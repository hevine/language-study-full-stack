/**
 * MP4 导出：把分段 mp3 + 分镜字幕合成可下载视频（ffmpeg）。
 *
 * 三条音轨口径（v10）：
 *   target  原文音轨（历史行为，seg-N.mp3）
 *   native  中文讲师音轨（seg-N.zh.mp3，缺镜回落到原文）
 *   both    同一容器两条 audio stream，播放器/剪辑软件里可切语言
 *
 * 优先使用 npm 静态二进制 @ffmpeg-installer/ffmpeg，缺失时回退系统 PATH。
 * 两者都没有时抛出可执行中文提示；页面内播放不依赖本服务（SDK 分镜播放器）。
 * 不监听端口、不常驻进程 —— spawn 一次性 ffmpeg，与 edgeTts 的取舍一致。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 返回可执行的 ffmpeg 路径：npm 静态包优先，系统 PATH 兜底 */
function ffmpegBinary(): string {
  try {
    const installer = require('@ffmpeg-installer/ffmpeg') as { path?: string };
    if (installer.path && fs.existsSync(installer.path)) return installer.path;
  } catch {
    // 依赖未安装时走系统 PATH
  }
  return 'ffmpeg';
}
import { ConfigError, UpstreamError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { Language } from '../domain/language';
import type { ExplainVideo } from '../domain/explainVideo';
import { getVideoDir } from './explainVideo';
import {
  exportPath,
  nativeSegmentPath,
  segmentPath,
  type ExportTrack,
} from '../repositories/explainVideos';

/**
 * 中文字体候选。
 *
 * 顺序不是审美偏好，是实测：PingFang.ttc 在 freetype 下会漏个别字（U+8FDC「远」
 * 渲染成空白，「关于远程办公」变成「关于  程办公」），而 Hiragino Sans GB 与
 * STHeiti Light 都齐全。漏字比换字体难看得多，所以把 PingFang 降到兜底位。
 */
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/System/Library/Fonts/Supplemental/Songti.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  // 兜底：字体齐全度略差（见上），但至少是系统自带
  '/System/Library/Fonts/PingFang.ttc',
];

function findFont(): string | null {
  return FONT_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/** 容器里的语言标记：剪辑软件据此把两条音轨标成「日语 / 中文」而不是「Audio 1/2」 */
const LANG_TAG: Record<Language, string> = { en: 'eng', ja: 'jpn', ko: 'kor' };

const FRAME_W = 960;
const FRAME_H = 540;
const TITLE_SIZE = 32;
const LINE_SIZE = 20;

/**
 * drawtext 不会自动换行：长句会一路排到画面外被裁掉。
 * 按显示宽度折行——全角字符算 1 个单位、拉丁字母 0.55；最多三行，再多就截断
 * （三行已经吃满画面下半区，继续堆只会更难读）。
 * 带一句避头标点：句号逗号不落在行首，宁可让上一行多挤一个字符。
 */
function wrapText(text: string, maxUnits: number, maxLines = 3): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const NO_LINE_START = /[。、，．,.!?！？；：）】」』’”…—]/;
  const lines: string[] = [];
  let line = '';
  let units = 0;
  for (const ch of [...clean]) {
    const wide = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/.test(ch);
    const w = wide ? 1 : 0.55;
    if (units + w > maxUnits && line) {
      if (NO_LINE_START.test(ch)) {
        line += ch;
        units += w;
        continue;
      }
      lines.push(line);
      line = ch;
      units = w;
      if (lines.length >= maxLines) break;
    } else {
      line += ch;
      units += w;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines.join('\n');
}

function runFfmpeg(args: string[], timeoutMs = 8 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new UpstreamError('MP4 导出超时（8 分钟），请稍后重试'));
      }
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new ConfigError(`无法启动 ffmpeg：${err.message}。请安装 @ffmpeg-installer/ffmpeg 或运行 brew install ffmpeg 后重试`, undefined, true));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().split('\n').slice(-6).join(' ').slice(0, 500);
        reject(new UpstreamError(`MP4 导出失败（退出码 ${code}）：${tail}`));
      }
    });
  });
}

/**
 * 把逐镜音频拼成一整条音轨。
 *
 * 不用 concat demuxer + `-c copy`：配音降级的分镜没有 mp3 文件，缺一镜就会让
 * 后面所有字幕整体前移（旧实现在这一处会音画错位）。这里给缺镜插等长静音，
 * 再统一 aresample + aformat 后走 filter concat，顺便抹平不同来源 mp3 的参数差异。
 */
async function buildAudioTrack(params: {
  dir: string;
  video: ExplainVideo;
  kind: 'target' | 'native';
  outFile: string;
}): Promise<void> {
  const { dir, video, kind, outFile } = params;
  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];

  video.shots.forEach((shot, index) => {
    const primary = kind === 'native' ? nativeSegmentPath(dir, index) : segmentPath(dir, index);
    const fallback = segmentPath(dir, index);
    const durSec = Math.max(0.1, shot.audio.durationMs / 1000).toFixed(3);
    if (fs.existsSync(primary)) {
      inputs.push('-i', primary);
    } else if (kind === 'native' && fs.existsSync(fallback)) {
      // 这镜没中文轨（转述没过语种校验）：用原文顶上，宁可混一句外语也别留空白
      inputs.push('-i', fallback);
    } else {
      inputs.push('-f', 'lavfi', '-t', durSec, '-i', 'anullsrc=r=24000:cl=mono');
    }
    chains.push(`[${index}:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[a${index}]`);
    labels.push(`[a${index}]`);
  });
  if (labels.length === 0) throw new UpstreamError('没有可导出的音频分段');

  await runFfmpeg([
    '-y',
    ...inputs,
    '-filter_complex',
    `${chains.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`,
    '-map', '[out]',
    '-c:a', 'libmp3lame', '-q:a', '4',
    outFile,
  ]);
}

/** 导出 mp4，返回绝对路径。已存在则直接返回（缓存），按音轨分开存 */
export async function exportExplainVideo(
  videoId: string,
  track: ExportTrack = 'target',
): Promise<string> {
  const found = getVideoDir(videoId);
  if (!found) throw new ConfigError('讲解视频不存在，无法导出');
  const { video, dir } = found;

  if (track !== 'target' && !video.shots.some((shot) => shot.audio?.native?.url)) {
    throw new UpstreamError('这条讲解还没有中文讲师轨，只能导出原文音轨；可以先点「补中文讲师」再来导');
  }

  const out = exportPath(dir, track);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;

  try {
    await runFfmpeg(['-version'], 8000);
  } catch {
    throw new ConfigError(
      '这台机器还没有安装 ffmpeg。请在项目目录运行 npm install，或运行 brew install ffmpeg，安装完成后再点导出。',
      undefined,
      true,
    );
  }

  const font = findFont();
  if (!font) throw new ConfigError('没有找到中文字体，无法在画面里渲染字幕');

  // 中间产物统一放一个临时子目录：一次 recursive 删除就能收干净，
  // 也不会把 ev-text-* 这类文件混进视频目录（之前是逐个删，20 镜就上百次删除调用）
  const stamp = Date.now();
  const tmpDir = path.join(dir, `.export-${stamp}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const targetAudio = path.join(tmpDir, 'audio-target.mp3');
  const nativeAudio = track === 'target' ? null : path.join(tmpDir, 'audio-native.mp3');

  try {
    // ① 音频：原文轨必建；中文轨只有选了才建
    await buildAudioTrack({ dir, video, kind: 'target', outFile: targetAudio });
    if (nativeAudio) await buildAudioTrack({ dir, video, kind: 'native', outFile: nativeAudio });

    // ② 逐镜字幕：drawtext 用 textfile 承载，彻底避开逗号/引号/百分号的转义问题
    let cursorSec = 0;
    const filters: string[] = [];
    video.shots.forEach((shot, index) => {
      const start = cursorSec;
      const dur = Math.max(0.1, shot.audio.durationMs / 1000);
      cursorSec += dur;

      const titleFile = path.join(tmpDir, `title-${index}.txt`);
      const lineFile = path.join(tmpDir, `line-${index}.txt`);
      // 导中文音轨时第二行换成中文口播稿：否则「中文在讲、屏幕上是日文」很割裂
      const second = track === 'native' ? shot.narrationZh || shot.narration : shot.narration;
      const titleText = wrapText(`${index + 1}. ${shot.caption || shot.narration}`, 24, 3);
      const lineText = wrapText(second, 40, 3);
      fs.writeFileSync(titleFile, titleText, 'utf8');
      fs.writeFileSync(lineFile, lineText, 'utf8');

      // 字幕块整体垂直居中：行数不同时不要出现「有时候偏上」
      const titleH = titleText.split('\n').length * TITLE_SIZE * 1.25;
      const lineH = lineText.split('\n').length * LINE_SIZE * 1.35;
      const gap = 14;
      const top = Math.round((FRAME_H - (titleH + gap + lineH)) / 2);
      const window = `between(t,${start.toFixed(3)},${(start + dur).toFixed(3)})`;
      filters.push(
        `drawtext=fontfile='${font}':textfile='${titleFile}':fontsize=${TITLE_SIZE}:fontcolor=white:line_spacing=8:x=(w-text_w)/2:y=${top}:enable='${window}'`,
      );
      filters.push(
        `drawtext=fontfile='${font}':textfile='${lineFile}':fontsize=${LINE_SIZE}:fontcolor=#d7e0ff:line_spacing=6:x=(w-text_w)/2:y=${top + Math.round(titleH + gap)}:enable='${window}'`,
      );
    });
    const totalSec = Math.max(1, cursorSec);
    const videoFilter = `color=c=0x12172a:s=${FRAME_W}x${FRAME_H}:r=24:d=${totalSec.toFixed(3)},${filters.join(',')}`;

    // ③ 合成：单音轨直接 map；双音轨用 apad 补齐到同一长度，避免「中文比画面短」时尾部丢音
    const args = ['-y', '-f', 'lavfi', '-i', videoFilter, '-i', targetAudio];
    if (nativeAudio) args.push('-i', nativeAudio);
    args.push('-map', '0:v');
    if (nativeAudio) {
      args.push('-filter_complex', '[1:a]apad[a1];[2:a]apad[a2]', '-map', '[a1]', '-map', '[a2]');
    } else {
      args.push('-map', '1:a');
    }
    args.push(
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '1',
      '-metadata:s:a:0', `language=${LANG_TAG[video.language] ?? 'und'}`,
    );
    if (nativeAudio) {
      args.push('-metadata:s:a:1', 'language=zho', '-metadata:s:a:1', 'title=中文讲师');
    }
    args.push('-t', totalSec.toFixed(3), out);

    await runFfmpeg(args);
  } finally {
    // 清理失败不影响成品：mp4 已经落盘，中间文件下次会被同名目录覆盖前先清
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略：目录里的内容都是可再生的
    }
  }
  logger.info('explain video exported', { videoId, track, bytes: fs.statSync(out).size });
  return out;
}

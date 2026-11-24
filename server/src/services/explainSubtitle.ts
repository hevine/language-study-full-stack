/**
 * 导出字幕的折行与字体选择。
 *
 * ffmpeg drawtext 一个滤镜只能挂一个 fontfile，而且不做字形回退：
 * 中文字体（Hiragino Sans GB 等）没有谚文字形，韩语整行变豆腐块；
 * 韩文字体（Apple SD Gothic Neo）的汉字覆盖又不全（「尘」「积」缺字）。
 * 所以按「这一行用到哪些文字系统」选字体：纯中文/日文用中文字体，
 * 纯韩文用韩文字体，中韩混排（中文正文里嵌韩文引号）用两边都覆盖的全 CJK 字体。
 */
import fs from 'node:fs';

export type FontKind = 'cjk' | 'hangul' | 'panCjk';

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/u;
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/u;

export function fontKindForText(text: string): FontKind {
  if (!HANGUL.test(text)) return 'cjk';
  return HAN.test(text) || KANA.test(text) ? 'panCjk' : 'hangul';
}

const NOTO_CJK = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-VF.otf.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-VF.otf.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
];

const NOTO_KR = [
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansKR-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf',
];

/** Arial Unicode MS 在 macOS 上中/日/韩/拉丁都覆盖，是混排行唯一稳妥的单字体 */
const ARIAL_UNICODE = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
];

/**
 * 字体候选按优先级排列。
 *
 * 中文仍优先 Hiragino Sans GB：PingFang.ttc 在 freetype 下会漏 U+8FDC「远」，
 * 与韩文乱码同源的「漏字」问题——只不过程度轻。韩文优先 Apple SD Gothic Neo；
 * 混排只能靠 Arial Unicode / Noto Sans CJK 这种全字库字体，单语字体必然缺字。
 */
export const FONT_CANDIDATES: Record<FontKind, readonly string[]> = {
  cjk: [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    ...NOTO_CJK,
    '/System/Library/Fonts/PingFang.ttc',
    ...ARIAL_UNICODE,
  ],
  hangul: [
    '/System/Library/Fonts/AppleSDGothicNeo.ttc',
    '/System/Library/Fonts/Supplemental/AppleGothic.ttf',
    ...NOTO_KR,
    ...NOTO_CJK,
    ...ARIAL_UNICODE,
  ],
  panCjk: [
    ...ARIAL_UNICODE,
    ...NOTO_CJK,
    ...NOTO_KR,
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/AppleSDGothicNeo.ttc',
    '/System/Library/Fonts/PingFang.ttc',
  ],
};

const FONT_FALLBACK_ORDER: Record<FontKind, readonly FontKind[]> = {
  cjk: ['cjk', 'panCjk', 'hangul'],
  hangul: ['hangul', 'panCjk', 'cjk'],
  panCjk: ['panCjk', 'cjk', 'hangul'],
};

/** 按候选顺序找第一个存在的字体；本机缺某类字体时退到覆盖更全/更窄的其他字体 */
export function findFont(
  kind: FontKind,
  exists: (file: string) => boolean = fs.existsSync,
): string | null {
  for (const fallback of FONT_FALLBACK_ORDER[kind]) {
    const hit = FONT_CANDIDATES[fallback].find((file) => exists(file));
    if (hit) return hit;
  }
  return null;
}

/**
 * drawtext 不会自动换行：长句会一路排到画面外被裁掉。
 * 按显示宽度折行——全角字符算 1 个单位、拉丁字母 0.55；最多三行，再多就截断
 * （三行已经吃满画面下半区，继续堆只会更难读）。
 * 带一句避头标点：句号逗号不落在行首，宁可让上一行多挤一个字符。
 */
export function wrapText(text: string, maxUnits: number, maxLines = 3): string {
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
/**
 * UI 组件库预览页（/ui-kit）
 *
 * 一处集中展示全套统一组件：输入框 / 多行文本 / 下拉 / 开关 / 滑块 / 分段 /
 * 按钮 / 徽章 / 玻璃卡片。顶部可直接切换语种主题，实时查看换肤效果——
 * 所有组件都吃 CSS 变量，跟随 [data-theme] + [data-language] 自动同步。
 */
import { useState } from 'react';
import { Field, Area, Select, Switch, Slider, Segmented, AudioPlayer, type SelectOption } from '@waiyubaodian/ui-kit';
import { Dropdown } from '@waiyubaodian/ui-kit';
import { Banner, SectionCard, CheckMark, TokenHint, PlayIcon, StopIcon, StarIcon } from '../components/ui';
import { useApp } from '../store';
import { THEMES, themeById, type ThemeId } from '@waiyubaodian/ui-kit/theme';
import type { Language } from '../types';

const LANG_OPTIONS: SelectOption<Language>[] = [
  { value: 'en', label: '英语 · English', sublabel: '海湾蓝主题' },
  { value: 'ja', label: '日语 · 日本語', sublabel: '樱花红主题' },
  { value: 'ko', label: '韩语 · 한국어', sublabel: '青瓷主题' },
];

const FRUIT: SelectOption[] = [
  { value: 'apple', label: 'Apple', sublabel: '苹果' },
  { value: 'banana', label: 'Banana', sublabel: '香蕉' },
  { value: 'cherry', label: 'Cherry', sublabel: '樱桃', disabled: true },
];

const RATE_OPTIONS = [
  { value: '0.8', label: '0.8× 慢速' },
  { value: '1', label: '1× 正常' },
  { value: '1.2', label: '1.2× 快速' },
];

/** 生成一段可离线播放的短提示音，供播放器示例使用（不依赖外部音频资源） */
function makeDemoAudioUrl(): string {
  const sampleRate = 8000;
  const seconds = 5;
  const frames = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t * 5, (seconds - t) * 5);
    const sample = Math.sin(2 * Math.PI * 523.25 * t) * 0.2 * envelope;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }
  const binary = Array.from({ length: buffer.byteLength }, (_, i) => String.fromCharCode(view.getUint8(i))).join('');
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export default function UIKit() {
  const { language, theme, setTheme, autoTheme, resetTheme, switchLanguage, switching } = useApp();
  const [text, setText] = useState('');
  const [area, setArea] = useState('这是一段试听语料。所有组件会自动跟随主题换肤。');
  const [fruit, setFruit] = useState<string | null>('apple');
  const [switchedOn, setSwitchedOn] = useState(true);
  const [rate, setRate] = useState(50);
  const [seg, setSeg] = useState('1');
  const [langPick, setLangPick] = useState('1');
  const [demoAudio] = useState(makeDemoAudioUrl);

  return (
    <div className="stack">
      <div className="page-head">
        <div className="eyebrow">COMPONENT LIBRARY</div>
        <h1>UI 组件库</h1>
        <p className="page-sub">
          统一的流光玻璃组件；切换下方语种 / 主题，观察组件与播放器如何同步换肤。
        </p>
      </div>

      {/* 换肤控制台 */}
      <SectionCard title="换肤控制台" extra={<span className="hint">当前：{themeById(theme).name} · {language.toUpperCase()}</span>}>
        <div className="ukit-skinbar">
          <Select<Language>
            label="语种"
            value={language}
            onChange={(next) => void switchLanguage(next)}
            options={LANG_OPTIONS}
            disabled={switching !== null}
            block
          />
          <div className="ukit-theme-dots">
            <span className="ui-field-label">主题色（语种自动 / 手动固定）</span>
            <div className="theme-dots">
              <button
                className={`theme-auto${autoTheme ? ' active' : ''}`}
                onClick={resetTheme}
                title="配色跟随语种"
              >
                自动
              </button>
              {THEMES.map((item) => (
                <button
                  key={item.id}
                  className={`theme-dot${theme === item.id ? ' active' : ''}`}
                  style={{ background: item.swatch }}
                  onClick={() => setTheme(item.id as ThemeId)}
                  title={`${item.name} · ${item.hint}`}
                  aria-label={item.name}
                />
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      {/* 表单控件 */}
      <SectionCard title="表单控件">
        <div className="ukit-grid">
          <Field
            label="文本输入框"
            value={text}
            onChange={setText}
            placeholder="点这里输入…"
            hint="玻璃磨砂外壳 + 主题色聚焦光环"
            block
          />
          <Field
            label="带前后缀"
            value={text}
            onChange={setText}
            placeholder="0.90"
            leading="倍速"
            trailing="×"
            block
          />
          <Field
            label="校验失败态"
            value={text}
            onChange={setText}
            placeholder="错误示例"
            hint="这是一条校验提示"
            invalid
            block
          />
          <Field
            label="禁用态"
            value="不可编辑"
            onChange={() => undefined}
            disabled
            block
          />
        </div>
        <div style={{ marginTop: 10 }}>
          <Area
            label="多行文本框"
            value={area}
            onChange={setArea}
            rows={3}
            hint="聚焦时描边与光环跟随当前主题"
            block
          />
        </div>
      </SectionCard>

      {/* 选择类控件 */}
      <SectionCard title="选择控件">
        <div className="ukit-grid">
          <Select
            label="下拉选择（玻璃菜单）"
            value={fruit}
            onChange={setFruit}
            options={FRUIT}
            placeholder="请选择…"
            block
          />
          <Segmented
            label="分段控件"
            value={seg}
            onChange={setSeg}
            options={RATE_OPTIONS.map((option) => ({ value: option.value, label: option.label.replace(' 慢速', '').replace(' 正常', '').replace(' 快速', '') }))}
          />
          <div className="ukit-control">
            <span className="ui-field-label">开关</span>
            <Switch checked={switchedOn} onChange={setSwitchedOn} label="启用语音增强" hint="iOS 风格拨动开关" />
          </div>
          <div className="ukit-control">
            <span className="ui-field-label">原生下拉菜单（Dropdown 组件）</span>
            <Dropdown
              value={langPick}
              onChange={setLangPick}
              options={[
                { value: '1', label: '选项一' },
                { value: '2', label: '选项二' },
              ]}
              placeholder="打开看看"
            />
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <Slider
            label="滑块"
            value={rate}
            onChange={setRate}
            min={0}
            max={100}
            display={`${rate}%`}
            ariaLabel="示例滑块"
          />
        </div>
      </SectionCard>

      {/* 按钮 / 徽章 / 反馈 */}
      <SectionCard title="按钮与反馈">
        <div className="ukit-buttons">
          <button className="btn btn-primary">主按钮</button>
          <button className="btn">次要按钮</button>
          <button className="btn btn-ghost">幽灵按钮</button>
          <button className="btn btn-sm btn-danger">危险操作</button>
          <button className="btn btn-primary btn-sm"><PlayIcon />播放</button>
          <button className="btn btn-sm"><StopIcon />停止</button>
        </div>
        <div className="ukit-badges" style={{ marginTop: 14 }}>
          <span className="chip">默认</span>
          <span className="chip chip-ok"><CheckMark />完成</span>
          <span className="chip chip-warn">进行中</span>
          <TokenHint text="此操作会消耗 token" />
          <StarIcon />
        </div>
        <div style={{ marginTop: 14 }}>
          <Banner tone="teal">所有组件的颜色都来自主题变量，切换语种立即同步。</Banner>
        </div>
      </SectionCard>

      {/* 音频播放器（录音回放同款） */}
      <SectionCard title="音频播放器（录音回放同款）" extra={<span className="hint">播放键 / 进度 / 音量 / 倍速均为组件库样式</span>}>
        <div className="ukit-control" style={{ gap: 12 }}>
          {demoAudio ? <AudioPlayer src={demoAudio} label="示例录音回放" /> : null}
          <span className="ui-field-hint">
            玻璃胶囊容器 + 主题色播放键 + 玻璃滑轨，替代浏览器原生灰色控件条；开播会自动停掉其它媒体与朗读。
          </span>
        </div>
      </SectionCard>

      {/* 流光玻璃播放器框预览 */}
      <SectionCard title="流光玻璃容器（视频 / 播放器同款）">
        <div className="liquid-glass-frame">
          <div className="liquid-glass-inner ukit-glass-demo">
            <div className="ukit-glass-glow" />
            <div className="ukit-glass-caption">
              <PlayIcon size={18} />
              <span>Liquid Glass · 边框流光随语种主题变色</span>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

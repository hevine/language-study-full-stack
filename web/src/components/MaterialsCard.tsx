import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Banner } from './ui';
import { Dropdown } from '@waiyubaodian/ui-kit';
import type { Language, MaterialSummary } from '../types';

const ACCEPT = '.pdf,.epub,.docx,.txt,.md,.html';

const formatSize = (bytes: number): string =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const LANGUAGE_NOTE: Record<string, string> = {
  en: '支持 PDF / EPUB / DOCX / TXT / MD。级别会从文件名自动识别（basic / core / advanced），也可以在上传前手动选。',
  ja: '支持 PDF / EPUB / DOCX / TXT / MD。文件名带 N5–N1 会自动分级；识别不出时在上传前手动选级别即可。',
  ko: '支持 PDF / EPUB / DOCX / TXT / MD。文件名带「1 级–6 级」会自动分级，也可手动选。',
};

const KIND_LABEL: Record<MaterialSummary['kind'], string> = {
  textbook: '教材',
  vocab: '词表',
  grammar: '语法书',
  notes: '资料',
};

const JA_LEVELS: Record<string, string> = {
  n5: 'N5',
  n4: 'N4',
  n3: 'N3',
  n2: 'N2',
  n1: 'N1',
};

const levelLabel = (item: MaterialSummary): string => {
  if (!item.level) return '未分级';
  return JA_LEVELS[item.level] ?? item.level.toUpperCase();
};

const LEVEL_OPTIONS: Record<string, Array<{ id: string; label: string }>> = {
  ja: [
    { id: 'n5', label: 'N5' },
    { id: 'n4', label: 'N4' },
    { id: 'n3', label: 'N3' },
    { id: 'n2', label: 'N2' },
    { id: 'n1', label: 'N1' },
  ],
  ko: [
    { id: 'ko1', label: '1 级' },
    { id: 'ko2', label: '2 级' },
    { id: 'ko3', label: '3 级' },
    { id: 'ko4', label: '4 级' },
    { id: 'ko5', label: '5 级' },
    { id: 'ko6', label: '6 级' },
  ],
  en: [
    { id: 'basic', label: '基础' },
    { id: 'core', label: '核心' },
    { id: 'advanced', label: '进阶' },
  ],
};

/** 设置页里的「我的教材」：上传自有电子书 → 解析成章节与词条 → 接进每日计划 */
export default function MaterialsCard({ language }: { language: Language }) {
  const [items, setItems] = useState<MaterialSummary[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [level, setLevel] = useState('');
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'working'>('idle');
  const [message, setMessage] = useState<{ tone: 'teal' | 'gold' | 'danger'; text: string } | null>(null);
  const [toc, setToc] = useState<{ id: string; units: Array<{ idx: number; title: string; charCount: number }> } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const response = await api.materials(language);
      setItems(response.materials);
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    }
  };

  useEffect(() => {
    setFile(null);
    setLevel('');
    setToc(null);
    setMessage(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  const upload = async () => {
    if (!file) {
      inputRef.current?.click();
      return;
    }
    setBusy('uploading');
    setMessage(null);
    try {
      const response = await api.uploadMaterial(file, language, { level });
      const { material, preview } = response;
      const kindText =
        material.kind === 'vocab' ? '词表包（只进词汇任务）' : material.kind === 'notes' ? '参考资料（不占每日任务）' : '教材';
      setMessage({
        tone: 'teal',
        text: `已解析《${material.title}》：${kindText} · ${levelLabel(material)} · ${material.unitCount} 章 · ${material.wordCount} 个候选词，其中 ${preview.inLexicon} 个可背。${
          material.kind === 'textbook' && material.level ? '已按级别接入计划，会随进度自动往上推进。' : ''
        }`,
      });
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusy('idle');
    }
  };

  const toggle = async (item: MaterialSummary) => {
    setBusy('working');
    setMessage(null);
    try {
      await api.activateMaterial(item.id, !item.active);
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusy('idle');
    }
  };

  const enrich = async (item: MaterialSummary) => {
    setBusy('working');
    setMessage(null);
    try {
      const response = await api.enrichMaterial(item.id);
      setMessage({ tone: 'teal', text: response.message });
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusy('idle');
    }
  };

  const toggleToc = async (item: MaterialSummary) => {
    if (toc?.id === item.id) {
      setToc(null);
      return;
    }
    setBusy('working');
    try {
      const detail = await api.materialDetail(item.id);
      setToc({ id: item.id, units: detail.units });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusy('idle');
    }
  };

  const remove = async (item: MaterialSummary) => {
    setBusy('working');
    try {
      await api.deleteMaterial(item.id);
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusy('idle');
    }
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="hint">{LANGUAGE_NOTE[language] ?? LANGUAGE_NOTE.en}</div>

      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <button className="btn btn-sm" onClick={() => inputRef.current?.click()} disabled={busy !== 'idle'}>
          {file ? '重新选择' : '选择文件'}
        </button>
        <span className="hint" style={{ flex: 1, minWidth: 140 }}>
          {file ? `${file.name} · ${formatSize(file.size)}` : '还没有选择文件'}
        </span>
        <Dropdown
          value={level}
          onChange={(next) => setLevel(next)}
          options={[
            { value: '', label: '级别：自动识别' },
            ...(LEVEL_OPTIONS[language] ?? LEVEL_OPTIONS.en).map((option) => ({
              value: option.id,
              label: `级别：${option.label}`,
            })),
          ]}
          triggerClassName="sf-compact"
          triggerStyle={{ width: 132 }}
          title="教材级别：决定它在计划里什么时候接手"
        />
        <button
          className="btn btn-sm btn-primary"
          onClick={upload}
          disabled={busy !== 'idle' || !file}
        >
          {busy === 'uploading' ? '解析中…' : '解析并入库'}
        </button>
      </div>

      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}

      {items.length === 0 ? (
        <div className="hint">
          还没有导入教材。教材按文件名里的级别（N5–N1 / 零基础）自动排进计划：导入 0–N2 全套后，会随备考进度一本本往上推进；词表包只补充词汇任务，答疑资料留在库里备查。
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {items.map((item) => (
            <div key={item.id} className="stack" style={{ gap: 6 }}>
              <div className="mat-row">
              <div style={{ minWidth: 0 }}>
                <div className="mat-title">
                  {item.title}
                  <span className="chip" style={{ marginLeft: 8 }}>{KIND_LABEL[item.kind]}</span>
                  <span className="chip" style={{ marginLeft: 4 }}>{levelLabel(item)}</span>
                  {item.active ? <span className="chip chip-ok" style={{ marginLeft: 4 }}>生效中</span> : null}
                  {item.kind === 'textbook' && item.level ? (
                    <span className="chip chip-ok" style={{ marginLeft: 4 }}>按级别自动接入</span>
                  ) : null}
                  {item.kind === 'grammar' ? (
                    <span className="chip chip-ok" style={{ marginLeft: 4 }}>按天轮换进拆句</span>
                  ) : null}
                </div>
                <div className="hint">
                  {item.format.toUpperCase()} · {item.unitCount} {item.kind === 'grammar' ? '个句型' : '章'} ·{' '}
                  {item.wordCount} 词 · {formatSize(item.fileSize)} · {Math.round(item.charCount / 1000)}k 字符
                  {item.kind === 'vocab' ? ' · 随词汇任务取词' : ''}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                {item.unitCount > 0 ? (
                  <button className="btn btn-sm" onClick={() => toggleToc(item)} disabled={busy !== 'idle'}>
                    {toc?.id === item.id ? '收起目录' : '目录'}
                  </button>
                ) : null}
                {item.kind === 'textbook' && !item.level ? (
                  <button className="btn btn-sm" onClick={() => toggle(item)} disabled={busy !== 'idle'}>
                    {item.active ? '停用' : '设为教材'}
                  </button>
                ) : null}
                {item.wordCount > 0 ? (
                  <button className="btn btn-sm" onClick={() => enrich(item)} disabled={busy !== 'idle'}>
                    补释义
                  </button>
                ) : null}
                <button className="btn btn-sm" onClick={() => remove(item)} disabled={busy !== 'idle'}>
                  删除
                </button>
              </div>
              </div>
              {toc?.id === item.id ? (
                <div className="hint" style={{ paddingLeft: 4, lineHeight: 1.9 }}>
                  {toc.units.map((unit) => (
                    <div key={unit.idx}>
                      <span className="chip" style={{ marginRight: 6 }}>{unit.idx + 1}</span>
                      {unit.title}
                      <span style={{ opacity: 0.6 }}> · {unit.charCount} 字</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

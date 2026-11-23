import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { Field } from '@waiyubaodian/ui-kit';
import { Banner } from './ui';
import { Dropdown } from '@waiyubaodian/ui-kit';
import type { ExamImportJob, ExamPaperSummary, Language } from '../types';

const ACCEPT = '.pdf,.docx,.epub,.txt,.md,.markdown,.html,.htm,.json';

const STAGES: Array<{ key: string; label: string; note: string }> = [
  { key: 'read', label: '读取文件', note: '抽文字层' },
  { key: 'ocr', label: 'OCR 识别', note: '本机 Vision' },
  { key: 'structure', label: '整理题目', note: '模型分段抽取' },
  { key: 'save', label: '写入题库', note: '生成可考卷子' },
];

const FORMAT_NOTE: Record<string, string> = {
  en: 'PDF / DOCX / EPUB / TXT / MD / HTML，或已整理好的 JSON。扫描版 PDF 会自动走本机 OCR；答案页、Answer Key 一并放进文件效果最好。',
  ja: 'PDF / DOCX / EPUB / TXT / MD / HTML，或已整理好的 JSON。扫描版会走本机 OCR；请把「解答・解説」页一起放进去，否则缺少答案的题会被跳过。',
  ko: 'PDF / DOCX / EPUB / TXT / MD / HTML，或已整理好的 JSON。扫描版会走本机 OCR；答案与解析页一起导入最稳。',
};

function formatSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function guessYear(name: string): number | null {
  const match = name.match(/(19|20)\d{2}/);
  const year = match ? Number(match[0]) : NaN;
  return year >= 1990 && year <= 2100 ? year : null;
}

/** 设置页里的「真题导入」：原卷文件 → OCR / 抽取 → 写进「升级自测」题库 */
export default function ExamImportCard({ language }: { language: Language }) {
  const { plan } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [paperType, setPaperType] = useState<'real' | 'mock'>('real');
  const [ocrMode, setOcrMode] = useState<'auto' | 'force' | 'off'>('auto');
  const [title, setTitle] = useState('');
  const [job, setJob] = useState<ExamImportJob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ExamPaperSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  const running = job?.status === 'running';

  const loadList = async () => {
    try {
      const response = await api.importedExams(language);
      setItems(response.papers);
      setListError(null);
    } catch (err) {
      setListError((err as Error).message);
    }
  };

  useEffect(() => {
    setFile(null);
    setJob(null);
    setError(null);
    setTitle('');
    if (inputRef.current) inputRef.current.value = '';
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  /* 轮询导入进度：任务 id / 状态不变时不重启动，避免重复定时器 */
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const startedAt = Date.parse(job.startedAt);
    const clock = window.setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    }, 1000);

    const tick = async () => {
      try {
        const response = await api.examImportJob(job.id);
        setJob(response.job);
        if (response.job.status === 'running') {
          timerRef.current = window.setTimeout(tick, 900);
        } else {
          await loadList();
        }
      } catch (err) {
        setError((err as Error).message);
      }
    };
    timerRef.current = window.setTimeout(tick, 700);

    return () => {
      window.clearInterval(clock);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  const pick = (next: File | null) => {
    setFile(next);
    setJob(null);
    setError(null);
    if (!next) return;
    const guessed = guessYear(next.name);
    if (guessed) setYear(guessed);
    if (!title.trim()) setTitle(next.name.replace(/\.[^.]+$/, ''));
  };

  const start = async () => {
    if (!file) {
      inputRef.current?.click();
      return;
    }
    setError(null);
    setElapsed(0);
    try {
      const response = await api.startExamImport(file, language, {
        year,
        paperType,
        ocr: ocrMode,
        title: title.trim() || undefined,
        examName: plan?.examName,
        levelLabel: plan?.currentLevelName,
      });
      setJob(response.job);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (paper: ExamPaperSummary) => {
    if (!window.confirm(`删除「${paper.title}」？这份卷子的作答记录也会一起删掉。`)) return;
    setBusyId(paper.id);
    try {
      await api.deleteImportedExam(paper.id);
      await loadList();
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const activeStage = job
    ? job.stage === 'done'
      ? STAGES.length
      : Math.max(0, STAGES.findIndex((stage) => stage.key === job.stage))
    : -1;
  const ocrSkipped = job ? job.stage !== 'ocr' && activeStage > 1 && job.result?.ocr === false : false;

  return (
    <div className="exam-import">
      <div className="hint">{FORMAT_NOTE[language] ?? FORMAT_NOTE.en}</div>

      <div className="import-row">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(event) => pick(event.target.files?.[0] ?? null)}
        />
        <button className="btn btn-sm" onClick={() => inputRef.current?.click()} disabled={running}>
          {file ? '重新选择' : '选择原卷'}
        </button>
        <span className="import-file">
          {file ? (
            <>
              <strong>{file.name}</strong>
              <span className="hint"> · {formatSize(file.size)}</span>
            </>
          ) : (
            <span className="hint">支持 PDF / DOCX / EPUB / TXT / MD / HTML / JSON</span>
          )}
        </span>
      </div>

      <div className="import-fields">
        <div className="import-field">
          <Field
            label="年份"
            type="number"
            min={1990}
            max={2100}
            value={year}
            disabled={running}
            onChange={(value) => setYear(Number(value) || new Date().getFullYear())}
            block
          />
        </div>
        <label className="import-field">
          <span>卷别</span>
          <Dropdown
            block
            disabled={running}
            triggerClassName="sf-compact"
            value={paperType}
            options={[
              { value: 'real', label: '真题原卷' },
              { value: 'mock', label: '自制 / 改编' },
            ]}
            onChange={(next) => setPaperType(next === 'mock' ? 'mock' : 'real')}
          />
        </label>
        <label className="import-field">
          <span>扫描件 OCR</span>
          <Dropdown
            block
            disabled={running}
            triggerClassName="sf-compact"
            value={ocrMode}
            options={[
              { value: 'auto', label: '自动（推荐）' },
              { value: 'force', label: '强制 OCR' },
              { value: 'off', label: '关闭' },
            ]}
            onChange={(next) => setOcrMode(next === 'force' || next === 'off' ? next : 'auto')}
          />
        </label>
        <div className="import-field import-field-wide">
          <Field
            label="卷名"
            value={title}
            disabled={running}
            placeholder="留空则用文件名"
            onChange={setTitle}
            block
          />
        </div>
      </div>

      <div className="row" style={{ gap: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={start} disabled={running || !file}>
          {running ? '解析中…' : '开始解析并入库'}
        </button>
        <span className="hint">
          OCR 在本机完成，不消耗 token；整理题目会调用模型（按段落 2–8 次），会消耗 token。
        </span>
      </div>

      {error ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      {job ? (
        <div className={`import-progress is-${job.status}`}>
          <div className="import-progress-head">
            <span className="import-progress-title">
              {job.status === 'error' ? '导入未完成' : job.status === 'done' ? '导入完成' : job.message}
            </span>
            <span className="import-progress-percent">{job.percent}%</span>
          </div>
          <div className="import-bar">
            <span style={{ width: `${Math.max(3, job.percent)}%` }} />
          </div>
          <div className="import-progress-detail">
            {job.status === 'error' ? job.error : job.detail}
            {job.status === 'running' ? <span className="hint"> · 已用 {elapsed}s</span> : null}
          </div>

          <div className="import-steps">
            {STAGES.map((stage, index) => {
              const skipped = stage.key === 'ocr' && ocrSkipped;
              const state =
                job.status === 'error' && index === activeStage
                  ? 'failed'
                  : index < activeStage
                    ? skipped
                      ? 'skipped'
                      : 'done'
                    : index === activeStage && job.status === 'running'
                      ? 'active'
                      : 'todo';
              return (
                <div key={stage.key} className={`import-step is-${state}`}>
                  <span className="import-step-dot" />
                  <span className="import-step-label">{stage.label}</span>
                  <span className="import-step-note">{skipped ? '未使用' : stage.note}</span>
                </div>
              );
            })}
          </div>

          {job.warnings.length > 0 ? (
            <ul className="import-warnings">
              {job.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          {job.result ? (
            <div className="import-result">
              <div className="import-result-head">
                <strong>{job.result.title}</strong>
                <span className="chip chip-ok">
                  {job.result.itemCount} 题 · {job.result.durationMin} 分钟
                </span>
                {job.result.blocks ? <span className="chip">{job.result.blocks} 个大题</span> : null}
                {job.result.ocr ? <span className="chip">OCR</span> : null}
                {job.result.writingCount > 0 ? <span className="chip">写作 {job.result.writingCount}</span> : null}
              </div>
              <div className="hint">
                {job.result.sections.join(' / ')} · 选择 {job.result.choiceCount} 题
                {job.result.pages > 0 ? ` · ${job.result.pages} 页` : ''}
                {job.result.model ? ` · ${job.result.model}` : ''}
              </div>
              {job.result.answerStats ? (
                <div className="hint">
                  答案来源：原卷 {job.result.answerStats.fromKey} 题 · 据解析推导{' '}
                  {job.result.answerStats.fromExplain} 题 · 按题面作答 {job.result.answerStats.fromSolve} 题
                </div>
              ) : null}
              <div className="row" style={{ gap: 8 }}>
                <Link className="btn btn-sm btn-primary" to={`/exams/${job.result.paperId}/take`}>
                  直接开考 →
                </Link>
                <Link className="btn btn-sm" to="/exams">
                  去升级自测
                </Link>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setFile(null);
                    setJob(null);
                    setTitle('');
                    if (inputRef.current) inputRef.current.value = '';
                  }}
                >
                  再导入一份
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {listError ? <Banner tone="danger">{listError}</Banner> : null}

      <div className="import-list">
        <div className="import-list-head">
          <span>已导入的真题卷</span>
          <span className="hint">{items.length} 份 · 存在本机</span>
        </div>
        {items.length === 0 ? (
          <div className="hint">
            还没有导入过真题。导入后可在「升级自测」里按年份选到，答题环境自带计时、判分与逐题解析。
          </div>
        ) : (
          items.map((paper) => (
            <div className="import-item" key={paper.id}>
              <div className="import-item-main">
                <div className="import-item-title">
                  {paper.title}
                  <span className={`exam-type-badge is-${paper.paperType}`}>
                    {paper.paperType === 'real' ? '真题' : paper.paperType === 'ai' ? 'AI 卷' : '自制'}
                  </span>
                  {paper.importMeta?.ocr ? <span className="chip">OCR</span> : null}
                </div>
                <div className="hint">
                  {paper.year} 年 · {paper.itemCount} 题 · {paper.durationMin} 分钟
                  {paper.sections.length > 0 ? ` · ${paper.sections.join(' / ')}` : ''}
                  {paper.importFile ? ` · 来自 ${paper.importFile}` : ''}
                  {paper.importMeta?.model ? ` · ${paper.importMeta.model}` : ''}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                <Link className="btn btn-sm" to={`/exams/${paper.id}/take`}>
                  开始自测
                </Link>
                <button
                  className="btn btn-sm btn-danger-ghost"
                  onClick={() => remove(paper)}
                  disabled={busyId === paper.id}
                >
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

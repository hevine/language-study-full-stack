/**
 * 采纳条：Agent 与真实学习进度之间唯一的接缝。
 *
 * 为什么要点两次（预览 → 确认）：
 * 采纳一次会写两处 —— 挂进今日任务、把错因记进档案。档案写错会污染之后所有推理，
 * 所以必须先让用户看见「到底会写什么、挂到哪条任务」，再让他点头。
 *
 * 这也是北极星指标的计数点：产物被采纳且进了复习队列才计一次闭环。
 * 所以绝不能自动采纳 —— 每跑一次就自动算学一次，指标立刻失去意义。
 */
import { useState } from 'react';
import { api } from '../../api';
import type { AgentAdoptResult, AgentArtifact } from '../../agentTypes';

interface Props {
  runId: string;
  artifact: AgentArtifact;
  onAdopted?: (result: AgentAdoptResult) => void;
}

type Phase = 'idle' | 'previewing' | 'preview' | 'saving' | 'done' | 'error';

export default function AdoptBar({ runId, artifact, onAdopted }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<AgentAdoptResult | null>(null);
  const [result, setResult] = useState<AgentAdoptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (confirm: boolean) => {
    setError(null);
    setPhase(confirm ? 'saving' : 'previewing');
    try {
      const next = await api.agentAdopt({ runId, artifactId: artifact.artifactId, confirm });
      if (confirm) {
        setResult(next);
        setPhase('done');
        onAdopted?.(next);
      } else {
        setPreview(next);
        setPhase('preview');
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  if (phase === 'done' && result) {
    return (
      <div className={`adopt-bar is-done${result.closedLoop ? ' is-closed' : ''}`}>
        <div className="adopt-result">
          <strong>{result.closedLoop ? '这次算一次有效学习' : '已记录'}</strong>
          <ul>
            <li>
              {result.attached && result.taskTitle
                ? `产物已挂到「${result.taskTitle}」`
                : result.reason ?? '没有挂到任务上'}
            </li>
            {result.patch && result.patch.applied ? (
              <li>
                错因记入候选 {result.patch.added.length} 条
                {result.patch.promoted.length > 0 ? `，其中 ${result.patch.promoted.length} 条升级为长期薄弱项` : ''}
              </li>
            ) : null}
            <li className="hint">之后的复习会按这些错因安排，过几天它会回来考你。</li>
          </ul>
        </div>
      </div>
    );
  }

  if ((phase === 'preview' || phase === 'saving') && preview) {
    const pending = preview.patch?.pending ?? [];
    const saving = phase === 'saving';
    return (
      <div className="adopt-bar is-preview">
        <div className="adopt-preview">
          <strong>{saving ? '正在写入…' : '确认后会发生这些事'}</strong>
          <ul>
            <li>{preview.taskTitle ? `挂到今日任务「${preview.taskTitle}」` : preview.reason ?? '找不到可以挂的任务，只记录错因'}</li>
            {pending.length > 0 ? (
              <li>
                档案记 {pending.length} 笔错因：
                {pending.slice(0, 4).map((item) => item.detail).join('、')}
                {pending.length > 4 ? ` 等 ${pending.length} 笔` : ''}
              </li>
            ) : (
              <li>档案没有可沉淀的错因（这份产物不含规则命中）</li>
            )}
          </ul>
          <p className="hint">档案改动可回滚，写错了可以撤销。</p>
        </div>
        <div className="adopt-actions">
          <button className="btn btn-sm" disabled={saving} onClick={() => setPhase('idle')}>再想想</button>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => void run(true)}>
            {saving ? '写入中…' : '确认写入'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="adopt-bar">
      <div className="adopt-idle">
        <div className="adopt-writes">
          {artifact.writes.length > 0
            ? artifact.writes.map((item) => <span key={item.target} className="chip">{item.summary}</span>)
            : <span className="hint">采纳后把这份结果挂到今日任务（不含错因，不会改档案）</span>}
        </div>
        {error ? <p className="run-step-error">{error}</p> : null}
      </div>
      <div className="adopt-actions">
        <button
          className="btn btn-sm btn-primary"
          disabled={phase === 'previewing' || phase === 'saving'}
          onClick={() => void run(false)}
        >
          {phase === 'previewing' ? '正在核对…' : '采纳'}
        </button>
      </div>
    </div>
  );
}

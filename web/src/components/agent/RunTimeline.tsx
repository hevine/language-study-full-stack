/**
 * 中间栏：这次 run 到底做了什么。
 *
 * 它回答三个问题：现在跑到哪了、每一步为什么要有、结果凭什么可信。
 * 所以除了步骤，还要把 Lingua CI 的五关与上下文摘要一起露出来 ——
 * 只给一个「已完成」的界面，用户没有理由相信它。
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentRun, AgentRunStep, AgentVerifyReport } from '../../agentTypes';
import { GATE_LABEL, formatDuration, formatTokens, sceneName, toolHint, toolLabel } from './labels';

export type RunPhase = 'idle' | 'running' | 'done' | 'clarify' | 'error';

interface Props {
  phase: RunPhase;
  plan: string[];
  steps: AgentRunStep[];
  verify: AgentVerifyReport | null;
  run: AgentRun | null;
  scene: string | null;
  confidence: number | null;
  error: string | null;
  clarify: { message: string; candidates: Array<{ id: string; title: string }> } | null;
  onPickScene: (sceneId: string) => void;
}

const STATUS_TEXT: Record<AgentRunStep['status'], string> = {
  pending: '待执行',
  running: '运行中',
  done: '完成',
  skipped: '跳过',
  failed: '失败',
};

/** 秒表：LLM 单步 40–80 秒很常见，不给计时器用户会以为卡死 */
function useStopwatch(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    if (!active) return undefined;
    startedAt.current = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => {
      setSeconds(Math.round((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return seconds;
}

export default function RunTimeline({
  phase,
  plan,
  steps,
  verify,
  run,
  scene,
  confidence,
  error,
  clarify,
  onPickScene,
}: Props) {
  const elapsed = useStopwatch(phase === 'running');

  if (phase === 'idle' && !clarify) {
    return (
      <div className="run-empty">
        <div className="run-empty-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="run-empty-title">上面写下你的问题，这里会显示它怎么动手</p>
        <ul className="run-empty-list">
          <li>先路由到具体场景，再排出要调用哪几步</li>
          <li>每一步都带耗时与依据，不用盲等</li>
          <li>结束后过五道校验关，下方才出产物</li>
        </ul>
      </div>
    );
  }

  return (
    <div className="run-inner">
      <div className="run-head">
        <div>
          <div className="run-head-title">
            {phase === 'running' ? '正在执行' : phase === 'done' ? '执行完成' : phase === 'clarify' ? '需要你说清楚一点' : '执行中断'}
            {scene ? <span className="chip chip-accent run-scene-chip">{sceneName(scene)}</span> : null}
          </div>
          <div className="hint">
            {phase === 'running'
              ? `已用时 ${elapsed}s · 大模型单步可能要几十秒，别急着刷新`
              : run
                ? `共 ${run.steps.length} 步 · ${formatTokens(run.budget.usedTokens)} token`
                : ''}
          </div>
        </div>
        {confidence !== null ? (
          <div className="run-conf" title="路由器对场景判断的把握">
            <span className="run-conf-num">{Math.round(confidence * 100)}%</span>
            <span className="hint">场景置信度</span>
          </div>
        ) : null}
      </div>

      {clarify ? (
        <div className="run-clarify">
          <p>{clarify.message}</p>
          <div className="run-clarify-actions">
            {clarify.candidates.map((item) => (
              <button key={item.id} className="btn btn-sm" onClick={() => onPickScene(item.id)}>
                {item.title}
              </button>
            ))}
          </div>
          <p className="hint">
            猜错要白跑一整套工具、花掉几万 token，所以这里宁可先问一句。
          </p>
        </div>
      ) : null}

      {error ? <div className="banner banner-danger run-error">{error}</div> : null}

      {plan.length > 0 ? (
        <ol className="run-steps">
          {plan.map((tool, index) => {
            const step = steps.find((item) => item.n === index + 1) ?? null;
            const status: AgentRunStep['status'] = step?.status ?? 'pending';
            return (
              <li key={`${tool}-${index}`} className={`run-step is-${status}`}>
                <span className="run-step-rail" aria-hidden="true">
                  <span className="run-step-dot" />
                </span>
                <div className="run-step-body">
                  <div className="run-step-head">
                    <strong>{toolLabel(tool)}</strong>
                    <span className="run-step-meta">
                      {status === 'running' ? '运行中…' : STATUS_TEXT[status]}
                      {step && step.ms > 0 ? ` · ${formatDuration(step.ms)}` : ''}
                      {step && step.tokens > 0 ? ` · ${formatTokens(step.tokens)} token` : ''}
                    </span>
                  </div>
                  <div className="run-step-sub">
                    {step?.error ? <span className="run-step-error">{step.error}</span> : step?.summary || toolHint(tool)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {verify ? (
        <div className="run-verify">
          <div className="run-verify-head">
            <strong>Lingua CI</strong>
            <span className="hint">产物出厂前的五道校验</span>
          </div>
          <div className="run-gates">
            {verify.gates.map((gate) => (
              <div key={gate.id} className={`run-gate is-${gate.verdict}`} title={gate.detail || GATE_LABEL[gate.id]}>
                <span className="run-gate-id">{gate.id}</span>
                <span className="run-gate-name">{GATE_LABEL[gate.id]}</span>
                <span className="run-gate-verdict">
                  {gate.verdict === 'pass' ? '通过' : gate.verdict === 'fail' ? '未过' : '跳过'}
                </span>
              </div>
            ))}
          </div>
          {verify.review.length > 0 ? (
            <ul className="run-review">
              {verify.review.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {run ? (
        <div className="run-digest">
          <div className="run-digest-title">它根据什么判断</div>
          <div className="run-digest-grid">
            <div>
              <span className="hint">你的等级</span>
              <div>{run.contextDigest.level ?? '未建档'}</div>
            </div>
            <div>
              <span className="hint">距考试</span>
              <div>{run.contextDigest.daysLeft !== undefined ? `${run.contextDigest.daysLeft} 天` : '—'}</div>
            </div>
            <div>
              <span className="hint">帮助档位</span>
              <div>{run.contextDigest.helpLevel ?? '—'}</div>
            </div>
            <div>
              <span className="hint">高频错因</span>
              <div>{run.contextDigest.topErrors.length ? run.contextDigest.topErrors.join('、') : '暂无记录'}</div>
            </div>
          </div>
          <div className="hint run-digest-foot">
            run {run.runId} · 预算 {run.budget.usedTokens}/{run.budget.limit} token
          </div>
        </div>
      ) : null}
    </div>
  );
}

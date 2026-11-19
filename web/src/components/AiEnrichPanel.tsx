import { useEffect, useState } from 'react';
import { api } from '../api';
import CreativeLoading from './CreativeLoading';
import Quiz from './Quiz';
import { Banner, TokenIcon } from './ui';
import type { AiGenerateResponse, AiStats, TaskKind } from '../types';

interface Props {
  date: string;
  taskId: string;
  kind: TaskKind;
}

interface KindMeta {
  /** 展开后的一句话说明：这一批会生成什么 */
  brief: string;
  /** 生成后能带来什么 */
  hint: string;
  /** 预估 token，让用户在点之前心里有数 */
  tokens: string;
}

const META: Partial<Record<TaskKind, KindMeta>> = {
  vocab: {
    brief: '让 AI 从今天的主题里再挑 8 个级别匹配的词',
    hint: '生成的词会写进词汇本，今晚复习就能抽到，用的是同一个记忆曲线。',
    tokens: '约 1k tokens',
  },
  read: {
    brief: '围绕今天这篇文章，出 5 道理解题 + 2 个长难句',
    hint: '题目只针对今天这篇材料，做完能立刻检验自己有没有读懂。',
    tokens: '约 2k tokens',
  },
  listen: {
    brief: '围绕今天这段材料，出 4 道听力理解题 + 2 个听辨难点',
    hint: '覆盖主旨、细节、态度、推断，做题时先别看原文。',
    tokens: '约 2k tokens',
  },
  speak: {
    brief: '出 4 个口语任务，每个都带提纲、句型和范例',
    hint: '照着句型说三遍，再说自己的版本，比空想「该说什么」有效得多。',
    tokens: '约 2k tokens',
  },
  grammar: {
    brief: '从今天的材料里挑 6 句，拆主干、标从句',
    hint: '先自己划主干，再对照译文和提示；看不懂的那句抄进复盘。',
    tokens: '约 1.5k tokens',
  },
  write: {
    brief: '出 1 道写作题，附提纲、高分表达与范例段落',
    hint: '写完可以直接去批改页提交，AI 会给分并逐条改句。',
    tokens: '约 1.5k tokens',
  },
};

type Phase = 'idle' | 'loading' | 'ready' | 'error';

function fmtTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export default function AiEnrichPanel({ date, taskId, kind }: Props) {
  const meta = META[kind];
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<AiGenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<AiStats | null>(null);

  useEffect(() => {
    if (!open || stats) return;
    api
      .aiStats()
      .then((data) => setStats(data))
      .catch(() => undefined);
  }, [open, stats]);

  if (!meta) return null;

  const run = async (fresh: boolean) => {
    setOpen(true);
    setPhase('loading');
    setError(null);
    try {
      const response = await api.aiGenerate(date, taskId, fresh);
      setResult(response);
      setPhase('ready');
      api
        .aiStats()
        .then((data) => setStats(data))
        .catch(() => undefined);
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  const items = result?.items ?? [];
  const quizzes = items.filter((item) => item.type === 'quiz');
  const words = items.filter((item) => item.type === 'word');
  const sentences = items.filter((item) => item.type === 'sentence');
  const prompts = items.filter((item) => item.type === 'prompt');

  return (
    <section className={`ai-panel${open ? ' open' : ''}`}>
      <div className="ai-bar">
        <span className="ai-spark" aria-hidden>
          ✦
        </span>
        <div className="ai-bar-text">
          <strong className="ai-bar-title">
            <TokenIcon size={13} /> AI 加练
          </strong>
          <span className="hint">{open ? '按今天的计划项生成，由你决定什么时候点' : meta.brief}</span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {stats && stats.today.tokens > 0 ? (
            <span className="ai-usage" title={`累计 ${stats.total.tokens} tokens · ${stats.total.items} 条题库`}>
              <TokenIcon size={11} /> 今日 {fmtTokens(stats.today.tokens)} tokens
            </span>
          ) : null}
          {!open ? (
            <button className="btn btn-sm" onClick={() => setOpen(true)}>
              打开
            </button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="ai-body">
          {phase === 'idle' ? (
            <>
              <div className="ai-estimate">
                <span className="chip chip-accent">{result ? '可以再来一批' : meta.tokens}</span>
                <span className="hint">
                  5 分钟内重复点击不会重复调用模型；生成的内容会存入本地题库，标注来源模型。
                </span>
              </div>
              <div className="row" style={{ alignItems: 'center' }}>
                <button className="btn btn-primary btn-sm" onClick={() => run(Boolean(result))}>
                  {result ? (
                    <>
                      <TokenIcon size={13} /> 再生成一批（消耗 token）
                    </>
                  ) : (
                    <>
                      <TokenIcon size={13} /> 让 AI 出一批
                    </>
                  )}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
                  收起
                </button>
                <span className="hint">{meta.hint}</span>
              </div>
            </>
          ) : null}

          {phase === 'loading' ? (
            <CreativeLoading
              compact
              variant="enrich"
              kind={kind}
              tokenLabel={meta.tokens.replace(/\s*tokens\s*$/, '')}
              modelHint={stats?.activeModel || null}
              subtitle={`${meta.brief} · 生成后直接入库，可反复练习`}
            />
          ) : null}

          {phase === 'error' ? (
            <div className="stack" style={{ gap: 10 }}>
              <Banner tone="danger">{error}</Banner>
              <div className="row">
                <button className="btn btn-sm" onClick={() => run(false)}>
                  重试
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
                  收起
                </button>
              </div>
            </div>
          ) : null}

          {phase === 'ready' && result ? (
            <>
              <div className="ai-meta">
                <span className="ai-model" title={`来源：${result.provider}`}>
                  ✦ {result.model || '未知模型'}
                </span>
                <span className="chip">{result.provider}</span>
                {result.cached ? (
                  <span className="chip chip-gold" title="同一批内容在 5 分钟内被再次请求，直接复用">
                    未消耗 token · 复用刚才的结果
                  </span>
                ) : (
                  <span className="chip chip-teal">本次 {result.usage.totalTokens} tokens</span>
                )}
                {result.latencyMs > 0 ? (
                  <span className="hint">{(result.latencyMs / 1000).toFixed(1)}s</span>
                ) : null}
                <span className="chip chip-ok">
                  {result.newCount > 0 ? `新增 ${result.newCount} 条入库` : '内容已在题库中'}
                </span>
                {result.duplicateCount > 0 ? (
                  <span className="hint">跳过重复 {result.duplicateCount} 条</span>
                ) : null}
                {result.repaired ? (
                  <span
                    className="chip chip-gold"
                    title={`模型返回的格式不太规矩，已自动修复并抢救入库${result.dropped ? `；另有 ${result.dropped} 条实在救不回被丢弃` : ''}，没有多花一次调用`}
                  >
                    已自动修复格式{(result.dropped ?? 0) > 0 ? ` · 丢弃 ${result.dropped} 条` : ''}
                  </span>
                ) : null}
              </div>
              {result.note ? <div className="ai-note">{result.note}</div> : null}

              {words.length > 0 ? (
                <div className="ai-group">
                  <div className="ai-group-head">
                    词汇 · {words.length} 个
                    <span className="hint">已写入词汇本，标注「AI · {result.model}」</span>
                  </div>
                  <div className="ai-words">
                    {words.map((word) => (
                      <div className="ai-word" key={`${word.term}-${word.meaning}`}>
                        <div className="ai-word-top">
                          <strong>{word.term}</strong>
                          {word.reading ? <span className="ai-reading">{word.reading}</span> : null}
                          {word.pos ? <span className="chip">{word.pos}</span> : null}
                        </div>
                        <div className="ai-word-meaning">{word.meaning}</div>
                        {word.example ? (
                          <div className="ai-word-example">
                            {word.example}
                            {word.exampleCn ? <span>{word.exampleCn}</span> : null}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {quizzes.length > 0 ? (
                <div className="ai-group">
                  <div className="ai-group-head">
                    理解检测 · {quizzes.length} 题<span className="hint">先做，再看解析</span>
                  </div>
                  <Quiz
                    questions={quizzes.map((item) => ({
                      prompt: item.prompt,
                      options: item.options,
                      answer: item.answer,
                      explain: item.explain,
                    }))}
                  />
                </div>
              ) : null}

              {sentences.length > 0 ? (
                <div className="ai-group">
                  <div className="ai-group-head">
                    句子拆解 · {sentences.length} 句<span className="hint">先自己划主干</span>
                  </div>
                  <div className="ai-sentences">
                    {sentences.map((item) => (
                      <div className="ai-sentence" key={item.text}>
                        <div className="ai-sentence-text">{item.text}</div>
                        <div className="ai-sentence-cn">{item.translation}</div>
                        {item.tips.length > 0 ? (
                          <ul className="ai-tips">
                            {item.tips.map((tip) => (
                              <li key={tip}>{tip}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {prompts.length > 0 ? (
                <div className="ai-group">
                  <div className="ai-group-head">
                    任务 · {prompts.length} 个<span className="hint">照着说/写，再换成自己的内容</span>
                  </div>
                  <div className="stack" style={{ gap: 12 }}>
                    {prompts.map((item) => (
                      <div className="ai-prompt" key={item.title}>
                        <div className="ai-prompt-title">{item.title}</div>
                        <div className="ai-prompt-scenario">{item.scenario}</div>
                        {item.outline.length > 0 ? (
                          <div className="ai-prompt-block">
                            <span className="ai-label">提纲</span>
                            <ol className="ai-list">
                              {item.outline.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ol>
                          </div>
                        ) : null}
                        {item.phrases.length > 0 ? (
                          <div className="ai-prompt-block">
                            <span className="ai-label">可套用</span>
                            <div className="row" style={{ gap: 6 }}>
                              {item.phrases.map((phrase) => (
                                <span className="chip" key={phrase}>
                                  {phrase}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {item.sample ? (
                          <details className="ai-sample">
                            <summary>看范例</summary>
                            <p>{item.sample}</p>
                          </details>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="ai-foot">
                <button className="btn btn-sm" onClick={() => run(true)} disabled={phase !== 'ready'}>
                  <TokenIcon size={13} /> 再生成一批（消耗 token）
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
                  收起
                </button>
                <span className="spacer" />
                <span className="hint">
                  {result.cached
                    ? '刚才这一批还在 5 分钟缓存里，想换内容就点「再生成一批」'
                    : `来自 ${result.provider} ${result.model} · 已存入本地题库`}
                </span>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

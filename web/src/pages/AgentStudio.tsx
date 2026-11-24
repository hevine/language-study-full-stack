/**
 * Lingua Studio —— 学习者工作台。
 *
 * 形态不是聊天框，而是「上下文 / 执行过程 / 产物」三栏同屏：
 * 你能看着它动手，也能在最后一步否决。模仿的是 Trae、Qoder 那类编码 Agent 的工作台，
 * 因为外语学习的真实缺口也是「拉」而非「推」—— 困惑是临时的、碎片的、跨场景的。
 *
 * 三栏各有明确职责，不重叠：
 *   左：给什么上下文（场景 / 输入 / 帮助档位）
 *   中：它做了什么、凭什么可信（步骤 + Lingua CI 五关）
 *   右：产物长什么样、要不要采纳
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import AdoptBar from '../components/agent/AdoptBar';
import ArtifactView from '../components/agent/ArtifactView';
import RunTimeline, { type RunPhase } from '../components/agent/RunTimeline';
import { CATEGORY_LABEL, HELP_LEVELS, sceneName } from '../components/agent/labels';
import { todayISO, useApp } from '../store';
import type {
  AgentArtifact,
  AgentHelpLevel,
  AgentRun,
  AgentRunStep,
  AgentRunSummary,
  AgentScenesResponse,
  AgentScene,
  AgentVerifyReport,
} from '../agentTypes';
import type { Article } from '../types';

const INPUT_PLACEHOLDER: Record<string, string> = {
  writing: '把你的作文贴进来。有题目的话一起贴上，评分会按题目要求来。',
  sentence: '贴一句你读不懂的句子，或者想写得更地道的那句。',
  reading: '从右侧选一篇今天的文章，也可以写一句想让它重点讲的地方。',
  default: '说说你现在卡在哪。越具体越好：是看不懂、写不出，还是记不住。',
};

export default function AgentStudio() {
  const { language } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const [scenes, setScenes] = useState<AgentScenesResponse | null>(null);
  const [scenesError, setScenesError] = useState<string | null>(null);

  const [sceneId, setSceneId] = useState('');
  const [text, setText] = useState('');
  const [helpLevel, setHelpLevel] = useState<AgentHelpLevel>('L1');
  const [articleId, setArticleId] = useState('');
  const [articles, setArticles] = useState<Article[]>([]);

  const [phase, setPhase] = useState<RunPhase>('idle');
  const [plannedTools, setPlannedTools] = useState<string[]>([]);
  const [steps, setSteps] = useState<AgentRunStep[]>([]);
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [activeArt, setActiveArt] = useState(0);
  const [verify, setVerify] = useState<AgentVerifyReport | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [sceneTag, setSceneTag] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clarify, setClarify] = useState<{ message: string; candidates: Array<{ id: string; title: string }> } | null>(null);
  const [history, setHistory] = useState<AgentRunSummary[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  /** 深链只认第一次：用户自己点历史时不该又被 URL 重新加载一遍 */
  const deepLinked = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .agentScenes()
      .then((res) => {
        if (alive) setScenes(res);
      })
      .catch((err: Error) => {
        if (alive) setScenesError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const refreshHistory = useCallback(() => {
    api
      .agentRuns(6)
      .then((res) => setHistory(res.runs))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // 离开页面时断开流，别让后端继续跑一个没人看的 run
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const pack = scenes?.langs.find((item) => item.code === language) ?? null;

  /** 场景在「当前语种 + 当前语言包能力」下能不能跑；不能跑要给理由，不是灰掉不说话 */
  const support = useCallback(
    (scene: AgentScene): { ok: boolean; reason: string } => {
      if (!pack) return { ok: false, reason: '这个语种还没有语言包' };
      const why = pack.unsupported[scene.category];
      if (why) return { ok: false, reason: why };
      if (pack.supported.length > 0 && !pack.supported.includes(scene.category)) {
        return { ok: false, reason: `${pack.name}暂不支持这个场景` };
      }
      return { ok: true, reason: '' };
    },
    [pack],
  );

  const selected = useMemo(
    () => scenes?.scenes.find((item) => item.id === sceneId) ?? null,
    [scenes, sceneId],
  );

  const needsArticle = selected?.category === 'reading';

  // 阅读场景需要文章 id：讲解视频按文章生成，不是任意文本都能起作业
  useEffect(() => {
    if (!needsArticle) return undefined;
    let alive = true;
    api
      .dayBrief(todayISO())
      .then((res) => {
        if (!alive) return;
        setArticles(res.articles);
        setArticleId((prev) => prev || res.articles[0]?.id || '');
      })
      .catch(() => setArticles([]));
    return () => {
      alive = false;
    };
  }, [needsArticle]);

  const running = phase === 'running';
  const canRun = (text.trim().length > 0 || (needsArticle && articleId.length > 0)) && !running && Boolean(pack?.ready);

  const resetOutput = () => {
    setSteps([]);
    setArtifacts([]);
    setActiveArt(0);
    setVerify(null);
    setRun(null);
    setError(null);
    setClarify(null);
    setConfidence(null);
    setSceneTag(null);
    setPlannedTools([]);
  };

  const start = async () => {
    if (!canRun) return;
    const controller = new AbortController();
    abortRef.current = controller;
    resetOutput();
    setPhase('running');
    let settled = false;

    try {
      await api.agentRunStream(
        {
          lang: language,
          mode: 'craft',
          query: text.slice(0, 200),
          text,
          scene: sceneId || undefined,
          articleId: needsArticle ? articleId : undefined,
          helpLevel,
        },
        (event) => {
          switch (event.type) {
            case 'start':
              setPlannedTools(event.steps);
              setSceneTag(event.scene);
              setConfidence(event.confidence);
              break;
            case 'step':
              setSteps((prev) => {
                const next = prev.filter((item) => item.n !== event.step.n);
                return [...next, event.step].sort((a, b) => a.n - b.n);
              });
              break;
            case 'artifact':
              setArtifacts((prev) => [...prev, event.artifact]);
              break;
            case 'verify':
              setVerify(event.report);
              break;
            case 'done':
              settled = true;
              setRun(event.run);
              setPhase('done');
              deepLinked.current = true;
              setSearchParams({ run: event.run.runId }, { replace: true });
              refreshHistory();
              break;
            case 'clarify':
              settled = true;
              setClarify({ message: event.message, candidates: event.candidates });
              setPhase('clarify');
              break;
            case 'error':
              settled = true;
              setError(event.message);
              setPhase('error');
              break;
            default:
              break;
          }
        },
        controller.signal,
      );

      // 流正常结束但没给终态：说明连接被中间层掐了，不能让它永远停在「正在执行」
      if (!settled) {
        setError('连接中断了，这次 run 没跑完。再点一次「开始」重试。');
        setPhase('error');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPhase('idle');
        setError(null);
      } else {
        setError((err as Error).message);
        setPhase('error');
      }
    } finally {
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('idle');
  };

  /**
   * 回放一次 run。历史列表与深链共用这条路，
   * 保证「从哪儿点开」看到的都是同一份东西。
   */
  const openRun = useCallback(
    async (runId: string) => {
      try {
        const { run: loaded } = await api.agentRun(runId);
        setRun(loaded);
        setSteps(loaded.steps);
        setArtifacts(loaded.artifacts);
        setActiveArt(0);
        setVerify(loaded.verify ?? null);
        setSceneTag(loaded.scene);
        setConfidence(null);
        setPlannedTools(loaded.steps.map((item) => item.tool));
        setClarify(null);
        setError(null);
        setPhase('done');
        deepLinked.current = true;
        setSearchParams({ run: runId }, { replace: true });
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
      }
    },
    [setSearchParams],
  );

  // 深链：#/studio?run=xxx 直接把某次执行摆回工作台（一次批改可以发给别人看）
  useEffect(() => {
    if (deepLinked.current) return;
    const id = searchParams.get('run');
    if (!id) return;
    deepLinked.current = true;
    void openRun(id);
  }, [searchParams, openRun]);

  const placeholder = INPUT_PLACEHOLDER[selected?.category ?? 'default'] ?? INPUT_PLACEHOLDER.default;
  const activeArtifact = artifacts[activeArt] ?? null;

  return (
    <div className="studio">
      <div className="page-head studio-page-head">
        <div>
          <div className="eyebrow">LINGUA STUDIO</div>
          <h1>AI 学习台</h1>
          <p className="page-sub">
            把卡住的地方交给它，看着它拆解、批改、生成；产物由你决定要不要采纳。
          </p>
        </div>
        <div className="studio-head-chips">
          <span className="chip">{pack?.name ?? language}</span>
          <span className="chip">{pack?.scale.toUpperCase() ?? '—'}</span>
          <span className="chip chip-accent">{scenes?.scenes.length ?? 0} 个场景</span>
        </div>
      </div>

      {scenesError ? <div className="banner banner-danger">{scenesError}</div> : null}
      {pack && !pack.ready ? (
        <div className="banner">
          {pack.name}的语言能力（分词 / 句法 / 错误体系）还没接通，现在只能登记场景、不能真正执行。
          先切到英语试，或者等语言包补齐。
        </div>
      ) : null}

      <div className="studio-grid">
        {/* ---------------- 左：上下文 ---------------- */}
        <section className="card studio-col">
          <div className="studio-col-head">上下文</div>
          <div className="studio-col-body">
            <div className="studio-block">
              <div className="studio-block-head">
                <span>场景</span>
                <span className="hint">不选就让它自己判断</span>
              </div>
              <div className="studio-chips">
                <button
                  className={`studio-chip${sceneId === '' ? ' is-on' : ''}`}
                  onClick={() => setSceneId('')}
                >
                  自动判断
                </button>
                {scenes?.scenes.map((scene) => {
                  const sup = support(scene);
                  return (
                    <button
                      key={scene.id}
                      className={`studio-chip${sceneId === scene.id ? ' is-on' : ''}`}
                      disabled={!sup.ok}
                      title={sup.ok ? `${CATEGORY_LABEL[scene.category]} · ${scene.title}` : sup.reason}
                      onClick={() => setSceneId(scene.id)}
                    >
                      {scene.title}
                    </button>
                  );
                })}
              </div>
              {selected ? (
                <p className="hint studio-scene-hint">
                  {CATEGORY_LABEL[selected.category]} · 默认帮助档位 {selected.helpDefault} · 场景包 v{selected.version}
                </p>
              ) : null}
            </div>

            <div className="studio-block">
              <div className="studio-block-head">
                <span>输入</span>
                <span className="hint">{text.length} 字</span>
              </div>
              <textarea
                className="input studio-textarea"
                rows={7}
                value={text}
                placeholder={placeholder}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void start();
                }}
              />
              <p className="hint">⌘/Ctrl + Enter 直接开始</p>

              {needsArticle ? (
                <label className="studio-field">
                  <span>讲解哪篇</span>
                  {articles.length > 0 ? (
                    <select className="select" value={articleId} onChange={(event) => setArticleId(event.target.value)}>
                      {articles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input"
                      value={articleId}
                      placeholder="填文章 id（今日还没有生成文章时）"
                      onChange={(event) => setArticleId(event.target.value)}
                    />
                  )}
                </label>
              ) : null}
            </div>

            <div className="studio-block">
              <div className="studio-block-head">
                <span>帮助档位</span>
                <span className="hint">最小帮助原则</span>
              </div>
              <div className="studio-chips">
                {HELP_LEVELS.map((level) => (
                  <button
                    key={level.id}
                    className={`studio-chip${helpLevel === level.id ? ' is-on' : ''}`}
                    onClick={() => setHelpLevel(level.id)}
                  >
                    {level.id} · {level.name}
                  </button>
                ))}
              </div>
              <p className="hint">
                {HELP_LEVELS.find((level) => level.id === helpLevel)?.hint}
              </p>
            </div>

            <div className="studio-actions">
              {running ? (
                <button className="btn btn-block" onClick={stop}>停下来</button>
              ) : (
                <button className="btn btn-primary btn-block" disabled={!canRun} onClick={() => void start()}>
                  {pack && !pack.ready ? '语言包未就绪' : '开始'}
                </button>
              )}
            </div>

            {history.length > 0 ? (
              <div className="studio-block studio-history">
                <div className="studio-block-head">
                  <span>最近</span>
                  <span className="hint">点开可回放</span>
                </div>
                <ul>
                  {history.map((item) => (
                    <li key={item.runId}>
                      <button onClick={() => void openRun(item.runId)}>
                        <span className={`studio-history-dot${item.ok ? '' : ' is-bad'}`} />
                        <span className="studio-history-scene">{sceneName(item.scene)}</span>
                        <span className="hint">{new Date(item.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>

        {/* ---------------- 中：执行过程 ---------------- */}
        <section className="card studio-col">
          <div className="studio-col-head">
            执行过程
            {running ? <span className="studio-live" aria-hidden="true" /> : null}
          </div>
          <div className="studio-col-body">
            <RunTimeline
              phase={phase}
              plan={plannedTools}
              steps={steps}
              verify={verify}
              run={run}
              scene={sceneTag}
              confidence={confidence}
              error={error}
              clarify={clarify}
              onPickScene={(id) => {
                setSceneId(id);
                setClarify(null);
                setPhase('idle');
              }}
            />
          </div>
        </section>

        {/* ---------------- 右：产物 ---------------- */}
        <section className="card studio-col">
          <div className="studio-col-head">
            产物
            {artifacts.length > 1 ? (
              <span className="studio-art-tabs">
                {artifacts.map((item, index) => (
                  <button
                    key={item.artifactId}
                    className={`studio-art-tab${index === activeArt ? ' is-on' : ''}`}
                    onClick={() => setActiveArt(index)}
                  >
                    {item.title}
                  </button>
                ))}
              </span>
            ) : artifacts.length === 1 ? (
              <span className="hint">{artifacts[0].title}</span>
            ) : null}
          </div>

          <div className="studio-col-body studio-art-body">
            {activeArtifact ? (
              <ArtifactView artifact={activeArtifact} />
            ) : run && !run.ok ? (
              <div className="run-empty">
                <p className="run-empty-title">这次没有产出产物</p>
                <ul className="run-empty-list">
                  <li>{run.error ?? '有步骤失败了，中间栏能看到卡在哪一步'}</li>
                  <li>最常见的原因是模型这一步没跑完（长作文批改尤其容易超时）</li>
                  <li>重试一次通常就能过；连续失败的话，换个短一点的输入先试</li>
                </ul>
              </div>
            ) : (
              <div className="run-empty">
                <div className="run-empty-mark" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <p className="run-empty-title">产物会出现在这里</p>
                <ul className="run-empty-list">
                  <li>写作批改：逐条 diff（改前 / 改后 / 错因 / 规则）</li>
                  <li>句子拆解：成分树，主干与修饰分层</li>
                  <li>阅读讲解：讲解视频，异步生成、可看进度</li>
                </ul>
              </div>
            )}
          </div>

          {activeArtifact && run ? (
            // key 用产物 id：切产物页签时必须换一个全新的采纳状态，
            // 否则上一份产物「已采纳」的结果会挂在下一份产物上
            <AdoptBar key={activeArtifact.artifactId} runId={run.runId} artifact={activeArtifact} />
          ) : activeArtifact ? (
            <div className="adopt-bar">
              <span className="hint">等这次 run 收尾后才能采纳（产物还要过校验）</span>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

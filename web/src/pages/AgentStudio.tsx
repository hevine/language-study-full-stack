/**
 * Lingua Studio —— 学习者的首页。
 *
 * 定位：这是「每天打开的第一屏」，不是「遇到难题才进来的工具页」。
 * 所以页面先回答「今天做什么」（到期复习 / 今日任务 / 节奏），再给出唯一的高频动作
 * —— 把卡住的地方放进来。低频的「这句读不懂」从这里点进去解决。
 *
 * 形态：一条纵向流，不并列。
 *   今天该做什么 → 输入 → 它怎么动手 → 产物 → 要不要采纳
 * 为什么不是原来的三栏：「输入 / 执行 / 产物」是时间上依次发生的三个阶段，
 * 并列会永远空着 1–2 栏（空态时 2/3 是死区），而且把最该宽的产物挤到 1.12fr，
 * 长句 diff 折行严重。收成纵向流后，产物拿全宽，阅读动线不再横向跳。
 *
 * 三条底线没有为了好看让步：
 *   1. Lingua CI 五关在折叠条上就有徽章（G1–G5 的成败一眼可见），展开看详情；
 *   2. 采纳仍是显式两步（AdoptBar：预览落点 → 确认写入），绝不自动保存；
 *   3. 深链 ?run=<id> 可回放，离开页面 abort 流。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import AdoptBar from '../components/agent/AdoptBar';
import ArtifactView from '../components/agent/ArtifactView';
import RunTimeline, { type RunPhase } from '../components/agent/RunTimeline';
import SpeechInput from '../components/agent/SpeechInput';
import {
  CATEGORY_LABEL,
  HELP_LEVELS,
  formatTokens,
  toolLabel,
} from '../components/agent/labels';
import { diffDays, formatCn, todayISO, useApp } from '../store';
import type {
  AgentArtifact,
  AgentAudio,
  AgentHelpLevel,
  AgentRun,
  AgentRunStep,
  AgentRunSummary,
  AgentScenesResponse,
  AgentScene,
  AgentVerifyReport,
  TranscriptSource,
} from '../agentTypes';
import type { DayResponse } from '../types';
import type { LoopToday } from '../loopTypes';

const INPUT_PLACEHOLDER: Record<string, string> = {
  writing: '把你的作文贴进来。有题目的话一起贴上，评分会按题目要求来。',
  sentence: '贴一句你读不懂的句子，或者想写得更地道的那句。',
  reading: '从下面选一篇今天的文章，也可以写一句想让它重点讲的地方。',
  speaking: '录一段、导一个录音笔文件，或者直接把想练的稿子贴进来 —— 评流利度、语法、连贯与用词。',
  default: '说说你现在卡在哪。越具体越好：是看不懂、写不出，还是记不住。',
};

/** 首页的三个入口：对应三条最高频的「我卡住了」，点一下就把场景与输入框准备好 */
const QUICK_START: Array<{ scene: string; title: string; desc: string; output: string }> = [
  {
    scene: 'writing-exam',
    title: '作文批改',
    desc: '贴一篇作文，按你考的科目与目标分逐条改',
    output: '逐条 diff · 改前 / 改后 / 错因 / 规则',
  },
  {
    scene: 'sentence-parse',
    title: '长难句拆解',
    desc: '读不懂的那一句，拆主干、划从句、回译比对',
    output: '成分树 · 主干与修饰分层',
  },
  {
    scene: 'reading-explain',
    title: '阅读讲解',
    desc: '让它讲今天那篇精读，出一支讲解视频',
    output: '讲解视频 · 异步生成、可看进度',
  },
];

function greetingOf(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/** 秒表：单步 LLM 40–80 秒很常见，不给计时器就会以为卡死 */
function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const startedAt = useRef(Date.now());
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

export default function AgentStudio() {
  const { language, plan } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  /* ---------- 首页要的三份数据：场景 / 今天该做什么 / 最近 ---------- */
  const [scenes, setScenes] = useState<AgentScenesResponse | null>(null);
  const [scenesError, setScenesError] = useState<string | null>(null);
  const [loop, setLoop] = useState<LoopToday | null>(null);
  const [day, setDay] = useState<DayResponse | null>(null);
  const [history, setHistory] = useState<AgentRunSummary[]>([]);

  /* ---------- 输入 ---------- */
  const [sceneId, setSceneId] = useState('');
  const [text, setText] = useState('');
  const [helpLevel, setHelpLevel] = useState<AgentHelpLevel>('L1');
  const [articleId, setArticleId] = useState('');
  const [articles, setArticles] = useState<DayResponse['articles']>([]);
  /** 口语输入：挂在这次提问上的录音（run 只带它的 id，不带字节） */
  const [audio, setAudio] = useState<AgentAudio | null>(null);
  /** 上一次转写出来的原文：用来判断用户有没有动过稿子，从而说清「评的是什么」 */
  const [asrText, setAsrText] = useState('');

  /* ---------- 执行 ---------- */
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
  /** 过程默认折叠成一行摘要；运行中展开，成功后自动收起 */
  const [stepsOpen, setStepsOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);
  /** 跑完一次才自动滚到产物；深链回放也滚一次，别让人自己找 */
  const pendingScroll = useRef(false);
  /** 深链只认第一次：用户自己点历史时不该又被 URL 重新加载一遍 */
  const deepLinked = useRef(false);

  const elapsed = useElapsed(phase === 'running');

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

  /** 首页数字（到期卡片 / 今日任务 / 节奏）——采纳一次后要能立刻变 */
  const refreshToday = useCallback(() => {
    api
      .loopToday()
      .then(setLoop)
      .catch(() => setLoop(null));
    if (!plan) {
      setDay(null);
      return;
    }
    api
      .dayBrief(todayISO())
      .then(setDay)
      .catch(() => setDay(null));
  }, [plan]);

  useEffect(() => {
    refreshHistory();
    refreshToday();
  }, [refreshHistory, refreshToday]);

  // 离开页面时断开流，别让后端继续跑一个没人看的 run
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // 输入框跟着内容长高：首页的主输入不该是一个卡死的 3 行小窗
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 340)}px`;
  }, [text]);

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

  /** 场景按钮按「首页最常用」排序，不跟服务端的注册顺序走 */
  const orderedScenes = useMemo(() => {
    const order = ['writing', 'sentence', 'reading', 'vocab', 'grammar', 'speaking'];
    const list = scenes?.scenes ?? [];
    return [...list].sort((a, b) => {
      const ai = order.indexOf(a.category);
      const bi = order.indexOf(b.category);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }, [scenes]);

  /** run 里存的是 `sentence-parse@0.1.0`，界面要说人话 */
  const sceneTitle = useCallback(
    (id: string | null) => {
      if (!id) return '—';
      const key = id.split('@')[0];
      return scenes?.scenes.find((item) => item.id === key)?.title ?? key;
    },
    [scenes],
  );

  const needsArticle = selected?.category === 'reading';
  const needsSpeech = selected?.category === 'speaking';

  /** 转写稿落到输入框：用户看得见、改得动，识别错了不用重说一遍 */
  const handleTranscript = useCallback((next: string) => {
    setText(next);
    setAsrText(next);
  }, []);

  const handleAudioChange = useCallback((next: AgentAudio | null) => {
    setAudio(next);
    if (!next) setAsrText('');
  }, []);

  /**
   * 这次评的是什么：录音转写 / 改过的转写稿 / 手打文本。
   * 「改过」必须单独标出来 —— 改过的稿子还是能评语法与用词，
   * 但流利度只能按文本推测，不能再声称是录音实测。
   */
  const transcriptSource: TranscriptSource = audio
    ? text.trim() && text.trim() !== asrText.trim()
      ? 'asr-edited'
      : 'asr'
    : 'typed';

  const basisLabel = audio
    ? transcriptSource === 'asr-edited'
      ? '录音转写（你改过）'
      : '录音转写'
    : '手打文本';

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
  /**
   * 能跑的条件：有稿子、有录音（口语可以先转写再评）、或者阅读场景选了文章。
   * 口语允许「只有录音没有稿」，因为转写本来就可以在服务端那一步完成 ——
   * 页面上不该逼用户先等转写成功才能点开始。
   */
  const hasInput = text.trim().length > 0 || (needsSpeech && Boolean(audio)) || (needsArticle && articleId.length > 0);
  const canRun = hasInput && !running && Boolean(pack?.ready);

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
    setStepsOpen(true);
    setPhase('running');
    pendingScroll.current = true;
    let settled = false;

    try {
      await api.agentRunStream(
        {
          lang: language,
          mode: 'craft',
          query: text.slice(0, 200),
          text: text.trim() ? text : undefined,
          scene: sceneId || undefined,
          articleId: needsArticle ? articleId : undefined,
          // 口语才带录音：写作/阅读场景挂一段音频进去只会让 trace 变脏
          audioRef: needsSpeech ? audio?.audioId : undefined,
          audioName: needsSpeech ? audio?.name : undefined,
          audioDurationMs: needsSpeech ? audio?.durationMs ?? undefined : undefined,
          audioSource: needsSpeech ? audio?.source : undefined,
          transcriptSource: needsSpeech ? transcriptSource : undefined,
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
              // 有产物就收起过程，把首屏让给结果；没产物时留在展开态，让人看见卡在哪
              setStepsOpen(event.run.artifacts.length === 0 || !event.run.ok);
              deepLinked.current = true;
              setSearchParams({ run: event.run.runId }, { replace: true });
              refreshHistory();
              refreshToday();
              break;
            case 'clarify':
              settled = true;
              setClarify({ message: event.message, candidates: event.candidates });
              setPhase('clarify');
              setStepsOpen(true);
              break;
            case 'error':
              settled = true;
              setError(event.message);
              setPhase('error');
              setStepsOpen(true);
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
        setStepsOpen(true);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPhase('idle');
        setError(null);
      } else {
        setError((err as Error).message);
        setPhase('error');
        setStepsOpen(true);
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
   *
   * 滚动策略分两种：站内点历史 → 直接滚到产物；深链打开 → 停在页首。
   * 深链是别人发来的链接，第一屏该先交代「这是哪天、什么场景」，别一上来就跳走半屏。
   */
  const openRun = useCallback(
    async (runId: string, options?: { scroll?: boolean }) => {
      pendingScroll.current = options?.scroll !== false;
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
        setStepsOpen(false);
        setPhase('done');
        deepLinked.current = true;
        setSearchParams({ run: runId }, { replace: true });
      } catch (err) {
        pendingScroll.current = false;
        setError((err as Error).message);
        setPhase('error');
        setStepsOpen(true);
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
    void openRun(id, { scroll: false });
  }, [searchParams, openRun]);

  // 结果出现后滚一次，别让用户自己往下找
  useEffect(() => {
    if (!pendingScroll.current || phase !== 'done' || artifacts.length === 0) return;
    pendingScroll.current = false;
    resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [phase, artifacts.length]);

  const placeholder = INPUT_PLACEHOLDER[selected?.category ?? 'default'] ?? INPUT_PLACEHOLDER.default;
  const activeArtifact = artifacts[activeArt] ?? null;

  const helpHint = HELP_LEVELS.find((level) => level.id === helpLevel)?.hint ?? '';

  const gateStats = useMemo(() => {
    if (!verify) return null;
    const pass = verify.gates.filter((gate) => gate.verdict === 'pass').length;
    const fail = verify.gates.filter((gate) => gate.verdict === 'fail').length;
    return { pass, fail, total: verify.gates.length };
  }, [verify]);

  const runningStep = steps.find((step) => step.status === 'running') ?? null;

  const hasRun = phase !== 'idle' || steps.length > 0 || Boolean(run) || Boolean(error) || Boolean(clarify);

  /** 刚点下开始、还在规划步骤的那一两秒，展开也没有东西可看，就别撑出一个空盒子 */
  const stripHasBody =
    plannedTools.length > 0 || steps.length > 0 || Boolean(clarify) || Boolean(error) || Boolean(run);

  /** 折叠条那一行标题：不看详情也知道发生了什么、值不值得信 */
  const stripTitle =
    phase === 'running'
      ? `正在执行${sceneTag ? ` · ${sceneTitle(sceneTag)}` : ''}`
      : phase === 'clarify'
        ? '需要你说清楚一点'
        : phase === 'idle'
          ? '已中断'
          : phase === 'error' || (run && !run.ok)
            ? '这次没跑成'
            : `执行完成${sceneTag ? ` · ${sceneTitle(sceneTag)}` : ''}`;

  const stripSub = (() => {
    if (phase === 'running') {
      const total = plannedTools.length || steps.length;
      const current = runningStep ? ` · ${toolLabel(runningStep.tool)}` : '';
      return `${total > 0 ? `第 ${Math.min(steps.length + 1, total)}/${total} 步` : '正在规划步骤'}${current} · 已用 ${elapsed}s`;
    }
    if (phase === 'clarify') return clarify?.message ?? '场景判断不够有把握，先问你一句';
    if (phase === 'idle') return '你中断了这次执行，没有可采纳的产物';
    if (phase === 'error') return error ?? '有步骤失败了';
    if (run && !run.ok) return run.error ?? '有步骤失败了，展开能看到卡在哪一步';
    return [
      run ? `${run.steps.length} 步` : `${steps.length} 步`,
      run ? `${formatTokens(run.budget.usedTokens)} token` : null,
      gateStats ? `Lingua CI ${gateStats.pass}/${gateStats.total} 通过${gateStats.fail > 0 ? ` · ${gateStats.fail} 项未过` : ''}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  })();

  /* ---------- 首页数字 ---------- */
  const tasks = day?.day.tasks ?? [];
  const doneTasks = tasks.filter((task) => task.done).length;
  const leftMinutes = tasks.filter((task) => !task.done).reduce((sum, task) => sum + task.minutes, 0);
  const daysLeft = plan ? Math.max(0, diffDays(todayISO(), plan.examDate)) : null;
  const adoptedRuns = useMemo(
    () => new Set((loop?.recent ?? []).map((item) => item.runId)),
    [loop],
  );

  const pickQuick = (scene: string) => {
    const target = scenes?.scenes.find((item) => item.id === scene);
    if (target && !support(target).ok) return;
    setSceneId(scene);
    const def = target?.helpDefault;
    if (def) setHelpLevel(def);
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="studio">
      {/* ---------------- 顶部：今天是什么日子、该做什么 ---------------- */}
      <header className="studio-hero">
        <p className="studio-hero-eyebrow">
          <span>{formatCn(todayISO())}</span>
          {plan ? (
            <>
              <span className="studio-hero-sep" aria-hidden="true" />
              <span>{plan.examName}</span>
              <span className="studio-hero-sep" aria-hidden="true" />
              <span>距考试 {daysLeft} 天</span>
            </>
          ) : (
            <>
              <span className="studio-hero-sep" aria-hidden="true" />
              <span>还没有学习计划，先去定个目标</span>
            </>
          )}
        </p>
        <div className="studio-hero-row">
          <h1 className="studio-hero-title">
            {greetingOf(new Date().getHours())}，今天想先啃下哪一块？
          </h1>
          <div className="studio-hero-meta">
            <span className="chip">{pack?.name ?? language}</span>
            <span className="chip">{(pack?.scale ?? '—').toUpperCase()}</span>
          </div>
        </div>
        <p className="studio-hero-sub">
          贴一段作文、一句读不懂的长句，或者让它讲一篇文章。它会拆解、批改、生成 —— 产物由你决定要不要采纳。
        </p>
      </header>

      <section className="studio-today" aria-label="今天该做什么">
        <Link className="studio-tile" to="/loop?view=review">
          <span className="studio-tile-k">到期复习</span>
          <span className="studio-tile-v">
            {loop ? loop.due : '—'}
            <em>张</em>
          </span>
          <span className="studio-tile-n">
            {loop
              ? loop.due > 0
                ? `约 ${loop.minutes} 分钟 · 今天已复习 ${loop.reviewedToday} 张`
                : '今天没有到期的卡'
              : '正在读取…'}
          </span>
          <span className="studio-tile-go">{loop && loop.due > 0 ? '开始复习' : '看看闭环'} →</span>
        </Link>

        <Link className="studio-tile" to={plan ? '/today' : '/setup'}>
          <span className="studio-tile-k">今日任务</span>
          <span className="studio-tile-v">
            {tasks.length > 0 ? tasks.length - doneTasks : '—'}
            <em>{tasks.length > 0 ? '项待做' : ''}</em>
          </span>
          <span className="studio-tile-n">
            {!plan
              ? '还没有学习计划'
              : tasks.length === 0
                ? '今天没有安排任务'
                : `还剩约 ${leftMinutes} 分钟 · 已完成 ${doneTasks}/${tasks.length}`}
          </span>
          <span className="studio-tile-go">{plan ? '去今日任务' : '去定目标'} →</span>
        </Link>

        <div className="studio-tile is-static">
          <span className="studio-tile-k">学习节奏</span>
          <span className="studio-tile-v">
            {loop ? loop.stats.closed : '—'}
            <em>次闭环 / 7 天</em>
          </span>
          <span className="studio-tile-n">
            {loop
              ? `连续 ${loop.stats.streak} 天 · 保持率 ${Math.round(loop.stats.retention * 100)}%`
              : '采纳一次产物就会开始记录'}
          </span>
          <span className="studio-tile-go is-quiet">只数采纳并进复习的那一次</span>
        </div>
      </section>

      {scenesError ? <div className="banner banner-danger">{scenesError}</div> : null}
      {pack && !pack.ready ? (
        <div className="banner">
          {pack.name}的语言能力（分词 / 句法 / 错误体系）还没接通，现在只能登记场景、不能真正执行。
          先切到英语试，或者等语言包补齐。
        </div>
      ) : null}

      {/* ---------------- 输入：首页唯一的主输入 ---------------- */}
      <section className="studio-composer card">
        <div className="studio-composer-main">
          <textarea
            ref={inputRef}
            className="studio-composer-input"
            rows={3}
            value={text}
            placeholder={placeholder}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void start();
            }}
          />
        </div>

        {/* 口语专用：录 / 传 / 纯文本三入口。其它场景不显示，避免把主输入撑成一个大工具箱 */}
        {needsSpeech ? (
          <div className="studio-composer-speech">
            <SpeechInput
              lang={language}
              onTranscript={handleTranscript}
              onAudioChange={handleAudioChange}
              disabled={running}
            />
          </div>
        ) : null}

        <div className="studio-composer-bar">
          <div className="studio-scenes" role="group" aria-label="场景">
            <button
              className={`studio-scene${sceneId === '' ? ' is-on' : ''}`}
              onClick={() => setSceneId('')}
              title="不选场景，让它自己判断（判断不准会反问你）"
            >
              自动判断
            </button>
            {orderedScenes.map((scene) => {
              const sup = support(scene);
              return (
                <button
                  key={scene.id}
                  className={`studio-scene${sceneId === scene.id ? ' is-on' : ''}`}
                  disabled={!sup.ok}
                  title={sup.ok ? `${scene.title} —— 点一下就用这个场景` : sup.reason}
                  onClick={() => {
                    setSceneId(scene.id);
                    setHelpLevel(scene.helpDefault);
                  }}
                >
                  {CATEGORY_LABEL[scene.category]}
                </button>
              );
            })}
          </div>

          <div className="studio-composer-actions">
            <label className="studio-level" title={helpHint}>
              <span className="hint">帮助</span>
              <select
                className="studio-select"
                value={helpLevel}
                onChange={(event) => setHelpLevel(event.target.value as AgentHelpLevel)}
              >
                {HELP_LEVELS.map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.id} · {level.name}
                  </option>
                ))}
              </select>
            </label>
            {running ? (
              <button className="btn" onClick={stop}>
                停下来
              </button>
            ) : (
              <button className="btn btn-primary studio-send" disabled={!canRun} onClick={() => void start()}>
                开始
                <span className="studio-send-key">⌘↵</span>
              </button>
            )}
          </div>
        </div>

        {needsArticle ? (
          <div className="studio-composer-extra">
            <span className="hint">讲解哪篇</span>
            {articles.length > 0 ? (
              <select
                className="studio-select is-wide"
                value={articleId}
                onChange={(event) => setArticleId(event.target.value)}
              >
                {articles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input studio-select is-wide"
                value={articleId}
                placeholder="填文章 id（今日还没有生成文章时）"
                onChange={(event) => setArticleId(event.target.value)}
              />
            )}
          </div>
        ) : null}

        <div className="studio-composer-foot">
          <span className="hint">
            {selected ? `${selected.title} · ${helpHint}` : helpHint}
            {needsSpeech && (audio || text.trim()) ? ` · 评估依据：${basisLabel}` : ''}
          </span>
          <span className="hint">{text.length} 字</span>
        </div>
      </section>

      {/* ---------------- 执行过程：折叠成一行，展开是时间轴 + 五关 ---------------- */}
      {hasRun ? (
        <section className={`studio-strip card is-${phase}${stepsOpen ? ' is-open' : ''}`}>
          <button
            className="studio-strip-head"
            onClick={() => setStepsOpen((open) => !open)}
            aria-expanded={stepsOpen}
          >
            <span className={`studio-strip-dot is-${phase}${run && !run.ok ? ' is-bad' : ''}`} aria-hidden="true" />
            <span className="studio-strip-titles">
              <span className="studio-strip-title">{stripTitle}</span>
              <span className="studio-strip-sub">{stripSub}</span>
            </span>
            {confidence !== null && confidence < 0.75 ? (
              <span className="studio-strip-conf" title="路由器对场景判断的把握；越低越说明这个场景是它猜的">
                场景把握 {Math.round(confidence * 100)}%
              </span>
            ) : null}
            {verify ? (
              <span className="studio-strip-gates" title="Lingua CI 五道校验">
                {verify.gates.map((gate) => (
                  <i key={gate.id} className={`is-${gate.verdict}`} title={`${gate.id} · ${gate.detail || gate.verdict}`}>
                    {gate.id}
                  </i>
                ))}
              </span>
            ) : null}
            <span className="studio-strip-caret">{stepsOpen ? '收起过程' : '看过程'}</span>
          </button>

          {stepsOpen && stripHasBody ? (
            <div className="studio-strip-body">
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
                  const def = scenes?.scenes.find((item) => item.id === id)?.helpDefault;
                  if (def) setHelpLevel(def);
                  setClarify(null);
                  setPhase('idle');
                  setSteps([]);
                  setVerify(null);
                }}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ---------------- 产物：全宽，采纳条贴在下面 ---------------- */}
      {artifacts.length > 0 ? (
        <section className="studio-result card" ref={resultRef}>
          <div className="studio-result-head">
            <span>产物</span>
            {artifacts.length > 1 ? (
              <span className="studio-result-tabs">
                {artifacts.map((item, index) => (
                  <button
                    key={item.artifactId}
                    className={`studio-result-tab${index === activeArt ? ' is-on' : ''}`}
                    onClick={() => setActiveArt(index)}
                  >
                    {item.title}
                  </button>
                ))}
              </span>
            ) : (
              <span className="hint">{artifacts[0].title}</span>
            )}
          </div>
          <div className="studio-result-body">
            {activeArtifact ? <ArtifactView artifact={activeArtifact} /> : null}
          </div>
          {activeArtifact && run ? (
            // key 用产物 id：切产物页签时必须换一个全新的采纳状态，
            // 否则上一份产物「已采纳」的结果会挂在下一份产物上
            <AdoptBar
              key={activeArtifact.artifactId}
              runId={run.runId}
              artifact={activeArtifact}
              onAdopted={() => {
                refreshHistory();
                refreshToday();
              }}
            />
          ) : activeArtifact ? (
            <div className="adopt-bar">
              <span className="hint">等这次 run 收尾后才能采纳（产物还要过校验）</span>
            </div>
          ) : null}
        </section>
      ) : run && !run.ok ? (
        <section className="studio-result card">
          <div className="studio-result-head">
            <span>这次没有产出产物</span>
          </div>
          <div className="studio-result-body">
            <div className="run-empty">
              <p className="run-empty-title">没跑成，不是你操作错了</p>
              <ul className="run-empty-list">
                <li>{run.error ?? '有步骤失败了，上面展开能看到卡在哪一步'}</li>
                <li>最常见的原因是模型这一步没跑完（长作文批改尤其容易超时）</li>
                <li>重试一次通常就能过；连续失败的话，换个短一点的输入先试</li>
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      {/* ---------------- 空态：三种产物长什么样 ---------------- */}
      {!hasRun ? (
        <section className="studio-start">
          <div className="studio-start-head">
            <span>它能替你做的三件事</span>
            <span className="hint">点一下就把场景与输入框准备好</span>
          </div>
          <div className="studio-cards">
            {QUICK_START.map((item) => {
              const target = scenes?.scenes.find((scene) => scene.id === item.scene);
              const sup = target ? support(target) : { ok: true, reason: '' };
              return (
                <button
                  key={item.scene}
                  className="studio-quick"
                  disabled={!sup.ok}
                  title={sup.ok ? item.desc : sup.reason}
                  onClick={() => pickQuick(item.scene)}
                >
                  <span className="studio-quick-title">{item.title}</span>
                  <span className="studio-quick-desc">{sup.ok ? item.desc : sup.reason}</span>
                  <span className="studio-quick-out">{item.output}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ---------------- 最近：一次批改可以点开回放 ---------------- */}
      {history.length > 0 ? (
        <section className="studio-recent">
          <div className="studio-recent-head">
            <span>最近</span>
            <span className="hint">点开回放当时的过程与产物</span>
          </div>
          <ul>
            {history.map((item) => (
              <li key={item.runId}>
                <button onClick={() => void openRun(item.runId)}>
                  <span className={`studio-recent-dot${item.ok ? '' : ' is-bad'}`} aria-hidden="true" />
                  <span className="studio-recent-name">{sceneTitle(item.scene)}</span>
                  {adoptedRuns.has(item.runId) ? <span className="studio-recent-tag">已采纳</span> : null}
                  <span className="hint">
                    {new Date(item.startedAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="studio-foot">
        <span>产物不会自动保存：采纳要两步 —— 先预览会写到哪儿，再确认写入今日任务。</span>
        <Link className="studio-foot-link" to="/loop">
          看学习闭环 →
        </Link>
      </footer>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Field } from '@waiyubaodian/ui-kit';
import { Banner, EmptyState, Loading, SectionCard } from '../components/ui';
import { useApp } from '../store';
import type { LexiconResponse, VocabWord } from '../types';
import { useVoicePlayer } from '../hooks/useVoicePlayer';

const GRADES = [
  { grade: 0, label: '忘记', hint: '明天再来' },
  { grade: 1, label: '模糊', hint: '稍后复习' },
  { grade: 2, label: '记得', hint: '按曲线排' },
  { grade: 3, label: '熟练', hint: '拉长间隔' },
];

type Mode = 'review' | 'all' | 'library';

const LEVEL_LABEL: Record<string, string> = {
  L1: 'L1 基础',
  L2: 'L2 核心',
  L3: 'L3 进阶',
  L4: 'L4 学术',
  L5: 'L5 高难',
  basic: '过渡词',
  core: '核心',
  advanced: '拉分',
  n5: 'N5',
  n4: 'N4',
  n3: 'N3',
  n2: 'N2',
  n1: 'N1',
  ko1: '1级',
  ko2: '2级',
  ko3: '3级',
  ko4: '4级',
  ko5: '5级',
  ko6: '6级',
};

/** 词汇页的语种文案：英语 / 日语 / 韩语各自的标题与提示 */
const LANG_COPY = {
  en: {
    name: '英语',
    heading: '词汇本',
    eyebrow: 'Vocabulary · 间隔重复',
    searchAll: '搜索词或释义',
    searchLib: '查词、释义或主题',
    libTitle: '托福分级词库（L1–L5 · 1600 词）',
    emptyHint: '去「分级词库」把 L1–L5 任一级整级加入，或完成今天的英语精读任务。',
    reviewTip: '英语词条注意音标重音，托福听力里听不出的词，多半是重音位置记错了。',
  },
  ja: {
    name: '日语',
    heading: '語彙帳',
    eyebrow: 'Vocabulary · 語彙帳',
    searchAll: '搜索词形、假名或释义',
    searchLib: '查词、假名或主题',
    libTitle: 'JLPT 分级词库（N5 / N4 / N3 / N2 / N1）',
    emptyHint: '去「分级词库」把 N5 入门词整级加入，或完成今天的日语精读任务。',
    reviewTip: '日语词条先读假名再看汉字：先读准再记义；带例句的词条可结合例句记忆。',
  },
  ko: {
    name: '韩语',
    heading: '단어장',
    eyebrow: 'Vocabulary · 단어장',
    searchAll: '搜索词形、读音或释义',
    searchLib: '查词、读音或主题',
    libTitle: 'TOPIK 分级词库（1–6 级）',
    emptyHint: '去「分级词库」把 3 级核心词整级加入，或完成今天的韩语精读任务。',
    reviewTip: '韩语词条先把字形和读音对上再记意思：收尾音（받침）读不准，听力里的连音就辨不出来。',
  },
} as const;

export default function VocabPage() {
  const { plan } = useApp();
  const language = plan?.language ?? 'en';
  const copy = LANG_COPY[language] ?? LANG_COPY.en;

  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [mode, setMode] = useState<Mode>(
    initialTab === 'all' || initialTab === 'library' ? initialTab : 'review',
  );
  const [queue, setQueue] = useState<VocabWord[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [graded, setGraded] = useState(0);
  const [words, setWords] = useState<VocabWord[]>([]);
  const [stats, setStats] = useState({ total: 0, due: 0, mastered: 0 });
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [lex, setLex] = useState<LexiconResponse | null>(null);
  const [lexLevel, setLexLevel] = useState<string | null>(null);
  const [lexQuery, setLexQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wordVoice = useVoicePlayer('word');

  const loadDue = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.vocabDue(language, 30);
      setQueue(response.words);
      setIndex(0);
      setRevealed(false);
      setGraded(0);
      const all = await api.vocab(language);
      setStats(all.stats);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [language]);

  const loadAll = useCallback(
    async (search: string) => {
      setLoading(true);
      try {
        const response = await api.vocab(language, search || undefined);
        setWords(response.words);
        setStats(response.stats);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [language],
  );

  useEffect(() => {
    loadDue();
  }, [loadDue]);

  useEffect(() => {
    if (mode === 'all') loadAll(query);
  }, [mode, loadAll, query]);

  // 切换语种后把词库面板重置，避免把英语的级别选择带到日语里
  useEffect(() => {
    setLex(null);
    setLexLevel(null);
    setLexQuery('');
    setNotice(null);
  }, [language]);

  useEffect(() => {
    if (mode !== 'library') return;
    let cancelled = false;
    setLoading(true);
    api
      .lexicon(language, lexLevel ?? undefined, lexQuery || undefined)
      .then((response) => {
        if (cancelled) return;
        setLex(response);
        if (!lexLevel) {
          const fallback =
            response.planLevelId && response.levels.some((item) => item.id === response.planLevelId)
              ? response.planLevelId
              : response.levels[0]?.id ?? null;
          if (fallback) setLexLevel(fallback);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, language, lexLevel, lexQuery]);

  const grade = async (value: number) => {
    const word = queue[index];
    if (!word) return;
    try {
      await api.review(word.id, value, language);
      setGraded((count) => count + 1);
      setIndex((current) => current + 1);
      setRevealed(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const importLevel = async (levelId: string) => {
    setImporting(true);
    setNotice(null);
    try {
      const result = await api.importLevel(language, levelId);
      setNotice(
        result.added > 0
          ? `已把 ${result.added} 个新词加入${copy.name}词汇本${result.skipped > 0 ? `，${result.skipped} 个原本就在册中` : ''}${result.pending > 0 ? `；另有 ${result.pending} 个词释义待补，暂未加入` : ''}。`
          : result.pending > 0
            ? `这一级有 ${result.pending} 个词的释义待补，暂未加入词汇本。`
            : '这一级的词已经全部在词汇本里了。',
      );
      const refreshed = await api.lexicon(language, lexLevel ?? levelId, lexQuery || undefined);
      setLex(refreshed);
      setStats(refreshed.stats);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const current = queue[index];
  const finished = queue.length > 0 && index >= queue.length;
  const activeLevel = useMemo(
    () => lex?.levels.find((item) => item.id === lexLevel) ?? null,
    [lex, lexLevel],
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {copy.eyebrow} · {copy.name}独立册
          </div>
          <h1>{copy.heading}</h1>
          <div className="page-sub">
            共 {stats.total} 词 · 今日到期 {stats.due} 个 · 已进入长期记忆 {stats.mastered} 个
            <span className="hint">　（只统计{copy.name}册）</span>
          </div>
        </div>
        <div className="row">
          <button
            className={`btn btn-sm${mode === 'review' ? ' btn-selected' : ''}`}
            onClick={() => setMode('review')}
          >
            今日复习
          </button>
          <button className={`btn btn-sm${mode === 'all' ? ' btn-selected' : ''}`} onClick={() => setMode('all')}>
            我的词汇
          </button>
          <button
            className={`btn btn-sm${mode === 'library' ? ' btn-selected' : ''}`}
            onClick={() => setMode('library')}
          >
            分级词库
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      {notice ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="teal">{notice}</Banner>
        </div>
      ) : null}

      {mode === 'review' ? (
        <div className="grid split">
          <SectionCard
            title={queue.length === 0 ? '今日复习' : `进度 ${Math.min(index + 1, queue.length)} / ${queue.length}`}
            extra={<span className="hint">按「忘记 / 模糊 / 记得 / 熟练」自评</span>}
          >
            {loading ? <Loading text="正在取回今天的复习队列…" /> : null}

            {!loading && queue.length === 0 ? (
              <EmptyState
                title="今天没有到期词汇"
                hint={`完成「今日任务」里的精读后，新词会按记忆曲线排进${copy.name}册的复习队列。`}
              />
            ) : null}

            {!loading && finished ? (
              <div className="center" style={{ padding: '30px 0' }}>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 20 }}>今日复习完成</div>
                <div className="hint" style={{ marginTop: 6 }}>
                  共复习 {graded} 个词，明天的队列会在完成精读后自动更新。
                </div>
                <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={loadDue}>
                  再刷一轮
                </button>
              </div>
            ) : null}

            {!loading && current && !finished ? (
              <div className="vocab-stage">
                <div className="vocab-card">
                  <div className="vocab-term">{current.term}</div>
                  <div className="row voice-inline" style={{ justifyContent: 'center', gap: 8, marginTop: 6 }}>
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={!wordVoice.supported}
                      onClick={() => wordVoice.speak(current.term, `vocab-${current.id}`)}
                    >
                      ▶ 朗读单词
                    </button>
                    {current.example ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={!wordVoice.supported}
                        onClick={() => wordVoice.speak(current.example as string, `vocab-ex-${current.id}`)}
                      >
                        ▶ 朗读例句
                      </button>
                    ) : null}
                    <span className="hint">{wordVoice.currentVoice?.name ?? ''}</span>
                  </div>
                  {wordVoice.error ? <div className="hint voice-error">{wordVoice.error}</div> : null}
                  <div className="vocab-reading">
                    {revealed ? current.reading || ' ' : '先在心里读出声音，再翻开答案'}
                  </div>

                  {revealed ? (
                    <div className="vocab-answer">
                      <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
                        {current.level ? (
                          <span className="chip chip-accent">
                            {LEVEL_LABEL[current.level] ?? current.level}
                          </span>
                        ) : null}
                        {current.pos ? <span className="chip">{current.pos}</span> : null}
                        <span className="chip chip-teal">已复习 {current.reps} 次</span>
                        <span className="chip">间隔 {current.intervalDays} 天</span>
                      </div>
                      <div style={{ fontSize: 17, marginTop: 12 }}>{current.meaning || '释义待补'}</div>
                      {current.mnemonic ? (
                        <div className="mnemonic" style={{ marginTop: 10 }}>
                          <span className="mnemonic-label">记忆法</span>
                          {current.mnemonic}
                        </div>
                      ) : null}
                      {current.example ? (
                        <div className="example-box" style={{ marginTop: 10 }}>
                          <div>{current.example}</div>
                          {current.exampleCn ? <div className="hint">{current.exampleCn}</div> : null}
                        </div>
                      ) : null}
                      <div className="grade-row">
                        {GRADES.map((item) => (
                          <button
                            key={item.grade}
                            className={`grade-btn grade-${item.grade}`}
                            onClick={() => grade(item.grade)}
                          >
                            {item.label}
                            <span>{item.hint}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <button className="btn btn-primary" style={{ marginTop: 22 }} onClick={() => setRevealed(true)}>
                      显示释义
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </SectionCard>

          <div className="stack">
            <SectionCard title="记忆曲线怎么算">
              <div className="stack" style={{ gap: 10 }}>
                <p className="small muted">
                  每个词有独立的「熟练度」与「复习间隔」。答「记得」时，间隔按熟练度倍数拉长；答「忘记」则重置为 1
                  天并降低熟练度。
                </p>
                <p className="small muted">
                  这样，真正难的词会反复出现，简单词几周才见一次——比每天从头背一遍效率高得多。
                </p>
                <hr className="divider" />
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">今日到期</span>
                  <span>{stats.due} 个</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">长期记忆（间隔 ≥ 21 天）</span>
                  <span>{stats.mastered} 个</span>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="复习建议">
              <p className="small muted">
                复习时先「看词想义」，能 3 秒内想出中文才算「记得」。想不起来但答案眼熟，选「模糊」——它不会让间隔暴涨，也不会像「忘记」那样重置。
              </p>
              <p className="small muted" style={{ marginTop: 8 }}>
                {copy.reviewTip}
              </p>
            </SectionCard>
          </div>
        </div>
      ) : null}

      {mode === 'all' ? (
        <SectionCard
          title={`我的词汇（${words.length}）`}
          extra={
            <Field
              style={{ maxWidth: 220 }}
              placeholder={copy.searchAll}
              value={query}
              onChange={setQuery}
              leading="⌕"
              aria-label={copy.searchAll}
            />
          }
        >
          {loading ? <Loading /> : null}
          {!loading && words.length === 0 ? (
            <EmptyState
              title="这一册还没有词汇"
              hint={copy.emptyHint}
            />
          ) : null}
          {words.map((word) => (
            <div key={word.id} className="word-item">
              <div>
                <div className="word-term">
                  {word.term}
                  {word.reading ? (
                    <span className="hint" style={{ marginLeft: 8 }}>
                      {word.reading}
                    </span>
                  ) : null}
                  {word.level ? (
                    <span className="chip chip-accent" style={{ marginLeft: 8 }}>
                      {LEVEL_LABEL[word.level] ?? word.level}
                    </span>
                  ) : null}
                  {word.pos ? (
                    <span className="chip" style={{ marginLeft: 8 }}>
                      {word.pos}
                    </span>
                  ) : null}
                </div>
                <div className="small muted">{word.meaning}</div>
              </div>
              <div className="hint" style={{ textAlign: 'right', flex: 'none' }}>
                下次 {word.dueDate}
                <div>间隔 {word.intervalDays} 天</div>
              </div>
            </div>
          ))}
        </SectionCard>
      ) : null}

      {mode === 'library' ? (
        <div className="stack">
          <SectionCard
            title={copy.libTitle}
            extra={
              <Field
                style={{ maxWidth: 220 }}
                placeholder={copy.searchLib}
                value={lexQuery}
                onChange={setLexQuery}
                leading="⌕"
                aria-label={copy.searchLib}
              />
            }
          >
            <p className="small muted" style={{ marginBottom: 14 }}>
              {lex?.source ?? '正在读取词库…'}
            </p>

            <div className="vocab-levels">
              {(lex?.levels ?? []).map((level) => {
                const percent = level.total === 0 ? 0 : Math.round((level.inBook / level.total) * 100);
                return (
                  <button
                    key={level.id}
                    className={`level-card${lexLevel === level.id ? ' is-active' : ''}`}
                    onClick={() => {
                      setLexLevel(level.id);
                      setNotice(null);
                    }}
                  >
                    <div className="level-top">
                      <span className="level-badge">{level.short}</span>
                      {lex?.planLevelId === level.id ? <span className="chip chip-accent">当前计划</span> : null}
                      <span className="spacer" />
                      <span className="hint">{percent}%</span>
                    </div>
                    <div className="level-name">{level.name}</div>
                    <div className="level-desc">{level.description}</div>
                    <div className="level-bar">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <div className="level-meta">
                      <span>收录 {level.total}</span>
                      <span>已收 {level.inBook}</span>
                      <span>今日到期 {level.due}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {activeLevel ? (
              <div className="lib-head">
                <div>
                  <div className="lib-title">
                    {activeLevel.short} · {activeLevel.name}
                  </div>
                  <div className="hint">共 {activeLevel.total} 词，已进词汇本 {activeLevel.inBook} 个</div>
                </div>
                <div className="row">
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={importing}
                    onClick={() => importLevel(activeLevel.id)}
                  >
                    {importing ? '正在加入…' : `把 ${activeLevel.short} 整级加入词汇本`}
                  </button>
                </div>
              </div>
            ) : null}

            {loading ? <Loading text="正在取回分级词库…" /> : null}

            {!loading && lex && lex.words.length === 0 ? (
              <EmptyState title="没有匹配的词" hint="换个关键词，或清空搜索框。" />
            ) : null}

            {!loading
              ? lex?.words.map((word) => (
                  <div key={word.term} className="lib-word">
                    <div className="lib-word-main">
                      <div className="lib-word-term">
                        {word.term}
                        {word.reading ? <span className="lib-kana">{word.reading}</span> : null}
                        <span className="chip chip-accent">{LEVEL_LABEL[word.level] ?? word.level}</span>
                        <span className="chip">{word.pos}</span>
                        {word.band ? <span className="chip">{word.band}</span> : null}
                      </div>
                      {word.forms ? <div className="hint">变形：{word.forms}</div> : null}
                      <div className="lib-cn">{word.cn || '释义待补'}</div>
                      {word.relations ? <div className="hint">{word.relations}</div> : null}
                      {word.example ? (
                        <div className="lib-example">
                          {word.example}
                          {word.exampleCn ? <span>　{word.exampleCn}</span> : null}
                        </div>
                      ) : null}
                      {word.mnemonic ? <div className="lib-mnemonic">{word.mnemonic}</div> : null}
                    </div>
                    <div className="lib-word-side">
                      <span className="chip">{word.theme}</span>
                      {word.code ? <span className="hint">{word.code}</span> : null}
                      <span className={`chip ${word.inBook ? 'chip-ok' : ''}`}>
                        {word.inBook ? '已在册' : '未收录'}
                      </span>
                    </div>
                  </div>
                ))
              : null}
          </SectionCard>

          <Banner tone="teal">
            英语与日语是两本独立的册子：切到日语计划时，这里只出现 N3 / N2 / N1 的日语词，复习队列、级别进度、统计都不会和英语混在一起；数据库层面也按语种分区存放。
          </Banner>
        </div>
      ) : null}
    </div>
  );
}

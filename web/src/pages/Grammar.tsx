import { useCallback, useEffect, useMemo, useState } from 'react';
import { Field } from '@waiyubaodian/ui-kit';
import { api } from '../api';
import { Banner, EmptyState, Loading, SectionCard } from '../components/ui';
import { useApp } from '../store';
import type { GrammarLibraryResponse, GrammarPoint, GrammarRule } from '../types';
import { useVoicePlayer } from '../hooks/useVoicePlayer';

type View = 'points' | 'rules';

/** 语法库页的语种文案；标题、级别名、条目内容都直接用数据里的，不在这里重复一遍 */
const COPY = {
  en: { name: '英语', eyebrow: 'Grammar · 内置语法库' },
  ja: { name: '日语', eyebrow: '文法 · 内置语法库' },
  ko: { name: '韩语', eyebrow: '문법 · 内置语法库' },
} as const;

const SEARCH_PLACEHOLDER = {
  points: '查语法点、接续或例句',
  rules: '查规则名称、表现或编码',
} as const;

/**
 * 内置语法库：按级别浏览语法点（接续 / 释义 / 类义 / 例句 / 考点 / 易错规则），
 * 以及每条错因规则的触发 / 表现 / 判定。语法点与规则可以互相跳转。
 *
 * 一个语种最多两百多条，所以不带级别参数、整库一次取回，级别切换在本地筛 ——
 * 级别卡片上的收录量不会因为筛选而跳动。搜索走服务端，因为它同时筛语法点和规则。
 */
export default function GrammarPage() {
  const { plan, language } = useApp();
  const copy = COPY[language] ?? COPY.en;
  const [view, setView] = useState<View>('points');
  /** undefined = 还没定；null = 全部级别 */
  const [level, setLevel] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [data, setData] = useState<GrammarLibraryResponse | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 从规则视图点过来、要定位并展开的语法点 */
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const voice = useVoicePlayer('word');

  const load = useCallback(
    async (search: string) => {
      setLoading(true);
      try {
        const response = await api.grammar(language, search ? { q: search } : undefined);
        setData(response);
        // 默认落到计划所在的级别；计划级别不在任何一档里（比如英语目录的六级）就取第一档
        setLevel((current) => {
          if (current !== undefined) return current;
          const planLevel = response.levels.find((item) =>
            item.catalogLevels.some((catalog) => catalog.id === plan?.currentLevelId),
          );
          return planLevel?.id ?? response.levels[0]?.id ?? null;
        });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [language, plan?.currentLevelId],
  );

  useEffect(() => {
    load(query);
  }, [load, query]);

  // 数据到位后处理「定位到某个语法点」：切到它所在的级别、展开、滚到可见
  useEffect(() => {
    if (!data || !focusRef) return;
    const target = data.points.find((point) => point.ref === focusRef);
    if (!target) return;
    setLevel(target.level);
    setExpanded(target.ref);
    setFocusRef(null);
    document.getElementById(`grammar-${target.ref}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [data, focusRef]);

  // 切语种时整页由路由重挂载（App.tsx 的 <Routes key={planKey}>），这里不需要自己重置状态

  const points = useMemo(
    () => (data?.points ?? []).filter((point) => level === null || point.level === level),
    [data, level],
  );
  const rules = useMemo(() => data?.rules ?? [], [data]);
  const activeLevel = data?.levels.find((item) => item.id === level) ?? null;
  const searching = query.trim().length > 0;

  /** 语法点 → 规则：用规则编码当搜索词，规则视图里只剩这一条 */
  const openRule = (ref: string): void => {
    setQuery(ref);
    setView('rules');
  };

  /** 规则 → 语法点：清掉搜索（里面是规则编码，会把语法点列表筛空），回到语法点视图定位 */
  const openPoint = (ref: string): void => {
    setQuery('');
    setView('points');
    setFocusRef(ref);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {copy.eyebrow} · {copy.name}
          </div>
          <h1>语法库</h1>
          <div className="page-sub">
            共 {data?.stats.points ?? 0} 个语法点 · {data?.stats.rules ?? 0} 条错因规则
            {data?.examName ? (
              <span className="hint">　（面向 {data.examName}；来源：{data.source}）</span>
            ) : null}
          </div>
        </div>
        <div className="row">
          <button
            className={`btn btn-sm${view === 'points' ? ' btn-selected' : ''}`}
            onClick={() => {
              setView('points');
              setQuery('');
            }}
          >
            语法点
          </button>
          <button
            className={`btn btn-sm${view === 'rules' ? ' btn-selected' : ''}`}
            onClick={() => {
              setView('rules');
              setQuery('');
            }}
          >
            错因规则
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      <SectionCard
        title={
          view === 'rules'
            ? `错因规则（${rules.length}）`
            : activeLevel && !searching
              ? `${activeLevel.label} · ${points.length} 个语法点`
              : `${searching ? '搜索结果' : '全部级别'} · ${points.length} 个语法点`
        }
        extra={
          <Field
            style={{ maxWidth: 240 }}
            placeholder={SEARCH_PLACEHOLDER[view]}
            value={query}
            onChange={setQuery}
            leading="⌕"
            aria-label="搜索语法库"
          />
        }
      >
        {!loading && data && !data.stats.seeded ? (
          <EmptyState
            title="语法库还没有写入知识图谱"
            hint="语法点在服务启动时自动写入。如果重启后仍是空的，请看服务日志里的 knowledge base seed failed。"
          />
        ) : null}

        {view === 'points' && !searching && (data?.levels.length ?? 0) > 1 ? (
          <div className="vocab-levels">
            {(data?.levels ?? []).map((item) => {
              const planHere = item.catalogLevels.some((catalog) => catalog.id === plan?.currentLevelId);
              return (
                <button
                  key={item.id}
                  className={`level-card${level === item.id ? ' is-active' : ''}`}
                  aria-pressed={level === item.id}
                  onClick={() => {
                    // 再点一次已选中的级别 = 取消筛选，看全部
                    setLevel(level === item.id ? null : item.id);
                    setExpanded(null);
                  }}
                >
                  <div className="level-top">
                    <span className="level-badge">{item.short}</span>
                    {planHere ? <span className="chip chip-accent">当前计划</span> : null}
                    <span className="spacer" />
                    <span className="hint">收录 {item.total}</span>
                  </div>
                  <div className="level-name">{item.label}</div>
                  <div className="level-desc">
                    {item.catalogLevels.length > 0
                      ? item.catalogLevels.map((catalog) => catalog.name).join(' · ')
                      : '目录里暂无对应的学习级别'}
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}

        {loading ? <Loading text="正在取回语法库…" /> : null}

        {!loading && data?.stats.seeded && view === 'points' && points.length === 0 ? (
          <EmptyState title="没有匹配的语法点" hint="换个关键词，或点一下已选中的级别卡片取消筛选。" />
        ) : null}
        {!loading && data?.stats.seeded && view === 'rules' && rules.length === 0 ? (
          <EmptyState title="没有匹配的错因规则" hint="换个关键词，或清空搜索框。" />
        ) : null}

        {!loading && view === 'points'
          ? points.map((point) => {
              const open = expanded === point.ref;
              return (
                <div key={point.ref} id={`grammar-${point.ref}`} className="lib-word grammar-row">
                  <div className="lib-word-main">
                    <button
                      className="grammar-head"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : point.ref)}
                    >
                      <div className="lib-word-term">
                        {point.name}
                        <span className="chip">{point.ref}</span>
                        <span className="chip chip-accent">{point.levelLabel}</span>
                        <span className={`grammar-caret${open ? ' is-open' : ''}`} aria-hidden="true">
                          ▾
                        </span>
                      </div>
                      <div className="lib-cn">{point.meaning}</div>
                      <div className="lib-example">接续：{point.structure}</div>
                    </button>

                    {open ? (
                      <div className="grammar-detail">
                        <span className="grammar-k">类义</span>
                        <span>{point.synonym || '—'}</span>

                        <span className="grammar-k">例句</span>
                        <span className="grammar-example">
                          <span>
                            {point.example}
                            {point.translation ? <span className="hint">　{point.translation}</span> : null}
                          </span>
                          {voice.supported ? (
                            <button
                              className="btn btn-sm btn-ghost"
                              onClick={() => voice.speak(point.example, `grammar-${point.ref}`)}
                            >
                              ▶ 朗读
                            </button>
                          ) : null}
                        </span>

                        {point.note ? (
                          <>
                            <span className="grammar-k">考点</span>
                            <span>{point.note}</span>
                          </>
                        ) : null}

                        {point.errorRule ? (
                          <>
                            <span className="grammar-k">易错</span>
                            <span>
                              <button className="grammar-link" onClick={() => openRule(point.errorRule!.ref)}>
                                {point.errorRule.name}
                              </button>
                              <span className="hint">　{point.errorRule.ref} · 点开看触发与判定</span>
                            </span>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          : null}

        {!loading && view === 'rules'
          ? rules.map((rule) => <RuleRow key={rule.ref} rule={rule} onOpenPoint={openPoint} />)
          : null}
      </SectionCard>
    </div>
  );
}

function RuleRow({ rule, onOpenPoint }: { rule: GrammarRule; onOpenPoint: (ref: string) => void }) {
  return (
    <div className="lib-word grammar-row">
      <div className="lib-word-main">
        <div className="lib-word-term">
          {rule.name}
          <span className="chip">{rule.ref}</span>
          <span className={`chip${rule.pointCount > 0 ? 'chip-teal' : ''}`}>
            {rule.pointCount > 0 ? `覆盖 ${rule.pointCount} 个语法点` : '暂无语法点挂接'}
          </span>
        </div>
        <div className="grammar-line">
          <span className="grammar-k">触发</span>
          <span>{rule.trigger}</span>
        </div>
        <div className="grammar-line">
          <span className="grammar-k">表现</span>
          <span>{rule.symptom}</span>
        </div>
        <div className="grammar-line">
          <span className="grammar-k">判定</span>
          <span>{rule.judgement}</span>
        </div>
        {rule.pointCount > 0 ? (
          <div className="grammar-refs">
            <span className="grammar-k">语法点</span>
            <span className="grammar-ref-list">
              {rule.pointRefs.map((ref) => (
                <button key={ref} className="grammar-link" onClick={() => onOpenPoint(ref)}>
                  {ref}
                </button>
              ))}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

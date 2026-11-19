import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import LanguageSwitch from '../components/LanguageSwitch';
import { Banner, Ring } from '../components/ui';
import { useApp } from '../store';
import type { Language, LearningPath, PathStep } from '../types';

const STATUS_LABEL: Record<PathStep['status'], string> = {
  done: '已跨过',
  current: '当前阶段',
  next: '下一站',
  future: '之后',
};

const STATUS_CHIP: Record<PathStep['status'], string> = {
  done: 'chip-ok',
  current: 'chip-accent',
  next: 'chip-gold',
  future: '',
};

export default function PathPage() {
  const { language, plan } = useApp();
  const navigate = useNavigate();
  const [path, setPath] = useState<LearningPath | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.learningPath(language);
      setPath(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    void load();
  }, [load]);

  const goSetup = (step?: PathStep) => {
    navigate('/setup', {
      state: { language: path?.language ?? language, levelId: step?.levelId },
    });
  };

  if (loading && !path) {
    return <div className="loading">正在读取进阶路线…</div>;
  }

  if (error && !path) {
    return <Banner tone="danger">{error}</Banner>;
  }

  if (!path) return null;

  const title =
    path.language === 'ja'
      ? 'N3 → N2 → N1 进阶路线'
      : path.language === 'ko'
        ? 'TOPIK 3 → 4 → 6 级进阶路线'
        : '基础 → 托福 100 进阶路线';
  const nextStep = path.steps.find((step) => step.status === 'next') ?? path.steps[0];

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            Path · {path.nativeName} · {path.languageName}
          </div>
          <h1>{title}</h1>
          <div className="page-sub">{path.headline}</div>
        </div>
        <div className="head-side">
          <LanguageSwitch onSwitched={() => void load()} />
          <button className="btn btn-sm" onClick={() => goSetup(nextStep)}>
            以「{nextStep.levelName}」为起点定目标
          </button>
        </div>
      </div>

      <div className="grid split" style={{ alignItems: 'start' }}>
        <div className="path-list">
          {path.steps.map((step, index) => {
            const last = index === path.steps.length - 1;
            return (
              <div key={step.levelId} className={`path-step ${step.status}`}>
                <div className="path-rail">
                  <div className="path-node">{step.status === 'done' ? '✓' : step.index}</div>
                  {last ? null : <div className="path-line" />}
                </div>
                <div className="card path-card">
                  <div className="path-card-head">
                    <div>
                      <div className="path-level">{step.levelName}</div>
                      <div className="hint">
                        CEFR {step.cefr} · 目标：{step.targetLabel}
                      </div>
                    </div>
                    <span className={`chip ${STATUS_CHIP[step.status]}`}>{STATUS_LABEL[step.status]}</span>
                  </div>

                  <div className="path-motto">「{step.motto}」</div>

                  <div className="path-metrics">
                    <div>
                      <span className="path-metric-value">{step.hours}</span>
                      <span className="path-metric-label">累计投入小时</span>
                    </div>
                    <div>
                      <span className="path-metric-value">{step.weeks}</span>
                      <span className="path-metric-label">
                        周（每周 {path.weeklyHours}h）
                      </span>
                    </div>
                    <div>
                      <span className="path-metric-value">{step.vocab}</span>
                      <span className="path-metric-label">
                        目标词汇 · 本级 +{step.vocabGain}
                      </span>
                    </div>
                    <div>
                      <span className="path-metric-value">{step.weeklyVocab}</span>
                      <span className="path-metric-label">新词 / 周</span>
                    </div>
                  </div>

                  <div className="path-block">
                    <div className="path-exam">
                      <strong>卷面</strong> {step.examShape}
                      <div className="hint" style={{ marginTop: 4 }}>
                        合格线：{step.passLine}
                      </div>
                    </div>
                  </div>

                  <div className="path-cols">
                    <div>
                      <div className="hint-title">这一级要拿下什么</div>
                      <ul className="path-ul">
                        {step.focus.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="hint-title">具体怎么学</div>
                      <ul className="path-ul">
                        {step.method.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="path-pitfalls">
                    <div className="hint-title">这一级最容易踩的坑</div>
                    <ul className="path-ul">
                      {step.pitfalls.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="path-check">
                    <span className="path-check-label">升级自测</span>
                    {step.checkpoint}
                  </div>

                  <div className="row" style={{ marginTop: 14 }}>
                    <button className="btn btn-sm" onClick={() => goSetup(step)}>
                      以这一级为目标生成计划
                    </button>
                    {step.status === 'current' ? (
                      <Link className="btn btn-sm btn-ghost" to="/today">
                        去看今天的任务 →
                      </Link>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="stack">
          <div className="card card-pad">
            <div className="eyebrow">Current</div>
            <h2 style={{ fontSize: 17, marginBottom: 12 }}>你在这条路上的位置</h2>
            {path.plan ? (
              <>
                <div className="ring-wrap">
                  <Ring value={path.plan.completionRate} size={78} stroke={7} />
                  <div>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 16 }}>
                      {path.plan.currentLevelName} → {path.plan.targetLabel}
                    </div>
                    <div className="hint">
                      {path.plan.weeks} 周 · 每日 {path.plan.dailyMinutes} 分钟
                    </div>
                    <div className="hint">距离考试 {path.plan.daysLeft} 天</div>
                  </div>
                </div>
                <hr className="divider" />
                <div className="hint">
                  计划进度 {Math.round(path.plan.completionRate * 100)}%。
                  {path.plan.isActive
                    ? '该计划正在使用中，首页就是这个语种。'
                    : '该计划当前处于归档状态，在上方切到本语种即可启用。'}
                </div>
                {path.currentIndex === -1 ? (
                  <div className="hint" style={{ marginTop: 6 }}>
                    你当前在「{path.plan.currentLevelName}」，这条路线的第一站是「{nextStep.levelName}」。
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="hint">
                  你还没有{path.languageName}的备考计划。这条路从「{nextStep.levelName}」开始最省力。
                </div>
                <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} onClick={() => goSetup(nextStep)}>
                  生成{path.languageName}计划
                </button>
              </>
            )}
          </div>

          <div className="card card-pad">
            <div className="eyebrow">How to use</div>
            <h2 style={{ fontSize: 17, marginBottom: 10 }}>这条路怎么用</h2>
            <ul className="path-ul">
              <li>一次只盯一级：当前阶段的「升级自测」没达标，不要提前报下一级。</li>
              <li>周数是按每周 {path.weeklyHours} 小时估的；时间减半，周期大致翻倍。</li>
              <li>词汇量是累计值，数字差距比证书名更能说明工作量。</li>
              <li>每级都会落到每日任务：词汇、精读、朗读、听力、输出按阶段配比自动切分。</li>
            </ul>
            <hr className="divider" />
            <div className="hint">{path.note}</div>
          </div>

          {plan && plan.language !== path.language ? (
            <Banner tone="gold">
              当前首页计划是{plan.language === 'ja' ? '日语' : plan.language === 'ko' ? '韩语' : '英语'}。切到
              {path.languageName}后，这里的进度会跟着切换。
            </Banner>
          ) : null}
        </div>
      </div>
    </div>
  );
}

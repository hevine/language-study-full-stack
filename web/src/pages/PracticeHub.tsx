import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Banner, EmptyState, Loading, SectionCard, Stat } from '../components/ui';
import { formatCn, formatShort, useApp } from '../store';
import type { PracticeOverview } from '../types';

const LANG_CN: Record<string, string> = { en: '英语', ja: '日语', ko: '韩语' };

export default function PracticeHub() {
  const { plan } = useApp();
  const [data, setData] = useState<PracticeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    api
      .practiceOverview()
      .then((response) => !cancelled && setData(response))
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [plan?.id]);

  if (!plan) return null;
  if (loading) return <Loading text="正在读取批改记录…" />;
  if (error && !data) return <Banner tone="danger">{error}</Banner>;
  if (!data) return null;

  const { tasks, attempts, summary } = data;
  const writeTasks = tasks.filter((task) => task.kind === 'write');
  const speakTasks = tasks.filter((task) => task.kind === 'speak');

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">{formatCn(data.date)} · 输出能力</div>
          <h1>写作 · 口语批改</h1>
          <div className="page-sub">
            {plan.examName} · {plan.targetLabel} · 每篇按官方评分维度逐条批改，给出改后句与下一步训练
          </div>
        </div>
        <Link className="btn btn-sm" to="/today">
          今日任务
        </Link>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="累计批改" value={summary.attempts} unit="次" hint={`最近 ${summary.lastOverall ?? '—'} 分`} />
        <Stat label="写作均分" value={summary.write.avg ?? '—'} unit={summary.write.avg ? "分" : ""} hint={`${summary.write.attempts} 次批改`} />
        <Stat label="口语均分" value={summary.speak.avg ?? '—'} unit={summary.speak.avg ? "分" : ""} hint={`${summary.speak.attempts} 次批改`} />
        <Stat label="待完成" value={data.pending} unit="项" hint={data.hasDay ? '今日写作/口语任务' : '今日不在计划范围内'} />
      </div>

      <div className="grid practice-layout">
        <div className="stack">
          <SectionCard title="今日待练" extra={<span className="hint">写完/说完直接提交，系统自动评分</span>}>
            {tasks.length === 0 ? (
              <EmptyState
                title="今天没有写作或口语任务"
                hint={data.hasDay ? '这一天的任务以输入为主，明天或后天会安排输出训练。' : '今日不在计划日期范围内，可在「学习计划」里查看排期。'}
              />
            ) : (
              <div className="practice-tasks">
                {[...writeTasks, ...speakTasks].map((task) => (
                  <div key={task.taskId} className="practice-task">
                    <div className="practice-task-main">
                      <div className="row" style={{ gap: 8 }}>
                        <span className={`chip ${task.kind === 'write' ? 'chip-accent' : 'chip-teal'}`}>
                          {task.kind === 'write' ? '写作' : '口语'}
                        </span>
                        <strong>{task.title}</strong>
                        <span className="hint">{task.minutes} 分钟</span>
                      </div>
                      <div className="hint" style={{ marginTop: 4 }}>
                        {task.attemptCount > 0
                          ? `已批改 ${task.attemptCount} 次 · 最高 ${task.best ?? '—'} 分${
                              task.last ? ` · 最近 ${task.last.overall} 分（${task.last.bandLabel}）` : ''
                            }`
                          : '还没有批改记录'}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      {task.done ? <span className="chip chip-ok">已完成{task.score ? ` · ${Math.round(task.score)} 分` : ''}</span> : null}
                      <Link
                        className="btn btn-sm btn-primary"
                        to={`/practice/${data.date}/${task.taskId}`}
                        state={{ kind: task.kind }}
                      >
                        {task.attemptCount > 0 ? '再练一次' : '开始练习'}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="批改记录"
            extra={<span className="hint">最近 24 次 · 含历史计划与其他语种</span>}
          >
            {attempts.length === 0 ? (
              <EmptyState title="还没有批改记录" hint="完成一次写作或口语提交后，这里会出现分数、档位与逐条修改建议。" />
            ) : (
              <div className="timeline-list">
                {attempts.map((attempt) => (
                  <Link
                    key={attempt.id}
                    className="attempt-row"
                    to={`/practice/${attempt.date}/${attempt.taskId}`}
                    state={{ kind: attempt.kind }}
                  >
                    <span className={`attempt-kind ${attempt.kind}`}>{attempt.kind === 'write' ? '写' : '说'}</span>
                    <span className="attempt-main">
                      <span className="attempt-title">{attempt.promptTitle}</span>
                      <span className="hint">
                        {formatShort(attempt.date)} · {attempt.bandLabel} ·{' '}
                        {attempt.source === 'llm' ? '大模型' : '启发式'}
                        {attempt.language && attempt.language !== plan.language
                          ? ` · ${LANG_CN[attempt.language] ?? attempt.language}`
                          : ''}
                      </span>
                    </span>
                    <span className="attempt-score">{Math.round(attempt.overall)}</span>
                  </Link>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="stack">
          <SectionCard title="分数走势" extra={<span className="hint">近 12 次</span>}>
            {summary.trend.length === 0 ? (
              <div className="hint">提交 2 次以上就能看到走势。</div>
            ) : (
              <>
                <div className="spark">
                  {summary.trend.map((point, index) => (
                    <div key={`${point.date}-${index}`} className="spark-col">
                      <div
                        className={`spark-bar ${point.kind}`}
                        style={{ height: `${Math.max(6, point.overall)}%` }}
                        title={`${point.date} · ${point.overall} 分 · ${point.title}`}
                      />
                      <span className="spark-value">{point.overall}</span>
                    </div>
                  ))}
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  红＝写作，青＝口语。柱高为综合分（0–100），不是考试原始分。
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard title="评分怎么来的">
            <ul className="tight-list">
              <li>按目标考试的官方维度加权：内容、结构、语言、词汇（口语另含流利度与语音）。</li>
              <li>综合分 0–100，同时换算成考试分制（如托福 0–5、雅思 Band、六级 15 分）。</li>
              <li>已配置大模型时逐句批改；未配置时用可量化的启发式规则（篇幅、衔接、错误检测、重复率）。</li>
              <li>口语的「语音」维度只能估算，务必回听录音自行核对。</li>
            </ul>
            <hr className="divider" />
            <div className="hint">评分标准写在每一题的右侧栏，提交前可以先对照自检。</div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

import { formatCn, todayISO } from '../store';
import type { ExamCalendar } from '../types';

const TAG_COLOR: Record<string, string> = {
  报名: 'chip-accent',
  考场: 'chip-gold',
  证件: 'chip-teal',
  考试: 'chip-accent',
  出分: 'chip-ok',
};

function diffLabel(offsetDays: number): string {
  if (offsetDays === 0) return '考试当天';
  if (offsetDays > 0) return `考后 ${offsetDays} 天`;
  const days = -offsetDays;
  if (days >= 30) return `考前 ${Math.round(days / 30)} 个月`;
  return `考前 ${days} 天`;
}

/**
 * 报考日历卡片：关键节点时间线 + 报名指引链接 + 费用说明。
 * highlightEventId 用于任务完成页：把当前要办的节点高亮并展开指引。
 */
export default function ExamCalendarCard({
  calendar,
  highlightEventId,
  compact,
}: {
  calendar: ExamCalendar;
  highlightEventId?: string;
  compact?: boolean;
}) {
  const today = todayISO();

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="hint">{calendar.scheduleNote}</div>

      <div className="cal-timeline">
        {calendar.events.map((event) => {
          const isHighlight = event.id === highlightEventId;
          const past = event.date < today;
          return (
            <div key={event.id} className={`cal-event${isHighlight ? ' is-now' : ''}${past ? ' is-past' : ''}`}>
              <div className="cal-rail">
                <span className="cal-dot" />
                {event.id !== calendar.events[calendar.events.length - 1].id ? (
                  <span className="cal-line" />
                ) : null}
              </div>
              <div className="cal-body">
                <div className="row" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>{event.title}</strong>
                  <span className={`chip ${TAG_COLOR[event.tag] ?? ''}`}>{event.tag}</span>
                  <span className="hint">
                    {diffLabel(event.offsetDays)} · {formatCn(event.date)}
                  </span>
                  {event.isTask && !compact ? <span className="chip">会排进当日任务</span> : null}
                </div>
                <div className="small" style={{ marginTop: 4, lineHeight: 1.7 }}>
                  {event.what}
                </div>
                {isHighlight || (!compact && (event.id === 'reserve' || event.id === 'register-info')) ? (
                  <ul className="tight-list" style={{ marginTop: 6, marginBottom: 0 }}>
                    {event.tips.map((tip) => (
                      <li key={tip} style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 3 }}>
                        {tip}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {event.url && !compact ? (
                  <div style={{ marginTop: 6 }}>
                    <a className="cal-link" href={event.url} target="_blank" rel="noreferrer">
                      {event.url.replace('https://', '')} ↗
                    </a>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="lib-title" style={{ marginBottom: 8 }}>费用说明</div>
        <div className="fee-table">
          {calendar.fees.map((fee) => (
            <div key={fee.item} className="fee-row">
              <div className="fee-item">{fee.item}</div>
              <div className="fee-amount">{fee.amount}</div>
              <div className="fee-note">{fee.note}</div>
            </div>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>{calendar.feesNote}</div>
      </div>

      {!compact ? (
        <div>
          <div className="lib-title" style={{ marginBottom: 8 }}>官方入口与指引</div>
          <div className="stack" style={{ gap: 8 }}>
            {calendar.links.map((link) => (
              <div key={link.url} className="cal-link-card">
                <a href={link.url} target="_blank" rel="noreferrer" className="cal-link">
                  {link.label}（{link.url.replace('https://', '')}）↗
                </a>
                <div className="hint" style={{ marginTop: 2 }}>{link.note}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

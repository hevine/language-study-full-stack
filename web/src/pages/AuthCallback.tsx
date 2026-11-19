/** 扫码回调落地页：URL 上只有 ticketId，真正的兑换密钥留在 sessionStorage */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthProvider';

const TICKET_KEY = 'wb_login_ticket';
const errText = (err: unknown) => (err instanceof Error ? err.message : '登录失败，请重新扫码');

export default function AuthCallback() {
  const location = useLocation();
  const navigate = useNavigate();
  const { loginWithTicket } = useAuth();
  const [phase, setPhase] = useState<'working' | 'error'>('working');
  const [message, setMessage] = useState('正在确认扫码结果…');

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(location.search);
    const ticketId = params.get('ticket');
    const status = params.get('status');

    if (!ticketId || status === 'failed') {
      setPhase('error');
      setMessage(params.get('message') || '授权未完成，请返回登录页重新扫码');
      sessionStorage.removeItem(TICKET_KEY);
      return;
    }

    let ticket: { ticketId: string; ticketSecret: string } | null = null;
    try {
      ticket = JSON.parse(sessionStorage.getItem(TICKET_KEY) ?? 'null');
    } catch {
      ticket = null;
    }
    if (!ticket || ticket.ticketId !== ticketId) {
      setPhase('error');
      setMessage('登录票据与当前浏览器不匹配。请在发起扫码的同一窗口完成登录，或返回重新扫码。');
      return;
    }

    void (async () => {
      try {
        const state = await api.authQrPoll(ticketId, ticket!.ticketSecret).catch(() => null);
        if (state && (state.status === 'failed' || state.status === 'expired')) {
          throw new Error(state.message ?? '二维码已失效，请重新扫码');
        }
        await loginWithTicket(ticketId, ticket!.ticketSecret);
        if (cancelled) return;
        setMessage('登录成功，正在进入…');
        window.setTimeout(() => navigate('/', { replace: true }), 400);
      } catch (err) {
        if (cancelled) return;
        const consumedElsewhere = err instanceof ApiError && err.code === 'TICKET_CONSUMED';
        setMessage(consumedElsewhere ? '这次登录已在另一个窗口完成，返回即可继续。' : errText(err));
        setPhase('error');
        sessionStorage.removeItem(TICKET_KEY);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [location.search, loginWithTicket, navigate]);

  return (
    <div className="center-page">
      <div className="card card-pad auth-callback">
        <h2 style={{ fontSize: 18, marginBottom: 10 }}>
          {phase === 'working' ? '正在完成登录' : '登录未完成'}
        </h2>
        {phase === 'working' ? <div className="auth-pending-dot" /> : null}
        <p className="small muted" style={{ marginTop: 12 }}>{message}</p>
        <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} onClick={() => navigate('/login', { replace: true })}>
          返回登录页
        </button>
        {phase === 'error' ? (
          <button className="auth-link auth-guest" onClick={() => navigate('/', { replace: true })}>
            回到首页
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 登录 / 账号中心。
 * 未登录：微信、钉钉扫码 + 账号密码兜底；已登录：资料、渠道绑定、会话与管理端用户表。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthProvider';
import type { AuthProviderId, AuthSession, AuthUser } from '../types';

interface StoredTicket {
  ticketId: string;
  ticketSecret: string;
  provider: AuthProviderId;
  expiresAt: string;
}

const TICKET_KEY = 'wb_login_ticket';
const PROVIDER_COLOR: Record<AuthProviderId, string> = {
  wechat: '#07c160',
  dingtalk: '#1677ff',
};
const PROVIDER_MARK: Record<AuthProviderId, string> = { wechat: '微', dingtalk: '钉' };

const errText = (err: unknown) => (err instanceof Error ? err.message : '操作失败，请稍后再试');

export default function Login() {
  const { config, user, ready, loginWithPassword, loginWithTicket, logout } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<StoredTicket | null>(null);
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [adminUsers, setAdminUsers] = useState<Array<AuthUser & { sessionCount: number }>>([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', displayName: '' });

  const isAdmin = user?.role === 'admin';

  const loadAccount = useCallback(async () => {
    if (!user) return;
    try {
      const [sessionRes, userRes] = await Promise.all([
        api.authSessions(),
        isAdmin ? api.authAdminUsers() : Promise.resolve(null),
      ]);
      setSessions(sessionRes.sessions);
      if (userRes) setAdminUsers(userRes.users);
    } catch (err) {
      setNotice(errText(err));
    }
  }, [user, isAdmin]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  /** 授权页按返回键回来（或弹窗扫码）时，用 sessionStorage 里的票据继续轮询 */
  useEffect(() => {
    if (user) return;
    const raw = sessionStorage.getItem(TICKET_KEY);
    if (!raw) return;
    let ticket: StoredTicket;
    try {
      ticket = JSON.parse(raw) as StoredTicket;
    } catch {
      sessionStorage.removeItem(TICKET_KEY);
      return;
    }
    if (new Date(ticket.expiresAt).getTime() < Date.now()) {
      sessionStorage.removeItem(TICKET_KEY);
      return;
    }
    setPending(ticket);
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      if (stopped) return;
      try {
        const state = await api.authQrPoll(ticket.ticketId, ticket.ticketSecret);
        if (state.status === 'confirmed') {
          await loginWithTicket(ticket.ticketId, ticket.ticketSecret);
          navigate('/', { replace: true });
          return;
        }
        if (state.status !== 'pending') {
          setNotice(state.message ?? '二维码已失效，请重新发起扫码');
          sessionStorage.removeItem(TICKET_KEY);
          setPending(null);
          return;
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'TICKET_CONSUMED') {
          setPending(null);
          return;
        }
        setNotice(errText(err));
        setPending(null);
        return;
      }
      timer = window.setTimeout(() => void poll(), 1600);
    };
    timer = window.setTimeout(() => void poll(), 900);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [user, loginWithTicket, navigate]);

  const startQr = async (provider: AuthProviderId, bind = false) => {
    setBusy(true);
    setNotice(null);
    try {
      const data = await api.authQrStart(provider, bind);
      const ticket: StoredTicket = {
        ticketId: data.ticketId,
        ticketSecret: data.ticketSecret,
        provider: data.provider,
        expiresAt: data.expiresAt,
      };
      // 票据密钥只在本标签页会话里；回调 URL 上不带任何凭证
      sessionStorage.setItem(TICKET_KEY, JSON.stringify(ticket));
      setPending(ticket);
      window.location.assign(data.authorizeUrl);
    } catch (err) {
      setNotice(errText(err));
      setBusy(false);
    }
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await loginWithPassword(username.trim(), password);
      setPassword('');
      navigate('/', { replace: true });
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async () => {
    setBusy(true);
    await logout();
    setSessions([]);
    setAdminUsers([]);
    setBusy(false);
    setNotice(null);
  };

  const reviewUser = async (id: string, status: 'active' | 'disabled') => {
    try {
      await api.authAdminPatchUser(id, { status });
      await loadAccount();
    } catch (err) {
      setNotice(errText(err));
    }
  };

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.authAdminCreateUser({
        username: newUser.username.trim(),
        password: newUser.password,
        ...(newUser.displayName.trim() ? { displayName: newUser.displayName.trim() } : {}),
      });
      setNewUser({ username: '', password: '', displayName: '' });
      await loadAccount();
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <div className="center-page">
        <div className="center hint">正在准备登录…</div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card card card-pad">
        <div className="auth-brand">
          <div className="brand-mark">典</div>
          <div>
            <div className="auth-title">外语考证宝典</div>
            <div className="auth-sub">登录后可同步属于你的备考空间</div>
          </div>
        </div>

        {notice ? <div className="auth-notice">{notice}</div> : null}

        {!user ? (
          <>
            {config?.required ? (
              <div className="auth-tip">本站已开启强制登录，请选择一种方式继续。</div>
            ) : (
              <div className="auth-tip">
                当前为游客模式，数据保存在本机。登录后会切换到属于你的独立空间。
              </div>
            )}

            <div className="auth-section-title">扫码登录</div>
            <div className="auth-providers">
              {(config?.providers ?? []).map((provider) => (
                <button
                  key={provider.id}
                  className="auth-provider"
                  disabled={!provider.enabled || busy}
                  onClick={() => void startQr(provider.id)}
                  title={provider.enabled ? `跳转到${provider.label}官方扫码页` : provider.hint}
                >
                  <span className="auth-provider-mark" style={{ background: PROVIDER_COLOR[provider.id] }}>
                    {PROVIDER_MARK[provider.id]}
                  </span>
                  <span className="auth-provider-text">
                    <strong>{provider.label}扫码登录</strong>
                    <small>{provider.enabled ? '打开官方授权页，手机扫码确认' : provider.hint}</small>
                  </span>
                </button>
              ))}
              {!config?.providers.some((item) => item.enabled) ? (
                <p className="hint small auth-hint">
                  两个渠道都未配置凭证。在 <code>.env</code> 填入 AppID / AppSecret 并重启服务后即可使用；
                  也可以先用下面的账号密码登录。
                </p>
              ) : null}
            </div>

            {pending ? (
              <div className="auth-pending" role="status">
                <span className="auth-pending-dot" />
                正在等待{PROVIDER_MARK[pending.provider] === '微' ? '微信' : '钉钉'}扫码确认…
                <button className="auth-link" onClick={() => { sessionStorage.removeItem(TICKET_KEY); setPending(null); }}>
                  取消
                </button>
              </div>
            ) : null}

            <div className="auth-divider"><span>或使用账号密码</span></div>

            <form className="auth-form" onSubmit={(event) => void submitPassword(event)}>
              <label className="auth-field">
                <span>账号</span>
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  placeholder="admin"
                />
              </label>
              <label className="auth-field">
                <span>密码</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                />
              </label>
              <button className="btn btn-primary btn-block" disabled={busy} type="submit">
                {busy ? '登录中…' : '登录'}
              </button>
            </form>

            {!config?.passwordEnabled ? (
              <p className="hint small auth-hint">
                还没有设置管理员密码。执行 <code>NEW_ADMIN_PASSWORD='至少8位' npm run admin:passwd</code> 即可启用。
              </p>
            ) : null}

            {config?.guestAllowed ? (
              <button className="auth-link auth-guest" onClick={() => navigate('/', { replace: true })}>
                以游客身份继续使用 →
              </button>
            ) : null}
          </>
        ) : (
          <>
            <div className="auth-user">
              <div className="auth-avatar" style={{ background: user.avatarUrl ? undefined : 'var(--accent)' }}>
                {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.displayName.slice(0, 1)}
              </div>
              <div className="auth-user-meta">
                <strong>{user.displayName}</strong>
                <span className="small muted">
                  {user.role === 'admin' ? '管理员' : '学员'} · 用户 ID {user.id}
                </span>
              </div>
            </div>

            <div className="auth-section-title">已绑定的登录渠道</div>
            <div className="auth-chips">
              {(config?.providers ?? []).map((provider) => {
                const bound = user.identities.some((item) => item.provider === provider.id);
                return (
                  <div className="auth-chip" key={provider.id}>
                    <span className="auth-chip-mark" style={{ background: PROVIDER_COLOR[provider.id] }}>
                      {PROVIDER_MARK[provider.id]}
                    </span>
                    <span>{provider.label}</span>
                    <span className="auth-chip-state">{bound ? '已绑定' : '未绑定'}</span>
                    {!bound && provider.enabled ? (
                      <button className="auth-link" disabled={busy} onClick={() => void startQr(provider.id, true)}>
                        绑定
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="auth-section-title">登录设备（{sessions.filter((item) => !item.revokedAt).length}）</div>
            <div className="auth-sessions">
              {sessions.length === 0 ? <p className="hint small">暂无记录</p> : null}
              {sessions.slice(0, 5).map((session) => (
                <div className="auth-session" key={session.id}>
                  <span>
                    {new Date(session.createdAt).toLocaleString('zh-CN')} · {session.ip ?? '本机'}
                    {session.revokedAt ? ' · 已撤销' : ''}
                  </span>
                  {!session.revokedAt ? (
                    <button
                      className="auth-link"
                      onClick={async () => {
                        try {
                          await api.authRevokeSession(session.id);
                          await loadAccount();
                        } catch (err) {
                          setNotice(errText(err));
                        }
                      }}
                    >
                      下线
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            {isAdmin ? (
              <>
                <div className="auth-section-title">用户主表（{adminUsers.length}）</div>
                <div className="auth-table-wrap">
                  <table className="auth-table">
                    <thead>
                      <tr><th>用户</th><th>角色</th><th>状态</th><th>渠道</th><th>会话</th><th /></tr>
                    </thead>
                    <tbody>
                      {adminUsers.map((item) => (
                        <tr key={item.id}>
                          <td>{item.displayName}</td>
                          <td>{item.role === 'admin' ? '管理员' : '学员'}</td>
                          <td>
                            <span className={`auth-status status-${item.status}`}>
                              {item.status === 'active' ? '正常' : item.status === 'pending' ? '待审核' : '已停用'}
                            </span>
                          </td>
                          <td>{item.identities.length ? item.identities.map((identity) => (identity.provider === 'wechat' ? '微信' : '钉钉')).join(' / ') : '—'}</td>
                          <td>{item.sessionCount}</td>
                          <td>
                            {item.id !== user.id && item.status !== 'active' ? (
                              <button className="auth-link" onClick={() => void reviewUser(item.id, 'active')}>启用</button>
                            ) : null}
                            {item.id !== user.id && item.status === 'active' ? (
                              <button className="auth-link" onClick={() => void reviewUser(item.id, 'disabled')}>停用</button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="auth-section-title">新建本地账号</div>
                <form className="auth-inline-form" onSubmit={(event) => void createUser(event)}>
                  <input
                    placeholder="用户名"
                    value={newUser.username}
                    onChange={(event) => setNewUser({ ...newUser, username: event.target.value })}
                  />
                  <input
                    placeholder="昵称（可选）"
                    value={newUser.displayName}
                    onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })}
                  />
                  <input
                    type="password"
                    placeholder="密码（至少 8 位）"
                    value={newUser.password}
                    onChange={(event) => setNewUser({ ...newUser, password: event.target.value })}
                  />
                  <button className="btn btn-primary" type="submit" disabled={busy}>创建</button>
                </form>
                <p className="hint small auth-hint">
                  本地账号可立即用账号密码登录，拥有独立的备考空间；也可以在登录后到「已绑定的登录渠道」绑定微信或钉钉。
                </p>
              </>
            ) : null}

            <div className="auth-actions">
              <button className="btn btn-block" onClick={() => navigate('/', { replace: true })}>
                返回备考空间
              </button>
              <button className="btn btn-block auth-logout" disabled={busy} onClick={() => void doLogout()}>
                退出登录
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

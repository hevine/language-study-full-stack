/**
 * 登录 / 注册 / 账号中心。
 * 未登录：登录、注册两个 tab（含扫码 + 账号密码）；
 * 已登录：资料维护、渠道绑定、会话管理、游客数据认领与管理端用户表。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { Field, Select, type SelectOption } from '@waiyubaodian/ui-kit';
import type {
  AuthProviderId,
  AuthRole,
  AuthSession,
  AuthUser,
  ClaimTableCount,
  JlptLevel,
  PublicRegisterRole,
} from '../types';

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

const ROLE_LABEL: Record<AuthRole, string> = {
  admin: '管理员',
  teacher: '教师',
  student: '学生',
  user: '学员',
};
const JLPT_LEVELS: JlptLevel[] = ['N1', 'N2', 'N3', 'N4', 'N5'];

/** 与后端 assertPassword 一致：8–72 位、含字母与数字 */
const passwordStrength = (value: string): { ok: boolean; text: string } => {
  if (value.length === 0) return { ok: false, text: '至少 8 位' };
  if (value.length < 8) return { ok: false, text: '至少 8 位' };
  if (value.length > 72) return { ok: false, text: '最多 72 位' };
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return { ok: false, text: '需同时含字母和数字' };
  return { ok: true, text: '强度合格' };
};

export default function Login() {
  const { config, user, ready, loginWithPassword, register, loginWithTicket, logout } = useAuth();
  const navigate = useNavigate();

  const [tab, setTab] = useState<'login' | 'register'>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'register' ? 'register' : 'login',
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<StoredTicket | null>(null);
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [adminUsers, setAdminUsers] = useState<Array<AuthUser & { sessionCount: number }>>([]);
  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    confirm: '',
    displayName: '',
    role: 'student' as PublicRegisterRole,
    jlptLevel: 'N3' as JlptLevel,
  });
  const [profileName, setProfileName] = useState('');
  const [pwdChange, setPwdChange] = useState({ current: '', next: '', confirm: '' });
  const [claimPreview, setClaimPreview] = useState<ClaimTableCount[] | null>(null);
  const [resetFor, setResetFor] = useState<{ id: string; name: string } | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const isAdmin = user?.role === 'admin';

  const loadAccount = useCallback(async () => {
    if (!user) return;
    setProfileName(user.displayName);
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

  const submitRegister = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    const strength = passwordStrength(newUser.password);
    if (!strength.ok) {
      setNotice(`密码不合规：${strength.text}`);
      return;
    }
    if (newUser.password !== newUser.confirm) {
      setNotice('两次输入的密码不一致');
      return;
    }
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(newUser.username.trim())) {
      setNotice('用户名需为 3–40 位字母、数字或 . _ -');
      return;
    }
    setBusy(true);
    try {
      const loggedIn = await register({
        username: newUser.username.trim(),
        password: newUser.password,
        ...(newUser.displayName.trim() ? { displayName: newUser.displayName.trim() } : {}),
        role: newUser.role,
        ...(newUser.role === 'teacher' ? { jlptLevel: newUser.jlptLevel } : {}),
      });
      if (loggedIn) {
        setNotice(null);
        navigate('/', { replace: true });
      } else {
        setNotice('注册成功，账号待管理员审核通过后方可登录。');
        setTab('login');
      }
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.authUpdateMe({ displayName: profileName.trim() });
      await loadAccount();
      setNotice('资料已保存');
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const submitPasswordChange = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    const strength = passwordStrength(pwdChange.next);
    if (!strength.ok) {
      setNotice(`新密码不合规：${strength.text}`);
      return;
    }
    if (pwdChange.next !== pwdChange.confirm) {
      setNotice('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await api.authChangePassword(pwdChange.current, pwdChange.next);
      setPwdChange({ current: '', next: '', confirm: '' });
      setNotice('密码已修改，其它设备已下线');
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const loadClaimPreview = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const data = await api.authGuestData();
      setClaimPreview(data.tables);
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmClaim = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const data = await api.authClaimGuest();
      setClaimPreview(null);
      setNotice(`已认领 ${data.total} 条本机数据到当前账号`);
      // 数据归属变了，整页重拉，避免显示上一个账号的内容
      navigate('/', { replace: true });
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetFor) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.authAdminResetPassword(resetFor.id, resetPassword);
      setResetFor(null);
      setResetPassword('');
      setNotice(`已重置 ${resetFor.name} 的密码，该用户所有设备已下线`);
      await loadAccount();
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
      setNewUser({ username: '', password: '', confirm: '', displayName: '', role: 'student', jlptLevel: 'N3' });
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
            <div className="auth-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'login'}
                className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
                onClick={() => { setTab('login'); setNotice(null); }}
              >
                登录
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'register'}
                className={`auth-tab ${tab === 'register' ? 'active' : ''}`}
                onClick={() => { setTab('register'); setNotice(null); }}
                disabled={config?.allowRegister === false}
                title={config?.allowRegister === false ? '本站暂未开放注册' : '创建新账号'}
              >
                注册
              </button>
            </div>

            {config?.allowRegister === false ? (
              <div className="auth-tip">本站暂未开放自助注册，请联系管理员创建账号。</div>
            ) : null}

            {tab === 'login' ? (
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
              <Field
                label="账号"
                value={username}
                onChange={setUsername}
                autoComplete="username"
                placeholder="admin"
                block
              />
              <Field
                label="密码"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                placeholder="请输入密码"
                block
              />
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
                <div className="auth-tip">
                  注册后拥有独立的备考空间，与其它账号数据完全隔离；游客数据可在账号中心手动认领。
                </div>
                <form className="auth-form" onSubmit={(event) => void submitRegister(event)}>
                  <Field
                    label="账号（3–40 位字母、数字或 . _ -）"
                    value={newUser.username}
                    onChange={(value) => setNewUser({ ...newUser, username: value })}
                    autoComplete="username"
                    placeholder="例如 student_01"
                    block
                  />
                  <Field
                    label="昵称（可选）"
                    value={newUser.displayName}
                    onChange={(value) => setNewUser({ ...newUser, displayName: value })}
                    placeholder="留空则用账号名"
                    block
                  />
                  <div className="auth-field">
                    <span>注册身份</span>
                    <div className="auth-role-pick">
                      <button
                        type="button"
                        className={`auth-role-btn ${newUser.role === 'student' ? 'active' : ''}`}
                        onClick={() => setNewUser({ ...newUser, role: 'student' })}
                      >
                        学生
                      </button>
                      <button
                        type="button"
                        className={`auth-role-btn ${newUser.role === 'teacher' ? 'active' : ''}`}
                        onClick={() => setNewUser({ ...newUser, role: 'teacher' })}
                      >
                        教师
                      </button>
                    </div>
                  </div>
                  {newUser.role === 'teacher' ? (
                    <Select<JlptLevel>
                      label="能力等级（预留，供后续教学能力判定）"
                      value={newUser.jlptLevel}
                      onChange={(value) => setNewUser({ ...newUser, jlptLevel: value })}
                      options={JLPT_LEVELS.map((level) => ({ value: level, label: level })) as SelectOption<JlptLevel>[]}
                      block
                    />
                  ) : null}
                  <Field
                    label="密码"
                    type="password"
                    value={newUser.password}
                    onChange={(value) => setNewUser({ ...newUser, password: value })}
                    autoComplete="new-password"
                    placeholder="8–72 位，含字母和数字"
                    block
                  />
                  {newUser.password ? (
                    <div className={`auth-strength ${passwordStrength(newUser.password).ok ? 'ok' : ''}`}>
                      {passwordStrength(newUser.password).text}
                    </div>
                  ) : null}
                  <Field
                    label="确认密码"
                    type="password"
                    value={newUser.confirm}
                    onChange={(value) => setNewUser({ ...newUser, confirm: value })}
                    autoComplete="new-password"
                    placeholder="再次输入密码"
                    block
                  />
                  <button className="btn btn-primary btn-block" disabled={busy} type="submit">
                    {busy ? '注册中…' : '注册并进入'}
                  </button>
                </form>
                {config?.newUserStatus === 'pending' ? (
                  <p className="hint small auth-hint">当前站点开启了注册审核，注册后需管理员启用才能登录。</p>
                ) : null}
                {config?.guestAllowed ? (
                  <button className="auth-link auth-guest" onClick={() => navigate('/', { replace: true })}>
                    以游客身份继续使用 →
                  </button>
                ) : null}
              </>
            )}
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
                  {ROLE_LABEL[user.role]}
                  {user.role === 'teacher' && user.jlptLevel ? ` · ${user.jlptLevel}` : ''}
                  {' · '}用户 ID {user.id}
                </span>
              </div>
            </div>

            <div className="auth-section-title">个人资料</div>
            <form className="auth-inline-form" onSubmit={(event) => void saveProfile(event)}>
              <Field
                placeholder="昵称"
                value={profileName}
                onChange={setProfileName}
                aria-label="昵称"
              />
              <button className="btn" type="submit" disabled={busy}>保存昵称</button>
            </form>

            <div className="auth-section-title">修改密码</div>
            <form className="auth-inline-form auth-form-stack" onSubmit={(event) => void submitPasswordChange(event)}>
              <Field
                type="password"
                placeholder="当前密码"
                value={pwdChange.current}
                onChange={(value) => setPwdChange({ ...pwdChange, current: value })}
                aria-label="当前密码"
              />
              <Field
                type="password"
                placeholder="新密码（8–72 位，含字母和数字）"
                value={pwdChange.next}
                onChange={(value) => setPwdChange({ ...pwdChange, next: value })}
                aria-label="新密码"
              />
              <Field
                type="password"
                placeholder="确认新密码"
                value={pwdChange.confirm}
                onChange={(value) => setPwdChange({ ...pwdChange, confirm: value })}
                aria-label="确认新密码"
              />
              <button className="btn" type="submit" disabled={busy}>修改密码（其它设备将下线）</button>
            </form>

            <div className="auth-section-title">认领本机游客数据</div>
            <p className="hint small auth-hint">
              首次使用若以游客身份录入过数据，可在此搬移到当前账号。认领不可逆，且会一并搬走本机配置的大模型 API Key。
            </p>
            {claimPreview ? (
              <div className="auth-claim-preview">
                <div className="auth-claim-list">
                  {claimPreview.filter((item) => item.count > 0).map((item) => (
                    <div key={item.table} className="auth-claim-row">
                      <span>{item.table}</span><strong>{item.count} 条</strong>
                    </div>
                  ))}
                  {claimPreview.every((item) => item.count === 0) ? (
                    <p className="hint small">本机游客数据为空，无需认领。</p>
                  ) : null}
                </div>
                <div className="auth-claim-actions">
                  <button className="btn btn-primary" disabled={busy} onClick={() => void confirmClaim()}>
                    确认认领（不可撤销）
                  </button>
                  <button className="btn" disabled={busy} onClick={() => setClaimPreview(null)}>取消</button>
                </div>
              </div>
            ) : (
              <button className="btn" disabled={busy} onClick={() => void loadClaimPreview()}>
                预览可认领的数据
              </button>
            )}

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
                          <td>
                            {ROLE_LABEL[item.role]}
                            {item.role === 'teacher' && item.jlptLevel ? ` ${item.jlptLevel}` : ''}
                          </td>
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
                            <button
                              className="auth-link"
                              onClick={() => { setResetFor({ id: item.id, name: item.displayName }); setResetPassword(''); setNotice(null); }}
                            >
                              重置密码
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="auth-section-title">新建本地账号</div>
                <form className="auth-inline-form" onSubmit={(event) => void createUser(event)}>
                  <Field
                    placeholder="用户名"
                    value={newUser.username}
                    onChange={(value) => setNewUser({ ...newUser, username: value })}
                    aria-label="用户名"
                  />
                  <Field
                    placeholder="昵称（可选）"
                    value={newUser.displayName}
                    onChange={(value) => setNewUser({ ...newUser, displayName: value })}
                    aria-label="昵称"
                  />
                  <Field
                    type="password"
                    placeholder="密码（至少 8 位）"
                    value={newUser.password}
                    onChange={(value) => setNewUser({ ...newUser, password: value })}
                    aria-label="密码"
                  />
                  <button className="btn btn-primary" type="submit" disabled={busy}>创建</button>
                </form>
                <p className="hint small auth-hint">
                  本地账号可立即用账号密码登录，拥有独立的备考空间；也可以在登录后到「已绑定的登录渠道」绑定微信或钉钉。
                </p>

                {resetFor ? (
                  <div className="auth-reset-box">
                    <div className="auth-section-title">重置「{resetFor.name}」的密码</div>
                    <form className="auth-inline-form" onSubmit={(event) => void submitReset(event)}>
                      <Field
                        type="password"
                        placeholder="新密码（至少 8 位）"
                        value={resetPassword}
                        onChange={setResetPassword}
                        aria-label="新密码"
                      />
                      <button className="btn btn-primary" type="submit" disabled={busy}>确认重置</button>
                      <button className="btn" type="button" onClick={() => setResetFor(null)}>取消</button>
                    </form>
                    <p className="hint small auth-hint">重置后该用户所有设备会立即下线，需用新密码重新登录。</p>
                  </div>
                ) : null}
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

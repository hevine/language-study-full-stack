/** 侧栏底部的账号卡片：游客显示登录入口，已登录显示用户与退出 */
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

export default function UserMenu() {
  const { user, logout } = useAuth();

  if (!user) {
    return (
      <div className="auth-mini">
        <div className="auth-mini-top">
          <span className="auth-mini-dot" /> 游客模式
        </div>
        <div className="auth-mini-sub">数据保存在本机，不与其他账号共享</div>
        <Link className="auth-mini-btn" to="/login">登录 / 注册</Link>
      </div>
    );
  }

  return (
    <div className="auth-mini">
      <div className="auth-mini-user">
        <span className="auth-mini-avatar">
          {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.displayName.slice(0, 1)}
        </span>
        <span className="auth-mini-name" title={user.displayName}>{user.displayName}</span>
        {user.role === 'admin' ? <span className="auth-mini-role">管理员</span> : null}
      </div>
      <div className="auth-mini-row">
        <Link to="/login">账号中心</Link>
        <button type="button" onClick={() => void logout()}>退出</button>
      </div>
    </div>
  );
}

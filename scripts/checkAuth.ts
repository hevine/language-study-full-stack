/**
 * 认证闭环自检：注册 → 登录 → 重复检测 → 改密 → 锁定 → 重置 → refresh 重放 → 认领 → 登出。
 *
 * 全离线、不依赖已启动的服务，也不碰真实数据：脚本在运行前把 DATA_DIR 指向一个
 * 临时目录，通过动态 import 让 env.ts 在加载时读到该目录，跑完即删。
 *
 * 用法：npm run check:auth
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiyu-auth-check-'));
process.env.DATA_DIR = tmpDir;
process.env.AUTH_ALLOW_REGISTER = 'true';
process.env.AUTH_NEW_USER_STATUS = 'active';
process.env.AUTH_LOCK_THRESHOLD = '5';
process.env.AUTH_LOCK_MINUTES = '15';
process.env.AUTH_JWT_SECRET = 'check-auth-only-secret-not-for-production';

interface Check {
  name: string;
  run: () => void;
}
const checks: Check[] = [];
const check = (name: string, run: () => void) => checks.push({ name, run });

async function main(): Promise<void> {
  const { db, runMigrations, closeDb } = await import('../server/src/db');
  const auth = await import('../server/src/services/auth');
  const repo = await import('../server/src/repositories/auth');
  const meta = { ip: '127.0.0.1', userAgent: 'checkAuth' };
  const expectCode = (err: unknown, code: string) => {
    if ((err as { code?: string }).code !== code) {
      throw new Error(`期望 ${code}，实际 ${(err as { code?: string }).code} / ${(err as Error).message}`);
    }
  };

  runMigrations();
  auth.bootstrapAuth();
  // eslint-disable-next-line no-console
  console.log('认证闭环自检（离线，临时库）：');

  const uname = `tester_${Date.now().toString().slice(-6)}`;
  const pwd = 'Pass1234';
  let registeredId = '';

  check('注册成功并直接签发令牌（active）', () => {
    const result = auth.registerWithPassword(
      { username: uname, password: pwd, displayName: '自检用户', role: 'student' },
      meta,
    );
    if ('pending' in result) throw new Error('不应返回 pending');
    registeredId = result.user.id;
    if (result.user.role !== 'student') throw new Error(`role=${result.user.role}`);
    if (!result.accessToken) throw new Error('缺少 accessToken');
    if (!repo.findUserById(registeredId)?.password_hash) throw new Error('密码未落库');
    // profile 必须同步建好，否则页面昵称会退化成「学员」
    const profile = db.prepare('SELECT display_name FROM profile WHERE user_id = ?').get(registeredId) as
      | { display_name: string }
      | undefined;
    if (!profile || profile.display_name !== '自检用户') throw new Error('profile 昵称未同步');
  });

  check('重复用户名（含大小写变体）转 USERNAME_TAKEN', () => {
    try {
      auth.registerWithPassword({ username: uname.toUpperCase(), password: pwd }, meta);
      throw new Error('重复注册未被拒绝');
    } catch (err) {
      expectCode(err, 'USERNAME_TAKEN');
    }
  });

  check('登录：用户名大小写不敏感', () => {
    const pair = auth.loginWithPassword(uname.toUpperCase(), pwd, meta);
    if (pair.user.id !== registeredId) throw new Error('登录用户不一致');
  });

  check('改密码：旧密码失效、新密码可用', () => {
    auth.changePassword(registeredId, pwd, 'NewPass123', null);
    try {
      auth.loginWithPassword(uname, pwd, meta);
      throw new Error('旧密码仍可用');
    } catch (err) {
      expectCode(err, 'INVALID_CREDENTIALS');
    }
    auth.loginWithPassword(uname, 'NewPass123', meta);
  });

  check('账号锁定：连续 5 次错误后拒绝（ACCOUNT_LOCKED）', () => {
    for (let i = 0; i < 5; i += 1) {
      try {
        auth.loginWithPassword(uname, 'wrongpass', meta);
      } catch {
        // 前几次是 INVALID_CREDENTIALS，忽略
      }
    }
    try {
      auth.loginWithPassword(uname, 'NewPass123', meta);
      throw new Error('锁定后仍可登录');
    } catch (err) {
      expectCode(err, 'ACCOUNT_LOCKED');
    }
  });

  check('管理员重置密码后锁定解除', () => {
    auth.adminResetPassword(registeredId, 'Reset1234');
    const pair = auth.loginWithPassword(uname, 'Reset1234', meta);
    if (pair.user.id !== registeredId) throw new Error('重置后登录失败');
  });

  check('refresh 轮换后旧令牌重放触发整族撤销', () => {
    const pair = auth.loginWithPassword(uname, 'Reset1234', meta);
    const rotated = auth.refreshSession(pair.refreshToken, meta);
    if (rotated.refreshToken === pair.refreshToken) throw new Error('refresh 令牌未轮换');
    try {
      auth.refreshSession(pair.refreshToken, meta);
      throw new Error('旧 refresh 未被拦截');
    } catch (err) {
      expectCode(err, 'SESSION_REPLAY');
    }
  });

  check('教师注册可带能力等级；不能自助注册 admin', () => {
    const teacher = auth.registerWithPassword(
      { username: `teacher_${Date.now().toString().slice(-5)}`, password: pwd, role: 'teacher', jlptLevel: 'N3' },
      meta,
    );
    if ('pending' in teacher || teacher.user.role !== 'teacher' || teacher.user.jlptLevel !== 'N3') {
      throw new Error('教师注册信息不正确');
    }
    try {
      auth.registerWithPassword(
        { username: `adminx_${Date.now().toString().slice(-5)}`, password: pwd, role: 'admin' as 'student' },
        meta,
      );
      throw new Error('自助注册 admin 未被拒绝');
    } catch (err) {
      expectCode(err, 'VALIDATION_FAILED');
    }
  });

  check('游客数据认领：逐表搬移、计数正确、local 清空', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO study_logs (id, user_id, kind, minutes, log_date, created_at)
       VALUES (?, 'local', 'study', 10, '2026-11-22', ?)`,
    ).run(`chk_${Date.now()}`, now);
    const preview = auth.claimGuestPreview();
    if (!preview.find((item) => item.table === 'study_logs' && item.count >= 1)) {
      throw new Error('预览未统计到游客学习记录');
    }
    const result = auth.claimGuestData(registeredId, meta);
    if (!result.find((item) => item.table === 'study_logs' && item.moved >= 1)) {
      throw new Error('认领未搬移学习记录');
    }
    const left = repo.countClaimable('local').find((item) => item.table === 'study_logs');
    if (!left || left.count !== 0) throw new Error('认领后 local 仍有学习记录');
  });

  check('登出撤销会话，access token 校验失效', () => {
    const pair = auth.loginWithPassword(uname, 'Reset1234', meta);
    if (!auth.sessionIdFromToken(pair.accessToken)) throw new Error('无法解析会话 ID');
    auth.logout(pair.refreshToken, meta);
    try {
      auth.resolveAccessToken(pair.accessToken);
      throw new Error('登出后令牌仍有效');
    } catch (err) {
      expectCode(err, 'SESSION_REVOKED');
    }
  });

  let passed = 0;
  let failed = 0;
  for (const c of checks) {
    try {
      c.run();
      passed += 1;
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${c.name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`  ✗ ${c.name}: ${(err as Error).message}`);
    }
  }

  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main();

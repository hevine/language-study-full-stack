/**
 * 设置 / 重置本地管理员（用户名 admin）的密码。
 *
 * 用法（推荐用环境变量，避免密码留在 shell history）：
 *   NEW_ADMIN_PASSWORD='你的强密码' npm run admin:passwd
 * 或者：
 *   npm run admin:passwd -- --password '你的强密码'
 *
 * 只在首次启动时读 AUTH_ADMIN_PASSWORD；之后改密码一律走这个脚本，
 * 这样环境变量里就不必长期保存明文口令。
 */
import { closeDb, runMigrations } from '../server/src/db';
import { bootstrapAuth, setAdminPassword } from '../server/src/services/auth';

function readPassword(): string {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf('--password');
  if (flagIndex >= 0 && args[flagIndex + 1]) return args[flagIndex + 1];
  return process.env.NEW_ADMIN_PASSWORD ?? '';
}

function main(): void {
  const password = readPassword();
  if (!password) {
    // eslint-disable-next-line no-console
    console.error(
      '缺少密码。用法：\n' +
        "  NEW_ADMIN_PASSWORD='至少8位' npm run admin:passwd\n" +
        "  npm run admin:passwd -- --password '至少8位'",
    );
    process.exit(1);
  }
  runMigrations();
  bootstrapAuth();
  setAdminPassword(password);
  // eslint-disable-next-line no-console
  console.log('本地管理员（admin / id=local）的密码已更新。现在可以在登录页用账号密码登录。');
  closeDb();
}

main();

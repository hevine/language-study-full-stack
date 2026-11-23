# HANDOVER-AUTH · 注册与登录专项交接

> **给谁读**：接手「注册与登录整体设计并完善」这个新任务的会话 / 工程师。
> 只讲认证这一块；计划、精读、解题视频等业务只在必须联动时提及。
> 基线：`main@2d8f82a`。认证相关代码（`014_auth.sql`、`routes/auth.ts`、`services/auth.ts`、
> `middleware/auth.ts`、`web/src/pages/Login.tsx` 等）**全部已提交**，当前工作区里那 43 个未提交改动
> 集中在听力库与解题视频容错，与认证无关，不要误当成认证的半成品。

---

## 0. 一句话现状

认证的「骨架」已经搭完并自洽（令牌模型、五张表、扫码状态机、RBAC、审计、按账号隔离数据），
**但缺了最关键的一环：没有注册**。普通人拿不到账号，只能由管理员在登录页后台手工建号；
而眼下数据库里唯一的账号 `local`（用户名 `admin`）**密码为空**，微信/钉钉又没配凭证——
也就是说，把服务跑起来，登录页三种方式**一种都用不了**。

这次任务的本质：把「只有管理员能造号」改成「用户能自己进来，且进来后账号是安全的、可维护的」。

---

## 1. 先跑起来（5 分钟）

### 1.1 命令与端口

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
npm install            # 依赖里有两个 file: 本地 SDK，见 package.json
npm run dev            # 后端 4399，前端 5199；vite 代理 /api → 4399
# 或生产：npm run build && npm start   → 只开 4399，静态页同端口
```

登录页：`http://localhost:5199/login`（生产 `http://localhost:4399/login`）。

### 1.2 Node 版本坑（会让你以为代码坏了）

本机有两个 Node：

| 位置 | 版本 | 能不能加载 `better-sqlite3` |
| --- | --- | --- |
| `node`（WorkBuddy 自带，默认在 PATH 最前） | v22.22.2（ABI 127） | **不能**，会报 `NODE_MODULE_VERSION 137 vs 127` |
| `/usr/local/bin/node` | v24.12.0（ABI 137） | 能，当前 `node_modules` 就是给它编的 |

所以直接 `node -e "...require('better-sqlite3')..."` 会失败。跑脚本时用：

```bash
PATH=/usr/local/bin:$PATH npm run dev
# 或者一次性：/usr/local/bin/node node_modules/.bin/tsx scripts/xxx.ts
```

如果换机器 / 换 Node 大版本，先 `npm rebuild better-sqlite3`。

### 1.3 当前数据库里的真实状态（`.data/app.db`）

| 对象 | 现状 | 含义 |
| --- | --- | --- |
| `users` | **1 行**：`id=local`、`username=admin`、`role=admin`、`password_hash=NULL` | 管理员没密码，密码登录进不去 |
| `auth_sessions` | 0 | 从没人登录成功过 |
| `user_identities` | 0 | 微信/钉钉一个都没绑 |
| `auth_audit_logs` | 1 条 `oauth_bad_state` | 只有一次失败的扫码回调 |
| `profile` | 1 行（`user_id=local`） | 页面上的昵称来自这里 |
| `.data/.authkey` | 存在（600） | JWT 签名密钥，环境变量没配时自动生成 |

`.env` 关键项：`AUTH_REQUIRED=false`（游客可全功能使用）、`AUTH_NEW_USER_STATUS=active`、
`WECHAT_*/DINGTALK_*` 全空（两个扫码渠道 disabled）。

**想让登录页能点通，先做这一步**：

```bash
NEW_ADMIN_PASSWORD='至少8位' npm run admin:passwd
```

### 1.4 游客数据有多少（决定注册时要不要「认领」）

全部挂在 `user_id='local'` 下：

| 表 | 行数 | 表 | 行数 |
| --- | --- | --- | --- |
| `plans` | 13 | `ai_bank_items` | 62 |
| `vocab_items` | 522 | `exam_attempts` | 5 |
| `study_logs` | 31 | `voices` | 22 |
| `materials` | 11 | `voice_assignments` | 12 |
| `llm_keys` | 5 | `listening_materials` | 1 |

注意 `llm_keys`（用户自己的大模型 API Key，加密存库）也带 `user_id`——**认领游客数据会把 API Key 一起搬走**，
这是设计「认领」功能时必须显式提示的风险点。

---

## 2. 认证是怎么搭的（现状全貌）

### 2.1 分层与调用链

```
web/src/api.ts (access token 在模块内存 / 401 自动刷新重试)
        │  Authorization: Bearer  +  Cookie: wb_refresh
        ▼
server/src/routes/index.ts
  healthRouter（永远公开）
  → optionalAuthenticate（有令牌就解析，无效令牌降级游客，不报错）
  → authRouter（/api/auth/*，公开与需登录端点混排）
  → enforceAuth（仅当 AUTH_REQUIRED=true，挡所有业务路由）
  → 业务路由（requireAuth / requireRole 自行把关）
        ▼
server/src/middleware/auth.ts
  requestScopeMiddleware → bindCurrentUser → requireAuth / requireRole / rateLimit / assertSameOrigin
        ▼
server/src/services/auth.ts        业务编排：登录、扫码状态机、令牌轮换、RBAC、审计
        ▼
server/src/repositories/auth.ts    纯 SQL（秘密字段只存 SHA-256）
        ▼
SQLite（014_auth.sql 五张表）
```

请求作用域（`server/src/auth/requestScope.ts`）是全局数据隔离的支点：`AsyncLocalStorage` 在最外层
`run(scope, next)`，下游 16 个业务文件里的 88 处 `currentUserId()` 自动拿到当前用户；
没有请求上下文（CLI 脚本、启动期种子任务）时回落到 `'local'`。

### 2.2 五张表（字段语义与为什么这么设计）

| 表 | 关键字段 | 设计意图 |
| --- | --- | --- |
| `users` | `username UNIQUE`、`password_hash`、`display_name`、`avatar_url`、`role`、`status` | 唯一的「真人」主表。`status` 三态 `active/pending/disabled`，扫码新建用户的初始状态由 `AUTH_NEW_USER_STATUS` 决定 |
| `user_identities` | `(provider, subject) UNIQUE`、`open_id`、`union_id` | 一个真人可绑微信 + 钉钉两条渠道而不产生两份备考数据。微信 `subject = unionid ?? openid` |
| `auth_sessions` | `token_hash UNIQUE`、`family_id`、`replaced_by`、`revoked_at` | 只存 refresh token 的 SHA-256；`family_id` 把一次登录派生的所有 refresh 串成链，检测到旧令牌重放就整链撤销 |
| `auth_login_tickets` | `state_hash`、`ticket_secret`、`status` 五态 | 扫码状态机。回调成功只写 `confirmed`，**不直接签令牌**；兑换要 `ticketSecret`（只存在浏览器 sessionStorage） |
| `auth_audit_logs` | `event`、`provider`、`ip`、`user_agent`、`detail` | 事后排障。已用事件：`login_password`、`login_failed`、`qr_start`、`identity_bound`、`user_created`、`user_created_by_admin`、`oauth_bad_state` |

### 2.3 令牌模型（改代码时最容易踩的地方）

| 项 | 现在的做法 | 为什么 |
| --- | --- | --- |
| access token | HS256 JWT，15 分钟（`AUTH_ACCESS_TTL_SEC=900`），**只放在前端模块内存** | 不进 localStorage，XSS 拿不到持久令牌；刷新页面即丢，靠 refresh 换回 |
| refresh token | 48 字节随机串，**只走 HttpOnly Cookie**，`Path=/api/auth`、`SameSite=Lax`、30 天 | `Path` 限定让刷新令牌不会被带到业务接口上；前端 JS 完全读不到 |
| 轮换 | 每次 refresh 作废旧记录（`revoked_at` + `replaced_by`），签发新的同 family 令牌 | 一次性令牌，降低泄露窗口 |
| 重放检测 | 用已作废的 refresh 再来一次 → 撤销整个 `family_id` | 判定为令牌被复制 |
| 登出 | 撤销当前 session；access token 立刻失效（每次校验都查 `auth_sessions`） | 「下线立即生效」，不只靠 JWT 过期 |
| 密码 | scrypt（N=32768, r=8, p=1, 64B），随机盐，`timingSafeEqual` 比对 | 不引第三方依赖；单次约 80ms，天然抗暴力但**会吃 CPU，登录必须限流** |
| 防枚举 | 用户不存在时也跑一次 `DUMMY_HASH` | 响应耗时一致，无法判断账号是否存在 |
| 限流 | 内存固定窗口，按「动作 + IP」，默认 10 次 / 60 秒 | 登录、refresh、qr-start、qr-poll、qr-exchange 各自独立计数 |

### 2.4 扫码登录状态机（不配凭证时整条链路是灰的）

```
POST /api/auth/qr/start   → 建 ticket(pending)，返回 authorizeUrl + ticketSecret
GET  /api/auth/qr/:id     → 前端每 1.6s 轮询（带 x-ticket-secret 头）
平台回调 /api/auth/callback/:provider
     → 校验 state 摘要 → 换 code → 拉资料 → 找/建用户 → ticket 置 confirmed
     → 302 到 ${AUTH_PUBLIC_BASE_URL}/#/auth/callback?ticket=...&status=...
POST /api/auth/qr/exchange → 凭 ticketId + ticketSecret 换令牌（ticket 置 consumed，一次性）
```

回调 URL 上**没有任何可用凭证**（没有 token、没有 secret），这是刻意的：
URL 会进浏览器历史、Referer、服务器日志。微信/钉钉都要求登记**公网 HTTPS 回调域名**，
本地 `http://localhost` 配不通，所以开发期只能靠账号密码。

### 2.5 前端登录态

- `web/src/auth/AuthProvider.tsx`：启动时 `GET /auth/config` → `refreshSilently()` 用 Cookie 静默换令牌
  → `ready`。`user` 变化即代表数据归属变了。
- `web/src/api.ts`：`request()` 遇 401（且不是 `/auth/*`）自动 refresh 一次并重试；仍失败则
  `setAccessToken(null)` + 派发 `AUTH_LOST_EVENT`，由 AuthProvider 清空用户。上传/音频走 `fetchWithAuth()`，逻辑相同。
- `web/src/App.tsx`：`/login` 与 `/auth/callback` 是全屏页；`config.required && !user` → 一律渲染 `<Login />`；
  `userId` 变化触发整页数据重拉（`useEffect` 依赖 `user.id`），**避免切换账号后串数据**。
- `web/src/pages/Login.tsx`（428 行）：未登录是「扫码 + 账号密码」两段；已登录变成账号中心
  （已绑渠道、登录设备列表、管理员用户表 + 建号表单）。**没有注册入口**。
- `web/src/components/UserMenu.tsx`：侧栏底部，游客显示「登录 / 注册」（文案有「注册」但点了只有登录页）。

### 2.6 现有接口清单

| 方法 | 路径 | 鉴权 | 现状 |
| --- | --- | --- | --- |
| GET | `/api/auth/config` | 公开 | 返回 `required / guestAllowed / passwordEnabled / providers / accessTtlSec` |
| POST | `/api/auth/login` | 公开 + 限流 | 账号密码登录 |
| POST | `/api/auth/register` | — | **不存在（本次要加）** |
| POST | `/api/auth/qr/start` | 公开 + 限流 | 建扫码票据 |
| GET | `/api/auth/qr/:ticketId` | 票据密钥 | 轮询状态 |
| POST | `/api/auth/qr/exchange` | 票据密钥 | 兑换令牌 |
| GET | `/api/auth/callback/:provider` | 平台回调 | 302 回前端 |
| POST | `/api/auth/refresh` | Refresh Cookie | 轮换令牌 |
| POST | `/api/auth/logout` | Refresh Cookie | 撤销并清 Cookie |
| GET | `/api/auth/me` | 登录 | 当前用户 |
| GET/DELETE | `/api/auth/sessions[/:id]` | 登录 | 设备列表 / 单设备下线 |
| GET/POST | `/api/auth/admin/users` | 管理员 | 用户列表 / 手工建号 |
| PATCH | `/api/auth/admin/users/:id` | 管理员 | 改角色 / 状态 / 昵称（有「最后一个管理员」保护） |
| GET | `/api/auth/admin/audit` | 管理员 | 审计日志（limit ≤ 500） |
| — | `/api/auth/password`、`/api/auth/forgot` | — | **不存在（本次要加）** |
| — | `PATCH /api/auth/me` | — | **不存在（自己改昵称/头像做不到）** |

---

## 3. 能力盘点

### 3.1 已经能用（别重写）

- 密码登录 / 登出 / 静默续期 / 多设备会话管理
- 扫码登录全链路（代码是真实实现，不是 mock；缺的只是公网 HTTPS + 凭证）
- 管理员手工建号、改角色、停用/启用、审计查看
- 按账号隔离业务数据（16 个业务文件共 88 处 `currentUserId()`，覆盖 plans / vocab / materials / exams / voices / keys / explain-video）
- `status=pending` 的「待审核」语义已贯通：`resolveAccessToken` 和 `loginWithPassword` 都会拦，文案是「账号待管理员审核」

### 3.2 明确缺失（这次要补的）

| # | 缺口 | 影响 | 优先级 |
| --- | --- | --- | --- |
| 1 | **无自助注册** | 新用户进不来，只能管理员造号 | P0 |
| 2 | 登录页无注册入口、无「忘记密码」 | 文案写了「注册」却点不到 | P0 |
| 3 | 无修改密码 / 找回密码 | 密码忘了只能上服务器跑脚本 | P0（找回）/ P1（改密） |
| 4 | 无自助改昵称、头像 | `display_name` 只能管理员改 | P1 |
| 5 | 扫码注册的用户 `username = NULL` 且无密码 | 微信进来的用户永远没法用密码兜底登录，也没法设密码 | P1 |
| 6 | 无账号级登录失败锁定 | 只有 IP 限流；换 IP 就能继续撞库 | P1 |
| 7 | 游客数据归属未定义 | 注册后看到的是空空间，13 个计划 / 522 个单词「消失」（其实还在 `local` 名下） | **P0 决策项** |
| 8 | 无邮箱/手机字段 | 将来做找回、通知要改表 | P2（可先留列） |
| 9 | `smoke.ts` 完全不覆盖 `/auth` | 改认证没有自动化回归 | P0（补自检脚本） |

### 3.3 半成品 / 隐患（读代码时留意）

- `publicAuthConfig().passwordEnabled` 只看 `local` 这一个账号有没有密码。一旦支持注册，
  这个字段的语义要改成「是否允许密码登录」（否则永远显示「还没设置管理员密码」的提示）。
- 限流桶在**进程内存**里，重启即清零，多实例部署不共享。单机自用没问题，上多实例要换 Redis 或网关限流。
- `pruneExpired()` 只在启动时跑一次；长期不重启，过期 session/ticket 会一直堆着。
- `assertNotLastAdmin` 只保护「停用/降级最后一个管理员」，没保护「管理员改自己密码改错」这类操作。
- 审计日志只有 `limit`，没有分页与按用户筛选；`auth_audit_logs` 没有 `(event, created_at)` 索引。
- `requestMeta` 刻意**不采信 `X-Forwarded-For`**。如果将来上反代，必须在网关改写并在网关限流，否则所有请求的 `ip` 都是 `127.0.0.1`，限流会把所有人当一个 IP 掐死。

---

## 4. 建议的任务范围

### P0 · 注册闭环（本次必须做完）

1. `POST /api/auth/register`：用户名 + 密码 +（可选）昵称；写 `users` + `profile` + 审计；
   `status` 走 `AUTH_NEW_USER_STATUS`。
2. 登录页拆成「登录 / 注册」两个 tab（或 `/register` 路由），成功后行为要与登录一致（进入备考空间）。
3. 注册限流（复用 `rateLimit('register')`）+ 同源校验 + 唯一性冲突转 409。
4. 补 `scripts/checkAuth.ts`：注册 → 登录 → refresh → 重放检测 → 登出，全离线可跑。
5. 明确游客数据策略并落地（见 §5 决策 ③）。

### P1 · 账号可维护

6. `PATCH /api/auth/me`：改昵称 / 头像（同步 `profile.display_name`）。
7. `POST /api/auth/password`：旧密码 + 新密码；改完撤销其他设备的 session（保留当前）。
8. 找回密码：无邮件通道的现实下，先做「管理员重置」（管理员端 `POST /auth/admin/users/:id/password`）+ 审计，
   不做邮件链接。
9. 账号级失败锁定：连续 5 次失败锁 15 分钟（内存 + 审计即可，不必建表）。

### P2 · 留口子，别现在做

10. `users.email` / `users.phone` 列 + 唯一索引（先留列不启用验证）。
11. 邀请码 / 注册审批队列（`status=pending` 已有，缺的是审核提醒与列表筛选）。

---

## 5. 五个必须先拍板的决策

> 建议在动手写代码前，把这 5 条逐条确认；③ 是最容易返工的。

| # | 决策 | 选项 | 影响 | 我的建议 |
| --- | --- | --- | --- | --- |
| ① | 谁能注册 | A 开放注册 / B 邀请码 / C 注册后待审核 / D 关闭 | 决定 `AUTH_ALLOW_REGISTER` 与 `status` 初值 | **A + 开关**：加 `AUTH_ALLOW_REGISTER=true`，`AUTH_NEW_USER_STATUS` 决定是 `active` 还是 `pending`。本机自用设 active，公网部署改 pending，同一套代码 |
| ② | 登录标识 | A 仅用户名 / B 用户名+邮箱 / C 手机号 | 手机号要短信通道（无），邮箱要 SMTP（无） | **A 先做**，`users` 预留 `email` 列不启用；等有邮件服务再做验证与找回 |
| ③ | 游客数据怎么办 | A 不迁移 / B 注册时自动认领 / C 登录后手动「导入本机数据」/ D 注册时让用户勾选 | 游客 13 计划 / 522 单词 / 5 个 API Key 的归属；不可逆 | **C**：默认不迁移，账号中心提供「导入本机游客数据（N 项）」+ 二次确认 + 预览计数 + 审计。理由见下 |
| ④ | `local` 的双重身份 | A 保持（local 既是游客容器又是管理员）/ B 拆开（local 只做游客容器，另建 admin 账号） | 若做 ③，认领会把数据从管理员名下搬走 | **先 A，把 B 记为重构项**。改造面太大（README、bootstrap、`admin:passwd`、历史数据全指向 local），本次不值得动 |
| ⑤ | 密码与锁定策略 | 最短 8 位 / 12 位？锁定 5 次 15 分钟？ | 影响注册表单与登录提示 | **8–72 位、要求含字母+数字、禁止与用户名相同；5 次失败锁 15 分钟**。scrypt 单次 80ms，锁定比加盐更有效 |

### 为什么 ③ 建议选 C（手动认领），而不是注册时自动迁移

1. **不可逆**：`plans` / `vocab_items` 迁移后原用户看不到；误操作没法回滚。
2. **`local` 同时是管理员**：自动迁移会把管理员的 13 个计划搬给新注册用户（如果注册的人不是管理员）。
3. **会带走 API Key**：`llm_keys` 里是加密的第三方 Key，语义上是「这台机器的配置」，不该跟着注册动作走。
4. **已有先例**：项目里其它危险操作（导入卷、教材清洗）都是「先备份 → 显式确认 → 写审计」，认领也该如此。

实现要点：`UPDATE <表> SET user_id = ? WHERE user_id = 'local'`，逐表包在**一个事务**里；
认领前把受影响行数写进审计 `detail`；认领后 `local` 名下相关表应为 0 行。建议同时提供一个
「恢复为游客」的管理员按钮（反向 UPDATE），否则用户点错就死了。

---

## 6. 注册功能设计草案（可直接落地）

### 6.1 接口契约

```
POST /api/auth/register
  body: { username, password, displayName? }
  201  { accessToken, expiresIn, user }        // status=active 时直接登录（并 Set-Cookie）
  202  { pending: true, user }                 // status=pending 时不发令牌，提示「待审核」
  400  VALIDATION_FAILED    用户名/密码不合规
  403  REGISTER_DISABLED    AUTH_ALLOW_REGISTER=false
  409  USERNAME_TAKEN       用户名占用
  429  RATE_LIMITED         复用 rateLimit('register')
```

要点：

- **不要**为了「友好提示」去查 `users` 再插入（TOCTOU + 枚举）。直接 INSERT，
  catch `SQLITE_CONSTRAINT_UNIQUE` 转 `ConflictError('这个用户名已被使用')` 即可。
- 用户名规则沿用 `adminCreateUser` 的正则：`^[a-zA-Z0-9._-]{3,40}$`（大小写不敏感比较要自己处理，
  SQLite 的 UNIQUE 默认区分大小写 → 建议注册时统一转小写存，或加 `COLLATE NOCASE` 索引，二选一，写进迁移）。
- 密码规则：8–72 位，含字母与数字，不得等于用户名。
- 必须调用 `repo.ensureProfileForUser(user.id, displayName)`——**页面上的昵称读的是 `profile` 表**，
  漏了这一步会出现「账号有昵称、页面显示学员」的诡异现象（`bootstrapAuth` 里就是这么踩的，
  所以它对 `local` 做了 `display_name !== '学员'` 的兼容）。
- 审计事件名：`user_registered`，`detail` 里带 `username`（不要带密码、不要带哈希）。

### 6.2 服务层骨架（贴着现有风格写）

```ts
// server/src/services/auth.ts
export function registerWithPassword(
  input: { username: string; password: string; displayName?: string },
  meta: RequestMeta,
): TokenPair | { pending: true; user: AuthUser } {
  if (!env.auth.allowRegister) throw new ForbiddenError('本站暂未开放注册', 'REGISTER_DISABLED');

  const username = input.username.trim().toLowerCase();
  assertUsername(username);          // 抽出来，adminCreateUser 复用同一份规则
  assertPassword(input.password, username);

  let user: repo.UserRow;
  try {
    user = repo.createUser({
      username,
      passwordHash: hashPassword(input.password),
      displayName: (input.displayName?.trim() || username).slice(0, 60),
      role: 'user',
      status: env.auth.newUserStatus,   // active | pending
      providerHint: 'password',
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('这个用户名已被使用', { code: 'USERNAME_TAKEN' });
    throw err;
  }

  repo.ensureProfileForUser(user.id, user.display_name);
  audit('user_registered', meta, { userId: user.id, detail: `username=${username}` });

  if (user.status !== 'active') return { pending: true, user: repo.toAuthUser(user) };
  return issueTokenPair(user, meta, { event: 'login_password', provider: null });
}
```

`ConflictError` 目前不接受 code 参数（`lib/errors.ts` 里写死 `CONFLICT`）。要么给它加一个可选 code，
要么新建 `ConflictError` 的子类；**别在前端按 message 分支**。

### 6.3 前端改动点

| 文件 | 改什么 |
| --- | --- |
| `web/src/api.ts` | 新增 `authRegister(input): Promise<TokenResponse \| { pending: true }>`；`authChangePassword`；`authUpdateMe` |
| `web/src/auth/AuthProvider.tsx` | 新增 `register()`（内部调 `applyTokens`）；`pending` 情况返回给页面处理 |
| `web/src/pages/Login.tsx` | 顶部加「登录 / 注册」切换；注册表单（用户名、昵称、密码、确认密码）；密码强度提示；已有密码登录表单的 `username` 默认值 `'admin'` **要删掉**（开发期残留，正式版很怪） |
| `web/src/App.tsx` | 若拆 `/register` 路由，加一行（也可以只在 Login 内部切换，省一次路由） |
| `web/src/components/UserMenu.tsx` | 「登录 / 注册」拆成两个动作，或保留文案但锚到注册 tab |
| `web/src/styles.css` | 复用 `.auth-*` 已有类；tab 与表单校验态需要补几个类（`.auth-tabs`、`.auth-field-error`、`.auth-strength`） |

### 6.4 错误码与文案（前端按 code 分支，不按 message）

| code | HTTP | 文案 | 出现场景 |
| --- | --- | --- | --- |
| `REGISTER_DISABLED` | 403 | 本站暂未开放注册 | 开关关闭 |
| `USERNAME_TAKEN` | 409 | 这个用户名已被使用 | 唯一约束冲突 |
| `VALIDATION_FAILED` | 400 | 用户名需为 3–40 位字母、数字或 . _ - / 密码至少 8 位且含字母和数字 | 前端已校验，后端兜底 |
| `RATE_LIMITED` | 429 | 操作太频繁，请稍后再试（N 秒后重试） | 超限；`details.retryAfterSec` |
| `ACCOUNT_INACTIVE` | 403 | 账号待管理员审核 / 账号已被停用 | `pending` / `disabled` 登录 |

---

## 7. 不变量（改的时候不能破）

1. **refresh token 绝不进响应体、绝不进 URL、绝不让 JS 读到**。只在 `Set-Cookie`，`Path=/api/auth`。
2. **access token 只存前端模块内存**，不许写 localStorage / sessionStorage。
3. 新增任何业务表查询一律用 `currentUserId()`，**不许**再出现新的硬编码 `'local'`。
4. 新建用户必须同时建 `profile` 行（`ensureProfileForUser`），否则昵称显示会退化成「学员」。
5. 迁移**只增不改**：014 已上线，新字段/新表一律走 `016_*.sql`（015 已被听力库占用），
   并保持「不改动现有业务表」的原则。
6. 任何地方读 `users.username` 都要能处理 `NULL`（扫码注册的用户没有用户名）。
7. 管理员相关操作保留 `assertNotLastAdmin`；新增的「重置密码」「停用」路径也要接上。
8. 错误码是前端契约（`LOGIN_REQUIRED` / `INVALID_CREDENTIALS` / `ACCOUNT_INACTIVE` / `TICKET_CONSUMED`
   / `ROLE_REQUIRED` / `CSRF_ORIGIN`），改名要同步改 `web/src/api.ts` 与页面分支。
9. 依赖 Cookie 的写操作必须 `assertSameOrigin(req)`；新增的 `/auth/*` POST 也要加。
   白名单 = 硬编码 `5199`/`${PORT}` + `AUTH_PUBLIC_BASE_URL` + `AUTH_ALLOWED_ORIGINS`（逗号分隔的完整 origin）；
   **开发态额外放行 `localhost`/`127.0.0.1`/`::1` 的任意端口**——Vite `strictPort:false` 在 5199 被占用时会自动顺延
   （如 5200），代理又保留浏览器原始 Origin，写死端口会误报「跨站请求被拒绝」。生产态不放行回环端口，第三方站点一律拒绝。
10. 密码 / refresh / ticket secret / state **只进哈希**，日志里只允许出现 `tokenFingerprint()` 的 12 位。

---

## 8. 落点文件索引

| 层 | 文件 | 作用 / 本次要动的地方 |
| --- | --- | --- |
| DB | `server/src/db/migrations/014_auth.sql` | 五张表定义（**只读参考**，不要改） |
| DB | `server/src/db/migrations/016_*.sql` | 本次新增（`email` 列、`username COLLATE NOCASE`、失败计数等） |
| DB | `server/src/db/index.ts` | `runMigrations()` 按文件名排序执行，事务内单条提交 |
| 常量 | `server/src/auth/constants.ts` | `LOCAL_USER_ID`、`AuthUser`、`TokenPair`、`REFRESH_COOKIE` |
| 加密 | `server/src/auth/crypto.ts` | `hashPassword` / `verifyPassword` / `sha256` / `loadOrCreateSecret` |
| JWT | `server/src/auth/jwt.ts` | `signAccessToken` / `verifyAccessToken`（校验 alg/iss/aud/exp/nbf） |
| 作用域 | `server/src/auth/requestScope.ts` | `currentUserId()` / `bindCurrentUser()` / `runAsUser()` |
| 中间件 | `server/src/middleware/auth.ts` | Cookie 读写、`optionalAuthenticate`、`requireAuth`、`enforceAuth`、`requireRole`、`rateLimit`、`assertSameOrigin` |
| 路由 | `server/src/routes/auth.ts` | 所有 `/auth/*`（本次加 register / password / me） |
| 服务 | `server/src/services/auth.ts` | `bootstrapAuth` / `loginWithPassword` / `issueTokenPair` / `refreshSession` / `adminCreateUser`（**注册逻辑放这里**） |
| 仓储 | `server/src/repositories/auth.ts` | 纯 SQL；`createUser` / `toAuthUser` / `ensureProfileForUser` / `rotateSession` / `adminUserViews` |
| 第三方 | `server/src/services/oauthProviders.ts` | 微信 QRConnect / 钉钉 OAuth2，未配凭证即 disabled |
| 配置 | `server/src/config/env.ts`（113–142 行） | 所有 `AUTH_*` 解析与默认值 |
| 配置 | `.env.example`（33–76 行） | 认证环境变量说明（新增开关要同步这里） |
| 启动 | `server/src/index.ts` | `bootstrapAuth()` 调用时机、全局中间件顺序 |
| 前端 | `web/src/api.ts`（173–260 行） | 401 刷新重试、`AUTH_LOST_EVENT`、auth 方法集合 |
| 前端 | `web/src/auth/AuthProvider.tsx` | 登录态唯一来源 |
| 前端 | `web/src/pages/Login.tsx` | 登录页 + 账号中心（**要改最大的一处**） |
| 前端 | `web/src/pages/AuthCallback.tsx` | 扫码回调落地页（轮询 → exchange） |
| 前端 | `web/src/types.ts`（1188–1245 行） | `AuthUser` / `AuthConfig` / `TokenResponse` / `AuthSession` |
| 脚本 | `scripts/adminPasswd.ts` | 设/重置本地管理员密码（`npm run admin:passwd`） |
| 脚本 | `scripts/smoke.ts` | 现有冒烟测试，**未覆盖 auth**；新自检建议独立成 `scripts/checkAuth.ts` |

---

## 9. 踩过的坑（都是真金白银，别重犯）

1. **`Path=/api/auth` 会让业务接口拿不到 refresh Cookie**。这不是 bug，是设计；排查「刷新不生效」时别去改 Path。
2. **无效 access token 被降级成游客**（`optionalAuthenticate` 里吞异常），所以业务接口只在 `requireAuth` 生效的地方才挡得住；
   新增受保护接口必须自己挂 `requireAuth`，不能指望全局。
3. **`AUTH_REQUIRED` 只在启动时读一次**（`routes/index.ts` 里 `if (env.auth.required)`），改 `.env` 必须重启。
4. **`profile` 与 `users` 有两份昵称**：页面读 `profile.display_name`，管理端列表读 `users.display_name`。
   改昵称要同时写两处，否则两处显示不一致。
5. **scrypt 是 CPU 密集的**（N=2^15）。压测或爬虫打登录接口会直接把 Node 单线程打满，限流不是「可选项」。
6. **限流键是 IP**，`requestMeta` 不采信 `X-Forwarded-For`；上反代后所有请求会共享同一个桶（`127.0.0.1`）。
7. **扫码回调只 `302` 不改状态以外的事**：不要在回调里 `Set-Cookie`，跨站 302 的 Cookie 行为在 Safari 上会丢。
8. **`ticket_secret` 存在 sessionStorage 而不是 localStorage**：授权页同标签跳转会保留，关标签就失效，
   这是故意的（别「优化」成 localStorage）。
9. **切换账号必须整页重拉数据**（`App.tsx` 用 `user.id` 做依赖）。只 `setUser` 不重拉，会把上一个账号的计划渲染给新用户。
10. **Node 版本**：`better-sqlite3` 是 native 模块，默认 PATH 里的 v22 加载不了（见 §1.2）。
11. **`ConfigError` 默认不暴露 message**（`expose=false`），新加配置项报错时用户只会看到「服务暂不可用」，
    需要排查的配置错误记得传 `expose=true`（这道坑在解题视频导出时踩过一次）。

---

## 10. 验收清单（照着做一遍就算过）

```bash
# 0) 前置
NEW_ADMIN_PASSWORD='admin12345' npm run admin:passwd
npm run dev

# 1) 注册开关关闭时拒绝
#    .env 设 AUTH_ALLOW_REGISTER=false → 重启
curl -s -X POST localhost:4399/api/auth/register -H 'content-type: application/json' \
  -d '{"username":"tester01","password":"pass1234"}' | jq .    # 期望 403 REGISTER_DISABLED

# 2) 打开开关后注册成功并直接登录
#    .env 设 AUTH_ALLOW_REGISTER=true → 重启
curl -si -X POST localhost:4399/api/auth/register -H 'content-type: application/json' \
  -d '{"username":"tester01","password":"pass1234","displayName":"测试员"}' | head -20
#    期望 201、有 accessToken、有 Set-Cookie: wb_refresh=...; HttpOnly; Path=/api/auth

# 3) 重复注册被拒（且不是 500）
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4399/api/auth/register \
  -H 'content-type: application/json' -d '{"username":"tester01","password":"pass1234"}'   # 409

# 4) 新账号数据是隔离的
TOKEN=$(curl -s -X POST localhost:4399/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"tester01","password":"pass1234"}' | jq -r .accessToken)
curl -s localhost:4399/api/plans/active -H "authorization: Bearer $TOKEN" | jq '.plan.id'   # null（看不到游客那 13 个计划）

# 5) 数据库落点
sqlite3 .data/app.db "select id,username,role,status,length(password_hash) from users;
                      select count(*) from profile where user_id<>'local';
                      select event,detail from auth_audit_logs order by created_at desc limit 3;"

# 6) 注册后刷新页面不掉线（浏览器）
#    打开 /、F5 → 仍是该用户；关浏览器重开 → 仍是该用户（refresh cookie 30 天）
```

另外必查：

- [ ] 注册页在浅色 / 深色主题下都不崩（`.auth-*` 走的是全局变量，别写死颜色）
- [ ] 密码错误 5 次后进入锁定，第 6 次提示带剩余秒数
- [ ] 管理员停用新账号后，该用户下一次请求立刻 403 `ACCOUNT_INACTIVE`（不是等 access token 过期）
- [ ] `POST /api/auth/refresh` 拿旧 cookie 重放一次 → 该 family 全撤销，当前设备被踢下线
- [ ] `npm run typecheck` + `npm run build` 全绿

---

## 11. 明确不要做的事

- ❌ 不要把 refresh token 改成「响应体返回 + 前端存 localStorage」（现有模型是刻意设计的安全边界）
- ❌ 不要为了「一次请求拿到用户信息」把 profile 塞进 JWT（昵称可改，JWT 15 分钟才刷新，会出现陈旧数据）
- ❌ 不要写「忘记密码 → 邮件链接」然后留个假 SMTP（没有邮件服务就先做管理员重置，别做半成品）
- ❌ 不要在登录失败提示里区分「用户不存在」和「密码错误」
- ❌ 不要动 `LOCAL_USER_ID` 的语义（`bootstrapAuth`、`admin:passwd`、历史数据、`runAsUser` 全依赖它）
- ❌ 不要在 `014_auth.sql` 上改字段（已上线）；新增一律 `016_*.sql`
- ❌ 不要引入新的第三方鉴权库（现在只用 `node:crypto`，这是刻意的：零依赖、可审计）

---

## 12. 阅读顺序（30 分钟摸清全貌）

1. `server/src/auth/constants.ts`（60 行）—— 所有共享类型与常量
2. `server/src/routes/auth.ts`（253 行）—— 接口全貌，注释里写清了令牌约定
3. `server/src/services/auth.ts`（约 560 行）—— `bootstrapAuth` → `loginWithPassword` → `issueTokenPair` → `refreshSession`
4. `server/src/middleware/auth.ts`（约 200 行）—— 三个中间件 + 限流 + CSRF
5. `server/src/auth/requestScope.ts`（90 行）—— 为什么 88 处 `currentUserId()` 不用改签名
6. `web/src/auth/AuthProvider.tsx` + `web/src/api.ts` 的 `request()` / `refreshSilently()`
7. `web/src/pages/Login.tsx`（428 行）—— 登录页兼账号中心，本次改动主战场

相关文档：`README.md` 的「用户与登录」「用户与鉴权接口」两节（对外说明，改接口要同步更新）、
`HANDOVER.md`（上一轮：删除导入卷）、`HANDOVER-EXPLAIN-VIDEO.md`（解题视频，含 LLM 容错经验）。

---

## 附：给新会话的开场 prompt（直接复制）

```
读 HANDOVER-AUTH.md，然后在这个项目里把「注册与登录」整体设计并完善。
先按文档 §5 的五个决策逐条跟我确认（每条约 1 句话说明你选了哪个、为什么），
再按 §4 的 P0 范围实施：注册接口 + 注册页 + 限流与审计 + scripts/checkAuth.ts 自检。
不要改 014_auth.sql，新增走 016；不要动 LOCAL_USER_ID 的语义；
refresh token 只走 HttpOnly Cookie 这条边界不要破。
做完按 §10 的验收清单逐条跑给我看。
```

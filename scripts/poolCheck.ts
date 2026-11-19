/**
 * 号池自检：用本地假接口验证「额度用尽自动换线」与「Key 不明文落盘」。
 *
 * 全程不碰真实平台、不消耗额度，跑在独立的数据目录里（.data/pool-check），结束后删除。
 *   npm run check:pool
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dataDir = path.resolve('.data/pool-check');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.LLM_API_KEY = '';
process.env.LLM_BASE_URL = '';
process.env.LLM_MODEL = '';

const KEY_EXHAUSTED = 'sk-test-exhausted-000000000001';
const KEY_OK = 'sk-test-working-00000000000002';
const KEY_BROKEN = 'sk-test-server-error-0000000003';

interface Account {
  hits: number;
  status: number;
  body: string;
}

const accounts: Record<string, Account> = {
  exhausted: { hits: 0, status: 429, body: JSON.stringify({ error: { message: 'insufficient quota: free tier exhausted' } }) },
  working: { hits: 0, status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) },
  broken: { hits: 0, status: 500, body: JSON.stringify({ error: { message: 'internal error' } }) },
  // 第一次并发限流、第二次放行：模拟智谱免费模型「等两秒就好」的情况
  flaky: { hits: 0, status: 429, body: JSON.stringify({ error: { message: '当前并发数超过限制，请稍后重试' } }) },
  // HTTP 200 但正文为空、只有思考内容：模拟思考型模型把 max_tokens 花光
  empty: {
    hits: 0,
    status: 200,
    body: JSON.stringify({
      choices: [
        { message: { content: '', reasoning_content: '用户要求输出 JSON，我先想想…' }, finish_reason: 'length' },
      ],
    }),
  },
};

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  const account = Object.keys(accounts).find((name) => url.startsWith(`/${name}/`));
  if (!account) {
    res.writeHead(404).end('not found');
    return;
  }
  const entry = accounts[account];
  entry.hits += 1;
  const flakyPass = account === 'flaky' && entry.hits > 1;
  res
    .writeHead(flakyPass ? 200 : entry.status, { 'content-type': 'application/json' })
    .end(flakyPass ? JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) : entry.body);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const base = (name: string) => `http://127.0.0.1:${port}/${name}/v1`;

const { runMigrations, db, closeDb } = await import('../server/src/db/index.ts');
const { addPoolKey, classifyLlmFailure, deletePoolKey, listPoolKeys, poolCandidates } = await import(
  '../server/src/services/keyPool.ts'
);
const { chat, pingLlm, resolveLlmConfig, llmStatus } = await import('../server/src/services/llm.ts');

const checks: Array<{ name: string; run: () => Promise<string> }> = [];
const failures: string[] = [];

function check(name: string, run: () => Promise<string>) {
  checks.push({ name, run });
}

runMigrations();

const created: string[] = [];

check('号池按优先级返回可用线路', async () => {
  const a = addPoolKey({ label: 'A 额度用尽', baseUrl: base('exhausted'), model: 'mock-model', apiKey: KEY_EXHAUSTED, providerId: 'custom' });
  const b = addPoolKey({ label: 'B 正常', baseUrl: base('working'), model: 'mock-model', apiKey: KEY_OK, providerId: 'custom' });
  const c = addPoolKey({ label: 'C 服务异常', baseUrl: base('broken'), model: 'mock-model', apiKey: KEY_BROKEN, providerId: 'custom' });
  created.push(a.id, b.id, c.id);

  const views = listPoolKeys();
  if (views.length !== 3) throw new Error(`应有 3 条线路，实际 ${views.length}`);
  if (views.some((view) => view.maskedKey.includes('test-'))) throw new Error('掩码里出现了 Key 片段');
  if (!views.every((view) => view.maskedKey.includes('••••'))) throw new Error('掩码格式不对');
  const candidates = poolCandidates();
  if (candidates.length !== 3) throw new Error(`可用线路应为 3，实际 ${candidates.length}`);
  if (candidates[0].label !== 'A 额度用尽') throw new Error('顺序不对，第一条应是 A');
  return `3 条线路 · 掩码 ${views[0].maskedKey}`;
});

check('额度用尽自动切到下一条，并给失败的线路挂冷却', async () => {
  const { config } = resolveLlmConfig();
  if (!config) throw new Error('没有解析出配置');
  const text = await chat(config, [{ role: 'user', content: 'ping' }], { retries: 0 });
  if (!text.includes('"ok"')) throw new Error(`返回内容异常：${text}`);
  if (accounts.exhausted.hits !== 1) throw new Error(`A 应只被调用 1 次，实际 ${accounts.exhausted.hits}`);
  if (accounts.working.hits !== 1) throw new Error(`B 应被调用 1 次，实际 ${accounts.working.hits}`);
  if (accounts.broken.hits !== 0) throw new Error('B 成功后不该再试 C');

  const views = listPoolKeys();
  const a = views.find((view) => view.label === 'A 额度用尽')!;
  const b = views.find((view) => view.label === 'B 正常')!;
  if (a.status !== 'exhausted') throw new Error(`A 状态应为 exhausted，实际 ${a.status}`);
  if (!a.cooldownUntil) throw new Error('A 没有冷却时间');
  if (b.status !== 'ready' || b.successCount !== 1) throw new Error('B 没有记为成功');
  if (config.usedModel !== 'mock-model') throw new Error('没有回填实际使用的模型');
  return `A ${a.status}（${a.lastError}）→ B 成功，用时 ${b.successCount} 次`;
});

check('冷却中的线路不会被重复尝试', async () => {
  const before = accounts.exhausted.hits;
  const { config } = resolveLlmConfig();
  if (!config) throw new Error('没有解析出配置');
  await chat(config, [{ role: 'user', content: 'ping again' }], { retries: 0 });
  if (accounts.exhausted.hits !== before) throw new Error('冷却中的 A 又被调用了');
  if (accounts.working.hits !== 2) throw new Error('B 没有被优先命中');
  return 'A 仍在冷却，直接命中 B';
});

check('全部线路失败时给出可读的汇总错误', async () => {
  const b = listPoolKeys().find((view) => view.label === 'B 正常')!;
  deletePoolKey(b.id);
  const c = listPoolKeys().find((view) => view.label === 'C 服务异常')!;
  const a = listPoolKeys().find((view) => view.label === 'A 额度用尽')!;
  // 让 A、C 都处于可用状态，再一次性打光
  db.prepare("UPDATE llm_keys SET status='ready', cooldown_until=NULL WHERE id IN (?, ?)").run(a.id, c.id);

  const { config } = resolveLlmConfig();
  if (!config) throw new Error('没有解析出配置');
  let message = '';
  try {
    await chat(config, [{ role: 'user', content: 'ping' }], { retries: 0 });
  } catch (err) {
    message = (err as Error).message;
  }
  if (!/所有模型线路都不可用/.test(message)) throw new Error(`错误信息不可读：${message}`);
  if (!/额度/.test(message) || !/500|服务异常/.test(message)) throw new Error(`缺少具体原因：${message}`);
  return message.slice(0, 80);
});

check('429 能区分「并发/频率」与「额度用尽」', async () => {
  const concurrent = classifyLlmFailure(429, '{"error":{"message":"当前并发数超过限制"}}');
  if (concurrent.kind !== 'rate' || !/并发超限/.test(concurrent.message)) {
    throw new Error(`并发限流识别错误：${concurrent.kind} ${concurrent.message}`);
  }
  const quota = classifyLlmFailure(429, '{"error":{"message":"免费额度已用尽"}}');
  if (quota.kind !== 'quota' || !/额度/.test(quota.message)) {
    throw new Error(`额度识别错误：${quota.kind} ${quota.message}`);
  }
  return `${concurrent.message} ／ ${quota.message}`;
});

check('测试连接遇到 429 会等 2.5 秒自动重试一次', async () => {
  const view = addPoolKey({
    label: 'E 限流线路',
    baseUrl: base('flaky'),
    model: 'mock-model',
    apiKey: 'sk-test-flaky-000000000006',
    providerId: 'custom',
  });
  created.push(view.id);
  const { config } = resolveLlmConfig();
  // 直接按这条线路测，避免命中其他线路
  const result = await pingLlm({
    baseUrl: base('flaky'),
    apiKey: 'sk-test-flaky-000000000006',
    model: 'mock-model',
    timeoutMs: 8000,
    jsonMode: false,
    pool: false,
  });
  if (!result.ok) throw new Error(`重试后仍未成功：${result.message}`);
  if (accounts.flaky.hits !== 2) throw new Error(`应当请求 2 次，实际 ${accounts.flaky.hits}`);
  if (config) deletePoolKey(view.id);
  return `${result.message} · 共 ${accounts.flaky.hits} 次请求`;
});

check('「返回内容为空」能说清原因，且测试仍判为线路可用', async () => {
  const view = addPoolKey({
    label: 'F 空正文线路',
    baseUrl: base('empty'),
    model: 'mock-model',
    apiKey: 'sk-test-empty-00000000000007',
    providerId: 'custom',
  });
  created.push(view.id);

  let message = '';
  try {
    await chat(
      {
        baseUrl: base('empty'),
        apiKey: 'sk-test-empty-00000000000007',
        model: 'mock-model',
        timeoutMs: 8000,
        jsonMode: false,
        pool: false,
      },
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 20, retries: 0 },
    );
    throw new Error('空正文竟然没报错');
  } catch (err) {
    message = (err as Error).message;
  }
  if (!/内容为空/.test(message)) throw new Error(`报错措辞不对：${message}`);
  if (!/思考过程吃满/.test(message)) throw new Error(`没点明思考占满 token：${message}`);

  const ping = await pingLlm({
    baseUrl: base('empty'),
    apiKey: 'sk-test-empty-00000000000007',
    model: 'mock-model',
    timeoutMs: 8000,
    jsonMode: false,
    pool: false,
  });
  if (!ping.ok) throw new Error(`通了却判为失败：${ping.message}`);
  if (!/HTTP 200/.test(ping.message)) throw new Error(`提示没说清是 200：${ping.message}`);

  // 5 秒冷却：别因为模型不吐字就把一条好线路关一天
  const line = listPoolKeys().find((item) => item.id === view.id);
  if (!line) throw new Error('线路丢失');
  return `${message.slice(0, 40)}… / 测试判 ${ping.ok ? '通过' : '失败'}`;
});

check('Key 不明文落盘（数据库与 WAL 里都搜不到）', async () => {
  const files = [`${process.env.DATA_DIR}/app.db`, `${process.env.DATA_DIR}/app.db-wal`];
  const haystack = files
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file).toString('latin1'))
    .join('');
  for (const key of [KEY_EXHAUSTED, KEY_OK, KEY_BROKEN]) {
    if (haystack.includes(key)) throw new Error(`数据库里出现了明文 Key：${key.slice(0, 12)}…`);
  }
  const row = db.prepare('SELECT key_cipher FROM llm_keys LIMIT 1').get() as { key_cipher: string };
  if (!row.key_cipher.startsWith('v1:')) throw new Error('密文格式不对');
  return `密文前缀 ${row.key_cipher.slice(0, 12)}… · 明文 0 处`;
});

check('「只存内存」的线路不落盘，重启即失效', async () => {
  const key = 'sk-test-memory-only-00000000004';
  const view = addPoolKey({
    label: 'D 内存线路',
    baseUrl: base('working'),
    model: 'mock-model',
    apiKey: key,
    persist: false,
    providerId: 'custom',
  });
  created.push(view.id);
  const row = db.prepare('SELECT key_cipher, persist FROM llm_keys WHERE id = ?').get(view.id) as {
    key_cipher: string;
    persist: number;
  };
  if (row.persist !== 0 || row.key_cipher !== '') throw new Error('内存线路不应有密文');
  const haystack = fs.readFileSync(`${process.env.DATA_DIR}/app.db`).toString('latin1');
  if (haystack.includes(key)) throw new Error('内存线路的 Key 出现在数据库里');
  const stillUsable = poolCandidates().some((candidate) => candidate.keyId === view.id);
  if (!stillUsable) throw new Error('内存线路应当在本进程内可用');
  return 'persist=0 · 库内无密文 · 本进程可用';
});

check('旧版明文 Key 会被加密迁移并清空原值', async () => {
  const { setSetting, getSetting } = await import('../server/src/repositories/misc.ts');
  const { migrateLegacyKeys } = await import('../server/src/services/keyPool.ts');
  setSetting('llm.baseUrl', base('working'));
  setSetting('llm.model', 'mock-model');
  setSetting('llm.apiKey', 'sk-legacy-plaintext-00000000005');

  migrateLegacyKeys();
  if ((getSetting('llm.apiKey') ?? '') !== '') throw new Error('settings 里的明文没有被清空');
  const migrated = listPoolKeys().find((view) => view.label === '旧配置迁移');
  if (!migrated) throw new Error('没有生成迁移线路');
  created.push(migrated.id);
  const row = db.prepare('SELECT key_cipher FROM llm_keys WHERE id = ?').get(migrated.id) as { key_cipher: string };
  if (!row.key_cipher.startsWith('v1:')) throw new Error('迁移后没有加密');
  return 'settings 已清空 · 号池里是密文';
});

for (const item of checks) {
  try {
    const detail = await item.run();
    console.log(`✅ ${item.name}：${detail}`);
  } catch (err) {
    failures.push(item.name);
    console.log(`❌ ${item.name}：${(err as Error).message}`);
  }
}

for (const id of created) {
  try {
    deletePoolKey(id);
  } catch {
    /* ignore */
  }
}

const status = llmStatus();
closeDb();
server.close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error(`号池自检失败 ${failures.length}/${checks.length} 项：${failures.join('、')}`);
  process.exit(1);
}
console.log(`号池自检通过 ${checks.length}/${checks.length} 项`);
console.log(`（顺带确认：无 Key 时状态 ${status.configured ? '已配置' : '未配置'}）`);

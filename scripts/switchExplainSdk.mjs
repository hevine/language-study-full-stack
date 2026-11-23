#!/usr/bin/env node
/**
 * 解题答疑视频 SDK 依赖来源切换器。
 *
 *   node scripts/switchExplainSdk.mjs local             # 用本地 file: 链接（改 SDK 时联调）
 *   node scripts/switchExplainSdk.mjs npm               # 用 npm 版本（读 SDK 的 package.json version）
 *   node scripts/switchExplainSdk.mjs npm 0.1.0         # 指定版本
 *   node scripts/switchExplainSdk.mjs npm --no-install  # 只改 package.json，不装依赖
 *
 * 同时把代码里遗留的旧包名（@waiyu/explain-video）迁移到当前包名。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NEW_NAME = '@waiyubaodian/explain-video';
const LEGACY_NAMES = ['@waiyu/explain-video', 'waiyu-explain-video'];
/** SDK 仓库位置：可用环境变量 EXPLAIN_SDK_DIR 覆盖，默认取同级 WorkBuddy 工作区 */
const SDK_DIR = process.env.EXPLAIN_SDK_DIR
  ? path.resolve(process.env.EXPLAIN_SDK_DIR)
  : fileURLToPath(new URL('../../../2026-11-21-11-52-51/explain-video-sdk', import.meta.url));

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CODE_DIRS = ['web/src', 'server/src'];

const argv = process.argv.slice(2);
const mode = argv[0];
const noInstall = argv.includes('--no-install');
const versionArg = argv.slice(1).find((a) => /^\d+\.\d+\.\d+/.test(a));

if (!['local', 'npm'].includes(mode)) {
  console.error('用法: node scripts/switchExplainSdk.mjs <local|npm> [version] [--no-install]');
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function migrateImports() {
  let touched = 0;
  for (const rel of CODE_DIRS) {
    for (const file of walk(path.join(projectRoot, rel))) {
      const before = fs.readFileSync(file, 'utf8');
      let after = before;
      for (const legacy of LEGACY_NAMES) after = after.split(legacy).join(NEW_NAME);
      if (after !== before) {
        fs.writeFileSync(file, after);
        touched += 1;
        console.log(`  改名: ${path.relative(projectRoot, file)}`);
      }
    }
  }
  return touched;
}

const pkgPath = path.join(projectRoot, 'package.json');
const pkg = readJson(pkgPath);
pkg.dependencies = pkg.dependencies ?? {};

for (const legacy of LEGACY_NAMES) delete pkg.dependencies[legacy];

let spec;
if (mode === 'local') {
  if (!fs.existsSync(path.join(SDK_DIR, 'package.json'))) {
    console.error(`本地 SDK 目录不存在: ${SDK_DIR}`);
    process.exit(1);
  }
  let rel = path.relative(projectRoot, SDK_DIR).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  spec = `file:${rel}`;
  console.log(`切到本地链接: ${NEW_NAME} -> ${spec}`);
} else {
  const sdkVersion = fs.existsSync(path.join(SDK_DIR, 'package.json'))
    ? readJson(path.join(SDK_DIR, 'package.json')).version
    : null;
  const version = versionArg ?? sdkVersion;
  if (!version) {
    console.error('无法确定版本：请显式传入，例如 node scripts/switchExplainSdk.mjs npm 0.1.0');
    process.exit(1);
  }
  spec = `^${version}`;
  console.log(`切到 npm 版本: ${NEW_NAME} -> ${spec}`);
}

pkg.dependencies[NEW_NAME] = spec;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const migrated = migrateImports();
console.log(`引用改名完成（${migrated} 个文件）`);

if (noInstall) {
  console.log('已跳过 npm install（--no-install）。');
  process.exit(0);
}

console.log('正在安装依赖…');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const res = spawnSync(npmCmd, ['install'], { cwd: projectRoot, stdio: 'inherit' });
if (res.status !== 0) {
  console.error('npm install 失败。若包还没发布，请先完成 PUBLISH.md 的发布步骤，或回退到 local。');
  process.exit(res.status ?? 1);
}

console.log('完成。建议回归：npm run typecheck && npm run build');

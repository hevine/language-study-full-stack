/**
 * Language Pack 加载器。
 *
 * 设计意图（设计文档 §7）：语言差异进数据，不进代码分支。
 * 新增一门语言 = 在这里放一个目录，core/ 一行不改。
 * 「接入新语言不修改 core/ 下任何文件」是 M3 的验收线，所以这个加载器
 * 绝不能对具体语言写 if。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import type { LangCode } from '../types';

const LANG_ROOT = path.dirname(fileURLToPath(import.meta.url));

const ErrorRuleSchema = z.object({
  id: z.string().min(2),
  label: z.string(),
  /** 该错误典型的严重度，工具可覆盖 */
  severity: z.enum(['must-fix', 'should-fix', 'style']).default('should-fix'),
});

const LanguagePackFileSchema = z.object({
  code: z.enum(['en', 'ja', 'ko']),
  name: z.string(),
  script: z.array(z.string()).default([]),
  /** 分词器标识，实现由 adapters 侧按这个名字装配 */
  tokenizer: z.string(),
  /** 句法范式：英语 tree，日语 chunk。决定 SyntaxPort 内部实现，不影响 IR 结构 */
  syntax: z.enum(['tree', 'chunk']),
  phonology: z.string(),
  levelScale: z.object({ id: z.string(), bands: z.array(z.string()).min(1) }),
  exams: z.array(z.string()).default([]),
  scenes: z
    .object({
      supported: z.array(z.string()).default([]),
      /** 不支持的场景必须给理由：宁可明确拒绝，也不产出低质结果 */
      unsupported: z.record(z.string()).default({}),
    })
    .optional(),
});

export interface LanguagePack {
  code: LangCode;
  name: string;
  script: string[];
  tokenizer: string;
  syntax: 'tree' | 'chunk';
  phonology: string;
  levelScale: { id: string; bands: string[] };
  exams: string[];
  supported: string[];
  /** sceneId → 不支持的理由 */
  unsupported: Record<string, string>;
  errors: Array<{ id: string; label: string; severity: 'must-fix' | 'should-fix' | 'style' }>;
}

function readJson(file: string): unknown | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn('语言包 JSON 解析失败，已跳过', { file, err: (err as Error).message });
    return null;
  }
}

/** 扫描 lang/ 下所有 <code>/lang.json。单个语言包坏掉只跳过它，不能让整个服务起不来 */
export function loadLanguagePacks(): Map<LangCode, LanguagePack> {
  const packs = new Map<LangCode, LanguagePack>();

  if (!fs.existsSync(LANG_ROOT)) return packs;

  for (const entry of fs.readdirSync(LANG_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(LANG_ROOT, entry.name);
    const raw = readJson(path.join(dir, 'lang.json'));
    if (!raw) continue;

    const parsed = LanguagePackFileSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('语言包字段不合法，已跳过', {
        dir: entry.name,
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      continue;
    }

    const errorsRaw = readJson(path.join(dir, 'errors.json'));
    const errors = z
      .object({ rules: z.array(ErrorRuleSchema).default([]) })
      .safeParse(errorsRaw ?? {});

    const file = parsed.data;
    packs.set(file.code, {
      code: file.code,
      name: file.name,
      script: file.script,
      tokenizer: file.tokenizer,
      syntax: file.syntax,
      phonology: file.phonology,
      levelScale: file.levelScale,
      exams: file.exams,
      supported: file.scenes?.supported ?? [],
      unsupported: file.scenes?.unsupported ?? {},
      errors: errors.success ? errors.data.rules : [],
    });
  }

  return packs;
}

/** 某语言是否支持某垂类。不支持时返回理由，供路由器给出明确话术而不是硬跑 */
export function sceneSupport(
  pack: LanguagePack | null,
  category: string,
): { ok: true } | { ok: false; reason: string } {
  if (!pack) return { ok: false, reason: '这个语种还没有语言包' };
  const why = pack.unsupported[category];
  if (why) return { ok: false, reason: why };
  if (pack.supported.length > 0 && !pack.supported.includes(category)) {
    return { ok: false, reason: `${pack.name}暂不支持「${category}」这一类练习` };
  }
  return { ok: true };
}

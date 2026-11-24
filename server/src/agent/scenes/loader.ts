/**
 * Scene Pack 加载器（设计文档 §3.3）。
 *
 * 为什么不做成 9 个 if-else：场景要能独立安装、独立 A/B、独立评测。
 * 每个场景一个目录，scene.json 声明「触发、工具、产物、预算、语种要求」，
 * rules.md 是场景守则（用户可在 ~/.lingua/rules/ 覆盖），evals/ 是金标。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { ARTIFACT_TYPES, HELP_LEVELS, RUN_MODES } from '../protocols';
import { SCENE_CATEGORIES } from '../types';
import type { ArtifactType, HelpLevel, RunMode, SceneCategory } from '../types';

const SCENE_ROOT = path.dirname(fileURLToPath(import.meta.url));

const SceneFileSchema = z.object({
  id: z.string().min(2),
  title: z.string(),
  version: z.string().default('0.1.0'),
  /** 所属垂类：语言包按垂类声明能力，不按场景 id */
  category: z.enum(SCENE_CATEGORIES),
  /** 允许的模式：ask 只答、craft 做事、coach 定时。省略表示 ask+craft */
  modes: z.array(z.enum(RUN_MODES)).default(['ask', 'craft']),
  match: z.object({
    /** 触发样例，路由器用字符二元组重叠度打分（中文没有空格，不能用词切分） */
    examples: z.array(z.string()).min(1),
    signals: z.array(z.string()).default([]),
  }),
  /** 工具序列即默认计划的骨架；Planner 会按预算与语种能力再裁剪 */
  tools: z.array(z.string()).min(1),
  artifacts: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  budget: z
    .object({
      maxSteps: z.number().int().positive().default(6),
      maxTokens: z.number().positive().default(12_000),
      tts: z.boolean().default(false),
    })
    .optional(),
  lang: z
    .object({
      requires: z.array(z.string()).default([]),
      /** examId 白名单按语种声明；空数组表示该语种不做这个场景 */
      exams: z.record(z.array(z.string())).default({}),
    })
    .optional(),
  helpDefault: z.enum(HELP_LEVELS).default('L1'),
  /** 产物主渲染器，前端据此选面板 */
  presenter: z.string().optional(),
});

export interface ScenePack {
  id: string;
  title: string;
  version: string;
  category: SceneCategory;
  modes: RunMode[];
  match: { examples: string[]; signals: string[] };
  tools: string[];
  artifacts: ArtifactType[];
  budget: { maxSteps: number; maxTokens: number; tts: boolean };
  lang: { requires: string[]; exams: Record<string, string[]> };
  helpDefault: HelpLevel;
  presenter?: string;
  /** rules.md 原文，注入 system prompt 的场景守则 */
  rules: string;
  /** 金标目录（存在才有） */
  evalDir?: string;
}

const DEFAULT_BUDGET = { maxSteps: 6, maxTokens: 12_000, tts: false };

export function loadScenePacks(): ScenePack[] {
  const packs: ScenePack[] = [];
  if (!fs.existsSync(SCENE_ROOT)) return packs;

  for (const entry of fs.readdirSync(SCENE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SCENE_ROOT, entry.name);
    const file = path.join(dir, 'scene.json');
    if (!fs.existsSync(file)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      logger.warn('场景包 JSON 解析失败，已跳过', { dir: entry.name, err: (err as Error).message });
      continue;
    }

    const parsed = SceneFileSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('场景包字段不合法，已跳过', {
        dir: entry.name,
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      continue;
    }

    const data = parsed.data;
    const rulesPath = path.join(dir, 'rules.md');
    const evalDir = path.join(dir, 'evals');

    packs.push({
      id: data.id,
      title: data.title,
      version: data.version,
      category: data.category,
      modes: data.modes,
      match: data.match,
      tools: data.tools,
      artifacts: data.artifacts,
      budget: data.budget ?? DEFAULT_BUDGET,
      lang: data.lang ?? { requires: [], exams: {} },
      helpDefault: data.helpDefault,
      presenter: data.presenter,
      rules: fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8').trim() : '',
      evalDir: fs.existsSync(evalDir) ? evalDir : undefined,
    });
  }

  return packs;
}

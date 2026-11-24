/**
 * Agent 界面文案表。
 *
 * 工具名（`gra.parse`）是给内核看的，用户看到的是「句法拆解」。
 * 集中一处而不是散在各组件里：将来工具改名只改这张表。
 */
import type { AgentGateId, AgentSceneCategory, SyntaxRole } from '../../agentTypes';

export const TOOL_LABEL: Record<string, string> = {
  'profile.read': '读取学习档案',
  'exam.rubric': '取考试评分标准',
  'gra.rules': '规则引擎扫描',
  'write.diff_review': '逐条批改（模型）',
  'profile.patch': '沉淀错因',
  'gra.parse': '句法拆解（模型）',
  'gra.contrast': '母语迁移对照',
  'explain.video': '生成解题讲解',
};

/** 说的是「这一步在干什么」，不是「调用了什么函数」 */
export const TOOL_HINT: Record<string, string> = {
  'profile.read': '看你的等级、目标与高频错因，决定讲多深',
  'exam.rubric': '按该考试的官方维度与权重评分，不用通用标准',
  'gra.rules': '确定性规则先扫一遍：冠词、时态、主谓一致这类可判定的错',
  'write.diff_review': '模型逐条给修改建议与错因，再与规则结果交叉校验',
  'profile.patch': '把本次命中的错因记进候选库，之后会回来复诊',
  'gra.parse': '拆主干与修饰，逐层标出成分',
  'gra.contrast': '对照中文母语习惯，指出哪些地方容易迁移错',
  'explain.video': '起一个讲解作业，真视频异步产出',
};

export const CATEGORY_LABEL: Record<AgentSceneCategory, string> = {
  vocab: '词汇',
  grammar: '语法',
  sentence: '长短句',
  reading: '阅读',
  writing: '写作',
  speaking: '口语',
  exam: '考证',
  translation: '翻译',
  peripheral: '外语周边',
};

export const ROLE_LABEL: Record<SyntaxRole, string> = {
  head: '主干',
  subject: '主语',
  predicate: '谓语',
  object: '宾语',
  modifier: '修饰',
  particle: '助词',
  clause: '从句',
  other: '其他',
};

export const SEVERITY_LABEL: Record<'must-fix' | 'should-fix' | 'style', string> = {
  'must-fix': '必改',
  'should-fix': '建议改',
  style: '风格',
};

export const GATE_LABEL: Record<AgentGateId, string> = {
  G1: '结构完整',
  G2: '规则一致',
  G3: '双通道一致',
  G4: '回译保真',
  G5: '引用可追溯',
};

export const HELP_LEVELS: Array<{ id: 'L0' | 'L1' | 'L2' | 'L3'; name: string; hint: string }> = [
  { id: 'L0', name: '只指方向', hint: '告诉你该关注哪一段、哪一类问题，不给答案' },
  { id: 'L1', name: '给提示与规则', hint: '指出错在哪条规则上，改法自己想（默认）' },
  { id: 'L2', name: '给局部改写', hint: '把有问题的那一小段改好，其余留给你' },
  { id: 'L3', name: '给完整示范', hint: '整篇给一版示范。看的时候请回译对比，别直接抄' },
];

export function toolLabel(tool: string): string {
  return TOOL_LABEL[tool] ?? tool;
}

export function toolHint(tool: string): string {
  return TOOL_HINT[tool] ?? '';
}

/** 场景标题去掉 `@version` */
export function sceneName(scene: string | null): string {
  if (!scene) return '—';
  return scene.split('@')[0] ?? scene;
}

/**
 * 耗时：低于 1 秒就按毫秒说。
 * 「完成 · 0.0s」既没信息量又像出错 —— 读取档案这种步骤本来就是几十毫秒。
 */
export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(tokens: number): string {
  if (!tokens) return '0';
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

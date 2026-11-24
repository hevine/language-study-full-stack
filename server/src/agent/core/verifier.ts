/**
 * ⑤ 校验：Lingua CI 五关（设计文档 §3.5）。
 *
 * 为什么这件事在教育产品里比在编程产品里更要紧：编译器不会把错教给你，
 * 但一个自信的模型会把错的语法讲得很像对的，学生一旦记住就变成僵化错误，
 * 后面要花十倍时间改。所以宁可标「待复核」，也不要给一个漂亮的错答案。
 */
import { ARTIFACT_PAYLOAD, type Artifact, type VerifyReport } from '../protocols';
import type { AnnotatedDiff } from '../protocols';

/** 双通道分差阈值：0–100 制上约等于一个考试档位（雅思 1 档 ≈ 11 分，此处留一点余量） */
const CHANNEL_GAP_POINTS = 12;

export interface VerifyInput {
  artifacts: Artifact[];
  /** Language Pack 里的合法 ruleId，G5 用它判断「有据可依」 */
  ruleIds: string[];
  /** 规则引擎本次命中数，G2 用 */
  ruleHits: number;
}

export function verify(input: VerifyInput): VerifyReport {
  const gates: VerifyReport['gates'] = [];
  const review: string[] = [];

  const diffs = input.artifacts
    .filter((item) => item.type === 'annotated-diff')
    .map((item) => item.data as AnnotatedDiff);

  // G1 结构：产物必须符合协议，否则前端渲染不出来
  const broken = input.artifacts.filter((art) => {
    const schema = ARTIFACT_PAYLOAD[art.type];
    if (!schema) return false;
    return !schema.safeParse(art.data).success;
  });
  gates.push({
    id: 'G1',
    verdict: input.artifacts.length === 0 ? 'fail' : broken.length === 0 ? 'pass' : 'fail',
    detail:
      input.artifacts.length === 0
        ? '这次没有产出任何产物，无从校验'
        : broken.length === 0
          ? `${input.artifacts.length} 个产物结构合法`
          : `${broken.length} 个产物结构不合法：${broken.map((b) => b.type).join('、')}`,
  });
  // 「0 个产物合法」是最容易骗过自己的绿灯：运行明明失败了，界面却显示校验通过
  if (input.artifacts.length === 0) review.push('没有产物：环节失败或模型超时，先看是哪一步没过');
  if (broken.length > 0) review.push('产物结构不合法，界面可能渲染不出内容');

  // G2 规则：规则引擎跑过就算过关；命中多少只影响分数，不影响判定
  gates.push({
    id: 'G2',
    verdict: 'pass',
    detail: input.ruleHits > 0 ? `规则引擎命中 ${input.ruleHits} 处` : '规则引擎未命中（不等于没问题，只是没有确定性证据）',
  });

  // G3 双通道一致：规则分 vs 模型分。分差过大时不改分数，只标待复核
  const scored = diffs.find((item) => item.score?.ruleOverall !== undefined && item.score?.llmOverall !== undefined);
  if (!scored) {
    gates.push({ id: 'G3', verdict: 'skip', detail: '本次只有一个引擎给分，无法比对' });
  } else {
    const rule = scored.score?.ruleOverall ?? 0;
    const llm = scored.score?.llmOverall ?? 0;
    const gap = Math.abs(rule - llm);
    gates.push({
      id: 'G3',
      verdict: gap <= CHANNEL_GAP_POINTS ? 'pass' : gap <= CHANNEL_GAP_POINTS * 2 ? 'fail' : 'fail',
      detail: `规则 ${rule} / 模型 ${llm}，分差 ${gap} 分（阈值 ${CHANNEL_GAP_POINTS}）`,
    });
    if (gap > CHANNEL_GAP_POINTS) review.push(`两个引擎的分差 ${gap} 分，分数仅供参照`);
  }

  // G4 回译保真：M0 未接 trans.backtranslate，如实标 skip，不假装通过
  const hasRewrite = diffs.some((item) => Boolean(item.rewrite));
  gates.push({
    id: 'G4',
    verdict: hasRewrite ? 'skip' : 'pass',
    detail: hasRewrite ? '存在改写产物，回译校验待接入（M1：trans.backtranslate）' : '本次没有改写，无需回译',
  });
  if (hasRewrite) review.push('改写未经回译校验，语义可能偏移');

  // G5 事实引用：每个错误判定都要能指向一个合法 ruleId
  const unknown = new Set<string>();
  for (const diff of diffs) {
    for (const item of diff.items) {
      if (!item.ruleId) continue;
      if (!input.ruleIds.includes(item.ruleId)) unknown.add(item.ruleId);
    }
  }
  gates.push({
    id: 'G5',
    verdict: unknown.size === 0 ? 'pass' : 'fail',
    detail: unknown.size === 0 ? '全部判定均可追溯到规则或维度' : `出现未知 ruleId：${[...unknown].join('、')}`,
  });
  if (unknown.size > 0) review.push('有判定缺少可追溯依据');

  const fails = gates.filter((gate) => gate.verdict === 'fail').length;
  const skips = gates.filter((gate) => gate.verdict === 'skip').length;
  const confidence = Math.max(0.05, Math.min(1, 0.92 - fails * 0.26 - skips * 0.04));

  return { gates, confidence: Number(confidence.toFixed(2)), review };
}

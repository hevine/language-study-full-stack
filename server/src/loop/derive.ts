import { AnnotatedDiffSchema, type AgentRun, type Artifact } from '../agent/protocols';
import type { DerivedCard } from './types';

const MAX_PER_ARTIFACT = 5;
const MAX_PER_DECK = 10;

/**
 * 产物 → 卡片：零 LLM 的纯规则映射。
 *
 * 采纳必须秒级、可预览、离线可用，所以这一步不能再调模型。
 * 只覆盖当前真实存在的产物类型；视频 / 阅读包 / 计划补丁不产卡。
 */
export function deriveCards(run: AgentRun, artifact: Artifact): DerivedCard[] {
  if (artifact.type === 'annotated-diff') return fromDiff(artifact);
  if (artifact.type === 'syntax-tree') return fromSyntax(run, artifact);
  if (artifact.type === 'card-deck') return fromDeck(artifact);
  return [];
}

function fromDiff(artifact: Artifact): DerivedCard[] {
  const parsed = AnnotatedDiffSchema.safeParse(artifact.data);
  if (!parsed.success) return [];

  const ordered = [...parsed.data.items].sort((a, b) => {
    const weight = (severity: string) => (severity === 'must-fix' ? 0 : severity === 'should-fix' ? 1 : 2);
    return weight(a.severity) - weight(b.severity);
  });

  const seen = new Set<string>();
  const cards: DerivedCard[] = [];
  for (const item of ordered) {
    const front = item.before.trim();
    const back = item.after.trim();
    if (!front || !back || front === back) continue;
    const key = `${item.ruleId}|${front}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({
      kind: 'error',
      front,
      back,
      context: item.reason || undefined,
      ruleId: item.ruleId || undefined,
      sourceRef: 'rule-engine',
    });
    if (cards.length >= MAX_PER_ARTIFACT) break;
  }
  return cards;
}

function fromSyntax(run: AgentRun, artifact: Artifact): DerivedCard[] {
  const payload = artifact.data as { summary?: unknown; nodes?: Array<{ text?: unknown }> } | null;
  const inputText = typeof run.input?.text === 'string' ? run.input.text.trim() : '';

  // 句法树 payload 里没有原句，只能取 run 的输入；取不到时才用节点文本兜底
  const front =
    inputText ||
    (Array.isArray(payload?.nodes)
      ? payload!.nodes
          .map((node) => (typeof node?.text === 'string' ? node.text : ''))
          .filter(Boolean)
          .join(' ')
      : '');
  if (!front) return [];

  const summary = typeof payload?.summary === 'string' ? payload.summary.trim() : '';
  return [
    {
      kind: 'sentence',
      front,
      back: summary || '主干见句法树',
      context: summary ? undefined : '这一句先记主干，细节回到 AI 学习台看句法树。',
      sourceRef: 'syntax-port',
    },
  ];
}

function fromDeck(artifact: Artifact): DerivedCard[] {
  const payload = artifact.data as
    | { entries?: Array<{ term?: string; meaning?: string; example?: string }> }
    | null;
  const entries = payload?.entries;
  if (!Array.isArray(entries)) return [];

  return entries
    .slice(0, MAX_PER_DECK)
    .map<DerivedCard | null>((entry) => {
      const front = (entry.term ?? '').trim();
      const back = (entry.meaning ?? '').trim();
      if (!front || !back) return null;
      return { kind: 'word', front, back, context: entry.example?.trim() || undefined, sourceRef: 'dictionary' };
    })
    .filter((card): card is DerivedCard => card !== null);
}

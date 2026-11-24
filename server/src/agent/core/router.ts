/**
 * ② 路由：意图 → 场景包。
 *
 * 刻意不用大模型分类：一次分类调用只为了选个分支，太贵也太慢，
 * 而且不可复现（同样的输入偶尔给不同结果，评测做不了）。
 * M0 用字符二元组重叠度打分 —— 中文没有空格，按词切分反而更差。
 * 置信度低于阈值时反问一句，而不是硬猜（猜错的代价是跑完一整套工具）。
 */
import type { ScenePack } from '../scenes/loader';

const CLARIFY_THRESHOLD = 0.16;

function bigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, '').toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  if (clean.length === 1) out.add(clean);
  return out;
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

export interface RouteResult {
  scene: ScenePack | null;
  confidence: number;
  candidates: Array<{ id: string; title: string; score: number }>;
  /** scene 为 null 时给用户的反问话术 */
  clarify?: string;
}

export function route(
  input: { query?: string; text?: string; scene?: string; mode: string },
  scenes: ScenePack[],
): RouteResult {
  const scored = scenes.map((scene) => {
    // 显式指定场景优先级最高，但仍然校验它允许这个模式
    if (input.scene && scene.id === input.scene) return { scene, score: 1 };
    const probe = (input.query ?? input.text ?? '').slice(0, 120);
    if (!probe) return { scene, score: 0 };
    const probeSet = bigrams(probe);
    let best = 0;
    for (const example of scene.match.examples) {
      best = Math.max(best, similarity(probeSet, bigrams(example)));
    }
    // 模式不匹配的场景直接压到 0：coach 场景不该被 ask 触发
    const modeOk = scene.modes.includes(input.mode as ScenePack['modes'][number]);
    return { scene, score: modeOk ? best : 0 };
  });

  const ranked = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => ({ id: item.scene.id, title: item.scene.title, score: Number(item.score.toFixed(3)) }));

  const top = ranked[0];
  if (!top || top.score < CLARIFY_THRESHOLD) {
    return {
      scene: null,
      confidence: top?.score ?? 0,
      candidates: ranked.slice(0, 4),
      clarify:
        ranked.length >= 2
          ? `你更想要哪一种？${ranked
              .slice(0, 3)
              .map((item) => `「${item.title}」`)
              .join(' / ')}`
          : '我还判断不出你要做什么。可以说得具体点，比如「按雅思标准改这篇作文」。',
    };
  }

  const chosen = scenes.find((scene) => scene.id === top.id) ?? null;
  return { scene: chosen, confidence: top.score, candidates: ranked.slice(0, 4) };
}

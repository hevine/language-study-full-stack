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

// ---------------------------------------------------------------------------
// 多意图路由：把输入切成 segments，每个 segment 独立打分
// ---------------------------------------------------------------------------

const SPLIT_WORDS = ['另外', '还有', '帮我', '然后', '接着', '同时', 'besides', 'also', 'then'];

function splitSegments(input: string): string[] {
  if (!input.trim()) return [];

  // 长文本（>200 字）按段落分
  if (input.length > 200) {
    return input
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 短文本按信号词分
  let segments: string[] = [input];
  for (const word of SPLIT_WORDS) {
    const next: string[] = [];
    for (const seg of segments) {
      const parts = seg.split(word);
      next.push(...parts.map((p) => p.trim()).filter(Boolean));
    }
    segments = next;
  }

  // 如果分割后只有一段，按标点再试一次
  if (segments.length === 1) {
    const byPunct = input.split(/[。！？.!?;；]/).map((s) => s.trim()).filter(Boolean);
    if (byPunct.length > 1) segments = byPunct;
  }

  return segments.length > 0 ? segments : [input];
}

export interface MultiRouteResult {
  matches: Array<{ scene: ScenePack; confidence: number; inputSegment: string }>;
  unmatched: string;
  clarify?: string;
}

export function routeMulti(
  input: { query?: string; text?: string; scene?: string; mode: string },
  scenes: ScenePack[],
): MultiRouteResult {
  // 显式指定场景时直接返回单场景
  if (input.scene) {
    const scene = scenes.find((s) => s.id === input.scene);
    if (scene) {
      return {
        matches: [{ scene, confidence: 1, inputSegment: input.text ?? input.query ?? '' }],
        unmatched: '',
      };
    }
  }

  const fullText = (input.text ?? input.query ?? '').trim();
  if (!fullText) {
    return { matches: [], unmatched: '', clarify: '请输入要学习的内容' };
  }

  const segments = splitSegments(fullText);
  const matches: MultiRouteResult['matches'] = [];
  let unmatched = '';

  for (const segment of segments) {
    const result = route({ ...input, text: segment, scene: undefined }, scenes);
    if (result.scene && result.confidence >= CLARIFY_THRESHOLD) {
      // 去重：同一场景只保留最高分的 segment
      const existing = matches.find((m) => m.scene.id === result.scene!.id);
      if (existing) {
        if (result.confidence > existing.confidence) {
          existing.confidence = result.confidence;
          existing.inputSegment = segment;
        }
      } else {
        matches.push({
          scene: result.scene,
          confidence: result.confidence,
          inputSegment: segment,
        });
      }
    } else {
      unmatched = unmatched ? `${unmatched} ${segment}` : segment;
    }
  }

  // 取 top-2
  matches.sort((a, b) => b.confidence - a.confidence);
  const top2 = matches.slice(0, 2);

  if (top2.length === 0) {
    return {
      matches: [],
      unmatched: fullText,
      clarify:
        '我还判断不出你要做什么。可以说得具体点，比如「按雅思标准改这篇作文」或「帮我分析这个长难句」。',
    };
  }

  return { matches: top2, unmatched };
}

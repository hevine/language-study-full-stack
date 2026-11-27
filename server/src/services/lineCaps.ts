/**
 * 线路画像：把「这条线路能干什么」从模型名的字符串里显式化出来。
 *
 * 为什么需要这一层：号池原来只有一维优先级，而优先级解决不了「同一条线路，
 * 在这个请求里是主力、在那个请求里必然失败」这类问题。最典型的是 `glm-4v-flash`——
 * 它是视觉模型，塞进文本链会被平台以 400 拒掉（弃用前已累计失败 21 次）；
 * 但它本身是条好线路，将来做「拍照批改作业」「识别教材图片」时就该轮到它。
 *
 * 所以线路不删、不禁用，只标画像；由请求声明自己要什么，路由时匹配。
 *
 * 两条设计红线：
 * 1. **只硬排除「必失败」的组合**（如视觉专用模型收到纯文本请求）。其余一律只调顺序 ——
 *    画像推导靠模型名，总有认不出的时候，标签配错顶多慢一点，不能因为配错就一条线路都不给。
 * 2. **画像不落库**。它是模型名 + 平台 id 的纯函数，改了规则立刻生效；
 *    需要人工修正时再加覆盖列，而不是反过来把推导结果固化进数据库。
 */

export type LineKind = 'text' | 'vision';
/** 思维链能否被请求关掉。always 的线路在低延迟路径上只能退到「低推理档」 */
export type ThinkingControl = 'toggleable' | 'always';
/** 量级：flash 是小而快，pro 是旗舰，standard 居中 */
export type LineTier = 'flash' | 'standard' | 'pro';

export interface LineCaps {
  kind: LineKind;
  thinking: ThinkingControl;
  tier: LineTier;
  /** 判定依据，用于设置页展示与线上排查（标签错了要能一眼看出为什么错） */
  reason: string;
}

/**
 * 视觉专用模型的模型名特征。
 * 注意不要误伤能同时吃文本的多模态模型：`gpt-4o` 文本能力完整，塞进文本链不会 400，
 * 所以不在列表里。这里只收「文本请求必被拒」的那类。
 */
const VISION_ONLY: Array<[RegExp, string]> = [
  [/[0-9]v([-_]|$)/i, '模型名带 Nv 后缀（如 glm-4v / glm-4.6v），视觉专用'],
  [/[-_]vl([-_]|$)/i, '模型名带 -vl 后缀（如 qwen-vl），视觉专用'],
  [/vision/i, '模型名含 vision，视觉专用'],
];

/**
 * 无法关闭思维链的线路。
 * 依据是实测：GLM-5 系传 `thinking:{type:"disabled"}` 会直接 400
 * （平台原文「该模型始终思考，不支持关闭思考」），只能改用 `reasoning_effort` 降档。
 */
const ALWAYS_THINKING: Array<[RegExp, string]> = [
  [/^glm-5/, 'GLM-5 系始终思考，无法关闭'],
  [/reasoner/i, 'reasoner 系专为推理设计，思考不可关'],
  [/[-_]thinking/i, 'thinking 变体，思考不可关'],
  [/^o[13]([-_]|$)/i, 'o1/o3 系为推理模型'],
  [/qwq/i, 'QwQ 为推理模型'],
];

const FLASH_TIER: Array<[RegExp, string]> = [
  [/flash/i, 'flash 档'],
  [/lite/i, 'lite 档'],
  [/turbo/i, 'turbo 档'],
  [/[-_]mini([-_]|$)/i, 'mini 档'],
  [/[-_]air([-_]|$)/i, 'air 档'],
  [/instant/i, 'instant 档'],
];

const PRO_TIER: Array<[RegExp, string]> = [
  [/-pro([-_]|$)/i, 'pro 档'],
  [/-max([-_]|$)/i, 'max 档'],
  [/opus/i, 'opus 档'],
  [/[-_]ultra([-_]|$)/i, 'ultra 档'],
];

function firstMatch(rules: Array<[RegExp, string]>, model: string): string | null {
  for (const [pattern, reason] of rules) {
    if (pattern.test(model)) return reason;
  }
  return null;
}

/**
 * 运行证据：号池里持久化的真实失败记录。
 *
 * 为什么要它：画像靠模型名推导，而模型名可以被用户随手改成别名（例如混元的线路
 * 直接叫 `hy4`、`hy3`），名字里不含任何特征。但 `last_error` 是实测出来的 ——
 * 一条被记上「返回内容为空（思考占满 max_tokens）」的线路，无论它叫什么名字，
 * 都该按「思考不可关」对待。真实证据优先于名字猜测。
 */
export interface LineEvidence {
  lastError?: string | null;
}

/** 失败信息里出现这些，说明这条线路把预算花在思考上了 */
const REASONING_EVIDENCE = /思考占满|只有思考|reasoning_content/i;

/**
 * 按模型名 + 运行证据推导画像。纯函数：同样的入参永远同样的结果，便于测试与缓存。
 */
export function capabilitiesOf(model: string, providerId?: string, evidence?: LineEvidence): LineCaps {
  const name = (model ?? '').trim();
  const reasons: string[] = [];

  const visionReason = firstMatch(VISION_ONLY, name);
  const kind: LineKind = visionReason ? 'vision' : 'text';
  if (visionReason) reasons.push(visionReason);

  const thinkReason = firstMatch(ALWAYS_THINKING, name);
  const evidenceSaysReasoning = REASONING_EVIDENCE.test(evidence?.lastError ?? '');
  const thinking: ThinkingControl = thinkReason || evidenceSaysReasoning ? 'always' : 'toggleable';
  if (thinkReason) reasons.push(thinkReason);
  else if (evidenceSaysReasoning) reasons.push('历史失败记录显示思考吃满预算，按思考不可关处理');

  let tier: LineTier = 'standard';
  const flashReason = firstMatch(FLASH_TIER, name);
  const proReason = flashReason ? null : firstMatch(PRO_TIER, name);
  if (flashReason) {
    tier = 'flash';
    reasons.push(flashReason);
  } else if (proReason) {
    tier = 'pro';
    reasons.push(proReason);
  }

  return {
    kind,
    thinking,
    tier,
    reason: reasons.length ? reasons.join('；') : `${providerId ?? '未标注平台'} 通用文本线路，无特殊约束`,
  };
}

/**
 * 请求画像：调用方只声明「我要什么样的线路」，不点名具体模型。
 *
 * 这是刻意设计 —— 如果让场景直接写「长短句用这 4 条」，每加一个场景就要重配一遍，
 * 换线路还要改场景代码。声明需求之后，新场景自动继承同一批线路。
 */
export type RunProfile = 'balanced' | 'interactive' | 'long-output' | 'deep' | 'vision';

export interface ProfileRule {
  /** 这条线路能不能接这类活。返回 false 表示「必失败」，直接排除 */
  accept: (caps: LineCaps) => boolean;
  /** 该类活的默认思考策略：交互路径关掉，深评路径要求开 */
  thinking: 'auto' | 'off' | 'on';
  /**
   * 是否按「旗舰优先」重排。只有 deep 开 ——
   * 深评要质量是客观事实，不是个人偏好，所以允许压过手工优先级。
   * 其余档位一律以号池 priority 为主序：代码负责「能不能用」，人负责「谁先谁后」。
   */
  preferQuality?: boolean;
  /**
   * 把「无法关闭思考」的线路排到本档末尾（但不排除）。
   * 用在交互档：它们关不掉思考只能降推理档，慢一截，但正文仍可用，属于可用备胎。
   */
  deferAlwaysThinking?: boolean;
  desc: string;
}

export const PROFILE_RULES: Record<RunProfile, ProfileRule> = {
  /** 不筛选，保持历史行为。所有未显式声明 profile 的调用方都走这里 */
  balanced: {
    accept: () => true,
    thinking: 'auto',
    desc: '不筛选，按号池优先级直排',
  },

  /**
   * 低延迟交互（句子拆解、写作批改、规划、校验）。
   *
   * 视觉专用模型在这一档是纯浪费：发过去必然 400，还要白等一次往返，所以排除。
   * 关不掉思考的线路不排除（正文质量仍然可用），但排到最后，并自动降推理档。
   * 最终队列形如：能关思考的快线在前，关不掉思考的垫后，视觉线完全不参与。
   */
  interactive: {
    accept: (caps) => caps.kind === 'text',
    thinking: 'off',
    deferAlwaysThinking: true,
    desc: '低延迟交互：排除视觉专用线路，关闭思维链，思考不可关的垫后',
  },

  /**
   * 长输出（解题讲解脚本 6–10k token）。思考型线路会把 max_tokens 全花在 reasoning 上，
   * 正文一个字都不留 —— 这条在实现期踩过，日志是「返回内容为空（思考占满 max_tokens）」。
   * 所以这一档对「无法关闭思考」的线路做硬排除，而不是只排后：
   * 长输出没有第二次机会，白等两分钟比慢更糟。
   */
  'long-output': {
    accept: (caps) => caps.kind === 'text' && caps.thinking === 'toggleable',
    thinking: 'off',
    desc: '长输出：排除视觉专用与思考不可关的线路，避免正文为空',
  },

  /** 高质量深评（作文精评、整篇精读）。这里反而要思考，且旗舰优先 */
  deep: {
    accept: (caps) => caps.kind === 'text',
    thinking: 'on',
    preferQuality: true,
    desc: '深评：文本线路全参与，开启思维链，旗舰优先',
  },

  /** 视觉任务（拍照批改、识别教材图片）。将来接这类功能时，glm-4v-flash 会自动进队 */
  vision: {
    accept: (caps) => caps.kind === 'vision',
    thinking: 'auto',
    desc: '视觉任务：只选视觉专用线路',
  },
};

/** 质量序：deep 档按这个排，数字小的先试 */
export const QUALITY_ORDER: Record<LineTier, number> = { pro: 0, standard: 1, flash: 2 };


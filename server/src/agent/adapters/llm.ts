/**
 * LlmPort 的进程内实现：直接复用主项目已打磨过的号池 / 重试 / JSON 修复能力。
 *
 * 这里什么都不重写 —— 号池轮换、截断加预算重试、JSON 抢救全在 services/llm.ts 里，
 * 那些是踩过坑换来的，重写一遍只会把坑再踩一遍。
 */
import type { LlmPort } from '../ports';
import { chat, chatJson, resolveLlmConfig } from '../../services/llm';

export function createLlmPort(): LlmPort {
  return {
    async json(req) {
      const { config } = resolveLlmConfig();
      if (!config) {
        throw new Error('还没有配置大模型：到「设置 → 模型 Key」填一条 OpenAI 兼容线路');
      }
      const data = await chatJson(
        config,
        [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        req.schema,
        {
          temperature: req.temperature ?? 0.4,
          maxTokens: req.maxTokens ?? 2000,
          // Agent 的每一步都挡在用户面前等，默认走低延迟交互档：
          // 排除视觉专用线路、关闭思维链、思考不可关的线路垫后
          profile: req.profile ?? 'interactive',
          thinking: req.thinking,
        },
      );
      return { data, tokens: config.usage?.totalTokens ?? 0 };
    },

    async text(req) {
      const { config } = resolveLlmConfig();
      if (!config) {
        throw new Error('还没有配置大模型：到「设置 → 模型 Key」填一条 OpenAI 兼容线路');
      }
      const text = await chat(
        config,
        [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        {
          temperature: 0.5,
          maxTokens: req.maxTokens ?? 1200,
          profile: req.profile ?? 'interactive',
          thinking: req.thinking,
        },
      );
      return { text, tokens: config.usage?.totalTokens ?? 0 };
    },
  };
}

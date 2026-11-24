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
          // 交互路径默认不想：思维链在这类结构化任务上换不来质量，只换来几十秒
          thinking: req.thinking ?? 'off',
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
        { temperature: 0.5, maxTokens: req.maxTokens ?? 1200, thinking: req.thinking ?? 'off' },
      );
      return { text, tokens: config.usage?.totalTokens ?? 0 };
    },
  };
}

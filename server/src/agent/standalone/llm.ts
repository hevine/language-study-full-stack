/**
 * Standalone LlmPort：直连 OpenAI 兼容 API，不走号池。
 *
 * standalone 单用户场景不需要号池轮换与重试策略——配一条线路就够。
 * JSON 模式直接用 response_format: { type: 'json_object' }。
 */
import type { LlmPort } from '../ports';

export interface StandaloneLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export function createStandaloneLlm(config: StandaloneLlmConfig): LlmPort {
  const timeoutMs = config.timeoutMs ?? 90_000;

  async function callAPI(
    system: string,
    user: string,
    opts: { temperature?: number; maxTokens?: number; json?: boolean; thinking?: 'auto' | 'off' | 'on' },
  ): Promise<{ text: string; tokens: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: opts.temperature ?? 0.4,
          max_tokens: opts.maxTokens ?? 2000,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM API ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      const tokens = json.usage?.total_tokens ?? 0;
      return { text, tokens };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async json(req) {
      const { text, tokens } = await callAPI(req.system, req.user, {
        temperature: req.temperature ?? 0.4,
        maxTokens: req.maxTokens ?? 2000,
        json: true,
        thinking: req.thinking ?? 'off',
      });

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        data = JSON.parse(cleaned);
      }

      const parsed = req.schema.safeParse(data);
      if (!parsed.success) {
        throw new Error(
          `LLM 输出不符合 schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }

      return { data: parsed.data, tokens };
    },

    async text(req) {
      return callAPI(req.system, req.user, {
        temperature: 0.5,
        maxTokens: req.maxTokens ?? 1200,
        thinking: req.thinking ?? 'off',
      });
    },
  };
}

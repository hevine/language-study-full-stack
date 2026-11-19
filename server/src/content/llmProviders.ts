/**
 * 大模型服务商预设。
 *
 * 这里只收录「OpenAI 兼容」的接口，前端选中后自动填好 Base URL 与推荐模型，
 * 用户只需粘贴自己的 API Key。免费档的说明都写在 freeNote 里，方便挑便宜的先跑通。
 */

export interface LlmModelOption {
  id: string;
  label: string;
  /** 免费 / 上下文长度等提示，展示在模型下拉里 */
  note?: string;
  free?: boolean;
}

export interface LlmProvider {
  id: string;
  name: string;
  vendor: string;
  baseUrl: string;
  defaultModel: string;
  models: LlmModelOption[];
  /** 免费额度说明（一句话） */
  freeNote: string;
  applyUrl: string;
  applyLabel: string;
  keyHint: string;
  /** 该平台是否支持 response_format: json_object；不支持的走提示词 + 修复重试 */
  jsonMode: boolean;
}

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'zhipu',
    name: '智谱 GLM',
    vendor: 'BigModel 开放平台',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.7-flash',
    models: [
      { id: 'glm-4.7-flash', label: 'GLM-4.7-Flash', note: '免费 · 200K 上下文', free: true },
      { id: 'glm-4.5-flash', label: 'GLM-4.5-Flash', note: '免费', free: true },
      { id: 'glm-4.5-air', label: 'GLM-4.5-Air', note: '免费 · 轻量', free: true },
      { id: 'glm-4.6v-flash', label: 'GLM-4.6V-Flash', note: '免费 · 多模态', free: true },
      { id: 'glm-4.7', label: 'GLM-4.7', note: '更强，按量计费' },
    ],
    freeNote: 'GLM-4.7-Flash 免费，30 QPS，中文最强免费档',
    applyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    applyLabel: '去 BigModel 创建 API Key',
    keyHint: '形如 xxxxxxxx.yyyyyyyy（控制台 → API Keys）',
    jsonMode: true,
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    vendor: '腾讯云',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: 'hunyuan-lite',
    models: [
      { id: 'hunyuan-lite', label: 'Hunyuan-Lite', note: '永久免费 · 并发 5', free: true },
      { id: 'hunyuan-turbos-latest', label: 'Hunyuan-TurboS', note: '更快，按量计费' },
      { id: 'hunyuan-pro', label: 'Hunyuan-Pro', note: '旗舰，按量计费' },
    ],
    freeNote: 'Hunyuan-Lite 永久免费不限量（并发 5）',
    applyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    applyLabel: '去腾讯云创建 API Key',
    keyHint: '控制台 → 混元大模型 → API Key 管理',
    jsonMode: false,
  },
  {
    id: 'modelscope',
    name: '魔搭 ModelScope',
    vendor: '阿里 · 模型社区',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    defaultModel: 'Qwen/Qwen3-8B-Instruct',
    models: [
      { id: 'Qwen/Qwen3-8B-Instruct', label: 'Qwen3-8B-Instruct', note: '免费 · 建议先用它验证', free: true },
      { id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5-7B-Instruct', note: '免费 · 备选', free: true },
    ],
    freeNote: '每天 2000 次免费调用，注册即用',
    applyUrl: 'https://modelscope.cn/my/myaccesstoken',
    applyLabel: '去魔搭获取 SDK Token',
    keyHint: '账号中心 → 访问令牌；模型名填「模型 ID」，如 Qwen/Qwen3-8B-Instruct',
    jsonMode: false,
  },
  {
    id: 'dashscope',
    name: '通义千问',
    vendor: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: [
      { id: 'qwen-plus', label: 'qwen-plus', note: '均衡，新用户有免费额度' },
      { id: 'qwen-turbo', label: 'qwen-turbo', note: '便宜快速' },
      { id: 'qwen-max', label: 'qwen-max', note: '旗舰' },
    ],
    freeNote: '新用户每个模型有免费 token 额度',
    applyUrl: 'https://bailian.console.aliyun.com/',
    applyLabel: '去百炼控制台创建 Key',
    keyHint: '以 sk- 开头',
    jsonMode: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: '深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat', note: '通用对话' },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner', note: '推理更强，慢一些' },
    ],
    freeNote: '无免费额度，但价格很低',
    applyUrl: 'https://platform.deepseek.com/api_keys',
    applyLabel: '去 DeepSeek 创建 Key',
    keyHint: '以 sk- 开头',
    jsonMode: true,
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    vendor: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: [
      { id: 'moonshot-v1-8k', label: 'moonshot-v1-8k', note: '8K 上下文' },
      { id: 'moonshot-v1-32k', label: 'moonshot-v1-32k', note: '32K 上下文' },
    ],
    freeNote: '新用户有试用额度',
    applyUrl: 'https://platform.moonshot.cn/console/api-keys',
    applyLabel: '去 Kimi 开放平台创建 Key',
    keyHint: '以 sk- 开头',
    jsonMode: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini', note: '便宜够用' },
      { id: 'gpt-4o', label: 'gpt-4o', note: '更强' },
    ],
    freeNote: '无免费额度，需要绑卡',
    applyUrl: 'https://platform.openai.com/api-keys',
    applyLabel: '去 OpenAI 创建 Key',
    keyHint: '以 sk- 开头',
    jsonMode: true,
  },
  {
    id: 'custom',
    name: '自定义',
    vendor: '任意 OpenAI 兼容接口',
    baseUrl: '',
    defaultModel: '',
    models: [],
    freeNote: '自建网关、Ollama、one-api 等都可以填这里',
    applyUrl: '',
    applyLabel: '',
    keyHint: '本地服务没有 Key 时随便填一个占位符即可',
    jsonMode: true,
  },
];

export function providerById(id: string | null | undefined): LlmProvider | null {
  if (!id) return null;
  return LLM_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** 按 Base URL 反查服务商，用于「用户在设置里手改过地址」的情况 */
export function providerForBaseUrl(baseUrl: string): LlmProvider | null {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  if (!normalized) return null;
  const hit = LLM_PROVIDERS.find(
    (provider) => provider.baseUrl && normalized.startsWith(provider.baseUrl.toLowerCase()),
  );
  return hit ?? null;
}

/** 前端展示用的精简结构（不带内部字段） */
export function llmProviderCatalog(): LlmProvider[] {
  return LLM_PROVIDERS;
}

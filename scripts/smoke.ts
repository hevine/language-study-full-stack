/**
 * 冒烟自检脚本：只读检查服务是否可用，不写入任何业务数据。
 *
 * 用法：
 *   npm run smoke
 *   BASE_URL=http://127.0.0.1:4399 npm run smoke
 */
import http from 'node:http';
import { providerById } from '../server/src/content/llmProviders';
import { stripPromo } from '../server/src/services/sanitize';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:4399').replace(/\/+$/, '');

function getJson(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}${path}`);
    const request = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, timeout: 8000 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (!response.statusCode || response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('返回内容不是 JSON'));
          }
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error('请求超时'));
    });
    request.on('error', (err) => reject(err));
  });
}

interface Check {
  name: string;
  run: () => Promise<string>;
}

const checks: Check[] = [
  {
    name: 'GET /api/health',
    run: async () => {
      const data = (await getJson('/api/health')) as { status: string; uptime: number };
      if (data.status !== 'ok') throw new Error(`status=${data.status}`);
      return `uptime ${data.uptime}s`;
    },
  },
  {
    name: 'GET /api/ready（数据库可用）',
    run: async () => {
      const data = (await getJson('/api/ready')) as { status: string };
      if (data.status !== 'ready') throw new Error(`status=${data.status}`);
      return 'sqlite ready';
    },
  },
  {
    name: 'GET /api/catalog（考纲目录）',
    run: async () => {
      const data = (await getJson('/api/catalog')) as {
        languages: Array<{ exams: unknown[] }>;
        llm: { configured: boolean };
      };
      const exams = data.languages.reduce((sum, lang) => sum + lang.exams.length, 0);
      return `${data.languages.length} 种语言 / ${exams} 门考试 / 模型 ${
        data.llm.configured ? '已配置' : '未配置（演示模式）'
      }`;
    },
  },
  {
    name: 'GET /api/plans/active',
    run: async () => {
      const data = (await getJson('/api/plans/active')) as { plan: { targetLabel: string } | null };
      return data.plan ? `当前计划：${data.plan.targetLabel}` : '尚无计划（首次打开会进入目标设定）';
    },
  },
  {
    name: 'GET /api/stats',
    run: async () => {
      const data = (await getJson('/api/stats')) as { streak: number; vocabulary: { total: number } };
      return `连续 ${data.streak} 天 / 词汇 ${data.vocabulary.total} 个`;
    },
  },
  {
    name: 'GET /api/practice/overview（批改中心）',
    run: async () => {
      const data = (await getJson('/api/practice/overview')) as {
        tasks: unknown[];
        summary: { attempts: number };
      };
      return `${data.tasks.length} 个今日输出任务 / 累计批改 ${data.summary.attempts} 次`;
    },
  },
  {
    name: 'GET /api/practice/attempts（批改记录）',
    run: async () => {
      const data = (await getJson('/api/practice/attempts?limit=5')) as { attempts: unknown[] };
      return `${data.attempts.length} 条记录`;
    },
  },
  {
    name: 'GET /api/paths/:language（学习之路）',
    run: async () => {
      const ja = (await getJson('/api/paths/ja')) as {
        steps: Array<{ levelName: string; status: string }>;
      };
      const en = (await getJson('/api/paths/en')) as { steps: unknown[] };
      const ko = (await getJson('/api/paths/ko')) as { steps: unknown[] };
      if (ja.steps.length === 0 || en.steps.length === 0 || ko.steps.length === 0) {
        throw new Error('台阶为空');
      }
      return `日语 ${ja.steps.map((s) => s.levelName.replace(/^JLPT /, '')).join('→')} / 英语 ${en.steps.length} 级 / 韩语 ${ko.steps.length} 级`;
    },
  },
  {
    name: 'GET /api/lexicon（分级词库：英语 / 日语 / 韩语隔离）',
    run: async () => {
      const en = (await getJson('/api/lexicon?language=en')) as {
        levels: Array<{ id: string; total: number }>;
      };
      const ja = (await getJson('/api/lexicon?language=ja')) as {
        levels: Array<{ id: string; total: number }>;
      };
      const ko = (await getJson('/api/lexicon?language=ko')) as {
        levels: Array<{ id: string; total: number }>;
      };
      const enTotal = en.levels.reduce((sum, level) => sum + level.total, 0);
      const jaTotal = ja.levels.reduce((sum, level) => sum + level.total, 0);
      const koTotal = ko.levels.reduce((sum, level) => sum + level.total, 0);
      if (enTotal === 0 || jaTotal === 0 || koTotal === 0) throw new Error('词库为空');
      const enIds = en.levels.map((l) => l.id).join('/');
      const jaIds = ja.levels.map((l) => l.id).join('/');
      const koIds = ko.levels.map((l) => l.id).join('/');
      if (enIds !== 'basic/core/advanced' || jaIds !== 'n3/n2/n1') {
        throw new Error(`级别异常 en=${enIds} ja=${jaIds}`);
      }
      if (koIds !== 'ko1/ko2/ko3/ko4/ko5/ko6') {
        throw new Error(`级别异常 ko=${koIds}`);
      }
      return `英语 ${enTotal} 词（${enIds}）/ 日语 ${jaTotal} 词（${jaIds}）/ 韩语 ${koTotal} 词（${koIds}）`;
    },
  },
  {
    name: 'GET /api/exam-calendar（报考日历：托福 / JLPT / TOPIK）',
    run: async () => {
      const toefl = (await getJson(
        '/api/exam-calendar?examId=toefl&examDate=2027-02-07',
      )) as { events: Array<{ id: string; isTask: boolean }>; fees: unknown[] };
      const jlpt = (await getJson(
        '/api/exam-calendar?examId=jlpt&examDate=2027-07-04',
      )) as { events: Array<{ id: string; date: string }>; fees: unknown[] };
      const topik = (await getJson(
        '/api/exam-calendar?examId=topik&examDate=2027-04-11',
      )) as { events: Array<{ id: string; isTask: boolean }>; fees: unknown[] };
      if (!toefl.events.some((e) => e.id === 'ticket' && e.isTask)) throw new Error('托福缺少准考证节点');
      if (!jlpt.events.some((e) => e.id === 'register-pay')) throw new Error('JLPT 缺少报名缴费节点');
      if (!topik.events.some((e) => e.id === 'register-info')) throw new Error('TOPIK 缺少注册节点');
      if (toefl.fees.length === 0 || jlpt.fees.length === 0 || topik.fees.length === 0) {
        throw new Error('费用说明为空');
      }
      return `托福 ${toefl.events.length} 节点 / JLPT ${jlpt.events.length} 节点 / TOPIK ${topik.events.length} 节点 ${topik.fees.length} 项费用`;
    },
  },
  {
    name: 'GET /api/settings（模型服务商预设）',
    run: async () => {
      const data = (await getJson('/api/settings')) as {
        llm: { configured: boolean; providers: Array<{ id: string; baseUrl: string; models: Array<{ id: string; free?: boolean }> }> };
      };
      const ids = data.llm.providers.map((provider) => provider.id);
      for (const need of ['zhipu', 'hunyuan', 'modelscope']) {
        if (!ids.includes(need)) throw new Error(`缺少服务商预设：${need}`);
      }
      const zhipu = data.llm.providers.find((provider) => provider.id === 'zhipu')!;
      if (zhipu.baseUrl !== 'https://open.bigmodel.cn/api/paas/v4') throw new Error('智谱 Base URL 不对');
      if (!zhipu.models.some((model) => model.free)) throw new Error('智谱没有标出免费模型');
      const hunyuan = providerById('hunyuan');
      const scope = providerById('modelscope');
      if (!hunyuan || !scope) throw new Error('预设缺失');
      if (hunyuan.jsonMode || scope.jsonMode) throw new Error('混元/魔搭应关闭 JSON 模式');
      if (!providerById('zhipu')?.jsonMode) throw new Error('智谱应开启 JSON 模式');
      return `${ids.length} 个预设 · 免费档 ${['zhipu', 'hunyuan', 'modelscope'].join('/')} · JSON 模式按平台区分`;
    },
  },
  {
    name: 'GET /api/settings（Key 池 · 加密存储 · 只回掩码）',
    run: async () => {
      const data = (await getJson('/api/settings')) as {
        llm: {
          summary: { total: number; ready: number };
          storage: { encrypted: boolean; algorithm: string; masterKeySource: string };
          keys: Array<Record<string, unknown>>;
          apiKeyMasked: string;
        };
      };
      const { llm } = data;
      if (!llm.storage.encrypted || llm.storage.algorithm !== 'AES-256-GCM') {
        throw new Error('没有声明加密存储');
      }
      if (!Array.isArray(llm.keys)) throw new Error('缺少号池列表');
      if (llm.summary.ready > llm.summary.total) throw new Error('可用数大于总数');
      for (const key of llm.keys) {
        if ('apiKey' in key || 'keyCipher' in key) throw new Error('接口回传了 Key 字段');
        const masked = String(key.maskedKey ?? '');
        if (masked && !masked.includes('••••')) throw new Error(`掩码格式异常：${masked}`);
      }
      const raw = JSON.stringify(data);
      if (/\bsk-[A-Za-z0-9._-]{12,}/.test(raw)) throw new Error('响应里出现了疑似明文 Key');
      return `${llm.summary.total} 条线路 · 可用 ${llm.summary.ready} · ${llm.storage.algorithm} · 主密钥 ${llm.storage.masterKeySource}`;
    },
  },
  {
    name: 'GET /api/ai/stats（AI 加练用量统计）',
    run: async () => {
      const data = (await getJson('/api/ai/stats')) as {
        today: { runs: number; tokens: number };
        total: { runs: number; tokens: number; items: number };
        ready: boolean;
        activeModel: string;
      };
      if (data.total.items < 0) throw new Error('统计为负');
      return `今日 ${data.today.runs} 次 / ${data.today.tokens} tokens · 题库 ${data.total.items} 条 · 模型${
        data.ready ? `已配置（${data.activeModel}）` : '未配置'
      }`;
    },
  },
  {
    name: 'GET /api/ai/bank（AI 题库按语种隔离）',
    run: async () => {
      const ja = (await getJson('/api/ai/bank?language=ja')) as { items: Array<{ id: string; language: string }> };
      const ko = (await getJson('/api/ai/bank?language=ko')) as { items: Array<{ id: string; language: string }> };
      if (ja.items.some((item) => item.language !== 'ja')) throw new Error('语种串了');
      if (ko.items.some((item) => item.language !== 'ko')) throw new Error('语种串了');
      return `日语 ${ja.items.length} 条 / 韩语 ${ko.items.length} 条，互不污染`;
    },
  },
  {
    name: '教材正文去推广词（沪江 / 网址 / 版权声明）',
    run: async () => {
      const raw = [
        '第1章 練習',
        '沪江日语 Class.YesHJ.com',
        'この章では基礎を学びます。毎日少しずつ練習してください。',
        'PDF 文件使用 "pdfFactory Pro" 试用版本创建   www.fineprint.com.cn',
        '沪江网校内部资料，转载请注明出处。Class.YesHJ.com 2',
        '詳しくは https://www.hujiang.com/riyu/ を参照。',
      ].join('\n');
      const clean = stripPromo(raw);
      const leftovers = /沪江|yeshj|hujiang|pdfFactory|https?:|www\.|转载请注明/i.exec(clean);
      if (leftovers) throw new Error(`仍有残留：${leftovers[0]}`);
      if (!clean.includes('この章では基礎を学びます')) throw new Error('正文被误删');
      if (!clean.includes('詳しくは')) throw new Error('含链接的正文被整行删掉');
      return '推广词与链接已清除，正文完整';
    },
  },
  {
    name: 'GET /api/vocab（词汇按语种隔离）',
    run: async () => {
      const en = (await getJson('/api/vocab?language=en&limit=300')) as {
        words: Array<{ language: string; term: string }>;
      };
      const ja = (await getJson('/api/vocab?language=ja&limit=300')) as {
        words: Array<{ language: string; term: string }>;
      };
      const ko = (await getJson('/api/vocab?language=ko&limit=300')) as {
        words: Array<{ language: string; term: string }>;
      };
      const mixed =
        en.words.some((w) => w.language !== 'en') ||
        ja.words.some((w) => w.language !== 'ja') ||
        ko.words.some((w) => w.language !== 'ko');
      if (mixed) throw new Error('出现跨语种词条');
      return `英语册 ${en.words.length} / 日语册 ${ja.words.length} / 韩语册 ${ko.words.length}，无串册`;
    },
  },
];

async function main(): Promise<void> {
  console.log(`自检目标：${BASE}\n`);
  let failed = 0;
  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`  ✓ ${check.name} — ${detail}`);
    } catch (err) {
      failed += 1;
      console.log(`  ✗ ${check.name} — ${(err as Error).message}`);
    }
  }
  console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 项失败，请确认服务已启动。`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();

import type { GeneratedDay, PlanRecord, Task } from '../domain/types';
import { ensureDayContent } from './content';
import {
  isStretchWord,
  lexLevelName,
  LEX_SOURCE,
  pickLexEntries,
  type LexEntry,
  type LexLanguage,
} from '../content/lexicon';
import { findByTerms, listWords, upsertWords } from '../repositories/vocab';
import { currentUserId } from '../auth/requestScope';
import { buildAdminDetail, type AdminPayload } from './examTasks';
import {
  buildMaterialArticle,
  materialContextFor,
  materialEntries,
  materialSentences,
  materialSourceLabel,
  vocabPackEntries,
} from './materialContent';

export interface TaskWord {
  /** 词汇本里的记录 id；未入库时为 null（日语兜底词等） */
  id: string | null;
  term: string;
  ipa: string | null;
  reading: string | null;
  pos: string | null;
  cn: string;
  mnemonic: string;
  example: string | null;
  exampleCn: string | null;
  syn: string[];
  theme: string;
  tier: 'basic' | 'core' | 'advanced' | null;
  /** 分级词库级别：英语 basic/core/advanced，日语 n3/n2/n1 */
  level: string | null;
  levelName: string | null;
  /** 日语计划里出现的下一级别词（进阶词），界面上会单独标注 */
  stretch: boolean;
}

export type TaskDetail =
  | {
      kind: 'vocab';
      payload: {
        words: TaskWord[];
        source: string;
        levelName: string;
        targetLabel: string;
        tierNote: string;
      };
    }
  | {
      kind: 'reading';
      payload: {
        mode: 'read' | 'listen' | 'speak';
        article: Awaited<ReturnType<typeof ensureDayContent>>['articles'][number];
        secondary: Awaited<ReturnType<typeof ensureDayContent>>['articles'][number] | null;
        notice: string | null;
      };
    }
  | {
      kind: 'grammar';
      payload: {
        sentences: Array<{ text: string; translation: string | null; tips: string[] }>;
        note: string;
      };
    }
  | { kind: 'practice'; payload: { path: string; note: string } }
  | {
      kind: 'review';
      payload: {
        tasks: Task[];
        theme: string;
        focus: string[];
        advice: string[];
      };
    }
  | { kind: 'admin'; payload: AdminPayload }


export interface TaskDetailResponse {
  date: string;
  task: Task;
  day: GeneratedDay;
  plan: {
    language: PlanRecord['language'];
    examId: string;
    examName: string;
    targetLabel: string;
    targetScore: number;
    currentLevelName: string;
  };
  detail: TaskDetail;
}

const JA_LEVEL_NOTE: Record<string, string> = {
  n5: 'N5 基础词起步，先把日常动词与助词搭配打牢。',
  n4: 'N4 巩固词为主，逐步引入 N3 词，先把动词活用练熟。',
  n3: '以 N3 核心词为主，每批混入约三成 N2 进阶词——N3 到 N2 的落差主要就压在这批词上。',
  n2: 'N2 高频词打底，穿插 N1 拉分词，为读社论和公文提前铺路。',
  n1: 'N1 拉分词为主，重点在抽象评论与公文里的固定搭配。',
};

const KO_LEVEL_NOTE: Record<string, string> = {
  ko0: '先从 1 级生存词起步：한글 字母 + 最常用的动词名词，每天开口读。',
  ko1: '1 级生存词为主，混入少量 2 级词，先把问候与购物场景打熟。',
  ko2: '2 级生活事务词打底，穿插 3 级进阶词，为 TOPIK II 提前铺路。',
  ko3: '以 3 级核心词为主，每批混入约三成 4 级词——3 到 4 级的差距主要压在这批词上。',
  ko4: '4 级高频词为主，穿插 5 级新闻词，为读社论与公文铺路。',
  ko5: '5 级进阶词为主，混入 6 级拉分词，重点是社论里的抽象名词与正式表达。',
  ko6: '6 级拉分词为主，重点在评论与学术文章的书面搭配。',
};

const TIER_NOTE: Record<string, string> = {
  hs: '当前按「高中 → 托福」的过渡词起步，先把四级之后的高频词清掉。',
  cet4: '四级到托福 100 的差距主要在学术高频词，今天这批以"过渡词 + 核心词"混排。',
  cet6: '六级底子已够，直接上托福阅读/听力高频核心词。',
  cet6plus: '基础较稳，核心词与拉分词各半，为写作和讲座听力储备替换表达。',
  tem4: '接近目标分，重点补冲 100 的拉分词与学术论证词。',
};

function wordCountForTask(minutes: number): number {
  return Math.max(8, Math.min(16, Math.round(minutes / 3)));
}

function toTaskWord(
  entry: LexEntry,
  id: string | null,
  language: LexLanguage,
  planLevelId: string,
): TaskWord {
  return {
    id,
    term: entry.term,
    ipa: language === 'en' ? entry.reading : null,
    reading: language === 'en' ? null : entry.reading,
    pos: entry.pos,
    cn: entry.cn,
    mnemonic: entry.mnemonic,
    example: entry.example,
    exampleCn: entry.exampleCn,
    syn: entry.syn,
    theme: entry.theme,
    tier: language === 'en' ? (entry.level as TaskWord['tier']) : null,
    level: entry.level,
    levelName: lexLevelName(language, entry.level),
    stretch: isStretchWord(language, planLevelId, entry.level),
  };
}

/**
 * 词汇任务：按「当前级别 + 目标」从对应语种的分级词库里取词。
 * 英语取托福词库（basic/core/advanced），日语取 JLPT 词库（n3/n2/n1），
 * 两者共用同一套写库逻辑，但 language 不同、词表不同，互不污染。
 */
function buildVocab(plan: PlanRecord, day: GeneratedDay, task: Task): TaskDetail {
  const language: LexLanguage = plan.language;
  const count = wordCountForTask(task.minutes);
  const known = new Set(
    listWords(currentUserId(), language, { limit: 500 }).map((word) => word.term),
  );
  // 启用「我的教材」时优先背教材里这一章出现的词，不足再用考纲词补齐
  const materialCtx = materialContextFor(plan, day);
  const fromMaterial = materialCtx ? materialEntries(materialCtx, known, count) : [];
  const afterBook = new Set([...known, ...fromMaterial.map((entry) => entry.term)]);
  // 再取词表包（kind = vocab）：只进词汇任务，最多占四成，剩下的留给考纲词
  const packQuota = Math.max(0, Math.min(count - fromMaterial.length, Math.round(count * 0.4)));
  const packs = vocabPackEntries({
    plan,
    date: day.date,
    exclude: afterBook,
    count: packQuota,
  });
  const remaining = Math.max(0, count - fromMaterial.length - packs.entries.length);
  const picked = [
    ...fromMaterial,
    ...packs.entries,
    ...pickLexEntries({
      language,
      levelId: plan.currentLevelId,
      targetScore: plan.targetScore,
      seed: `${day.date}-${task.id}`,
      count: remaining,
      exclude: new Set([
        ...afterBook,
        ...packs.entries.map((entry) => entry.term),
      ]),
    }),
  ];

  upsertWords(
    currentUserId(),
    language,
    picked.map((entry) => ({
      term: entry.term,
      reading: entry.reading ?? undefined,
      pos: entry.pos,
      meaning: entry.cn,
      example: entry.example,
      exampleCn: entry.exampleCn,
      mnemonic: entry.mnemonic,
      theme: entry.theme,
      level: entry.level,
      syn: entry.syn,
    })),
    materialCtx && fromMaterial.length > 0
      ? `教材《${materialCtx.material.title}》`.slice(0, 40)
      : packs.entries.length > 0
        ? `词表《${packs.packs[0]}》`.slice(0, 40)
        : language === 'ja' ? 'ja-lexicon' : language === 'ko' ? 'ko-lexicon' : 'toefl-lexicon',
  );

  const records = findByTerms(
    currentUserId(),
    language,
    picked.map((entry) => entry.term),
  );
  const idByTerm = new Map(records.map((record) => [record.term, record.id]));

  const fromBook = materialCtx && fromMaterial.length > 0 ? materialSourceLabel(materialCtx) : '';
  const fromPack = packs.entries.length > 0 ? `词表《${packs.packs.join('、')}》` : '';
  const sourceLabel = [fromBook, fromPack].filter(Boolean).join(' + ');

  return {
    kind: 'vocab',
    payload: {
      words: picked.map((entry) =>
        toTaskWord(entry, idByTerm.get(entry.term) ?? null, language, plan.currentLevelId),
      ),
      source: sourceLabel
        ? `${sourceLabel} · 教材/资料词 ${fromMaterial.length + packs.entries.length} 个，考纲词补 ${remaining} 个`
        : LEX_SOURCE[language],
      levelName: plan.currentLevelName,
      targetLabel: plan.targetLabel,
      tierNote:
        fromMaterial.length > 0 || packs.entries.length > 0
          ? `今日生词优先取自你的教材与词表：${
              materialCtx && fromMaterial.length > 0 ? materialCtx.levelName : ''
            }${
              packs.entries.length > 0 ? `${materialCtx && fromMaterial.length > 0 ? ' · ' : ''}词表包按目标级别出词` : ''
            }；词义已随资料入库，不足部分由考纲词补齐。`
          : language === 'ja'
          ? JA_LEVEL_NOTE[plan.currentLevelId] ?? JA_LEVEL_NOTE.n3
          : language === 'ko'
            ? KO_LEVEL_NOTE[plan.currentLevelId] ?? KO_LEVEL_NOTE.ko1
            : TIER_NOTE[plan.currentLevelId] ?? TIER_NOTE.cet4,
    },
  };
}

export async function buildTaskDetail(
  plan: PlanRecord,
  day: GeneratedDay,
  task: Task,
): Promise<TaskDetailResponse> {
  const base = {
    date: day.date,
    task,
    day,
    plan: {
      language: plan.language,
      examId: plan.examId,
      examName: plan.examName,
      targetLabel: plan.targetLabel,
      targetScore: plan.targetScore,
      currentLevelName: plan.currentLevelName,
    },
  };

  switch (task.kind) {
    case 'vocab': {
      return { ...base, detail: buildVocab(plan, day, task) };
    }

    case 'admin': {
      const payload: AdminPayload = buildAdminDetail(plan, task);
      return { ...base, detail: { kind: 'admin' as const, payload } };
    }

    case 'read':
    case 'listen':
    case 'speak': {
      const ctx = materialContextFor(plan, day);
      if (ctx) {
        const built = buildMaterialArticle({
          ctx,
          language: plan.language,
          mode: task.kind === 'speak' ? 'speak' : task.kind === 'listen' ? 'listen' : 'read',
        });
        return {
          ...base,
          detail: {
            kind: 'reading',
            payload: {
              mode: task.kind === 'speak' ? 'speak' : task.kind === 'listen' ? 'listen' : 'read',
              article: built.article,
              secondary: null,
              notice: built.notice,
            },
          },
        };
      }

      const content = await ensureDayContent(plan, day);
      const intensive =
        content.articles.find((item) => item.kind === 'intensive') ?? content.articles[0] ?? null;
      const extensive = content.articles.find((item) => item.kind === 'extensive') ?? null;
      if (!intensive) throw new Error('今日文章尚未生成');
      return {
        ...base,
        detail: {
          kind: 'reading',
          payload: {
            mode: task.kind === 'speak' ? 'speak' : task.kind === 'listen' ? 'listen' : 'read',
            article: task.kind === 'listen' && extensive ? extensive : intensive,
            secondary: task.kind === 'listen' && extensive ? intensive : null,
            notice: content.notice,
          },
        },
      };
    }

    case 'grammar': {
      const ctx = materialContextFor(plan, day);
      if (ctx) {
        return {
          ...base,
          detail: {
            kind: 'grammar',
            payload: {
              sentences: materialSentences(ctx, plan.language).map((text) => ({
                text,
                translation: null,
                tips: [] as string[],
              })),
              note: `句子取自${materialSourceLabel(ctx)}，先划主干再回译；译文可以在原书对照段落里找。`,
            },
          },
        };
      }

      const content = await ensureDayContent(plan, day);
      const intensive = content.articles.find((item) => item.kind === 'intensive');
      const segments = (intensive?.readingScript.segments ?? []).slice(0, 6);
      return {
        ...base,
        detail: {
          kind: 'grammar',
          payload: {
            sentences: segments.map((segment) => ({
              text: segment.text,
              translation: segment.translation ?? null,
              tips: segment.tips ?? [],
            })),
            note: '先自己划主干（谁 + 做了什么），再对照译文；最后遮住英文做回译。',
          },
        },
      };
    }

    case 'write':
      return {
        ...base,
        detail: {
          kind: 'practice',
          payload: {
            path: `/practice/${day.date}/${task.id}`,
            note: '写作任务需要提交后自动批改，正在带你进入写作页。',
          },
        },
      };

    default:
      return {
        ...base,
        detail: {
          kind: 'review',
          payload: {
            tasks: day.tasks,
            theme: day.theme,
            focus: day.focus,
            advice: [
              '先把今天没做完的项圈出来，判断是"没时间"还是"不会做"——前者挪到明天前半段，后者单独记下来。',
              '把今天批改过的错句复述一遍，只复述错的那一句，不要整段重写。',
              '明天的第一件事：打开词汇本，把今天到期的词先过一遍再开始新内容。',
            ],
          },
        },
      };
  }
}

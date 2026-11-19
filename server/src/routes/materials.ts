import express, { Router } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { logger } from '../lib/logger';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { requireLanguage } from '../domain/language';
import {
  activeMaterialId,
  deleteMaterial,
  getMaterial,
  listMaterialWords,
  listMaterials,
  listUnits,
  saveMaterial,
  setActiveMaterial,
  updateMaterialWordMeanings,
} from '../repositories/materials';
import {
  cleanMaterialTitle,
  detectMaterialKind,
  detectMaterialLevel,
  extractDocument,
  extractWords,
  splitIntoUnits,
} from '../services/materialParse';
import { chatJson, resolveLlmConfig } from '../services/llm';

export const materialsRouter = Router();

const ALLOWED = new Set(['.pdf', '.epub', '.docx', '.txt', '.md', '.html', '.htm']);
const MAX_BYTES = 120 * 1024 * 1024;

const decodeName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** 上传并解析：请求体是文件原始字节，文件名/语种走 query，避免额外引入 multipart 依赖 */
materialsRouter.post(
  '/materials',
  express.raw({ type: () => true, limit: MAX_BYTES }),
  asyncHandler(async (req, res) => {
    const language = requireLanguage(req.query.language);
    const fileName = decodeName(req.query.name);
    if (!fileName) throw new ValidationError('缺少文件名（query.name）');
    const ext = path.extname(fileName).toLowerCase();
    if (!ALLOWED.has(ext)) {
      throw new ValidationError(`暂不支持 ${ext || '该'} 格式，请上传 PDF / EPUB / DOCX / TXT / MD`);
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new ValidationError('没有收到文件内容');
    if (body.length > MAX_BYTES) throw new ValidationError('文件超过 120MB 上限');

    const doc = await extractDocument(body, fileName);
    const units = splitIntoUnits(doc);
    if (units.length === 0) throw new ValidationError('没能从文件里解析出正文，可能是扫描版 PDF（需要先做 OCR）');

    const words = extractWords(units, language);
    const title =
      decodeName(req.query.title).trim() ||
      cleanMaterialTitle(fileName) ||
      '未命名教材';
    const level =
      decodeName(req.query.level).trim() || detectMaterialLevel(fileName, language);
    const kindQuery = decodeName(req.query.kind).trim();
    const kind =
      kindQuery === 'vocab' || kindQuery === 'notes' || kindQuery === 'textbook'
        ? kindQuery
        : detectMaterialKind(fileName);

    const material = saveMaterial({
      language,
      title,
      format: doc.format,
      fileName,
      fileSize: body.length,
      charCount: doc.text.length,
      level: level || null,
      kind,
      origin: 'upload',
      units,
      words,
    });

    // 未分级的教科书才需要「手动启用」；分级教材按计划进度自动接入，词表与资料不占教材位
    if (!activeMaterialId(language) && material.kind === 'textbook' && !material.level) {
      setActiveMaterial(language, material.id);
    }

    res.status(201).json({
      material,
      active: activeMaterialId(language) === material.id,
      preview: {
        units: units.slice(0, 5).map((unit) => ({
          idx: unit.idx,
          title: unit.title,
          charCount: unit.charCount,
          pageFrom: unit.pageFrom,
        })),
        words: words.slice(0, 12).map((word) => ({
          term: word.term,
          reading: word.reading,
          meaning: word.meaning,
          unitIdx: word.unitIdx,
        })),
        inLexicon: words.filter((word) => word.inLexicon).length,
      },
    });
  }),
);

materialsRouter.get(
  '/materials',
  asyncHandler(async (req, res) => {
    const language = typeof req.query.language === 'string' ? requireLanguage(req.query.language) : undefined;
    const materials = listMaterials(language);
    res.json({
      materials: materials.map((material) => ({
        ...material,
        active: activeMaterialId(material.language) === material.id,
      })),
      activeId: language ? activeMaterialId(language) : null,
    });
  }),
);

materialsRouter.get(
  '/materials/:id',
  asyncHandler(async (req, res) => {
    const material = getMaterial(req.params.id);
    if (!material) throw new NotFoundError('教材不存在');
    const units = listUnits(material.id);
    const words = listMaterialWords(material.id, { limit: 20 });
    res.json({
      material,
      active: activeMaterialId(material.language) === material.id,
      units: units.map((unit) => ({
        idx: unit.idx,
        title: unit.title,
        charCount: unit.charCount,
        pageFrom: unit.pageFrom,
        pageTo: unit.pageTo,
      })),
      words: words.map((word) => ({
        term: word.term,
        reading: word.reading,
        meaning: word.meaning,
        unitIdx: word.unitIdx,
        freq: word.freq,
      })),
    });
  }),
);

const ActivateInput = z.object({ active: z.boolean() });

materialsRouter.post(
  '/materials/:id/activate',
  asyncHandler(async (req, res) => {
    const material = getMaterial(req.params.id);
    if (!material) throw new NotFoundError('教材不存在');
    const { active } = ActivateInput.parse(req.body ?? {});
    setActiveMaterial(material.language, active ? material.id : null);
    res.json({ ok: true, active });
  }),
);

materialsRouter.delete(
  '/materials/:id',
  asyncHandler(async (req, res) => {
    const material = getMaterial(req.params.id);
    if (!material) throw new NotFoundError('教材不存在');
    deleteMaterial(material.id);
    res.json({ ok: true });
  }),
);

const EnrichInput = z.object({ limit: z.number().int().min(1).max(80).optional() });

const EnrichItem = z.object({
  term: z.string().min(1),
  meaning: z.string().min(1),
  pos: z.string().optional().default(''),
  reading: z.string().optional().default(''),
});

/**
 * 宽容的数组解析：模型经常把数组包成 {"items":[...]}、甚至按「词 → 释义」的对象返回，
 * 这里把三种形态都摊平成数组、按常见别名归位字段，避免为一次格式问题重写一遍、白烧 token。
 */
const pickText = (record: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const lenientArray = {
  safeParse(value: unknown) {
    let list: unknown[] = [];
    if (Array.isArray(value)) {
      list = value;
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const nested = Object.values(record).find((item) => Array.isArray(item)) as unknown[] | undefined;
      list =
        nested ??
        Object.entries(record).map(([key, item]) =>
          item && typeof item === 'object' ? { term: key, ...(item as Record<string, unknown>) } : item,
        );
    }

    const parsed: z.infer<typeof EnrichItem>[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const candidate = EnrichItem.safeParse({
        term: pickText(record, ['term', 'word', 'headword', '原词']),
        meaning: pickText(record, ['meaning', 'zh', 'cn', 'definition', 'translation', '释义']),
        pos: pickText(record, ['pos', 'partOfSpeech', 'type']),
        reading: pickText(record, ['reading', 'ipa', 'phonetic', 'kana']),
      });
      if (candidate.success) parsed.push(candidate.data);
    }
    return { success: parsed.length > 0, data: parsed, error: { issues: [] } };
  },
};

/** 用大模型给「词库未收录」的教材生词补释义（未配置模型时给出明确提示） */
materialsRouter.post(
  '/materials/:id/enrich',
  asyncHandler(async (req, res) => {
    const material = getMaterial(req.params.id);
    if (!material) throw new NotFoundError('教材不存在');
    const { limit = 40 } = EnrichInput.parse(req.body ?? {});
    const { config } = resolveLlmConfig();
    if (!config) {
      throw new ConflictError('尚未配置大模型，暂时无法自动补释义；可在「设置 → 模型服务」配置后重试。');
    }

    const pending = listMaterialWords(material.id, { limit: 2000 }).filter((word) => !word.meaning).slice(0, limit);
    if (pending.length === 0) {
      res.json({ ok: true, updated: 0, message: '没有待补释义的词条' });
      return;
    }

    const language = material.language === 'ja' ? '日语' : material.language === 'ko' ? '韩语' : '英语';
    // 每批 30 个词：再多输出就会被 max_tokens 截断，反而白花一次调用
    const BATCH = 30;
    const allowed = new Map(pending.map((word) => [word.term.toLowerCase(), word.term]));
    const collected: Array<{ term: string; meaning: string; pos: string; reading: string }> = [];
    let failedBatch = 0;

    for (let offset = 0; offset < pending.length; offset += BATCH) {
      const batch = pending.slice(offset, offset + BATCH);
      const prompt = `你在为${language}学习者整理一本教材的生词表。
为下面每个词给出中文释义（简洁，最多 20 字）、词性（n./v./adj./副/名 等）、读音（英语给国际音标；日语给假名；韩语给罗马字）。
只输出一个 JSON 对象：{"items":[{"term":"原词","meaning":"…","pos":"…","reading":"…"}, ...]}
items 必须包含全部 ${batch.length} 个词、顺序与下面一致；不要 markdown 围栏、不要任何解释。

词表：
${batch.map((word, index) => `${index + 1}. ${word.term}`).join('\n')}`;

      try {
        const items = await chatJson(config, [{ role: 'user', content: prompt }], lenientArray, {
          temperature: 0.3,
          maxTokens: 3200,
          retries: 1,
        });
        // 只认清单里确实待补的词，且按小写归位——模型偶尔会自作主张多给或改写词形
        items.forEach((item) => {
          const term = allowed.get(item.term.trim().toLowerCase());
          if (term) collected.push({ ...item, term });
        });
      } catch (err) {
        // 单批失败不拖垮整轮：已拿到的结果照样入库，剩下的下次补
        failedBatch += 1;
        logger.warn('material enrich batch failed', {
          materialId: material.id,
          offset,
          message: (err as Error).message,
        });
      }
    }

    if (collected.length === 0) {
      throw new ConflictError('这一轮没能拿到可用释义，请稍后重试或换一条模型线路。');
    }

    const updated = updateMaterialWordMeanings(material.id, collected);
    res.json({
      ok: true,
      updated,
      failed: failedBatch,
      message: failedBatch > 0
        ? `已补全 ${updated} 个词条释义（有 ${failedBatch} 批未成功，可再点一次继续补）`
        : `已补全 ${updated} 个词条释义`,
    });
  }),
);

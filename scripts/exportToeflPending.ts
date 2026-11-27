/**
 * 导出待补精讲的托福分级词，按批切分成清单文件，供逐批撰写。
 *
 *   tsx scripts/exportToeflPending.ts --out /tmp/wy-enhance --size 50
 *
 * 每个 manifest-<NNN>.json 含 { batch, words:[{code,term,pos,ipa,theme,forms,relations,band}] }，
 * 写手按同一批次号把成果写回 server/src/content/toefl-enhanced/batch-<NNN>.json。
 * 只导出尚未有精讲内容的词：分级表里、且不在 toeflLexicon.ts 精讲词中的词。
 */
import fs from 'node:fs';
import path from 'node:path';
import { GRADED_WORDS } from '../server/src/content/toeflGraded';
import { TOEFL_WORDS } from '../server/src/content/toeflLexicon';
import { enhancedCodes } from '../server/src/content/toeflEnhanced';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = arg('out') ?? '/tmp/wy-enhance';
const size = Number(arg('size') ?? '50');
if (!Number.isInteger(size) || size <= 0) throw new Error('--size 必须是正整数');

const detailed = new Set(TOEFL_WORDS.map((word) => word.term.toLowerCase()));
const done = enhancedCodes();
const pending = GRADED_WORDS().filter(
  (word) => !detailed.has(word.term.toLowerCase()) && !done.has(word.code),
);

fs.mkdirSync(out, { recursive: true });
const batches: string[] = [];
for (let start = 0, batch = 1; start < pending.length; start += size, batch += 1) {
  const slice = pending.slice(start, start + size);
  const name = `manifest-${String(batch).padStart(3, '0')}.json`;
  fs.writeFileSync(
    path.join(out, name),
    JSON.stringify(
      {
        batch,
        range: `${slice[0].code}–${slice[slice.length - 1].code}`,
        words: slice.map((w) => ({
          code: w.code,
          term: w.term,
          pos: w.pos,
          ipa: w.ipa,
          theme: w.theme,
          forms: w.forms,
          relations: w.relations,
          band: w.band,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  batches.push(name);
}

console.log(
  JSON.stringify(
    { out, pending: pending.length, alreadyEnhanced: done.size, batchSize: size, batches },
    null,
    2,
  ),
);

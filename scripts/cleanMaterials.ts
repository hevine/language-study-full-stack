/**
 * 把已经入库的教材/资料再洗一遍：删掉「沪江网校」「Class.YesHJ.com」这类推广词、
 * 页脚水印、公众号与裸链接，避免它们出现在每日计划里。
 *
 *   npm run clean:materials            # 只报告会改哪些，不落库
 *   npm run clean:materials -- --write # 真正写回数据库
 *
 * 解析链路已经在入库时清洗（services/sanitize.ts），这个脚本只处理「清洗之前」
 * 就已经进库的老数据，洗完再跑一次不会有任何变化（幂等）。
 */
import { closeDb, runMigrations } from '../server/src/db';
import { db } from '../server/src/db';
import { hasPromo, stripPromo, stripPromoTitle } from '../server/src/services/sanitize';

const write = process.argv.includes('--write');
const verbose = process.argv.includes('--verbose');

interface UnitRow {
  id: string;
  material_id: string;
  idx: number;
  title: string;
  body: string;
  char_count: number;
}

interface WordRow {
  id: string;
  term: string;
  reading: string | null;
  pos: string | null;
  meaning: string | null;
  example: string | null;
}

interface MaterialRow {
  id: string;
  title: string;
  note: string | null;
}

runMigrations();

const materials = db.prepare('SELECT id, title, note FROM materials').all() as MaterialRow[];
const units = db.prepare('SELECT id, material_id, idx, title, body, char_count FROM material_units').all() as UnitRow[];
const words = db
  .prepare('SELECT id, term, reading, pos, meaning, example FROM material_words')
  .all() as WordRow[];

const titleById = new Map(materials.map((row) => [row.id, row.title]));

const dirtyUnits = units.filter((unit) => hasPromo(unit.body) || hasPromo(unit.title));
const dirtyWords = words.filter(
  (word) => hasPromo(word.term) || hasPromo(word.reading ?? '') || hasPromo(word.meaning ?? '') || hasPromo(word.example ?? ''),
);
const dirtyMaterials = materials.filter((row) => hasPromo(row.title) || hasPromo(row.note ?? ''));

console.log(`扫描：${materials.length} 本教材 · ${units.length} 个章节 · ${words.length} 个词条`);
console.log(`命中推广内容：${dirtyMaterials.length} 本标题 / ${dirtyUnits.length} 个章节 / ${dirtyWords.length} 个词条`);

const samples = dirtyUnits.slice(0, 3);
const PROMO_HINT = /沪江|yeshj|hujiang|pdfFactory|fineprint|https?:\/\/|www\.|转载请注明|内部资料/i;
for (const unit of samples) {
  const before = unit.body;
  const after = stripPromo(before);
  console.log(`\n—— 《${titleById.get(unit.material_id) ?? '?'}》第 ${unit.idx + 1} 章：${before.length} → ${after.length} 字`);
  const removed = before
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && PROMO_HINT.test(line))
    .slice(0, 4);
  for (const line of removed) console.log(`   - ${line.slice(0, 80)}`);
}

if (verbose) {
  for (const word of dirtyWords.slice(0, 10)) {
    console.log(`   词条 ${word.term} | ${word.meaning ?? ''} | ${(word.example ?? '').slice(0, 40)}`);
  }
}

if (!write) {
  console.log('\n（预演模式，未写入。加 --write 真正落库）');
  closeDb();
  process.exit(0);
}

const updateUnit = db.prepare('UPDATE material_units SET body = ?, title = ?, char_count = ? WHERE id = ?');
const updateWord = db.prepare(
  'UPDATE material_words SET term = ?, reading = ?, pos = ?, meaning = ?, example = ? WHERE id = ?',
);
const updateMaterial = db.prepare('UPDATE materials SET title = ?, note = ? WHERE id = ?');

let changedUnits = 0;
let changedWords = 0;
let changedMaterials = 0;

db.transaction(() => {
  for (const unit of dirtyUnits) {
    const body = stripPromo(unit.body);
    const title = stripPromoTitle(unit.title);
    if (body === unit.body && title === unit.title) continue;
    updateUnit.run(body, title, body.length, unit.id);
    changedUnits += 1;
  }
  for (const word of dirtyWords) {
    const term = stripPromo(word.term);
    const reading = word.reading ? stripPromo(word.reading) : word.reading;
    const pos = word.pos ? stripPromo(word.pos) : word.pos;
    const meaning = word.meaning ? stripPromo(word.meaning) : word.meaning;
    const example = word.example ? stripPromo(word.example) : word.example;
    if (
      term === word.term &&
      reading === word.reading &&
      pos === word.pos &&
      meaning === word.meaning &&
      example === word.example
    ) {
      continue;
    }
    updateWord.run(term, reading, pos, meaning, example, word.id);
    changedWords += 1;
  }
  for (const row of dirtyMaterials) {
    const title = stripPromoTitle(row.title);
    const note = row.note ? stripPromo(row.note) : row.note;
    if (title === row.title && note === row.note) continue;
    updateMaterial.run(title, note, row.id);
    changedMaterials += 1;
  }
})();

console.log(`\n已写回：${changedMaterials} 本教材标题 / ${changedUnits} 个章节 / ${changedWords} 个词条`);

// 洗完再扫一遍，确认没有残留
const leftovers = (
  db.prepare('SELECT count(*) AS c FROM material_units WHERE body LIKE ? OR body LIKE ? OR body LIKE ?').get(
    '%沪江%',
    '%YesHJ%',
    '%http%',
  ) as { c: number }
).c;
const leftoverNotes = (
  db.prepare("SELECT count(*) AS c FROM material_units WHERE body LIKE '%www.%' OR body LIKE '%转载请注明%'").get() as {
    c: number;
  }
).c;
console.log(`残留检查：沪江/YesHJ/http ${leftovers} 条，www./转载请注明 ${leftoverNotes} 条`);

closeDb();

/**
 * 托福精讲增强层质检：字段完整、编码合法、例句确实用到该词、中文释义/记忆法有实质内容。
 *   tsx scripts/checkToeflEnhanced.ts
 */
import { GRADED_WORDS } from '../server/src/content/toeflGraded';
import { enhancedCodes, enhancedOf } from '../server/src/content/toeflEnhanced';

const graded = new Map(GRADED_WORDS().map((word) => [word.code, word]));
const codes = [...enhancedCodes()].sort();
const problems: string[] = [];

/** 从 term / forms 提取英文词形（含屈折），用于判断例句是否用到该词 */
function wordForms(code: string): string[] {
  const word = graded.get(code);
  if (!word) return [];
  const raw = `${word.term} ${word.forms}`;
  const found = raw.match(/[a-zA-Z]{3,}/g) ?? [];
  return [...new Set(found.map((w) => w.toLowerCase()))];
}

for (const code of codes) {
  const entry = enhancedOf(code);
  const word = graded.get(code);
  if (!entry || !word) {
    problems.push(`${code} 加载失败`);
    continue;
  }
  if (entry.cn.length < 2) problems.push(`${code} ${word.term} 中文释义过短`);
  if (entry.mnemonic.length < 6) problems.push(`${code} ${word.term} 记忆法过短`);
  if (entry.exampleCn.length < 4) problems.push(`${code} ${word.term} 例句译文过短`);
  const lower = entry.example.toLowerCase();
  const forms = wordForms(code);
  if (!forms.some((form) => lower.includes(form))) {
    problems.push(`${code} ${word.term} 例句未用到该词：${entry.example}`);
  }
  if (!/[.!?]["']?$/.test(entry.example.trim())) {
    problems.push(`${code} ${word.term} 例句缺少句末标点`);
  }
}

const pending = [...graded.values()].filter(
  (word) => !enhancedCodes().has(word.code),
).length;

console.log(
  JSON.stringify(
    {
      enhanced: codes.length,
      gradedTotal: graded.size,
      remainingPending: pending,
      problems: problems.length,
      sample: problems.slice(0, 30),
    },
    null,
    2,
  ),
);
if (problems.length > 0) process.exitCode = 1;

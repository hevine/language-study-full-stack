/**
 * 把教研的《多语种语法点分级表》（.md 版）转成内置语法库的数据文件。
 *
 *   npm run import:grammar-table -- <表格.md>            解析 → 校验 → 覆盖内容文件
 *   npm run import:grammar-table -- <表格.md> --check    只解析和校验，不写文件
 *
 * 产出：server/src/content/grammar/{en,ja,ko}.json，每个语种一个文件，
 * 结构是「级别表 + 语法点 + 错因规则」。写之前用内容层同一份 schema 校验，
 * 不合格直接失败并指出是哪一条，不会写进去半份数据。
 *
 * 表格约定（与教研口径一致）：
 *   · 二级标题分语种，三级标题分级别（英语 T1/A2、日语 N5、韩语 TOPIK 1），末尾一段是错因规则；
 *   · 语法点 8 列：编码｜语法点｜接续｜释义｜类义｜例句（原文｜中译）｜错因规则编码｜考点备注；
 *   · 规则 3 列：编码｜规则名称｜触发：…｜表现：…｜判定：…；
 *   · 段内分隔用全角竖线 ｜（U+FF5C），不是半角 |。
 *
 * 级别 id 取该语种刻度本身：英语用 CEFR（T1/A2 → A2），日语用 N5–N1，韩语用 1–6；
 * 原始级别名（如「T1/A2」）保留在 label 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadGrammarLibraryFile } from '../server/src/content/grammar';
import type { GrammarLibrary, GrammarPoint, GrammarRule } from '../server/src/content/grammar';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const input = args.find((arg) => !arg.startsWith('--'));
if (!input) {
  console.error('用法：npm run import:grammar-table -- <表格.md> [--check]');
  process.exit(1);
}

const OUT_DIR = path.resolve(process.cwd(), 'server/src/content/grammar');
const SOURCE_LABEL = '多语种语法点分级表_英日韩 · 教研初版';

const SECTION_RE = /^## (英语|日语|韩语)（[^）]*）（\d+ 条）\s*$/;
const LEVEL_RE = /^### (.+?)（(\d+) 条）\s*$/;
const RULES_RE = /^### (英语|日语|韩语)错因规则（(\d+) 条）\s*$/;

const META: Record<'英语' | '日语' | '韩语', { language: GrammarLibrary['language']; examId: string }> = {
  英语: { language: 'en', examId: 'toefl' },
  日语: { language: 'ja', examId: 'jlpt' },
  韩语: { language: 'ko', examId: 'topik' },
};

/** 「T1/A2」→ A2；「N5」→ N5；「TOPIK 3」→ 3 */
function levelIdOf(language: GrammarLibrary['language'], label: string): string {
  if (language === 'en') {
    const cefr = label.split('/')[1];
    if (!cefr) throw new Error(`英语级别「${label}」写法不对，应形如 T1/A2`);
    return cefr.trim();
  }
  if (language === 'ja') return label.trim();
  const digits = label.replace(/^TOPIK\s*/i, '').trim();
  if (!/^[1-6]$/.test(digits)) throw new Error(`韩语级别「${label}」写法不对，应形如 TOPIK 3`);
  return digits;
}

function cells(line: string, expected: number, where: string): string[] {
  const parts = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
  if (parts.length !== expected) {
    throw new Error(`第 ${where} 行应有 ${expected} 列，实际 ${parts.length} 列：${line.slice(0, 60)}`);
  }
  return parts;
}

/** 规则正文三段：触发：…｜表现：…｜判定：…。提示词允许「触发条件 / 典型错误 / 纠错判定」的写法 */
function splitRule(text: string, where: string): Pick<GrammarRule, 'trigger' | 'symptom' | 'judgement'> {
  const parts = text.split('｜').map((part) => part.trim());
  const strip = (part: string, labels: string[]): string => {
    for (const label of labels) {
      if (part.startsWith(`${label}：`) || part.startsWith(`${label}:`)) return part.slice(label.length + 1).trim();
    }
    return '';
  };
  if (parts.length !== 3) throw new Error(`第 ${where} 行的错因规则应为三段（触发｜表现｜判定）：${text.slice(0, 40)}`);
  const rule = {
    trigger: strip(parts[0], ['触发条件', '触发']),
    symptom: strip(parts[1], ['典型错误', '表现']),
    judgement: strip(parts[2], ['纠错判定', '判定']),
  };
  if (!rule.trigger || !rule.symptom || !rule.judgement) {
    throw new Error(`第 ${where} 行的错因规则三段缺提示词：${text.slice(0, 40)}`);
  }
  return rule;
}

function parse(text: string): GrammarLibrary[] {
  const libraries: GrammarLibrary[] = [];
  let current: GrammarLibrary | null = null;
  let levelLabel = '';
  let inRules = false;
  let lineNumber = 0;

  for (const raw of text.split(/\r?\n/)) {
    lineNumber += 1;
    const line = raw.trimEnd();

    const section = SECTION_RE.exec(line);
    if (section) {
      const meta = META[section[1] as '英语' | '日语' | '韩语'];
      current = {
        language: meta.language,
        source: SOURCE_LABEL,
        examId: meta.examId,
        levels: [],
        points: [],
        rules: [],
      };
      libraries.push(current);
      levelLabel = '';
      inRules = false;
      continue;
    }

    const rulesHead = RULES_RE.exec(line);
    if (rulesHead) {
      const meta = META[rulesHead[1] as '英语' | '日语' | '韩语'];
      current = libraries.find((item) => item.language === meta.language) ?? null;
      if (!current) throw new Error(`第 ${lineNumber} 行：先出现「${rulesHead[1]}错因规则」，但没有对应的语种小节`);
      inRules = true;
      continue;
    }

    const level = LEVEL_RE.exec(line);
    if (level && current) {
      levelLabel = level[1].trim();
      inRules = false;
      const id = levelIdOf(current.language, levelLabel);
      if (current.levels.some((item) => item.label === levelLabel)) {
        throw new Error(`第 ${lineNumber} 行：级别「${levelLabel}」出现了两次`);
      }
      current.levels.push({ id, label: levelLabel });
      continue;
    }

    if (!/^\| (EN|JP|KR)-/.test(line) || !current) continue;
    const where = `${lineNumber}（${current.language}）`;

    if (inRules) {
      const [ref, name, text] = cells(line, 3, where);
      current.rules.push({ ref, name, ...splitRule(text, where) });
      continue;
    }
    if (!levelLabel) throw new Error(`第 ${lineNumber} 行：语法点出现在级别标题之前`);

    const [ref, name, structure, meaning, synonym, example, errorRule, note] = cells(line, 8, where);
    const [sentence, translation, ...rest] = example.split('｜').map((part) => part.trim());
    if (!sentence || rest.length > 0) {
      throw new Error(`第 ${lineNumber} 行的例句应为「原文｜中译」两段：${example.slice(0, 40)}`);
    }
    current.points.push({
      ref,
      name,
      level: levelIdOf(current.language, levelLabel),
      structure,
      meaning,
      synonym,
      example: sentence,
      translation: translation ?? '',
      errorRule: errorRule || null,
      note,
    });
  }

  if (libraries.length ===  0) throw new Error('没有解析到任何语种小节（应形如「## 英语（托福）（200 条）」）');
  for (const library of libraries) {
    if (library.points.length === 0) throw new Error(`${library.language} 没有语法点`);
  }
  return libraries;
}

// ---------------------------------------------------------------- 主流程

const text = fs.readFileSync(path.resolve(input), 'utf8');
const libraries = parse(text);

let failed = false;
for (const library of libraries) {
  try {
    loadGrammarLibraryFile(library, `导入的 ${library.language} 数据`);
  } catch (err) {
    failed = true;
    console.error(`✗ ${library.language}：${(err as Error).message}`);
  }
}
if (failed) process.exit(1);

for (const library of libraries) {
  const byLevel = library.levels.map((level) => {
    const total = library.points.filter((point) => point.level === level.id).length;
    return `${level.label}=${total}`;
  });
  const covered = new Set(library.points.map((point) => point.errorRule).filter(Boolean)).size;
  console.log(
    `✓ ${library.language}：语法点 ${library.points.length}（${byLevel.join('，')}）· 错因规则 ${library.rules.length}（被引用 ${covered}）`,
  );
}

if (checkOnly) {
  console.log('\n--check：只校验，未写入文件。');
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const library of libraries) {
    const file = path.join(OUT_DIR, `${library.language}.json`);
    fs.writeFileSync(file, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
    console.log(`  已写入 ${path.relative(process.cwd(), file)}`);
  }
}

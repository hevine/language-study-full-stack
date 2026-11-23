/**
 * 模型返回的 JSON 经常「差一点就能用」：外面裹一圈客套话、markdown 围栏、
 * 末尾多个逗号、中文引号、写到一半被 max_tokens 截断……
 * 这些情况本地就能修好，不值得再调一次模型白烧 token。
 *
 * 修复是「逐级加码」的：每个阶段都先试一次 JSON.parse，
 * 能过就立刻返回，绝不做多余的改写（改写本身也可能碰坏内容）。
 *
 * 截断阶段是「一题多解」：同一段残缺文本生成几种候选（补齐引号括号 /
 * 丢弃最后一个不完整对象 / 丢掉写到一半的字符串），逐个 parse，取第一个能过的。
 */

export interface RepairResult {
  ok: boolean;
  value?: unknown;
  /** 实际通过 parse 的那一版文本，方便日志排查 */
  stage?: string;
}

/** 阶段一：剥掉围栏与前后缀，只留最外层的 { } 或 [ ] */
export function stripNoise(raw: string): string {
  let text = raw.replace(/^\uFEFF/, '').trim();
  // ```json ... ``` 围栏
  if (text.includes('```')) {
    const fenced = text.match(/```(?:json|jsonc|json5|javascript|js)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
  }
  // 模型常先写一大段分析再给 JSON：定位到 "shots"/"scenes" 键，从它所在对象的 { 开始切
  const anchor = text.search(/"(?:shots|scenes|storyboard|segments|sections)"\s*:/i);
  if (anchor > 0) {
    const brace = text.lastIndexOf('{', anchor);
    if (brace > 0) text = text.slice(brace);
  }
  // 前后客套话：取第一个 { 或 [ 到最后一个 } 或 ]
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  const first = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  const lastObj = text.lastIndexOf('}');
  const lastArr = text.lastIndexOf(']');
  const last = Math.max(lastObj, lastArr);
  if (first !== -1 && last > first) text = text.slice(first, last + 1);
  return text.trim();
}

/** 阶段二：删掉 ] 或 } 前的悬挂逗号 */
function dropTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/** 阶段三：中文引号 → 英文引号（模型爱用 “” ‘’ 当字符串定界符） */
function normalizeQuotes(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/** 只在字符串外部做替换：字符串里的中文标点是正文内容，动了就毁稿 */
function mapOutsideStrings(text: string, fn: (ch: string) => string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    out += inString ? ch : fn(ch);
  }
  return out;
}

/** 阶段四之前：中文标点当结构符号用（`，` 当逗号、`：` 当冒号、全角引号当定界符） */
function normalizeFullWidth(text: string): string {
  const table: Record<string, string> = {
    '，': ',',
    '、': ',',
    '：': ':',
    '；': ';',
    '｛': '{',
    '｝': '}',
    '［': '[',
    '］': ']',
    '\u3000': ' ',
  };
  if (!/[，、：；｛｝［］\u3000]/.test(text)) return text;
  return mapOutsideStrings(text, (ch) => table[ch] ?? ch);
}

/** 阶段四之前：去掉字符串外的 // 与 /* *\/ 注释（模型爱写「// 第1题」） */
function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 阶段四：单引号字符串 → 双引号（只在没辙时试，风险最高） */
function singleToDoubleQuotes(text: string): string {
  if (!text.includes("'")) return text;
  return text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, body: string) => `"${body.replace(/"/g, '\\"')}"`);
}

/** 阶段五：字符串里的裸换行 / 裸制表符转义掉（JSON 不允许字面换行） */
function escapeRawControls(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch === '\n') {
      out += '\\n';
      continue;
    }
    if (inString && ch === '\t') {
      out += '\\t';
      continue;
    }
    if (inString && ch === '\r') {
      continue;
    }
    out += ch;
  }
  return out;
}

interface ScanState {
  /** 还等着配对的右括号，栈顶是最内层 */
  stack: string[];
  /** 扫描结束时是否还停在字符串里 */
  openString: boolean;
  /** 最后一个未闭合字符串的起始下标 */
  stringStart: number;
  /** 这个未闭合字符串是对象的「键」还是「值」：键补引号反而会造出非法 JSON */
  stringIsKey: boolean;
  /** 最后一个完整元素之后的截断点：裁到这里，前缀结构一定完整 */
  boundary: number;
}

/** 一次扫描同时拿到括号栈、字符串状态和「可以安全裁掉的位置」 */
function scanJson(text: string): ScanState {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let stringIsKey = false;
  let boundary = 0;
  let lastStructural = '';

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
      const top = stack[stack.length - 1];
      stringIsKey = top === '}' && (lastStructural === '{' || lastStructural === ',');
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (stack.length === 0) boundary = i + 1;
      stack.push(ch === '{' ? '}' : ']');
      lastStructural = ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length > 0) boundary = i + 1;
      lastStructural = ch;
      continue;
    }
    if (ch === ',') {
      if (stack.length > 0) boundary = i;
      lastStructural = ch;
      continue;
    }
    if (ch === ':') {
      lastStructural = ch;
      continue;
    }
    // 数字 / true / null / 空白：不更新 lastStructural，值本身不是结构字符
  }
  return { stack, openString: inString, stringStart, stringIsKey, boundary };
}

function closers(stack: string[]): string {
  return stack.slice().reverse().join('');
}

/** 截断点常停在 "xxx", 或 "key": 后面，先把这些悬挂标点去掉 */
function trimDangling(text: string): string {
  return text.replace(/\s+$/, '').replace(/[,:]\s*$/, '');
}

/**
 * 生成几种截断补全方案，按「尽量保留内容」到「保守裁切」排序。
 * 只有确实存在未闭合结构时才返回候选，避免把本来合法的 JSON 改写坏。
 */
function truncatedCandidates(text: string): Array<{ name: string; value: string }> {
  const scan = scanJson(text);
  if (scan.stack.length === 0 && !scan.openString) return [];
  const out: Array<{ name: string; value: string }> = [];

  // ① 补齐：字符串写到一半时先补引号（是「键」就别补），再按括号栈补右括号
  const withQuote = scan.openString && !scan.stringIsKey ? `${text}"` : text;
  out.push({ name: 'close', value: trimDangling(withQuote) + closers(scan.stack) });

  // ② 丢弃最后一个不完整对象：裁到最近一个完整元素的边界，再按新的括号栈补齐
  if (scan.boundary > 0 && scan.boundary < text.length) {
    const cut = trimDangling(text.slice(0, scan.boundary).trimEnd());
    out.push({ name: 'drop-last', value: cut + closers(scanJson(cut).stack) });
  }

  // ③ 丢掉写到一半的字符串，连同它前面悬空的 "key": 前缀
  if (scan.openString && scan.stringStart > 0) {
    let cut = text.slice(0, scan.stringStart).trimEnd();
    cut = cut.replace(/[:,]\s*"[^"]*"\s*:\s*$/, '').replace(/"[^"]*"\s*:\s*$/, '');
    cut = trimDangling(cut);
    out.push({ name: 'drop-open-string', value: cut + closers(scanJson(cut).stack) });
  }
  return out;
}

export function repairJson(raw: string): RepairResult {
  const base = stripNoise(raw);
  if (!base) return { ok: false };

  // 逐级累计修复，每级都先试 parse
  let text = base;
  const stages: Array<{ name: string; apply: (t: string) => string }> = [
    { name: 'as-is', apply: (t) => t },
    { name: 'trailing-commas', apply: dropTrailingCommas },
    { name: 'smart-quotes', apply: normalizeQuotes },
    { name: 'comments', apply: stripComments },
    { name: 'full-width', apply: normalizeFullWidth },
    { name: 'raw-controls', apply: escapeRawControls },
    { name: 'single-quotes', apply: singleToDoubleQuotes },
  ];

  for (const stage of stages) {
    text = stage.apply(text);
    if (!text) continue;
    try {
      return { ok: true, value: JSON.parse(text), stage: stage.name };
    } catch {
      /* 下一级 */
    }
  }

  // 截断：同一段文本试几种补法，任何一种能 parse 就立刻用
  if (!text) return { ok: false };
  for (const candidate of truncatedCandidates(text)) {
    if (!candidate.value) continue;
    try {
      return { ok: true, value: JSON.parse(candidate.value), stage: `truncated:${candidate.name}` };
    } catch {
      /* 换下一种补法 */
    }
  }
  return { ok: false };
}

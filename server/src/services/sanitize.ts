/**
 * 讲义 / 电子书里夹带的「别人的水印」：网校署名、下载站广告、公众号与群号、版权声明、裸链接。
 *
 * 这些东西对学习没有任何价值，出现在每日精读里还会打断句子（页脚常把一句话劈成两半），
 * 所以统一在「入库前」剥掉；已有数据用 scripts/cleanMaterials.ts 回洗一遍。
 * 只做保守匹配：宁可漏掉一条广告，也不要把正文里的词误删。
 */

/** 整行命中即丢掉：这些句子本身就是广告或版权声明，不可能是正文 */
const PROMO_LINE_PATTERNS: RegExp[] = [
  /pdfFactory/i, // 盗版 PDF 的打印机水印
  /试用版本(?:创建|生成)?/,
  /沪江(?:网校|日语|部落|开心词场|网校日语)/,
  /yeshj/i,
  /hujiang\.com/i,
  /转载请注明(?:出处|来源)/,
  /版权归.{0,12}所有/,
  /内部资料/,
  /(?:仅供|仅限)(?:学习|内部|交流|个人)/,
  /(?:扫码|扫描二维码|长按识别|扫描下方)/,
  /(?:关注|添加|加入)(?:微信|公众号|QQ|企鹅|书友|学习群)/,
  /(?:微信|公众号|QQ\s*群|书友群|交流群|学习群|答疑群)\s*[：:]\s*\S+/,
  /(?:淘宝|天猫|京东|当当)(?:店铺|旗舰店|商城|网)/,
  /(?:本书|本资料|本讲义)(?:由|来自).{0,14}(?:整理|提供|分享|制作)/,
  /(?:更多|免费)(?:资料|课程|视频).{0,10}(?:关注|扫码|访问)/,
];

/** 行内出现的广告片段：删掉后若这一行不剩什么，整行也会被丢掉 */
const PROMO_INLINE_PATTERNS: RegExp[] = [
  /PDF\s*文件使用[^\n]{0,48}?创建/g,
  /沪江(?:网校|日语|部落|开心词场)/g,
  /(?:class|www)\.yeshj\.com/gi,
  /\byeshj\.com\b/gi,
  /hujiang\.com/gi,
];

/** 带协议的链接与 www 开头的裸链接 */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s，。；、）)】」』"'<>]+/gi;

/** 以常见后缀结尾的裸域名（Class.YesHJ.com、fineprint.com.cn 这类水印） */
const DOMAIN_PATTERN =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|jp|cc|top|xyz|info|me|tv|io|co)(?:\/[^\s，。；、）)】]*)?/gi;

/**
 * 去掉一行里的链接与品牌词。
 * 只有「真的删掉了东西」才顺手清理残留的冒号、顿号，否则「词汇：」这种标签会被削成「词汇」。
 */
function stripInline(line: string): { text: string; stripped: boolean } {
  // 先整条删链接，再删品牌词：反过来的话链接被拆成半截，「http://」会留在原地
  let out = line.replace(URL_PATTERN, ' ').replace(DOMAIN_PATTERN, ' ');
  for (const pattern of PROMO_INLINE_PATTERNS) out = out.replace(pattern, ' ');
  out = out.replace(URL_PATTERN, ' '); // 品牌词删完可能又露出新的链接尾巴

  const stripped = out !== line;
  if (stripped) {
    out = out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^[\s·・,，、;；:：\-–—]+/, '')
      .replace(/[\s·・,，、;；:：\-–—]+$/, '');
  }
  return { text: out.trim(), stripped };
}

/** 一行里还剩几个「实字」（不算标点与空白） */
function meaningfulLength(text: string): number {
  return text.replace(/[\p{P}\p{S}\s]/gu, '').length;
}

/** 清掉正文里的推广词、网址与版权声明；对已经干净的内容是幂等的 */
export function stripPromo(text: string): string {
  if (!text) return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  /** 上一行是广告被删掉了：下一行要接回上一句，否则正文会被广告拦腰截断 */
  let joinNext = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      // 广告块前后常带空行：正等着把后半句接回来时先别急着留空行
      if (joinNext) continue;
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    // 先摘掉链接再判断是不是水印行：否则「解答：http://class.yeshj.com/…」会被
    // 当成沪江广告整行删掉，连「解答」两个字一起没了
    const withoutUrls = line.replace(URL_PATTERN, ' ').replace(DOMAIN_PATTERN, ' ');
    if (PROMO_LINE_PATTERNS.some((pattern) => pattern.test(withoutUrls))) {
      joinNext = true;
      continue;
    }

    const { text: cleaned, stripped } = stripInline(line);
    // 整行被删空、或只剩一两个标点：这行本来就是广告，下一行要接回上一句
    if (meaningfulLength(cleaned) < 2) {
      joinNext = true;
      continue;
    }
    // 一行里除了链接只剩「解答」这种残渣，删掉；但下一行是独立的话，不要并进来
    if (stripped && cleaned.length < 5) {
      joinNext = false;
      continue;
    }

    const prev = kept[kept.length - 1];
    if (
      joinNext &&
      prev !== undefined &&
      prev.length > 20 &&
      !/[。！？.!?：:；;、,」』）)]$/.test(prev) &&
      /[\u3040-\u30ff\u4e00-\u9fffA-Za-z]$/.test(prev) &&
      /^[\u3040-\u30ff\u4e00-\u9fffA-Za-z]/.test(cleaned)
    ) {
      // 广告卡在句子中间：把后半句接回去
      kept[kept.length - 1] = prev + cleaned;
      joinNext = false;
      continue;
    }

    kept.push(cleaned);
    joinNext = false;
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 标题也走一遍：有的书把「沪江网校」塞进了章节名 */
export function stripPromoTitle(title: string): string {
  return stripInline(title).text.replace(/^[\s\-–—·]+|[\s\-–—·]+$/g, '').trim() || title.trim();
}

/** 快速判断一段文本里还有没有推广残留，供校验脚本用 */
export function hasPromo(text: string): boolean {
  if (!text) return false;
  // 带 /g 的正则 test() 会记住 lastIndex，这里先归零，避免同一个模式下次误判
  const hit = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  };
  return (
    PROMO_LINE_PATTERNS.some(hit) ||
    PROMO_INLINE_PATTERNS.some(hit) ||
    hit(URL_PATTERN) ||
    hit(DOMAIN_PATTERN)
  );
}

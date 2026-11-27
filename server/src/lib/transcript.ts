/**
 * 转写文本清洗
 * ============================================================
 * SenseVoice 系模型（硅基流动 / 本地 FunASR）把**情感与事件**当成输出的一部分：
 * 「…離れ。😌エーアイと？共存的…」—— 那个 😌 不是用户说的话，是模型在标注
 * 「这句听起来轻松」。同一批模型还会写 `<|HAPPY|>`、`<|Speech|>`、`<|woitn|>`
 * 这类标签，以及 `[laughter]` 这种事件标记。
 *
 * 这些东西一旦进了正文，后果不是「多一个符号」：
 * - 口语报告会把它当原文回放给用户看；
 * - 批改会把 emoji 当成一个「词」，字数、词数、语速全跟着偏；
 * - 用户复制这段文字去别处，等于把模型的内部标注带出去了。
 *
 * 所以在**转写出口**统一清掉，而不是让每个调用方各自处理。
 *
 * 只清「非语音内容」，不碰任何语言本身的字符：
 * emoji（Extended_Pictographic）、模型标签、事件标记、零宽字符、以及
 * 日语里模型硬插的分词空格。英文的单词间空格、韩文的词间空格一概不动 ——
 * 那是正字法的一部分，删了就变成另一个词。
 */

export type TranscriptLang = 'en' | 'ja' | 'ko';

/** `<|zh|>` `<|HAPPY|>` `<|Speech|>`：FunASR 系的元信息标签，永远不该出现在正文 */
const MODEL_TAG = /<\|[^|>]{0,40}\|>/g;

/** `[laughter]` `[笑声]` `[音楽]`：英文事件标记与中文/日文事件标记 */
const EVENT_TAG =
  /\[(?:laughter|laughs|applause|music|bgm|noise|silence|unk|inaudible|breath)\]|\[(?:笑い?声?|音楽|拍手|雑音|静音|不明)\]|\((?:laughter|laughs|applause)\)/gi;

/**
 * emoji 本体。
 *
 * 用 Extended_Pictographic 而不是 Emoji：后者包含 0-9、#、*，
 * 用它会把数字和井号一起删掉。Regional_Indicator 补国旗，
 * Emoji_Modifier 补肤色，另外补 \uFE0F（变体选择符）、\u20E3（键帽）。
 */
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u20E3]/gu;

/** 零宽字符：粘贴与模型输出都会带，肉眼看不见但会破坏字符串比较 */
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/** 日语字符与日文标点：这两类之间出现的空格一律是模型插的，日语正字法不用空格分词 */
const JA_BOUNDARY =
  '[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}\\p{Nd}、。，．！？「」『』（）ー〜・]';
const JA_INNER_SPACE = new RegExp(`(?<=${JA_BOUNDARY})[ \\t\\u3000]+(?=${JA_BOUNDARY})`, 'gu');

export function sanitizeTranscript(raw: string, lang: TranscriptLang = 'en'): string {
  if (!raw) return '';

  let text = raw
    // 标签先删：标签里可能带竖线，留到后面会被 emoji 规则拆碎
    .replace(MODEL_TAG, ' ')
    .replace(EVENT_TAG, ' ')
    // 零宽字符要在 emoji 与空格之前删：夹在空格里的零宽会让后面的空格清理失效
    .replace(ZERO_WIDTH, '')
    .replace(EMOJI, ' ')
    .replace(/\r\n?/g, '\n');

  // 日语：先去掉日中之间的空格，再折叠 —— 反过来的话「ア 自体」会被折成一个空格留下来
  if (lang === 'ja') text = text.replace(JA_INNER_SPACE, '');

  text = text
    .replace(/[ \t\u3000]{2,}/g, ' ')
    .replace(/[ \t\u3000]*\n[ \t\u3000]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * 这段文本里还有没有「可识别的内容」。
 *
 * 只判空不够：模型偶尔会输出一串标点或单个符号当结果，
 * 那说明这段录音没听清，应当当作识别失败去走下一线路，而不是给用户一段「。。。」。
 */
export function hasTranscriptContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * 「这段话说出了多少个单位」——按语种给，不按写法猜。
 *
 * 语速的分母必须是该语言自己的计量单位，否则数字会莫名其妙地偏大或偏小：
 *
 * | 语言 | 单位 | 为什么 |
 * |---|---|---|
 * | 英语 | 词（word） | 空格与标点就是词边界，测量层自己数得出来 |
 * | 日语 | モーラ（拍） | 是拍语言，汉字词与假名词的「长度」都按拍算；按字数会少一半 |
 * | 韩语 | 音节（음절） | 一个字一个音节，收音不独立成拍；按 어절 算会被词长带偏 |
 *
 * 这个函数存在的意义：让测量层（services/speechTiming）完全不懂语言，
 * 只接收一个数。否则每接一门语言就要在测量层里加一条 if。
 */
import type { LangCode } from '../types';
import { jaMoraCount } from './ja';
import { koSyllableCount } from './ko';

/**
 * 返回 undefined 表示「这门语言的单位交给测量层默认逻辑」——
 * 目前只有英语走这条路（它按空格数词），其余语言都必须自己给数。
 */
export async function spokenUnitCount(text: string, lang: LangCode): Promise<number | undefined> {
  if (lang === 'ja') return jaMoraCount(text);
  if (lang === 'ko') return koSyllableCount(text);
  return undefined;
}

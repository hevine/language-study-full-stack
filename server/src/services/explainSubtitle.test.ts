import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findFont, fontKindForText, wrapText } from './explainSubtitle';

test('fontKindForText：纯中文/日文/拉丁走中文字体', () => {
  assert.equal(fontKindForText('灰尘堆积直接原因？'), 'cjk');
  assert.equal(fontKindForText('考试题目解析'), 'cjk');
  assert.equal(fontKindForText('ひらがなとカタカナ'), 'cjk');
  assert.equal(fontKindForText('TOPIK 6 · 13.5%'), 'cjk');
});

test('fontKindForText：纯韩文走韩文字体', () => {
  assert.equal(fontKindForText('먼지의 현상과 원인'), 'hangul');
  assert.equal(fontKindForText("'없으니까'가 원인 표지."), 'hangul');
  assert.equal(fontKindForText('ㄱㄴㄷ'), 'hangul');
});

test('fontKindForText：中韩/日韩混排走全 CJK 字体', () => {
  assert.equal(fontKindForText('选项0「먼지의 현상」是原因'), 'panCjk');
  assert.equal(fontKindForText('灰尘 ひらがな 먼지'), 'panCjk');
});

test('findFont：按文字系统优先挑对应字体', () => {
  const all = () => true;
  assert.match(findFont('cjk', all) ?? '', /Hiragino Sans GB/);
  assert.match(findFont('hangul', all) ?? '', /AppleSDGothicNeo/);
  assert.match(findFont('panCjk', all) ?? '', /Arial Unicode/);
});

test('findFont：本机只有全 CJK 字体时，韩文与混排都退到它', () => {
  const exists = (file: string) => file.includes('Arial Unicode');
  assert.match(findFont('hangul', exists) ?? '', /Arial Unicode/);
  assert.match(findFont('panCjk', exists) ?? '', /Arial Unicode/);
  assert.match(findFont('cjk', exists) ?? '', /Arial Unicode/);
});

test('findFont：本机只有韩文字体时，中文也退到韩文字体而不是返回 null', () => {
  const exists = (file: string) => file.includes('AppleSDGothicNeo');
  assert.match(findFont('cjk', exists) ?? '', /AppleSDGothicNeo/);
  assert.match(findFont('panCjk', exists) ?? '', /AppleSDGothicNeo/);
});

test('findFont：一个字体都没有时返回 null', () => {
  assert.equal(findFont('cjk', () => false), null);
  assert.equal(findFont('hangul', () => false), null);
  assert.equal(findFont('panCjk', () => false), null);
});

test('wrapText：拉丁字符按 0.55 单位折行', () => {
  const lines = wrapText('abcdefgh', 2.2).split('\n');
  assert.deepEqual(lines, ['abcd', 'efgh']);
});

test('wrapText：全角字符按 1 单位折行，韩文不丢字', () => {
  const text = '가나다라마바사';
  const lines = wrapText(text, 3).split('\n');
  assert.deepEqual(lines, ['가나다', '라마바', '사']);
  assert.equal(lines.join(''), text);
});

test('wrapText：避头标点不落在行首', () => {
  // 第 6 个字符是逗号，已超宽但属于避头标点，跟上一行走
  const lines = wrapText('가나다라마,바사', 5).split('\n');
  assert.deepEqual(lines, ['가나다라마,', '바사']);
});

test('wrapText：超过最大行数就截断，不继续堆', () => {
  const lines = wrapText('가나다라마바사아자차', 3, 2).split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines, ['가나다', '라마바']);
});

test('wrapText：空串返回空串', () => {
  assert.equal(wrapText('   ', 10), '');
});
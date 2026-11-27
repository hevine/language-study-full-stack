import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_NEW_WORDS_PER_SESSION,
  MAX_REVIEW_WORDS,
  MIN_NEW_WORDS_PER_SESSION,
  sessionNewWordCount,
  sessionReviewCount,
} from './vocabPlan';

test('sessionNewWordCount：60 个/天、44 分钟的任务真的给 60 个新词', () => {
  assert.equal(sessionNewWordCount(60, 44), 60);
});

test('sessionNewWordCount：词量跟着计划目标走，不跟时长一刀切成 15 个', () => {
  assert.equal(sessionNewWordCount(30, 44), 30);
  assert.equal(sessionNewWordCount(45, 44), 45);
});

test('sessionNewWordCount：时间不够时按时长收缩（0.7 分钟/词）', () => {
  assert.equal(sessionNewWordCount(60, 21), 30);
  assert.equal(sessionNewWordCount(60, 7), 10);
});

test('sessionNewWordCount：上下限与缺失目标都有人兜底', () => {
  assert.equal(sessionNewWordCount(200, 120), MAX_NEW_WORDS_PER_SESSION);
  assert.equal(sessionNewWordCount(1, 44), MIN_NEW_WORDS_PER_SESSION);
  assert.equal(sessionNewWordCount(undefined, 44), MAX_NEW_WORDS_PER_SESSION);
  assert.equal(sessionNewWordCount(60, 0), MIN_NEW_WORDS_PER_SESSION);
});

test('sessionReviewCount：有积压按新词量 1/4 抽，且不超过上限', () => {
  assert.equal(sessionReviewCount(0, 60), 0);
  assert.equal(sessionReviewCount(121, 60), 15);
  assert.equal(sessionReviewCount(3, 60), 3);
  assert.equal(sessionReviewCount(500, 400), MAX_REVIEW_WORDS);
});

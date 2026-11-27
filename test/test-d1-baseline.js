'use strict';
const assert = require('node:assert/strict');
const { strictResult, summarize, comparison } = require('../scripts/d1-baseline.js');
const row = (id, rank, error = null) => ({ id, query: '합성 질문', split: 'dev', scored: true,
  top1: rank === 1, top3: rank <= 3, bodyIncluded: true, matched: [{ lawId: 1, article: '제1조', rank }],
  error, rules: [{ lawId: 1, title: '합성규정', text: '제1조(목적) 본문' }], elapsedMs: 1 });
const first = strictResult(row('a', 1), { split: 'dev' });
const fourth = strictResult(row('a', 4), { split: 'dev' });
assert.equal(first.strict, true);
assert.equal(fourth.strict, false, '정답 조문이 반환돼도 규정 순위 4위는 엄격 채점 실패');
assert.equal(strictResult(row('a', 1, 'UPSTREAM_UNAVAILABLE'), { split: 'dev' }).strict, false);
const summary = summarize([first, fourth]);
assert.equal(summary.strict.hits, 1);
assert.equal(summary.strict.total, 2);
assert.deepEqual(summary.articleGivenTop3, { hits: 1, total: 1, rate: 1 });
assert.equal(summarize([fourth]).articleGivenTop3.rate, null, '규정 정답이 없으면 조건부 비율을 0으로 꾸미지 않음');
const before = [first, strictResult(row('b', 2), { split: 'train' })];
const after = [fourth, strictResult(row('b', 4), { split: 'train' })];
assert.deepEqual(comparison(before, after).strict.newWrong.map(item => item.id), ['a', 'b']);
assert.deepEqual(comparison(before, after).bodyIncluded.newWrong, []);
assert.throws(() => comparison(before, [first]), /QUESTION_SET_MISMATCH/);
console.log('✅ D1 기준선 채점: 상위3 경계·오류·조건부 분모·신규 오답 목록 검증 통과');

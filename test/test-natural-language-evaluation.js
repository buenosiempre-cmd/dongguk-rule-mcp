'use strict';
const assert = require('node:assert/strict');
const { validateQuestions, scoreResponse, evaluate, parseArgs } = require('../scripts/evaluate-natural-language.js');
const questions = require('./fixtures/natural-language-questions.json');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const response = rules => ({ structuredContent: { ok: true, data: { rules, search: { mode: '핵심어 색인' } } } });
const rule = (title, text) => ({ title, excerpt: { text }, evidenceStatus: 'partial', incompleteReasons: ['RULE_IDENTITY_UNCONFIRMED'] });
async function main() {
  check('fixture has 30 queries, 28 scored and 2 unscored', () => {
    assert.equal(validateQuestions(questions).length, 30);
    assert.equal(questions.filter(q => q[1] !== null).length, 28);
  });
  check('invalid fixture fails before any calls', () => {
    for (const input of [[], {}, [['query', [], null]], [['query', null, 'keyword']], [['query', [''], null]]]) assert.throws(() => validateQuestions(input));
  });
  check('top3 and matching excerpt are distinct from top1', () => {
    const result = scoreResponse(['질문', ['여비규정'], '숙박비'], response([rule('기타', '숙박비'), rule('여 비 규 정', '숙박 비')]));
    assert.equal(result.top1, false); assert.equal(result.top3, true); assert.equal(result.excerptMatch, true); assert.equal(result.passed, true);
  });
  check('keyword in a wrong rule cannot pass the expected excerpt', () => {
    const result = scoreResponse(['질문', ['여비규정'], '숙박비'], response([rule('기타', '숙박비'), rule('여비규정', '일비')]));
    assert.equal(result.top3, true); assert.equal(result.excerptMatch, false); assert.equal(result.passed, false);
  });
  check('fourth returned rule and otherCandidates do not count as top3', () => {
    const r = response([rule('가', ''), rule('나', ''), rule('다', ''), rule('여비규정', '숙박비')]);
    r.structuredContent.data.search.otherCandidates = [{ title: '여비규정' }];
    assert.equal(scoreResponse(['질문', ['여비규정'], '숙박비'], r).top3, false);
  });
  check('unscored is not automatically a pass', () => {
    const result = scoreResponse(['질문', null, null], response([rule('가', '')]));
    assert.equal(result.passed, null); assert.equal(result.top1, null); assert.equal(result.excerptMatch, null);
  });
  check('invalid successful response is a call error', () => assert.equal(scoreResponse(questions[0], response([])).error, 'INVALID_RESPONSE'));
  check('CLI rejects missing arguments and invalid timeouts', () => {
    for (const args of [['--output'], ['--timeout', '0'], ['--timeout', 'NaN'], ['--unknown', 'x']]) assert.throws(() => parseArgs(args));
    assert.equal(parseArgs(['--timeout', '1234']).timeout, 1234);
  });
  let calls = 0;
  const report = await evaluate([
    ['success', ['여비규정'], '숙박비'], ['mismatch', ['여비규정'], null],
    ['failure', ['여비규정'], null], ['unscored failure', null, null], ['unscored success', null, null],
  ], async query => {
    calls++;
    if (query.includes('failure')) throw new Error('synthetic transport error');
    return response([rule(query === 'success' ? '여비규정' : '기타규정', '숙박비')]);
  });
  check('evaluation continues after call errors and accounts for every query', () => {
    assert.equal(calls, 5); assert.equal(report.total, 5); assert.equal(report.scored, 3); assert.equal(report.unscored, 2);
    assert.equal(report.passed, 1); assert.equal(report.failed, 2); assert.equal(report.errors, 2);
    assert.equal(report.top1, 1); assert.equal(report.top3, 1); assert.equal(report.excerptEvaluated, 1); assert.equal(report.excerptMatched, 1);
  });
  console.log(`Natural language evaluation regression: ${passed} passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

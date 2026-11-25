// Evidence status must not be promoted: a partial child keeps the parent partial.
'use strict';
const assert = require('node:assert/strict');
const { ruleLookupGaps, summarizeRuleCoverage, lawTextCoverage } = require('../src/evidence-status.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`); }

const rule = extra => ({ evidenceStatus: 'retrieved', incompleteReasons: [], excerpt: { truncated: false, matchedTerms: ['여비'], missingAppendices: [] }, ...extra });
const lookup = (rules, evidenceStatus = rules.some(x => x.evidenceStatus === 'partial') ? 'partial' : 'retrieved') => ({ structuredContent: { ok: true, data: { evidenceStatus, rules } } });
const request = { keyword: '여비규정', terms: '숙박비' };

check('하위 조회가 완전하면 retrieved', () => {
  const coverage = summarizeRuleCoverage([lookup([rule()])], [request], 8);
  assert.deepEqual([coverage.status, coverage.not_retrieved, coverage.incomplete], ['retrieved', 0, []]);
});
check('하위 partial은 사유와 함께 상위 partial로 남는다', () => {
  for (const reason of ['APPENDIX_NOT_FOUND', 'HWP_STRUCTURE_PARTIAL', 'RULE_IDENTITY_UNCONFIRMED']) {
    const child = lookup([rule({ evidenceStatus: 'partial', incompleteReasons: [reason] })]);
    child.requested_reference = request;
    const coverage = summarizeRuleCoverage([child], [request], 8);
    assert.deepEqual([coverage.status, coverage.not_retrieved], ['partial', 1], reason);
    assert.deepEqual(coverage.incomplete, [{ reference: request, reasons: [reason] }]);
  }
});
check('사유 없는 partial, 누락 별표, 잘린 발췌, 일치어 없음도 미완료', () => {
  assert.deepEqual(ruleLookupGaps(lookup([rule({ evidenceStatus: 'partial' })]).structuredContent), ['EVIDENCE_PARTIAL']);
  assert.deepEqual(ruleLookupGaps(lookup([rule()], 'partial').structuredContent), ['EVIDENCE_PARTIAL']);
  assert.deepEqual(ruleLookupGaps(lookup([rule({ excerpt: { truncated: false, matchedTerms: ['여비'], missingAppendices: ['별표 9'] } })]).structuredContent), ['APPENDIX_NOT_FOUND']);
  assert.deepEqual(ruleLookupGaps(lookup([rule({ excerpt: { truncated: true, matchedTerms: [] } })]).structuredContent), ['EXCERPT_TRUNCATED', 'NO_TERM_MATCH']);
  assert.deepEqual(ruleLookupGaps(lookup([rule({ warning: { code: 'X' } })]).structuredContent), ['RULE_WARNING']);
});
check('실패·빈 결과·조문 응답·요청 상한', () => {
  assert.deepEqual(ruleLookupGaps({ ok: false, error: { code: 'AMBIGUOUS_RULE' } }), ['AMBIGUOUS_RULE']);
  assert.deepEqual(ruleLookupGaps(undefined), ['LOOKUP_FAILED']);
  assert.deepEqual(ruleLookupGaps({ ok: true, data: { rules: [] } }), ['NO_RULE_RETURNED']);
  assert.deepEqual(ruleLookupGaps({ ok: true, data: { articles: [{ article: '제3조' }] } }), []);
  const requests = Array.from({ length: 10 }, (_, i) => ({ keyword: `규정${i}` }));
  const coverage = summarizeRuleCoverage(requests.slice(0, 8).map(() => lookup([rule()])), requests, 8);
  assert.deepEqual([coverage.status, coverage.not_retrieved, coverage.omitted_count, coverage.attempted], ['partial', 0, 2, 8]);
});
check('법령 본문 완전성은 조회 성공과 따로 본다', () => {
  const laws = [{ lawName: '옛 법', identity: { name: '새 법', mst: '1' }, articles: [{ article: '제26조', truncated: true, text: '가' }, { article: '제23조', truncated: false, text: '나' }] }];
  assert.deepEqual(lawTextCoverage(laws, { includeText: true, maxTextChars: 3000 }), { requested: true, status: 'partial', truncatedArticles: [{ lawName: '새 법', article: '제26조', mst: '1' }], missingArticles: [], maxTextChars: 3000 });
  assert.equal(lawTextCoverage([{ lawName: '법', articles: [{ article: '제1조', truncated: false, text: '가' }] }], { includeText: true, maxTextChars: 3000 }).status, 'complete');
  // Without include_text no body is returned, so a cut body is not a gap in this response.
  assert.deepEqual(lawTextCoverage(laws, { includeText: false }), { requested: false, status: 'not_requested', truncatedArticles: [], missingArticles: [] });
});
check('본문을 못 가져온 조문은 complete가 아니고 잘림과 구분한다', () => {
  const cover = (articles, extra = {}) => lawTextCoverage([{ lawName: '법', identity: { status: 'current', name: '법', mst: '1' }, articles, ...extra.law }], { includeText: true, maxTextChars: 3000, ...extra.options });
  const failed = cover([{ article: '제101조', status: 'unavailable', code: 'LEGAL_BODY_ERROR' }]);
  assert.deepEqual([failed.status, failed.truncatedArticles, failed.missingArticles], ['unavailable', [], [{ lawName: '법', article: '제101조', articleStatus: 'unavailable', reason: 'LEGAL_BODY_ERROR' }]]);
  const limited = cover([{ article: '제1조', status: 'found', text: '가' }, { article: '제9조', status: 'not_checked', code: 'ARTICLE_LIMIT' }]);
  assert.deepEqual([limited.status, limited.missingArticles.map(x => [x.article, x.reason])], ['partial', [['제9조', 'ARTICLE_LIMIT']]]);
  const off = cover([{ article: '제5조', status: 'not_checked' }], { law: { identity: { status: 'not_checked' } }, options: { lookupCode: 'LAW_LINK_NOT_CONFIGURED' } });
  assert.deepEqual([off.status, off.missingArticles[0].reason], ['unavailable', 'LAW_LINK_NOT_CONFIGURED']);
  assert.equal(cover([{ article: '제2조', status: 'found' }]).missingArticles[0].reason, 'LAW_TEXT_NOT_RETURNED');
  // 확인된 삭제·없음, 목록에 없는 법령, 인용 조문이 없는 법령은 가져올 본문이 없다.
  assert.equal(cover([{ article: '제31조', status: 'deleted' }, { article: '제99조', status: 'missing', code: 'LEGAL_ARTICLE_MISSING' }]).status, 'not_required');
  assert.equal(cover([{ article: '제1조', status: 'not_checked' }], { law: { identity: { status: 'not_found', code: 'LEGAL_EXACT_LAW_NOT_FOUND' } } }).status, 'not_required');
  assert.equal(cover([]).status, 'not_required');
  assert.equal(cover([{ article: '제29조', status: 'found', text: '가' }, { article: '제31조', status: 'deleted', text: '제31조 삭제' }, { article: '제99조', status: 'missing' }]).status, 'complete');
});

console.log(`📊 근거 상태 전파 검증: ${passed}개 통과`);

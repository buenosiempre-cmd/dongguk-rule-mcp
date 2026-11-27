'use strict';
const assert = require('node:assert/strict');
const { ranksOf, reciprocalRankFusion, rankRules, rankingMethod, METHODS, DEFAULT_METHOD } = require('../src/fusion');
const ontology = require('../src/ontology');
const { ruleFamily, requestedRuleScope } = require('../src/lookup');
const { summarize, compareReports, parseArgs, percentile } = require('../scripts/measure-natural-language');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`); }

let nextId = 1;
const candidate = (title, score, extra = {}) => ({ lawId: nextId++, title, score, wordScore: score, semanticRuleRank: null, ...ruleFamily(title), ...extra });
const titles = result => result.ranked.map(hit => hit.title);
const rank = (question, candidates, options = {}) => rankRules({ candidates, scope: requestedRuleScope(question, options.campus || 'all'), query: question, ...options });

console.log('순위 결합');
check('순위: 같은 점수는 같은 순위, 유한하지 않은 점수는 제외', () => {
  assert.deepEqual([...ranksOf([['a', 3], ['b', 5], ['c', 3], ['d', NaN]])], [['b', 1], ['a', 2], ['c', 2]]);
});
check('RRF: 순위만 더하고, 한 목록에 없는 규정은 그 목록 몫이 0', () => {
  const fused = reciprocalRankFusion([{ ranks: new Map([['a', 1], ['b', 2]]) }, { ranks: new Map([['b', 1]]), weight: 0.5 }, { ranks: new Map([['a', 1]]), weight: 0 }, { ranks: null }], { k: 10 });
  assert.equal(fused.get('a'), 1 / 11);
  assert.equal(fused.get('b'), 1 / 12 + 0.5 / 11);
});
check('방식 이름: 기본은 legacy, 모르는 값도 legacy', () => {
  assert.equal(DEFAULT_METHOD, 'legacy');
  assert.equal(rankingMethod(''), 'legacy');
  assert.equal(rankingMethod('  RRF '), 'rrf');
  assert.equal(rankingMethod('nonsense'), 'legacy');
  assert.deepEqual(METHODS, ['legacy', 'hybrid', 'rrf', 'jev', 'hybrid-graph']);
});

console.log('캠퍼스·기관');
const purchasing = () => [candidate('구매규정', 10), candidate('WISE캠퍼스 구매규정', 9), candidate('취업규칙', 8), candidate('WISE캠퍼스 대관 규정', 2)];
check('legacy: 물은 캠퍼스의 규정이 있으면 그 규정만 남김(이전 동작)', () => {
  const result = rank('경주캠퍼스 구매 계약', purchasing(), { method: 'legacy' });
  assert.equal(result.method, 'legacy');
  assert.deepEqual(titles(result), ['WISE캠퍼스 구매규정', 'WISE캠퍼스 대관 규정']);
});
check('legacy: 범위를 묻지 않으면 점수 순서 그대로, 판이 여럿인 계열은 모호', () => {
  const result = rank('구매 계약', purchasing(), { method: 'legacy' });
  assert.deepEqual(titles(result), ['구매규정', 'WISE캠퍼스 구매규정', '취업규칙', 'WISE캠퍼스 대관 규정']);
  assert.equal(result.ranked[0].scopeMatch, null);
  assert.equal(result.ranked[0].scopeAmbiguous, true);
  assert.equal(result.ranked[2].scopeAmbiguous, false);
});
check('hybrid: 캠퍼스 판이 있는 계열은 그 판으로, 판이 없는 전교 규정은 후보로 남김', () => {
  const result = rank('경주캠퍼스 구매 계약', purchasing(), { method: 'hybrid' });
  assert.deepEqual(titles(result), ['WISE캠퍼스 구매규정', '취업규칙', 'WISE캠퍼스 대관 규정']);
  assert.deepEqual(result.ranked.map(hit => hit.scopeMatch), [true, null, true]);
  assert.equal(result.ranked[0].order, 9 * 1.5);
  assert.equal(result.ranked[1].order, 8);
});
check('hybrid: 캠퍼스만 물으면 그 캠퍼스의 다른 기관 판은 전교 규정을 대신하지 않음', () => {
  const result = rank('경주캠퍼스 직원 병가', [candidate('취업규칙', 10), candidate('산학협력단 취업규칙', 9), candidate('WISE캠퍼스 산학협력단 취업규칙', 9)], { method: 'hybrid' });
  assert.deepEqual(titles(result).sort(), ['WISE캠퍼스 산학협력단 취업규칙', '취업규칙']);
  assert(result.ranked.every(hit => hit.scopeMatch === null && hit.scopeAmbiguous));
});
check('hybrid: 캠퍼스와 기관을 함께 물으면 둘 다 맞는 판 하나', () => {
  const result = rank('WISE캠퍼스 산학협력단 직원 정년', [candidate('취업규칙', 10), candidate('산학협력단 취업규칙', 9), candidate('WISE캠퍼스 산학협력단 취업규칙', 9)], { method: 'hybrid' });
  assert.deepEqual(titles(result), ['WISE캠퍼스 산학협력단 취업규칙']);
  assert.equal(result.ranked[0].scopeAmbiguous, false);
});
check('hybrid: 기관만 물으면 두 캠퍼스의 그 기관 판이 모두 남아 모호', () => {
  const result = rank('산단 직원 연차', [candidate('취업규칙', 10), candidate('산학협력단 취업규칙', 9), candidate('WISE캠퍼스 산학협력단 취업규칙', 8)], { method: 'hybrid' });
  assert.deepEqual(titles(result), ['산학협력단 취업규칙', 'WISE캠퍼스 산학협력단 취업규칙']);
  assert(result.ranked.every(hit => hit.scopeMatch === true && hit.scopeAmbiguous));
});
check('hybrid: 의대 질문은 의학계열 판을 고르고 전교 규정(학칙)을 버리지 않음', () => {
  const result = rank('의대 학생이 휴학하려면', [candidate('학칙', 10), candidate('교원인사규정', 6), candidate('의학계열 교원인사규정', 5), candidate('의학과 학사시행세칙', 4)], { method: 'hybrid' });
  assert.deepEqual(titles(result), ['학칙', '의학계열 교원인사규정', '의학과 학사시행세칙']);
  assert.deepEqual(result.ranked.map(hit => hit.scopeMatch), [null, true, true]);
});
check('hybrid: 분야 이름이 든 연구소는 기관 범위가 아님, legacy는 의학계열 규정만 남김', () => {
  const candidates = () => [candidate('불교의학연구소 규정', 10), candidate('의학계열 교원인사규정', 6), candidate('교원인사규정', 5)];
  assert.deepEqual(titles(rank('불교의학연구소 선임연구원 자격', candidates(), { method: 'hybrid' })), ['불교의학연구소 규정', '의학계열 교원인사규정', '교원인사규정']);
  assert.deepEqual(titles(rank('불교의학연구소 선임연구원 자격', candidates(), { method: 'legacy' })), ['의학계열 교원인사규정']);
});
check('hybrid: 서울캠퍼스를 물으면 WISE 규정은 뒤로', () => {
  const result = rank('서울캠퍼스 대관 신청', [candidate('WISE캠퍼스 대관 규정', 10), candidate('대관 규정', 9), candidate('WISE캠퍼스 학생준칙', 8), candidate('학생준칙', 1)], { method: 'hybrid' });
  assert.deepEqual(titles(result), ['대관 규정', '학생준칙']);
  const other = rank('서울캠퍼스 대관 신청', [candidate('WISE캠퍼스 공동묘지 관리규정', 10), candidate('대관 규정', 7)], { method: 'hybrid' });
  assert.deepEqual(titles(other), ['대관 규정', 'WISE캠퍼스 공동묘지 관리규정']);
  assert.equal(other.ranked[1].scopeMatch, false);
});
check('hybrid: 도구의 campus 인수도 범위로 읽음', () => {
  assert.deepEqual(titles(rank('구매 계약', purchasing(), { method: 'hybrid', campus: 'wise' })), ['WISE캠퍼스 구매규정', '취업규칙', 'WISE캠퍼스 대관 규정']);
});

console.log('대상');
const staffRule = { lawId: 9001, title: '취업규칙', code: '3-3-14', blocks: Array.from({ length: 12 }, (_, i) => ({ article: `제${i + 1}조`, content: `### 제${i + 1}조(복무)\n직원은 성실히 근무한다. 직원의 휴가는 따로 정한다.` })) };
const mixedRule = { lawId: 9002, title: '여비규정', code: '3-7-5', blocks: Array.from({ length: 12 }, (_, i) => ({ article: `제${i + 1}조`, content: `### 제${i + 1}조(여비)\n교직원의 여비는 직원과 교원에게 같은 기준으로 지급한다.` })) };
check('본문 대상: 한 직군을 거듭 말하는 규정만, 교직원은 어느 쪽도 아님', () => {
  assert.equal(ontology.bodySubject(staffRule), '직원');
  assert.equal(ontology.bodySubject(mixedRule), null);
  assert.equal(ontology.bodySubject({ title: '빈 규정', blocks: [] }), null);
  assert.equal(ontology.ruleFacets(staffRule).bodySubject, '직원');
  assert(ontology.ruleFacets(staffRule).evidence.some(item => item.source === 'body' && item.inferred));
  // The title already names the class: the body is not read again.
  assert.equal(ontology.ruleFacets({ ...staffRule, title: '직원 복무규정' }).bodySubject, null);
});
check('hybrid: 본문이 다른 직군의 규정은 조금 뒤로, 같은 직군·대상을 안 물은 질문은 그대로', () => {
  const corpus = { rules: [staffRule, mixedRule] };
  const candidates = () => [{ ...candidate('취업규칙', 10), lawId: 9001 }, { ...candidate('여비규정', 9), lawId: 9002 }];
  const facets = query => ontology.createFacetSignal({ corpus, query });
  const professor = rank('교수 휴가는 며칠', candidates(), { method: 'hybrid', facets: facets('교수 휴가는 며칠') });
  assert.deepEqual(titles(professor), ['여비규정', '취업규칙']);
  assert.equal(professor.ranked[1].order, 8);
  assert.deepEqual(titles(rank('직원 휴가는 며칠', candidates(), { method: 'hybrid', facets: facets('직원 휴가는 며칠') })), ['취업규칙', '여비규정']);
  assert.deepEqual(titles(rank('휴가는 며칠', candidates(), { method: 'hybrid', facets: facets('휴가는 며칠') })), ['취업규칙', '여비규정']);
  assert.deepEqual(titles(rank('교수 휴가는 며칠', candidates(), { method: 'hybrid' })), ['취업규칙', '여비규정']);
});
check('hybrid: 넓은 직군의 규정은 좁은 직군 질문에 불일치가 아님(교원 → 강사)', () => {
  const facultyRule = { ...staffRule, lawId: 9003, title: '인사규정', blocks: staffRule.blocks.map(block => ({ ...block, content: block.content.replace(/직원/g, '교원') })) };
  const corpus = { rules: [facultyRule] };
  const result = rank('강사 휴가는 며칠', [{ ...candidate('인사규정', 10), lawId: 9003 }], { method: 'hybrid', facets: ontology.createFacetSignal({ corpus, query: '강사 휴가는 며칠' }) });
  assert.equal(result.ranked[0].order, 10);
});

console.log('RRF·확률');
check('rrf: 낱말 2위라도 의미 1위면 앞에, 의미 순위가 없으면 hybrid로', () => {
  const candidates = () => [candidate('가 규정', 10, { semanticRuleRank: 5 }), candidate('나 규정', 9, { semanticRuleRank: 1 })];
  const fused = rank('질문', candidates(), { method: 'rrf', semantic: true });
  assert.equal(fused.method, 'rrf');
  assert.deepEqual(titles(fused), ['나 규정', '가 규정']);
  const plain = rank('질문', candidates(), { method: 'rrf', semantic: false });
  assert.equal(plain.method, 'hybrid');
  assert.deepEqual(titles(plain), ['가 규정', '나 규정']);
});
check('rrf: 그래프 점수가 있으면 한 목록으로 더함', () => {
  const candidates = [candidate('가 규정', 10, { semanticRuleRank: 1 }), candidate('나 규정', 9, { semanticRuleRank: 2 })];
  const graph = new Map([[candidates[1].lawId, 3]]);
  assert.deepEqual(titles(rank('질문', candidates, { method: 'rrf', semantic: true })), ['가 규정', '나 규정']);
  assert.deepEqual(titles(rank('질문', candidates, { method: 'rrf', semantic: true, graph })), ['나 규정', '가 규정']);
});
check('jev: 확률이 오면 확률 순서, 없으면 hybrid', () => {
  const candidates = [candidate('가 규정', 10), candidate('나 규정', 9)];
  const probability = new Map([[candidates[0].lawId, 0.2], [candidates[1].lawId, 0.7]]);
  const scored = rank('질문', candidates, { method: 'jev', probability });
  assert.equal(scored.method, 'jev');
  assert.deepEqual(titles(scored), ['나 규정', '가 규정']);
  assert.equal(rank('질문', candidates, { method: 'jev' }).method, 'hybrid');
  assert.equal(rank('질문', candidates, { method: 'unknown' }).method, 'legacy');
});

console.log('측정 요약');
check('요약: 규정 선택과 조문 선택을 나눠 세고 세트별로 냄', () => {
  const rows = [
    { id: 'A1', set: 'a', answered: true, ruleInTop3: true, ruleFirst: true, rulesShown: 1, ms: 10 },
    { id: 'A2', set: 'a', answered: false, ruleInTop3: true, ruleFirst: false, rulesShown: 3, ms: 30 },
    { id: 'B1', set: 'b', answered: false, ruleInTop3: false, ruleFirst: false, rulesShown: 1, ms: 20 },
  ];
  const { total, sets } = summarize(rows);
  assert.deepEqual([total.questions, total.answered, total.ruleInTop3, total.articleGivenRule, total.singleRule, total.singleRuleRight, total.singleRuleAnswered], [3, 1, 2, 1, 2, 1, 1]);
  assert.equal(total.answeredShare, 33.3);
  assert.equal(total.articleGivenRuleShare, 50);
  assert.deepEqual([total.medianMs, total.p95Ms], [20, 30]);
  assert.equal(sets.a.questions, 2);
  assert.equal(sets.b.articleGivenRuleShare, null);
  assert.equal(percentile([], 0.5), null);
});
check('비교: 새로 틀린 문항과 규정이 빠진 문항을 모두 냄', () => {
  const before = { rows: [{ id: 'A1', answered: true, ruleInTop3: true }, { id: 'A2', answered: false, ruleInTop3: false }, { id: 'A3', answered: true, ruleInTop3: true }] };
  const after = { rows: [{ id: 'A1', answered: false, ruleInTop3: false }, { id: 'A2', answered: true, ruleInTop3: true }, { id: 'A3', answered: true, ruleInTop3: true }, { id: 'A4', answered: true, ruleInTop3: true }] };
  assert.deepEqual(compareReports(before, after), { newlyWrong: ['A1'], newlyRight: ['A2'], ruleLost: ['A1'], ruleFound: ['A2'], missing: ['A4'] });
});
check('인수: 필수 값이 없거나 모르는 옵션이면 실패', () => {
  assert.deepEqual(parseArgs(['--cache', 'c', '--questions', 'a.json,b.json', '--ranking', 'rrf']).questions, ['a.json', 'b.json']);
  assert.equal(parseArgs(['--cache', 'c', '--questions', 'a.json']).offline, true);
  assert.throws(() => parseArgs(['--questions', 'a.json']), /USAGE/);
  assert.throws(() => parseArgs(['--cache', 'c', '--questions', 'a.json', '--what']), /UNKNOWN_OPTION/);
  assert.throws(() => parseArgs(['--cache']), /MISSING_VALUE/);
});

console.log('일상어 이름·낱말 처리');
const aliases = require('../src/aliases');
const { queryContentTokens } = require('../src/lookup');
check('이름 사전: 대상·기관·사물의 일상어가 규정 용어로 이어지고 기존 사전 묶음은 그대로', () => {
  assert(aliases.businessTerms('미화원').includes('미화직'));
  assert(aliases.businessTerms('상담센터').includes('카운슬링센터'));
  assert(aliases.businessTerms('킥보드').includes('개인형 이동장치'));
  assert.deepEqual(aliases.businessTerms('월급'), ['월급', '보수', '급여']);
  assert.equal(aliases.CONCEPT_GROUPS.length, ontology.data.concepts.length);
  const legacyWords = new Set(ontology.data.concepts.flatMap(item => [...item.everyday, ...item.rule]));
  for (const label of ontology.data.labels) {
    assert(['subject', 'body', 'thing'].includes(label.kind));
    // A label never rewrites a word the concept groups already define.
    assert(label.everyday.every(word => !legacyWords.has(word)), label.id);
  }
});
check('이름 사전 자료가 잘못되면 내장 기본값으로', () => {
  assert.throws(() => ontology.validateData({ ...ontology.data, labels: [{ id: 'x', kind: 'other', everyday: ['가'], rule: ['나'] }] }));
  assert.throws(() => ontology.validateData({ ...ontology.data, labels: [{ id: 'x', kind: 'thing', everyday: [], rule: ['나'] }] }));
  assert.equal(ontology.loadOntologyData(() => JSON.stringify({ ...ontology.data, labels: 'broken' })).status, 'fallback');
  assert.throws(() => ontology.validateData({ ...ontology.data, scopes: ontology.data.scopes.map(item => item.id === 'medical' ? { ...item, place: { ask: '[', title: 'x' } } : item) }));
  assert.throws(() => ontology.validateData({ ...ontology.data, bodySubject: { ...ontology.data.bodySubject, terms: { 없는대상: 'x' } } }));
});
check('조사 둘이 겹친 낱말에서 명사만 남기고, 한 글자 명사 술을 읽음', () => {
  assert(queryContentTokens('교수학습혁신센터에는 어떤 사람들이 일해').includes('교수학습혁신센터'));
  assert(queryContentTokens('직원에게도 수당을 줘').includes('직원'));
  assert(queryContentTokens('기숙사 방에서 술 마셔도 돼').includes('술'));
});
check('뭐 하는 곳인지 묻는 질문은 기능·직능 조문, 뽑힐 수 없는 사람은 결격사유', () => {
  assert(aliases.headingCueStrength('산학기획위원회는 뭐 하는 곳이야', '기능') > 0);
  assert(aliases.headingCueStrength('입학전형관리위원회는 뭘 하는 데야', '직능') > 0);
  assert.equal(aliases.headingCueStrength('산학기획위원회 위원은 몇 명이야', '기능'), 0);
  assert(aliases.phraseConcepts('산학협력단 직원으로 뽑힐 수 없는 사람은 누구야').includes('결격사유'));
});

console.log(`📊 순위 결합 검증: ${passed}개 통과`);

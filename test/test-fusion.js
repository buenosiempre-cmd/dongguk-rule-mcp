'use strict';
const assert = require('node:assert/strict');
const fusion = require('../src/fusion');
const { rankRules, rankingMethod, METHODS, DEFAULT_METHOD } = fusion;
const ontology = require('../src/ontology');
const { ruleFamily, requestedRuleScope } = require('../src/lookup');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`); }

let nextId = 1;
const candidate = (title, score, extra = {}) => ({ lawId: nextId++, title, score, wordScore: score, ...ruleFamily(title), ...extra });
const titles = result => result.ranked.map(hit => hit.title);
const rank = (question, candidates, options = {}) => rankRules({ candidates, scope: requestedRuleScope(question, options.campus || 'all'), query: question, ...options });

console.log('순위 결합');
check('방식 이름: 기본은 hybrid, 모르는 값도 hybrid', () => {
  assert.equal(DEFAULT_METHOD, 'hybrid');
  assert.equal(rankingMethod(''), 'hybrid');
  assert.equal(rankingMethod('  Hybrid '), 'hybrid');
  assert.equal(rankingMethod('nonsense'), 'hybrid');
  assert.deepEqual(METHODS, ['legacy', 'hybrid']);
});
check('실험 방식과 훅은 이 모듈에 없음: rrf·jev는 기본 hybrid로 읽고, 그래프·확률·장소 판독을 넘겨도 순서가 같음', () => {
  for (const name of ['rrf', 'jev', 'graph']) assert.equal(rankingMethod(name), 'hybrid');
  assert.deepEqual(Object.keys(fusion).sort(), ['DEFAULT_METHOD', 'METHODS', 'meaningElsewhere', 'rankRules', 'rankingMethod']);
  const candidates = () => { nextId = 100; return [candidate('가 규정', 10), candidate('나 규정', 9), candidate('WISE캠퍼스 다 규정', 8)]; };
  const extras = { semantic: true, graph: new Map([[101, 5]]), probability: new Map([[101, 0.9], [100, 0.1]]), placeAgreementOf: () => -1 };
  for (const method of ['legacy', 'hybrid', 'rrf', 'jev']) {
    const plain = rank('경주캠퍼스 질문', candidates(), { method }), given = rank('경주캠퍼스 질문', candidates(), { method, ...extras });
    assert.deepEqual(given, plain);
    assert.equal(plain.method, method === 'legacy' ? 'legacy' : 'hybrid');
  }
  // The measurement switches of the experiments are not read either.
  const { searchCorpus } = require('../src/corpus');
  const block = (article, text) => ({ article, supplementary: false, supplementaryHeading: null, content: `### ${article}(휴가)\n${text}` });
  const corpus = { rules: [
    { lawId: 1, historyId: 1, title: '복무규정', code: '3-1-1', blocks: [block('제1조', '직원의 휴가는 연 15일로 한다.')] },
    ...[2, 3, 4].map(lawId => ({ lawId, historyId: 1, title: `시행세칙 ${lawId}`, code: `3-1-${lawId}`, blocks: [block('제1조', '「복무규정」에 따라 세부 사항을 정한다.')] })),
  ] };
  const score = () => searchCorpus(corpus, '휴가 일수').hits.find(hit => hit.lawId === 1).wordScore;
  const usual = score();
  process.env.DONGGUK_MCP_MEASURE_STANDING = 'off'; process.env.DONGGUK_MCP_MEASURE_GRAPH = 'all';
  try { assert.equal(score(), usual); } finally { delete process.env.DONGGUK_MCP_MEASURE_STANDING; delete process.env.DONGGUK_MCP_MEASURE_GRAPH; }
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
check('hybrid: 다른 캠퍼스·다른 기관의 규정은 다른 축이 맞아도 불일치(레드팀 I04)', () => {
  const place = question => ontology.placeRequest(question);
  // Campus differs, institution agrees: was 0 (neutral) while the two cancelled.
  assert.equal(ontology.placeAgreement('WISE캠퍼스 산학협력단 취업규칙', place('서울캠퍼스 산학협력단 직원 병가')), -1);
  // Campus agrees, another institution than the asked one.
  assert.equal(ontology.placeAgreement('WISE캠퍼스 의료원 취업규칙', place('WISE캠퍼스 산학협력단 직원 병가')), -1);
  assert.equal(ontology.placeAgreement('의료원 취업규칙', place('서울캠퍼스 산학협력단 직원 병가')), -1);
  assert.equal(ontology.placeAgreement('WISE캠퍼스 의료원 취업규칙', place('서울캠퍼스 산학협력단 직원 병가')), -2);
  // Unchanged readings.
  assert.equal(ontology.placeAgreement('WISE캠퍼스 산학협력단 취업규칙', place('WISE캠퍼스 산학협력단 직원 병가')), 2);
  assert.equal(ontology.placeAgreement('산학협력단 취업규칙', place('서울캠퍼스 산학협력단 직원 병가')), 1);
  assert.equal(ontology.placeAgreement('WISE캠퍼스 산학협력단 취업규칙', place('경주캠퍼스 직원 병가')), 0);
  assert.equal(ontology.placeAgreement('취업규칙', place('서울캠퍼스 산학협력단 직원 병가')), 0);
  assert.equal(ontology.placeAgreement('WISE캠퍼스 산학협력단 취업규칙', place('직원 병가')), 0);
  // The red team's candidates: the Seoul question no longer keeps the WISE edition as neutral.
  const result = rank('서울캠퍼스 산학협력단 직원 병가', [candidate('WISE캠퍼스 산학협력단 취업규칙', 10), candidate('취업규칙', 9)], { method: 'hybrid' });
  assert.deepEqual(result.ranked.map(hit => [hit.title, hit.scopeMatch]), [['취업규칙', null]]);
  // With no other edition in the family it stays a candidate, marked and weighed as another place's rule.
  const alone = rank('서울캠퍼스 산학협력단 직원 병가', [candidate('WISE캠퍼스 산학협력단 취업규칙', 10), candidate('복무규정', 7)], { method: 'hybrid' });
  assert.deepEqual(alone.ranked.map(hit => [hit.title, hit.scopeMatch, hit.order]), [['복무규정', null, 7], ['WISE캠퍼스 산학협력단 취업규칙', false, 6]]);
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

console.log('일상어 이름·낱말 처리');
const aliases = require('../src/aliases');
const { queryContentTokens } = require('../src/lookup');
const withLabels = (value, fn) => {
  const before = process.env.DONGGUK_MCP_LABELS;
  if (value === undefined) delete process.env.DONGGUK_MCP_LABELS; else process.env.DONGGUK_MCP_LABELS = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.DONGGUK_MCP_LABELS; else process.env.DONGGUK_MCP_LABELS = before; }
};
check('스위치: 기본 켬, 0·off·false·no는 끔', () => {
  withLabels(undefined, () => assert.equal(aliases.labelsEnabled(), true));
  for (const value of ['', '1', 'on', ' ON ', 'true', 'yes', 'hybrid']) withLabels(value, () => assert.equal(aliases.labelsEnabled(), true));
  for (const value of ['0', 'off', 'false', 'no']) withLabels(value, () => assert.equal(aliases.labelsEnabled(), false));
});
check('꺼진 상태: 이름 사전·겹친 조사·새 의도 문구를 쓰지 않음(이전 동작)', () => withLabels('0', () => {
  assert.deepEqual(aliases.businessTerms('미화원'), ['미화원']);
  assert.deepEqual(aliases.businessTerms('킥보드'), ['킥보드']);
  assert.equal(aliases.knownTerm('한의대'), false);
  assert.deepEqual(aliases.businessTerms('월급'), ['월급', '보수', '급여']);
  assert(!queryContentTokens('교수학습혁신센터에는 어떤 사람들이 일해').includes('교수학습혁신센터'));
  assert.equal(aliases.headingCueStrength('산학기획위원회는 뭐 하는 곳이야', '기능'), 0);
  assert.equal(aliases.headingCueStrength('위원회는 무슨 일을 해', '직능'), 0);
  assert(aliases.headingCueStrength('위원회는 무슨 일을 해', '기능') > 0);
  assert(!aliases.phraseConcepts('산학협력단 직원으로 뽑힐 수 없는 사람은 누구야').includes('결격사유'));
  assert.deepEqual(aliases.phraseConcepts('직원으로 뽑을 수 없는 사람'), ['결격사유']);
}));
check('이름 사전: 대상·기관·사물의 일상어가 규정 용어로 이어지고 기존 사전 묶음은 그대로', () => withLabels('1', () => {
  assert(aliases.businessTerms('미화원').includes('미화직'));
  assert(aliases.businessTerms('한의대').includes('한의과대학'));
  // Words the rule book itself uses are not given extra forms.
  assert.deepEqual(aliases.businessTerms('특허'), ['특허']);
  assert(aliases.businessTerms('킥보드').includes('개인형 이동장치'));
  assert.deepEqual(aliases.businessTerms('월급'), ['월급', '보수', '급여']);
  assert.equal(aliases.CONCEPT_GROUPS.length, ontology.data.concepts.length);
  const legacyWords = new Set(ontology.data.concepts.flatMap(item => [...item.everyday, ...item.rule]));
  for (const label of ontology.data.labels) {
    assert(['subject', 'body', 'thing'].includes(label.kind));
    // A label never rewrites a word the concept groups already define.
    assert(label.everyday.every(word => !legacyWords.has(word)), label.id);
  }
}));
check('이름 사전 자료가 잘못되면 내장 기본값으로', () => {
  assert.throws(() => ontology.validateData({ ...ontology.data, labels: [{ id: 'x', kind: 'other', everyday: ['가'], rule: ['나'] }] }));
  assert.throws(() => ontology.validateData({ ...ontology.data, labels: [{ id: 'x', kind: 'thing', everyday: [], rule: ['나'] }] }));
  assert.equal(ontology.loadOntologyData(() => JSON.stringify({ ...ontology.data, labels: 'broken' })).status, 'fallback');
  assert.throws(() => ontology.validateData({ ...ontology.data, scopes: ontology.data.scopes.map(item => item.id === 'medical' ? { ...item, place: { ask: '[', title: 'x' } } : item) }));
  assert.throws(() => ontology.validateData({ ...ontology.data, bodySubject: { ...ontology.data.bodySubject, terms: { 없는대상: 'x' } } }));
});
check('조사 둘이 겹친 낱말에서 명사만 남김', () => withLabels('1', () => {
  assert(queryContentTokens('교수학습혁신센터에는 어떤 사람들이 일해').includes('교수학습혁신센터'));
  assert(queryContentTokens('직원에게도 수당을 줘').includes('직원'));
}));
check('뭐 하는 곳인지 묻는 질문은 기능·직능 조문, 뽑힐 수 없는 사람은 결격사유', () => withLabels('1', () => {
  assert(aliases.headingCueStrength('산학기획위원회는 뭐 하는 곳이야', '기능') > 0);
  assert(aliases.headingCueStrength('입학전형관리위원회는 뭘 하는 데야', '직능') > 0);
  assert.equal(aliases.headingCueStrength('산학기획위원회 위원은 몇 명이야', '기능'), 0);
  assert.deepEqual(aliases.phraseConcepts('산학협력단 직원으로 뽑힐 수 없는 사람은 누구야'), ['결격사유']);
  assert.deepEqual(aliases.phraseConcepts('직원으로 뽑을 수 없는 사람'), ['결격사유']);
}));

check('의미 조건: 다른 후보의 가산 뒤 점수가 1위의 낱말 점수에 닿는지가 경계', () => {
  const { meaningElsewhere } = require('../src/fusion.js');
  const at = (leaderWordScore, otherScores, more = {}) => meaningElsewhere({ applied: true, leaderRank: 3, leaderWordScore, otherScores, ...more });
  assert.equal(at(10, [9.99, 4]), false, '아래: 닿지 않으면 확정을 막지 않음');
  assert.equal(at(10, [10, 4]), true, '같음: 닿으면 확정하지 않음');
  assert.equal(at(10, [4, 10.01]), true, '위: 넘으면 확정하지 않음(가장 높은 후보를 봄)');
  assert.equal(at(10, [30], { leaderRank: 1 }), false, '낱말 1위가 의미 1위이면 다른 후보의 점수와 관계없이 막지 않음');
  assert.equal(at(10, [30], { leaderRank: null }), true, '의미 순위가 없는 1위는 의미 1위가 아님');
  assert.equal(at(10, [30], { applied: false }), false, '의미검색이 적용되지 않은 응답에서는 동작하지 않음');
  assert.equal(at(10, []), false, '다른 후보가 없으면 동작하지 않음');
});

console.log(`📊 순위 결합 검증: ${passed}개 통과`);

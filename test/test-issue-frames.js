// 사안 프레임(issue frame) 기반 타대학 비교: 동음어 조문 제외, 규율 요소 추출, 주/보조 규정, 요소 대조표. 오프라인.
'use strict';
const assert = require('node:assert/strict');
const { FRAMES, resolveFrame, analyzeArticle, assignRoles, buildSlotMatrix, frameSummary, citedLaws } = require('../src/issue-frames');
const { compareUniversityRules, formatComparison, expandTopic, selectArticles } = require('../src/university-rules');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`); }

// 2026-11-24 실측에서 나온 "겸직" 잡음을 그대로 재현한 합성 규정들.
const ja = { title: 'JA교원 운영규정', lawId: 693, historyId: 3749, url: 'https://rule.dongguk.edu/ja',
  markdown: '### 제9조(소속변경 및 겸직철회)\n① JA교원이 원 소속학과 변경을 요청할 때에는 겸직학과의 기관장의 동의를 받아 교원인사위원회에 제출한다.\n④ 임용기간 중이라도 겸직 사유 소멸 시 총장은 겸직을 해제할 수 있다.' };
const startup = { title: '교원창업규정', lawId: 165, historyId: 3838, url: 'https://rule.dongguk.edu/startup', revisedAt: '2026.03.13',
  markdown: '### 제9조(겸직기간)\n① 겸직기간은 매 1년마다 신청 및 연장하되 최대 5년을 넘을 수 없다. 다만 총장의 승인을 받아야 한다.\n② 연장을 희망하는 창업자는 사업계획서를 총장에게 제출하고, 기여도를 심사하여 결정한다.' };
const conduct = { title: '서울시립대학교 교직원 행동강령', lawId: 403, historyId: 1999, url: 'http://rule.uos.ac.kr/403',
  markdown: '### 제11조(겸직의 제한)\n교직원은 직무관련자의 업무에 속하는 직무를 겸직하여서는 아니 된다. 단, 공직유관단체의 정관 등에 따라 당연직으로 임명되는 경우에는 겸직할 수 있다.' };
const gradSchool = { title: '서울시립대학교 대학원 시행세칙', lawId: 68, historyId: 2068, url: 'http://rule.uos.ac.kr/68',
  markdown: '### 제19조(재입학 및 전과)\n③ 석사 또는 박사과정 논문 지도교수가 그 학과 소속이 변경되거나 복수의 학과에 겸직한 경우, 지도학생은 전과할 수 있다.\n④ 전과는 학기 시작일 30일 이전에 소속 학과에 신청한다.' };
const dedicated = { title: '건국대학교 교원의 외부기관 겸직에 관한 내규', lawId: 231, historyId: 3505, url: 'https://rule.konkuk.ac.kr/231', effectiveAt: '2025-02-24', effectiveSource: 'addenda',
  markdown: '### 제4조(겸직허가)\n① 교원이 비영리 목적의 타 기관에서 겸직을 하고자 할 경우 사전에 총장의 허가를 받아야 한다.\n② 다음의 영리 기관에 겸직을 하고자 할 경우 사전에 총장의 허가를 받아야 한다.\n1. 「벤처기업육성에 관한 특별 조치법」제16조의2에 따른 벤처기업의 대표자나 임직원\n2. 사기업체의 사외이사\n### 제9조(겸직기간)\n① 겸직기간은 2년 이내로 한다.\n② 겸직기간은 2회에 한하여 연장가능하며, 추가 연장은 교원인사위원회에서 심의하여 결정한다.\n### 제12조(보수)\n겸직 교원의 보수는 본교 근무 비율에 따라 조정한다.' };
const mention = { title: '교원인사규정', lawId: 9, historyId: 10, url: 'https://x/9', markdown: '### 제30조(복무)\n교원은 겸직 등 복무에 관한 사항을 준수한다.' };

async function main() {
  await check('프레임 정의가 온전하다: 고유 id·주제, 요소 3개 이상, 정규식 패턴, 제외·맥락 배열', () => {
    const ids = new Set(), topics = new Set();
    for (const f of FRAMES) {
      assert(!ids.has(f.id) && !topics.has(f.topic), f.id); ids.add(f.id); topics.add(f.topic);
      assert(f.terms.length >= 1 && f.slots.length >= 3 && f.searchTerms.length >= 1, f.id);
      assert(Array.isArray(f.exclude.title) && Array.isArray(f.exclude.article) && Array.isArray(f.context) && Array.isArray(f.subjects));
      const keys = new Set();
      for (const s of f.slots) { assert(!keys.has(s.key), `${f.id}.${s.key}`); keys.add(s.key); assert(s.patterns.every(p => p instanceof RegExp)); }
      for (const l of f.upperLaws) assert(typeof l.lawName === 'string' && Array.isArray(l.articles));
      assert(Object.isFrozen(f));
    }
    assert.equal(resolveFrame(['겸직']).id, 'external_concurrent_office');
    assert.equal(resolveFrame('없는주제'), null);
  });
  await check('주제어 확장이 프레임을 돌려주고, 띄어 쓴 "교원 겸직"도 프레임으로 모인다', () => {
    const k = expandTopic('겸직'); assert.equal(k.frame.id, 'external_concurrent_office'); assert.deepEqual(k.terms, ['겸직', '겸업']);
    const spaced = expandTopic('교원 겸직'); assert.equal(spaced.frame.id, 'external_concurrent_office'); assert.deepEqual(spaced.terms, ['겸직', '겸업']); assert(spaced.titleHints.includes('교원'));
    assert.equal(expandTopic('등록금 반환').frame.id, 'tuition_refund');
    const two = expandTopic('여비 겸직'); assert.equal(two.frame, null); assert.deepEqual(two.terms, ['여비', '겸직']);
    assert.equal(expandTopic('학부졸업유예').frame, null); assert.deepEqual(expandTopic('학부졸업유예').terms, ['학부졸업유예', '졸업유예']);
  });
  await check('동음어 조문 제외: 교내 겸무(JA교원)·지도교수 겸직은 빼고, 외부 겸직·행동강령은 남긴다', () => {
    const frame = resolveFrame('겸직');
    assert.equal(analyzeArticle({ content: ja.markdown }, ja, frame).excluded, 'other_issue_rule');
    // 경희대 「교원 교내겸직 규정」(2026-11-24 실측): 제목에 겸직이 있어도 교내 겸직은 다른 사안이다.
    assert.equal(analyzeArticle({ content: '### 제3조(겸직 신청)\n교원은 교내 다른 학과에 겸직을 신청할 수 있으며 보수는 지급하지 아니한다.' }, { title: '교원 교내겸직 규정' }, frame).excluded, 'other_issue_rule');
    // 숭실대 「교원 내부 겸직에 관한 내규」(2026-11-25 실측): 내부 겸직도 같은 사안이 아니다.
    assert.equal(analyzeArticle({ content: '### 제8조(보수)\n내부 겸직 교원에게는 겸직 수당을 지급하지 아니한다.' }, { title: '교원 내부 겸직에 관한 내규' }, frame).excluded, 'other_issue_rule');
    assert.equal(analyzeArticle({ content: ja.markdown }, { ...ja, title: '전임교원 인사규정' }, frame).excluded, 'other_issue_article');
    assert.equal(analyzeArticle({ content: gradSchool.markdown }, { ...gradSchool, title: '교무규정' }, frame).excluded, 'other_issue_article');
    assert.equal(analyzeArticle({ content: mention.markdown }, mention, frame).excluded, 'mention_only');
    const c = analyzeArticle({ content: conduct.markdown }, conduct, frame);
    assert.equal(c.excluded, null); assert(c.slots.some(s => s.key === 'prohibition')); assert.deepEqual(c.subjects, ['교직원']);
    const s = analyzeArticle({ content: startup.markdown }, startup, frame);
    assert.equal(s.excluded, null); assert.deepEqual(s.slots.map(x => x.key).sort(), ['period', 'permission', 'reporting']);
    assert.equal(s.slots.find(x => x.key === 'period').inHeading, true); assert.match(s.slots.find(x => x.key === 'period').evidence, /^① 겸직기간은/);
    // 조문 제목·규정명에 사안어가 없으면 사안어가 든 줄만 근거가 된다: 정관의 '직원 보수' 항은 요소로 세지 않아 언급만으로 빠진다.
    const bylaw = { title: '발전기금 정관', markdown: '### 제34조(직원)\n① 사무국 직원은 겸직할 수 있다.\n② 사무국장 등 직원은 이사장이 임명하며 보수 등은 이사회에서 정한다.' };
    assert.equal(analyzeArticle({ content: bylaw.markdown }, bylaw, frame).excluded, 'mention_only');
    const mixed = { ...bylaw, markdown: '### 제34조(직원)\n① 사무국 직원은 외부기관에 겸직할 수 있다.\n② 직원의 겸직 보수는 이사회에서 정한다.' };
    assert.deepEqual(analyzeArticle({ content: mixed.markdown }, mixed, frame).slots.map(x => x.key), ['compensation']);
  });
  await check('조문이 인용한 법령을 프레임 근거 법령과 대조한다', () => {
    const frame = resolveFrame('겸직');
    const laws = citedLaws('「벤처기업육성에 관한 특별 조치법」제16조의2에 따른 벤처기업과 「자본시장과 금융투자업에 관한 법률」제9조 제3항', frame);
    assert.deepEqual(laws.map(l => [l.lawName, l.inFrame]), [['벤처기업육성에 관한 특별 조치법', true], ['자본시장과 금융투자업에 관한 법률', false]]);
    assert.deepEqual(laws[0].articles, ['제16조의2']);
    assert.deepEqual(citedLaws('인용 없음', frame), []);
    // 교내 규정명은 법령이 아니므로 빠지고, 법령 접미가 없어도 프레임 근거 법령이면 남는다.
    assert.deepEqual(citedLaws('「교원창업규정」 및 「학교기업운영규정」에 의한 겸직은 「국가공무원 복무규정」 제25조에 따른다', frame).map(l => [l.lawName, l.inFrame]), [['국가공무원 복무규정', true]]);
  });
  await check('주규정은 제목에 사안어가 있는 규정, 없으면 요소를 가장 많이 다루는 규정(3개 이상)', () => {
    const ts = r => r.titleScore;
    const titled = assignRoles([{ lawId: 1, titleScore: 2, slots: ['a'] }, { lawId: 2, titleScore: 1, slots: ['a', 'b', 'c', 'd'] }], ts);
    assert.deepEqual(titled.map(r => r.role), ['primary', 'secondary']);
    const untitled = assignRoles([{ lawId: 1, titleScore: 0, slots: ['a'] }, { lawId: 2, titleScore: 1, slots: ['a', 'b', 'c'] }], ts);
    assert.deepEqual(untitled.map(r => r.role), ['secondary', 'primary']);
    assert.deepEqual(assignRoles([{ lawId: 1, titleScore: 0, slots: ['a', 'b'] }], ts).map(r => r.role), ['secondary']);
    assert.deepEqual(assignRoles([{ lawId: 1, titleScore: 0, slots: ['a', 'b', 'c'] }, { lawId: 2, titleScore: 0, slots: ['a', 'b', 'd'] }], ts).map(r => r.role), ['primary', 'primary']);
  });
  await check('selectArticles: 프레임이 있으면 제외 건수·역할·요소 칸·인용 법령을 함께 돌려준다', () => {
    const frame = resolveFrame('겸직');
    const r = selectArticles([ja, startup, mention], ['겸직', '겸업'], 3, frame.titleHints, frame);
    assert.equal(r.dropped.count, 2); assert.equal(r.dropped.reasons.other_issue_rule.count, 1); assert.equal(r.dropped.reasons.mention_only.label, '언급만');
    assert.equal(r.articles.length, 1); assert.equal(r.articles[0].universityRule, '교원창업규정'); assert.equal(r.articles[0].role, 'primary');
    assert.deepEqual(Object.keys(r.slotCells).sort(), ['period', 'permission', 'reporting']); assert.equal(r.slotCells.period.article, '제9조');
    assert.deepEqual(r.rules.map(x => [x.universityRule, x.role]), [['교원창업규정', 'primary']]);
    const plain = selectArticles([ja, startup], ['겸직', '겸업'], 3);
    assert.equal(plain.articles.length, 2); assert.equal(plain.dropped, undefined); assert.equal(plain.articles[0].role, undefined);
  });
  await check('비교 결과: 사안 프레임·요소 대조표·열별 주규정, 미등록 주제는 기존 정렬 기준', async () => {
    const byUniversity = { uos: [conduct, gradSchool], konkuk: [dedicated] };
    const client = { request: async () => { throw new Error('unused'); } };
    const data = await compareUniversityRules({ topic: '겸직', universities: ['uos', 'konkuk', 'yonsei'], max_articles: 2 },
      { loadDongguk: async () => ({ rules: [ja, startup], failures: [], coverage: { mode: 'fixture', truncated: false } }), client, totalTimeoutMs: 5000,
        loadExternalImpl: async source => ({ rules: byUniversity[source.key] || [], failures: [], coverage: { mode: 'fixture', truncated: false } }) });
    assert.equal(data.alignment, 'issue_frame_slots_not_legal_equivalence'); assert.equal(data.issueFrame.id, 'external_concurrent_office');
    assert(data.supportedTopics.includes('겸직')); assert.match(data.notice, /사안 프레임/);
    const [dg, uos, kk, yonsei] = data.columns;
    assert.equal(dg.dropped.count, 1); assert.deepEqual(dg.articles.map(a => a.universityRule), ['교원창업규정']);
    assert.equal(uos.dropped.count, 1); assert.deepEqual(uos.articles.map(a => [a.universityRule, a.role]), [['서울시립대학교 교직원 행동강령', 'secondary']]);
    assert.equal(kk.rules[0].role, 'primary'); assert.equal(kk.articles.length, 2); assert(kk.articlesTruncated);
    assert.equal(yonsei.status, 'unsupported');
    assert.equal(dg.slotCells, undefined);
    const period = data.slotMatrix.slots.find(s => s.key === 'period');
    assert.equal(period.cells.dongguk.article, '제9조'); assert.equal(period.cells.konkuk.universityRule, dedicated.title); assert.equal(period.cells.konkuk.role, 'primary');
    assert.equal(period.cells.uos.status, 'not_found_in_scope'); assert.equal(period.cells.yonsei.status, 'unsupported');
    // 요소 표는 상위 max_articles 밖의 조문(제12조 보수)도 쓴다.
    assert.equal(data.slotMatrix.slots.find(s => s.key === 'compensation').cells.konkuk.article, '제12조');
    assert.deepEqual(data.slotMatrix.anchorLaws.konkuk.map(l => [l.lawName, l.inFrame, l.citedBy]), [['벤처기업육성에 관한 특별 조치법', true, [`${dedicated.title} 제4조`]]]);
    const text = formatComparison(data);
    assert.match(text, /## 사안 프레임: 교직원의 외부기관 겸직/); assert.match(text, /\| 주규정 \| 교원창업규정 \| 없음\(보조규정만\) \| 건국대학교 교원의 외부기관 겸직에 관한 내규 \| — \|/);
    assert.match(text, /\| 제외 조문 \| 다른 사안의 규정 1 \| 다른 사안의 규정 1 \| 0 \| 0 \|/); assert.match(text, /\| 기간·연장 \| .*제9조/); assert.match(text, /◎ 벤처기업육성에 관한 특별 조치법 제16조의2/);
    assert.match(text, /\[주규정\] 건국대학교/); assert.match(text, /\[보조\] 서울시립대학교 교직원 행동강령/); assert.match(text, /규율 요소: 허가권자·절차/);
    assert(!/\n\n\n/.test(text));
    const plain = await compareUniversityRules({ topic: '졸업유예', universities: ['uos'] }, { loadDongguk: async () => ({ rules: [{ ...mention, markdown: '### 제1조(졸업유예)\n졸업유예를 신청할 수 있다.' }], failures: [], coverage: {} }), client, totalTimeoutMs: 5000, loadExternalImpl: async () => ({ rules: [], failures: [], coverage: {} }) });
    assert.equal(plain.alignment, 'topic_keyword_matches_not_legal_equivalence'); assert.equal(plain.issueFrame, null); assert.equal(plain.slotMatrix, undefined);
    assert(!formatComparison(plain).includes('사안 프레임:')); assert.equal(plain.columns[0].articles[0].role, undefined);
    assert.equal(frameSummary(FRAMES[0]).slots[0].key, 'permission'); assert.equal(buildSlotMatrix(FRAMES[0], []).slots.length, FRAMES[0].slots.length);
  });
  console.log(`📊 사안 프레임 검증: ${passed}개 통과`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });

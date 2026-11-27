const {
  extractRuleCitations,
  verifyRuleCitations,
  titleMatches,
  maxHangOf,
} = require('../src/citations.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🛡 인용 검증(verify_rule_citations) 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n[1] 인용 추출');
let ex = extractRuleCitations('「보수규정」 제15조제1항에 따라 지급한다.');
check('낫표+조+항 추출', ex.citations.length === 1 && ex.citations[0].ruleName === '보수규정'
  && ex.citations[0].article.canonical === '제15조' && ex.citations[0].hang === 1, JSON.stringify(ex.citations));

ex = extractRuleCitations('여비규정 제6조(운임의 구분)에 따라 정산한다.');
check('무낫표+제목 괄호 추출', ex.citations[0]?.ruleName === '여비규정' && ex.citations[0]?.citedTitle === '운임의 구분');

ex = extractRuleCitations('복무규정 제10조의2를 적용한다.');
check('제N조의M 추출', ex.citations[0]?.article.canonical === '제10조의2');

ex = extractRuleCitations('「학칙」 부칙 제2조 참조.');
check('부칙 조문 추출', ex.citations[0]?.article.supplementary === true && ex.citations[0]?.article.canonical === '부칙 제2조');

ex = extractRuleCitations('「산학협력단·연구비규정」 제3조에 따른다.');
check('가운뎃점 규정명 추출', ex.citations[0]?.ruleName === '산학협력단·연구비규정');

console.log('\n[2] 조응("같은 규정") 처리 — korean-law v4.9 교훈');
ex = extractRuleCitations('「보수규정」 제15조 및 같은 규정 제16조에 따른다.');
check('같은 규정 승계', ex.citations.length === 2 && ex.citations[1].ruleName === '보수규정' && ex.citations[1].anaphora === true,
  JSON.stringify(ex.citations.map(c => c.ruleName)));

ex = extractRuleCitations('「학칙」 제3조와 같은 학칙 시행세칙 제5조를 따른다.');
check('같은 학칙 시행세칙 → 학칙 시행세칙', ex.citations[1]?.ruleName === '학칙 시행세칙', JSON.stringify(ex.citations));

ex = extractRuleCitations('「보수규정」 제15조를 따른다.\n\n같은 규정 제16조도 참조한다.');
check('문단 경계에서 조응 승계 중단', ex.citations.length === 1 && ex.floating.length === 1
  && /선행 규정명 없음/.test(ex.floating[0].reason), JSON.stringify(ex.floating));

ex = extractRuleCitations('이 규정 제5조에 따른다.');
check('선행 없는 지시어는 규정명 불명확', ex.citations.length === 0 && ex.floating.length === 1);

console.log('\n[3] 잡음 방어');
ex = extractRuleCitations('제3조에 따라 계약금액을 정한다.');
check('규정명 없는 조문은 floating', ex.citations.length === 0 && ex.floating.length === 1);

ex = extractRuleCitations('「위임전결규정」에 따른다.');
check('조문 없는 낫표 인용은 규정 실존 검증 대상', ex.citations.length === 1 && ex.citations[0].article === null);

ex = extractRuleCitations('「보수규정」 제15조. 「보수규정」 제15조.');
check('동일 인용 중복 제거', ex.citations.length === 1);

ex = extractRuleCitations('보수규정 제15조(2025.1.1. 개정)에 따른다.');
check('날짜 주석 괄호는 제목 아님', ex.citations[0]?.citedTitle === null, JSON.stringify(ex.citations));
ex = extractRuleCitations('복무규정 제7조(신설 2024.9.1.)를 참조한다.');
check('신설 주석 괄호는 제목 아님', ex.citations[0]?.citedTitle === null);
ex = extractRuleCitations('학칙 제3조(삭제)는 적용하지 않는다.');
check('삭제 단독 주석은 제목 아님', ex.citations[0]?.citedTitle === null);
ex = extractRuleCitations('사무규정 제5조(개정절차)를 따른다.');
check("'개정'으로 시작하는 실제 제목은 유지", ex.citations[0]?.citedTitle === '개정절차', JSON.stringify(ex.citations));

console.log('\n[4] 제목 유사도·항 탐지');
check('동일 제목', titleMatches('보수의 구성', '보수의 구성') === true);
check('조사 차이 흡수(bigram)', titleMatches('보수 구성', '보수의 구성') === true);
check('무관 제목 불일치', titleMatches('겸직 금지', '보수의 구성') === false);
check('한쪽 결측 시 판정 유보', titleMatches('', '보수의 구성') === true);
check('원문자 항 최대값', maxHangOf('① 가\n② 나\n③ 다') === 3);
check('항 표기 없음 = 0', maxHangOf('본문에 항 없음') === 0);

console.log('\n[5] 판정 — mock 규정집');
const DB = {
  491: {
    hit: { lawId: 491, historyId: 3600, code: '규정', title: '보수규정', revisedAt: '2025.01.01' },
    md: '# 보수규정\n\n### 제15조(보수의 구성)\n① 보수는 봉급과 수당으로 구성한다.\n② 수당은 따로 정한다.\n\n### 제16조(지급일)\n보수는 매월 지급한다.\n\n부 칙\n\n### 제1조(시행일)\n이 규정은 공포한 날부터 시행한다.',
  },
};
const calls = [];
const deps = {
  searchRule: async q => {
    calls.push(q);
    if (q.includes('보수')) return { hits: [DB[491].hit] };
    if (q.includes('장학')) return { hits: [{ lawId: 777, historyId: 7000, code: '규정', title: '학사운영에관한내규', revisedAt: '2024.01.01' }] };
    return { hits: [] };
  },
  getRuleMarkdown: async lawId => (DB[lawId] ? DB[lawId].md : ''),
  resolveLatest: async lawId => ({ historyId: DB[lawId].hit.historyId, revisedAt: DB[lawId].hit.revisedAt }),
};

(async () => {
  const text = [
    '「보수규정」 제15조(보수의 구성) 제1항에 따라 지급하고,',
    '같은 규정 제16조(겸직 금지) 및 제15조 제3항,',
    '「보수규정」 제99조와 부칙 제1조, 부칙 제9조를 적용한다.',
    '「유령규정」 제1조와 「장학규정」 제1조도 참조한다.',
  ].join(' ');
  const r = await verifyRuleCitations(text, deps);
  const by = (article, extra = () => true) => r.citations.find(c => c.article === article && extra(c));

  check('실존+항+제목 일치 = ✓', by('제15조', c => c.hang === 1)?.status === 'EXISTS');
  check('제목 불일치 = ⚠ CONTENT_MISMATCH', by('제16조', c => c.citedTitle === '겸직 금지')?.status === 'CONTENT_MISMATCH');
  check('실제 제목 동봉', by('제16조', c => c.citedTitle === '겸직 금지')?.actualTitle === '지급일');
  check('항 초과 = ✗ HANG_NOT_FOUND(최대 항 안내)', by('제15조', c => c.hang === 3)?.status === 'HANG_NOT_FOUND'
    && /최대 제2항/.test(by('제15조', c => c.hang === 3)?.note || ''));
  const nf = by('제99조');
  check('없는 조문 = ✗ + 존재 범위', nf?.status === 'NOT_FOUND' && /제15조~제16조/.test(nf?.note || ''), nf?.note);
  check('부칙 실존 = ✓', by('부칙 제1조')?.status === 'EXISTS');
  check('부칙 미존재 = ✗', by('부칙 제9조')?.status === 'NOT_FOUND');
  check('검색 0건 = ⚠ (미존재 단정 금지)', r.citations.find(c => c.ruleName === '유령규정')?.status === 'RULE_SEARCH_MISS');
  const law = await verifyRuleCitations('「사립학교법」 제29조와 「소득세법 시행령」 제12조, 「유령규정」 제1조', deps);
  check('국가 법령 인용은 규정명 오기가 아니라 EXTERNAL_LAW', law.citations.filter(c => c.status === 'EXTERNAL_LAW').map(c => c.ruleName).join() === '사립학교법,소득세법 시행령'
    && law.citations.find(c => c.ruleName === '유령규정')?.status === 'RULE_SEARCH_MISS' && law.summary.needsReview === 3, JSON.stringify(law.citations.map(c => [c.ruleName, c.status])));
  check('무관 검색결과 = ⚠ RULE_AMBIGUOUS', r.citations.find(c => c.ruleName === '장학규정')?.status === 'RULE_AMBIGUOUS');
  check('정규화 검색 변형은 규정당 각 1회 조회', calls.filter(q => q.includes('보수')).length === 2 && new Set(calls.filter(q => q.includes('보수'))).size === 2, JSON.stringify(calls));
  check('요약 집계 일치', r.summary.exists === 3 && r.summary.notFound === 3 && r.summary.needsReview === 3, JSON.stringify(r.summary));
  check('보고서 헤더·경고 문구', /규정 인용 검증/.test(r.text) && /통과가 아닙니다/.test(r.text));
  check('규정 메타 동봉', r.citations.find(c => c.ruleName === '보수규정')?.rule?.lawId === 491);

  // Red-team fixtures retain the complete requested scope, including unsupported parts.
  const redteamBody = '### 제1조(목적)\n① 첫 항\n㊿ 마지막 항\n\n### 제1조의12(특례)\n가지조문\n\n## 부칙(2020.1.1.)\n\n### 제1조(시행일)\n부칙';
  const redteamDeps = {
    searchRule: async () => ({ hits: [{ lawId: 1, historyId: 2, title: '검수규정' }] }),
    resolveLatest: async () => ({ historyId: 2, revisedAt: '2026.01.01' }),
    getRuleMarkdown: async () => redteamBody,
  };
  for (const scope of [
    '별표999', '별표 제999호', '별지 제999호 서식', '별지서식999', '서식999',
    '제1조의123', '제1조의120', '제1000조', '제1234조', '제0조', '제1조의0',
    '제1조 제999항', '제1조제100항', '제1조 제51항', '제1조 제0항',
    '제1조 제1항 제999호', '제1조 제1항 가목', '제1조 별표999',
    '제1조(목적) 제999항', '제999항', '제999호',
    '제999999999999999999999조', '제1조의999999999999999999999',
    '부칙(2099.1.1.) 제1조',
  ]) {
    const text = `「검수규정」 ${scope}`;
    const result = await verifyRuleCitations(text, redteamDeps);
    check(`I03 ${scope}: 확인필요, 성공 제외`, result.citations.length > 0
      && result.citations.every(c => c.status === 'UNSUPPORTED_CITATION' && c.unsupportedReasons.length)
      && result.summary.verified === 0 && result.summary.exists === 0
      && result.summary.needsReview === result.summary.total, JSON.stringify(result.citations));
    check(`I03 ${scope}: 원래 범위 보존`, result.citations.every(c =>
      text.slice(c.originalRange.start, c.originalRange.end) === c.originalRange.text
      && (!c.parsedRange || text.slice(c.parsedRange.start, c.parsedRange.end) === c.parsedRange.text))
      && result.citations.map(c => c.originalRange.text).join(' ').includes(scope));
  }
  for (const scope of ['제1조', '제1조의12', '부칙 제1조', '제1조 제1항', '제1조 제50항', '제1조(목적)']) {
    const result = await verifyRuleCitations(`「검수규정」 ${scope}`, redteamDeps);
    check(`I03 정상 대조군 ${scope}`, result.citations.length === 1
      && result.citations[0].status === 'EXISTS' && result.summary.verified === 1
      && result.citations[0].originalRange.text === scope && result.citations[0].parsedRange.text === scope);
  }
  const partial = await verifyRuleCitations('「검수규정」 제1조 제999항', redteamDeps);
  check('I03 원래 범위와 지원 파싱 범위를 구분', partial.citations[0].originalRange.text === '제1조 제999항'
    && partial.citations[0].parsedRange.text === '제1조' && partial.citations[0].hang === 999);
  const numeric = await verifyRuleCitations('「검수규정」 제1조의123', redteamDeps);
  check('I03 가지조문 숫자의 앞자리만 파싱하지 않음', numeric.citations[0].article === '제1조의123'
    && numeric.citations[0].parsedRange === null);
  const mixed = await verifyRuleCitations('「검수규정」 제1조 및 제1조 제999항, 별표999', redteamDeps);
  check('I03 혼합 인용 성공/확인필요 분리', mixed.summary.total === 3 && mixed.summary.verified === 1 && mixed.summary.needsReview === 2);
  const offsetsText = '도입\n \n\n「검수규정」 제1조 제999항';
  const offsets = await verifyRuleCitations(offsetsText, redteamDeps);
  check('I03 문단 공백 뒤 오프셋 정확', offsetsText.slice(offsets.citations[0].originalRange.start, offsets.citations[0].originalRange.end) === '제1조 제999항');
  const prose = await verifyRuleCitations('「검수규정」 제1조의 제목을 확인한다.', redteamDeps);
  check('I03 일반 문장의 제목을 목 인용으로 오인하지 않음', prose.citations.length === 1 && prose.summary.verified === 1);
  const ruleOnly = await verifyRuleCitations('「검수규정」에 따른다.', redteamDeps);
  check('I03 규정명만 요청하면 RULE_EXISTS 유지', ruleOnly.summary.verified === 1 && ruleOnly.citations[0].status === 'RULE_EXISTS');
  const employmentDeps = { ...redteamDeps, searchRule: async () => ({ hits: [{ lawId: 1, historyId: 2, title: '취업규칙' }] }) };
  const fourDigit = await verifyRuleCitations('「취업규칙」 제1234조', employmentDeps);
  check('I03 D3 제1234조가 규정명 실존으로 축소되지 않음', fourDigit.citations[0].article === '제1234조'
    && fourDigit.citations[0].status === 'UNSUPPORTED_CITATION' && fourDigit.summary.verified === 0);
  const employmentOnly = await verifyRuleCitations('「취업규칙」에 따라', employmentDeps);
  check('I03 D5 취업규칙 이름만 쓴 인용은 정상 통과', employmentOnly.citations[0].status === 'RULE_EXISTS'
    && employmentOnly.summary.verified === 1 && employmentOnly.summary.needsReview === 0);
  for (const kind of ['searchRule', 'resolveLatest', 'getRuleMarkdown']) {
    const unavailable = await verifyRuleCitations('「검수규정」 제1조', { ...redteamDeps, [kind]: async () => { throw Error('synthetic outage'); } });
    check(`I03 레드팀 장애 ${kind}: 성공 제외`, unavailable.summary.verified === 0 && unavailable.summary.needsReview === 1);
  }

  const empty = await verifyRuleCitations('규정 인용이 전혀 없는 평문입니다.', deps);
  check('인용 없음 처리', empty.citations.length === 0 && empty.summary.total === 0);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 인용 검증: ${pass}개 통과 / ${fail}개 실패`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(1); });

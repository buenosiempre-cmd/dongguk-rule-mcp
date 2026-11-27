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

  // I02 red-team fixture: the same article number exists in main and addenda.
  const redteamBody = '### 제1조(목적)\n본칙\n\n### 제1조의12(특례)\n가지조문\n\n## 부칙(2020.1.1.)\n\n### 제1조(시행일)\n시행일';
  const redteamDeps = {
    searchRule: async () => ({ hits: [{ lawId: 1, historyId: 2, title: '검수규정' }] }),
    resolveLatest: async () => ({ historyId: 2, revisedAt: '2026.01.01' }),
    getRuleMarkdown: async () => redteamBody,
  };
  for (const [selector, status, title] of [
    ['제1조', 'EXISTS', '목적'],
    ['제1조의12', 'EXISTS', '특례'],
    ['부칙 제1조', 'EXISTS', '시행일'],
    ['부칙(2099.1.1.) 제1조', 'NOT_FOUND', null],
    ['부칙(2020.1.1.) 제1조', 'EXISTS', '시행일'],
    ['부칙(2099.1.1.)의 제1조', 'NOT_FOUND', null],
    ['부칙(2099.1.1.) 중 제1조', 'NOT_FOUND', null],
    ['부칙(2020.1.1.)의 제1조', 'EXISTS', '시행일'],
    ['부칙(2020.1.1.) 중 제1조', 'EXISTS', '시행일'],
    ['부칙(2020.1.1.)\n제1조', 'EXISTS', '시행일'],
    ['부 칙 （2020.01.01.） 제1조', 'EXISTS', '시행일'],
    ['부칙 2020-01-01 제1조', 'EXISTS', '시행일'],
    ['부칙 [2020/1/1] 제1조', 'EXISTS', '시행일'],
    ['부칙〈2020년 1월 1일 개정〉 제1조', 'EXISTS', '시행일'],
    ['부칙(2020. 1. 1.) 제1조', 'EXISTS', '시행일'],
    ['부칙<2020.1.1.> 제1조', 'EXISTS', '시행일'],
    ['부칙(제2020-1호, 2020.1.1.) 제1조', 'ARTICLE_SELECTOR_UNVERIFIED', null],
    ['부칙(미상) 제1조', 'ARTICLE_SELECTOR_UNVERIFIED', null],
    ['부칙(2099.1.) 제1조', 'ARTICLE_SELECTOR_UNVERIFIED', null],
    ['부칙(2099.1.1. 제1조', 'ARTICLE_SELECTOR_UNVERIFIED', null],
  ]) {
    const result = await verifyRuleCitations(`「검수규정」 ${selector}`, redteamDeps);
    check(`I02 ${selector}: ${status}`, result.citations.length === 1
      && result.citations[0].status === status && result.citations[0].actualTitle === title
      && result.summary.verified === (status === 'EXISTS' ? 1 : 0), JSON.stringify(result.citations));
  }
  const missingDate = await verifyRuleCitations('「검수규정」 부칙(2099.1.1.) 제1조', redteamDeps);
  const missingArticle = await verifyRuleCitations('「검수규정」 부칙(2020.1.1.) 제9조', redteamDeps);
  check('I02 날짜 미확인과 그 날짜 부칙 내 조문 부재 안내 구분',
    /2099.1.1.*부칙 조문 블록을 확인하지 못함/.test(missingDate.citations[0].note)
    && /2020.1.1.*부칙은 있으나 해당 조문 없음/.test(missingArticle.citations[0].note)
    && missingDate.summary.verified === 0 && missingArticle.summary.verified === 0);
  const differentDates = await verifyRuleCitations('「검수규정」 부칙(2020.1.1.) 제1조 및 부칙(2099.1.1.) 제1조', redteamDeps);
  check('I02 날짜가 다른 부칙 인용을 중복 제거하지 않음', differentDates.citations.length === 2
    && differentDates.summary.verified === 1 && differentDates.summary.notFound === 1);
  const manyAddenda = { ...redteamDeps, getRuleMarkdown: async () => redteamBody + '\n\n## 부칙(2021.2.3.)\n\n### 제1조(경과조치)\n별도 부칙' };
  const selected = await verifyRuleCitations('「검수규정」 부칙(2021.2.3.) 제1조', manyAddenda);
  check('I02 개정일로 여러 부칙 중 하나를 특정', selected.summary.verified === 1 && selected.citations[0].actualTitle === '경과조치');
  const ambiguous = await verifyRuleCitations('「검수규정」 부칙 제1조', manyAddenda);
  check('I02 날짜 없는 복수 부칙은 확인필요', ambiguous.citations[0].status === 'ARTICLE_AMBIGUOUS' && ambiguous.summary.verified === 0);
  const noDate = await verifyRuleCitations('「검수규정」 부칙(2020.1.1.) 제1조', {
    ...redteamDeps, getRuleMarkdown: async () => redteamBody.replace('부칙(2020.1.1.)', '부칙'),
  });
  check('I02 원문에 날짜가 없으면 날짜 지정 인용을 통과시키지 않음', noDate.summary.verified === 0 && noDate.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED' && noDate.summary.needsReview === 1);

  for (const text of [
    '「검수규정」 부칙에 따라 시행하며, 제3조를 준용한다.',
    '「검수규정」 부칙의 취지를 고려해 제1조를 준용한다.',
    '「검수규정」 부칙 중 적용대상을 설명하고 제1조를 준용한다.',
    '「검수규정」 부칙은 2020년 1월 1일부터 시행한다. 다만 제1조는 그러하지 아니하다.',
  ]) {
    const result = await verifyRuleCitations(text, { ...redteamDeps, getRuleMarkdown: async () => '### 제3조(준용)\n본칙\n\n' + redteamBody });
    check('일반 문장의 부칙 낱말은 뒤 본칙 조문을 삼키지 않음', result.citations.length === 1
      && result.citations[0].status === 'EXISTS' && !result.citations[0].article.startsWith('부칙'), JSON.stringify(result.citations));
  }
  for (const date of ['2099.1.1.', '2020.1.1.']) {
    for (const connector of ['에서 ', ' 중의 ', '에 따른 ', ' 가운데 ', '의 취지를 고려해 ', '을 검토한 후 ']) {
      const selector = `부칙(${date})${connector}제1조`;
      const result = await verifyRuleCitations(`「검수규정」 ${selector}를 인용한다.`, redteamDeps);
      check(`R2 날짜 선택자 연결 미해석: ${selector}`, result.citations.length === 1
        && result.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED'
        && result.citations[0].article.startsWith(`부칙(${date})`)
        && result.summary.verified === 0 && result.summary.exists === 0 && result.summary.needsReview === 1,
      JSON.stringify(result.citations));
    }
  }
  for (const text of [
    '「검수규정」 부칙의 취지를 고려해 제3조',
    '「검수규정」 부칙 중 적용대상을 검토하여 제3조',
    '「검수규정」 부칙에 따라 시행하며, 제3조를 준용한다.',
    '「검수규정」 부칙(2099.1.1.)을 검토한다. 제3조를 준용한다.',
    '「검수규정」 부칙(2099.1.1.)을 검토한다! 제3조를 준용한다.',
    '「검수규정」 부칙(2099.1.1.)을 검토한다? 제3조를 준용한다.',
  ]) {
    const result = await verifyRuleCitations(text, { ...redteamDeps, getRuleMarkdown: async () => '### 제3조(준용)\n본문\n\n' + redteamBody });
    check('R2 날짜 없는 서술문 또는 다음 문장의 조문은 본칙 유지',
      result.citations.length === 1 && result.citations[0].article === '제3조' && result.summary.verified === 1);
  }
  const nextOnly = await verifyRuleCitations('「검수규정」 부칙(2099.1.1.) 가운데 제1조 및 제1조의12', redteamDeps);
  check('R2 날짜 선택자는 바로 다음 조문 한 개에만 보존', nextOnly.citations.length === 2
    && nextOnly.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED' && nextOnly.citations[1].status === 'EXISTS');
  const newOwner = extractRuleCitations('「검수규정」 부칙(2099.1.1.)을 검토하고 「다른규정」 제3조');
  check('R2 다른 규정명으로 날짜 선택자를 넘기지 않음', newOwner.citations.find(c => c.ruleName === '다른규정')?.article.canonical === '제3조');
  const repeated = await verifyRuleCitations('「검수규정」 부칙(2020.1.1.) 제1조 및 부칙(2020.1.1.) 가운데 제1조', redteamDeps);
  check('R2 같은 날짜·조문도 미해석 인용을 성공 인용으로 중복 제거하지 않음', repeated.citations.length === 2
    && repeated.summary.verified === 1 && repeated.summary.needsReview === 1);

  for (const [date, status, title] of [['2099.1.1.', 'NOT_FOUND', null], ['2020.1.1.', 'EXISTS', '시행일']]) {
    for (const scope of [`${date}자 부칙 제1조`, `${date} 부칙 제1조`, `(${date} 부칙) 제1조`,
      `${date}자 부칙의 제1조`, `${date} 부칙 중 제1조`, `（${date} 부칙） 제1조`]) {
      const result = await verifyRuleCitations(`「검수규정」 ${scope}`, redteamDeps);
      check(`날짜가 앞선 부칙: ${scope}`, result.citations.length === 1
        && result.citations[0].status === status && result.citations[0].actualTitle === title
        && result.citations[0].article === `부칙(${date}) 제1조`
        && result.summary.verified === (status === 'EXISTS' ? 1 : 0), JSON.stringify(result.citations));
    }
  }
  for (const scope of ['2099.1.자 부칙 제1조', '(2099.1. 부칙) 제1조',
    '2099.1.1.자 부칙 가운데 제1조', '(2099.1.1. 부칙)에서 제1조',
    '2020.1.1.자 부칙 가운데 제1조', '(2020.1.1. 부칙)에서 제1조',
    '(2020.1.1. 부칙] 제1조', '(2020.1.1. 부칙 제1조']) {
    const result = await verifyRuleCitations(`「검수규정」 ${scope}`, redteamDeps);
    check(`앞선 날짜 또는 연결 미해석: ${scope}`, result.citations.length === 1
      && result.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED'
      && result.summary.verified === 0 && result.summary.needsReview === 1, JSON.stringify(result.citations));
  }
  for (const scope of ['2020-01-01자 부칙 제1조', '2020년 1월 1일자 부칙 제1조', '[2020/1/1 부칙] 제1조']) {
    const result = await verifyRuleCitations(`「검수규정」 ${scope}`, redteamDeps);
    check(`앞선 날짜의 정상 구분자: ${scope}`, result.summary.verified === 1 && result.citations[0].actualTitle === '시행일');
  }
  const leadingUnknown = await verifyRuleCitations('「검수규정」 2020.1.1.자 부칙 제1조', {
    ...redteamDeps, getRuleMarkdown: async () => redteamBody.replace('부칙(2020.1.1.)', '부칙'),
  });
  check('앞선 날짜도 원문 날짜 미상은 확인필요', leadingUnknown.summary.verified === 0
    && leadingUnknown.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED');
  const dateInEarlierSentence = await verifyRuleCitations('「검수규정」 2020.1.1.에 시행한다. 부칙 제1조', redteamDeps);
  check('다른 문장의 날짜를 날짜 없는 부칙에 붙이지 않음', dateInEarlierSentence.citations[0].article === '부칙 제1조'
    && dateInEarlierSentence.summary.verified === 1);

  for (const date of ['2099.1.1.', '2020.1.1.']) {
    for (const prefix of [`(${date}) 부칙`, `${date} 개정 부칙`, `개정 ${date} 부칙`, `${date}자 개정 부칙`, `부칙 (${date} 개정)`]) {
      const direct = await verifyRuleCitations(`「검수규정」 ${prefix} 제1조`, redteamDeps);
      check(`R4 날짜 토큰 정규화: ${prefix}`, direct.citations.length === 1
        && direct.citations[0].article === `부칙(${date}) 제1조`
        && direct.citations[0].status === (date.startsWith('2020') ? 'EXISTS' : 'NOT_FOUND')
        && direct.citations[0].actualTitle === (date.startsWith('2020') ? '시행일' : null));
      const unknown = await verifyRuleCitations(`「검수규정」 ${prefix} 새로운연결로 제1조`, redteamDeps);
      check(`R4 미등록 연결도 날짜를 버리지 않음: ${prefix}`, unknown.summary.verified === 0
        && unknown.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED');
    }
    for (const prefix of [`${date} 시행 부칙`, `${date} 확인되지않은수식 부칙`, `부칙(${date} 확인되지않은수식)`, `(${date}) 완전히새로운표현 부칙`]) {
      const result = await verifyRuleCitations(`「검수규정」 ${prefix} 제1조`, redteamDeps);
      check(`R4 미해석 수식어도 보존: ${prefix}`, result.summary.verified === 0
        && result.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED');
    }
  }
  const conflictingDates = await verifyRuleCitations('「검수규정」 2099.1.1. 부칙(2020.1.1.) 제1조', redteamDeps);
  check('R4 한 선택자에 둘 이상의 날짜는 확인필요', conflictingDates.summary.verified === 0
    && conflictingDates.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED');
  const malformedDateWrapper = await verifyRuleCitations('「검수규정」 (2020.1.1.] 부칙 제1조', redteamDeps);
  check('R4 날짜만 둘러싼 잘못된 괄호도 확인필요', malformedDateWrapper.summary.verified === 0
    && malformedDateWrapper.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED');

  for (const scope of ['부칙(제2020-1호, 2020.1.1.) 제1조', '부칙(2099.1.) 제1조',
    '부칙(2020.1.1. 제1조', '2099.1.1. 시행 부칙 제1조']) {
    const result = await verifyRuleCitations(`「검수규정」 ${scope}`, redteamDeps);
    check(`미해석 날짜 표시는 입력 그대로: ${scope}`, result.citations.length === 1
      && result.citations[0].article === scope && result.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED'
      && result.summary.verified === 0, JSON.stringify(result.citations));
  }

  const unknownAmongDated = await verifyRuleCitations('「검수규정」 부칙(2099.1.1.) 제1조', {
    ...redteamDeps, getRuleMarkdown: async () => redteamBody + '\n\n## 부칙\n\n### 제1조(시행일)\n날짜 미상',
  });
  check('일치 날짜가 없고 날짜 미상 부칙이 섞이면 확인필요', unknownAmongDated.citations[0].status === 'ARTICLE_SELECTOR_UNVERIFIED'
    && unknownAmongDated.summary.verified === 0 && unknownAmongDated.summary.needsReview === 1 && unknownAmongDated.summary.notFound === 0);

  const empty = await verifyRuleCitations('규정 인용이 전혀 없는 평문입니다.', deps);
  check('인용 없음 처리', empty.citations.length === 0 && empty.summary.total === 0);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 인용 검증: ${pass}개 통과 / ${fail}개 실패`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(1); });

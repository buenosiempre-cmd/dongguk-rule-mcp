'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSearch, parseContent, listArticleBlocks, extractArticleSections, extractChapter, normalizeArticleSelector } = require('../src/parsers.js');
const { selectRuleCandidate, rankRuleHits } = require('../src/lookup.js');
const { verifyRuleCitations, resolveRule, judgeCitation, paragraphNumbersOf } = require('../src/citations.js');
const { compareRuleMarkdown } = require('../src/versioning.js');
const { resolveHistoryAtDate, extractEnforcementDates } = require('../src/timeline.js');
const { extractAppendices, compareAppendices } = require('../src/appendices.js');
const { SEARCH_HTML } = require('./fixtures.js');

let passed = 0;
function check(name, callback) {
  callback();
  passed++;
  console.log(`  ✅ ${name}`);
}

const HIT = { lawId: 1, historyId: 10, title: '보수규정', revisedAt: '2024.01.01' };
const BODY = '### 제1조(지급기준)\n① 첫째 기준\n② 둘째 기준';
const cite = (overrides = {}) => ({ article: { number: 1, subNumber: null, supplementary: false, canonical: '제1조' }, ...overrides });
const record = md => ({ status: 'ok', hit: HIT, blocks: listArticleBlocks(md), range: { min: 1, max: 1 } });

async function main() {
  let selectedHistory;
  const deps = {
    searchRule: async () => ({ hits: [HIT] }),
    resolveLatest: async () => ({ historyId: 20, revisedAt: '2026.09.01' }),
    getRuleMarkdown: async (lawId, historyId) => { selectedHistory = historyId; return BODY; },
  };
  const verified = await verifyRuleCitations('「보수규정」 제1조 제2항', deps);
  check('인용은 검색 캐시가 아닌 최신 연혁의 본문 사용', () => assert.equal(selectedHistory, 20));
  check('인용 개정일과 HISTORY_ID는 같은 연혁에서 반환', () => assert.deepEqual(
    [verified.citations[0].rule.historyId, verified.citations[0].rule.revisedAt], [20, '2026.09.01']));
  check('확인된 항만 검증 성공', () => assert.equal(verified.summary.verified, 1));
  const unavailable = await resolveRule('보수규정', { ...deps, resolveLatest: async () => { throw new Error('offline'); } });
  check('최신 연혁 조회 실패 시 옛 검색결과로 대체 금지', () => assert.equal(unavailable.status, 'latestunavailable'));
  const numericLatest = await resolveRule('보수규정', { ...deps, resolveLatest: async () => 20 });
  check('ID형 resolver 호환 시 구 검색일자를 최신 개정일로 표기 금지', () => assert.equal(numericLatest.hit.revisedAt, ''));
  const failedSearch = await resolveRule('보수규정', { ...deps, searchRule: async () => { throw new Error('offline'); } });
  check('검색 장애를 검색 0건으로 오인 금지', () => assert.equal(failedSearch.status, 'searcherror'));
  const partialSearch = await resolveRule('보수규정', { ...deps, searchRule: async q => { if(q==='보수')throw new Error('offline');return {hits:[HIT]}; } });
  check('다른 검색 변형이 실패하면 첫 exact 후보로 검증 성공 금지', () => assert.equal(partialSearch.status,'searcherror'));
  const failedBody = await resolveRule('보수규정', { ...deps, getRuleMarkdown: async () => { throw new Error('offline'); } });
  check('본문 조회 장애는 해당 규정의 미검증 상태로 격리', () => assert.equal(failedBody.status, 'nocontent'));

  const sameTitle = [HIT, { ...HIT, lawId: 2 }];
  check('같은 제목의 다른 규정을 첫 행으로 임의 선택하지 않음', () => assert.equal(selectRuleCandidate(sameTitle, '보수규정').status, 'ambiguous'));
  check('동일 LAW_ID의 중복 행은 모호성 아님', () => assert.equal(selectRuleCandidate([HIT, HIT], '보수규정').status, 'unique'));
  check('포함 제목 하나도 정확한 규정명 확정으로 승격하지 않음', () => assert.equal(selectRuleCandidate([{ ...HIT, title: '교원보수규정' }], '보수규정').status, 'ambiguous'));
  check('등록 별칭은 정확 후보로 해석', () => assert.equal(selectRuleCandidate([{ ...HIT, title: '위임전결규정' }], '전결규정').status, 'unique'));
  check('가운뎃점 표기 차이는 같은 제목', () => assert.equal(selectRuleCandidate([{ ...HIT, title: '교원ㆍ직원규정' }], '교원·직원규정').status, 'unique'));
  check('별칭의 공식 제목이 임의의 포함 제목보다 우선', () => assert.equal(rankRuleHits([
    { ...HIT, lawId: 2, title: '위원회전결규정' }, { ...HIT, title: '위임전결규정' },
  ], '전결규정')[0].lawId, 1));
  const aliasResolution = await resolveRule('전결규정', {
    ...deps,
    searchRule: async q => ({ hits: [{ ...HIT, title: q === '위임전결규정' ? '위임전결규정' : '위원회전결규정' }] }),
  });
  check('첫 검색의 부정확한 후보 뒤에도 공식 별칭 검색 계속', () => assert.equal(aliasResolution.hit.title, '위임전결규정'));

  const noParagraphs = judgeCitation(cite({ hang: 2 }), record('### 제1조(목적)\n항 표기 없는 본문'));
  check('항 미검증은 성공 표시 금지', () => assert.deepEqual([noParagraphs.status, noParagraphs.symbol], ['HANG_UNVERIFIED', '⚠']));
  check('중간 번호가 빠진 항을 최대 번호만 보고 실존 판정하지 않음', () => assert.equal(
    judgeCitation(cite({ hang: 2 }), record('### 제1조(기준)\n① 하나\n③ 셋')).status, 'HANG_NOT_FOUND'));
  check('본문 중 인용된 원문자는 항 번호 아님', () => assert.deepEqual(paragraphNumbersOf('① 본문에서 ③을 참조한다.'), [1]));
  check('제21항 이상 유니코드 항 표기 지원', () => assert.deepEqual(paragraphNumbersOf('㉑ 본문\n㊱ 본문'), [21, 36]));
  check('조문 구조가 전혀 없으면 조문 미존재 단정 금지', () => assert.equal(judgeCitation(cite(), record('# 규정\n본문')).status, 'RULE_CONTENT_UNAVAILABLE'));
  check('원문 제목을 추출하지 못했으면 제목 검증 성공 금지', () => assert.equal(judgeCitation(cite({ citedTitle: '지급기준' }), record('### 제1조\n본문')).status, 'TITLE_UNVERIFIED'));
  check('유사 제목을 동일한 의미로 자동 확정하지 않음', () => assert.equal(judgeCitation(cite({ citedTitle: '지급' }), record('### 제1조(지급금지)\n본문')).symbol, '⚠'));

  const supplements = '부칙(2024.1.1.)\n\n### 제1조(시행일)\n종전 시행일\n\n부 칙 (2025.1.1.)\n\n### 제1조(경과조치)\n새 경과조치';
  check('날짜 괄호가 붙은 부칙 헤더 탐지', () => assert(listArticleBlocks(supplements).every(b => b.supplementary)));
  check('본칙이 없을 때 부칙 제1조로 자동 대체 금지', () => assert.equal(extractArticleSections(supplements, '제1조').text, ''));
  check('부칙 동일 조문 다수는 명시적 모호성 반환', () => assert.equal(extractArticleSections(supplements, '부칙 제1조').error, 'AMBIGUOUS_ARTICLE'));
  check('부칙 후보에 원문 헤더와 순번 유지', () => assert.deepEqual(listArticleBlocks(supplements).map(b => b.supplementaryIndex), [1, 2]));
  check('부칙 인용을 첫 번째 조문으로 판정하지 않음', () => assert.equal(judgeCitation(cite({ article: { number: 1, subNumber: null, supplementary: true, canonical: '부칙 제1조' } }), record(supplements)).status, 'ARTICLE_AMBIGUOUS'));
  check('모호 부칙의 특정 조문 비교도 거부', () => assert.equal(compareRuleMarkdown(supplements, supplements, { article: '부칙 제1조' }).error, 'AMBIGUOUS_ARTICLE'));
  const unnumbered = '### 제1조(목적)\n본문 동일\n\n부 칙\n이 규정은 2025년부터 시행한다.';
  check('번호 없는 부칙의 변경 누락 방지', () => assert.equal(compareRuleMarkdown(unnumbered, unnumbered.replace('2025', '2026')).counts.changed, 1));
  check('마지막 장 조회에 부칙이 섞이지 않음', () => assert(!extractChapter(`## 제1장 총칙\n\n${unnumbered}`, 1).includes('부 칙')));
  check('제목만 파싱한 HTML을 본문 조회 성공으로 처리하지 않음', () => assert.equal(parseContent('<div class="fullbody"><div class="lawname">규정명</div></div>').markdown, ''));
  check('정수 범위를 넘는 조문 번호 거부', () => assert.equal(normalizeArticleSelector('9007199254740993'), null));
  check('가지조문 의 앞 띄어쓰기 허용', () => assert.equal(listArticleBlocks('### 제1조 의 2(특례)\n본문')[0].subNumber, 2));
  const formattedSearch = SEARCH_HTML.replace('>3</span>건', '>1,234</span>건').replaceAll('재정시행세칙', '연구&amp;교육규정');
  check('천 단위 구분기호가 있는 검색 건수 파싱', () => assert.equal(parseSearch(formattedSearch).total, 1234));
  check('규정명 HTML 엔티티를 안전하게 보존', () => assert.equal(parseSearch(formattedSearch).hits[0].title, '연구&교육규정'));
  const liveSearch=fs.readFileSync(path.join(__dirname,'fixtures/search-live-2026-09-08.html'),'utf8');
  const liveHit=parseSearch(liveSearch,1,10).hits[0];
  check('실제 script형 검색결과에서 첫 인자만 규정명으로 추출', () => assert.deepEqual(liveHit,{lawId:184,historyId:3350,code:'3-7-5',title:'여비규정',revisedAt:'2025.04.29'}));
  const differentQuery=liveSearch.replaceAll('"여비규정");','"여비");');
  check('검색어가 달라도 규정명에 두 번째 인자를 섞지 않음', () => assert.equal(parseSearch(differentQuery).hits[0].title,'여비규정'));
  const escapedTitle=liveSearch.replace('showSearchText("여비규정", "여비규정")','showSearchText("위원회 \\"A\\" 규정, 세칙", "추가 검색어", "세 번째 인자")');
  check('첫 인자의 쉼표와 이스케이프 따옴표는 보존', () => assert.equal(parseSearch(escapedTitle).hits[0].title,'위원회 "A" 규정, 세칙'));

  check('같은 개정일의 복수 개정본을 배열 순서로 선택하지 않음', () => assert.equal(resolveHistoryAtDate([
    { historyId: 1, revisedAt: '2025.01.01' }, { historyId: 2, revisedAt: '2025.01.01' },
  ], '2025-02-01').error, 'AMBIGUOUS_HISTORY'));
  check('중복 연혁 행 자체는 모호성으로 처리하지 않음', () => assert.equal(resolveHistoryAtDate([
    { historyId: 1, revisedAt: '2025.01.01' }, { historyId: 1, revisedAt: '2025.01.01' },
  ], '2025-02-01').entry.historyId, 1));
  check('시행일의 에 및 무조사 표기 허용', () => assert.deepEqual(extractEnforcementDates(
    '2025년 1월 1일에 시행한다. 2026. 1. 1. 시행한다.').map(x => x.iso), ['2025-01-01', '2026-01-01']));

  const appendix='<별표 1> 지급기준\n|구분|금액|\n|A|100원|';
  const appendixWithSupplement=`${appendix}\n\n부 칙\n이 규정은 2025년부터 시행한다.`;
  check('부칙 변경을 별표 변경으로 오인하지 않음', () => assert.deepEqual(
    compareAppendices(appendixWithSupplement,appendixWithSupplement.replace('2025','2026')).counts,
    {added:0,removed:0,changed:0,unchanged:1}));
  check('별표 이후 본칙 조문을 별표 내용에 포함하지 않음', () => assert(!extractAppendices(`${appendix}\n\n### 제3조(기준)\n본칙 재개`)[0].text.includes('본칙 재개')));
  check('별표 이후 장 제목에서 추출 중단', () => assert(!extractAppendices(`${appendix}\n\n**제2장 총칙**\n새 장 내용`)[0].text.includes('새 장 내용')));
  check('별표 참조 문장을 제목으로 오인하지 않음', () => assert.equal(extractAppendices('별표 1에서 정한 기준을 따른다.\n일반 본문').length,0));
  check('괄호가 있어도 별표 참조 문장은 제외', () => assert.equal(extractAppendices('<별표 1>에 따라 지급한다.\n일반 본문').length,0));
  check('굵은 Markdown 별표 제목 인식', () => assert.equal(extractAppendices('**<별표 1> 지급기준**\n|금액|\n|100원|')[0].key,'별표 1'));
  check('제목 일부만 굵게 표시되어도 별표 인식', () => assert.equal(extractAppendices('## **<별표 1>** 지급기준\n|금액|\n|100원|')[0].key,'별표 1'));
  check('별표 제목의 굵은 서식만 다른 경우 내용은 동일', () => assert.equal(compareAppendices(appendix,appendix.replace('<별표 1> 지급기준','**<별표 1> 지급기준**')).counts.unchanged,1));
  check('번호 없는 별표를 실제 텍스트 비교에 포함', () => assert.equal(compareAppendices('[별표]\n|금액|\n|100원|','[별표]\n|금액|\n|200원|').counts.changed,1));
  check('번호 없는 일반 별표 참조는 제목에서 제외', () => assert.equal(extractAppendices('별표 지급기준을 적용한다.\n일반 본문').length,0));
  check('별지 제N호 서식 표기 정규화', () => assert.equal(extractAppendices('[별지 제1호 서식]\n신청서')[0].key,extractAppendices('[별지서식 제1호]\n신청서')[0].key));
  check('제N호의M 가지서식 번호 보존', () => assert.equal(extractAppendices('[별지 제1호의2 서식]\n신청서')[0].key,'별지서식 1의2'));
  check('하이픈으로 구분한 별표 번호 보존', () => assert.equal(extractAppendices('[별표 1-2]\n기준표')[0].key,'별표 1-2'));
  check('중복 별표 번호의 임의 비교는 여전히 차단', () => assert.equal(compareAppendices(`${appendix}\n\n${appendix}`,appendix).status,'partial'));
  const form='[별지 제1호 서식]\n계약서\n제1조(계약기간)\n계약기간은 별도로 정한다.';
  check('서식 내부일 수 있는 조문 경계는 완료로 단정하지 않음', () => assert.equal(compareAppendices(form,form).status,'partial'));
  check('서식 조문 경계의 원문 대조 사유 반환', () => assert(compareAppendices(form,form).boundaryWarnings.length>0));
  console.log(`📊 CoP 검색·인용 정확성 회귀 검증: ${passed}개 통과`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

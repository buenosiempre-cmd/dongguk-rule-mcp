'use strict';
// lookup_dongguk_rule for questions that name no rule: index-first candidates,
// compound-word rewriting, dominant-candidate preview, and the live fallback order.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-lookup-index-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
const searches = [];
const response = html => ({ ok: true, status: 200, text: async () => html });
const hitRow = (lawId, historyId, code, title) => `<p class="infoLeft"><span>1</span>건</p><table><tbody class="tbody"><tr><td class="tbody_txt"><a href="javascript:lawSearchFullViewSrv('${lawId}','${historyId}');"><span onclick='showSearchText("${code}")'></span><span onclick='showSearchText("${title}")'></span></a></td></tr></tbody></table>`;
require.cache[fetchPath].exports = async (url, options) => {
  assert(String(url).startsWith('https://rule.dongguk.edu/lmxsrv/search/'), `unexpected fetch ${url}`);
  const params = new URLSearchParams(options.body);
  searches.push({ type: params.get('SEARCH_TYPE'), text: params.get('SEARCH_TEXT') });
  if (params.get('SEARCH_TYPE') === 'CONTENTS' && params.get('SEARCH_TEXT') === '일비 숙박비') return response(hitRow(1, 20, '4-1-1', '여비규정'));
  return response('<p class="infoLeft"><span>0</span>건</p>');
};
const { createServer } = require('../src/index.js');
const { buildCorpus, saveCorpus, corpusPath, searchCorpus, rewriteMissingToken } = require('../src/corpus.js');
const { TOTAL_TIMEOUT_MS } = require('../src/university-rules.js');

const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
function seed(category, key, data) {
  fs.mkdirSync(path.join(dir, category), { recursive: true });
  fs.writeFileSync(path.join(dir, category, `${key}.json`), JSON.stringify(data));
}
const CATALOG = [
  { lawId: 1, historyId: 20, title: '여비규정', code: '4-1-1', revisedAt: '2026.09.01' },
  { lawId: 3, historyId: 40, title: '취업규칙', code: '3-1-1', revisedAt: '2025.01.02' },
  { lawId: 5, historyId: 50, title: '학부 장학규정', code: '3-6-2', revisedAt: '2026.03.13' },
  { lawId: 6, historyId: 60, title: '장학금 지급에 관한 시행세칙', code: '3-6-12', revisedAt: '2026.08.10' },
  { lawId: 7, historyId: 70, title: '강의료 지급규정', code: '3-7-9', revisedAt: '2026.03.13' },
  { lawId: 8, historyId: 80, title: '등록금에 관한 시행세칙', code: '2-3-1', revisedAt: '2026.01.01' },
];
const CONTENT = {
  '1_20': { title: '여 비 규 정', markdown: '### 제1조(목적)\n이 규정은 교직원의 출장 여비를 정한다.\n### 제9조(일비 등의 지급)\n① 일비, 숙박비, 식비의 지급액은 총장이 따로 정한다.\n② 일비는 출장지에서의 교통비를 포함한다.\n### 제10조(일비 등의 감액)\n근무지역 인접 출장의 일비는 1/2을 지급한다.' },
  '3_40': { title: '취업규칙', markdown: '### 제50조(출장)\n출장 명령을 받은 직원에게는 「여비규정」에 따라 여비를 지급한다.' },
  '5_50': { title: '학부 장학규정', markdown: '### 제3조(지급대상)\n교내에서 근로를 제공하는 사람\n### 제15조(이중수혜 금지)\n근로장학금은 등록금을 초과하여 받을 수 있다. 성적 기준은 세칙에 따른다.' },
  '6_60': { title: '장학금 지급에 관한 시행세칙', markdown: '### 제7조(근로장학금)\n① 경제사정이 곤란한 자에게 근로장학금을 지급할 수 있다.\n④ 수혜자는 직전 학기 성적 평균평점이 2.0 이상이어야 한다. 성적 기준은 매 학기 정한다.' },
  '7_70': { title: '강의료 지급규정', markdown: '### 제3조(지급 기준)\n특강 강사의 강의료 지급 기준은 별표와 같다.' },
  '8_80': { title: '등록금에 관한 시행세칙', markdown: '### 제7조(반환)\n수강료와 등록금의 반환 기준을 정한다.' },
};
// Synthetic rules: three strong body matches compete with a title-only rule;
// scope-ambiguous editions must retain separate bodies and their own scores.
const extraRules = [
  [11, '처리규정 가', '제1조(절차)\n물품 전결 처리'],
  [12, '처리규정 나', '제1조(절차)\n물품 전결 처리'],
  [13, '처리규정 다', '제1조(절차)\n물품 전결 처리'],
  [14, '위임전결규정', '제1조(목적)\n권한의 배분은 별표에 따른다.'],
  [21, '직원인사규정', '제1조(목적)\n육아휴직을 정한다.\n\n제9조(육아휴직 기간)\n육아휴직 기간 기준을 정한다.'],
  [22, 'WISE캠퍼스 직원인사규정', '제9조(육아휴직 기간)\n육아휴직 기간 기준을 정한다.'],
  [23, '의학계열 직원인사규정', '제9조(육아휴직 기간)\n육아휴직 기간 기준을 정한다.'],
  [24, '산학협력단 직원인사규정', '제9조(육아휴직 기간)\n육아휴직 기간 기준을 정한다.'],
  [25, '복무규정', '제9조(육아휴직 기간)\n육아휴직 기간 기준을 정한다.'],
  [31, '구매규정', '제3조(장비 구매)\n장비 구매 절차는 총장이 승인한다.'],
  [32, '산학협력단 구매규정', '제3조(장비 구매)\n장비 구매 절차는 산학협력단장이 승인한다.'],
  [33, 'WISE캠퍼스 구매규정', '제3조(장비 구매)\n장비 구매 절차는 WISE담당자가 승인한다.'],
  [34, 'WISE캠퍼스 산학협력단 구매규정', '제3조(장비 구매)\n장비 구매 절차는 WISE산학담당자가 승인한다.'],
  [35, '의학계열 구매규정', '제3조(장비 구매)\n장비 구매 절차는 의학담당자가 승인한다.'],
];
for (const [lawId, title, markdown] of extraRules) {
  const historyId = lawId * 10;
  CATALOG.push({ lawId, historyId, title, code: `test-${lawId}`, revisedAt: '2026.01.01' });
  CONTENT[`${lawId}_${historyId}`] = { title, markdown: markdown.replace(/(^|\n)(제\d+조)/g, '$1### $2') };
}
seed('catalog', 'all', CATALOG);
for (const [key, value] of Object.entries(CONTENT)) {
  value.markdown = value.markdown.replace(/\n(?=###)/g, '\n\n');
  seed('content-v4', key, value);
  const appendix = key === '1_20' ? '\n\n제10조의2(특례)\n가지조문고유내용\n\n<별표 1> 지급표\n\n| 항목 | 금액 |\n|---|---|\n| 합성 | 100원 |\n\n① 별표주석\n\n<별표 10> 다른 표\n\n다른표고유내용\n\n<별표 1의2> 가지 표\n\n가지표고유내용\n\n## 부칙\n\n### 제9조(시행일)\n2050년부터 시행한다.' : '';
  seed('original-structure-v2', key, { markdown: value.markdown + appendix, structure: { coverage: { articles: 'complete' } } });
}
for (const rule of CATALOG) seed('history', String(rule.lawId), [{ historyId: rule.historyId, revisedAt: rule.revisedAt }]);

let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`  ✅ ${name}`); }

async function main() {
  const corpus = await buildCorpus({ catalog: CATALOG, loadContent: async (lawId, historyId) => CONTENT[`${lawId}_${historyId}`] });
  saveCorpus(dir, corpus);

  const df = token => corpus.rules.filter(r => r.title.includes(token) || r.blocks.some(b => b.content.includes(token))).length;
  check('복합어 대체: 네 글자 이상은 앞 글자부터 제거', rewriteMissingToken('교내근로장학금', df, corpus.rules.length) === '근로장학금' && rewriteMissingToken('국내출장', df, corpus.rules.length) === '출장');
  check('복합어 대체: 세 글자는 앞 두 글자 유지(특강료→특강, 강료 아님)', rewriteMissingToken('특강료', df, corpus.rules.length) === '특강' && df('강료') > 0);
  check('복합어 대체: 두 글자·규정에 없는 말은 대체하지 않음', rewriteMissingToken('없음', df, corpus.rules.length) === null && rewriteMissingToken('zzzz', df, corpus.rules.length) === null);
  const scholarship = searchCorpus(corpus, '교내근로장학금 성적 기준', { top: 5 });
  check('색인 검색: 대체 단어 기록과 후보', scholarship.rewrittenTerms['교내근로장학금'] === '근로장학금' && scholarship.tokens.includes('근로장학금') && scholarship.hits.some(h => h.lawId === 6) && scholarship.hits.some(h => h.lawId === 5));
  const {businessTerms,generalRuleWeight,comparisonTerms}=require('../src/aliases.js');
  check('사전의 객체 원형 키도 일반 검색어로 처리', ['constructor','toString','__proto__'].every(t=>businessTerms(t).length===1 && searchCorpus(corpus,t+' 여비').hits.length>0));
  check('어간 동의어는 다른 말투에도 적용', ['잃어버렸는데','잃어버리면','잃어버린'].every(t=>businessTerms(t).includes('분실')) && businessTerms('출장갈때').includes('여비'));
  check('조문 제목으로 직접 연결하지 않는 업무 사전', !businessTerms('매달').includes('지급기일') && businessTerms('협조결재').length===1 && businessTerms('학점').length===1 && businessTerms('적립금').length===1);
  check('석사·박사·논문 질문은 대학원 감점 해제', ['석사 논문 심사 절차','박사과정 수료 학점','학위청구 논문'].every(q=>generalRuleWeight('일반대학원 학칙시행세칙',q)===1));
  check('짝 없는 캠퍼스 규정은 감점하지 않음', generalRuleWeight('WISE캠퍼스 아파트 관리내규','아파트 입주',false)===1 && generalRuleWeight('WISE캠퍼스 아파트 관리내규','아파트 입주',true)<1);
  check('비교 주제는 규정 이름 동의어만 확장', comparisonTerms('강사료').includes('강의료') && comparisonTerms('법카').includes('법인카드') && comparisonTerms('한도').length===1);
  const {extractRelevantBlocks}=require('../src/lookup.js');
  const preferred=extractRelevantBlocks('### 제2조(기준)\n강의료 지급 기준\n\n### 제8조(금액)\n강의료 지급 기준 100원 200원', '강의료', {maxBlocks:1,order:'relevance',priorityArticles:['제2조']});
  check('대표 조문을 발췌 한도 안에서 먼저 포함', preferred.text.includes('제2조(') && !preferred.text.includes('제8조('));
  const travel = searchCorpus(corpus, '국내출장 일비와 숙박비 한도', { top: 5 });
  check('색인 검색: 여비규정이 1위, 한도는 없는 단어', travel.hits[0].lawId === 1 && travel.hits[0].articles[0].article === '제9조' && travel.missingTerms.includes('한도') && travel.rewrittenTerms['국내출장'] === '출장');

  const server = createServer({ profile: 'rules' });
  const client = new Client({ name: 'lookup-index', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { sc: r.structuredContent, text: r.content.find(c => c.type === 'text')?.text || '' }; };
  try {
    const info = await call('get_service_info', {});
    check('서비스 정보의 타대학 비교 시간 제한은 모듈 상수와 같음', info.sc.data.integrations.universityComparison.totalTimeoutMs === TOTAL_TIMEOUT_MS && info.sc.data.fullTextIndex.available === true);

    searches.length = 0;
    const travelLookup = await call('lookup_dongguk_rule', { query: '국내출장 일비와 숙박비 한도' });
    check('자연어 질문: 색인으로 여비규정을 미리보기로 반환', travelLookup.sc.ok === true && travelLookup.sc.data.search.mode === '핵심어 색인' && travelLookup.sc.data.search.identityStatus === 'candidate_preview' && travelLookup.sc.data.rules[0].lawId === 1);
    check('미리보기는 근거 미확정(partial)과 다른 후보를 표시', travelLookup.sc.data.rules[0].evidenceStatus === 'partial' && travelLookup.sc.data.rules[0].incompleteReasons.includes('RULE_IDENTITY_UNCONFIRMED') && /다른 후보: .*취업규칙\(LAW_ID 3\)/.test(travelLookup.text) && /제9조\(일비 등의 지급\)/.test(travelLookup.text));
    check('MCP 자동 발췌는 동번호 부칙을 검색어로 추가하지 않음', !travelLookup.sc.data.rules[0].excerpt.text.includes('2050년') && !travelLookup.sc.data.rules[0].excerpt.text.includes('시행일'));
    check('색인 기준·대체 단어를 본문에 표시', /색인 기준: /.test(travelLookup.text) && /짧게 바꿔 찾은 단어: 국내출장→출장/.test(travelLookup.text) && /어느 규정에도 없는 단어: 한도/.test(travelLookup.text));
    check('색인 경로에서는 전문검색을 요청하지 않음', !searches.some(s => s.type === 'CONTENTS'));

    const query = '국내출장 일비와 숙박비 한도';
    for (const [label, args, expectedTerms] of [
      ['명시 조문', { query, terms: '제10조' }, '제10조'],
      ['명시 주제', { query, terms: '감액' }, '감액'],
      ['질문 조문', { query: '국내출장 일비와 숙박비 제10조' }, null],
    ]) {
      const lookup = await call('lookup_dongguk_rule', { ...args, max_sections: 1 });
      const data = lookup.sc.data, excerpt = data.rules[0].excerpt.text;
      check(`I1 ${label}: 색인 후보와 별개로 제10조 감액을 발췌`, data.search.mode === '핵심어 색인' && excerpt.includes('제10조(') && !excerpt.includes('제9조(') && !excerpt.includes('제10조의2'));
      check(`I1 ${label}: effectiveTerms에 요청 조건 보존`, expectedTerms ? data.query.effectiveTerms === expectedTerms : data.query.effectiveTerms.includes('제10조'));
    }
    for (const args of [{ query, terms: '제 10 조 의 2' }, { query: query + ' 제 10 조 의 2' }]) {
      const lookup = await call('lookup_dongguk_rule', { ...args, max_sections: 1 });
      check('가지조문 선택자는 명시 terms와 질문 모두에서 보존', lookup.sc.data.rules[0].excerpt.text.includes('가지조문고유내용') && !lookup.sc.data.rules[0].excerpt.text.includes('제9조('));
    }
    for (const args of [{ query, terms: '별 표 제1호' }, { query: query + ' 별 표 제1호' }]) {
      const lookup = await call('lookup_dongguk_rule', { ...args, max_sections: 1 });
      const excerpt = lookup.sc.data.rules[0].excerpt.text;
      check('별표 선택자 기존 동작: 번호·주석 보존, 다른 번호와 가지표 제외', excerpt.includes('100원') && excerpt.includes('별표주석') && !excerpt.includes('다른표고유내용') && !excerpt.includes('가지표고유내용'));
    }
    const branchAppendix = await call('lookup_dongguk_rule', { query, terms: '별표 1의2', max_sections: 1 });
    check('명시 가지별표도 검색어 확장 없이 선택', branchAppendix.sc.data.rules[0].excerpt.text.includes('가지표고유내용') && !branchAppendix.sc.data.rules[0].excerpt.text.includes('100원'));
    const missingExcerpt = await call('lookup_dongguk_rule', { query, terms: '존재하지않는발췌어' });
    check('없는 명시 terms를 색인 검색어로 대체하지 않음', missingExcerpt.sc.data.rules[0].excerpt.text === '' && missingExcerpt.sc.data.rules[0].incompleteReasons.includes('NO_MATCHING_EXCERPT'));
    const override = await call('lookup_dongguk_rule', { query: query + ' 제9조', terms: '감액', max_sections: 1 });
    check('명시 terms는 질문의 조문보다 우선', override.sc.data.query.effectiveTerms === '감액' && override.sc.data.rules[0].excerpt.text.includes('제10조('));

    const scholarshipLookup = await call('lookup_dongguk_rule', { query: '교내근로장학금 성적 기준' });
    const previews = scholarshipLookup.sc.data?.rules || [];
    check('비슷한 후보가 여럿이면 선택 요청 대신 후보별 해당 조문을 미확정 미리보기로 반환', scholarshipLookup.sc.ok === true && scholarshipLookup.sc.data.search.selection === 'multiple_candidates' && scholarshipLookup.sc.data.search.identityStatus === 'candidate_preview' && previews.some(r => r.lawId === 6) && previews.some(r => r.lawId === 5));
    check('여러 후보 미리보기는 모두 근거 미확정(partial)', scholarshipLookup.sc.data.evidenceStatus === 'partial' && previews.every(r => r.evidenceStatus === 'partial' && r.incompleteReasons.includes('RULE_IDENTITY_UNCONFIRMED')) && /적용할 규정이 확정된 결과가 아닙니다/.test(scholarshipLookup.text));
    check('미리보기에 대체 단어 안내', /교내근로장학금→근로장학금/.test(scholarshipLookup.text));
    const verb = searchCorpus(corpus, '장학금 이중 수혜하려면 어떻게 해?', { top: 3 });
    check('동사 어미·의문사는 핵심어가 아니고 붙여 쓴 규정 표현(이중수혜)을 찾음', !verb.tokens.some(t => /하려면|어떻게/.test(t)) && verb.searchTerms.includes('이중수혜') && verb.hits[0].lawId === 5 && verb.hits[0].articles[0].article === '제15조');
    const vocabulary = searchCorpus(corpus, '특강료 환불 기준', { top: 3 });
    check('일상어는 규정 용어로도 찾음(특강료→강의료, 환불→반환)', vocabulary.searchTerms.includes('강의료') && vocabulary.searchTerms.includes('반환') && vocabulary.hits.some(h => h.lawId === 7) && vocabulary.hits.some(h => h.lawId === 8));

    const chosen = await call('lookup_dongguk_rule', { query: '교내근로장학금 성적 기준', law_id: 6 });
    check('law_id 선택 뒤에는 확정 조회', chosen.sc.ok === true && chosen.sc.data.search.identityStatus === 'explicit_id' && chosen.sc.data.rules[0].lawId === 6);

    const titled = await call('lookup_dongguk_rule', { query: '등록금에 관한 시행세칙 제7조 반환' });
    check('규정명이 든 질문은 색인보다 현행 목록 제목으로 확정', titled.sc.ok === true && titled.sc.data.search.identityStatus === 'catalog_title' && titled.sc.data.rules[0].lawId === 8);

    const unanchored = searchCorpus(corpus, '물품 전결', { top: 5 }).hits;
    check('제목 후보 회귀 조건: 위임전결규정은 본문 점수로는 4위', unanchored[3].lawId === 14 && unanchored[3].articles.length === 0);
    const anchored = await call('lookup_dongguk_rule', { query: '물품 전결은 누가 해?' });
    const anchoredRules = anchored.sc.data.rules;
    check('질문 단어가 규정명에 있는 후보를 상위 3개 미리보기에 보존', anchoredRules.length === 3 && anchoredRules[0].lawId === 11 && anchoredRules[2].lawId === 14);
    check('제목만 일치한 후보는 발췌 없음과 규정 미확정을 함께 표시', anchoredRules[2].incompleteReasons.includes('NO_MATCHING_EXCERPT') && anchoredRules[2].incompleteReasons.includes('RULE_IDENTITY_UNCONFIRMED'));

    const family = await call('lookup_dongguk_rule', { query: '육아휴직 기간' });
    const general = family.sc.data.rules.find(r => r.lawId === 21);
    check('범위 미지정은 일반판 우선, 적용범위가 다른 판도 별도 미확정 후보로 보존', family.sc.data.rules.length === 3 && family.sc.data.rules.map(r=>r.lawId).join(',') === '21,25,23' && family.sc.data.search.selection === 'multiple_candidates');
    check('미리보기 한도 밖의 다른 판도 LAW_ID와 제목 보존', general.editions.length === 3 && [22, 23, 24].every(id => general.editions.some(e => e.lawId === id && e.title === CATALOG.find(r => r.lawId === id).title)));
    check('자연어 발췌는 문서 순서보다 관련 조문 우선', general.excerpt.text.indexOf('제9조') < general.excerpt.text.indexOf('제1조') && general.excerpt.text.includes('제1조'));
    const wise = await call('lookup_dongguk_rule', { query: '육아휴직 기간', campus: 'wise' });
    const wiseRule = wise.sc.data.rules.find(r => r.lawId === 22);
    check('WISE 요청은 WISE 판을 대표로 선택하고 일반 판도 안내', !!wiseRule && wiseRule.editions.some(e => e.lawId === 21) && !wise.sc.data.rules.some(r => r.lawId === 21));
    check('캠퍼스 대표 선택도 적용 규정 확정으로 취급하지 않음', wise.sc.data.rules.every(r => r.evidenceStatus === 'partial' && r.incompleteReasons.includes('RULE_IDENTITY_UNCONFIRMED')));

    for (const [scopeQuery, campus, allowed, text] of [
      ['산학협력단 장비 구매 절차', undefined, [32, 34], '산학협력단장이'],
      ['산단 장비 구매 절차', undefined, [32, 34], '산학협력단장이'],
      ['와이즈 장비 구매 절차', undefined, [33, 34], 'WISE담당자가'],
      ['경주 장비 구매 절차', undefined, [33, 34], 'WISE담당자가'],
      ['의학계열 장비 구매 절차', undefined, [35], '의학담당자가'],
      ['WISE캠퍼스 산학협력단 장비 구매 절차', undefined, [34], 'WISE산학담당자가'],
      ['산학협력단 장비 구매 절차', 'wise', [34], 'WISE산학담당자가'],
      ['서울캠퍼스 산학협력단 장비 구매 절차', undefined, [32], '산학협력단장이'],
    ]) {
      const lookup = await call('lookup_dongguk_rule', { query: scopeQuery, ...(campus ? { campus } : {}) });
      const rules = lookup.sc.data.rules;
      check(`I2 명시 범위 우선: ${scopeQuery} / ${campus || 'all'}`, allowed.includes(rules[0].lawId) && rules[0].excerpt.text.includes(text) && !rules.some(r => r.lawId === 31) && rules.every(r => r.scopeMatch));
      check('범위 선택 후에도 미확정 상태 유지', rules.every(r => r.evidenceStatus === 'partial' && r.incompleteReasons.includes('RULE_IDENTITY_UNCONFIRMED')));
    }
    const scopeUnknown = await call('lookup_dongguk_rule', { query: '장비 구매 절차' });
    const scores = new Map(searchCorpus(corpus, '장비 구매 절차', { top: CATALOG.length }).hits.map(hit => [hit.lawId, hit.score]));
    check('일반판은 다른 판의 최고 점수를 상속하지 않음', scopeUnknown.sc.data.rules.some(r => r.lawId === 31) && scopeUnknown.sc.data.rules.every(r => r.score === scores.get(r.lawId)));
    check('기관 미지정은 여러 판의 실제 본문을 반환', scopeUnknown.sc.data.rules.length === 3 && scopeUnknown.sc.data.rules.some(r => r.excerpt.text.includes('산학협력단장이')));
    const campusConflict = await call('lookup_dongguk_rule', { query: 'WISE캠퍼스 산학협력단 장비 구매 절차', campus: 'seoul' });
    check('질문과 campus가 충돌하면 한 판으로 확정하지 않음', [32, 34].every(id => campusConflict.sc.data.rules.some(r => r.lawId === id)) && campusConflict.sc.data.search.selection === 'multiple_candidates');
    const explicitScope = await call('lookup_dongguk_rule', { query: '산학협력단 장비 구매 절차', law_id: 31 });
    check('명시 law_id는 범위 추정보다 우선', explicitScope.sc.data.search.identityStatus === 'explicit_id' && explicitScope.sc.data.rules.length === 1 && explicitScope.sc.data.rules[0].lawId === 31);
    const keywordScope = await call('lookup_dongguk_rule', { rule_keyword: '장비 구매', query: '산학협력단 장비 구매 절차' });
    check('짧은 rule_keyword와 함께 보낸 질문의 기관 범위도 보존', keywordScope.sc.data.rules[0].lawId === 32 && keywordScope.sc.data.rules.every(r => r.edition.includes('산학협력단')));
    const exactScope = await call('lookup_dongguk_rule', { query: '산학협력단 구매규정 장비 구매 절차' });
    check('정확한 기관 규정명은 색인 판 선택보다 우선', exactScope.sc.data.search.identityStatus === 'catalog_title' && exactScope.sc.data.rules.length === 1 && exactScope.sc.data.rules[0].lawId === 32);
    for (const max_rules of [1, 2, 3]) {
      const lookup = await call('lookup_dongguk_rule', { query: '교내근로장학금 성적 기준', max_rules });
      const data = lookup.sc.data;
      check(`R1 max_rules=${max_rules}: selection은 실제 반환 개수와 일치`, data.rules.length === (max_rules === 2 ? 2 : 3) && data.search.selection === 'multiple_candidates');
      check('다중 미리보기 제한과 본문 안내도 일치', data.query.maxSections === 3 && data.query.maxChars === 6000 && lookup.text.includes(`규정 ${data.rules.length}개`));
    }
    check('한 판만 반환하면 single_candidate', wise.sc.data.rules.length === 1 && wise.sc.data.search.selection === 'single_candidate');

    const named = await call('lookup_dongguk_rule', { query: '여비규정에서 밥값은 얼마 나와?' });
    check('규정 이름을 말한 질문도 일상어를 규정 용어로 읽어 조문 선택', named.sc.data.rules.length === 1 && named.sc.data.rules[0].lawId === 1 && named.sc.data.rules[0].excerpt.text.includes('제9조('));
    const explicitTerms = await call('lookup_dongguk_rule', { rule_keyword: '여비규정', terms: '밥값' });
    check('terms를 직접 준 조회는 검색어를 넓히지 않음', explicitTerms.sc.data.rules[0].lawId === 1 && !explicitTerms.sc.data.rules[0].excerpt.text.includes('제9조('));
    const oneWord = await call('lookup_dongguk_rule', { query: '숙박비' });
    check('제목 후보가 없는 한 낱말 질문은 색인으로 조회', oneWord.sc.ok === true && oneWord.sc.data.search.mode === '핵심어 색인' && oneWord.sc.data.rules[0].lawId === 1);

    fs.unlinkSync(corpusPath(dir));
    searches.length = 0;
    const fallback = await call('lookup_dongguk_rule', { query: '국내출장 일비와 숙박비 한도' });
    const contents = searches.filter(s => s.type === 'CONTENTS').map(s => s.text);
    check('색인이 없으면 전문검색: 전체 → 가장 긴 단어 제외 → 긴 단어와 끝 단어 제외 순', contents.length === 3 && contents[0] === '국내출장 일비 숙박비 한도' && contents[1] === '일비 숙박비 한도' && contents[2] === '일비 숙박비');
    check('전문검색 후보는 확정하지 않고 선택 요청', fallback.sc.error?.code === 'AMBIGUOUS_RULE' && fallback.sc.error.details.candidates[0].lawId === 1 && fallback.sc.error.details.searchMode === '핵심어 전문');
  } finally { await client.close(); await server.close(); }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`📊 자연어 조회·색인 후보 검증: ${passed}개 통과`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });

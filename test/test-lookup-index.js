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
seed('catalog', 'all', CATALOG);
for (const [key, value] of Object.entries(CONTENT)) {
  seed('content-v3', key, value);
  seed('original-structure-v2', key, { markdown: value.markdown, structure: { coverage: { articles: 'complete' } } });
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
    check('색인 기준·대체 단어를 본문에 표시', /색인 기준: /.test(travelLookup.text) && /짧게 바꿔 찾은 단어: 국내출장→출장/.test(travelLookup.text) && /어느 규정에도 없는 단어: 한도/.test(travelLookup.text));
    check('색인 경로에서는 전문검색을 요청하지 않음', !searches.some(s => s.type === 'CONTENTS'));

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

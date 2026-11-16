// check_rule_updates, get_rule_references and the local full-text index, offline.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-updates-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
let networkCalls = 0;
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => { networkCalls++; throw new Error('Network disabled in offline regression test'); };
const { createServer } = require('../src/index.js');
const { validateCatalog, isoDate, checkRuleUpdates } = require('../src/catalog.js');
const { createResolver, extractReferences, summarizeExternalLaws } = require('../src/references.js');
const { buildCorpus, saveCorpus, loadCorpus, searchCorpus, corpusCoverage } = require('../src/corpus.js');

const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
function seed(category, key, data) {
  fs.mkdirSync(path.join(dir, category), { recursive: true });
  fs.writeFileSync(path.join(dir, category, `${key}.json`), JSON.stringify(data));
}
const CATALOG = [
  { lawId: 1, historyId: 20, title: '여비규정', code: '4-1-1', revisedAt: '2026.09.01' },
  { lawId: 2, historyId: 31, title: '위임전결규정', code: '1-1-1', revisedAt: '2026.08.15' },
  { lawId: 3, historyId: 40, title: '취업규칙', code: '3-1-1', revisedAt: '2025.01.02' },
  { lawId: 4, historyId: 50, title: 'WISE캠퍼스 위임전결규정', code: '1-1-2', revisedAt: '' },
];
const CONTENT = {
  '1_20': { title: '여 비 규 정', markdown: '### 제1조(목적)\n이 규정은 「취업규칙」 제50조에 따라 여비를 정한다.\n### 제2조(숙박비)\n국내 출장 숙박비는 「별표1」에 따르며 소득세법 제12조의 비과세 범위는 따로 확인한다.\n### 제3조(준용)\n「사학기관 재무ㆍ회계 규칙에 대한 특례규칙」과 「사학기관 재무회계 규칙에 대한 특례규칙」 및 「국가를 당사자로 하는 계약에 관한 법률 시행령」(이하 "시행령"이라 한다) 제26조를 준용하는 방법은 총장이 정한다.' },
  '2_31': { title: '위임전결규정', markdown: '### 제1조(목적)\n출장 결재는 「여비규정」 제2조와 WISE캠퍼스 위임전결규정 제3조를 따른다.' },
  '3_40': { title: '취업규칙', markdown: '### 제50조(출장)\n출장 명령을 받은 직원에게는 「여비규정」에 따라 여비를 지급한다.\n## 부칙 (2025.1.2.)\n### 제1조(시행일)\n이 규칙은 공포한 날부터 시행한다.' },
  '4_50': { title: 'WISE캠퍼스 위임전결규정', markdown: '전결 사항은 총장이 따로 정한다.' },
};
seed('catalog', 'all', CATALOG);
for (const [key, value] of Object.entries(CONTENT)) seed('content-v3', key, value);
for (const rule of CATALOG) seed('history', String(rule.lawId), [{ historyId: rule.historyId, revisedAt: rule.revisedAt }]);

let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`  ✅ ${name}`); }

async function main() {
  // --- pure logic ---
  const manyHits = Array.from({ length: 120 }, (_, i) => ({ lawId: i + 1, historyId: i + 1000, title: `규정${i}`, revisedAt: '2026.01.01' }));
  check('전체 목록 검증 통과', validateCatalog({ total: 120, hits: manyHits }).length === 120);
  assert.throws(() => validateCatalog({ total: 515, hits: manyHits }), /응답 형식/); passed++;
  assert.throws(() => validateCatalog({ total: 3, hits: manyHits.slice(0, 3) }), /응답 형식/); passed++;
  console.log('  ✅ 잘린 목록·비정상 목록은 거부');
  check('날짜 정규화', isoDate('2026.11.6') === '2026-11-06' && isoDate('2026-02-30') === null && isoDate('') === null);
  const updates = checkRuleUpdates({ catalog: CATALOG, lawIds: [1, 2, 3, 99, 1], previous: { 1: 10, 2: 31, 99: 7 }, since: '2026-08-15' });
  const status = Object.fromEntries(updates.results.map(x => [x.lawId, x.status]));
  check('개정됨·변동 없음·첫 확인·확인 불가 구분', status[1] === 'changed' && status[2] === 'unchanged' && status[3] === 'first_seen' && status[99] === 'unknown');
  check('중복 LAW_ID 제거', updates.results.length === 4 && updates.coverage.requested === 4 && updates.coverage.failed === 1);
  check('확인 불가 항목은 이전 스냅샷 유지', updates.nextSnapshot[99] === 7 && updates.nextSnapshot[1] === 20);
  check('기준일 이후 개정 목록은 최신순', updates.recent.total === 2 && updates.recent.rules[0].lawId === 1 && updates.recent.undatedRules === 1);

  const resolver = createResolver(CATALOG, { lawId: 1, title: '여비규정' });
  const refs = extractReferences(CONTENT['1_20'].markdown, resolver);
  const by = name => refs.find(x => x.name === name);
  check('교내 규정 인용과 조문', by('취업규칙')?.scope === 'dongguk_rule' && by('취업규칙').target.lawId === 3 && by('취업규칙').article === '제50조');
  check('별표는 인용으로 세지 않음', !refs.some(x => x.name.startsWith('별표')));
  check('낫표 없는 법령명과 조문', by('소득세법')?.scope === 'external_law' && by('소득세법').article === '제12조' && by('소득세법').resolutionStatus === 'name_heuristic');
  check('"방법"을 법령으로 보지 않음', !refs.some(x => /방법/.test(x.name)));
  check('약칭 정의 괄호 뒤의 조문 연결', by('국가를 당사자로 하는 계약에 관한 법률 시행령')?.article === '제26조');
  check('목록에 없는 규칙은 미확정 + 외부 후보', by('사학기관 재무ㆍ회계 규칙에 대한 특례규칙')?.scope === 'unresolved' && by('사학기관 재무ㆍ회계 규칙에 대한 특례규칙').externalCandidate === true);
  const laws = summarizeExternalLaws(refs);
  check('가운뎃점만 다른 법령명은 하나로 묶음', laws.filter(x => x.lawName.includes('특례규칙')).length === 1 && laws.length === 3);
  const longest = extractReferences(CONTENT['2_31'].markdown, createResolver(CATALOG, { lawId: 2, title: '위임전결규정' }));
  check('낫표 없는 규정명은 가장 긴 제목으로 연결', longest.some(x => x.target.lawId === 4 && x.article === '제3조' && x.resolutionStatus === 'name_heuristic') && !longest.some(x => x.scope === 'same_rule'));

  let loads = 0;
  const loadContent = async (lawId, historyId) => { loads++; if (lawId === 4 && loads < 10) throw new Error('down'); return CONTENT[`${lawId}_${historyId}`]; };
  const first = await buildCorpus({ catalog: CATALOG, loadContent });
  check('색인 생성: 실패 규정은 누락으로 기록', first.rules.length === 3 && first.failed[0].lawId === 4 && corpusCoverage(first).complete === false);
  loads = 10;
  const second = await buildCorpus({ catalog: CATALOG.map(r => r.lawId === 1 ? { ...r, historyId: 20 } : r), loadContent, previous: first });
  check('색인 갱신: 바뀌지 않은 규정은 재사용', second.reused === 3 && loads === 11 && corpusCoverage(second).complete === true);
  await assert.rejects(buildCorpus({ catalog: CATALOG.slice(0, 1), loadContent, previous: { catalogTotal: 500, rules: [] } }), /크게 줄었습니다/); passed++;
  console.log('  ✅ 규정 수 급감 시 색인 덮어쓰기 거부');
  const found = searchCorpus(second, '출장 숙박비 상한은?', { top: 2 });
  check('색인 검색: 일부 단어만 맞아도 후보 반환, 없는 단어 표시', found.hits[0].lawId === 1 && found.hits[0].articles[0].article === '제2조' && found.missingTerms.includes('상한'));
  check('조문 없는 내규도 색인', second.rules.find(r => r.lawId === 4).blocks.length === 1);

  // --- through the MCP server ---
  const server = createServer({ profile: 'rules' });
  const client = new Client({ name: 'updates', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  try {
    const tools = (await client.listTools()).tools.map(t => t.name);
    check('새 도구 등록', tools.includes('check_rule_updates') && tools.includes('get_rule_references') && tools.length === 12);
    for (const args of [{}, { law_ids: [] }, { law_ids: [1.5] }, { law_ids: 'x' }, { since: '2026-13-01' }, { law_ids: [1], previous: [1] }, { law_ids: [1], previous: { a: 1 } }]) {
      check(`잘못된 입력 거부: ${JSON.stringify(args)}`, (await call('check_rule_updates', args)).error.code === 'INVALID_ARGUMENT');
    }
    const checked = await call('check_rule_updates', { law_ids: [1, 2], previous: { 1: 10, 2: 31 } });
    check('check_rule_updates: 캐시된 목록으로 판정', checked.ok && checked.data.results[0].status === 'changed' && checked.data.results[1].status === 'unchanged' && checked.data.nextSnapshot['1'] === 20);

    const noIndex = await call('get_rule_references', { law_id: 1, direction: 'both' });
    check('색인 없으면 역방향은 미조회·partial', noIndex.ok && noIndex.data.coverage.incoming.code === 'INDEX_UNAVAILABLE' && noIndex.data.evidenceStatus === 'partial' && noIndex.data.counts.outgoing >= 4);
    check('색인 전용 검색은 색인 없음 오류', (await call('search_rule_deep', { query: '숙박비', mode: 'index' })).error.code === 'INDEX_UNAVAILABLE');
    check('잘못된 mode 거부', (await call('search_rule_deep', { query: '숙박비', mode: 'fast' })).error.code === 'INVALID_ARGUMENT');

    saveCorpus(dir, second);
    check('색인 저장·재로드', loadCorpus(dir).rules.length === 4);
    const both = await call('get_rule_references', { law_id: 1, direction: 'both' });
    const incoming = both.data.references.filter(x => x.direction === 'incoming');
    check('역방향: 여비규정을 인용한 규정과 조문 위치', incoming.length === 2 && incoming.some(x => x.sourceLocation.lawId === 3 && x.sourceLocation.article === '제50조') && both.data.evidenceStatus === 'retrieved');
    check('한국법령 조회용 법령 목록', both.data.externalLaws.some(x => x.lawName === '소득세법' && x.articles[0] === '제12조'));
    const article = await call('get_rule_references', { law_id: 1, article: 2, direction: 'both' });
    check('조문 지정: 그 조문의 인용과 그 조문을 가리킨 인용만', article.data.references.filter(x => x.direction === 'outgoing').every(x => x.sourceLocation.article === '제2조') && article.data.references.filter(x => x.direction === 'incoming').length === 1);
    check('없는 조문', (await call('get_rule_references', { law_id: 1, article: 99 })).error.code === 'NOT_FOUND');
    check('잘못된 direction', (await call('get_rule_references', { law_id: 1, direction: 'up' })).error.code === 'INVALID_ARGUMENT');

    const deep = await call('search_rule_deep', { query: '출장 숙박비', top: 2 });
    check('색인 검색: 현행 개정본과 대조', deep.ok && deep.data.searchMode === 'index' && deep.data.documents[0].lawId === 1 && deep.data.documents[0].versionCheck === 'current' && deep.data.evidenceStatus === 'retrieved');

    // The rule was revised after the index was built: the current text must be re-read.
    seed('catalog', 'all', CATALOG.map(r => r.lawId === 1 ? { ...r, historyId: 21, revisedAt: '2026.11.01' } : r));
    seed('content-v3', '1_21', { title: '여비규정', markdown: '### 제2조(숙박비)\n국내 출장 숙박비는 실비로 한다.' });
    const refreshed = await call('search_rule_deep', { query: '출장 숙박비', top: 1 });
    check('색인 이후 개정된 규정은 현행 본문으로 교체', refreshed.data.documents[0].versionCheck === 'refetched' && refreshed.data.documents[0].historyId === 21 && refreshed.data.documents[0].articles[0].content.includes('실비'));

    seed('catalog', 'all', CATALOG.filter(r => r.lawId !== 1));
    const gone = await call('search_rule_deep', { query: '출장 숙박비', top: 1 });
    check('현행 목록에 없는 규정은 partial', gone.data.documents[0].versionCheck === 'not_in_current_catalog' && gone.data.evidenceStatus === 'partial');

    const info = await call('get_service_info', {});
    check('서비스 정보에 색인 상태', info.data.toolCount === 12 && info.data.fullTextIndex.available === true && info.data.fullTextIndex.indexedRules === 4);
    check('외부 요청 없음', networkCalls === 0);
  } finally { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  console.log(`📊 개정 점검·인용 관계·전문 색인 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exit(1); });

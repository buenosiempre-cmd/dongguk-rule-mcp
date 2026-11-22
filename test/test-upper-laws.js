// get_rule_upper_laws: citation extraction, law identity checks and review signals, offline.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-upperlaw-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
for (const key of ['DONGGUK_LEGAL_MCP_ENABLED', 'DONGGUK_LEGAL_MCP_TRANSPORT', 'DONGGUK_LEGAL_MCP_URL', 'DONGGUK_LEGAL_MCP_BEARER_TOKEN', 'DONGGUK_PUBLIC_LAW_LINK', 'LAW_OC']) delete process.env[key];
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => { throw new Error('Network disabled in offline regression test'); };
const { createServer } = require('../src/index.js');
const { createHttpServer } = require('../src/http-server.js');
const { closeLegalClient, inspectLaws, articleFacts } = require('../src/legal-client.js');
const { createResolver, extractReferences, summarizeExternalLaws } = require('../src/references.js');
const { planLaws, signalsFor, topicCandidates, latestAnnotatedDate } = require('../src/upper-laws.js');
const { titleInQuery, withoutRuleName } = require('../src/lookup.js');

const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
function seed(category, key, data) {
  fs.mkdirSync(path.join(dir, category), { recursive: true });
  fs.writeFileSync(path.join(dir, category, `${key}.json`), JSON.stringify(data));
}
seed('catalog', 'all', Array.from({ length: 120 }, (_, i) => ({ lawId: i + 1, historyId: 20, title: ['재무회계규정', '여비규정', '교원인사규정'][i] || `합성규정${i}`, code: '', revisedAt: '2021.03.02' })));
for (const id of [1, 2]) seed('history', String(id), [{ historyId: 20, revisedAt: '2021.03.02' }]);
seed('content-v3', '1_20', { title: '재무회계규정', markdown: [
  '### 제7조(자금의 관리)', '사립학교법 제32조의2 제3항에 따른 기금은 심의를 거친다.(2018.11.12. 개정)',
  '### 제9조(회계처리)', '회계는 「사학기관 재무ㆍ회계 규칙에 대한 특례규칙」 제5조에 따른다.',
  '### 제29조(평가)', '시가는 『지가공시 및 토지 등의 평가에 관한 법률』에 의한 감정평가액으로 하되 동법 제4조를 따른다.',
  '### 제30조(훈련)', '「향토예비군설치법」 제6조와 「없는가상법」 제1조, 「교원인사규정」 제3조를 따른다.',
  '### 제31조(예산)', '「사립학교법」 제29조, 제31조 및 제99조에 따른다.',
].join('\n') });
seed('content-v3', '2_20', { title: '여비규정', markdown: '### 제1조(목적)\n이 규정은 여비를 정한다.' });

// Synthetic law listing in the provider's format. Dates are fixture values, not real law data.
const LAWS = {
  사립학교법: { id: '000888', mst: '9001', promulgated: '20240101', effective: '20240301', kind: '법률',
    articles: { 제29조: '제29조(회계의 구분)\n①학교법인의 회계는 구분한다. <개정 2020.3.24>', 제31조: '제31조 삭제 <2022.1.4>', '제32조의2': '제32조의2(적립금)\n①적립할 수 있다. <개정 2019.4.16>' } },
  '사학기관 재무ㆍ회계 규칙에 대한 특례규칙': { id: '007333', mst: '9002', promulgated: '20230531', effective: '20230601', kind: '교육부령',
    articles: { 제5조: '제5조 회계원칙\n회계는 복식부기로 한다.' } },
  '부동산 가격공시에 관한 법률': { id: '001827', mst: '9003', promulgated: '20200609', effective: '20201210', kind: '법률',
    articles: { 제4조: '제4조 표준지공시지가의 조사협조\n장관은 요구할 수 있다. <개정 2020.6.9>' } },
  예비군법: { id: '001619', mst: '9004', promulgated: '20200101', effective: '20200201', kind: '법률', articles: { 제6조: '제6조(훈련)\n훈련을 받는다.' } },
  소득세법: { id: '001565', mst: '9005', promulgated: '20200101', effective: '20200201', kind: '법률', articles: {} },
  '소득세법 시행령': { id: '003956', mst: '9006', promulgated: '20200101', effective: '20200201', kind: '대통령령', articles: {} },
  '공무원 여비 규정': { id: '009402', mst: '9007', promulgated: '20200101', effective: '20200201', kind: '대통령령', articles: {} },
  '근로자퇴직급여 보장법': { id: '009883', mst: '9008', promulgated: '20200101', effective: '20200201', kind: '법률', articles: { 제8조: '제8조(퇴직금제도의 설정 등)\n①퇴직금을 지급한다.' } },
};
const RENAMED = { '지가공시및토지등의평가에관한법률': ['지가공시및토지등의평가에관한법률', '부동산 가격공시에 관한 법률'], 향토예비군설치법: ['향토예비군 설치법', '예비군법'] };
const flat = value => String(value).replace(/[\sㆍ·]/g, '');
const listing = names => names.map((name, i) => { const law = LAWS[name]; return `${i + 1}. ${name} [현행]\n   - 법령ID: ${law.id}\n   - MST: ${law.mst}\n   - 공포일: ${law.promulgated} / 시행일: ${law.effective}\n   - 구분: ${law.kind}\n`; }).join('\n');
const lawCalls = [];
let mode = 'ok';
function lawTool(name, a) {
  lawCalls.push({ name, args: a });
  const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
  if (mode === 'empty') return text('');
  if (mode === 'maintenance') return text('<html><body>시스템 점검 중입니다</body></html>');
  if (name === 'search_law') {
    const exact = Object.keys(LAWS).find(x => flat(x) === flat(a.query));
    if (exact) return text(`검색 결과 (총 1건):\n\n${listing([exact])}${exact === '예비군법' ? '' : ''}`);
    const renamed = RENAMED[flat(a.query)];
    if (renamed) return text(`검색 결과 (총 1건):\n\n${listing([renamed[1]])}\n🔜 「${renamed[1]}」 개정 시행예정 (일부개정, 2026-06-09 공포 제21770호, 시행 2026-12-10) — 시행예정본\n📛 「${renamed[0]}」은(는) 옛 법령명입니다 — 제명이 바뀌어 현행은 「${renamed[1]}」(법령ID ${LAWS[renamed[1]].id}, MST ${LAWS[renamed[1]].mst})입니다.`);
    const partial = Object.keys(LAWS).filter(x => flat(x).includes(flat(a.query)));
    if (partial.length) return text(`검색 결과 (총 ${partial.length}건):\n\n${listing(partial)}\n⚠️ 정확매칭 없음`);
    return text(`[NOT_FOUND] 법령 '${a.query}' 검색 결과가 없습니다.`, true);
  }
  if (name === 'get_law_text') {
    const entry = Object.entries(LAWS).find(([, law]) => law.mst === String(a.mst));
    const head = `법령명: ${entry[0]}\n공포일: ${entry[1].promulgated}\n시행일: ${entry[1].effective}\n\n`;
    const body = entry[1].articles[a.jo];
    return body ? text(head + body + '\n') : text(`${head}[NOT_FOUND] 조문 내용을 찾을 수 없습니다.`, true);
  }
  throw new Error('unexpected');
}
const injected = { callTool: async ({ name, arguments: a }) => lawTool(name, a) };
function lawFixture() {
  const server = new Server({ name: 'korean-law-fixture', version: 'test' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['search_law', 'get_law_text'].map(name => ({ name, inputSchema: { type: 'object' } })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => lawTool(request.params.name, request.params.arguments));
  return server;
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`); }

async function main() {
  const resolver = createResolver([{ lawId: 3, title: '교원인사규정', historyId: 1 }], { lawId: 1, title: '재무회계규정' });
  const refs = text => extractReferences(text, resolver).map(x => `${x.scope}|${x.name}|${x.article || ''}|${x.resolutionStatus}`);

  await check('조문 나열과 항 번호', async () => {
    const found = extractReferences('「사립학교법」 제29조, 제31조 및 제32조의2제3항에 따른다.', resolver);
    assert.deepEqual(found.map(x => x.article), ['제29조', '제31조', '제32조의2']);
    assert.equal(found[2].paragraph, '제3항');
    assert.deepEqual(refs('「학칙」 제5조 및 「사립학교법」 제53조의2와 제54조').slice(1), ['external_law|사립학교법|제53조의2|quoted_name', 'external_law|사립학교법|제54조|quoted_name']);
  });
  await check('동법·같은 법은 바로 앞 법령으로 연결', async () => {
    assert.deepEqual(refs('「고등교육법」 제11조 및 같은 법 시행령 제4조의2'), ['external_law|고등교육법|제11조|quoted_name', 'external_law|고등교육법 시행령|제4조의2|anaphora']);
    assert.deepEqual(refs('소득세법 제12조 및 같은 법 제13조'), ['external_law|소득세법|제12조|name_heuristic', 'external_law|소득세법|제13조|anaphora']);
    assert.deepEqual(refs('「소득세법」 제12조. 같은 법 제13조. 「법인세법」 제19조. 같은 법 제20조.').slice(2), ['external_law|법인세법|제19조|quoted_name', 'external_law|법인세법|제20조|anaphora']);
    assert.deepEqual(refs('이 법 제3조와 관계 법 제5조, 동법 제4조'), []);
  });
  await check('약칭은 정의한 뒤에만 연결', async () => {
    assert.deepEqual(refs('시행령 제1조. 「소득세법 시행령」(이하 "시행령"이라 한다) 제2조. 시행령 제3조 및 제5조.'),
      ['external_law|소득세법 시행령|제2조|quoted_name', 'external_law|소득세법 시행령|제3조|defined_abbreviation', 'external_law|소득세법 시행령|제5조|defined_abbreviation']);
  });
  await check('띄어 쓴 법령명과 법령이 아닌 말', async () => {
    assert.deepEqual(refs('소득세법 시행령 제12조제3호 및 근로자퇴직급여 보장법 제8조'), ['external_law|소득세법 시행령|제12조|name_heuristic', 'external_law|근로자퇴직급여 보장법|제8조|name_heuristic']);
    assert.deepEqual(refs('이 경우 국가를 당사자로 하는 계약에 관한 법률 제7조에 따른다.'), ['external_law|국가를 당사자로 하는 계약에 관한 법률|제7조|name_heuristic']);
    assert.deepEqual(refs('성과의 평가방법 제5조에 따라 심사하고 처리기법 제2조를 따른다.'), []);
    const laws = summarizeExternalLaws(extractReferences('근로자퇴직급여 보장법 제8조와 「사립학교법」 제29조', resolver));
    assert.equal(laws.find(x => x.lawName === '근로자퇴직급여 보장법').nameGuessed, true);
    assert.equal(laws.find(x => x.lawName === '사립학교법').nameGuessed, undefined);
  });

  await check('법령 식별: 현행, 제명 변경, 시행예정, 목록에 없음', async () => {
    const result = await inspectLaws([{ name: '사립학교법', articles: [] }, { name: '향토예비군설치법', articles: [] }, { name: '없는가상법', articles: [] }], { client: injected });
    assert.equal(result.status, 'retrieved');
    assert.deepEqual(result.laws.map(x => x.identity.status), ['current', 'renamed', 'not_found']);
    assert.deepEqual([result.laws[0].identity.kind, result.laws[0].identity.effectiveAt, result.laws[0].identity.mst], ['법률', '2024-03-01', '9001']);
    assert.equal(result.laws[1].identity.name, '예비군법');
    assert.equal(result.laws[1].identity.renamedFrom, '향토예비군 설치법');
    assert.deepEqual(result.laws[1].identity.pendingAmendments, [{ kind: '일부개정', promulgatedAt: '2026-06-09', effectiveAt: '2026-12-10' }]);
  });
  await check('조문 상태: 있음·삭제·없음, 개정 표시일', async () => {
    const result = await inspectLaws([{ name: '사립학교법', articles: ['제29조', '제31조', '제99조'] }], { client: injected });
    const [found, deleted, missing] = result.laws[0].articles;
    assert.deepEqual([found.status, found.title, found.lastAmendedAt, found.versionCheck], ['found', '회계의 구분', '2020-03-24', 'matches_listing']);
    assert.equal(deleted.status, 'deleted');
    assert.deepEqual([missing.status, missing.code], ['missing', 'LEGAL_ARTICLE_MISSING']);
    assert.deepEqual(articleFacts('법령명: X\n\n제15조 서류\n제15조(서류)\n①본문 <개정 1976.1.7, 2019.9.17>\n7. 삭제<1999.1.29>\n', '제15조').amendedDates, ['1976-01-07', '1999-01-29', '2019-09-17']);
  });
  await check('빈 응답·점검 페이지는 없음이 아니라 확인 실패', async () => {
    for (const broken of ['empty', 'maintenance']) {
      mode = broken;
      const result = await inspectLaws([{ name: '사립학교법', articles: ['제29조'] }], { client: injected });
      assert.equal(result.laws[0].identity.status, 'unavailable', broken);
      assert.equal(result.status, 'unavailable');
    }
    mode = 'ok';
    const flaky = { callTool: async request => request.name === 'get_law_text' ? { content: [{ type: 'text', text: '<html>점검</html>' }] } : injected.callTool(request) };
    const result = await inspectLaws([{ name: '사립학교법', articles: ['제29조'] }], { client: flaky });
    assert.deepEqual([result.laws[0].identity.status, result.laws[0].articles[0].status, result.status], ['current', 'unavailable', 'partial']);
  });
  await check('낫표 없는 이름은 목록의 정식 이름 끝부분과 맞춰 확정', async () => {
    const result = await inspectLaws([{ name: '직원은 근로자퇴직급여 보장법', articles: ['제8조'], suffixMatch: true }, { name: '직원은 근로자퇴직급여 보장법', articles: [] }], { client: injected });
    assert.deepEqual([result.laws[0].identity.status, result.laws[0].identity.name, result.laws[0].identity.matchedFromText], ['current', '근로자퇴직급여 보장법', '직원은 근로자퇴직급여 보장법']);
    assert.equal(result.laws[0].articles[0].title, '퇴직금제도의 설정 등');
    assert.equal(result.laws[1].identity.status, 'not_found');
  });
  await check('한도: 법령 수와 조문 수', async () => {
    const result = await inspectLaws([{ name: '사립학교법', articles: ['제29조', '제31조'] }, { name: '예비군법', articles: [] }], { client: injected, maxLaws: 1, maxArticles: 1 });
    assert.deepEqual(result.laws[0].articles.map(x => x.code || x.status), ['found', 'ARTICLE_LIMIT']);
    assert.deepEqual([result.laws[1].identity.status, result.laws[1].identity.code], ['not_checked', 'LAW_LIMIT']);
  });

  await check('점검 신호', async () => {
    const codes = (law, ruleRevisedAt = '2021-03-02') => signalsFor(law, { ruleRevisedAt }).map(x => x.code);
    const current = { status: 'current', name: '사립학교법', effectiveAt: '2024-03-01', pendingAmendments: [] };
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: current, articles: [{ article: '제29조', status: 'found', lastAmendedAt: '2020-03-24', ruleArticleAnnotatedAt: null }] }), ['LAW_EFFECTIVE_AFTER_RULE']);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: current, articles: [{ article: '제29조', status: 'found', lastAmendedAt: '2020-03-24', ruleArticleAnnotatedAt: '2018-11-12' }, { article: '제31조', status: 'deleted' }, { article: '제99조', status: 'missing' }] }),
      ['LAW_EFFECTIVE_AFTER_RULE', 'ARTICLE_AMENDED_AFTER_RULE', 'ARTICLE_DELETED', 'ARTICLE_MISSING']);
    assert.deepEqual(codes({ relation: 'topic_candidate', nameStatus: 'law_name', identity: current, articles: [] }), []);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: { status: 'renamed', name: '예비군법', renamedFrom: '향토예비군 설치법', effectiveAt: '2020-02-01', pendingAmendments: [{ kind: '일부개정', promulgatedAt: '2026-06-09', effectiveAt: '2026-12-10' }] }, articles: [{ article: '제6조', status: 'found', lastAmendedAt: null }] }),
      ['LAW_RENAMED', 'PENDING_AMENDMENT', 'ARTICLE_NUMBER_UNVERIFIED']);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'candidate_name', identity: { status: 'not_found' }, articles: [] }), ['NAME_NOT_A_CURRENT_LAW']);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: { status: 'not_found', similar: [] }, articles: [] }), ['LAW_NOT_FOUND']);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: { status: 'unavailable', code: 'LEGAL_TIMEOUT' }, articles: [] }), ['LAW_LOOKUP_FAILED']);
    assert.equal(latestAnnotatedDate('기금은 심의를 거친다.(2018.11.12. 개정) 다만 그러하지 아니하다.(2016.8.22. 신설)'), '2018-11-12');
  });
  await check('주제 후보와 한도', async () => {
    assert.deepEqual(topicCandidates('여비규정').map(x => x.lawName), ['소득세법', '소득세법 시행령', '공무원 여비 규정']);
    assert.deepEqual(topicCandidates('도서관 이용 내규'), []);
    const plan = planLaws([], { title: '재무회계규정', maxLaws: 2 });
    assert.deepEqual(plan.laws.map(x => x.relation), ['topic_candidate', 'topic_candidate']);
    assert.equal(plan.omitted.length, 1);
  });

  await check('띄어 쓴 규정명 인식과 규정명 제외', async () => {
    const catalog = [{ lawId: 1, title: '취업규칙' }, { lawId: 2, title: '산학협력단 취업규칙' }, { lawId: 3, title: '등록금에 관한 시행세칙' }, { lawId: 4, title: '여비규정' }, { lawId: 5, title: '학칙' }];
    assert.equal(titleInQuery('산학협력단 취업규칙 연가 일수', catalog).rules[0].lawId, 2);
    assert.equal(titleInQuery('등록금에 관한 시행세칙 제7조 반환', catalog).title, '등록금에 관한 시행세칙');
    assert.equal(titleInQuery('여비규정과 취업규칙의 차이', catalog), null);
    assert.equal(titleInQuery('학칙 개정 절차', catalog), null);
    assert.equal(withoutRuleName('「등록금에 관한 시행세칙」의 반환 기준', '등록금에 관한 시행세칙'), '반환 기준');
    assert.equal(withoutRuleName('취업규칙 연차', '취업규칙'), '연차');
    assert.equal(withoutRuleName('여비규정', '여비규정'), '');
  });

  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer({ profile: 'rules' });
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

  await check('연계가 꺼져 있으면 확인할 법령 목록만 반환', async () => {
    lawCalls.length = 0;
    const result = await call('get_rule_upper_laws', { law_id: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual([result.data.lookup.status, result.data.lookup.code, result.data.evidenceStatus], ['not_configured', 'LAW_LINK_NOT_CONFIGURED', 'partial']);
    assert(result.data.laws.some(x => x.lawName === '사립학교법' && x.articles.map(y => y.article).join() === '제32조의2,제29조,제31조,제99조'));
    assert(result.data.laws.every(x => x.identity.status === 'not_checked' && !x.signals.length));
    assert.equal(lawCalls.length, 0);
  });
  await check('입력 검증', async () => {
    for (const args of [{ law_id: 1, max_laws: 13 }, { law_id: 1, include_text: 'yes' }, { law_id: 1, article: '가나다' }, { law_id: 0 }]) assert.equal((await call('get_rule_upper_laws', args)).error.code, 'INVALID_ARGUMENT');
    assert.equal((await call('get_rule_upper_laws', { law_id: 1, article: 55 })).error.code, 'NOT_FOUND');
  });

  const http = createHttpServer({ createServer: lawFixture, version: 'test' });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  Object.assign(process.env, { DONGGUK_LEGAL_MCP_ENABLED: '1', DONGGUK_LEGAL_MCP_TRANSPORT: 'streamable-http', DONGGUK_LEGAL_MCP_URL: `http://127.0.0.1:${http.address().port}/mcp`, DONGGUK_PUBLIC_LAW_LINK: '1' });

  await check('규정 전체: 법령별 현행 여부와 점검 신호', async () => {
    const raw = await client.callTool({ name: 'get_rule_upper_laws', arguments: { law_id: 1, max_laws: 12 } });
    const data = raw.structuredContent.data;
    const law = name => data.laws.find(x => x.lawName === name);
    const codes = name => law(name).signals.map(x => x.code);
    assert.equal(data.ruleRevisedAt, '2021-03-02');
    assert.deepEqual(law('사립학교법').articles.map(x => x.status), ['found', 'found', 'deleted', 'missing']);
    // 제7조의 인용은 그 조문의 개정 표시일(2018-11-12)과, 제31조의 인용은 규정 개정일과 비교한다.
    assert.deepEqual(codes('사립학교법'), ['LAW_EFFECTIVE_AFTER_RULE', 'ARTICLE_AMENDED_AFTER_RULE', 'ARTICLE_DELETED', 'ARTICLE_MISSING']);
    assert.match(law('사립학교법').signals[1].message, /제32조의2.*2019-04-16.*2018-11-12/);
    assert.deepEqual([law('사학기관 재무ㆍ회계 규칙에 대한 특례규칙').nameStatus, law('사학기관 재무ㆍ회계 규칙에 대한 특례규칙').identity.kind], ['candidate_name', '교육부령']);
    assert.deepEqual(codes('지가공시 및 토지 등의 평가에 관한 법률'), ['LAW_RENAMED', 'PENDING_AMENDMENT', 'ARTICLE_NUMBER_UNVERIFIED']);
    assert.equal(law('지가공시 및 토지 등의 평가에 관한 법률').identity.name, '부동산 가격공시에 관한 법률');
    assert.deepEqual(codes('향토예비군설치법').slice(0, 1), ['LAW_RENAMED']);
    assert.deepEqual(codes('없는가상법'), ['LAW_NOT_FOUND']);
    assert(!data.laws.some(x => x.lawName === '교원인사규정'), '교내 규정은 상위법령이 아님');
    assert.equal(data.counts.cited, 5);
    assert.equal(data.evidenceStatus, 'retrieved');
    assert(data.laws.every(x => x.articles.every(y => y.text === undefined)), 'include_text 없이 원문 미포함');
    assert.match(raw.content[0].text, /점검 신호/);
    assert.match(raw.content[0].text, /충돌이나 적용 여부를 판정한 것이 아닙니다/);
  });
  await check('조문 지정 + 원문 대조, 주제 후보 생략', async () => {
    const raw = await client.callTool({ name: 'get_rule_upper_laws', arguments: { law_id: 1, article: 9, include_text: true } });
    const data = raw.structuredContent.data;
    assert.deepEqual(data.laws.map(x => x.lawName), ['사학기관 재무ㆍ회계 규칙에 대한 특례규칙']);
    assert.match(data.laws[0].articles[0].text, /복식부기/);
    assert.match(raw.content[0].text, /조문 대조[\s\S]*규정 제9조: [\s\S]*복식부기/);
    assert.equal(data.coverage.scope, 'selected_article');
  });
  await check('인용이 없는 규정은 주제 후보만, 끄면 빈 결과', async () => {
    const result = await call('get_rule_upper_laws', { law_id: 2 });
    assert.deepEqual(result.data.laws.map(x => `${x.lawName}|${x.relation}|${x.identity.status}`), ['소득세법|topic_candidate|current', '소득세법 시행령|topic_candidate|current', '공무원 여비 규정|topic_candidate|current']);
    assert(result.data.laws.every(x => !x.signals.length));
    const none = await call('get_rule_upper_laws', { law_id: 2, include_candidates: false });
    assert.deepEqual([none.data.laws.length, none.data.lookup.status, none.data.evidenceStatus], [0, 'not_required', 'retrieved']);
  });
  await check('같은 날 같은 법령은 캐시에서, 실패는 캐시하지 않음', async () => {
    lawCalls.length = 0;
    await call('get_rule_upper_laws', { law_id: 2 });
    assert.equal(lawCalls.length, 0);
    seed('content-v3', '2_20', { title: '여비규정', markdown: '### 제1조(목적)\n「사립학교교직원 연금법」 제3조를 따른다.' });
    mode = 'maintenance';
    const down = await call('get_rule_upper_laws', { law_id: 2, include_candidates: false });
    assert.deepEqual([down.ok, down.data.lookup.status, down.data.laws[0].identity.status, down.data.laws[0].signals[0].code], [true, 'unavailable', 'unavailable', 'LAW_LOOKUP_FAILED']);
    mode = 'ok';
    const retry = await call('get_rule_upper_laws', { law_id: 2, include_candidates: false });
    assert.equal(retry.data.laws[0].identity.status, 'not_found');
  });
  await check('도구 목록과 서비스 정보', async () => {
    const tools = (await client.listTools()).tools;
    assert(tools.some(x => x.name === 'get_rule_upper_laws' && x.annotations.readOnlyHint));
    const info = await call('get_service_info', {});
    assert.equal(info.data.toolCount, tools.length);
    assert.equal(info.data.integrations.lawLink.upperLawTool, 'get_rule_upper_laws');
  });

  await client.close();
  await closeLegalClient();
  await new Promise(resolve => http.close(resolve));
  console.log(`📊 상위법령 관계 검증: ${passed}개 통과`);
}
main().then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });

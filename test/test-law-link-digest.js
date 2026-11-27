// Law text for cited articles (include_law_text) and the revision digest, offline.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-lawlink-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
for (const key of ['DONGGUK_LEGAL_MCP_ENABLED', 'DONGGUK_LEGAL_MCP_TRANSPORT', 'DONGGUK_LEGAL_MCP_URL', 'DONGGUK_LEGAL_MCP_BEARER_TOKEN', 'DONGGUK_PUBLIC_LAW_LINK', 'LAW_OC']) delete process.env[key];
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => { throw new Error('Network disabled in offline regression test'); };
const { createServer } = require('../src/index.js');
const { createHttpServer } = require('../src/http-server.js');
const { closeLegalClient } = require('../src/legal-client.js');
const { planRequests, lawLinkConfigured } = require('../src/law-link.js');
const { sinceDate, buildDigest, formatDigest, changeText } = require('../src/digest.js');

const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
function seed(category, key, data) {
  fs.mkdirSync(path.join(dir, category), { recursive: true });
  fs.writeFileSync(path.join(dir, category, `${key}.json`), JSON.stringify(data));
}
seed('catalog', 'all', Array.from({ length: 120 }, (_, i) => ({ lawId: i + 1, historyId: 20, title: i ? `합성규정${i}` : '여비규정', code: '', revisedAt: '2026.09.01' })));
seed('history', '1', [{ historyId: 20, revisedAt: '2026.09.01' }]);
seed('content-v4', '1_20', { title: '여비규정', markdown: [
  '### 제1조(목적)', '이 규정은 여비를 정한다.',
  '### 제2조(비과세)', '숙박비의 비과세 범위는 「소득세법」 제12조와 「소득세법 시행령」 제12조, 「법인세법」 제19조, 「부가가치세법」 제10조를 따른다.',
  '### 제3조(준용)', '그 밖의 사항은 「사립학교법」을 따른다.',
].join('\n') });

const lawCalls = [];
const lawNames = new Map();
let lawDown = false;
function lawFixture() {
  const server = new Server({ name: 'korean-law-fixture', version: 'test' }, { capabilities: { tools: {} } });
  const text = value => ({ content: [{ type: 'text', text: value }] });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['search_law', 'get_law_text'].map(name => ({ name, inputSchema: { type: 'object' } })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: a } = request.params;
    lawCalls.push({ name, args: a });
    if (lawDown) throw new Error('fixture down');
    if (name === 'search_law') {
      const mst = String(12345 + lawNames.size);
      lawNames.set(mst, a.query);
      return text(`1. ${a.query} [현행]\n   - 법령ID: 001565\n   - MST: ${mst}\n   - 공포일: 20250101 / 시행일: 20250101\n`);
    }
    if (name === 'get_law_text') return text(`법령명: ${lawNames.get(String(a.mst))}\n공포일: 20250101\n시행일: 20250101\n\n${a.jo}(비과세소득)\n① 합성 조문 본문입니다.\n`);
    throw new Error('unexpected');
  });
  return server;
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`); }

async function main() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer({ profile: 'rules' });
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

  await check('요청 계획: 조문 있는 확정 법령만, 최대 3개', async () => {
    const plan = planRequests([
      { lawName: '소득세법', articles: ['제12조', '제20조'], confirmedLawName: true },
      { lawName: '사립학교법', articles: [], confirmedLawName: true },
      { lawName: '어떤 지침', articles: ['제1조'], confirmedLawName: false },
      { lawName: '법인세법', articles: ['제19조', '제20조'], confirmedLawName: true },
    ]);
    assert.deepEqual(plan.requests.map(x => `${x.law_name} ${x.article}`), ['소득세법 제12조', '소득세법 제20조', '법인세법 제19조']);
    assert.deepEqual(plan.skipped.map(x => x.reason), ['NO_ARTICLE_CITED', 'LAW_NAME_UNCONFIRMED', 'LIMIT']);
  });

  await check('옵션을 쓰지 않으면 법령 서버를 부르지 않음', async () => {
    const result = await call('get_rule_references', { law_id: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.data.lawTexts, undefined);
  });

  await check('연계가 꺼져 있으면 인용 결과는 그대로, 원문은 not_configured', async () => {
    const result = await call('get_rule_references', { law_id: 1, include_law_text: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.lawTexts.status, 'not_configured');
    assert(result.data.externalLaws.some(x => x.lawName === '소득세법'));
    assert.equal(lawLinkConfigured('rules'), false);
  });

  const http = createHttpServer({ createServer: lawFixture, version: 'test' });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  Object.assign(process.env, { DONGGUK_LEGAL_MCP_ENABLED: '1', DONGGUK_LEGAL_MCP_TRANSPORT: 'streamable-http', DONGGUK_LEGAL_MCP_URL: `http://127.0.0.1:${http.address().port}/mcp` });

  await check('법령 서버가 설정돼도 공개 프로필은 별도 허용 전에는 연결하지 않음', async () => {
    const result = await call('get_rule_references', { law_id: 1, include_law_text: true });
    assert.equal(result.data.lawTexts.status, 'not_configured');
    assert.equal(lawCalls.length, 0);
  });

  process.env.DONGGUK_PUBLIC_LAW_LINK = '1';
  await check('법령 서버 장애: 규정 인용은 성공, 원문은 unavailable', async () => {
    lawDown = true;
    const result = await call('get_rule_references', { law_id: 1, article: 2, include_law_text: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.lawTexts.status, 'unavailable');
    assert(result.data.lawTexts.laws.every(x => x.status === 'unavailable' && x.code));
    lawDown = false;
  });

  await check('인용된 조문 원문을 가져오고 한도를 넘은 것은 표시', async () => {
    lawCalls.length = 0;
    const raw = await client.callTool({ name: 'get_rule_references', arguments: { law_id: 1, article: 2, include_law_text: true } });
    const result = raw.structuredContent;
    assert.equal(result.data.lawTexts.status, 'partial');
    assert.deepEqual(result.data.lawTexts.laws.map(x => `${x.lawName} ${x.article} ${x.status}`), ['소득세법 제12조 retrieved', '소득세법 시행령 제12조 retrieved', '법인세법 제19조 retrieved']);
    assert.match(result.data.lawTexts.laws[0].text, /합성 조문 본문/);
    assert.equal(result.data.lawTexts.laws[0].source.mst, '12345');
    assert.deepEqual(result.data.lawTexts.skipped, [{ lawName: '부가가치세법', article: '제10조', reason: 'LIMIT' }]);
    assert.match(raw.content[0].text, /인용 법령 원문/);
    assert.equal(lawCalls.filter(x => x.name === 'get_law_text').length, 3);
  });

  await check('같은 날 같은 조문은 캐시에서 반환', async () => {
    lawCalls.length = 0;
    const result = await call('get_rule_references', { law_id: 1, article: 2, include_law_text: true });
    assert.equal(result.data.lawTexts.laws[0].status, 'retrieved');
    assert.equal(lawCalls.length, 0);
  });

  await check('조문 없는 인용은 원문을 가져오지 않음', async () => {
    const result = await call('get_rule_references', { law_id: 1, article: 3, include_law_text: true });
    assert.equal(result.data.lawTexts.status, 'not_required');
    assert.deepEqual(result.data.lawTexts.skipped, [{ lawName: '사립학교법', reason: 'NO_ARTICLE_CITED' }]);
  });

  await check('서비스 정보에 연계 상태', async () => {
    const info = await call('get_service_info', {});
    assert.equal(info.data.integrations.lawLink.configured, true);
  });

  await closeLegalClient();
  await new Promise(resolve => http.close(resolve));

  await check('기준일 계산(서울 시간)', async () => {
    assert.equal(sinceDate(7, new Date('2026-11-16T16:00:00Z')), '2026-11-10');
  });

  const fake = async (name, args) => {
    if (name === 'check_rule_updates') return { ok: true, data: { checkedAt: 'now', coverage: { catalogRules: 515 }, recent: { since: args.since, total: 3, truncated: false, undatedRules: 0, rules: [
      { lawId: 1, historyId: 30, title: '여비규정', revisedAt: '2026.11.10' },
      { lawId: 2, historyId: 40, title: '신규 <규정>', revisedAt: '2026.11.09' },
      { lawId: 3, historyId: 50, title: '실패규정', revisedAt: '2026.11.08' },
    ] } } };
    if (name === 'list_rule_history') return { ok: true, data: { history: args.law_id === 2 ? [{ historyId: 40 }] : [{ historyId: args.law_id === 1 ? 30 : 50 }, { historyId: 20, revisedAt: '2025.01.01' }] } };
    if (name === 'compare_rule_versions') {
      if (args.law_id === 3) return { ok: false, error: { code: 'CONTENT_UNAVAILABLE' } };
      assert.equal(args.include_appendices, false);
      return { ok: true, data: { counts: {}, changesTruncated: false, changes: [{ key: '제5조', status: 'changed' }, { key: '제9조', status: 'added' }, { key: '부칙(2026.11.10.) 제1조', status: 'added' }] } };
    }
    throw new Error(name);
  };

  await check('개정 알림: 변경 조문, 신규 제정, 비교 실패를 구분', async () => {
    const digest = await buildDigest(fake, { since: '2026-11-03' });
    assert.deepEqual(digest.rules.map(x => x.detail), ['compared', 'new_rule', 'compare_failed']);
    assert.equal(digest.rules[0].previousHistoryId, 20);
    assert.equal(changeText(digest.rules[0]), '변경 제5조 / 신설 제9조');
    const slack = formatDigest(digest, 'slack');
    assert.match(slack, /<https:\/\/rule\.dongguk\.edu\/lmxsrv\/law\/lawFullView\.srv\?SEQ=1&SEQ_HISTORY=30\|여비규정>/);
    assert.match(slack, /신규 제정/);
    assert.match(slack, /변경 조문은 확인하지 못했습니다/);
    assert(!slack.includes('<규정>'));
    assert.match(formatDigest(digest, 'markdown'), /\[여비규정\]\(https:/);
  });

  await check('개정 알림: 부칙만 바뀐 경우와 개정 없음', async () => {
    assert.match(changeText({ detail: 'compared', changes: { changed: [], added: ['부칙(2026.1.1.) 제1조'], removed: [] } }), /본칙 조문 변경 없음/);
    assert.match(formatDigest({ since: '2026-11-03', rules: [], total: 0 }, 'slack'), /개정된 규정이 없습니다/);
  });

  await check('개정 알림: 목록 조회 실패는 오류', async () => {
    await assert.rejects(buildDigest(async () => ({ ok: false, error: { code: 'UPSTREAM' } }), { since: '2026-11-03' }), /규정 목록/);
  });

  console.log(`📊 법령 연계·개정 알림 검증: ${passed}개 통과`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
main().catch(error => { console.error('❌', error); process.exit(1); });

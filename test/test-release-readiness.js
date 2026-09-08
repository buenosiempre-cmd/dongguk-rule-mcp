'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-release-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
let networkCalls = 0;
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => { networkCalls++; throw new Error('Network disabled'); };
const { createServer } = require('../src/index.js');
function seed(category, key, value) {
  const folder = path.join(root, 'dongguk-rule-mcp/v2/public', category);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${key}.json`), JSON.stringify(value));
}
const key = (...parts) => crypto.createHash('md5').update(parts.join('|')).digest('hex');
const oldHit = { lawId: 1, historyId: 10, title: '여비규정', revisedAt: '2024.01.01' };
seed('search', key('숙박비', true, 1, 5, '0'), { total: 1, hits: [oldHit] });
for (const campus of ['0', '1', '2']) seed('search', key('여비규정', false, 1, 10, campus), { total: 1, hits: [oldHit] });
seed('search', key('여비',false,1,10,'0'), {total:0,hits:[]});
seed('history', '1', [{ historyId: 20, revisedAt: '2026.09.01' }, { historyId: 10, revisedAt: '2024.01.01' }]);
seed('content', '1_10', { markdown: '### 제1조(숙박비)\n과거 숙박비' });
seed('content', '1_20', { markdown: '### 제1조(숙박비)\n최신 숙박비' });
seed('original', '1_20', { markdown: '제1조(숙박비)\n최신 숙박비' });
const packPath = path.join(root, 'pack.json');
fs.writeFileSync(packPath, JSON.stringify({ version: 'synthetic', workflows: [{
  id: 'travel', title: '출장', keywords: ['출장'], required_facts: [{ key: 'base_date', label: '기준일' }, { key: 'campus', label: '캠퍼스' }],
  steps: [], completion_evidence: [], source_notes: [], checks: [], rule_requests: [{ keyword: '여비규정', terms: '숙박비' }], legal_requests: [],
}], cards: [] }));
process.env.DONGGUK_FINANCE_PACK_PATH = packPath;
let passed = 0, failed = 0;
function check(name, fn) { try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); } }
async function main() {
  const server = createServer({profile:'finance'});
  const client = new Client({ name: 'release-regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  try {
    await server.connect(b); await client.connect(a);
    const deep = (await call('search_rule_deep', { query: '숙박비', top: 1 })).data.documents[0];
    check('deep search selects latest history', () => assert.equal(deep.historyId, 20));
    check('deep search metadata matches selected history', () => assert.equal(deep.revisedAt, '2026.09.01'));
    check('deep search actually reads latest content', () => assert.match(deep.articles[0].content, /최신 숙박비/));
    for (const facts of [{}, { base_date: '2026-09-08' }, { campus: '서울' }]) {
      const before = networkCalls;
      const response = await call('get_finance_evidence', { query: '출장', facts });
      check(`missing facts do not claim retrieved: ${JSON.stringify(facts)}`, () => {
        assert.equal(response.data?.evidence_status, 'needs_input');
        assert.deepEqual(response.data.rules, []); assert.equal(networkCalls, before);
      });
    }
    for (const campus of ['unknown-campus', '__proto__', 'constructor']) {
      const invalid = await call('get_finance_evidence', { query: '출장', facts: { base_date: '2026-09-08', campus } });
      check(`unknown campus rejected: ${campus}`, () => assert.equal(invalid.error?.code, 'INVALID_ARGUMENT'));
    }
    for (const campus of ['wise', ' WISE ', '경주']) {
      const response = await call('get_finance_evidence', { query: '출장', facts: { base_date: '2026-09-08', campus } });
      check(`campus normalized: ${campus}`, () => assert.equal(response.data?.rules[0]?.structuredContent.data.query.campus, 'wise'));
    }
    const toc = await call('get_rule_toc', { law_id: 1, history_id: 999 });
    check('TOC rejects foreign history', () => assert.equal(toc.error?.code, 'HISTORY_NOT_FOUND'));
    check('seeded requests made no external calls', () => assert.equal(networkCalls, 0));
    fs.unlinkSync(path.join(root, 'dongguk-rule-mcp/v2/public/original/1_20.json'));
    seed('content', '1_20', { markdown: '   ' });
    const empty = await call('lookup_dongguk_rule', { rule_keyword: '여비규정' });
    check('missing HWP plus empty HTML is not success', () => {
      assert.equal(empty.ok, false); assert.equal(empty.error.code, 'CONTENT_UNAVAILABLE');
    });
    seed('content', '1_20', { markdown: '### 제1조(숙박비)\n대체 본문' });
    const fallback = await call('lookup_dongguk_rule', { rule_keyword: '여비규정' });
    check('usable HTML fallback retained with warning', () => { assert.equal(fallback.ok, true); assert.equal(fallback.data.rules[0].warning.code, 'HWP_FALLBACK'); });
  } finally { await client.close(); await server.close(); }
  console.log(`Release regression: ${passed} passed / ${failed} failed`);
  if (failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));

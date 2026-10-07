'use strict';
// Regression cases found in the October 2026 review. No private packs or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { parseSearch } = require('../src/parsers.js');
const { prepareFinanceCase, formatFinanceReview } = require('../src/finance-desk.js');
const { SEARCH_HTML } = require('./fixtures.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-maintenance-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
let requests = 0;
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => {
  requests++;
  return { ok: true, text: async () => '<html><body>Temporarily unavailable</body></html>' };
};
const { createServer } = require('../src/index.js');
const seed = (category, key, value) => {
  const folder = path.join(root, 'dongguk-rule-mcp/v2/public', category);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, key + '.json'), JSON.stringify(value));
};
const key = (...parts) => crypto.createHash('md5').update(parts.join('|')).digest('hex');
const hit = { lawId: 1, historyId: 10, title: '여비규정', revisedAt: '2026.01.01' };
for (const keyword of ['여비규정', '여비']) seed('search', key(keyword, false, 1, 10, '0'), { total: 1, hits: [hit] });
seed('history', '1', [{ historyId: 10, revisedAt: '2026.01.01' }]);
seed('content', '1_10', { title: '여비규정', markdown: '### 제1조(목적)\n합성 본문' });
seed('original', '1_10', { markdown: '제1조(목적) 합성 목적\n\n제2조(대상) 합성 대상\n\n제3조(범위) 합성 범위\n\n제4조(신청) 합성 신청\n\n제5조(숙박비) 숙박비는 합성 기준을 따른다.\n\n제6조(운임) 철도운임은 합성 기준을 따른다.' });

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
async function main() {
  for (const html of ['', '<html>Maintenance</html>', '<p class="infoLeft"><span>3</span>건</p>']) {
    await check('unrecognized/positive-count empty search is an upstream error', () => {
      assert.throws(() => parseSearch(html, 1, 10), { code: 'UPSTREAM_FORMAT_CHANGED' });
    });
  }
  await check('recognized zero-result search remains valid', () => {
    assert.equal(parseSearch('<p class="infoLeft"><span>0</span>건</p><table><tbody class="tbody"></tbody></table>', 1, 10).hits.length, 0);
  });
  await check('real search structure still parses titles', () => assert.equal(parseSearch(SEARCH_HTML, 1, 10).hits[0].title, '재정시행세칙'));
  await check('Finance Desk preserves branched annex numbers', () => {
    assert.deepEqual(prepareFinanceCase({ query: '특례규칙 별표 1의2 및 별표 3 내용 찾아줘' }).legal_requests.map(x => x.annex), ['별표 1의2', '별표 3']);
  });
  await check('text-only clients receive annex evidence and its limitations', () => {
    const rendered = formatFinanceReview({ context: { notice: '합성 검토' }, legal: { results: [{
      request: { law_name: '합성법', annex: '별표 1의2' }, status: 'partial', articles: [],
      annexes: [{ selector: '별표 1의2', status: 'partial', text: '합성 별표 본문', dateStatus: 'historical_unverified', referenceOnly: true, truncated: true, source: { url: 'https://example.com/annex' } }],
    }] } });
    assert.match(rendered, /합성 별표 본문/);
    assert.match(rendered, /별표 1의2/);
    assert.match(rendered, /historical_unverified/);
    assert.match(rendered, /잘림/);
    assert.match(rendered, /참고용/);
    assert.match(rendered, /https:\/\/example.com\/annex/);
  });

  const server = createServer({ profile: 'rules' });
  const client = new Client({ name: 'maintenance-regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  try {
    await server.connect(b); await client.connect(a);
    await check('explicit rule keyword still uses the accompanying question', async () => {
      const result = await call('lookup_dongguk_rule', { rule_keyword: '여비규정', query: '숙박비 알려줘' });
      assert.equal(result.ok, true);
      assert.match(result.data.rules[0].excerpt.text, /제5조/);
      assert(result.data.rules[0].excerpt.matchedTerms.includes('숙박비'));
    });
    await check('explicit terms take priority over the question', async () => {
      const result = await call('lookup_dongguk_rule', { rule_keyword: '여비규정', query: '숙박비 알려줘', terms: '철도운임' });
      assert.match(result.data.rules[0].excerpt.text, /제6조/);
      assert(!result.data.rules[0].excerpt.text.includes('제5조'));
    });
    await check('unmatched terms explicitly mark partial evidence', async () => {
      const result = await call('lookup_dongguk_rule', { law_id: 1, terms: '없는검색어' });
      assert.equal(result.data.evidenceStatus, 'partial');
      assert.equal(result.data.rules[0].evidenceStatus, 'partial');
      assert(result.data.rules[0].incompleteReasons.includes('NO_MATCHING_EXCERPT'));
    });
    await check('usable excerpt reports retrieval without deciding applicability', async () => {
      const result = await call('lookup_dongguk_rule', { law_id: 1, terms: '숙박비' });
      assert.equal(result.data.evidenceStatus, 'retrieved');
      assert.equal(result.data.rules[0].applicability, 'requires_enforcement_review');
    });
    await check('truncation explicitly marks partial evidence', async () => {
      seed('original', '1_10', { markdown: '제1조(숙박비)\n' + '숙박비 합성 본문 '.repeat(300) });
      const result = await call('lookup_dongguk_rule', { law_id: 1, terms: '숙박비', max_chars: 1000 });
      assert.equal(result.data.evidenceStatus, 'partial');
      assert(result.data.rules[0].incompleteReasons.includes('EXCERPT_TRUNCATED'));
    });
    await check('HTML fallback remains explicitly partial', async () => {
      fs.unlinkSync(path.join(root, 'dongguk-rule-mcp/v2/public/original/1_10.json'));
      const result = await call('lookup_dongguk_rule', { law_id: 1 });
      assert.equal(result.data.evidenceStatus, 'partial');
      assert(result.data.rules[0].incompleteReasons.includes('HWP_FALLBACK'));
    });
    await check('bad upstream page is not NOT_FOUND and is never cached', async () => {
      const before = requests;
      for (let i = 0; i < 2; i++) {
        const result = await call('search_rule', { keyword: '장애재현' });
        assert.equal(result.error?.code, 'UPSTREAM_FORMAT_CHANGED');
      }
      assert.equal(requests - before, 2);
    });
  } finally { await client.close(); await server.close(); }
  console.log(`Maintenance regression: ${passed} passed / ${failed} failed`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));

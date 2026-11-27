'use strict';
// With semantic search off or not installed, a lookup answers exactly as it did before the
// feature existed. Synthetic rules where a rule matched only by a scope word ("캠퍼스") outscores
// the second candidate: the single-rule decision must still compare the first two candidates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-semantic-off-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
process.env.DONGGUK_MCP_PROFILE = 'rules';
process.env.DONGGUK_LEGAL_MCP_ENABLED = '0';
delete process.env.DONGGUK_MCP_SEMANTIC_MODEL;
process.env.DONGGUK_MCP_SEMANTIC_RUNTIME = path.join(root, 'no-runtime');
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => ({ ok: true, status: 200, text: async () => '<p class="infoLeft"><span>0</span>건</p><table><tbody class="tbody"></tbody></table>' });
const { createServer } = require('../src/index.js');
const { buildCorpus, saveCorpus, loadCorpus, searchCorpus } = require('../src/corpus.js');
const semantic = require('../src/semantic.js');

const TEXTS = ['### 제2조(계약 구매)\n계약 및 구매는 절차를 따른다.', '### 제2조(업무)\n계약을 담당한다.', '### 제2조(캠퍼스)\n캠퍼스 업무를 정한다.'];
const CATALOG = TEXTS.map((_, i) => ({ lawId: i + 1, historyId: 10 * (i + 1), title: i === 2 ? '캠퍼스시설규정' : `시험${i + 1}규정`, code: `3-1-${i + 1}`, revisedAt: '2026.01.01' }));
const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
const seed = (kind, key, value) => { fs.mkdirSync(path.join(dir, kind), { recursive: true }); fs.writeFileSync(path.join(dir, kind, `${key}.json`), JSON.stringify(value)); };
seed('catalog', 'all', CATALOG);
for (const rule of CATALOG) {
  seed('history', rule.lawId, [{ historyId: rule.historyId, revisedAt: rule.revisedAt }]);
  seed('content-v4', `${rule.lawId}_${rule.historyId}`, { title: rule.title, markdown: TEXTS[rule.lawId - 1] });
  seed('original-structure-v2', `${rule.lawId}_${rule.historyId}`, { markdown: TEXTS[rule.lawId - 1], structure: { coverage: { articles: 'complete' } } });
}

let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`  ✅ ${name}`); }

async function main() {
  saveCorpus(dir, await buildCorpus({ catalog: CATALOG, loadContent: async lawId => ({ title: CATALOG[lawId - 1].title, markdown: TEXTS[lawId - 1] }) }));
  const corpus = loadCorpus(dir);
  const scores = new Map(searchCorpus(corpus, '캠퍼스 계약 구매', { top: 3 }).hits.map(hit => [hit.lawId, hit.score]));
  check('전제: 범위 낱말만 맞은 셋째 규정의 낱말 점수가 둘째 후보보다 높음', scores.get(3) > scores.get(2) && scores.get(1) >= scores.get(2) * 1.3 && scores.get(1) < scores.get(3) * 1.3);

  const server = createServer({ profile: 'rules' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'semantic-off-test', version: '1' });
  await client.connect(b);
  const call = async () => (await client.callTool({ name: 'lookup_dongguk_rule', arguments: { query: '캠퍼스 계약 구매' } })).structuredContent;
  const stable = result => JSON.stringify(result, (key, value) => key === 'returnedAt' ? undefined : value);
  try {
    process.env.DONGGUK_MCP_SEMANTIC = '0';
    const off = await call();
    check('끈 상태: 첫 후보가 둘째 후보를 뚜렷이 앞서면 한 규정만 반환', off.ok === true && off.data.search.selection === 'single_candidate'
      && off.data.rules.map(rule => rule.lawId).join() === '1' && off.data.search.semantic === false);
    check('끈 상태: 응답의 규정에 낱말 점수 필드를 더하지 않음', off.data.rules.every(rule => !('wordScore' in rule)) && !/wordScore/.test(JSON.stringify(off)));
    delete process.env.DONGGUK_MCP_SEMANTIC;
    const missing = await call();
    check('런타임·벡터가 없는 상태: 끈 것과 같은 응답', stable(missing) === stable(off) && semantic.semanticStatus(dir).indexAvailable === false);
    // Vectors exist but the runtime does not: still the same answer.
    await semantic.buildSemanticIndex({ corpus, directory: dir, embedder: { model: semantic.DEFAULT_MODEL, embedPassages: async texts => texts.map(() => new Float32Array([1, 0])) } });
    const noRuntime = await call();
    check('벡터는 있고 런타임이 없는 상태: 끈 것과 같은 응답', semantic.semanticStatus(dir).indexAvailable === true && stable(noRuntime) === stable(off));
  } finally {
    await client.close(); await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`📊 의미검색 꺼짐 동등성 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

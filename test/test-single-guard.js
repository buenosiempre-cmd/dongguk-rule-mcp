'use strict';
// A lookup shows one rule alone only when nothing says another rule may be meant.
// Synthetic rules: a rule written for one campus leads by words. A question that names no campus
// gets the candidates; a question (or campus argument) that names that campus gets the one rule.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-single-guard-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
process.env.DONGGUK_MCP_PROFILE = 'rules';
process.env.DONGGUK_LEGAL_MCP_ENABLED = '0';
process.env.DONGGUK_MCP_SEMANTIC = '0';
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => ({ ok: true, status: 200, text: async () => '<p class="infoLeft"><span>0</span>건</p><table><tbody class="tbody"></tbody></table>' });
const { createServer } = require('../src/index.js');
const { buildCorpus, saveCorpus } = require('../src/corpus.js');

const RULES = [
  { title: 'WISE캠퍼스 온실 운영규정', text: '### 제2조(온실 사용)\n온실 사용 신청은 온실 관리부서에 한다. 온실 사용 기간은 한 학기로 한다.' },
  { title: '실험시설 관리규정', text: '### 제2조(시설)\n온실은 실험시설에 포함한다.' },
  { title: '원예실습 운영내규', text: '### 제2조(실습)\n실습은 온실에서 할 수 있다.' },
  { title: '서고 운영규정', text: '### 제2조(서고 사용)\n서고 사용 신청은 서고 관리부서에 한다. 서고 사용 기간은 한 학기로 한다.' },
  { title: '자료실 관리규정', text: '### 제2조(시설)\n서고는 자료실에 포함한다.' },
];
const CATALOG = RULES.map((rule, i) => ({ lawId: i + 1, historyId: 10 * (i + 1), title: rule.title, code: `3-1-${i + 1}`, revisedAt: '2026.01.01' }));
const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
const seed = (kind, key, value) => { fs.mkdirSync(path.join(dir, kind), { recursive: true }); fs.writeFileSync(path.join(dir, kind, `${key}.json`), JSON.stringify(value)); };
seed('catalog', 'all', CATALOG);
for (const rule of CATALOG) {
  const markdown = RULES[rule.lawId - 1].text;
  seed('history', rule.lawId, [{ historyId: rule.historyId, revisedAt: rule.revisedAt }]);
  seed('content-v4', `${rule.lawId}_${rule.historyId}`, { title: rule.title, markdown });
  seed('original-structure-v2', `${rule.lawId}_${rule.historyId}`, { markdown, structure: { coverage: { articles: 'complete' } } });
}

let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`  ✅ ${name}`); }

async function main() {
  saveCorpus(dir, await buildCorpus({ catalog: CATALOG, loadContent: async lawId => ({ title: CATALOG[lawId - 1].title, markdown: RULES[lawId - 1].text }) }));
  const server = createServer({ profile: 'rules' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'single-guard-test', version: '1' });
  await client.connect(b);
  const call = async args => (await client.callTool({ name: 'lookup_dongguk_rule', arguments: args })).structuredContent.data;
  try {
    for (const ranking of ['legacy', 'hybrid']) {
      process.env.DONGGUK_MCP_RANKING = ranking;
      const general = await call({ query: '서고 사용 신청 기간' });
      check(`${ranking}: 전제 — 캠퍼스 전용이 아닌 규정이 낱말로 뚜렷이 앞서면 한 규정만 반환`, general.search.selection === 'single_candidate' && general.rules.map(rule => rule.lawId).join() === '4');
      const unasked = await call({ query: '온실 사용 신청 기간' });
      check(`${ranking}: 캠퍼스를 말하지 않은 질문에는 캠퍼스 전용 규정을 한 규정으로 확정하지 않음`, unasked.search.selection === 'multiple_candidates' && unasked.rules[0].lawId === 1 && unasked.rules.length > 1);
      const asked = await call({ query: 'WISE캠퍼스 온실 사용 신청 기간' });
      check(`${ranking}: 질문이 그 캠퍼스를 말하면 한 규정으로 확정`, asked.search.selection === 'single_candidate' && asked.rules.map(rule => rule.lawId).join() === '1');
      const argued = await call({ query: '온실 사용 신청 기간', campus: 'wise' });
      check(`${ranking}: campus 인자로 그 캠퍼스를 주어도 확정`, argued.search.selection === 'single_candidate' && argued.rules.map(rule => rule.lawId).join() === '1');
    }
  } finally {
    delete process.env.DONGGUK_MCP_RANKING;
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`📊 단독 확정 조건 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exit(1); });

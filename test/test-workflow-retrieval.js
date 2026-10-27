'use strict';
// Real MCP calls backed by synthetic, isolated cache entries. No live requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ruleNameFromQuery, searchVariants, extractRelevantBlocks } = require('../src/lookup.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-workflow-retrieval-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
let networkCalls = 0;
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => { networkCalls++; throw new Error('Network disabled in workflow regression'); };
const { createServer } = require('../src/index.js');

function seed(category, key, value) {
  const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public', category);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(value));
}
function seedRule(lawId, title, markdown) {
  const hit = { lawId, title, historyId: lawId * 10, revisedAt: '2026.01.01' };
  for (const variant of searchVariants(title)) {
    const key = crypto.createHash('md5').update([variant, false, 1, 10, '0'].join('|')).digest('hex');
    seed('search', key, { total: 1, hits: [hit] });
  }
  seed('history', String(lawId), [{ historyId: hit.historyId, revisedAt: hit.revisedAt }]);
  seed('content', `${lawId}_${hit.historyId}`, { title, markdown });
  seed('original', `${lawId}_${hit.historyId}`, { markdown });
}
const manyMatches = Array.from({ length: 6 }, (_, i) => `제${i + 1}조(숙박비)\n숙박비 합성 기준 ${i + 1}`).join('\n\n');
seedRule(1, '여비규정', manyMatches);
seedRule(2, '취업규칙', '제62조(임금 지급일)\n직원 임금 지급일 합성 조문');
seedRule(3, '연구비 관리규정', '제5조(정산)\n연구비 정산 합성 조문');

let passed = 0;
async function check(name, action) { await action(); passed++; console.log('PASS ' + name); }
async function main() {
  await check('recognizes non-규정 official name suffixes in questions', () => {
    for (const name of ['취업규칙', '재정시행세칙', '학칙', '학칙 시행세칙', '정관', '연구비관리지침', '성과보수내규']) {
      assert.equal(ruleNameFromQuery(`${name} 제5조 확인해줘`), name);
    }
  });
  await check('preserves quoted spaced names and middot variants', () => {
    assert.equal(ruleNameFromQuery('「연구비 관리규정」의 정산 알려줘'), '연구비 관리규정');
    assert.equal(ruleNameFromQuery('『교원 인사ㆍ보수 규정』 제3조'), '교원 인사ㆍ보수 규정');
  });
  await check('multiple names and unnamed questions do not select a first rule', () => {
    assert.equal(ruleNameFromQuery('여비규정과 취업규칙 비교해줘'), '');
    assert.equal(ruleNameFromQuery('「여비규정」과 「취업규칙」 비교해줘'), '');
    assert.equal(ruleNameFromQuery('「여비규정」과 취업규칙 비교해줘'), '');
    assert.equal(ruleNameFromQuery('규정 찾아줘'), '');
    assert.equal(ruleNameFromQuery('「규정」 찾아줘'), '');
  });
  await check('block limit records omitted matching evidence despite short text', () => {
    const excerpt = extractRelevantBlocks(manyMatches, '숙박비', { maxBlocks: 4, maxChars: 30000 });
    assert.equal(excerpt.truncated, true);
    assert.equal(excerpt.blocksTruncated, true);
    assert.equal(excerpt.charactersTruncated, false);
    assert.equal(excerpt.omittedBlockCount, 2);
    assert.match(excerpt.text, /관련 블록 2개 생략/);
  });
  await check('complete matches are not marked incomplete merely for unrelated blocks', () => {
    const excerpt = extractRelevantBlocks('제1조 숙박비 기준\n\n제2조 무관한 문구', '숙박비', { maxBlocks: 1 });
    assert.equal(excerpt.omittedBlockCount, 0);
    assert.equal(excerpt.truncated, false);
  });
  await check('table context recovers matching neighbors before counting omissions', () => {
    const excerpt = extractRelevantBlocks('숙박비 지급표\n\n| 숙박비 |\n| 100원 |\n\n숙박비 예외', '숙박비', { maxBlocks: 1 });
    assert.equal(excerpt.blockCount, 3);
    assert.equal(excerpt.omittedBlockCount, 0);
    assert.equal(excerpt.truncated, false);
  });
  await check('unfiltered preview also declares omitted original blocks', () => {
    const excerpt = extractRelevantBlocks(manyMatches, '', { maxBlocks: 4 });
    assert.equal(excerpt.omittedBlockCount, 2);
    assert.equal(excerpt.truncated, true);
    assert.match(excerpt.text, /원문 블록 2개 생략/);
  });

  const server = createServer({ profile: 'rules' });
  const client = new Client({ name: 'workflow-retrieval', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = async args => (await client.callTool({ name: 'lookup_dongguk_rule', arguments: args }));
  try {
    await server.connect(b); await client.connect(a);
    await check('MCP natural question finds 취업규칙 and its requested clause', async () => {
      const result = (await call({ query: '취업규칙 제62조 임금 지급일 알려줘' })).structuredContent;
      assert.equal(result.ok, true);
      assert.equal(result.data.query.keyword, '취업규칙');
      assert.equal(result.data.rules[0].lawId, 2);
      assert.match(result.data.rules[0].excerpt.text, /제62조/);
    });
    await check('MCP keeps full spaced quoted title', async () => {
      const result = (await call({ query: '「연구비 관리규정」의 정산 알려줘' })).structuredContent;
      assert.equal(result.ok, true);
      assert.equal(result.data.query.keyword, '연구비 관리규정');
      assert.equal(result.data.rules[0].lawId, 3);
    });
    await check('MCP marks a block-limited response partial in structured and visible output', async () => {
      const result = await call({ law_id: 1, terms: '숙박비', max_sections: 4, max_chars: 30000 });
      const data = result.structuredContent.data;
      assert.equal(data.evidenceStatus, 'partial');
      assert(data.rules[0].incompleteReasons.includes('EXCERPT_BLOCK_LIMIT'));
      assert.equal(data.rules[0].excerpt.omittedBlockCount, 2);
      assert.match(result.content[0].text, /EXCERPT_BLOCK_LIMIT/);
      assert.match(result.content[0].text, /관련 블록 2개 생략/);
    });
    await check('larger block limit retrieves the previously omitted matches', async () => {
      const result = (await call({ law_id: 1, terms: '숙박비', max_sections: 6 })).structuredContent;
      assert.equal(result.data.evidenceStatus, 'retrieved');
      assert.equal(result.data.rules[0].excerpt.omittedBlockCount, 0);
      assert.match(result.data.rules[0].excerpt.text, /제6조/);
    });
    await check('explicit rule keyword remains authoritative', async () => {
      const result = (await call({ rule_keyword: '취업규칙', query: '여비규정의 임금 지급일', terms: '임금' })).structuredContent;
      assert.equal(result.data.query.keyword, '취업규칙');
      assert.equal(result.data.rules[0].lawId, 2);
    });
    await check('all fixture lookups complete without external requests', () => assert.equal(networkCalls, 0));
  } finally { await client.close(); await server.close(); }
  console.log(`Workflow retrieval regression: ${passed} passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));

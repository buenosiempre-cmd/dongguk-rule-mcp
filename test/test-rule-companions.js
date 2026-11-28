'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { isImplementationOf, implementationCompanion } = require('../src/rule-companions');

async function fixture() {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-companions-'));
  Object.assign(process.env, { XDG_CACHE_HOME: root, DONGGUK_RULE_COOKIE: '', DONGGUK_MCP_NO_CACHE: '0', DONGGUK_MCP_PROFILE: 'rules', DONGGUK_LEGAL_MCP_ENABLED: '0', DONGGUK_MCP_SEMANTIC: '0', DONGGUK_MCP_LABELS: '0' });
  const fetchPath = require.resolve('node-fetch'); require(fetchPath);
  require.cache[fetchPath].exports = async () => ({ ok: true, status: 200, text: async () => '<p class="infoLeft"><span>0</span>건</p><table><tbody class="tbody"></tbody></table>' });
  const { createServer } = require('../src/index');
  const { buildCorpus, saveCorpus } = require('../src/corpus');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const linked = process.argv[2] === 'linked';
  const catalog = ['표본실규정', linked ? '표본실규정 시행세칙' : '표본실 세부지침', '박물관규정'].map((title, i) => ({ lawId: i + 1, historyId: 101 + i, title, code: `3-1-${i + 1}`, revisedAt: '2026.01.01' }));
  const texts = [Array.from({ length: 4 }, (_, i) => `### 제${i + 2}조(열람 신청 기간 ${i})\n표본실 열람 신청 기간은 다음과 같다. ${'보존자료 정리를 계속한다. '.repeat(80)}`).join('\n\n'), '### 제2조(확인)\n표본실 열람 확인서를 작성한다.', '### 제2조(시설)\n박물관은 표본실을 관리한다.'];
  const dir = path.join(root, 'dongguk-rule-mcp/v2/public');
  const seed = (kind, key, value) => { fs.mkdirSync(path.join(dir, kind), { recursive: true }); fs.writeFileSync(path.join(dir, kind, key + '.json'), JSON.stringify(value)); };
  seed('catalog', 'all', catalog);
  for (const r of catalog) {
    const markdown = texts[r.lawId - 1];
    seed('history', r.lawId, [{ historyId: r.historyId, revisedAt: r.revisedAt }]);
    seed('content-v4', `${r.lawId}_${r.historyId}`, { title: r.title, markdown });
    seed('original-structure-v2', `${r.lawId}_${r.historyId}`, { markdown, structure: { coverage: { articles: 'complete' } } });
  }
  saveCorpus(dir, await buildCorpus({ catalog, loadContent: async id => ({ title: catalog[id - 1].title, markdown: texts[id - 1] }) }));
  const server = createServer({ profile: 'rules' }), [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: 'companion-test', version: '1' }); await client.connect(b);
  const query = '표본실 열람 신청 기간';
  const calls = { plain: { query }, limited: { query, max_sections: 4, max_chars: 7000 }, keywords: { query, keywords: '열람, 신청, 기간' }, terms: { query, terms: '열람, 신청, 기간' }, multiple: { query, max_rules: 3 }, article: { query: query + ' 제2조' }, explicit: { query, law_id: 1 } };
  const out = {};
  try {
    for (const [key, args] of Object.entries(calls)) {
      const r = await client.callTool({ name: 'lookup_dongguk_rule', arguments: args });
      assert(r.structuredContent.ok, key);
      out[key] = { data: r.structuredContent.data, text: r.content.map(x => x.text || '').join('') };
    }
  } finally { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  console.log(JSON.stringify(out));
}

if (process.argv[2]) fixture().catch(e => { console.error(e); process.exitCode = 1; });
else {
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('  ✅ ' + name); };
  for (const [parent, child] of [['학칙', '학사과정 학칙시행세칙'], ['자료 관리규정', '자료 관리 규정 시행 세칙'], ['표본실규정', '표본실규정 내규']]) check('제목 관계: ' + parent + ' / ' + child, () => assert(isImplementationOf(parent, child)));
  for (const [parent, child] of [['관리규정', '관리 시행세칙'], ['자료규정', '자료규정 시행세칙 해설'], ['규정', '어떤규정 시행세칙'], ['자료규정 시행세칙', '자료규정'], ['자료규정', '다른규정 시행세칙']]) check('제목만 비슷한 후보 제외: ' + child, () => assert(!isImplementationOf(parent, child)));
  check('이미 순위에 있는 후보만, 적용범위가 맞지 않거나 불명확한 후보 제외', () => {
    const parent = { title: '표본실규정', lawId: 11 };
    for (const reason of ['scopeNameOnly', 'scopeAmbiguous', 'scopeMatch']) {
      const rejected = { title: '표본실규정 시행세칙', lawId: 12, [reason]: reason === 'scopeMatch' ? false : true };
      assert.equal(implementationCompanion([parent, rejected]), null);
    }
    const child = { title: '표본실규정 시행세칙', lawId: 13 };
    assert.equal(implementationCompanion([parent, child]), child);
    assert.equal(implementationCompanion([parent]), null);
  });
  for (const ranking of ['legacy', 'hybrid']) {
    const run = mode => JSON.parse(execFileSync(process.execPath, [__filename, mode], { env: { ...process.env, DONGGUK_MCP_RANKING: ranking }, encoding: 'utf8', maxBuffer: 2e6 }));
    const base = run('unlinked'), head = run('linked');
    check(ranking + ': 단독 상위 규정에만 시행세칙을 후보로 추가하고 관계를 알림', () => {
      assert.equal(base.plain.data.search.selection, 'single_candidate');
      assert.deepEqual(head.plain.data.rules.map(r => r.lawId), [1, 2]);
      assert.equal(head.plain.data.search.selection, 'multiple_candidates');
      assert.equal(head.plain.data.search.companionPreview.basis, 'title_relationship');
      assert(head.plain.text.includes('제목 관계만으로 적용 대상이 같다고 확정할 수 없'));
    });
    check(ranking + ': 복수로 바뀌어도 기존 네 블록과 문자 한도 유지', () => {
      for (const key of ['plain', 'limited']) {
        assert.deepEqual(head[key].data.rules[0].excerpt, base[key].data.rules[0].excerpt);
        assert(head[key].data.rules[0].excerpt.text.includes('제5조'));
      }
      assert.deepEqual(head.limited.data.search.companionPreview.leaderExcerptLimits, { maxSections: 4, maxChars: 7000 });
    });
    check(ranking + ': 기존 복수·keywords·terms·조문·law_id 요청 유지', () => {
      for (const key of ['keywords', 'terms', 'multiple', 'article', 'explicit']) {
        assert(!head[key].data.search.companionPreview, key);
        assert.deepEqual(head[key].data.rules.map(r => r.lawId), base[key].data.rules.map(r => r.lawId), key);
      }
    });
  }
  console.log(`📊 시행세칙 후보 검증: ${passed}개 통과`);
}

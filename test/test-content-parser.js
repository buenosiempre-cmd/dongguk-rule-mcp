'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseContent, listArticleBlocks, CONTENT_PARSER_VERSION } = require('../src/parsers.js');
const { buildCorpus, saveCorpus, loadCorpus } = require('../src/corpus.js');

// Synthetic text with the classes observed in lawFullContent.srv on 2026-11-27.
// JO and sbt04 are wrappers/controls, not body paragraphs.
const html = `<div class="fullbody"><div class="lawname">합성 절차 규정</div>
<div class="JO"><div class="sbt04">개정이력 버튼</div><div class="article">제1조(목적)</div>
<div class="article_none extra">이 규정은 <span>상위규정</span>에 따른 세부사항을 정한다.</div></div>
<div class="JO"><div class="article">제2조(절차)</div><div class="article_none">처리는 다음과 같다.</div>
<div class="hang">① 항 본문</div><div class="hang_none">항의 계속 문장</div>
<div class="ho">1. 호 본문</div><div class="ho_none">호의 계속 문장</div>
<div class="mok">가. 목 본문</div><div class="mok_none">목의 계속 문장</div>
<div class="dann">나. 단 본문</div><div class="dann_none">단의 계속 문장</div></div>
<div class="JO"><div class="article">제3조(삭제)</div><div class="article_none">삭제</div></div>
<div class="JO"><div class="article">제4조(빈 조문)</div></div>
<div class="addenda">부칙(2025.1.1. 개정)</div><div class="addendacontent_none">시행일 전의 사건에는 적용하지 않는다.</div>
<div class="JO"><div class="article">제1조(시행일)</div><div class="article_none">이 규정은 2025년 1월 1일부터 시행한다.</div></div>
</div>`;
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`  ✅ ${name}`); };
const parsed = parseContent(html), blocks = listArticleBlocks(parsed.markdown);
check('번호 없는 조문 본문과 인라인 요소를 보존', blocks[0].content.includes('이 규정은 상위규정에 따른 세부사항을 정한다.'));
const body = blocks[1].content;
const pieces = ['처리는 다음과 같다.', '① 항 본문', '항의 계속 문장', '1. 호 본문', '호의 계속 문장', '가. 목 본문', '목의 계속 문장', '나. 단 본문', '단의 계속 문장'];
check('항·호·목·단 계속문장을 중복 없이 순서대로 보존', pieces.every((text, i) => body.split(text).length === 2 && (!i || body.indexOf(pieces[i - 1]) < body.indexOf(text))));
check('컨테이너·화면 조작 텍스트를 본문에 섞지 않음', !parsed.markdown.includes('개정이력 버튼'));
check('삭제 조문과 실제 빈 조문을 임의로 채우지 않음', blocks[2].content.endsWith('삭제') && blocks[3].content.trim() === '### 제4조(빈 조문)');
check('부칙 계속문장과 본칙·부칙 경계를 보존', parsed.markdown.includes('시행일 전의 사건에는 적용하지 않는다.') && blocks[4].supplementary && !blocks[0].supplementary && blocks[4].content.includes('2025년 1월 1일부터 시행'));
check('기존 none 본문도 그대로 보존', parseContent('<div class="article">제1조(목적)</div><div class="none">기존 본문</div>').markdown.endsWith('기존 본문'));

// Exact synthetic I01 input supplied by the independent red team (2026-11-27).
const i01 = parseContent(fs.readFileSync(path.join(__dirname, 'fixtures/content-parser-i01.html'), 'utf8'));
const i01Blocks = listArticleBlocks(i01.markdown);
check('I01 article_none 본문을 해당 제1조에 한 번 보존', i01Blocks[0].content.split('본문보존고유문구').length === 2 && !i01Blocks[1].content.includes('본문보존고유문구'));
check('I01 hang_none 계속문장을 제2조 항 다음에 한 번 보존', i01Blocks[1].content.split('계속문장고유문구').length === 2 && i01Blocks[1].content.indexOf('① 첫문장') < i01Blocks[1].content.indexOf('계속문장고유문구'));

async function main() {
  const catalog = [{ lawId: 1, historyId: 10, title: parsed.title, code: 'test', revisedAt: '2025.01.01' }];
  const old = { version: 1, catalogTotal: 1, rules: [{ ...catalog[0], blocks: [{ article: '제1조', supplementary: false, content: '### 제1조(목적)' }] }], failed: [] };
  let calls = 0;
  const loadContent = async () => { calls++; return parsed; };
  const fresh = await buildCorpus({ catalog, previous: old, loadContent });
  check('같은 연혁이어도 파서 버전 없는 옛 색인은 전부 재생성', calls === 1 && fresh.reused === 0 && fresh.contentVersion === CONTENT_PARSER_VERSION && fresh.rules[0].blocks[0].content.includes('세부사항'));
  calls = 0;
  const reused = await buildCorpus({ catalog, previous: fresh, loadContent });
  check('새 파서로 만든 같은 연혁은 재사용', calls === 0 && reused.reused === 1);
  calls = 0;
  await buildCorpus({ catalog, previous: { ...fresh, contentVersion: CONTENT_PARSER_VERSION - 1 }, loadContent });
  check('파서 버전이 오래된 색인도 재생성', calls === 1);

  await assert.rejects(buildCorpus({ catalog, previous: { ...old, catalogTotal: 2 }, loadContent }), /규정 목록이 이전 색인/);
  check('구 파서 색인 이행 중에도 규정 수 급감 방지 유지', true);

  // End-to-end cache migration: the unchanged history must not return the old body.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-content-parser-'));
  process.env.XDG_CACHE_HOME = root;
  process.env.DONGGUK_RULE_COOKIE = '';
  process.env.DONGGUK_MCP_NO_CACHE = '0';
  const publicDir = path.join(root, 'dongguk-rule-mcp/v2/public');
  saveCorpus(publicDir, old);
  check('옛 파서 색인은 검색 경로에서 사용하지 않되 재빌드의 규정 수 검증용으로 읽을 수 있음',
    loadCorpus(publicDir) === null && loadCorpus(publicDir, { allowStaleParser: true }).catalogTotal === 1
    && loadCorpus(publicDir) === null);
  saveCorpus(publicDir, fresh);
  check('재생성한 색인은 검색 경로에서 다시 사용', loadCorpus(publicDir)?.contentVersion === CONTENT_PARSER_VERSION);
  for (const [folder, key, value] of [['history', '1', [{ historyId: 10, revisedAt: '2025.01.01' }]], ['content-v3', '1_10', { title: parsed.title, markdown: '### 제1조(목적)' }]]) {
    fs.mkdirSync(path.join(publicDir, folder), { recursive: true });
    fs.writeFileSync(path.join(publicDir, folder, key + '.json'), JSON.stringify(value));
  }
  const fetchPath = require.resolve('node-fetch');
  require(fetchPath);
  let fetches = 0;
  require.cache[fetchPath].exports = async url => {
    if (url.endsWith('lawFullContent.srv?SEQ=2&SEQ_HISTORY=20')) throw new Error('synthetic offline');
    assert.match(url, /lawFullContent\.srv\?SEQ=1&SEQ_HISTORY=10$/);
    fetches++;
    return { ok: true, text: async () => html };
  };
  const { createServer } = require('../src/index.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const server = createServer({ profile: 'rules' }), client = new Client({ name: 'content-parser-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const result = await client.callTool({ name: 'get_rule_content', arguments: { law_id: 1, history_id: 10, article: 1 } });
    check('MCP 조회가 content-v3를 재사용하지 않고 새 본문을 반환', fetches === 1 && result.structuredContent.ok && result.structuredContent.data.contentMarkdown.includes('세부사항'));
    const stored = JSON.parse(fs.readFileSync(path.join(publicDir, `content-v${CONTENT_PARSER_VERSION}`, '1_10.json')));
    check('새 캐시 저장·기존 캐시 보존', stored.markdown === parsed.markdown && JSON.parse(fs.readFileSync(path.join(publicDir, 'content-v3/1_10.json'))).markdown === '### 제1조(목적)');
    const cachedResult = await client.callTool({ name: 'get_rule_content', arguments: { law_id: 1, history_id: 10, article: 2 } });
    check('현재 content-v4는 원문 재요청 없이 조회', fetches === 1 && cachedResult.structuredContent.ok && cachedResult.structuredContent.data.contentMarkdown.includes('항의 계속 문장'));
    fs.writeFileSync(path.join(publicDir, 'history/2.json'), JSON.stringify([{ historyId: 20, revisedAt: '2025.01.01' }]));
    const staleFile = path.join(publicDir, 'content-v3/2_20.json');
    const staleBytes = JSON.stringify({ title: '옛 캐시', markdown: '### 제1조(목적)\n쓰면 안 되는 옛 본문' });
    fs.writeFileSync(staleFile, staleBytes);
    const unavailable = await client.callTool({ name: 'get_rule_content', arguments: { law_id: 2, history_id: 20, article: 1 } });
    check('원문 재조회가 실패해도 무효화한 v3로 조용히 폴백하지 않음', unavailable.structuredContent.ok === false && !JSON.stringify(unavailable).includes('쓰면 안 되는 옛 본문'));
    check('실패 이행은 v3를 보존하고 불완전한 v4를 저장하지 않음', fs.readFileSync(staleFile, 'utf8') === staleBytes && !fs.existsSync(path.join(publicDir, 'content-v4/2_20.json')));


  } finally { await client.close(); await server.close(); }
  console.log(`📊 본문 파서·캐시 이행 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

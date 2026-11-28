'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseContent, listArticleBlocks, repairArticleNumbering, CONTENT_PARSER_VERSION } = require('../src/parsers.js');
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

// A doubled 제 in the source ("제제3조(…)") is not marked as an article by the site or the HWP original.
const misprinted = ['### 제2조(일반휴학)', '① 일반휴학은 2학기까지 할 수 있다.', '[2020.1.1. 본조신설]', '제제3조(창업휴학) ① 창업을 사유로 휴학할 수 있다.', '② 창업휴학은 4학기를 넘을 수 없다.', '', '### 제4조(복학)', '① 복학은 학기 시작 전에 신청한다.'].join('\n');
const repaired = repairArticleNumbering(misprinted), repairedBlocks = listArticleBlocks(repaired);
check('오기 전에는 제3조가 제2조에 묻혀 조문으로 읽히지 않음', listArticleBlocks(misprinted).map(block => block.canonical).join() === '제2조,제4조');
check('앞 조문 번호에 이어지는 제제N조는 제N조로 읽음', repairedBlocks.map(block => block.canonical).join() === '제2조,제3조,제4조'
  && !repairedBlocks[0].content.includes('창업') && repairedBlocks[1].content.includes('② 창업휴학은 4학기를 넘을 수 없다.'));
check('원문 표기를 조문 제목 옆에 남기고 본문은 다음 줄로', repairedBlocks[1].content.startsWith('### 제3조(창업휴학) [원문 표기: 제제3조]\n① 창업을 사유로 휴학할 수 있다.'));
check('HWP 변환본은 본문을 제목 줄에 그대로 둠', repairArticleNumbering(misprinted, { inline: true }).includes('### 제3조(창업휴학) [원문 표기: 제제3조] ① 창업을 사유로 휴학할 수 있다.'));
check('다시 적용해도 같은 결과', repairArticleNumbering(repaired) === repaired && repairArticleNumbering('') === '' && repairArticleNumbering(null) === '');
const untouched = [
  ['번호가 이어지지 않음', '### 제2조(일반휴학)\n본문\n제제7조(창업휴학) ① 본문'],
  ['앞선 조문 없음', '제제1조(목적) 이 규정은 목적을 정한다.'],
  ['조문 제목 괄호 없음', '### 제2조(일반휴학)\n본문\n제제3조에 따라 처리한다.'],
  ['제제로 시작하는 보통 낱말', '### 제2조(조직)\n제제개발연구부를 둔다.\n제제 3종(가)을 둔다.'],
  ['줄 가운데의 제제', '### 제2조(감급)\n감급의 제제3조(가)를 정할 경우'],
  ['들여 쓴 호·목', '### 제2조(일반휴학)\n  제제3조(창업휴학) ① 본문'],
  // Red-team counterexamples (PR #93 review, 2026-11-28): a reference to an article is not the article.
  ['다른 조문을 가리키는 문장', '### 제2조(신청)\n제제3조(휴학)에서 정한 기준을 준용한다.'],
  ['괄호와 조사 사이를 띄운 참조', '### 제2조(신청)\n제제3조(휴학) 에서 정한 기준을 준용한다.'],
  ['조사·접속어가 뒤따르는 참조', '### 제2조(신청)\n제제3조(휴학)에 따라 처리한다.\n제제3조(휴학)의 기준\n제제3조(휴학)을 준용한다.\n제제3조(휴학) 및 제4조\n제제3조(휴학)이 정하는 바'],
  ['제목 뒤가 여느 문장', '### 제2조(신청)\n제제3조(보수) 보수는 별도로 정한다.'],
  ['별표 안 계약서 조항', '### 제2조(신청)\n본문\n## 별표 1\n표준 계약서\n제제3조(보수) ① 보수는 별도로 정한다.'],
  ['꺾쇠 별표·서식 안 조항', '### 제2조(신청)\n본문\n[별표 1]\n표준 계약서\n제제3조(보수) ① 보수는 별도로 정한다.\n[별지 제1호 서식]\n제제3조(기간) ① 기간은 1년으로 한다.'],
  ['본칙 번호를 부칙이 이어받지 않음', '### 제2조(신청)\n본문\n## 부칙 (2026.1.1.)\n제제3조(적용) ① 이 규정은 시행일부터 적용한다.'],
  ['같은 번호의 조문이 뒤에 따로 있음', '### 제2조(가)\n본문\n제제3조(나) ① 본문\n\n### 제3조(다)\n본문'],
  ['뒤 조문과 번호가 이어지지 않음', '### 제2조(가)\n본문\n제제3조(나) ① 본문\n\n### 제5조(다)\n본문'],
  ['앞 조문 없이 나온 가지번호', '### 제2조(가)\n본문\n제제3조의2(나) ① 본문'],
  // Red-team extended contrasts (PR #93 second review): a line break does not make a reference an article,
  // and without a numbered paragraph nothing tells an article of one paragraph from other prose.
  ['제목 뒤에서 줄이 바뀐 참조', '### 제2조(신청)\n제제3조(휴학)\n에서 정한 기준을 준용한다.\n### 제4조(준용)\n본문'],
  ['제목 뒤 공백·빈 줄 다음의 참조', '### 제2조(신청)\n제제3조(휴학)  \n\n에서 정한 기준을 준용한다.\n### 제4조(준용)\n본문'],
  ['항 번호 없는 본문이 같은 줄에', '### 제2조(신청)\n제제3조(휴학) 휴학은 허가를 받아야 한다.\n### 제4조(준용)\n본문'],
  ['항 번호 없는 본문이 다음 줄에', '### 제2조(신청)\n제제3조(휴학)\n휴학은 허가를 받아야 한다.\n### 제4조(준용)\n본문'],
  ['이 규정은으로 시작하는 단항 본문', '### 제1조(시행일)\n이 세칙은 시행한다.\n제제2조(경과조치) 이 세칙 개정 이전에 수행된 업무는 이 개정 세칙에 의한 것으로 본다.'],
  ['제목 다음이 곧바로 다른 조문', '### 제2조(신청)\n제제3조(휴학)\n### 제4조(준용)\n① 본문'],
];
const repairedLists = [
  ['제목 다음 줄이 항 번호', '### 제2조(신청)\n제제3조(휴학)\n① 휴학을 허가한다.\n### 제4조(준용)\n본문'],
  ['제목 뒤 공백 다음이 항 번호', '### 제2조(신청)\n제제3조(휴학)   ① 휴학을 허가한다.\n### 제4조(준용)\n본문'],
  ['제목과 항 번호 사이가 빈 줄', '### 제2조(신청)\n제제3조(휴학)\n\n① 휴학을 허가한다.\n\n### 제4조(준용)\n본문'],
];
for (const [name, text] of repairedLists) check(`항 번호가 확인되면 조문으로 읽음: ${name}`, listArticleBlocks(repairArticleNumbering(text)).map(block => block.canonical).join() === '제2조,제3조,제4조');
for (const [name, text] of untouched) check(`확신할 수 없으면 고치지 않음: ${name}`, repairArticleNumbering(text) === text && repairArticleNumbering(text, { inline: true }) === text);
const supplementary = listArticleBlocks(repairArticleNumbering('### 제1조(목적)\n본문\n\n## 부칙 (2026.1.20. 개정)\n\n### 제1조(시행일)\n이 세칙은 2026년 1월 20일부터 시행한다.\n제제2조(경과조치) ① 이 세칙 개정 이전에 수행된 업무는 이 개정 세칙에 의한 것으로 본다.'));
check('부칙 제1조에 이어지고 항 번호가 있는 제제2조는 부칙 제2조로 읽음', supplementary.map(block => `${block.supplementary ? '부칙' : '본칙'} ${block.canonical}`).join() === '본칙 제1조,부칙 제1조,부칙 제2조');
check('가지번호는 같은 번호의 조문 뒤에서만', listArticleBlocks(repairArticleNumbering('### 제3조(가)\n본문\n제제3조의2(나) ① 본문\n\n### 제4조(다)\n본문')).map(block => block.canonical).join() === '제3조,제3조의2,제4조');
check('제목만 있는 줄과 마지막 조문도 읽음', listArticleBlocks(repairArticleNumbering('### 제2조(가)\n본문\n제제3조(나)\n① 본문')).map(block => block.canonical).join() === '제2조,제3조');

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
  // Title search for the synthetic rules that the citation check looks up by name.
  const searchable = [[3, 30, '합성휴학세칙'], [4, 40, '합성참조규정'], [5, 50, '합성계약규정'],
    [6, 60, '합성줄바꿈참조규정'], [7, 70, '합성빈줄참조규정'], [8, 80, '합성다음줄항규정'], [9, 90, '합성같은줄단항규정'], [10, 100, '합성다음줄단항규정'], [11, 110, '합성공백항규정']];
  require.cache[fetchPath].exports = async (url, options) => {
    if (String(url).includes('/lmxsrv/search/')) {
      const wanted = (new URLSearchParams(options.body).get('SEARCH_TEXT') || '').replace(/\s/g, '');
      const rows = searchable.filter(([, , title]) => wanted && title.includes(wanted));
      return { ok: true, status: 200, text: async () => `<p class="infoLeft"><span>${rows.length}</span>건</p><table><tbody class="tbody">${rows.map(([lawId, historyId, title]) => `<tr><td class="tbody_txt"><a href="javascript:lawSearchFullViewSrv('${lawId}','${historyId}');"><span onclick='showSearchText("3-1-${lawId}")'></span><span onclick='showSearchText("${title}")'></span></a></td></tr>`).join('')}</tbody></table>` };
    }
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

    // A body cached before the repair existed is repaired when read; it is neither fetched again nor rewritten.
    fs.writeFileSync(path.join(publicDir, 'history/3.json'), JSON.stringify([{ historyId: 30, revisedAt: '2025.01.01' }]));
    const cachedFile = path.join(publicDir, `content-v${CONTENT_PARSER_VERSION}`, '3_30.json');
    const cachedBytes = JSON.stringify({ title: '합성휴학세칙', markdown: `# 합성휴학세칙\n\n${misprinted}` });
    fs.writeFileSync(cachedFile, cachedBytes);
    const third = await client.callTool({ name: 'get_rule_content', arguments: { law_id: 3, history_id: 30, article: 3 } });
    check('이미 캐시된 본문도 원문 재요청 없이 제3조를 조회', fetches === 1 && third.structuredContent.ok
      && third.structuredContent.data.contentMarkdown.includes('### 제3조(창업휴학) [원문 표기: 제제3조]') && !third.structuredContent.data.contentMarkdown.includes('일반휴학은'));
    const second = await client.callTool({ name: 'get_rule_content', arguments: { law_id: 3, history_id: 30, article: 2 } });
    check('앞 조문은 뒤 조문 본문을 더 이상 끌고 오지 않음', second.structuredContent.ok && second.structuredContent.data.contentMarkdown.includes('일반휴학은') && !second.structuredContent.data.contentMarkdown.includes('창업'));
    check('캐시 파일은 고쳐 쓰지 않음', fs.readFileSync(cachedFile, 'utf8') === cachedBytes);

    // The citation check, end to end. A wrong repair would turn ✗ into ✓ here (red-team I1, PR #93).
    const seed = (lawId, historyId, title, body) => {
      fs.writeFileSync(path.join(publicDir, `history/${lawId}.json`), JSON.stringify([{ historyId, revisedAt: '2025.01.01' }]));
      fs.writeFileSync(path.join(publicDir, `content-v${CONTENT_PARSER_VERSION}`, `${lawId}_${historyId}.json`), JSON.stringify({ title, markdown: `# ${title}\n\n${body}` }));
    };
    seed(4, 40, '합성참조규정', '### 제1조(목적)\n이 규정은 신청 절차를 정한다.\n\n### 제2조(신청)\n제제3조(휴학)에서 정한 기준을 준용한다.');
    seed(5, 50, '합성계약규정', '### 제1조(목적)\n이 규정은 계약 절차를 정한다.\n\n### 제2조(신청)\n본문\n\n## 별표 1\n표준 계약서\n제제3조(보수) ① 보수는 별도로 정한다.');
    const verify = async text => (await client.callTool({ name: 'verify_rule_citations', arguments: { text } })).structuredContent.data.citations.map(item => `${item.article} ${item.status}`).join();
    check('인용 점검: 고쳐 읽은 조문은 실존', await verify('「합성휴학세칙」 제3조(창업휴학)에 따름. 「합성휴학세칙」 제2조 참조.') === '제3조 EXISTS,제2조 EXISTS');
    check('인용 점검: 참조 문장의 제제3조는 조문이 아니므로 제3조는 여전히 없음', await verify('「합성참조규정」 제3조에 따름. 「합성참조규정」 제2조 참조.') === '제3조 NOT_FOUND,제2조 EXISTS');
    check('인용 점검: 별표 계약서의 제제3조는 본칙 조문이 아니므로 제3조는 여전히 없음', await verify('「합성계약규정」 제3조에 따름. 「합성계약규정」 제2조 참조.') === '제3조 NOT_FOUND,제2조 EXISTS');
    // Red-team extended contrasts (second review of PR #93), each as its own rule through the citation check.
    const extended = [
      [6, 60, '합성줄바꿈참조규정', '제제3조(휴학)\n에서 정한 기준을 준용한다.', 'NOT_FOUND'],
      [7, 70, '합성빈줄참조규정', '제제3조(휴학)  \n\n에서 정한 기준을 준용한다.', 'NOT_FOUND'],
      [8, 80, '합성다음줄항규정', '제제3조(휴학)\n① 휴학을 허가한다.', 'EXISTS'],
      [9, 90, '합성같은줄단항규정', '제제3조(휴학) 휴학은 허가를 받아야 한다.', 'NOT_FOUND'],
      [10, 100, '합성다음줄단항규정', '제제3조(휴학)\n휴학은 허가를 받아야 한다.', 'NOT_FOUND'],
      [11, 110, '합성공백항규정', '제제3조(휴학)   ① 휴학을 허가한다.', 'EXISTS'],
    ];
    for (const [lawId, historyId, title, lines, expected] of extended) {
      seed(lawId, historyId, title, `### 제2조(신청)\n${lines}\n### 제4조(준용)\n본문`);
      check(`인용 점검: ${title} 제3조는 ${expected}`, await verify(`「${title}」 제3조에 따름. 「${title}」 제4조 참조.`) === `제3조 ${expected},제4조 EXISTS`);
    }


  } finally { await client.close(); await server.close(); }
  console.log(`📊 본문 파서·캐시 이행 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

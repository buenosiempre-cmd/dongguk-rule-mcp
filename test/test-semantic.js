'use strict';
// Article-level semantic search beside the word index: vector file, fallback,
// rank merging and article choice. Synthetic rules and a deterministic stand-in
// for the embedding model; no model file, no network, no benchmark question.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-semantic-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
delete process.env.DONGGUK_MCP_SEMANTIC;
delete process.env.DONGGUK_MCP_SEMANTIC_MODEL;
// No runtime is installed for this test: a path that holds none.
process.env.DONGGUK_MCP_SEMANTIC_RUNTIME = path.join(root, 'no-runtime');
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
let CATALOG = [];
const row = rule => `<tr><td class="tbody_txt"><a href="javascript:lawSearchFullViewSrv('${rule.lawId}','${rule.historyId}');"><span onclick='showSearchText("${rule.code}")'></span><span onclick='showSearchText("${rule.title}")'></span></a></td></tr>`;
require.cache[fetchPath].exports = async (url, options) => {
  assert(String(url).startsWith('https://rule.dongguk.edu/lmxsrv/search/'), `unexpected fetch ${url}`);
  const params = new URLSearchParams(options.body);
  const text = (params.get('SEARCH_TEXT') || '').trim();
  const hits = params.get('SEARCH_TYPE') === 'LAWNAME' && text
    ? CATALOG.filter(rule => rule.title.replace(/\s/g, '').includes(text.replace(/\s/g, ''))) : [];
  return { ok: true, status: 200, text: async () => `<p class="infoLeft"><span>${hits.length}</span>건</p><table><tbody class="tbody">${hits.map(row).join('')}</tbody></table>` };
};
const { createServer } = require('../src/index.js');
const { buildCorpus, saveCorpus, loadCorpus, searchCorpus } = require('../src/corpus.js');
const semantic = require('../src/semantic.js');

const article = (number, heading, body) => `### 제${number}조(${heading})\n${body}`;
const RULES = [
  [1, '비품관리규정', '3-7-2', [
    article(1, '목적', '이 규정은 비품의 관리에 필요한 사항을 정한다.'),
    article(5, '대여', '부서의 장은 비품을 소속 직원에게 대여할 수 있다.'),
    article(9, '회수', '사용을 마친 물건은 관리부서가 회수한다.'),
    article(12, '손·망실', '비품을 훼손한 사람은 같은 비품으로 변상한다.'),
    article(13, '대여 기간', '비품의 대여 기간은 1년 이내로 한다.'),
    article(14, '대여 대장', '비품 대여는 대여 대장에 기록한다.'),
  ]],
  [2, '기자재 공동활용 내규', '3-7-9', [
    article(4, '대여 신청', '기자재를 대여하려는 사람은 신청서를 제출한다.'),
    article(8, '원상회복', '활용을 마친 사람은 기자재를 처음 상태로 되돌려 관리자에게 넘긴다.'),
  ]],
  [3, '복무규정', '3-3-1', [
    article(20, '연가', '직원의 연가는 재직기간에 따라 준다.'),
    article(21, '병가', '질병으로 직무를 수행할 수 없을 때에는 병가를 승인한다.'),
    article(30, '비품 사용', '직원은 대여받은 비품을 업무에만 사용한다.'),
  ]],
];
CATALOG = RULES.map(([lawId, title, code]) => ({ lawId, historyId: lawId * 10, title, code, revisedAt: '2026.01.01' }));
const CONTENT = Object.fromEntries(RULES.map(([lawId, title, , articles]) => [`${lawId}_${lawId * 10}`, { title, markdown: articles.join('\n\n') }]));
const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
function seed(category, key, data) {
  fs.mkdirSync(path.join(dir, category), { recursive: true });
  fs.writeFileSync(path.join(dir, category, `${key}.json`), JSON.stringify(data));
}
seed('catalog', 'all', CATALOG);
for (const [key, value] of Object.entries(CONTENT)) {
  seed('content-v3', key, value);
  seed('original-structure-v2', key, { markdown: value.markdown, structure: { coverage: { articles: 'complete' } } });
}
for (const rule of CATALOG) seed('history', String(rule.lawId), [{ historyId: rule.historyId, revisedAt: rule.revisedAt }]);

// Stand-in for the model: words of one meaning share a dimension, so an everyday
// word lands near the rule word it means without sharing a letter with it.
const MEANINGS = [['돌려', '되돌려', '회수', '반납', '끝나면'], ['망가', '훼손', '변상'], ['쉬고', '연가'], ['아프', '질병', '병가'], ['빌려', '빌린', '차용']];
function fakeVector(text) {
  const vector = new Float32Array(MEANINGS.length + 1);
  MEANINGS.forEach((words, i) => { vector[i] = words.filter(word => text.includes(word)).length; });
  if (!vector.some(Boolean)) vector[MEANINGS.length] = 1;
  const norm = Math.hypot(...vector);
  return vector.map(value => value / norm);
}
function fakeEmbedder({ delayMs = 0, fail = false } = {}) {
  const calls = { passages: 0, queries: 0 };
  const wait = () => new Promise(resolve => setTimeout(resolve, delayMs));
  return {
    model: semantic.DEFAULT_MODEL, calls,
    embedQuery: async text => { calls.queries++; if (delayMs) await wait(); if (fail) throw new Error('synthetic failure'); return fakeVector(text); },
    embedPassages: async texts => { calls.passages += texts.length; return texts.map(fakeVector); },
  };
}

let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`  ✅ ${name}`); }
const headings = text => [...String(text || '').matchAll(/^#{0,6}\s*(제\d+조)\(/gm)].map(match => match[1]);
const metaFile = path.join(dir, 'semantic', 'semantic-v1.json'), vectorFile = path.join(dir, 'semantic', 'semantic-v1.bin');
let clock = Date.now();
const touch = file => { clock += 5000; fs.utimesSync(file, new Date(clock), new Date(clock)); };

async function main() {
  const corpus = await buildCorpus({ catalog: CATALOG, loadContent: async (lawId, historyId) => CONTENT[`${lawId}_${historyId}`] });
  saveCorpus(dir, corpus);
  const loaded = loadCorpus(dir);
  const block = (lawId, name) => loaded.rules.find(rule => rule.lawId === lawId).blocks.find(item => item.article === name);

  // ── 임베딩 입력 ──
  check('짧은 조문은 규정명과 본문을 한 덩어리로', (() => {
    const texts = semantic.articleTexts('비품관리규정', '### 제5조(대여)\n부서의 장은 비품을 대여할 수 있다.');
    return texts.length === 1 && texts[0].startsWith('비품관리규정 ') && texts[0].includes('제5조(대여)');
  })());
  check('긴 조문은 겹치는 조각으로 나누고 조각마다 규정명·조 제목을 붙이며, 끝부분도 들어감', (() => {
    const body = `### 제7조(긴 조문)\n${'가나다라마바사아자차'.repeat(130)} 끝단서`;
    const texts = semantic.articleTexts('시험규정', body);
    return texts.length > 3 && texts.length <= 12 && texts.every(text => text.startsWith('시험규정 ')) && texts.slice(1).every(text => text.includes('제7조(긴 조문)'))
      && texts.at(-1).endsWith('끝단서') && texts.every(text => text.length < 460);
  })());

  // ── 색인이 없을 때 ──
  check('벡터 색인이 없으면 의미 점수 없음(null)', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '빌린 물건 돌려주기' }) === null);

  // ── 색인 만들기·다시 만들기 ──
  const builder = fakeEmbedder();
  const built = await semantic.buildSemanticIndex({ corpus: loaded, directory: dir, embedder: builder });
  check('본문 조문마다 벡터를 만들어 저장(부칙 제외)', built.meta.articles === 11 && built.meta.rows === 11 && builder.calls.passages === 11
    && fs.statSync(vectorFile).size === 11 * built.meta.dims * 4 && JSON.parse(fs.readFileSync(metaFile, 'utf8')).model === semantic.DEFAULT_MODEL);
  const again = fakeEmbedder();
  const rebuilt = await semantic.buildSemanticIndex({ corpus: loaded, directory: dir, embedder: again, previous: semantic.loadSemanticIndex(dir) });
  check('다시 만들 때 바뀌지 않은 조문은 벡터를 그대로 씀', again.calls.passages === 0 && rebuilt.reused === 11
    && Buffer.from(rebuilt.vectors.buffer).equals(Buffer.from(built.vectors.buffer)));
  const edited = structuredClone(loaded);
  edited.rules[0].blocks[2].content = '### 제9조(회수)\n사용을 마친 물건은 사용자가 직접 반납한다.';
  const partial = fakeEmbedder();
  const reb2 = await semantic.buildSemanticIndex({ corpus: edited, directory: null, embedder: partial, previous: semantic.loadSemanticIndex(dir) });
  check('본문이 바뀐 조문만 다시 임베딩', partial.calls.passages === 1 && reb2.reused === 10 && reb2.meta.rows === 11);

  // ── 질의 ──
  semantic.setEmbedderForTests(fakeEmbedder());
  const scores = await semantic.semanticScores({ corpus: loaded, directory: dir, text: '다 쓰고 돌려줘야 하나' });
  check('낱말이 하나도 겹치지 않아도 뜻이 가까운 조문이 가장 높은 점수', scores instanceof Map && scores.size === 11
    && [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([item]) => item.article).sort().join() === '제8조,제9조');
  check('색인 뒤 본문이 바뀐 조문은 의미 점수에서 빠지고 나머지는 유지', await (async () => {
    const stale = await semantic.semanticScores({ corpus: edited, directory: dir, text: '다 쓰고 돌려줘야 하나' });
    return stale.size === 10 && !stale.has(edited.rules[0].blocks[2]) && stale.has(edited.rules[1].blocks[1]);
  })());
  process.env.DONGGUK_MCP_SEMANTIC = '0';
  check('DONGGUK_MCP_SEMANTIC=0이면 끔', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '돌려줘' }) === null && semantic.semanticStatus(dir).setting === 'off');
  delete process.env.DONGGUK_MCP_SEMANTIC;

  // ── 폴백 ──
  semantic.setEmbedderForTests(fakeEmbedder({ delayMs: 400 }));
  const started = Date.now();
  check('시간 한도를 넘기면 기다리지 않고 null', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '아프면 쉬어도 돼', limitMs: 30 }) === null && Date.now() - started < 300);
  await new Promise(resolve => setTimeout(resolve, 450));
  check('늦게 끝난 임베딩은 버리지 않고 다음 같은 질문에 씀', (await semantic.semanticScores({ corpus: loaded, directory: dir, text: '아프면 쉬어도 돼', limitMs: 30 }))?.size === 11);
  semantic.setEmbedderForTests(fakeEmbedder({ fail: true }));
  check('임베딩이 실패하면 null(예외를 던지지 않음)', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '망가뜨리면' }) === null);
  semantic.setEmbedderForTests(null);
  check('런타임이 설치되지 않았으면 null', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '망가뜨리면' }) === null
    && semantic.semanticStatus(dir).lastError === 'SEMANTIC_RUNTIME_MISSING');
  const goodMeta = fs.readFileSync(metaFile, 'utf8'), goodVectors = fs.readFileSync(vectorFile);
  semantic.setEmbedderForTests(fakeEmbedder());
  fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(goodMeta), model: 'Xenova/bge-m3' })); touch(metaFile);
  semantic.setEmbedderForTests(null);
  check('다른 모델로 만든 색인은 쓰지 않음', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '돌려줘' }) === null && semantic.semanticStatus(dir).modelMatches === false);
  semantic.setEmbedderForTests(fakeEmbedder());
  fs.writeFileSync(metaFile, goodMeta); fs.writeFileSync(vectorFile, goodVectors.subarray(0, goodVectors.length - 8)); touch(metaFile);
  check('크기가 맞지 않는 벡터 파일은 쓰지 않음', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '돌려줘' }) === null && semantic.semanticStatus(dir).indexAvailable === false);
  fs.writeFileSync(vectorFile, goodVectors); fs.writeFileSync(metaFile, '{깨진 파일'); touch(metaFile);
  check('깨진 색인 정보 파일은 쓰지 않음', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '돌려줘' }) === null);
  fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(goodMeta), textVersion: 0 })); touch(metaFile);
  check('임베딩 입력 방식이 다른 색인은 쓰지 않음', await semantic.semanticScores({ corpus: loaded, directory: dir, text: '돌려줘' }) === null);
  fs.writeFileSync(metaFile, goodMeta); touch(metaFile);
  check('정상 파일로 돌아오면 다시 씀', (await semantic.semanticScores({ corpus: loaded, directory: dir, text: '돌려줘' }))?.size === 11);

  // ── 순위 합치기 ──
  const question = '비품 대여';
  const words = searchCorpus(loaded, question, { top: 3, perDoc: 3 });
  const lift = new Map([[block(2, '제8조'), 0.9], [block(2, '제4조'), 0.5], [block(1, '제9조'), 0.4], [block(1, '제5조'), 0.3], [block(3, '제30조'), 0.2], [block(1, '제1조'), 0.99]]);
  const merged = searchCorpus(loaded, question, { top: 3, perDoc: 3, semantic: lift });
  const byId = found => new Map(found.hits.map(hit => [hit.lawId, hit]));
  check('의미 점수가 없으면 점수·순위·필드가 이전과 같음', words.semantic === false && words.hits.every(hit => hit.score === hit.wordScore && hit.semanticArticle === null && hit.semanticRuleRank === null)
    && JSON.stringify(searchCorpus(loaded, question, { top: 3, perDoc: 3, semantic: new Map() }).hits) === JSON.stringify(words.hits));
  check('낱말 점수는 그대로 두고 뜻이 가장 가까운 규정의 점수만 올림(가장 가까운 규정 2배, 순위에 따라 감소)', merged.semantic === true
    && [1, 2, 3].every(id => byId(merged).get(id).wordScore === byId(words).get(id).score)
    && Math.abs(byId(merged).get(2).score / byId(merged).get(2).wordScore - 2) < 1e-9
    && Math.abs(byId(merged).get(1).score / byId(merged).get(1).wordScore - 1.9) < 1e-9
    && Math.abs(byId(merged).get(3).score / byId(merged).get(3).wordScore - 1.8) < 1e-9);
  check('목적·정의 조문은 뜻이 가까워도 대표 조문으로 삼지 않음', byId(merged).get(1).semanticArticle === '제9조' && byId(merged).get(1).semanticRuleRank === 2);
  check('규정 안 조문 순서는 낱말 순위 그대로, 뜻이 가까운 조문은 따로 알림', [1, 2, 3].every(id =>
    byId(merged).get(id).articles.map(item => item.article).join() === byId(words).get(id).articles.map(item => item.article).join())
    && byId(merged).get(2).semanticArticle === '제8조' && byId(merged).get(2).articles[0].article === '제4조');
  const far = new Map(Array.from({ length: 12 }, (_, i) => [{ article: `제${i}조`, content: `제${i}조(가짜) 본문`, supplementary: false }, 1 - i * 0.01]));
  const crowded = { ...loaded, rules: [...Array.from({ length: 12 }, (_, i) => ({ lawId: 100 + i, historyId: 1, title: `다른 규정 ${i}`, code: '', revisedAt: '', blocks: [[...far.keys()][i]] })), ...loaded.rules] };
  const outside = searchCorpus(crowded, question, { top: 3, perDoc: 3, semantic: new Map([...far, [block(2, '제8조'), 0.1]]) });
  check('뜻이 가까운 순위가 10위 밖인 규정은 점수 변화 없음', outside.hits.find(hit => hit.lawId === 2).score === outside.hits.find(hit => hit.lawId === 2).wordScore
    && outside.hits.find(hit => hit.lawId === 2).semanticRuleRank === 13);
  check('낱말이 하나도 맞지 않는 규정은 뜻이 가까워도 후보에 넣지 않음', !outside.hits.some(hit => hit.lawId >= 100)
    && !searchCorpus(crowded, question, { top: 50, semantic: new Map([...far]) }).hits.some(hit => hit.lawId >= 100));

  // ── 조회 응답 ──
  semantic.setEmbedderForTests(fakeEmbedder());
  const server = createServer({ profile: 'rules' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'semantic-test', version: '1' });
  await client.connect(b);
  const call = async args => {
    const response = await client.callTool({ name: 'lookup_dongguk_rule', arguments: args });
    return { text: response.content.map(item => item.text).join('\n'), sc: response.structuredContent };
  };
  const stable = result => JSON.stringify(result.sc, (key, value) => key === 'returnedAt' ? undefined : value);
  try {
    const asked = '비품 대여 기간 끝나면 어떡해?';
    process.env.DONGGUK_MCP_SEMANTIC = '0';
    const off = await call({ query: asked });
    delete process.env.DONGGUK_MCP_SEMANTIC;
    const on = await call({ query: asked });
    const excerptOf = (result, lawId) => result.sc.data.rules.find(rule => rule.lawId === lawId)?.excerpt.text || '';
    check('끄면 낱말 색인만으로 답하고 의미검색 표시 없음', off.sc.ok === true && off.sc.data.search.mode === '핵심어 색인' && off.sc.data.search.semantic === false && !/의미검색/.test(off.text));
    check('켜면 응답에 의미검색 사용을 표시', on.sc.ok === true && on.sc.data.search.semantic === true && /검색 방식: 핵심어 색인 \+ 의미검색/.test(on.text));
    check('조문 선택: 낱말이 고른 조문은 첫 자리에 그대로, 뜻이 가까운 조문을 둘째 자리에 함께 발췌', headings(excerptOf(off, 1))[0] === '제13조'
      && !headings(excerptOf(off, 1)).includes('제9조') && headings(excerptOf(on, 1)).slice(0, 2).join() === '제13조,제9조');
    check('한 규정만 보여 줄지는 낱말 점수로 판정: 의미검색을 켜도 후보 수가 줄지 않음', on.sc.data.rules.length >= off.sc.data.rules.length);
    semantic.setEmbedderForTests(fakeEmbedder({ fail: true }));
    const failed = await call({ query: asked });
    check('임베딩 실패 시 응답은 끈 것과 같음', stable(failed) === stable(off));
    semantic.setEmbedderForTests(null);
    const missing = await call({ query: asked });
    check('런타임이 없을 때 응답은 끈 것과 같음', stable(missing) === stable(off));
    semantic.setEmbedderForTests(fakeEmbedder());
    const keyed = await call({ query: '다 쓰면 어떻게 해?', keywords: '비품, 대여' });
    check('keywords와 함께 써도 의미검색 적용, 낱말이 고른 조문 유지', keyed.sc.ok === true && keyed.sc.data.search.semantic === true && keyed.sc.data.search.keywords.applied === true
      && headings(excerptOf(keyed, 1)).includes('제5조') && headings(excerptOf(keyed, 1)).includes('제9조'));
    const named = await call({ rule_keyword: '비품관리규정', query: '망가뜨리면 어떻게 해' });
    check('규정명을 정확히 준 조회는 그 규정만 반환', named.sc.ok === true && named.sc.data.rules.length === 1 && named.sc.data.rules[0].lawId === 1);
    const numbered = await call({ rule_keyword: '비품관리규정', terms: '제5조' });
    check('조문 번호를 준 조회는 그 조문만(의미 조문을 끼워 넣지 않음)', numbered.sc.ok === true && headings(numbered.sc.data.rules[0].excerpt.text).join() === '제5조');
  } finally {
    await client.close(); await server.close();
    semantic.setEmbedderForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`📊 의미검색 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

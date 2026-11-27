// get_rule_upper_laws: citation extraction, law identity checks and review signals, offline.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-upperlaw-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
for (const key of ['DONGGUK_LEGAL_MCP_ENABLED', 'DONGGUK_LEGAL_MCP_TRANSPORT', 'DONGGUK_LEGAL_MCP_URL', 'DONGGUK_LEGAL_MCP_BEARER_TOKEN', 'DONGGUK_PUBLIC_LAW_LINK', 'LAW_OC']) delete process.env[key];
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => { throw new Error('Network disabled in offline regression test'); };
const { createServer } = require('../src/index.js');
const { createHttpServer } = require('../src/http-server.js');
const { closeLegalClient, inspectLaws, articleFacts } = require('../src/legal-client.js');
const { createResolver, extractReferences, summarizeExternalLaws } = require('../src/references.js');
const { buildUpperLaws, planLaws, signalsFor, topicCandidates, latestAnnotatedDate } = require('../src/upper-laws.js');
const { titleInQuery, withoutRuleName } = require('../src/lookup.js');

const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
function seed(category, key, data) {
  fs.mkdirSync(path.join(dir, category), { recursive: true });
  fs.writeFileSync(path.join(dir, category, `${key}.json`), JSON.stringify(data));
}
seed('catalog', 'all', Array.from({ length: 120 }, (_, i) => ({ lawId: i + 1, historyId: 20, title: ['재무회계규정', '여비규정', '교원인사규정'][i] || `합성규정${i}`, code: '', revisedAt: '2021.03.02' })));
for (const id of [1, 2]) seed('history', String(id), [{ historyId: 20, revisedAt: '2021.03.02' }]);
seed('content-v4', '1_20', { title: '재무회계규정', markdown: [
  '### 제7조(자금의 관리)', '사립학교법 제32조의2 제3항에 따른 기금은 심의를 거친다.(2018.11.12. 개정)',
  '### 제9조(회계처리)', '회계는 「사학기관 재무ㆍ회계 규칙에 대한 특례규칙」 제5조에 따른다.\n① 부서장은 월별 증빙을 모은다.\n② 장부 검토를 마친 뒤 결산자료를 제출한다. 앞의 인용 문구 밖에 있는 규정원문끝표지.',
  '### 제29조(평가)', '시가는 『지가공시 및 토지 등의 평가에 관한 법률』에 의한 감정평가액으로 하되 동법 제4조를 따른다.',
  '### 제30조(훈련)', '「향토예비군설치법」 제6조와 「없는가상법」 제1조, 「교원인사규정」 제3조를 따른다.',
  '### 제31조(예산)', '「사립학교법」 제29조, 제31조 및 제99조에 따른다.',
].join('\n') });
seed('content-v4', '2_20', { title: '여비규정', markdown: '### 제1조(목적)\n이 규정은 여비를 정한다.' });
// 본문 완전성(textCoverage) 반례용 합성 규정: 본문 응답 오류, 조문 수 상한 초과, 긴 본문.
for (const id of [101, 102, 103]) seed('history', String(id), [{ historyId: 20, revisedAt: '2021.03.02' }]);
seed('content-v4', '101_20', { title: '합성규정100', markdown: '### 제1조(합성)\n「사립학교법」 제101조를 따른다.' });
seed('content-v4', '102_20', { title: '합성규정101', markdown: '### 제1조(합성)\n' + Array.from({ length: 9 }, (_, i) => `「사립학교법」 제${i + 1}조`).join(' 및 ') + '를 따른다.' });
seed('content-v4', '103_20', { title: '합성규정102', markdown: '### 제1조(합성)\n「사립학교법」 제50조를 따른다.' });

// Paired-text fixtures (all synthetic; no actual legal interpretation).
for (const id of [104, 105, 106, 107, 108, 109, 110, 111]) seed('history', String(id), [{ historyId: 20, revisedAt: '2021.03.02' }, { historyId: 19, revisedAt: '2019.01.01' }]);
const setRule = (id, markdown, historyId = 20) => seed('content-v4', `${id}_${historyId}`, { title: `합성규정${id-1}`, markdown });
setRule(104, '### 제1조(장문)\n「사립학교법」 제29조를 따른다.\n' + '가'.repeat(6100) + '장문끝');
setRule(105, Array.from({length:30}, (_,i) => `### 제${i+1}조(절차)\n「사립학교법」 제29조를 따른다. 본문${i+1}`).join('\n'));
setRule(106, '### 제1조(근거)\n「사립학교법」을 따른다. 조문을 특정하지 않았다.');
setRule(107, '### 제10조의2(절차)\n「사립학교법」 제29조제1항 및 「사립학교법」 제29조제2항에 따른다.\n규정 가지조문 고유본문');
setRule(107, '### 제10조의2(과거)\n「사립학교법」 제29조에 따른다. 과거 규정 고유본문', 19);
setRule(108, '### 제1조(본문)\n「사립학교법」 제29조를 따른다. 본칙고유\n## 부칙 (2020.1.1.)\n### 제1조(시행)\n「사립학교법」 제29조를 따른다. 첫부칙고유\n## 부칙 (2021.1.1.)\n### 제1조(시행)\n「사립학교법」 제29조를 따른다. 둘째부칙고유');
setRule(109, Array.from({length:5}, (_,i) => `### 제${i+1}조(장문)\n「사립학교법」 제29조를 따른다. ` + '나'.repeat(6100)).join('\n'));
setRule(110, '### 제1조(없는 조문)\n「사립학교법」 제99조를 따른다.');
setRule(111, '### 제1조(기호)\n「사립학교법」 제29조를 따른다.\n항목 | 값\n<표> & 문구');

// F1: same MST may return a future body unless efYd is pinned (synthetic prose).
for (const [id, jo] of [[660,25],[661,26],[662,27]]) {
  seed('history', String(id), [{historyId:3765,revisedAt:'2026.03.13'}]);
  seed('content-v4', `${id}_3765`, {title:'안전보건관리규정',markdown:`### 제1조(목적)\n산업안전보건법 제${jo}조를 따른다.`});
}

// Synthetic law listing in the provider's format. Dates are fixture values, not real law data.
const LAWS = {
  산업안전보건법: {id:'001766',mst:'291447',promulgated:'20261027',effective:'20261027',kind:'법률',articles:{}},
  사립학교법: { id: '000888', mst: '9001', promulgated: '20240101', effective: '20240301', kind: '법률',
    articles: { 제29조: '제29조(회계의 구분)\n①학교법인의 회계는 구분한다. <개정 2020.3.24>', 제31조: '제31조 삭제 <2022.1.4>', '제32조의2': '제32조의2(적립금)\n①적립할 수 있다. <개정 2019.4.16>' } },
  '사학기관 재무ㆍ회계 규칙에 대한 특례규칙': { id: '007333', mst: '9002', promulgated: '20230531', effective: '20230601', kind: '교육부령',
    articles: { 제5조: '제5조 회계원칙\n회계는 복식부기로 한다.' } },
  '부동산 가격공시에 관한 법률': { id: '001827', mst: '9003', promulgated: '20200609', effective: '20201210', kind: '법률',
    articles: { 제4조: '제4조 표준지공시지가의 조사협조\n장관은 요구할 수 있다. <개정 2020.6.9>' } },
  예비군법: { id: '001619', mst: '9004', promulgated: '20200101', effective: '20200201', kind: '법률', articles: { 제6조: '제6조(훈련)\n훈련을 받는다.' } },
  소득세법: { id: '001565', mst: '9005', promulgated: '20200101', effective: '20200201', kind: '법률', articles: {} },
  '소득세법 시행령': { id: '003956', mst: '9006', promulgated: '20200101', effective: '20200201', kind: '대통령령', articles: {} },
  '공무원 여비 규정': { id: '009402', mst: '9007', promulgated: '20200101', effective: '20200201', kind: '대통령령', articles: {} },
  '근로자퇴직급여 보장법': { id: '009883', mst: '9008', promulgated: '20200101', effective: '20200201', kind: '법률', articles: { 제8조: '제8조(퇴직금제도의 설정 등)\n①퇴직금을 지급한다.' } },
};
for (let i = 1; i <= 9; i++) LAWS.사립학교법.articles[`제${i}조`] = `제${i}조(합성)\n합성 조문 ${i}.`;
LAWS.사립학교법.articles.제50조 = '제50조(합성 장문)\n' + '합성 본문 '.repeat(1000);
const RENAMED = { '지가공시및토지등의평가에관한법률': ['지가공시및토지등의평가에관한법률', '부동산 가격공시에 관한 법률'], 향토예비군설치법: ['향토예비군 설치법', '예비군법'] };
const flat = value => String(value).replace(/[\sㆍ·]/g, '');
const listing = names => names.map((name, i) => { const law = LAWS[name]; return `${i + 1}. ${name} [현행]\n   - 법령ID: ${law.id}\n   - MST: ${law.mst}\n   - 공포일: ${law.promulgated} / 시행일: ${law.effective}\n   - 구분: ${law.kind}\n`; }).join('\n');
const lawCalls = [];
let mode = 'ok';
function lawTool(name, a) {
  lawCalls.push({ name, args: a });
  const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
  if (mode === 'empty') return text('');
  if (mode === 'maintenance') return text('<html><body>시스템 점검 중입니다</body></html>');
  if (name === 'search_law') {
    const exact = Object.keys(LAWS).find(x => flat(x) === flat(a.query));
    if (exact) return text(`검색 결과 (총 1건):\n\n${listing([exact])}${exact === '예비군법' ? '' : ''}`);
    const renamed = RENAMED[flat(a.query)];
    if (renamed) return text(`검색 결과 (총 1건):\n\n${listing([renamed[1]])}\n🔜 「${renamed[1]}」 개정 시행예정 (일부개정, 2026-06-09 공포 제21770호, 시행 2026-12-10) — 시행예정본\n📛 「${renamed[0]}」은(는) 옛 법령명입니다 — 제명이 바뀌어 현행은 「${renamed[1]}」(법령ID ${LAWS[renamed[1]].id}, MST ${LAWS[renamed[1]].mst})입니다.`);
    const partial = Object.keys(LAWS).filter(x => flat(x).includes(flat(a.query)));
    if (partial.length) return text(`검색 결과 (총 ${partial.length}건):\n\n${listing(partial)}\n⚠️ 정확매칭 없음`);
    return text(`[NOT_FOUND] 법령 '${a.query}' 검색 결과가 없습니다.`, true);
  }
  if (name === 'get_law_text' && a.jo === '제101조') return text('<html>시스템 점검 중입니다</html>');
  if (name === 'get_law_text') {
    const entry = Object.entries(LAWS).find(([, law]) => law.mst === String(a.mst));
    const head = `법령명: ${entry[0]}\n공포일: ${entry[1].promulgated}\n시행일: ${entry[1].effective}\n\n`;
    if (entry[0] === '산업안전보건법') {
      const effective = a.jo === '제27조' ? '' : a.efYd === '20261027' && a.jo === '제25조' ? '20261027' : '20270428';
      return text(`법령명: 산업안전보건법\n시행일: ${effective}\n\n${a.jo}(합성 시험)\n${effective === '20261027' ? '현재 합성본문' : '시행예정 합성본문'}`);
    }
    const body = entry[1].articles[a.jo];
    return body ? text(head + body + '\n') : text(`${head}[NOT_FOUND] 조문 내용을 찾을 수 없습니다.`, true);
  }
  throw new Error('unexpected');
}
const injected = { callTool: async ({ name, arguments: a }) => lawTool(name, a) };
function lawFixture() {
  const server = new Server({ name: 'korean-law-fixture', version: 'test' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['search_law', 'get_law_text'].map(name => ({ name, inputSchema: { type: 'object' } })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => lawTool(request.params.name, request.params.arguments));
  return server;
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`); }

async function main() {
  const resolver = createResolver([{ lawId: 3, title: '교원인사규정', historyId: 1 }], { lawId: 1, title: '재무회계규정' });
  const refs = text => extractReferences(text, resolver).map(x => `${x.scope}|${x.name}|${x.article || ''}|${x.resolutionStatus}`);

  await check('조문 나열과 항 번호', async () => {
    const found = extractReferences('「사립학교법」 제29조, 제31조 및 제32조의2제3항에 따른다.', resolver);
    assert.deepEqual(found.map(x => x.article), ['제29조', '제31조', '제32조의2']);
    assert.equal(found[2].paragraph, '제3항');
    const paragraphs = extractReferences('「사립학교법」 제29조제1항 및 「사립학교법」 제29조제2항, 「사립학교법」 제29조제1항', createResolver([]));
    assert.deepEqual(paragraphs.map(x => `${x.article} ${x.paragraph}`), ['제29조 제1항', '제29조 제2항']);
    assert.deepEqual(summarizeExternalLaws(paragraphs)[0].articles, ['제29조']);
    assert.deepEqual(refs('「학칙」 제5조 및 「사립학교법」 제53조의2와 제54조').slice(1), ['external_law|사립학교법|제53조의2|quoted_name', 'external_law|사립학교법|제54조|quoted_name']);
  });
  await check('동법·같은 법은 바로 앞 법령으로 연결', async () => {
    assert.deepEqual(refs('「고등교육법」 제11조 및 같은 법 시행령 제4조의2'), ['external_law|고등교육법|제11조|quoted_name', 'external_law|고등교육법 시행령|제4조의2|anaphora']);
    assert.deepEqual(refs('소득세법 제12조 및 같은 법 제13조'), ['external_law|소득세법|제12조|name_heuristic', 'external_law|소득세법|제13조|anaphora']);
    assert.deepEqual(refs('「소득세법」 제12조. 같은 법 제13조. 「법인세법」 제19조. 같은 법 제20조.').slice(2), ['external_law|법인세법|제19조|quoted_name', 'external_law|법인세법|제20조|anaphora']);
    assert.deepEqual(refs('이 법 제3조와 관계 법 제5조, 동법 제4조'), []);
  });
  await check('약칭은 정의한 뒤에만 연결', async () => {
    assert.deepEqual(refs('시행령 제1조. 「소득세법 시행령」(이하 "시행령"이라 한다) 제2조. 시행령 제3조 및 제5조.'),
      ['external_law|소득세법 시행령|제2조|quoted_name', 'external_law|소득세법 시행령|제3조|defined_abbreviation', 'external_law|소득세법 시행령|제5조|defined_abbreviation']);
  });
  await check('띄어 쓴 법령명과 법령이 아닌 말', async () => {
    assert.deepEqual(refs('소득세법 시행령 제12조제3호 및 근로자퇴직급여 보장법 제8조'), ['external_law|소득세법 시행령|제12조|name_heuristic', 'external_law|근로자퇴직급여 보장법|제8조|name_heuristic']);
    assert.deepEqual(refs('이 경우 국가를 당사자로 하는 계약에 관한 법률 제7조에 따른다.'), ['external_law|국가를 당사자로 하는 계약에 관한 법률|제7조|name_heuristic']);
    assert.deepEqual(refs('성과의 평가방법 제5조에 따라 심사하고 처리기법 제2조를 따른다.'), []);
    const laws = summarizeExternalLaws(extractReferences('근로자퇴직급여 보장법 제8조와 「사립학교법」 제29조', resolver));
    assert.equal(laws.find(x => x.lawName === '근로자퇴직급여 보장법').nameGuessed, true);
    assert.equal(laws.find(x => x.lawName === '사립학교법').nameGuessed, undefined);
  });

  await check('법령 식별: 현행, 제명 변경, 시행예정, 목록에 없음', async () => {
    const result = await inspectLaws([{ name: '사립학교법', articles: [] }, { name: '향토예비군설치법', articles: [] }, { name: '없는가상법', articles: [] }], { client: injected });
    assert.equal(result.status, 'retrieved');
    assert.deepEqual(result.laws.map(x => x.identity.status), ['current', 'renamed', 'not_found']);
    assert.deepEqual([result.laws[0].identity.kind, result.laws[0].identity.effectiveAt, result.laws[0].identity.mst], ['법률', '2024-03-01', '9001']);
    assert.equal(result.laws[1].identity.name, '예비군법');
    assert.equal(result.laws[1].identity.renamedFrom, '향토예비군 설치법');
    assert.deepEqual(result.laws[1].identity.pendingAmendments, [{ kind: '일부개정', promulgatedAt: '2026-06-09', effectiveAt: '2026-12-10' }]);
  });
  await check('조문 상태: 있음·삭제·없음, 개정 표시일', async () => {
    const result = await inspectLaws([{ name: '사립학교법', articles: ['제29조', '제31조', '제99조'] }], { client: injected });
    const [found, deleted, missing] = result.laws[0].articles;
    assert.deepEqual([found.status, found.title, found.lastAmendedAt, found.versionCheck], ['found', '회계의 구분', '2020-03-24', 'matches_listing']);
    assert.equal(deleted.status, 'deleted');
    assert.deepEqual([missing.status, missing.code], ['missing', 'LEGAL_ARTICLE_MISSING']);
    assert.deepEqual(articleFacts('법령명: X\n\n제15조 서류\n제15조(서류)\n①본문 <개정 1976.1.7, 2019.9.17>\n7. 삭제<1999.1.29>\n', '제15조').amendedDates, ['1976-01-07', '1999-01-29', '2019-09-17']);
  });
  await check('F1 같은 MST의 본문을 목록 시행일로 지정하고 정상 현행 본문은 유지', async () => {
    lawCalls.length = 0;
    const r = await inspectLaws([{name:'산업안전보건법',articles:['제25조']}], {client:injected,now:new Date('2026-11-27T03:00:00Z')});
    assert.equal(r.status,'retrieved');
    assert.equal(r.laws[0].articles[0].versionCheck,'matches_listing');
    assert.match(r.laws[0].articles[0].text,/현재 합성본문/);
    assert.deepEqual(lawCalls.find(x=>x.name==='get_law_text').args,{mst:'291447',efYd:'20261027',jo:'제25조'});
  });
  await check('F1 제공자가 시행일 지정을 무시하거나 날짜를 누락하면 본문을 확정하지 않음', async () => {
    for (const date of ['20270428','20200101','','2026-02-30']) {
      const client = {callTool:async request => request.name==='search_law' ? injected.callTool(request)
        : {content:[{type:'text',text:`법령명: 산업안전보건법\n시행일: ${date}\n\n제25조(합성)\n미검증 합성본문`}]}};
      const r = await inspectLaws([{name:'산업안전보건법',articles:['제25조']}],{client,now:new Date('2026-11-27T03:00:00Z')});
      const a = r.laws[0].articles[0];
      assert.deepEqual([r.status,a.status,a.code,a.versionCheck,a.text],['partial','unavailable','LEGAL_BODY_VERSION_UNVERIFIED','unverified',undefined],date);
      assert.equal(a.source.arguments.efYd,'20261027');
    }
  });
  await check('F1 다른 버전의 삭제·없음도 현행 삭제·없음으로 확정하지 않음', async () => {
    for (const body of ['제25조 삭제 <2027.4.28>', '[NOT_FOUND] 조문 내용을 찾을 수 없습니다.']) {
      const client = {callTool:async request => request.name==='search_law' ? injected.callTool(request)
        : {content:[{type:'text',text:`법령명: 산업안전보건법\n시행일: 20270428\n\n${body}`}],isError:body.startsWith('[NOT_FOUND]')}};
      const r=await inspectLaws([{name:'산업안전보건법',articles:['제25조']}],{client,now:new Date('2026-11-27T03:00:00Z')});
      assert.equal(r.laws[0].articles[0].code,'LEGAL_BODY_VERSION_UNVERIFIED');
      assert.equal(r.laws[0].articles[0].status,'unavailable');
    }
  });
  await check('F1 미래 시행일 목록·시행일 없는 제명 변경 안내는 현행 근거가 아님', async () => {
    for (const listingText of [listing(['산업안전보건법']).replace(/20261027/g,'20270428'),
      '「옛합성법」은(는) 옛 법령명입니다 — 제명이 바뀌어 현행은 「산업안전보건법」(법령ID 001766, MST 291447)입니다.\n'+listing(['소득세법'])]) {
      let bodies=0;
      const client={callTool:async request=>{if(request.name==='get_law_text')bodies++;return {content:[{type:'text',text:listingText}]};}};
      const r=await inspectLaws([{name:listingText.startsWith('「')?'옛합성법':'산업안전보건법',articles:['제25조']}],{client,now:new Date('2026-11-27T03:00:00Z')});
      assert.equal(r.laws[0].identity.code,'LEGAL_CURRENT_VERSION_UNVERIFIED');
      assert.equal(r.status,'unavailable');assert.equal(bodies,0);
    }
  });
  await check('F1 검증 전 캐시 키는 재사용하지 않고 검증된 결과만 새 키에 저장', async () => {
    const crypto=require('node:crypto'), day=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
    const oldKey=crypto.createHash('md5').update(['산업안전보건법','name','제25조',day].join('|')).digest('hex');
    let checked=0;
    const result=await buildUpperLaws({references:extractReferences('「산업안전보건법」 제25조',createResolver([])),title:'합성규정',includeText:true,
      includeCandidates:false,configured:true,cached:async(category,key,ttl,fn)=>{assert.equal(category,'upper-law');assert.notEqual(key,oldKey);return fn();},
      inspectLaws:async(requests,opts)=>{checked++;return inspectLaws(requests,{...opts,client:injected});}});
    assert.equal(checked,1);assert.equal(result.lookup.status,'retrieved');assert.match(result.laws[0].articles[0].text,/현재 합성본문/);
  });
  await check('빈 응답·점검 페이지는 없음이 아니라 확인 실패', async () => {
    for (const broken of ['empty', 'maintenance']) {
      mode = broken;
      const result = await inspectLaws([{ name: '사립학교법', articles: ['제29조'] }], { client: injected });
      assert.equal(result.laws[0].identity.status, 'unavailable', broken);
      assert.equal(result.status, 'unavailable');
    }
    mode = 'ok';
    const flaky = { callTool: async request => request.name === 'get_law_text' ? { content: [{ type: 'text', text: '<html>점검</html>' }] } : injected.callTool(request) };
    const result = await inspectLaws([{ name: '사립학교법', articles: ['제29조'] }], { client: flaky });
    assert.deepEqual([result.laws[0].identity.status, result.laws[0].articles[0].status, result.status], ['current', 'unavailable', 'partial']);
  });
  await check('낫표 없는 이름은 목록의 정식 이름 끝부분과 맞춰 확정', async () => {
    const result = await inspectLaws([{ name: '직원은 근로자퇴직급여 보장법', articles: ['제8조'], suffixMatch: true }, { name: '직원은 근로자퇴직급여 보장법', articles: [] }], { client: injected });
    assert.deepEqual([result.laws[0].identity.status, result.laws[0].identity.name, result.laws[0].identity.matchedFromText], ['current', '근로자퇴직급여 보장법', '직원은 근로자퇴직급여 보장법']);
    assert.equal(result.laws[0].articles[0].title, '퇴직금제도의 설정 등');
    assert.equal(result.laws[1].identity.status, 'not_found');
  });
  await check('한도: 법령 수와 조문 수', async () => {
    const result = await inspectLaws([{ name: '사립학교법', articles: ['제29조', '제31조'] }, { name: '예비군법', articles: [] }], { client: injected, maxLaws: 1, maxArticles: 1 });
    assert.deepEqual(result.laws[0].articles.map(x => x.code || x.status), ['found', 'ARTICLE_LIMIT']);
    assert.deepEqual([result.laws[1].identity.status, result.laws[1].identity.code], ['not_checked', 'LAW_LIMIT']);
  });

  await check('점검 신호', async () => {
    const codes = (law, ruleRevisedAt = '2021-03-02') => signalsFor(law, { ruleRevisedAt }).map(x => x.code);
    const current = { status: 'current', name: '사립학교법', effectiveAt: '2024-03-01', pendingAmendments: [] };
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: current, articles: [{ article: '제29조', status: 'found', lastAmendedAt: '2020-03-24', ruleArticleAnnotatedAt: null }] }), ['LAW_EFFECTIVE_AFTER_RULE']);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: current, articles: [{ article: '제29조', status: 'found', lastAmendedAt: '2020-03-24', ruleArticleAnnotatedAt: '2018-11-12' }, { article: '제31조', status: 'deleted' }, { article: '제99조', status: 'missing' }] }),
      ['LAW_EFFECTIVE_AFTER_RULE', 'ARTICLE_AMENDED_AFTER_RULE', 'ARTICLE_DELETED', 'ARTICLE_MISSING']);
    assert.deepEqual(codes({ relation: 'topic_candidate', nameStatus: 'law_name', identity: current, articles: [] }), []);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: { status: 'renamed', name: '예비군법', renamedFrom: '향토예비군 설치법', effectiveAt: '2020-02-01', pendingAmendments: [{ kind: '일부개정', promulgatedAt: '2026-06-09', effectiveAt: '2026-12-10' }] }, articles: [{ article: '제6조', status: 'found', lastAmendedAt: null }] }),
      ['LAW_RENAMED', 'PENDING_AMENDMENT', 'ARTICLE_NUMBER_UNVERIFIED']);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'candidate_name', identity: { status: 'not_found' }, articles: [] }), ['NAME_NOT_A_CURRENT_LAW']);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: { status: 'not_found', similar: [] }, articles: [] }), ['LAW_NOT_FOUND']);
    assert.deepEqual(codes({ relation: 'cited', nameStatus: 'law_name', identity: { status: 'unavailable', code: 'LEGAL_TIMEOUT' }, articles: [] }), ['LAW_LOOKUP_FAILED']);
    assert.equal(latestAnnotatedDate('기금은 심의를 거친다.(2018.11.12. 개정) 다만 그러하지 아니하다.(2016.8.22. 신설)'), '2018-11-12');
  });
  await check('주제 후보와 한도', async () => {
    assert.deepEqual(topicCandidates('여비규정').map(x => x.lawName), ['소득세법', '소득세법 시행령', '공무원 여비 규정']);
    assert.deepEqual(topicCandidates('도서관 이용 내규'), []);
    const plan = planLaws([], { title: '재무회계규정', maxLaws: 2 });
    assert.deepEqual(plan.laws.map(x => x.relation), ['topic_candidate', 'topic_candidate']);
    assert.equal(plan.omitted.length, 1);
  });

  await check('띄어 쓴 규정명 인식과 규정명 제외', async () => {
    const catalog = [{ lawId: 1, title: '취업규칙' }, { lawId: 2, title: '산학협력단 취업규칙' }, { lawId: 3, title: '등록금에 관한 시행세칙' }, { lawId: 4, title: '여비규정' }, { lawId: 5, title: '학칙' }];
    assert.equal(titleInQuery('산학협력단 취업규칙 연가 일수', catalog).rules[0].lawId, 2);
    assert.equal(titleInQuery('등록금에 관한 시행세칙 제7조 반환', catalog).title, '등록금에 관한 시행세칙');
    assert.equal(titleInQuery('여비규정과 취업규칙의 차이', catalog), null);
    assert.equal(titleInQuery('학칙 개정 절차', catalog), null);
    assert.equal(withoutRuleName('「등록금에 관한 시행세칙」의 반환 기준', '등록금에 관한 시행세칙'), '반환 기준');
    assert.equal(withoutRuleName('취업규칙 연차', '취업규칙'), '연차');
    assert.equal(withoutRuleName('여비규정', '여비규정'), '');
  });

  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer({ profile: 'rules' });
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

  await check('연계가 꺼진 채 본문을 요청하면 본문 완전성은 unavailable', async () => {
    const raw = await client.callTool({ name: 'get_rule_upper_laws', arguments: { law_id: 1, article: 9, include_text: true } });
    const data = raw.structuredContent.data;
    assert.deepEqual([data.lookup.status, data.textCoverage.status, data.evidenceStatus], ['not_configured', 'unavailable', 'partial']);
    assert.deepEqual(data.textCoverage.missingArticles.map(x => [x.article, x.reason]), [['제5조', 'LAW_LINK_NOT_CONFIGURED']]);
    assert.deepEqual(data.incompleteReasons, ['LAW_LOOKUP_INCOMPLETE', 'LAW_TEXT_UNAVAILABLE']);
    assert.doesNotMatch(raw.content[0].text, /잘렸습니다/);
    assert.equal(data.comparison.status, 'unavailable');
    assert.match(data.comparison.ruleArticles[0].contentMarkdown, /규정원문끝표지/);
    assert.equal(data.comparison.pairs[0].lawTextStatus, 'unavailable');
  });
  await check('연계가 꺼져 있으면 확인할 법령 목록만 반환', async () => {
    lawCalls.length = 0;
    const result = await call('get_rule_upper_laws', { law_id: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual([result.data.lookup.status, result.data.lookup.code, result.data.evidenceStatus], ['not_configured', 'LAW_LINK_NOT_CONFIGURED', 'partial']);
    assert(result.data.laws.some(x => x.lawName === '사립학교법' && x.articles.map(y => y.article).join() === '제32조의2,제29조,제31조,제99조'));
    assert(result.data.laws.every(x => x.identity.status === 'not_checked' && !x.signals.length));
    assert.equal(lawCalls.length, 0);
    // 무엇이 없고 운영자가 무엇을 넣으면 되는지 안내한다. 규정 쪽 결과는 그대로다.
    assert.deepEqual(result.data.lookup.setup, { state: 'missing', env: ['DONGGUK_LEGAL_MCP_URL', 'LAW_OC'], ocApplyUrl: 'https://open.law.go.kr' });
    for (const expected of [/DONGGUK_LEGAL_MCP_URL/, /LAW_OC/, /open\.law\.go\.kr/, /규정 쪽 결과는 그대로/]) assert.match(result.data.lookup.notice, expected);
  });
  await check('입력 검증', async () => {
    for (const args of [{ law_id: 1, max_laws: 13 }, { law_id: 1, include_text: 'yes' }, { law_id: 1, article: '가나다' }, { law_id: 0 }]) assert.equal((await call('get_rule_upper_laws', args)).error.code, 'INVALID_ARGUMENT');
    assert.equal((await call('get_rule_upper_laws', { law_id: 1, article: 55 })).error.code, 'NOT_FOUND');
  });

  const http = createHttpServer({ createServer: lawFixture, version: 'test' });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  Object.assign(process.env, { DONGGUK_LEGAL_MCP_ENABLED: '1', DONGGUK_LEGAL_MCP_TRANSPORT: 'streamable-http', DONGGUK_LEGAL_MCP_URL: `http://127.0.0.1:${http.address().port}/mcp`, DONGGUK_PUBLIC_LAW_LINK: '1' });

  await check('F1 안전보건관리규정 재현 호출은 시행일 지정 후 현재 본문으로 완전 조회', async () => {
    const raw=await client.callTool({name:'get_rule_upper_laws',arguments:{law_id:660,article:1,include_text:true}});
    const d=raw.structuredContent.data;
    assert.deepEqual([d.lookup.status,d.textCoverage.status,d.comparison.status,d.evidenceStatus],['retrieved','complete','complete','retrieved']);
    assert.equal(d.laws[0].articles[0].source.bodyEffectiveAt,'2026-10-27');
    assert.match(raw.content[0].text,/현재 합성본문/);assert.doesNotMatch(raw.content[0].text,/시행예정 합성본문/);
  });
  await check('F1 날짜 불일치·누락은 본문 대조와 최상위 상태에서도 미확인', async () => {
    for (const law_id of [661,662]) {
      const raw=await client.callTool({name:'get_rule_upper_laws',arguments:{law_id,article:1,include_text:true}});
      const d=raw.structuredContent.data;
      assert.deepEqual([d.lookup.status,d.textCoverage.status,d.comparison.status,d.evidenceStatus],['partial','unavailable','unavailable','partial']);
      assert.equal(d.laws[0].articles[0].text,undefined);
      assert.match(raw.content[0].text,/본문 시행일 미확인/);assert.match(raw.content[0].text,/LEGAL_BODY_VERSION_UNVERIFIED/);
      assert.doesNotMatch(raw.content[0].text,/시행예정 합성본문|오른쪽은 조회 시점 현행 법령 조문입니다/);
      const withoutText=(await call('get_rule_upper_laws',{law_id,article:1})).data;
      assert.equal(withoutText.evidenceStatus,'partial');
    }
  });
  await check('규정 전체: 법령별 현행 여부와 점검 신호', async () => {
    const raw = await client.callTool({ name: 'get_rule_upper_laws', arguments: { law_id: 1, max_laws: 12 } });
    const data = raw.structuredContent.data;
    const law = name => data.laws.find(x => x.lawName === name);
    const codes = name => law(name).signals.map(x => x.code);
    assert.equal(data.ruleRevisedAt, '2021-03-02');
    assert.deepEqual(law('사립학교법').articles.map(x => x.status), ['found', 'found', 'deleted', 'missing']);
    // 제7조의 인용은 그 조문의 개정 표시일(2018-11-12)과, 제31조의 인용은 규정 개정일과 비교한다.
    assert.deepEqual(codes('사립학교법'), ['LAW_EFFECTIVE_AFTER_RULE', 'ARTICLE_AMENDED_AFTER_RULE', 'ARTICLE_DELETED', 'ARTICLE_MISSING']);
    assert.match(law('사립학교법').signals[1].message, /제32조의2.*2019-04-16.*2018-11-12/);
    assert.deepEqual([law('사학기관 재무ㆍ회계 규칙에 대한 특례규칙').nameStatus, law('사학기관 재무ㆍ회계 규칙에 대한 특례규칙').identity.kind], ['candidate_name', '교육부령']);
    assert.deepEqual(codes('지가공시 및 토지 등의 평가에 관한 법률'), ['LAW_RENAMED', 'PENDING_AMENDMENT', 'ARTICLE_NUMBER_UNVERIFIED']);
    assert.equal(law('지가공시 및 토지 등의 평가에 관한 법률').identity.name, '부동산 가격공시에 관한 법률');
    assert.deepEqual(codes('향토예비군설치법').slice(0, 1), ['LAW_RENAMED']);
    assert.deepEqual(codes('없는가상법'), ['LAW_NOT_FOUND']);
    assert(!data.laws.some(x => x.lawName === '교원인사규정'), '교내 규정은 상위법령이 아님');
    assert.equal(data.counts.cited, 5);
    assert.equal(data.evidenceStatus, 'retrieved');
    assert.deepEqual([data.textCoverage.status, data.incompleteReasons], ['not_requested', []]);
    assert(data.laws.every(x => x.articles.every(y => y.text === undefined)), 'include_text 없이 원문 미포함');
    assert.equal(data.comparison.status, 'not_requested');
    assert.deepEqual(data.comparison.ruleArticles, []);
    assert.deepEqual(data.comparison.pairs, []);
    assert.match(raw.content[0].text, /점검 신호/);
    assert.match(raw.content[0].text, /충돌이나 적용 여부를 판정한 것이 아닙니다/);
  });
  await check('조문 지정 + 원문 대조, 주제 후보 생략', async () => {
    const raw = await client.callTool({ name: 'get_rule_upper_laws', arguments: { law_id: 1, article: 9, include_text: true } });
    const data = raw.structuredContent.data;
    assert.deepEqual(data.laws.map(x => x.lawName), ['사학기관 재무ㆍ회계 규칙에 대한 특례규칙']);
    assert.match(data.laws[0].articles[0].text, /복식부기/);
    assert.match(raw.content[0].text, /조문 대조[\s\S]*규정 제9조: [\s\S]*복식부기/);
    assert.equal(data.coverage.scope, 'selected_article');
    assert.deepEqual([data.textCoverage.status, data.textCoverage.truncatedArticles, data.textCoverage.missingArticles, data.evidenceStatus], ['complete', [], [], 'retrieved']);
  });
  await check('본문 완전성: 미조회·조문 상한·잘림을 구분하고 complete로 올리지 않는다', async () => {
    const probe = async args => { const raw = await client.callTool({ name: 'get_rule_upper_laws', arguments: { include_candidates: false, include_text: true, ...args } }); return { data: raw.structuredContent.data, text: raw.content[0].text }; };
    const failed = await probe({ law_id: 101 });
    assert.deepEqual([failed.data.lookup.status, failed.data.textCoverage.status, failed.data.evidenceStatus], ['partial', 'unavailable', 'partial']);
    assert.deepEqual(failed.data.textCoverage.missingArticles.map(x => [x.article, x.articleStatus, x.reason]), [['제101조', 'unavailable', 'LEGAL_BODY_ERROR']]);
    assert.deepEqual(failed.data.incompleteReasons, ['LAW_LOOKUP_INCOMPLETE', 'LAW_TEXT_UNAVAILABLE']);
    assert.match(failed.text, /본문을 가져오지 못한 법령 조문이 있습니다\(사립학교법 제101조: LEGAL_BODY_ERROR\)/);
    assert.doesNotMatch(failed.text, /잘렸습니다/, '미조회를 잘림으로 설명하지 않는다');

    const limited = await probe({ law_id: 102 });
    assert.deepEqual([limited.data.lookup.status, limited.data.textCoverage.status, limited.data.evidenceStatus], ['partial', 'partial', 'partial']);
    assert.equal(limited.data.laws[0].articles.filter(x => x.text).length, 8);
    assert.deepEqual(limited.data.textCoverage.missingArticles.map(x => [x.article, x.reason]), [['제9조', 'ARTICLE_LIMIT']]);
    assert.deepEqual([limited.data.textCoverage.truncatedArticles, limited.data.incompleteReasons], [[], ['LAW_LOOKUP_INCOMPLETE', 'LAW_TEXT_UNAVAILABLE']]);
    assert.doesNotMatch(limited.text, /잘렸습니다/);

    const cut = await probe({ law_id: 103 });
    assert.deepEqual([cut.data.lookup.status, cut.data.textCoverage.status, cut.data.evidenceStatus, cut.data.incompleteReasons], ['retrieved', 'partial', 'partial', ['LAW_TEXT_TRUNCATED']]);
    assert.deepEqual([cut.data.laws[0].articles[0].text.length, cut.data.textCoverage.truncatedArticles, cut.data.textCoverage.missingArticles], [3000, [{ lawName: '사립학교법', article: '제50조', mst: '9001' }], []]);
    assert.match(cut.text, /3000자에서 잘렸습니다\(사립학교법 제50조\)[\s\S]*get_law_text/);
    assert.doesNotMatch(cut.text, /본문을 가져오지 못한/);

    const off = (await client.callTool({ name: 'get_rule_upper_laws', arguments: { law_id: 103, include_candidates: false } })).structuredContent.data;
    assert.deepEqual([off.textCoverage.status, off.evidenceStatus, off.incompleteReasons], ['not_requested', 'retrieved', []]);
    // 삭제·없음이 확인된 조문은 가져올 본문이 없으므로 미조회로 세지 않는다.
    const mixed = await probe({ law_id: 1, article: 31 });
    assert.deepEqual([mixed.data.laws[0].articles.map(x => x.status), mixed.data.textCoverage.status, mixed.data.textCoverage.missingArticles], [['found', 'deleted', 'missing'], 'complete', []]);
  });
  await check('인용이 없는 규정은 주제 후보만, 끄면 빈 결과', async () => {
    const result = await call('get_rule_upper_laws', { law_id: 2 });
    assert.deepEqual(result.data.laws.map(x => `${x.lawName}|${x.relation}|${x.identity.status}`), ['소득세법|topic_candidate|current', '소득세법 시행령|topic_candidate|current', '공무원 여비 규정|topic_candidate|current']);
    assert(result.data.laws.every(x => !x.signals.length));
    const none = await call('get_rule_upper_laws', { law_id: 2, include_candidates: false });
    assert.deepEqual([none.data.laws.length, none.data.lookup.status, none.data.evidenceStatus], [0, 'not_required', 'retrieved']);
  });
  await check('인용 문구 밖 규정 조문 전체와 법령 원문을 나란히 반환', async () => {
    const raw = await client.callTool({name:'get_rule_upper_laws',arguments:{law_id:1,article:9,include_text:true}});
    const d=raw.structuredContent.data, cmp=d.comparison, pair=cmp.pairs[0], rule=cmp.ruleArticles[0];
    assert.equal(cmp.status,'complete'); assert.equal(rule.id,pair.ruleArticleId);
    assert.match(rule.contentMarkdown,/① 부서장은 월별 증빙[\s\S]*② 장부 검토[\s\S]*규정원문끝표지/);
    assert.equal(rule.textCoverage.totalChars,rule.contentMarkdown.length);
    assert.equal(rule.source.sourceType,'HTML 본문'); assert.equal(rule.source.historyId,20);
    assert.match(d.laws[pair.lawIndex].articles[pair.lawArticleIndex].text,/복식부기/);
    assert.match(raw.content[0].text,/\| 규정 조문 원문 \(HTML\) \| 인용한 국가 법령 조문 원문 \(현행본\) \|/);
    assert.match(raw.content[0].text,/규정원문끝표지/); assert.match(raw.content[0].text,/충돌이나 적용 여부를 판정한 것이 아닙니다/);
  });
  await check('같은 법령을 여러 규정 조문이 인용해도 본문 위치별 연결 유지', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:1,include_text:true,max_laws:12})).data;
    const pairs=d.comparison.pairs.filter(p=>p.lawName==='사립학교법');
    assert.deepEqual(pairs.map(p=>d.comparison.ruleArticles.find(r=>r.id===p.ruleArticleId).article),['제7조','제31조','제31조','제31조']);
    assert(d.comparison.pairs.some(p=>p.lawName==='지가공시 및 토지 등의 평가에 관한 법률' && d.laws[p.lawIndex].identity.status==='renamed'));
    assert(d.laws.some(l=>l.signals.some(s=>s.code==='ARTICLE_NUMBER_UNVERIFIED')));
  });
  await check('가지조문·서로 다른 항의 인용 보존과 추가 법령 요청 없음', async () => {
    await call('get_rule_upper_laws',{law_id:107,article:'제10조의2'});
    lawCalls.length=0;
    const d=(await call('get_rule_upper_laws',{law_id:107,article:'제10조의2',include_text:true})).data;
    assert.equal(d.comparison.ruleArticles.length,1); assert.equal(d.comparison.ruleArticles[0].article,'제10조의2');
    assert.deepEqual(d.comparison.pairs.map(x=>x.paragraph),['제1항','제2항']);
    assert(d.comparison.pairs.every(x=>x.lawArticleIndex===0)); assert.equal(lawCalls.length,0);
  });
  await check('과거 규정 개정본과 현행 법령 시점을 혼동하지 않음', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:107,history_id:19,article:'제10조의2',include_text:true})).data;
    assert.equal(d.comparison.ruleArticles[0].source.historyId,19); assert.equal(d.comparison.ruleArticles[0].source.revisedAt,'2019.01.01');
    assert.match(d.comparison.ruleArticles[0].contentMarkdown,/과거 규정 고유본문/);
    assert.equal(d.laws[0].identity.effectiveAt,'2024-03-01'); assert.equal(d.applicability,'requires_review');
    assert(d.comparison.ruleArticles[0].source.sourceUrl.endsWith('SEQ=107&SEQ_HISTORY=19'));
  });
  await check('번호가 같은 본칙·두 부칙의 본문을 서로 섞지 않음', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:108,include_text:true})).data;
    assert.equal(new Set(d.comparison.pairs.map(x=>x.ruleArticleId)).size,3);
    assert.deepEqual(d.comparison.ruleArticles.map(x=>x.article),['제1조','부칙 제1조','부칙 제1조']);
    const selected=(await call('get_rule_upper_laws',{law_id:108,article:'부칙(2021.1.1.) 제1조',include_text:true})).data;
    assert.match(selected.comparison.ruleArticles[0].supplementaryHeading,/2021/);
    assert.match(selected.comparison.ruleArticles[0].contentMarkdown,/둘째부칙고유/);
    assert.doesNotMatch(selected.comparison.ruleArticles[0].contentMarkdown,/첫부칙고유|본칙고유/);
    assert.equal((await call('get_rule_upper_laws',{law_id:108,article:'부칙 제1조',include_text:true})).error.code,'AMBIGUOUS_ARTICLE');
  });
  await check('규정 본문 잘림은 법령 textCoverage와 별도 표시·고정 개정본 복구 안내', async () => {
    const raw=await client.callTool({name:'get_rule_upper_laws',arguments:{law_id:104,include_text:true}}); const d=raw.structuredContent.data;
    assert.equal(d.textCoverage.status,'complete'); assert.equal(d.comparison.status,'partial'); assert.equal(d.evidenceStatus,'partial');
    assert(d.incompleteReasons.includes('RULE_TEXT_TRUNCATED')); const r=d.comparison.ruleArticles[0];
    assert.equal(r.contentMarkdown.length,6000); assert.equal(r.textCoverage.truncated,true);
    assert.deepEqual(r.fullTextRequest,{tool:'get_rule_full_text',arguments:{law_id:104,history_id:20}});
    assert.match(raw.content[0].text,/규정 본문 잘림/);
  });
  await check('규정 본문 합계 한도는 중복 조문을 한 번만 세고 미반환은 partial', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:109,include_text:true})).data;
    assert.equal(d.comparison.ruleArticles.reduce((n,r)=>n+r.contentMarkdown.length,0),24000);
    assert.equal(d.comparison.ruleArticles[4].textCoverage.status,'unavailable');
    assert(d.incompleteReasons.includes('RULE_TEXT_UNAVAILABLE')); assert.equal(d.comparison.status,'partial');
  });
  await check('대조 인용 한도와 article 선택 재조회', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:105,include_text:true})).data;
    assert.equal(d.comparison.pairs.length,24); assert.equal(d.comparison.omittedPairs,6);
    assert(d.incompleteReasons.includes('COMPARISON_LIMIT')); assert.equal(d.comparison.status,'partial');
    const selected=(await call('get_rule_upper_laws',{law_id:105,article:30,include_text:true})).data;
    assert.equal(selected.comparison.status,'complete'); assert.match(selected.comparison.ruleArticles[0].contentMarkdown,/본문30/);
  });
  await check('법령명만 있는 인용은 임의로 대응 조문을 채우지 않음', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:106,include_text:true})).data;
    assert.equal(d.textCoverage.status,'not_required'); assert.equal(d.comparison.status,'unavailable');
    assert.equal(d.comparison.pairs[0].lawArticleIndex,null); assert.equal(d.comparison.pairs[0].lawTextStatus,'not_specified');
    assert(d.incompleteReasons.includes('LAW_ARTICLE_UNSPECIFIED')); assert.equal(d.evidenceStatus,'partial');
  });
  await check('삭제 표지 본문과 없는 조문의 미확보 상태를 구분', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:110,include_text:true})).data;
    assert.equal(d.lookup.status,'retrieved'); assert.equal(d.textCoverage.status,'not_required'); assert.equal(d.laws[0].articles[0].status,'missing');
    assert.equal(d.comparison.status,'unavailable'); assert(d.incompleteReasons.includes('LAW_TEXT_UNAVAILABLE'));
    const whole=(await call('get_rule_upper_laws',{law_id:1,article:31,include_text:true})).data;
    const deleted=whole.comparison.pairs.find(p=>p.lawArticle==='제31조');
    assert.equal(deleted.lawTextStatus,'complete'); assert.match(whole.laws[deleted.lawIndex].articles[deleted.lawArticleIndex].text,/삭제/);
  });
  await check('긴 법령·실패·조문 상한은 대조 상태도 partial/unavailable', async () => {
    for(const [id,status,reason] of [[103,'partial','LAW_TEXT_TRUNCATED'],[101,'unavailable','LAW_TEXT_UNAVAILABLE'],[102,'partial','LAW_TEXT_UNAVAILABLE']]) {
      const d=(await call('get_rule_upper_laws',{law_id:id,include_text:true,include_candidates:false})).data;
      assert.equal(d.comparison.status,status); assert(d.incompleteReasons.includes(reason)); assert.equal(d.evidenceStatus,'partial');
    }
  });
  await check('주제 후보를 법령 대조 본문으로 꾸미지 않음', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:2,include_text:true})).data;
    assert.equal(d.comparison.status,'not_required'); assert.deepEqual(d.comparison.pairs,[]); assert.deepEqual(d.comparison.ruleArticles,[]);
  });
  await check('표 구분자·HTML·줄바꿈을 보존하는 표시', async () => {
    const raw=await client.callTool({name:'get_rule_upper_laws',arguments:{law_id:111,include_text:true}});
    assert.match(raw.structuredContent.data.comparison.ruleArticles[0].contentMarkdown,/항목 \| 값\n<표> & 문구/);
    assert.match(raw.content[0].text,/항목 &#124; 값<br>&lt;표&gt; &amp; 문구/);
  });
  await check('법령 수 한도로 생략된 대조도 partial', async () => {
    const d=(await call('get_rule_upper_laws',{law_id:1,max_laws:1,include_text:true})).data;
    assert(d.omitted.some(x=>x.relation==='cited')); assert.equal(d.comparison.status,'partial'); assert(d.comparison.incompleteReasons.includes('LAW_LIMIT'));
  });

  await check('같은 날 같은 법령은 캐시에서, 실패는 캐시하지 않음', async () => {
    lawCalls.length = 0;
    await call('get_rule_upper_laws', { law_id: 2 });
    assert.equal(lawCalls.length, 0);
    seed('content-v4', '2_20', { title: '여비규정', markdown: '### 제1조(목적)\n「사립학교교직원 연금법」 제3조를 따른다.' });
    mode = 'maintenance';
    const down = await call('get_rule_upper_laws', { law_id: 2, include_candidates: false });
    assert.deepEqual([down.ok, down.data.lookup.status, down.data.laws[0].identity.status, down.data.laws[0].signals[0].code], [true, 'unavailable', 'unavailable', 'LAW_LOOKUP_FAILED']);
    mode = 'ok';
    const retry = await call('get_rule_upper_laws', { law_id: 2, include_candidates: false });
    assert.equal(retry.data.laws[0].identity.status, 'not_found');
  });
  await check('도구 목록과 서비스 정보', async () => {
    const tools = (await client.listTools()).tools;
    assert(tools.some(x => x.name === 'get_rule_upper_laws' && x.annotations.readOnlyHint));
    const info = await call('get_service_info', {});
    assert.equal(info.data.toolCount, tools.length);
    assert.equal(info.data.integrations.lawLink.upperLawTool, 'get_rule_upper_laws');
    assert.equal(info.data.integrations.lawLink.upperLawComparison.response, 'comparison');
    assert.equal(info.data.integrations.lawLink.upperLawComparison.maxPairs, 24);
    assert.equal(info.data.toolCount, 15);
  });

  await client.close();
  await closeLegalClient();
  await new Promise(resolve => http.close(resolve));
  console.log(`📊 상위법령 관계 검증: ${passed}개 통과`);
}
main().then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });

// Exercise actual MCP handlers with an isolated cache and no external requests.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-reliability-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
let networkCalls = 0;
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => {
  networkCalls++;
  throw new Error('Network disabled in offline regression test');
};
const { createServer } = require('../src/index.js');
const { compareRuleMarkdown } = require('../src/versioning.js');
const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
function seed(category, key, data) {
  const folder = path.join(dir, category);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${key}.json`), JSON.stringify(data));
}
const searchKey = crypto.createHash('md5').update(['여비규정', false, 1, 10, '0'].join('|')).digest('hex');
seed('search', searchKey, { total: 1, hits: [{ lawId: 1, historyId: 10, title: '여비규정', revisedAt: '2024.01.01' }] });
seed('search', crypto.createHash('md5').update(['여비',false,1,10,'0'].join('|')).digest('hex'), { total:0,hits:[] });
seed('search', crypto.createHash('md5').update(['여비규정',false,1,10,'1'].join('|')).digest('hex'),{total:1,hits:[{lawId:1,historyId:10,title:'여비규정'}]});
seed('history', '1', [{ historyId: 20, revisedAt: '2026.09.01' }, { historyId: 10, revisedAt: '2024.01.01' }]);
seed('original', '1_20', { markdown: '제1조(여비)\n최신 숙박비 기준' });
seed('original', '1_10', { markdown: '제1조(여비)\n과거 숙박비 기준' });
seed('content', '1_10', { title: '여비규정', markdown: '### 제1조(여비)\n과거 기준' });
seed('content', '1_20', { title: '여비규정', markdown: '### 제1조(여비)\n최신 기준' });
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`  ✅ ${name}`); }
async function main() {
  const server = createServer({profile:'finance'});
  const client = new Client({ name: 'regression', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const value of [1.9, true, [1], '1e2', 0, -1, 9007199254740992]) {
      const response = await call('get_rule_content', { law_id: value });
      check(`잘못된 law_id 거부: ${JSON.stringify(value)}`, response.structuredContent.error.code === 'INVALID_ARGUMENT');
    }
    for (const name of ['get_rule_content', 'get_rule_toc']) {
      const response = await call(name, { law_id: 1, history_id: 0 });
      check(`${name}: 잘못된 개정본을 최신으로 대체하지 않음`, response.structuredContent.error.code === 'INVALID_ARGUMENT');
    }
    const invalidTarget = await call('compare_rule_versions', { law_id: 1, from_history_id: 10, to_history_id: false });
    check('잘못된 비교 대상 거부', invalidTarget.structuredContent.error.code === 'INVALID_ARGUMENT');
    const lookup = await call('lookup_dongguk_rule', { rule_keyword: '여비규정', terms: '숙박비' });
    const rule = lookup.structuredContent.data.rules[0];
    check('검색 캐시보다 최신 연혁 선택', rule.historyId === 20);
    check('개정일도 동일 연혁에서 반환', rule.revisedAt === '2026.09.01');
    check('실제로 최신 원문 사용', rule.excerpt.text.includes('최신 숙박비'));
    const financePath=path.join(root,'finance-pack.json');
    fs.writeFileSync(financePath,JSON.stringify({version:'test',workflows:[{id:'travel',title:'출장',keywords:['출장'],required_facts:[{key:'base_date',label:'기준일'},{key:'campus',label:'캠퍼스'}],source_notes:[],steps:['검토'],checks:[],completion_evidence:['확인'],rule_requests:[{keyword:'여비규정',terms:'숙박비',baseline_history_id:10}],legal_requests:[]}],cards:[]}));
    process.env.DONGGUK_FINANCE_PACK_PATH=financePath;
    const privateInput=await call('get_finance_context',{query:'출장 계좌번호: '+['000','0000','0000'].join('-')});
    check('재무 도구가 계좌형 개인값 입력 차단',privateInput.structuredContent.error.code==='SENSITIVE_INPUT');
    const historical=await call('get_finance_evidence',{query:'출장',facts:{base_date:'2024-02-01',campus:'서울'}});
    check('재무 근거는 과거 기준일 개정본 후보 선택',historical.structuredContent.data.rules[0].structuredContent.data.rules[0].historyId===10);
    check('개정 차이와 조항 변경을 구분',historical.structuredContent.data.freshness[0].status==='revision_changed');
    check('근거 조회를 적용 판단으로 승격하지 않음',historical.structuredContent.data.applicability==='requires_review');
    const badHistory=await call('get_rule_content',{law_id:1,history_id:999});
    check('본문 조회도 소속이 다른 개정본 차단',badHistory.structuredContent.error.code==='HISTORY_NOT_FOUND');
    const foreign = await call('compare_rule_versions', { law_id: 1, from_history_id: 999, to_history_id: 20 });
    check('다른 규정 개정본 차단', foreign.structuredContent.error.code === 'HISTORY_NOT_FOUND');
    const missing = await call('compare_rule_versions', { law_id: 1, from_history_id: 10, article: '제99조' });
    check('양쪽에 없는 조문은 NOT_FOUND', missing.structuredContent.error.code === 'NOT_FOUND');
    const comparison = await call('compare_rule_versions', { law_id: '1', from_history_id: 10, include_appendices:false });
    check('정상 비교 및 숫자 문자열 호환', comparison.structuredContent.data.counts.changed === 1);
    check('비교 범위 표시', comparison.structuredContent.data.comparisonScope === 'html_articles' && comparison.content[0].text.includes('HWP 별표'));
    check('조문 없는 문서 비교 거부', compareRuleMarkdown('# 제목\n본문', '# 제목\n다른 본문').error === 'CONTENT_UNAVAILABLE');
    check('한쪽 파싱 실패를 전체 삭제로 오인하지 않음', compareRuleMarkdown('### 제1조(목적)\n본문', '# 제목').error === 'CONTENT_UNAVAILABLE');
    check('앞선 검증은 외부 요청 없이 수행', networkCalls === 0);
    fs.unlinkSync(path.join(dir, 'original', '1_20.json'));
    const fallback = await call('lookup_dongguk_rule', { rule_keyword: '여비규정' });
    check('HWP 실패 시 HTML 대체와 경고', fallback.structuredContent.data.rules[0].warning.code === 'HWP_FALLBACK');
    const incomplete=await call('get_finance_evidence',{query:'출장',facts:{base_date:'2026-09-05',campus:'서울'}});
    check('재무 근거의 HWP 실패는 부분 조회로 표시',incomplete.structuredContent.data.evidence_status==='partial');
    check('대체 본문에 HWP 포함 완료를 단정하지 않음', !fallback.content[0].text.includes('원문 HWP의 관련 조문·별표가 포함되어 있습니다'));
    console.log(`📊 신뢰성 회귀 검증: ${passed}개 통과`);
  } finally {
    await client.close();
    await server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));

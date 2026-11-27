'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-excerpt-policy-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
process.env.DONGGUK_MCP_SEMANTIC = '0';
delete process.env.DONGGUK_MCP_EXCERPT;
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async url => {
  assert(String(url).includes('/search/'), `Unexpected network: ${url}`);
  return {ok:true,status:200,text:async()=>'<p class="infoLeft"><span>0</span>건</p><table><tbody class="tbody"></tbody></table>'};
};
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = require('../src/index');
const { buildCorpus, saveCorpus } = require('../src/corpus');
const dir = path.join(root, 'dongguk-rule-mcp/v2/public');
const catalog = [{lawId:1,historyId:10,title:'실험운영규정',code:'9-9',revisedAt:'2026.01.01'}];
const markdown = '### 제3조(신청)\n연령은 신청서에 적는다.\n\n### 제7조(정년)\n정년 퇴직 정년 퇴직 정년 퇴직\n\n### 제8조(접수)\n신청 신청 신청\n\n신청 신청\n\n### 제11조(후속처리)\n신청 접수 후 통보한다.';
function seed(category, key, value) {
  fs.mkdirSync(path.join(dir,category), {recursive:true});
  fs.writeFileSync(path.join(dir,category,`${key}.json`),JSON.stringify(value));
}
seed('catalog','all',catalog);
seed('history','1',[{historyId:10,revisedAt:'2026.01.01'}]);
seed('content-v4','1_10',{title:catalog[0].title,markdown});
seed('original-structure-v2','1_10',{markdown,structure:{coverage:{articles:'complete'}}});
(async()=>{
  saveCorpus(dir, await buildCorpus({catalog,loadContent:async()=>({title:catalog[0].title,markdown})}));
  const server = createServer();
  const client = new Client({name:'excerpt-policy-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  let passed = 0;
  const check = (name, condition) => {assert(condition,name); passed++; console.log(`✅ ${name}`);};
  const call = async (mode,args={query:'「실험운영규정」 연령',max_sections:1}) => {
    if(mode===undefined) delete process.env.DONGGUK_MCP_EXCERPT;
    else process.env.DONGGUK_MCP_EXCERPT=mode;
    const response = await client.callTool({name:'lookup_dongguk_rule',arguments:args});
    assert(response.structuredContent?.ok,JSON.stringify(response.structuredContent));
    return response.structuredContent.data;
  };
  const invariant = data => ({search:data.search,rules:data.rules.map(({excerpt,evidenceStatus,incompleteReasons,...rule})=>rule)});
  try {
    const baseline = await call();
    const explicit = await call('legacy');
    const invalid = await call('typo');
    check('기본값·명시 legacy·잘못된 값 응답 동일(조회시각 제외)', [explicit,invalid].every(data=>JSON.stringify({...data,source:{...data.source,returnedAt:''}})===JSON.stringify({...baseline,source:{...baseline.source,returnedAt:''}})));
    for (const mode of ['article','literal','article-literal']) {
      const actual = await call(mode);
      assert.deepEqual(invariant(actual),invariant(baseline));
      check(`${mode}: 규정 선택·순위 근거 불변`,true);
      if(mode.includes('literal')) {
        check(`${mode}: 실제 응답의 발췌 조건에서 확장 낱말 제외`,actual.query.effectiveTerms==='연령');
        check(`${mode}: 질문 낱말이 있는 조문을 선택`,actual.rules[0].excerpt.text.includes('제3조')&&!actual.rules[0].excerpt.text.includes('제7조'));
      }
    }
    const specified = await call('article-literal',{query:'「실험운영규정」 연령',terms:'제7조',max_sections:1});
    check('사용자가 명시한 조문 조건 보존',specified.query.effectiveTerms==='제7조'&&specified.rules[0].excerpt.text.includes('제7조'));
    const keywords = await call('article-literal',{query:'「실험운영규정」 연령',keywords:'정년',max_sections:1});
    check('사용자가 명시한 핵심어 보존',keywords.query.effectiveTerms.includes('정년'));
    const restored = await call();
    assert.deepEqual(restored.rules,baseline.rules);
    check('동일 프로세스에서 실험 해제 후 기존 발췌 복원',true);
    console.log(`발췌 정책 MCP 검증 ${passed}개 통과`);
  } finally { await client.close(); await server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});

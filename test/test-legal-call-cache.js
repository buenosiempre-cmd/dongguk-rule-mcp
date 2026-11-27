// Law-call cache, upstream rate-limit retry, own-key header and upper-law paging, offline.
'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createDiskCache}=require('../src/cache.js');
const lc=require('../src/legal-client.js');
const {planLaws}=require('../src/upper-laws.js');
const {queryLegalReferences,inspectLaws,resilientCaller,callCacheKey,rateLimitOf,legalCallStats,resetLegalCallStats,legalServerState,closeLegalClient}=lc;

const text=(value,isError=false)=>({content:[{type:'text',text:value}],...(isError?{isError:true}:{})});
const LAWS={사립학교법:{id:'000888',mst:'9001'},소득세법:{id:'001565',mst:'9005'}};
const listing=name=>text(`1. ${name} [현행]\n   - 법령ID: ${LAWS[name].id}\n   - MST: ${LAWS[name].mst}\n   - 공포일: 20240101 / 시행일: 20240301\n   - 구분: 법률\n`);
const body=(name,jo)=>text(`법령명: ${name}\n공포일: 20240101\n시행일: 20240301\n\n${jo}(합성)\n합성 조문입니다. <개정 2020.3.24>\n`);
function fakeClient(){
  const calls=[];
  return {calls,async callTool({name,arguments:a}){calls.push({name,args:a});
    if(name==='search_law'){const law=Object.keys(LAWS).find(x=>x===a.query);return law?listing(law):text(`[NOT_FOUND] 법령 '${a.query}' 검색 결과가 없습니다.`,true);}
    if(name==='get_law_text'){const law=Object.keys(LAWS).find(x=>LAWS[x].mst===String(a.mst));return body(law,a.jo||'제1조');}
    throw new Error('unexpected');}};
}
const memoryCache=()=>{const store=new Map();const fn=async(category,key,ttl,load)=>{const k=`${category}/${key}`;if(store.has(k))return store.get(k);const v=await load();store.set(k,v);return v;};fn.store=store;return fn;};
const tests=[];const test=(name,fn)=>tests.push({name,fn});

test('cache keys: listing per KST day, MST-pinned text, nothing for unknown tools',()=>{
  const day1=Date.parse('2026-11-26T10:00:00+09:00'),day2=Date.parse('2026-11-27T00:30:00+09:00');
  assert.notEqual(callCacheKey('search_law',{query:'민법',display:100},day1),callCacheKey('search_law',{query:'민법',display:100},day2));
  assert.equal(callCacheKey('search_law',{display:100,query:'민법'},day1),callCacheKey('search_law',{query:'민법',display:100},day1));
  assert.equal(callCacheKey('get_law_text',{mst:'1',jo:'제1조'},day1),callCacheKey('get_law_text',{mst:'1',jo:'제1조'},day2));
  assert.equal(callCacheKey('get_law_text',{lawName:'민법'},day1),null);
  assert.equal(callCacheKey('compare_old_new',{a:1},day1),null);
});
test('rate-limit detection: HTTP 429, quota text, but not ordinary errors',()=>{
  assert.ok(rateLimitOf(Object.assign(new Error('Error POSTing to endpoint: Too Many Requests'),{code:429}),null));
  assert.equal(rateLimitOf(null,text('[RATE_LIMITED] 공용 한도 초과. 12초 후 다시 시도하세요.',true)).waitMs,12000);
  assert.equal(rateLimitOf(Object.assign(new Error('connection reset'),{code:'ECONNRESET'}),null),null);
  assert.equal(rateLimitOf(null,text('[NOT_FOUND] 검색 결과가 없습니다.',true)),null);
  assert.equal(rateLimitOf(null,text('본문에 quota라는 낱말이 있어도 정상 응답')),null);
});
test('identical calls are served from the cache; failures are never cached',async()=>{
  resetLegalCallStats();
  const cache=memoryCache();let n=0;
  const call=resilientCaller(async(name,args)=>{n++;return args.query==='없는법'?text('[NOT_FOUND] 검색 결과가 없습니다.',true):listing('민법'in LAWS?'민법':'사립학교법');},{cache});
  await call('search_law',{query:'사립학교법',display:100});
  const second=await call('search_law',{query:'사립학교법',display:100});
  assert.equal(n,1);assert.match(second.content[0].text,/사립학교법/);
  await call('search_law',{query:'없는법',display:100});await call('search_law',{query:'없는법',display:100});
  assert.equal(n,3);
  const s=legalCallStats();assert.equal(s.upstreamCalls,3);assert.equal(s.cacheHits,1);
});
test('HTTP 429 is retried with backoff and then succeeds',async()=>{
  resetLegalCallStats();
  const waits=[];let n=0;
  const call=resilientCaller(async()=>{n++;if(n<3)throw Object.assign(new Error('Error POSTing to endpoint: {"error":"rate limit","retryAfter":2}'),{code:429});return listing('소득세법');},{cache:null,sleep:async ms=>{waits.push(ms);}});
  const r=await call('search_law',{query:'소득세법',display:100});
  assert.match(r.content[0].text,/소득세법/);assert.equal(n,3);assert.equal(waits.length,2);assert.ok(waits.every(ms=>ms>0&&ms<=5000));
  assert.equal(legalCallStats().retries,2);assert.equal(legalCallStats().rateLimited,2);
});
test('persistent 429 ends with LEGAL_UPSTREAM_RATE_LIMITED, never an endless loop',async()=>{
  let n=0;
  const call=resilientCaller(async()=>{n++;return text('HTTP 429 Too Many Requests',true);},{cache:null,sleep:async()=>{}});
  await assert.rejects(call('search_law',{query:'x'}),e=>e.code==='LEGAL_UPSTREAM_RATE_LIMITED');
  assert.equal(n,3);
});
test('no retry starts when the total deadline cannot fit the wait',async()=>{
  let n=0,slept=false;
  const call=resilientCaller(async()=>{n++;throw Object.assign(new Error('429'),{code:429});},{cache:null,deadline:()=>Date.now()+500,sleep:async()=>{slept=true;}});
  await assert.rejects(call('search_law',{query:'x'}),e=>e.code==='LEGAL_UPSTREAM_RATE_LIMITED');
  assert.equal(n,1);assert.equal(slept,false);
});
test('upper-law inspection: one law cited by several rules is searched once',async()=>{
  const client=fakeClient(),cache=memoryCache();
  for(const articles of [['제29조'],['제31조','제29조'],['제29조']]){
    const r=await inspectLaws([{name:'사립학교법',articles}],{client,cache,now:new Date('2026-11-26T03:00:00Z')});
    assert.equal(r.laws[0].identity.status,'current');
  }
  assert.equal(client.calls.filter(c=>c.name==='search_law').length,1);
  assert.equal(client.calls.filter(c=>c.name==='get_law_text').length,2); // 제29조·제31조 each once
});
test('law-text lookups reuse cached bodies and keep the original retrieval time',async()=>{
  const client=fakeClient(),cache=memoryCache();
  const req=[{law_name:'소득세법',article:'제12조'}];
  const first=await queryLegalReferences(req,{client,cache,now:new Date('2026-11-26T03:00:00Z')});
  await new Promise(r=>setTimeout(r,15));
  const second=await queryLegalReferences(req,{client,cache,now:new Date('2026-11-26T03:00:00Z')});
  assert.equal(first.status,'retrieved');assert.equal(second.status,'retrieved');
  assert.equal(client.calls.length,2); // one search, one body, nothing on the repeat
  assert.equal(second.results[0].articles[0].source.retrievedAt,first.results[0].articles[0].source.retrievedAt);
});
test('injected clients stay uncached unless a cache is passed (existing call-count tests)',async()=>{
  const client=fakeClient();
  for(let i=0;i<2;i++) await queryLegalReferences([{law_name:'소득세법',article:'제12조'}],{client,now:new Date('2026-11-26T03:00:00Z')});
  assert.equal(client.calls.length,4);
});
test('disk cache: a second process-level lookup reads the file, not the provider',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'legal-call-'));
  const cache=createDiskCache({directory:()=>dir});
  const client=fakeClient();
  await inspectLaws([{name:'소득세법',articles:['제12조']}],{client,cache});
  await inspectLaws([{name:'소득세법',articles:['제12조']}],{client,cache:createDiskCache({directory:()=>dir})});
  assert.equal(client.calls.length,2);
  assert.ok(fs.readdirSync(path.join(dir,'legal-call')).length>=2);
});
test('own 법제처 key goes to the hosted server as the apikey header and never into results',async()=>{
  const seen=[];
  const server=http.createServer((req,res)=>{seen.push(req.headers);res.writeHead(500,{'content-type':'text/plain'});res.end('fixture');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const saved={...process.env};
  try{
    Object.assign(process.env,{DONGGUK_LEGAL_MCP_ENABLED:'1',DONGGUK_LEGAL_MCP_TRANSPORT:'streamable-http',DONGGUK_LEGAL_MCP_URL:`http://127.0.0.1:${server.address().port}/law`,DONGGUK_LEGAL_MCP_API_KEY:'fixture-oc-key'});
    delete process.env.DONGGUK_LEGAL_MCP_BEARER_TOKEN;
    assert.equal(legalServerState().quota,'own_key');
    const r=await queryLegalReferences([{law_name:'소득세법',article:'제12조'}],{timeoutMs:3000,totalTimeoutMs:5000});
    assert.ok(seen.length>=1);assert.equal(seen[0].apikey,'fixture-oc-key');
    assert.doesNotMatch(JSON.stringify(r),/fixture-oc-key/);
    delete process.env.DONGGUK_LEGAL_MCP_API_KEY;
    assert.equal(legalServerState().quota,'local_operator_key');
    process.env.DONGGUK_LEGAL_MCP_API_KEY='bad\r\nkey';
    assert.equal(legalServerState().state,'invalid');
  }finally{
    for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k];
    Object.assign(process.env,saved);await closeLegalClient();server.close();
  }
});
test('quota label: loopback local server is the operator key, remote keyless is the shared quota',()=>{
  const saved={...process.env};
  const quota=url=>{process.env.DONGGUK_LEGAL_MCP_URL=url;return legalServerState().quota;};
  try{
    Object.assign(process.env,{DONGGUK_LEGAL_MCP_ENABLED:'1',DONGGUK_LEGAL_MCP_TRANSPORT:'streamable-http'});
    for(const k of ['DONGGUK_LEGAL_MCP_API_KEY','DONGGUK_LEGAL_MCP_BEARER_TOKEN']) delete process.env[k];
    assert.equal(quota('http://127.0.0.1:3858/mcp'),'local_operator_key');
    assert.equal(quota('http://localhost:3858/mcp'),'local_operator_key');
    assert.equal(quota('http://[::1]:3858/mcp'),'local_operator_key');
    assert.equal(quota('https://127.0.0.1:3858/mcp'),'local_operator_key');
    assert.equal(quota('https://law.example.org/mcp'),'shared_keyless');
    assert.equal(quota('https://127.0.0.1.example.org/mcp'),'shared_keyless');
    assert.equal(quota('http://law.example.org/mcp'),undefined);
    assert.equal(legalServerState().state,'invalid');
    process.env.DONGGUK_LEGAL_MCP_API_KEY='fixture-oc-key';
    assert.equal(quota('https://law.example.org/mcp'),'own_key');
    assert.equal(quota('http://127.0.0.1:3858/mcp'),'own_key');
    delete process.env.DONGGUK_LEGAL_MCP_API_KEY;process.env.DONGGUK_LEGAL_MCP_BEARER_TOKEN='fixture-token';
    assert.equal(quota('https://law.example.org/mcp'),'own_key');
    assert.doesNotMatch(JSON.stringify(legalServerState()),/fixture|example\.org|3858/);
  }finally{
    for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k];
    Object.assign(process.env,saved);
  }
});
test('upper-law paging: laws past max_laws continue with law_offset instead of being dropped',()=>{
  const refs=Array.from({length:10},(_,i)=>({scope:'external_law',target:{lawName:`합성법${i+1}`},article:'제1조',citationText:'',sourceLocation:{article:'제1조'}}));
  const p1=planLaws(refs,{title:'합성규정',includeCandidates:false,maxLaws:4});
  assert.deepEqual(p1.laws.map(x=>x.lawName),['합성법1','합성법2','합성법3','합성법4']);
  assert.deepEqual(p1.page,{offset:0,returned:4,total:10,nextOffset:4});
  const p2=planLaws(refs,{title:'합성규정',includeCandidates:false,maxLaws:4,offset:8});
  assert.deepEqual(p2.laws.map(x=>x.lawName),['합성법9','합성법10']);
  assert.deepEqual(p2.page,{offset:8,returned:2,total:10,nextOffset:null});
  assert.equal(p2.omitted.length,0);
  assert.equal(planLaws(refs,{includeCandidates:false,maxLaws:4,offset:99}).laws.length,0);
});

test('a body line that opens with another article is body text, not a new header (사립학교법 제70조의4 실례)',async()=>{
  const client={calls:[],async callTool({name,arguments:a}){this.calls.push(name);
    if(name==='search_law') return listing('사립학교법');
    return text('법령명: 사립학교법\n공포일: 20240101\n시행일: 20240301\n\n제70조의4 사무직원의 당연퇴직\n제70조의2제1항에도 불구하고 같은 조에 따라 임명된 사무직원의 당연퇴직에 관하여는 「지방공무원법」 제61조제1호를 준용한다. <개정 2021.9.24>\n\n');}};
  const r=await queryLegalReferences([{law_name:'사립학교법',article:'제70조의4'}],{client,now:new Date('2026-11-26T03:00:00Z')});
  assert.equal(r.results[0].status,'retrieved');
  assert.match(r.results[0].articles[0].text,/지방공무원법/);
  const missing=await queryLegalReferences([{law_name:'사립학교법',article:'제70조의2'}],{client,now:new Date('2026-11-26T03:00:00Z')});
  assert.equal(missing.results[0].articles[0].code,'LEGAL_ARTICLE_MISSING');
});
(async()=>{let passed=0;for(const t of tests){try{await t.fn();passed++;console.log('PASS',t.name);}catch(e){console.error('FAIL',t.name);console.error(e);process.exitCode=1;}}
console.log(`Legal call cache regression: ${passed}/${tests.length} passed`);if(passed!==tests.length)process.exitCode=1;})();

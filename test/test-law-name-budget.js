'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDiskCache}=require('../src/cache');
const {inspectLaws,queryLegalReferences,createLegalCallBudget,resilientCaller}=require('../src/legal-client');
const {verifyLawNameMentions,LIMITS}=require('../src/law-name-mentions');
const {extractReferences,createResolver}=require('../src/references');
const extract=text=>extractReferences(text,createResolver([]),{includeUnnumberedLaws:true});
const missing={content:[{type:'text',text:'[NOT_FOUND] 검색 결과가 없습니다.'}]};
const current={content:[{type:'text',text:'1. 병역법 [현행]\n - 법령ID: 001622\n - MST: 290783\n - 공포일: 20260804 / 시행일: 20261002\n - 구분: 법률'}]};
const now=new Date('2026-11-28T00:00:00Z');
let checks=0;
function fixture(answer=()=>missing){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'law-name-budget-'));let clock=Date.now(),calls=0;
 const cached=createDiskCache({directory:()=>root,now:()=>clock});
 const client={callTool:async req=>{calls++;return answer(req,calls);}};
 return {root,cached,client,get calls(){return calls;},advance:ms=>{clock+=ms;},
  inspectLaws:(req,options)=>inspectLaws(req,{...options,client,now,sleep:async()=>{}})};
}
const longNames=Array.from({length:10},(_,i)=>({name:`테스트${i} 내용 확인용 가상 법률`,nameVerificationRequired:true,scope:'unresolved',target:{name:`가상${i}법`}}));
(async()=>{
 const f=fixture();let r=await verifyLawNameMentions(longNames,{configured:true,...f});
 assert.equal(f.calls,8);assert.equal(r.unverified.length,10);assert(r.unverified.some(x=>x.code==='LEGAL_CALL_LIMIT'));checks++;
 await verifyLawNameMentions(longNames,{configured:true,...f});assert.equal(f.calls,16);checks++;
 // A completed three-query NOT_FOUND uses only its separate 60-second cache.
 const n=fixture(),one=longNames.slice(0,1);
 await verifyLawNameMentions(one,{configured:true,...n});assert.equal(n.calls,3);
 await verifyLawNameMentions(one,{configured:true,...n});assert.equal(n.calls,3);
 assert.equal(fs.existsSync(path.join(n.root,'law-name-verification')),false);
 assert.equal(fs.readdirSync(path.join(n.root,'law-name-not-found')).length,1);checks++;
 n.advance(61000);await verifyLawNameMentions(one,{configured:true,...n});assert.equal(n.calls,6);checks++;
 // Same-name concurrent requests share the existing scoped disk-cache flight.
 const c=fixture(async()=>{await new Promise(r=>setTimeout(r,5));return missing;});
 const parallel=await Promise.all(Array.from({length:12},()=>verifyLawNameMentions(one,{configured:true,...c})));
 assert.equal(c.calls,3);assert(parallel.every(x=>x.unverified.length===1));checks++;
 const good=fixture(async()=>{await new Promise(r=>setTimeout(r,5));return current;});
 const m=extract('병역법에 의한 복무');
 await Promise.all(Array.from({length:12},()=>verifyLawNameMentions(m,{configured:true,...good})));
 await verifyLawNameMentions(m,{configured:true,...good});assert.equal(good.calls,1);checks++;
 // All transient/invalid responses bypass the negative cache; recovery is immediate.
 for(const [i,bad] of [()=>{throw Error('offline');},()=>({isError:true,content:[{type:'text',text:'maintenance'}]}),()=>({content:[]}),()=>current].entries()){
  let recover=false;const t=fixture(req=>recover?current:bad(req));
  const unknown=extract('병역법에 의한 복무');
  // For a valid similar-name listing, use another name so exact identity fails.
  const input=i===3?extract('가짜병역법에 의한 복무'):unknown;
  await verifyLawNameMentions(input,{configured:true,...t});const before=t.calls;
  assert.equal(fs.existsSync(path.join(t.root,'law-name-not-found')),false);
  recover=true;await verifyLawNameMentions(input,{configured:true,...t});assert(t.calls>before);checks++;
 }
 const hanging=fixture(()=>new Promise(()=>{}));
 const fast={...hanging,inspectLaws:(req,options)=>hanging.inspectLaws(req,{...options,timeoutMs:10,totalTimeoutMs:1000})};
 for(let i=0;i<2;i++)await verifyLawNameMentions(m,{configured:true,...fast});
 assert.equal(hanging.calls,2);assert.equal(fs.existsSync(path.join(hanging.root,'law-name-not-found')),false);checks++;
 // A query limit must not poison a later request with a NOT_FOUND cache entry.
 const limited=fixture();
 await verifyLawNameMentions(one,{configured:true,...limited,callBudget:createLegalCallBudget(1)});
 assert.equal(limited.calls,1);assert.equal(fs.existsSync(path.join(limited.root,'law-name-not-found')),false);
 await verifyLawNameMentions(one,{configured:true,...limited});assert.equal(limited.calls,4);checks++;
 const rate=fixture(()=>({isError:true,content:[{type:'text',text:'429 Too many requests; retry-after: 0'}]}));
 await verifyLawNameMentions(longNames,{configured:true,...rate});assert.equal(rate.calls,8);checks++;
 // Spaced prose and a single fabricated word must not share positive keys.
 const boundary=fixture(()=>current);
 const spaced=[{name:'가짜 병역법',nameVerificationRequired:true,scope:'unresolved',target:{name:'가짜 병역법'}}];
 assert.equal((await verifyLawNameMentions(spaced,{configured:true,...boundary})).unverified.length,0);
 assert.equal((await verifyLawNameMentions(extract('가짜병역법에 의한 복무'),{configured:true,...boundary})).unverified.length,1);checks++;
 // Parent total includes every child and subsequent body/identity lookup.
 const shared=fixture(),budget=createLegalCallBudget(9);
 await verifyLawNameMentions(longNames,{configured:true,...shared,callBudget:budget});
 assert.equal(budget.used,8);
 await queryLegalReferences([{law_name:'미발견법',article:'제1조'}],{client:shared.client,now,callBudget:budget});
 const capped=await shared.inspectLaws([{name:'미발견법',articles:[]}],{callBudget:budget});
 assert.equal(shared.calls,9);assert.equal(budget.used,9);assert.equal(capped.laws[0].identity.code,'LEGAL_CALL_LIMIT');checks++;
 // A cached positive provider response costs no budget; a cold query is denied.
 const hit=fixture(()=>current);const caller=resilientCaller(()=>{throw Error('unexpected live call');},{cache:hit.cached,callBudget:createLegalCallBudget(0)});
 await resilientCaller(()=>current,{cache:hit.cached})('search_law',{query:'병역법',display:100});
 assert.deepEqual((await caller('search_law',{query:'병역법',display:100})).content,current.content);
 await assert.rejects(()=>caller('search_law',{query:'다른법',display:100}),{code:'LEGAL_CALL_LIMIT'});checks++;
 // Distinct public/private cache roots do not share pending requests or misses.
 const isolated=fixture();await verifyLawNameMentions(one,{configured:true,...isolated});assert.equal(isolated.calls,3);checks++;
 const nouns=['방법','평가방법','기법','문법','맞춤법','한글맞춤법','수행법','불교수행법','교수법','학습법','공부법','표기법','독서법','계산법','호흡법','명상법','조리법','사용법','운용법','분석법','측정법'];
 for(const noun of nouns)for(const ending of ['에 따라 작성한다','과 비교한다','을 준용한다']){assert.deepEqual(extract(noun+ending),[],noun+ending);checks++;}
 assert.deepEqual(extract('한글 맞춤법에 따라 가로로 쓴다.'),[]);assert.deepEqual(extract('비교명상 연구(불교 이외 수행법과 비교)'),[]);checks++;
 for(const name of ['병역법','교육법','사학법','세법','노동관계법','가짜병역법']){assert(extract(name+'에 따라 처리한다').some(x=>x.nameVerificationRequired),name);checks++;}
 // Quoted/numbered citations remain on the original extraction path.
 for(const text of ['「수행법」 제3조','맞춤법 제3조'])assert.deepEqual(extractReferences(text,createResolver([])),extract(text));checks++;
 // Real MCP handlers share the 32-call parent across name and body phases.
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'law-budget-mcp-'));
 Object.assign(process.env,{XDG_CACHE_HOME:root,DONGGUK_RULE_COOKIE:'',DONGGUK_LEGAL_MCP_URL:'http://127.0.0.1:9/mcp',DONGGUK_LEGAL_MCP_ENABLED:'1',DONGGUK_PUBLIC_LAW_LINK:'1',DONGGUK_MCP_NO_CACHE:'0'});
 const fetchPath=require.resolve('node-fetch');require(fetchPath);require.cache[fetchPath].exports=async()=>{throw Error('NETWORK_FORBIDDEN')};
 const pub=path.join(root,'dongguk-rule-mcp/v2/public');
 const seed=(cat,key,value)=>{fs.mkdirSync(path.join(pub,cat),{recursive:true});fs.writeFileSync(path.join(pub,cat,key+'.json'),JSON.stringify(value));};
 const records=[{lawId:990,historyId:1,title:'문서검수규정',revisedAt:'2026.11.28'},{lawId:991,historyId:1,title:'명상검수규정',revisedAt:'2026.11.28'},{lawId:992,historyId:1,title:'호출검수규정',revisedAt:'2026.11.28'}];
 seed('catalog','all',records);
 const crowded=Array.from({length:10},(_,i)=>`확인${i}법에 따라 처리한다.`).join(' ')+' '+Array.from({length:12},(_,i)=>`「검수${i}법」 제1조에 따른다.`).join(' ');
 for(const [i,r] of records.entries()){seed('history',r.lawId,[{historyId:1,revisedAt:r.revisedAt}]);seed('content-v4',r.lawId+'_1',{title:r.title,markdown:'### 제1조(검수)\n'+['한글 맞춤법에 따라 가로로 쓴다.','비교명상 연구(불교 이외 수행법과 비교)',crowded][i]});}
 const legal=require('../src/legal-client');let upstream=0;
 const provider={callTool:async()=>{upstream++;return {isError:true,content:[{type:'text',text:'429 Too many requests; retry-after: 0'}]};}};
 for(const name of ['inspectLaws','queryLegalReferences']){const original=legal[name];legal[name]=(req,options)=>original(req,{...options,now,client:provider,sleep:async()=>{}});}
 const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
 const server=require('../src/index').createServer({profile:'rules'}),mcp=new Client({name:'law-budget-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await mcp.connect(b);
 for(const tool of ['get_rule_references','get_rule_upper_laws']){
  const args={article:1,...(tool==='get_rule_references'?{include_law_text:true}:{include_text:true,include_candidates:false,max_laws:12})};
  for(const law_id of [990,991]){const before=upstream;const d=(await mcp.callTool({name:tool,arguments:{...args,law_id}})).structuredContent.data;assert.equal(d.evidenceStatus,'retrieved');assert(!d.unverifiedLawMentions);assert.equal(upstream,before);checks++;}
  const before=upstream;const d=(await mcp.callTool({name:tool,arguments:{...args,law_id:992}})).structuredContent.data;
  assert.equal(upstream-before,32);assert.equal(d.legalCallBudget.upstreamCalls,32);assert.equal(d.evidenceStatus,'partial');assert(d.unverifiedLawMentions.some(x=>x.code==='LEGAL_CALL_LIMIT'));checks++;
 }
 await mcp.close();await server.close();await legal.closeLegalClient();
 console.log(`Law name budget: ${checks} cases passed`);
})().catch(error=>{console.error(error);process.exitCode=1});

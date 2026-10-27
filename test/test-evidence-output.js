'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
const {formatLegalEvidence}=require('../src/legal-format.js');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dongguk-evidence-output-'));
process.env.XDG_CACHE_HOME=temp;process.env.DONGGUK_RULE_COOKIE='';process.env.DONGGUK_MCP_NO_CACHE='0';
const pack={version:'synthetic',workflows:[{id:'test',title:'합성 공동 조회',keywords:['합성'],required_facts:[{key:'base_date',label:'기준일'},{key:'campus',label:'캠퍼스'}],steps:[],completion_evidence:[],source_notes:[],checks:[],rule_requests:[{keyword:'합성규정',terms:'합성'}],legal_requests:[{law_name:'합성법',article:'제1조'}]}],cards:[]};
const packPath=path.join(temp,'pack.json');fs.writeFileSync(packPath,JSON.stringify(pack));process.env.DONGGUK_FINANCE_PACK_PATH=packPath;
let calls=0,fail=false;const legalClient=require('../src/legal-client.js');
legalClient.queryLegalReferences=async requests=>{calls++;if(fail)throw Error('private diagnostic must not be printed');return {status:'retrieved',baseDate:'2026-01-02',results:requests.map(request=>({request,status:'retrieved',articles:[{selector:'제1조',status:'retrieved',dateStatus:'historical_version_retrieved',bodyRetrieved:true,text:'합성 법령 원문',source:{lawId:'123',mst:'456',effectiveAt:'20260101',baseDate:'2026-01-02',retrievedAt:'2026-10-27T00:00:00Z',url:'https://example.com/law'}}],annexes:[]}))};};
let network=0;const fetchPath=require.resolve('node-fetch');require(fetchPath);require.cache[fetchPath].exports=async()=>{network++;throw Error('Network must not run');};
const {createServer}=require('../src/index.js');
const seed=(type,key,value)=>{const dir=path.join(temp,'dongguk-rule-mcp/v2/public',type);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,key+'.json'),JSON.stringify(value));};
const hit={lawId:1,historyId:10,title:'합성규정',revisedAt:'2026.01.01'};
for(const q of ['합성규정','합성'])seed('search',crypto.createHash('md5').update([q,false,1,10,'0'].join('|')).digest('hex'),{total:1,hits:[hit]});
seed('history','1',[{historyId:10,revisedAt:'2026.01.01'}]);seed('original-structure-v1','1_10',{markdown:'제1조(목적) 합성 교내 규정 원문'});
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{const server=createServer({profile:'finance'}),client=new Client({name:'evidence-output',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();try{
 await server.connect(b);await client.connect(a);
 const args={query:'합성',facts:{base_date:'2026-01-02',campus:'서울'}};
 await check('both law and university rule bodies visible through real MCP',async()=>{
  const r=await client.callTool({name:'get_finance_evidence',arguments:args});const t=r.content.map(x=>x.text||'').join('\n');
  assert.equal(r.structuredContent.ok,true);assert.equal(r.structuredContent.data.evidence_status,'retrieved');
  for(const expected of ['교내 규정 근거','합성 교내 규정 원문','법령 근거','합성 법령 원문','123 / 456','20260101','2026-01-02','https://example.com/law'])assert(t.includes(expected),expected);
 });
 await check('legal failure keeps university body and visible partial failure',async()=>{
  fail=true;const r=await client.callTool({name:'get_finance_evidence',arguments:args});const t=r.content.map(x=>x.text||'').join('\n');
  assert.equal(r.structuredContent.data.evidence_status,'partial');assert(t.includes('합성 교내 규정 원문'));assert(t.includes('LEGAL_LOOKUP_FAILED'));assert(!t.includes('private diagnostic'));
 });
 await check('missing date prevents both source calls',async()=>{
  const before=calls;const r=await client.callTool({name:'get_finance_evidence',arguments:{query:'합성',facts:{campus:'서울'}}});assert.equal(r.structuredContent.data.evidence_status,'needs_input');assert.equal(calls,before);
 });
 await check('unrequested laws do not create an unavailable warning',()=>assert.equal(formatLegalEvidence({status:'not_requested'}),''));
 await check('partial annex preserves reference-only and source limits',()=>{
  const t=formatLegalEvidence({status:'partial',results:[{request:{law_name:'합성법'},status:'partial',annexes:[{selector:'별표 1',status:'partial',referenceOnly:true,truncated:true,dateStatus:'historical_unverified',text:'합성 별표'}]}]});
  for(const expected of ['참고용','잘림','historical_unverified','미확인','합성 별표'])assert(t.includes(expected));
 });
 assert.equal(network,0);console.log(`Evidence output regression: ${passed} passed`);
 }finally{await client.close();await server.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});

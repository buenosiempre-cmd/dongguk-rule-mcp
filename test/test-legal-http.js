'use strict';
const assert=require('node:assert/strict');
const {Server}=require('@modelcontextprotocol/sdk/server/index.js');
const {ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');
const {createHttpServer}=require('../src/http-server.js');
const {queryLegalReferences,closeLegalClient}=require('../src/legal-client.js');
const LAW='소득세법',TODAY='2026-10-27';
const TOKEN='synthetic-law-http-token';
const keys=['DONGGUK_LEGAL_MCP_ENABLED','DONGGUK_LEGAL_MCP_TRANSPORT','DONGGUK_LEGAL_MCP_URL','DONGGUK_LEGAL_MCP_BEARER_TOKEN','DONGGUK_LEGAL_MCP_ARGS','LAW_OC'];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const text=value=>({content:[{type:'text',text:value}]});
const calls=[];
function factory(){
  const server=new Server({name:'korean-law-http-fixture',version:'test'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['search_law','get_law_text'].map(name=>({name,inputSchema:{type:'object'}}))}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const {name,arguments:a}=request.params;calls.push({name,args:a});
    if(name==='search_law')return text(`1. ${LAW} [현행]\n   - 법령ID: 001565\n   - MST: 12345\n   - 공포일: 20250101 / 시행일: 20250101\n`);
    if(name==='get_law_text')return text(`법령명: ${LAW}\n공포일: 20250101\n시행일: 20250101\n\n${a.jo}(원천징수)\n① 지급자는 원천징수 사항을 확인한다.\n`);
    throw new Error('unexpected fixture request');
  });return server;
}
let server,passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const query=()=>queryLegalReferences([{law_name:LAW,article:'제127조'}],{baseDate:TODAY,now:new Date(TODAY+'T03:00:00Z'),timeoutMs:1000,totalTimeoutMs:2000});
async function main(){
  server=createHttpServer({createServer:factory,version:'test',token:TOKEN});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  Object.assign(process.env,{DONGGUK_LEGAL_MCP_ENABLED:'1',DONGGUK_LEGAL_MCP_TRANSPORT:'streamable-http',DONGGUK_LEGAL_MCP_URL:url,DONGGUK_LEGAL_MCP_BEARER_TOKEN:TOKEN});
  delete process.env.LAW_OC;
  await check('real HTTP SDK bridge initializes and retrieves an article without LAW_OC',async()=>{
    const result=await query();assert.equal(result.status,'retrieved');assert.equal(result.results[0].articles[0].source.mst,'12345');
    assert.deepEqual(calls.map(c=>c.name),['search_law','get_law_text']);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
  await check('connection can be closed and re-established',async()=>{
    await closeLegalClient();assert.equal((await query()).status,'retrieved');
  });
  await check('changed auth settings cannot reuse a previously authorized connection',async()=>{
    process.env.DONGGUK_LEGAL_MCP_BEARER_TOKEN='synthetic-wrong-token';
    const result=await query();assert.equal(result.code,'LEGAL_CONNECTION_FAILED');
    assert.ok(!JSON.stringify(result).includes('synthetic-wrong-token'));
    process.env.DONGGUK_LEGAL_MCP_BEARER_TOKEN=TOKEN;
    assert.equal((await query()).status,'retrieved');
  });
  await check('non-TLS remote URLs, URL credentials, query and fragment are rejected',async()=>{
    for(const bad of ['http://remote.example/mcp','file:///tmp/mcp','https://user:password@example.test/mcp',url+'?token=private',url+'#fragment']){
      process.env.DONGGUK_LEGAL_MCP_URL=bad;
      const count=calls.length,result=await query();assert.equal(result.code,'LEGAL_MCP_NOT_CONFIGURED');assert.equal(calls.length,count);
      assert.ok(!JSON.stringify(result).includes('private'));
    }
    process.env.DONGGUK_LEGAL_MCP_URL=url;
  });
  await check('disabled, missing URL, unsupported transport and malformed header fail closed',async()=>{
    for(const [key,value] of [['DONGGUK_LEGAL_MCP_ENABLED','0'],['DONGGUK_LEGAL_MCP_URL',''],['DONGGUK_LEGAL_MCP_TRANSPORT','sse'],['DONGGUK_LEGAL_MCP_BEARER_TOKEN','bad\r\nheader']]){
      const before=process.env[key];process.env[key]=value;assert.equal((await query()).code,'LEGAL_MCP_NOT_CONFIGURED');process.env[key]=before;
    }
  });
  await check('stdio still requires its own LAW_OC configuration',async()=>{
    process.env.DONGGUK_LEGAL_MCP_TRANSPORT='stdio';delete process.env.LAW_OC;
    assert.equal((await query()).code,'LEGAL_MCP_NOT_CONFIGURED');
  });
  console.log(`Legal HTTP bridge regression: ${passed} passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  await closeLegalClient();if(server)await server.shutdown();
  for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
});

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
const {rankingMethod}=require('../src/fusion'),{labelsEnabled}=require('../src/aliases');
const {createServer}=require('../src/index'),{doctor}=require('../src/cli');
const version=require('../package.json').version;
process.env.XDG_CACHE_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'default-tools-'));
process.env.DONGGUK_RULE_COOKIE='';process.env.DONGGUK_FINANCE_PACK_PATH=path.join(process.env.XDG_CACHE_HOME,'not-configured.json');
process.env.DONGGUK_LEGAL_MCP_ENABLED='0';
let count=0;
(async()=>{
 for(const value of [undefined,'','nonsense','hybrid','legacy']){
  if(value===undefined)delete process.env.DONGGUK_MCP_RANKING;else process.env.DONGGUK_MCP_RANKING=value;
  assert.equal(rankingMethod(),value==='legacy'?'legacy':'hybrid');count++;
 }
 for(const value of [undefined,'','1','true','on','yes','0','false','off','no','nonsense']){
  if(value===undefined)delete process.env.DONGGUK_MCP_LABELS;else process.env.DONGGUK_MCP_LABELS=value;
  assert.equal(labelsEnabled(),!['0','false','off','no'].includes(value));count++;
 }
 delete process.env.DONGGUK_MCP_RANKING;delete process.env.DONGGUK_MCP_LABELS;
 for(const profile of ['rules','finance'])for(const value of [undefined,'','0','false','oops','1',' ON ','true','yes']){
  if(value===undefined)delete process.env.DONGGUK_FINANCE_CONTEXT_ENABLED;else process.env.DONGGUK_FINANCE_CONTEXT_ENABLED=value;
  const enabled=profile==='finance'&&['1',' ON ','true','yes'].includes(value);
  const server=createServer({profile}),client=new Client({name:'default-tools',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try{
   const tools=(await client.listTools()).tools,info=(await client.callTool({name:'get_service_info',arguments:{}})).structuredContent.data;
   assert.equal(tools.length,profile==='rules'?15:enabled?19:17);assert.equal(info.toolCount,tools.length);assert.equal(info.integrations.financeContext.enabled,enabled);assert.equal(info.integrations.financeContext.defaultEnabled,false);
   assert.equal(info.searchDefaults.ranking,'hybrid');assert.equal(info.searchDefaults.labels,true);count++;
   for(const name of ['get_finance_context','get_finance_evidence']){
    assert.equal(tools.some(t=>t.name===name),enabled);
    const response=(await client.callTool({name,arguments:{query:'출장'}})).structuredContent;
    if(!enabled)assert.equal(response.error.code,'TOOL_NOT_AVAILABLE');else assert.notEqual(response.error?.code,'TOOL_NOT_AVAILABLE');count++;
   }
   for(const name of ['search_finance_handbook','review_finance_case']){
    assert.equal(tools.some(t=>t.name===name),profile==='finance');
    const response=(await client.callTool({name,arguments:{query:'출장'}})).structuredContent;
    if(profile==='finance')assert.notEqual(response.error?.code,'TOOL_NOT_AVAILABLE');else assert.equal(response.error.code,'TOOL_NOT_AVAILABLE');count++;
   }
  }finally{await client.close();await server.close();}
 }
 for(const opt of ['0','1']){process.env.DONGGUK_FINANCE_CONTEXT_ENABLED=opt;const result=await doctor({createServer,version,profile:'finance'});assert.equal(result.ok,true);assert.equal(result.checks.find(c=>c.name==='tools').count,opt==='1'?19:17);count++;}
 console.log(`Default tools: ${count} cases passed`);
})().catch(e=>{console.error(e);process.exitCode=1});

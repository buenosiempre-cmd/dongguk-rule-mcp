'use strict';
// Public upstream integration checks, serial and bounded; this is not a load test
// or a judgment of the selected regulation's applicability to an actual person.
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const version=require('../package.json').version;
const cases=[['학사','학칙'],['교원 인사','교원인사'],['직원 근무','취업규칙'],['출장','여비규정'],['회계','재정시행세칙'],['결재 권한','위임전결규정'],['연구','연구비'],['학생 지원','장학']];
const client=new Client({name:'dongguk-cop-public-smoke',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'../src/index.js'),'--profile','rules'],env:{...process.env,DONGGUK_MCP_NO_CACHE:'1',DONGGUK_RULE_COOKIE:'',DONGGUK_FINANCE_PACK_PATH:'',DONGGUK_LEGAL_MCP_ENABLED:'0'},stderr:'pipe'});
const results=[];
async function call(name,args){const response=await client.callTool({name,arguments:args},undefined,{timeout:120000});assert.equal(response.structuredContent?.ok,true,`${name}: ${response.structuredContent?.error?.code||'invalid response'}`);return response.structuredContent.data;}
async function main(){
  await client.connect(transport);transport.stderr?.resume();
  assert.equal(client.getServerVersion()?.version,version);
  const info=await call('get_service_info',{});assert.equal(info.profile,'rules');
  for(const [area,keyword] of cases){
    const started=Date.now();
    try{
      const search=await call('search_rule',{keyword,limit:10});
      const selected=search.rules.find(x=>x.title.replace(/\s/g,'')===keyword)||search.rules[0];
      assert.ok(selected?.lawId,'public candidate found');
      const lookup=await call('lookup_dongguk_rule',{law_id:selected.lawId,include_history:true,max_chars:1000});
      const rule=lookup.rules[0],history=(await call('list_rule_history',{law_id:selected.lawId})).history;
      assert.equal(rule.lawId,selected.lawId);assert.equal(rule.historyId,history[0].historyId);assert.equal(rule.revisedAt,history[0].revisedAt);assert.ok(rule.excerpt.text.trim());
      const content=await call('get_rule_content',{law_id:rule.lawId,history_id:rule.historyId});assert.ok(content.contentMarkdown.trim());
      const row={area,keyword,ok:true,title:rule.title,lawId:rule.lawId,historyId:rule.historyId,revisedAt:rule.revisedAt,sourceType:rule.sourceType,warning:rule.warning?.code||null,sourceUrl:rule.sourceUrl,elapsedMs:Date.now()-started};
      results.push(row);console.log(JSON.stringify(row));
    }catch(error){results.push({area,keyword,ok:false,error:error.message,elapsedMs:Date.now()-started});console.error(`FAIL ${area}: ${error.message}`);}
  }
  const summary={version,checkedAt:new Date().toISOString(),cache:'disabled',cookie:'none',passed:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,notice:'Each first/exact search candidate was explicitly retrieved by LAW_ID for source integration testing. This does not select an applicable regulation for real work.',results};
  const outputIndex=process.argv.indexOf('--out');if(outputIndex>=0){assert.ok(process.argv[outputIndex+1]);fs.writeFileSync(process.argv[outputIndex+1],JSON.stringify(summary,null,2)+'\n');}
  console.log(JSON.stringify({version,passed:summary.passed,failed:summary.failed}));
  if(summary.failed)process.exitCode=1;
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await client.close();await transport.close();});

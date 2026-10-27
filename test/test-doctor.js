'use strict';

// Use actual SDK transports so the diagnostic cannot mistake a successful
// JSON-RPC envelope for successful source evidence.
const assert=require('node:assert/strict');
const {Server}=require('@modelcontextprotocol/sdk/server/index.js');
const {ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');
const {doctor}=require('../src/cli.js');
const version=require('../package.json').version;
let passed=0;
const validRule=()=>({lawId:491,historyId:3000,sourceType:'원문 HWP(별표 포함)',evidenceStatus:'retrieved',incompleteReasons:[],warning:null,excerpt:{text:'제1조(목적) 여비 지급에 관한 사항을 정한다.'}});
const success=rule=>({content:[{type:'text',text:'lookup fixture'}],structuredContent:{ok:true,data:{rules:[rule]}}});
function factory(response,{profileFailure=false,calls=[]}={}) {
  return ({profile})=>{
    const server=new Server({name:'doctor-fixture',version},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Array.from({length:profile==='rules'?10:14},(_,i)=>({name:'fixture_'+i,inputSchema:{type:'object'}}))}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{
      calls.push(request.params.name);
      if(request.params.name==='get_service_info')return {content:[],structuredContent:{ok:!profileFailure,data:{profile}}};
      assert.equal(request.params.name,'lookup_dongguk_rule');
      assert.deepEqual(request.params.arguments,{rule_keyword:'여비규정',max_chars:1000});
      if(response instanceof Error)throw response;
      return response;
    });
    return server;
  };
}
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
async function run(response,options={}){return doctor({createServer:factory(response,options),version,live:true});}
async function main(){
  await check('offline diagnosis never claims an upstream check',async()=>{
    const calls=[];
    const report=await doctor({createServer:factory(null,{calls}),version});
    assert.equal(report.ok,true);assert.equal(report.upstreamChecked,false);
    assert.deepEqual(calls,['get_service_info']);
  });
  await check('normal HWP sample includes source identity and evidence status',async()=>{
    const report=await run(success(validRule()));
    assert.equal(report.ok,true);assert.equal(report.upstreamChecked,true);
    assert.equal(report.checks.at(-1).lawId,491);assert.equal(report.checks.at(-1).historyId,3000);
    assert.equal(report.checks.at(-1).evidenceStatus,'retrieved');
  });
  await check('intentional sample truncation is disclosed without failing source connectivity',async()=>{
    const rule={...validRule(),evidenceStatus:'partial',incompleteReasons:['EXCERPT_TRUNCATED']};
    const report=await run(success(rule));
    assert.equal(report.ok,true);assert.deepEqual(report.checks.at(-1).incompleteReasons,['EXCERPT_TRUNCATED']);
  });
  await check('block-only and combined block/character sample limits remain successful',async()=>{
    for(const reasons of [['EXCERPT_BLOCK_LIMIT'],['EXCERPT_TRUNCATED','EXCERPT_BLOCK_LIMIT']]){
      const report=await run(success({...validRule(),evidenceStatus:'partial',incompleteReasons:reasons}));
      assert.equal(report.ok,true);assert.deepEqual(report.checks.at(-1).incompleteReasons,reasons);
    }
  });
  await check('HTML fallback is not an all-green original-document diagnosis',async()=>{
    const rule={...validRule(),sourceType:'HTML 본문',evidenceStatus:'partial',warning:{code:'HWP_FALLBACK',message:'PRIVATE_UPSTREAM_DIAGNOSTIC'},incompleteReasons:['HWP_FALLBACK']};
    const report=await run(success(rule));
    assert.equal(report.ok,false);assert.equal(report.checks.at(-1).warning,'HWP_FALLBACK');
    assert.equal(report.checks.at(-1).error,'ORIGINAL_SOURCE_UNAVAILABLE');
    assert.ok(!JSON.stringify(report).includes('PRIVATE_UPSTREAM_DIAGNOSTIC'));
  });
  await check('empty excerpt and missing rule IDs fail even when tool ok is true',async()=>{
    for(const rule of [{...validRule(),excerpt:{text:'  '}},{...validRule(),lawId:null},{...validRule(),historyId:0},{}]){
      assert.equal((await run(success(rule))).ok,false);
    }
  });
  await check('unconfirmed identity and other partial reasons require inspection',async()=>{
    const report=await run(success({...validRule(),evidenceStatus:'partial',incompleteReasons:['RULE_IDENTITY_UNCONFIRMED']}));
    assert.equal(report.ok,false);assert.equal(report.checks.at(-1).error,'PARTIAL_EVIDENCE');
    assert.equal((await run(success({...validRule(),evidenceStatus:'partial',incompleteReasons:[]}))).ok,false);
  });
  await check('tool failures preserve an error code without raw source diagnostics',async()=>{
    const report=await run({content:[{type:'text',text:'PRIVATE_FAILURE_DETAIL'}],structuredContent:{ok:false,error:{code:'UPSTREAM_UNAVAILABLE',message:'PRIVATE_FAILURE_DETAIL'}}});
    assert.equal(report.ok,false);assert.equal(report.checks.at(-1).error,'UPSTREAM_UNAVAILABLE');
    assert.ok(!JSON.stringify(report).includes('PRIVATE_FAILURE_DETAIL'));
  });
  await check('RPC lookup failure is labeled as lookup failure, not startup failure',async()=>{
    const report=await run(new Error('PRIVATE_RPC_DIAGNOSTIC'));
    assert.equal(report.ok,false);assert.equal(report.checks.at(-1).name,'public_rule_lookup');
    assert.equal(report.checks.at(-1).error,'PUBLIC_RULE_LOOKUP_FAILED');
    assert.ok(!JSON.stringify(report).includes('PRIVATE_RPC_DIAGNOSTIC'));
  });
  await check('profile diagnostic honors a structured failure despite matching profile',async()=>{
    const report=await run(success(validRule()),{profileFailure:true});
    assert.equal(report.ok,false);assert.equal(report.checks.find(x=>x.name==='profile').ok,false);
  });
  console.log(`Doctor regression: ${passed} passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});

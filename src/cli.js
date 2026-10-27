'use strict';
const path=require('node:path');
const {normalizeProfile}=require('./runtime-context.js');
function printConfig(client,profile='rules') {
  normalizeProfile(profile);
  const command=process.execPath,args=[path.join(__dirname,'index.js'),'--profile',profile];
  if(client==='codex') return `[mcp_servers.dongguk-rule]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
  if(['claude','cursor'].includes(client)) return JSON.stringify({mcpServers:{'dongguk-rule':{command,args}}},null,2)+'\n';
  throw new Error('--print-config에는 codex, claude, cursor 중 하나를 지정하세요.');
}
async function doctor({createServer,version,profile='rules',live=false}) {
  const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
  const [a,b]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'dongguk-doctor',version:'1'}),server=createServer({profile});
  const checks=[];
  let upstreamChecked=false,phase='startup';
  try {
    await server.connect(b);await client.connect(a);
    checks.push({name:'initialize',ok:client.getServerVersion()?.version===version});
    const tools=(await client.listTools()).tools;
    checks.push({name:'tools',ok:tools.length===(profile==='rules'?10:14),count:tools.length});
    const info=await client.callTool({name:'get_service_info',arguments:{}});
    checks.push({name:'profile',ok:info.isError!==true&&info.structuredContent?.ok===true&&info.structuredContent?.data?.profile===profile});
    if(live){
      phase='public_rule_lookup';upstreamChecked=true;
      const response=await client.callTool({name:'lookup_dongguk_rule',arguments:{rule_keyword:'여비규정',max_chars:1000}},undefined,{timeout:60000});
      const result=response.structuredContent,rule=result?.data?.rules?.[0];
      const hasExcerpt=typeof rule?.excerpt?.text==='string'&&rule.excerpt.text.trim().length>0;
      const hasIdentity=Number.isSafeInteger(rule?.lawId)&&rule.lawId>0&&Number.isSafeInteger(rule?.historyId)&&rule.historyId>0;
      const reasons=Array.isArray(rule?.incompleteReasons)?rule.incompleteReasons:[];
      // The live probe intentionally samples 1,000 characters and the default
      // section count. These limits are expected, but a fallback, empty body, or
      // unconfirmed selection is not successful original-document evidence.
      const sourceReady=rule?.sourceType==='원문 HWP(별표 포함)'&&!rule?.warning?.code;
      const samplingOnly=reasons.every(code=>['EXCERPT_TRUNCATED','EXCERPT_BLOCK_LIMIT'].includes(code));
      const evidenceReady=rule?.evidenceStatus==='retrieved'||(rule?.evidenceStatus==='partial'&&reasons.length>0&&samplingOnly);
      const ok=response.isError!==true&&result?.ok===true&&hasIdentity&&hasExcerpt&&sourceReady&&evidenceReady&&samplingOnly;
      checks.push({name:'public_rule_lookup',ok,warning:rule?.warning?.code||null,
        lawId:hasIdentity?rule.lawId:null,historyId:hasIdentity?rule.historyId:null,
        sourceType:rule?.sourceType||null,evidenceStatus:rule?.evidenceStatus||null,incompleteReasons:reasons,
        ...(!ok?{error:result?.error?.code||(!hasIdentity?'RULE_IDENTITY_UNCONFIRMED':!hasExcerpt?'NO_MATCHING_EXCERPT':!sourceReady?'ORIGINAL_SOURCE_UNAVAILABLE':'PARTIAL_EVIDENCE')}:{}),
      });
    }
  }catch(e){checks.push({name:phase,ok:false,error:phase==='public_rule_lookup'?'PUBLIC_RULE_LOOKUP_FAILED':'STARTUP_FAILED'});}
  finally{await client.close();await server.close();}
  return {ok:checks.every(x=>x.ok),version,node:process.version,profile,checks,upstreamChecked,
    notice:live?'대표 공개 규정의 HWP 원문 발췌 검사입니다. 1,000자 및 기본 발췌 구간 수에 따른 표본 잘림은 허용하지만 HTML 대체·빈 발췌·규정 선택 미확인은 점검 필요로 표시합니다. 전체 규정·표 해석·업무 적용 검증은 아닙니다.':'오프라인 설치 검사입니다. 원문 연결은 --live로 검사하세요.'};
}
module.exports={printConfig,doctor};

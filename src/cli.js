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
  try {
    await server.connect(b);await client.connect(a);
    checks.push({name:'initialize',ok:client.getServerVersion()?.version===version});
    const tools=(await client.listTools()).tools;
    checks.push({name:'tools',ok:tools.length===(profile==='rules'?10:14),count:tools.length});
    const info=await client.callTool({name:'get_service_info',arguments:{}});
    checks.push({name:'profile',ok:info.structuredContent?.data?.profile===profile});
    if(live){const response=await client.callTool({name:'lookup_dongguk_rule',arguments:{rule_keyword:'여비규정',max_chars:1000}},undefined,{timeout:60000});checks.push({name:'public_rule_lookup',ok:response.structuredContent?.ok===true,warning:response.structuredContent?.data?.rules?.[0]?.warning?.code||null});}
  }catch(e){checks.push({name:'startup',ok:false,error:e.code||'STARTUP_FAILED'});}
  finally{await client.close();await server.close();}
  return {ok:checks.every(x=>x.ok),version,node:process.version,profile,checks,upstreamChecked:live,notice:live?'대표 공개 규정 연결 검사입니다.':'오프라인 설치 검사입니다. 원문 연결은 --live로 검사하세요.'};
}
module.exports={printConfig,doctor};

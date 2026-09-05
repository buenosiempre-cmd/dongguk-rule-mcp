'use strict';
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
let connection;
async function legalClient(){
  if(process.env.DONGGUK_LEGAL_MCP_ENABLED!=='1' || !process.env.LAW_OC) throw new Error('LEGAL_MCP_NOT_CONFIGURED');
  if(!connection){
    connection=(async()=>{
      const client=new Client({name:'dongguk-finance-desk',version:'0.8.0'});
      const transport=new StdioClientTransport({command:process.env.DONGGUK_LEGAL_MCP_COMMAND||'npx',args:JSON.parse(process.env.DONGGUK_LEGAL_MCP_ARGS||'["--offline","korean-law-mcp"]'),env:{PATH:process.env.PATH,HOME:process.env.HOME,LAW_OC:process.env.LAW_OC},stderr:'pipe'});
      client.onclose=()=>{connection=null;};
      await client.connect(transport);
      transport.stderr?.resume();
      return client;
    })().catch(e=>{connection=null;throw e;});
  }
  return connection;
}
const textOf=response=>(response.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
const normalize=name=>name.replace(/[\sㆍ·]/g,'');
function exactCurrentLaw(response,name){
  const text=textOf(response);
  // Only numbered current-law entries, never a future-law hint or a partial name.
  for(const m of text.matchAll(/^\d+\. (.+?) \[현행\]\r?\n\s*- 법령ID: (\d+)\r?\n\s*- MST: (\d+)\r?\n\s*- 공포일: (\d+) \/ 시행일: (\d+)/gm)){
    if(normalize(m[1])===normalize(name)) return {name:m[1],lawId:m[2],mst:m[3],promulgatedAt:m[4],effectiveAt:m[5],sourceUrl:`https://www.law.go.kr/법령/${encodeURIComponent(m[1])}`};
  }
  return null;
}
async function queryLegalReferences(requests){
  const client=await legalClient();
  const results=[];
  for(const request of requests.slice(0,2)){
    try{
      const response=await client.callTool({name:'search_law',arguments:{query:request.law_name,display:10}},undefined,{timeout:25000});
      const law=!response.isError?exactCurrentLaw(response,request.law_name):null;
      const articles=[];
      if(law && request.article){
        const article=await client.callTool({name:'get_law_text',arguments:{mst:law.mst,jo:request.article}},undefined,{timeout:25000});
        articles.push({selector:request.article,status:article.isError?'unavailable':'retrieved',text:textOf(article)});
      }
      results.push({request,status:law&&!articles.some(a=>a.status!=='retrieved')?'retrieved':'partial',law,search_text:textOf(response),articles});
    }catch{
      results.push({request,status:'unavailable',code:'LEGAL_LOOKUP_FAILED'});
    }
  }
  return {status:results.some(r=>r.status!=='retrieved')?'partial':'retrieved',scope:'검색 시점 현행 법령·요청 조문. 사건 기준일·경과조치·사실관계 적용성은 별도 검토.',results};
}
async function closeLegalClient(){if(connection){const c=await connection;await c.close();connection=null;}}
module.exports={queryLegalReferences,closeLegalClient,exactCurrentLaw};

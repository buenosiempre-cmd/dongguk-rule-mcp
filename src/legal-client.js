'use strict';
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {parseDateLoose}=require('./timeline.js');

const DEFAULT_TIMEOUT_MS=25000;
const MAX_REQUESTS=8;
const MAX_TEXT_CHARS=120000;
const SCOPE='법령 본문과 별표는 조회 근거입니다. 기준일 버전을 확인해도 부칙·경과조치·조항별 시행일과 사건 적용성은 별도 검토해야 합니다. 과거 별표 및 버전 미확인 자료를 과거 적용 근거로 확정하지 마세요.';
let connection;
const failure=code=>Object.assign(new Error(code),{code});
const normalize=name=>String(name||'').replace(/[\sㆍ·]/g,'');
const textOf=response=>Array.isArray(response?.content)?response.content.filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):'';
const compactDate=value=>parseDateLoose(value)?.iso.replace(/-/g,'')||null;
const responseFailed=response=>!response||response.isError===true||Boolean(response.error)||response.structuredContent?.ok===false;

// A local deadline also bounds injected/older clients that ignore the SDK timeout.
async function bounded(operation,timeoutMs){
  const controller=new AbortController();
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('LEGAL_TIMEOUT'));},timeoutMs);});
  try{return await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),timeout]);}
  finally{clearTimeout(timer);}
}
async function legalClient(timeoutMs){
  if(process.env.DONGGUK_LEGAL_MCP_ENABLED!=='1'||!process.env.LAW_OC) throw failure('LEGAL_MCP_NOT_CONFIGURED');
  if(!connection){
    connection=(async()=>{
      let client,transport;
      try{
        const args=JSON.parse(process.env.DONGGUK_LEGAL_MCP_ARGS||'["--offline","korean-law-mcp"]');
        if(!Array.isArray(args)||args.some(a=>typeof a!=='string')) throw failure('LEGAL_MCP_NOT_CONFIGURED');
        client=new Client({name:'dongguk-finance-desk',version:require('../package.json').version});
        transport=new StdioClientTransport({command:process.env.DONGGUK_LEGAL_MCP_COMMAND||'npx',args,env:{PATH:process.env.PATH,HOME:process.env.HOME,LAW_OC:process.env.LAW_OC},stderr:'pipe'});
        client.onclose=()=>{connection=null;};
        const connecting=client.connect(transport,{timeout:timeoutMs});
        transport.stderr?.resume();
        await bounded(()=>connecting,timeoutMs);
        transport.stderr?.resume();
        return client;
      }catch(error){
        // Do not surface child stderr, arguments or exception messages: they may contain credentials.
        await client?.close().catch(()=>{});
        await transport?.close().catch(()=>{});
        throw failure(error?.code==='LEGAL_TIMEOUT'?'LEGAL_TIMEOUT':error?.code==='LEGAL_MCP_NOT_CONFIGURED'?'LEGAL_MCP_NOT_CONFIGURED':'LEGAL_CONNECTION_FAILED');
      }
    })().catch(error=>{connection=null;throw error;});
  }
  return bounded(()=>connection,timeoutMs);
}
function errorCode(error){
  if(['LEGAL_TIMEOUT','LEGAL_MCP_NOT_CONFIGURED','LEGAL_CONNECTION_FAILED','LEGAL_TOOL_UNAVAILABLE','HISTORICAL_LOOKUP_UNAVAILABLE'].includes(error?.code)) return error.code;
  if(error?.code===-32001||error?.name==='AbortError'||/timed?\s*out|timeout/i.test(String(error?.message||''))) return 'LEGAL_TIMEOUT';
  if(error?.code===-32601||/unknown tool|tool .*not found|method not found/i.test(String(error?.message||''))) return 'LEGAL_TOOL_UNAVAILABLE';
  if(['ECONNREFUSED','ECONNRESET','EPIPE'].includes(error?.code)||/not connected|connection closed|transport closed/i.test(String(error?.message||''))) return 'LEGAL_CONNECTION_FAILED';
  return 'LEGAL_LOOKUP_FAILED';
}
function errorText(text){
  return /^\s*(?:\[(?:NOT_FOUND|[A-Z_]*ERROR|[A-Z_]*FAILED|ANNEX_BODY_UNAVAILABLE|UPSTREAM_[A-Z_]+)\]|Error:|오류:|파일 다운로드 실패|조문 번호 변환 실패)/im.test(text)||/^\s*<(?:!doctype\s+html|html)(?:\s|>)/i.test(text);
}
function clipped(text,maxTextChars){
  const upstreamTruncated=/\[응답 크기 제한\]|응답이 너무 길어[\s\S]{0,50}잘렸습니다|…\s*\(생략\)/.test(text);
  const openTables=(text.match(/<table\b/gi)||[]).length;
  const closeTables=(text.match(/<\/table\s*>/gi)||[]).length;
  const incompleteTable=openTables>closeTables;
  let selected=text.slice(0,maxTextChars);
  if(/[\uD800-\uDBFF]$/.test(selected)) selected=selected.slice(0,-1);
  return {text:selected,truncated:text.length>maxTextChars||upstreamTruncated||incompleteTable,upstreamTruncated,incompleteTable,originalChars:text.length,returnedChars:selected.length};
}
function exactCurrentLaw(response,name){
  if(responseFailed(response)) return null;
  // Keep the established current-law format; exclude substring and future-law hints.
  for(const m of textOf(response).matchAll(/^\d+\. (.+?) \[현행\]\r?\n\s*- 법령ID: (\d+)\r?\n\s*- MST: (\d+)\r?\n\s*- 공포일: (\d+) \/ 시행일: (\d+)/gm)){
    if(normalize(m[1])===normalize(name)&&compactDate(m[4])&&compactDate(m[5])) return {name:m[1],lawId:m[2],mst:m[3],promulgatedAt:m[4],effectiveAt:m[5],sourceUrl:`https://www.law.go.kr/법령/${encodeURIComponent(m[1])}`};
  }
  return null;
}
function historicalVersion(response,name,baseDate){
  const text=textOf(response);
  if(responseFailed(response)||errorText(text)) return null;
  const heading=/행위시법 판단:\s*(.+?)\s*@\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/.exec(text);
  const selected=/▶\s*기준일에 시행 중이던 버전\s*\r?\n\s*(.+?)\s*\[시행 ([\d.\-/]+)\]\s*\[([^\]\r\n]+)\]\s*\(MST (\d+)\)/.exec(text);
  if(!heading||normalize(heading[1])!==normalize(name)||parseDateLoose(heading[2])?.iso!==baseDate.iso||!selected||normalize(selected[1])!==normalize(name)) return null;
  const effective=parseDateLoose(selected[2]);
  if(!effective||effective.ts>baseDate.ts) return null;
  return {name:selected[1],lawId:null,mst:selected[4],effectiveAt:compactDate(selected[2]),promulgatedAt:compactDate(/\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}/.exec(selected[3])?.[0]),sourceUrl:`https://www.law.go.kr/법령/${encodeURIComponent(selected[1])}`};
}
function articleSelector(value){
  if(value===undefined) return null;
  if(typeof value!=='string') return false;
  const text=value.trim();
  const m=/^제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,2}))?$/.exec(text);
  const code=/^\d{6}$/.test(text)?[null,text.slice(0,4),text.slice(4)]:null;
  const parsed=m||code;
  if(!parsed||Number(parsed[1])<1) return false;
  return `제${Number(parsed[1])}조${Number(parsed[2])?`의${Number(parsed[2])}`:''}`;
}
function annexSelector(value){
  if(value===undefined) return null;
  if(typeof value!=='string') return false;
  const m=/^(?:별표\s*)?(\d{1,4})(?:\s*의\s*(\d{1,3}))?$/.exec(value.trim());
  return m&&Number(m[1])>0?`${Number(m[1])}${m[2]?`의${Number(m[2])}`:''}`:false;
}
function bodyProblem(response,law,selector){
  const text=textOf(response);
  if(responseFailed(response)||errorText(text)) return 'LEGAL_BODY_ERROR';
  if(!text.trim()) return 'LEGAL_EMPTY_BODY';
  const name=/^법령명:\s*(.+)$/m.exec(text)?.[1];
  if(!name||normalize(name)!==normalize(law.name)) return 'LEGAL_BODY_LAW_MISMATCH';
  const effective=compactDate(/^시행일:\s*(.+)$/m.exec(text)?.[1]);
  if(!effective||effective!==law.effectiveAt) return 'LEGAL_BODY_VERSION_UNVERIFIED';
  if(/^목차\s*\(총\s*\d+개 조문\)/m.test(text)) return 'LEGAL_TOC_ONLY';
  const headers=[...text.matchAll(/^(제\d+조(?:의\d+)?)(\([^\r\n]*?\))?[^\S\r\n]*([^\r\n]*)/gm)];
  const index=selector?headers.findIndex(h=>h[1]===selector):0;
  if(index<0||!headers[index]) return 'LEGAL_ARTICLE_MISSING';
  // The live tool emits both "제17조 계정과목" and "제17조(계정과목)".
  // Neither title is body evidence. Select the final repeated header, then test
  // actual prose; parenthesized headers may also have same-line statutory text.
  let last=index;
  while(headers[last+1]?.[1]===headers[index][1]) last++;
  const header=headers[last],next=headers[last+1]?.index??text.length;
  const inline=header[2]?header[3]:/^삭제(?:\s|<|$)/.test(header[3])?header[3]:'';
  const body=(inline+'\n'+text.slice(header.index+header[0].length,next)).replace(/^\s*(?:⚠|ℹ|\[응답 크기 제한\]|나머지 조문 조회|여러 조문 일괄 조회).*$/gm,'').trim();
  if(!body||!/[^\s\p{P}\p{S}\d]/u.test(body)) return 'LEGAL_EMPTY_BODY';
  return null;
}
function annexProblem(response,lawName,selector){
  const text=textOf(response);
  if(responseFailed(response)||errorText(text)) return 'LEGAL_BODY_ERROR';
  if(!text.trim()) return 'LEGAL_EMPTY_BODY';
  const header=text.split(/\r?\n/,1)[0];
  if(!normalize(header).startsWith(normalize(lawName)+'-')) return 'LEGAL_BODY_LAW_MISMATCH';
  if(!/\(파일 형식:\s*[A-Z]+/.test(text)||/이미지 기반 PDF입니다|텍스트 추출(?:이 불가| 실패)|다운로드 안내만|본문을 확보하지 못/.test(text)) return 'LEGAL_ANNEX_BODY_UNAVAILABLE';
  const rawBody=text.slice(text.indexOf('\n\n')+2);
  if(/<table\b/i.test(rawBody)){
    const cells=[...rawBody.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if(!cells.some(m=>m[1].replace(/<[^>]*>/g,'').replace(/&(?:nbsp|#160);/g,' ').trim())) return 'LEGAL_ANNEX_BODY_UNAVAILABLE';
  }
  const body=rawBody.replace(/^.*\[\s*별표\s*\d+.*$/gm,'').replace(/^\s*(?:⚠|\(파일 형식:|다운로드 링크:|파일 링크:|원문 파일:).*$/gm,'').replace(/<[^>]*>/g,' ').replace(/https?:\/\/\S+/g,'').trim();
  if(body.length<20||/^(?:다운로드|파일|원문)\s*링크\s*:/.test(body)) return 'LEGAL_ANNEX_BODY_UNAVAILABLE';
  const markers=[...text.matchAll(/\[\s*별표\s*(\d+)(?:\s*의\s*(\d+))?\s*\]/g)].map(m=>`${Number(m[1])}${m[2]?`의${Number(m[2])}`:''}`);
  if(markers.length&&!markers.includes(selector)) return 'LEGAL_ANNEX_SELECTOR_MISMATCH';
  return null;
}
function summarize(results,baseDate,limits,extra={}){
  const counts={requested:results.length,attempted:results.filter(r=>r.attempted).length,retrieved:results.filter(r=>r.status==='retrieved').length,partial:results.filter(r=>r.status==='partial').length,unavailable:results.filter(r=>r.status==='unavailable').length,notRequested:results.filter(r=>r.status==='not_requested').length,notRetrieved:results.filter(r=>r.status!=='retrieved').length,bodyRetrieved:results.filter(r=>[...(r.articles||[]),...(r.annexes||[])].some(a=>a.bodyRetrieved)).length};
  const status=!results.length?(extra.code?'unavailable':'not_required'):counts.retrieved===results.length?'retrieved':counts.retrieved+counts.partial?'partial':'unavailable';
  return {status,baseDate:baseDate?.iso||null,scope:SCOPE,applicability:'requires_review',counts,limits,results,...extra};
}

/**
 * Korean Law legal_analysis/applicable_law resolves a historical MST and its actual
 * effective date. MOLEG efYd selects that effective slice; it is NOT a transaction
 * date filter, and ID+efYd ignores the date. Never substitute an unverified current
 * body for historical evidence. get_annexes cannot pin a historical version.
 */
async function queryLegalReferences(requests,{baseDate,client:injectedClient,timeoutMs=DEFAULT_TIMEOUT_MS,maxRequests=MAX_REQUESTS,maxTextChars=MAX_TEXT_CHARS,now=new Date()}={}){
  const limits={maxRequests,maxTextChars,timeoutMs};
  if(!Array.isArray(requests)) return summarize([],null,limits,{code:'INVALID_LEGAL_REQUESTS'});
  const today=parseDateLoose(new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}));
  const date=baseDate===undefined||baseDate===null?today:parseDateLoose(baseDate);
  const globalError=!date||!today?'INVALID_BASE_DATE':!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>MAX_REQUESTS||!Number.isInteger(maxTextChars)||maxTextChars<1||maxTextChars>MAX_TEXT_CHARS?'INVALID_LEGAL_OPTIONS':null;
  const results=requests.map((request,i)=>({request,status:'not_requested',attempted:false,articles:[],annexes:[],...(globalError?{status:'unavailable',code:globalError}:i>=maxRequests?{code:'LEGAL_REQUEST_LIMIT'}:{})}));
  if(globalError||!requests.length) return summarize(results,date,limits,globalError?{code:globalError}:{});
  if(date.ts>today.ts){
    for(const result of results) if(!result.code) Object.assign(result,{code:'FUTURE_DATE_UNVERIFIED',dateStatus:'future_unverified',referenceOnly:true});
    return summarize(results,date,limits,{code:'FUTURE_DATE_UNVERIFIED'});
  }
  const historical=date.ts<today.ts;
  const eligible=[];
  for(const result of results){
    if(result.code) continue;
    const request=result.request;
    const selector=articleSelector(request?.article),annexNo=annexSelector(request?.annex);
    if(!request||typeof request!=='object'||Array.isArray(request)||typeof request.law_name!=='string'||!request.law_name.trim()||request.law_name.length>200||/[\r\n\0]/.test(request.law_name)||selector===false||annexNo===false){Object.assign(result,{status:'unavailable',code:'INVALID_LEGAL_REQUEST'});continue;}
    eligible.push({result,lawName:request.law_name.trim(),selector,annexNo});
  }
  if(!eligible.length) return summarize(results,date,limits);
  let client;
  try{client=injectedClient||await legalClient(timeoutMs);if(typeof client?.callTool!=='function') throw failure('LEGAL_CONNECTION_FAILED');}
  catch(error){const code=errorCode(error);for(const {result} of eligible) Object.assign(result,{status:'unavailable',code});return summarize(results,date,limits,{code});}
  const call=(name,args)=>bounded(signal=>client.callTool({name,arguments:args},undefined,{timeout:timeoutMs,signal}),timeoutMs);
  const currentLookups=new Map(),historicalLookups=new Map();
  let historicalTool;
  const currentLaw=name=>{
    const key=normalize(name);
    if(!currentLookups.has(key)) currentLookups.set(key,(async()=>{
      const response=await call('search_law',{query:name,display:100});
      if(responseFailed(response)||errorText(textOf(response))) throw failure('LEGAL_LOOKUP_FAILED');
      const law=exactCurrentLaw(response,name);
      if(!law) throw failure('LEGAL_EXACT_LAW_NOT_FOUND');
      if(law.effectiveAt>compactDate(today.iso)) throw failure('LEGAL_CURRENT_VERSION_UNVERIFIED');
      return {law,search:clipped(textOf(response),maxTextChars)};
    })());
    return currentLookups.get(key);
  };
  const atDate=name=>{
    const key=normalize(name);
    if(!historicalLookups.has(key)) historicalLookups.set(key,(async()=>{
      if(!historicalTool) historicalTool=(async()=>{
        if(typeof client.listTools!=='function') throw failure('HISTORICAL_LOOKUP_UNAVAILABLE');
        // Follow pagination but bound a malformed/cycling provider.
        let cursor;const seen=new Set();
        for(let page=0;page<8;page++){
          const listing=await bounded(signal=>client.listTools(cursor?{cursor}:{},{timeout:timeoutMs,signal}),timeoutMs);
          const names=(listing?.tools||[]).map(t=>t.name);
          if(names.includes('legal_analysis')) return 'legal_analysis';
          if(names.includes('applicable_law')) return 'applicable_law';
          if(!listing?.nextCursor||seen.has(listing.nextCursor)) break;
          cursor=listing.nextCursor;seen.add(cursor);
        }
        throw failure('HISTORICAL_LOOKUP_UNAVAILABLE');
      })();
      const tool=await historicalTool;
      const response=await call(tool,{...(tool==='legal_analysis'?{mode:'applicable_law'}:{}),lawName:name,date:date.iso});
      const law=historicalVersion(response,name,date);
      if(!law) throw failure('HISTORICAL_VERSION_UNVERIFIED');
      return {law,resolution:clipped(textOf(response),maxTextChars),tool};
    })());
    return historicalLookups.get(key);
  };
  const safeCode=error=>/^LEGAL_|^HISTORICAL_/.test(error?.code||'')?error.code:errorCode(error);
  for(const {result,lawName,selector,annexNo} of eligible){
    result.attempted=true;
    result.dateStatus=historical?'historical_unverified':'current';
    const needsLawBody=Boolean(selector)||!annexNo;
    if(needsLawBody){
      const article={selector:selector||null,status:'unavailable',bodyRetrieved:false,dateStatus:result.dateStatus,referenceOnly:historical,source:null};
      result.articles.push(article);
      try{
        const resolved=await(historical?atDate(lawName):currentLaw(lawName));
        const law=resolved.law;
        result.law=law;
        if(resolved.search) result.search_text=resolved.search.text;
        if(resolved.resolution) result.dateResolution={...resolved.resolution,tool:resolved.tool};
        const arguments_={mst:law.mst,efYd:law.effectiveAt,...(selector?{jo:selector}:{})};
        const response=await call('get_law_text',arguments_);
        article.source={provider:'Korean Law MCP',tool:'get_law_text',lawName:law.name,lawId:law.lawId,mst:law.mst,effectiveAt:law.effectiveAt,baseDate:date.iso,retrievedAt:new Date().toISOString(),url:law.sourceUrl,arguments:arguments_};
        const problem=bodyProblem(response,law,selector);
        if(problem&&problem!=='LEGAL_TOC_ONLY') throw failure(problem);
        const content=clipped(textOf(response),maxTextChars);
        Object.assign(article,content,{status:problem||content.truncated?'partial':'retrieved',bodyRetrieved:!problem,dateStatus:historical?'historical_version_retrieved':'current',referenceOnly:false,...(problem?{code:problem}:content.truncated?{code:'LEGAL_TEXT_TRUNCATED'}:{})});
      }catch(error){article.code=safeCode(error);}
    }
    if(annexNo){
      const annex={selector:`별표 ${annexNo}`,annexNo,status:'unavailable',bodyRetrieved:false,dateStatus:historical?'historical_unverified':'current_unpinned',referenceOnly:historical,source:null};
      result.annexes.push(annex);
      try{
        const {law,search}=await currentLaw(lawName);
        if(!result.law) result.law=law;
        result.search_text=search.text;
        const arguments_={lawName:law.name,annexNo,...(selector?{jo:selector}:{})};
        const response=await call('get_annexes',arguments_);
        annex.source={provider:'Korean Law MCP',tool:'get_annexes',lawName:law.name,lawId:law.lawId,mst:null,currentLawMst:law.mst,effectiveAt:null,versionVerified:false,baseDate:date.iso,retrievedAt:new Date().toISOString(),url:law.sourceUrl,annexNo,arguments:arguments_};
        const problem=annexProblem(response,law.name,annexNo);
        if(problem) throw failure(problem);
        const text=textOf(response),content=clipped(text,maxTextChars);
        const canonicalUnverified=/정본 링크 확인 불가|최신 개정이 반영되지 않은 구본/.test(text);
        const referenceOnly=historical||canonicalUnverified;
        Object.assign(annex,content,{status:referenceOnly||content.truncated?'partial':'retrieved',bodyRetrieved:true,referenceOnly,...(canonicalUnverified?{dateStatus:historical?'historical_unverified':'current_unverified'}:{}),...(historical?{code:'HISTORICAL_ANNEX_UNVERIFIED'}:canonicalUnverified?{code:'LEGAL_ANNEX_VERSION_UNVERIFIED'}:content.truncated?{code:'LEGAL_TEXT_TRUNCATED'}:{})});
      }catch(error){annex.code=safeCode(error);}
    }
    const targets=[...result.articles,...result.annexes];
    result.status=targets.every(t=>t.status==='retrieved')?'retrieved':targets.some(t=>t.status!=='unavailable')?'partial':'unavailable';
    result.dateStatus=historical?targets.every(t=>t.dateStatus==='historical_version_retrieved')?'historical_version_retrieved':'historical_unverified':targets.some(t=>t.dateStatus==='current_unverified')?'current_unverified':annexNo&&!selector?'current_unpinned':'current';
    result.referenceOnly=targets.some(t=>t.referenceOnly);
    if(result.status!=='retrieved') result.code=targets.find(t=>t.code)?.code||'LEGAL_PARTIAL_RESULT';
  }
  return summarize(results,date,limits);
}
async function closeLegalClient(){const pending=connection;connection=null;if(pending){try{const client=await pending;await client.close();}catch{ /* Failed connections already clean up their transport. */ }}}
module.exports={queryLegalReferences,closeLegalClient,exactCurrentLaw};

'use strict';
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {createHash}=require('node:crypto');
const {parseDateLoose}=require('./timeline.js');

const DEFAULT_TIMEOUT_MS=25000;
const DEFAULT_TOTAL_TIMEOUT_MS=45000;
const MAX_REQUESTS=8;
const MAX_TEXT_CHARS=120000;
const SCOPE='법령 본문과 별표는 조회 근거입니다. 기준일 버전을 확인해도 부칙·경과조치·조항별 시행일과 사건 적용성은 별도 검토해야 합니다. 과거 별표 및 버전 미확인 자료를 과거 적용 근거로 확정하지 마세요.';
let connection;
const failure=code=>Object.assign(new Error(code),{code});
const normalize=name=>String(name||'').replace(/[\sㆍ·]/g,'');
const textOf=response=>Array.isArray(response?.content)?response.content.filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):'';
const compactDate=value=>parseDateLoose(value)?.iso.replace(/-/g,'')||null;
const responseFailed=response=>!response||response.isError===true||Boolean(response.error)||response.structuredContent?.ok===false;

// --- Law-call cache, upstream rate-limit retry and counters ---
// Laws change rarely, and one law (소득세법, 사립학교법 ...) is cited by many rules,
// so every successful provider answer is kept on disk and shared by all tools:
// - search_law / get_annexes: the current-law listing for one Korea (KST) day.
// - get_law_text with an MST: an MST pins one promulgated version, so its text
//   never changes; kept 30 days.
// - legal_analysis / applicable_law: the version in force on a past date; 7 days.
// Error, empty, maintenance and "not found" answers are never cached.
const CALL_CACHE_POLICY={
  search_law:{ttl:6*3600,daily:true},
  get_annexes:{ttl:6*3600,daily:true},
  get_law_text:{ttl:30*86400,daily:false,needs:args=>Boolean(args&&args.mst)},
  legal_analysis:{ttl:7*86400,daily:false},
  applicable_law:{ttl:7*86400,daily:false},
};
const RETRY_ATTEMPTS=2;
const RETRY_MAX_WAIT_MS=5000;
const FETCHED_AT=Symbol('fetchedAt');
const stats={upstreamCalls:0,cacheHits:0,cacheMisses:0,rateLimited:0,retries:0,since:new Date().toISOString()};
let defaultCallCache=null;
// index.js hands over its disk cache (public/private scoped, DONGGUK_MCP_NO_CACHE aware).
function setLegalCallCache(cache){defaultCallCache=typeof cache==='function'?cache:null;}
function legalCallStats(){return {...stats};}
function resetLegalCallStats(){Object.assign(stats,{upstreamCalls:0,cacheHits:0,cacheMisses:0,rateLimited:0,retries:0,since:new Date().toISOString()});}
const kstDay=now=>new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`:JSON.stringify(value);
function callCacheKey(name,args,now=Date.now()){
  const policy=CALL_CACHE_POLICY[name];
  if(!policy||(policy.needs&&!policy.needs(args))) return null;
  return createHash('sha256').update([name,stable(args||{}),policy.daily?kstDay(now):''].join('|')).digest('hex');
}
// The provider and the hosted server report a quota hit as HTTP 429 or as an
// error result that names the limit. Anything else is not retried here.
const RATE_LIMIT_TEXT=/\b429\b|too many requests|rate[ _-]?limit|quota|요청 한도|호출 한도|한도를? 초과|한도 초과|일일 호출|분당 [0-9,]+회/i;
function retryAfterMs(text){
  const m=/retry[- _]?after\D{0,12}(\d+(?:\.\d+)?)/i.exec(text)||/(\d+(?:\.\d+)?)\s*초\s*(?:후|뒤)/.exec(text);
  return m?Math.round(parseFloat(m[1])*1000):null;
}
function rateLimitOf(error,response){
  if(error){
    const message=String(error?.message||'');
    return error?.code===429||RATE_LIMIT_TEXT.test(message)?{waitMs:retryAfterMs(message)}:null;
  }
  if(!responseFailed(response)) return null;
  const text=textOf(response)+' '+String(response?.error?.message||'');
  return RATE_LIMIT_TEXT.test(text)?{waitMs:retryAfterMs(text)}:null;
}
const cacheable=response=>!responseFailed(response)&&!errorText(textOf(response))&&textOf(response).trim().length>0;
const fetchedAt=response=>response?.[FETCHED_AT]||new Date().toISOString();
// raw(name,args) performs one provider call. deadline() is the epoch ms after
// which no retry may start.
function resilientCaller(raw,{cache=defaultCallCache,deadline=()=>Infinity,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
  const live=async(name,args)=>{
    for(let attempt=0;;attempt++){
      let response,error;
      stats.upstreamCalls++;
      try{response=await raw(name,args);}catch(e){error=e;}
      const limited=rateLimitOf(error,response);
      if(!limited){if(error) throw error;return response;}
      stats.rateLimited++;
      const waitMs=Math.min(limited.waitMs??500*2**attempt,RETRY_MAX_WAIT_MS);
      if(attempt>=RETRY_ATTEMPTS||deadline()-Date.now()<waitMs+1000) throw failure('LEGAL_UPSTREAM_RATE_LIMITED');
      stats.retries++;
      await sleep(waitMs);
    }
  };
  return async(name,args)=>{
    const key=cache?callCacheKey(name,args,now()):null;
    if(!key) return live(name,args);
    let loaded=false;
    try{
      const value=await cache('legal-call',key,CALL_CACHE_POLICY[name].ttl,async()=>{
        loaded=true;
        const response=await live(name,args);
        if(!cacheable(response)) throw Object.assign(new Error('not cacheable'),{uncached:response});
        return {fetchedAt:new Date(now()).toISOString(),response};
      });
      if(loaded) stats.cacheMisses++; else stats.cacheHits++;
      return Object.assign({},value.response,{[FETCHED_AT]:value.fetchedAt});
    }catch(error){
      if(loaded) stats.cacheMisses++;
      if(error&&Object.prototype.hasOwnProperty.call(error,'uncached')) return error.uncached;
      throw error;
    }
  };
}

// A local deadline also bounds injected/older clients that ignore the SDK timeout.
async function bounded(operation,timeoutMs,onTimeout=()=>{}){
  const controller=new AbortController();
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{onTimeout();controller.abort();reject(failure('LEGAL_TIMEOUT'));},timeoutMs);});
  try{return await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),timeout]);}
  finally{clearTimeout(timer);}
}
// The law server is used whenever the operator has given an address or a key.
// DONGGUK_LEGAL_MCP_ENABLED=0 is the operator's off switch; no value means on.
// reason: disabled (switched off) | missing (no address or key) | invalid (bad value).
const notConfigured=reason=>Object.assign(failure('LEGAL_MCP_NOT_CONFIGURED'),{reason});
function legalTransport(){
  return process.env.DONGGUK_LEGAL_MCP_TRANSPORT||((process.env.DONGGUK_LEGAL_MCP_URL||'').trim()?'streamable-http':'stdio');
}
function connectionSettings(){
  if(process.env.DONGGUK_LEGAL_MCP_ENABLED==='0') throw notConfigured('disabled');
  const kind=legalTransport();
  if(kind==='streamable-http'){
    const raw=(process.env.DONGGUK_LEGAL_MCP_URL||'').trim();
    if(!raw) throw notConfigured('missing');
    let url;
    try{url=new URL(raw);}catch{throw notConfigured('invalid');}
    const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))||url.username||url.password||url.search||url.hash) throw notConfigured('invalid');
    const token=(process.env.DONGGUK_LEGAL_MCP_BEARER_TOKEN||'').trim();
    // The operator's own 법제처 OC for a hosted Korean Law MCP (sent as the
    // documented "apikey" header). Without it a hosted server answers from its
    // shared keyless quota. Never echoed in any response or log.
    const apiKey=(process.env.DONGGUK_LEGAL_MCP_API_KEY||'').trim();
    if(/[\r\n]/.test(token)||/[\r\n]/.test(apiKey)) throw notConfigured('invalid');
    return {kind,url:url.href,token,apiKey,loopback};
  }
  if(kind!=='stdio') throw notConfigured('invalid');
  if(!process.env.LAW_OC) throw notConfigured('missing');
  let args;
  try{args=JSON.parse(process.env.DONGGUK_LEGAL_MCP_ARGS||'["--offline","korean-law-mcp"]');}catch{throw notConfigured('invalid');}
  if(!Array.isArray(args)||args.some(a=>typeof a!=='string')) throw notConfigured('invalid');
  return {kind,command:process.env.DONGGUK_LEGAL_MCP_COMMAND||'npx',args,lawOc:process.env.LAW_OC};
}
// Which 법제처 quota a lookup draws on, from the settings alone (never the key).
// own_key: this process passes the operator's key (stdio LAW_OC, apikey header
// or bearer token). local_operator_key: a loopback korean-law-mcp the operator
// runs on the same machine with its own LAW_OC, so lookups never touch a hosted
// server's shared quota. shared_keyless: a remote hosted server without a key,
// whose quota every keyless user shares.
function legalQuota(settings){
  if(settings.kind==='stdio'||settings.apiKey||settings.token) return 'own_key';
  if(settings.loopback) return 'local_operator_key';
  return 'shared_keyless';
}
// Whether the law server can be reached with the current settings, without
// connecting. Never returns the address or the key.
function legalServerState(){
  try{
    const settings=connectionSettings();
    return {state:'ready',transport:settings.kind,quota:legalQuota(settings)};
  }
  catch(error){return {state:error.reason||'invalid',transport:legalTransport()};}
}
// Plain-language guidance for a missing law connection. It names the settings
// an operator can add and where the key is issued; it never invents an address.
const OC_APPLY_URL='https://open.law.go.kr';
function legalSetupGuide(state){
  if(state==='ready') return null;
  const env=state==='disabled'?['DONGGUK_LEGAL_MCP_ENABLED']:['DONGGUK_LEGAL_MCP_URL','LAW_OC'];
  const message=state==='disabled'
    ?'서버 운영자가 법령 연결을 꺼 두었습니다(DONGGUK_LEGAL_MCP_ENABLED=0). 운영자가 이 값을 지우면 다시 켜집니다.'
    :state==='missing'
      ?`이 서버에는 한국법령 MCP 연결 정보가 없어 법령을 조회할 수 없습니다. 서버 운영자가 환경변수 DONGGUK_LEGAL_MCP_URL에 한국법령 MCP 서버 주소를 넣거나, LAW_OC에 법제처 Open API 인증키(OC)를 넣으면 켜집니다(LAW_OC 방식은 서버에 korean-law-mcp가 설치되어 있어야 합니다). OC는 ${OC_APPLY_URL} 에서 신청합니다.`
      :'법령 MCP 연결 설정 값이 올바르지 않아 법령을 조회할 수 없습니다. 서버 운영자가 DONGGUK_LEGAL_MCP_URL(https 주소, 계정·쿼리 문자열 없이)과 DONGGUK_LEGAL_MCP_TRANSPORT(streamable-http 또는 stdio) 값을 확인해야 합니다.';
  return {state,env,ocApplyUrl:OC_APPLY_URL,message};
}
async function legalClient(timeoutMs){
  const settings=connectionSettings();
  const key=createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  if(connection&&connection.key!==key) await closeLegalClient();
  if(!connection){
    const record={key,promise:null};
    connection=record;
    record.promise=(async()=>{
      let client,transport;
      try{
        client=new Client({name:'dongguk-finance-desk',version:require('../package.json').version});
        transport=settings.kind==='streamable-http'
          ? new StreamableHTTPClientTransport(new URL(settings.url),{requestInit:{redirect:'error',headers:{...(settings.token?{Authorization:`Bearer ${settings.token}`}:{}),...(settings.apiKey?{apikey:settings.apiKey}:{})}}})
          : new StdioClientTransport({command:settings.command,args:settings.args,env:{PATH:process.env.PATH,HOME:process.env.HOME,LAW_OC:settings.lawOc},stderr:'pipe'});
        client.onclose=()=>{if(connection===record)connection=null;};
        const connecting=client.connect(transport,{timeout:timeoutMs});
        transport.stderr?.resume();
        await bounded(()=>connecting,timeoutMs);
        transport.stderr?.resume();
        return client;
      }catch(error){
        // Never expose transport URLs, credentials, child stderr or exception text.
        await client?.close().catch(()=>{});
        await transport?.close().catch(()=>{});
        throw error?.code==='LEGAL_MCP_NOT_CONFIGURED'?notConfigured(error.reason):failure(error?.code==='LEGAL_TIMEOUT'?'LEGAL_TIMEOUT':'LEGAL_CONNECTION_FAILED');
      }
    })().catch(error=>{if(connection===record)connection=null;throw error;});
  }
  const pending=connection.promise;
  return bounded(()=>pending,timeoutMs);
}

function errorCode(error){
  if(['LEGAL_TIMEOUT','LEGAL_TOTAL_TIMEOUT','LEGAL_MCP_NOT_CONFIGURED','LEGAL_CONNECTION_FAILED','LEGAL_TOOL_UNAVAILABLE','HISTORICAL_LOOKUP_UNAVAILABLE'].includes(error?.code)) return error.code;
  if(error?.code==='LEGAL_UPSTREAM_RATE_LIMITED') return error.code;
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
function bodyVersionProblem(text,law){
  const effective=compactDate(/^시행일:\s*(.+)$/m.exec(text)?.[1]);
  return !effective||effective!==law.effectiveAt?'LEGAL_BODY_VERSION_UNVERIFIED':null;
}
function bodyProblem(response,law,selector){
  const text=textOf(response);
  if(responseFailed(response)||errorText(text)) return 'LEGAL_BODY_ERROR';
  if(!text.trim()) return 'LEGAL_EMPTY_BODY';
  const name=/^법령명:\s*(.+)$/m.exec(text)?.[1];
  if(!name||normalize(name)!==normalize(law.name)) return 'LEGAL_BODY_LAW_MISMATCH';
  const versionProblem=bodyVersionProblem(text,law);
  if(versionProblem) return versionProblem;
  if(/^목차\s*\(총\s*\d+개 조문\)/m.test(text)) return 'LEGAL_TOC_ONLY';
  // A body line can open with another article ("제70조의2제1항에도 불구하고",
  // "제5조 및 제6조에 따른"); only a token followed by a title or line end is a header.
  const headers=[...text.matchAll(/^(제\d+조(?:의\d+)?)(?=\(|[^\S\r\n]|$)(?![^\S\r\n]+(?:및|또는|내지|부터|ㆍ|·|,|에\s|에도|에서|의\s|를|을|은|는|이|가))(\([^\r\n]*?\))?[^\S\r\n]*([^\r\n]*)/gm)];
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
// v4.15 Korean Law puts a dated/versioned preamble ahead of the annex body.
// Cross-check it against independently resolved historical law metadata. A date
// argument alone is never evidence that the provider honored the requested date.
function datedAnnexEvidence(response,lawName,date,law){
  const text=textOf(response);
  const preamble=/^📅 기준일 (\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}) 당시 시행 버전의 별표입니다\.\r?\n\s*「([^」\r\n]+)」 \[시행 ([\d.\-/]+)\] \[([^\]\r\n]+)\] \(MST (\d+)\)/.exec(text);
  const lines=text.split(/\r?\n/);
  const start=lines.findIndex(line=>normalize(line).startsWith(normalize(lawName)+'-'));
  const body=start>=0?lines.slice(start).join('\n'):'';
  const verified=!!preamble&&parseDateLoose(preamble[1])?.iso===date.iso&&normalize(preamble[2])===normalize(lawName)&&compactDate(preamble[3])===law.effectiveAt&&preamble[5]===law.mst;
  return {verified,bodyResponse:{...response,content:[{type:'text',text:body}]}};
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
 * body for historical evidence. Dated annexes require advertised date support
 * and matching version metadata; legacy annexes remain explicit current references.
 */
async function queryLegalReferences(requests,{baseDate,client:injectedClient,timeoutMs=DEFAULT_TIMEOUT_MS,totalTimeoutMs=DEFAULT_TOTAL_TIMEOUT_MS,maxRequests=MAX_REQUESTS,maxTextChars=MAX_TEXT_CHARS,now=new Date(),cache,sleep}={}){
  const limits={maxRequests,maxTextChars,timeoutMs,totalTimeoutMs};
  const deadline=Date.now()+totalTimeoutMs;
  let totalExpired=false;
  const remaining=()=>{const ms=deadline-Date.now();if(totalExpired||ms<=0)throw failure('LEGAL_TOTAL_TIMEOUT');return {allowed:Math.min(timeoutMs,ms),totalLimited:ms<=timeoutMs};};
  if(!Array.isArray(requests)) return summarize([],null,limits,{code:'INVALID_LEGAL_REQUESTS'});
  const today=parseDateLoose(new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}));
  const date=baseDate===undefined||baseDate===null?today:parseDateLoose(baseDate);
  const globalError=!date||!today?'INVALID_BASE_DATE':!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isInteger(totalTimeoutMs)||totalTimeoutMs<1||totalTimeoutMs>120000||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>MAX_REQUESTS||!Number.isInteger(maxTextChars)||maxTextChars<1||maxTextChars>MAX_TEXT_CHARS?'INVALID_LEGAL_OPTIONS':null;
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
  try{const {allowed,totalLimited}=remaining();let timerExpired=false;client=injectedClient||await bounded(()=>legalClient(allowed),allowed,()=>{timerExpired=true;}).catch(error=>{if(timerExpired&&totalLimited&&errorCode(error)==='LEGAL_TIMEOUT')throw failure('LEGAL_TOTAL_TIMEOUT');throw error;});if(typeof client?.callTool!=='function') throw failure('LEGAL_CONNECTION_FAILED');}
  catch(error){const code=Date.now()>=deadline&&errorCode(error)==='LEGAL_TIMEOUT'?'LEGAL_TOTAL_TIMEOUT':errorCode(error);for(const {result} of eligible) Object.assign(result,{status:'unavailable',code});return summarize(results,date,limits,{code,...(code==='LEGAL_MCP_NOT_CONFIGURED'?{setup:legalSetupGuide(error?.reason||'invalid')}:{})});}
  const deadlineCall=async operation=>{
    const {allowed,totalLimited}=remaining();
    let timerExpired=false;
    try{return await bounded(signal=>operation(signal,allowed),allowed,()=>{timerExpired=true;});}
    catch(error){
      // A timer can fire just before Date.now reaches its millisecond deadline.
      // Classify by the budget that limited this call, and never start another
      // request after that total-budget timer has fired.
      if(errorCode(error)==='LEGAL_TIMEOUT'&&((timerExpired&&totalLimited)||Date.now()>=deadline)) {
        totalExpired=true;throw failure('LEGAL_TOTAL_TIMEOUT');
      }
      throw error;
    }
  };
  // Injected (test) clients are cached only when a cache is passed explicitly.
  const call=resilientCaller((name,args)=>deadlineCall((signal,allowed)=>client.callTool({name,arguments:args},undefined,{timeout:allowed,signal})),
    {cache:cache!==undefined?cache:injectedClient?null:defaultCallCache,deadline:()=>deadline,...(sleep?{sleep}:{})});
  let discoveredTools;
  const toolDefinitions=()=>{
    if(!discoveredTools)discoveredTools=(async()=>{
      if(typeof client.listTools!=='function')return [];
      const tools=[],seen=new Set();let cursor;
      for(let page=0;page<8;page++){
        const listing=await deadlineCall((signal,allowed)=>client.listTools(cursor?{cursor}:{},{timeout:allowed,signal}));
        tools.push(...(listing?.tools||[]));
        if(!listing?.nextCursor||seen.has(listing.nextCursor))break;
        cursor=listing.nextCursor;seen.add(cursor);
      }
      return tools;
    })();
    return discoveredTools;
  };
  const currentLookups=new Map(),historicalLookups=new Map();
  let historicalTool;
  const currentLaw=(name,suffixMatch=false,allowRename=false)=>{
    const key=`${normalize(name)}|${suffixMatch}|${allowRename}`;
    if(!currentLookups.has(key)) currentLookups.set(key,(async()=>{
      // Only parser-widened names may use bounded suffix queries; a complete
      // official name must still be contained at the end of the candidate.
      const words=name.split(/\s+/);
      const queries=suffixMatch?[...new Set([words.slice(-3).join(' '),words.slice(-2).join(' '),words.slice(-1)[0]])]:[name];
      let law=null,response,renamed=null,matchedFromText=null;
      for(const query of queries){
        response=await call('search_law',{query,display:100});
        const text=textOf(response);
        const noResult=/^\[NOT_FOUND\][^\r\n]*검색 결과가 없습니다/m.test(text);
        if((responseFailed(response)||errorText(text))&&!noResult) throw failure('LEGAL_LOOKUP_FAILED');
        law=exactCurrentLaw(response,name);
        if(!law&&suffixMatch&&!noResult){
          const matched=listedLaws(text).filter(x=>normalize(name).endsWith(normalize(x.name)))
            .sort((a,b)=>normalize(b.name).length-normalize(a.name).length)[0];
          if(matched){law={...matched,sourceUrl:matched.url};matchedFromText=name;}
        }
        // Current article references accept an explicit provider rename notice.
        // Historical resolution and annex identity retain their exact-name rules.
        if(!law&&!noResult&&allowRename){
          const notice=renameNotice(text,name);
          if(notice){
            law=exactCurrentLaw(response,notice.to);
            if(!law) throw failure('LEGAL_CURRENT_VERSION_UNVERIFIED');
            renamed=notice;
          }
        }
        if(law) break;
      }
      if(!law) throw failure('LEGAL_EXACT_LAW_NOT_FOUND');
      if(law.effectiveAt>compactDate(today.iso)) throw failure('LEGAL_CURRENT_VERSION_UNVERIFIED');
      return {law,search:clipped(textOf(response),maxTextChars),renamed,matchedFromText};
    })());
    return currentLookups.get(key);
  };
  const atDate=name=>{
    const key=normalize(name);
    if(!historicalLookups.has(key)) historicalLookups.set(key,(async()=>{
      if(!historicalTool) historicalTool=(async()=>{
        const names=(await toolDefinitions()).map(t=>t.name);
        if(names.includes('legal_analysis'))return 'legal_analysis';
        if(names.includes('applicable_law'))return 'applicable_law';
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
    if(totalExpired||Date.now()>=deadline){Object.assign(result,{code:'LEGAL_TOTAL_TIMEOUT',dateStatus:historical?'historical_unverified':'current',referenceOnly:historical});continue;}
    result.attempted=true;
    result.dateStatus=historical?'historical_unverified':'current';
    const needsLawBody=Boolean(selector)||!annexNo;
    if(needsLawBody){
      const article={selector:selector||null,status:'unavailable',bodyRetrieved:false,dateStatus:result.dateStatus,referenceOnly:historical,source:null};
      result.articles.push(article);
      try{
        const resolved=await(historical?atDate(lawName):currentLaw(lawName,result.request.suffixMatch===true,true));
        const law=resolved.law;
        result.law=law;
        if(resolved.matchedFromText) result.matchedFromText=resolved.matchedFromText;
        if(resolved.renamed){
          result.renamedFrom=resolved.renamed.from;
          result.warnings=[
            {code:'LAW_RENAMED',message:`규정이 옛 법령명 「${resolved.renamed.from}」을 인용합니다. 현행 제명은 「${law.name}」입니다.`},
            ...(selector?[{code:'ARTICLE_NUMBER_UNVERIFIED',message:`${selector}는 현행 「${law.name}」의 같은 번호 조문입니다. 옛 법령에서 인용한 조문과 같은 내용인지 확인하세요.`}]:[]),
          ];
        }
        if(resolved.search) result.search_text=resolved.search.text;
        if(resolved.resolution) result.dateResolution={...resolved.resolution,tool:resolved.tool};
        const arguments_={mst:law.mst,efYd:law.effectiveAt,...(selector?{jo:selector}:{})};
        const response=await call('get_law_text',arguments_);
        article.source={provider:'Korean Law MCP',tool:'get_law_text',lawName:law.name,lawId:law.lawId,mst:law.mst,effectiveAt:law.effectiveAt,baseDate:date.iso,retrievedAt:fetchedAt(response),url:law.sourceUrl,arguments:arguments_};
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
        const annexTool=historical?(await toolDefinitions()).find(t=>t.name==='get_annexes'):null;
        const dateSupported=historical&&annexTool?.inputSchema?.properties?.date?.type==='string';
        // Legacy clients can still provide current reference material, labelled
        // explicitly. Once dated lookup is supported, never silently fall back.
        const resolved=await(dateSupported?atDate(lawName):currentLaw(lawName));
        const law=resolved.law;
        if(!result.law) result.law=law;
        if(resolved.search)result.search_text=resolved.search.text;
        if(resolved.resolution)result.dateResolution={...resolved.resolution,tool:resolved.tool};
        const arguments_={lawName:law.name,annexNo,...(selector?{jo:selector}:{}),...(dateSupported?{date:date.iso}:{})};
        const response=await call('get_annexes',arguments_);
        const dated=dateSupported?datedAnnexEvidence(response,law.name,date,law):null;
        const versionVerified=dated?.verified===true;
        annex.source={provider:'Korean Law MCP',tool:'get_annexes',lawName:law.name,lawId:law.lawId,mst:versionVerified?law.mst:null,currentLawMst:dateSupported?null:law.mst,effectiveAt:versionVerified?law.effectiveAt:null,versionVerified,baseDate:date.iso,retrievedAt:fetchedAt(response),url:law.sourceUrl,annexNo,arguments:arguments_};
        const problem=annexProblem(dated?.bodyResponse||response,law.name,annexNo);
        if(problem) throw failure(problem);
        const text=textOf(response),content=clipped(text,maxTextChars);
        const canonicalUnverified=/정본 링크 확인 불가|최신 개정이 반영되지 않은 구본/.test(text);
        const referenceOnly=(historical&&!versionVerified)||canonicalUnverified;
        Object.assign(annex,content,{status:referenceOnly||content.truncated?'partial':'retrieved',bodyRetrieved:true,referenceOnly,
          dateStatus:historical?(versionVerified&&!canonicalUnverified?'historical_version_retrieved':'historical_unverified'):canonicalUnverified?'current_unverified':'current_unpinned',
          ...(historical&&!versionVerified?{code:'HISTORICAL_ANNEX_UNVERIFIED'}:canonicalUnverified?{code:'LEGAL_ANNEX_VERSION_UNVERIFIED'}:content.truncated?{code:'LEGAL_TEXT_TRUNCATED'}:{})});
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
// --- Law identity and cited-article inspection (get_rule_upper_laws) ---
// Reads the provider's listing as written: "N. 이름 [현행]" blocks, the
// "옛 법령명" notice for renamed laws and the "개정 시행예정" notice.
function listedLaws(text){
  const laws=[];
  for(const m of text.matchAll(/^\d+\. (.+?) \[현행\]\r?\n\s*- 법령ID: (\d+)\r?\n\s*- MST: (\d+)\r?\n\s*- 공포일: (\d+) \/ 시행일: (\d+)(?:\r?\n\s*- 구분: ([^\r\n]+))?/gm)){
    if(compactDate(m[4])&&compactDate(m[5])) laws.push({name:m[1].trim(),lawId:m[2],mst:m[3],promulgatedAt:m[4],effectiveAt:m[5],kind:m[6]?.trim()||null,url:`https://www.law.go.kr/법령/${encodeURIComponent(m[1].trim())}`});
  }
  return laws;
}
function renameNotice(text,name){
  for(const m of text.matchAll(/「([^」\r\n]+)」은\(는\) 옛 법령명입니다[^\r\n「]*현행은 「([^」\r\n]+)」(?:\(법령ID (\d+), MST (\d+)\))?/g)){
    if(normalize(m[1])===normalize(name)) return {from:m[1],to:m[2],lawId:m[3]||null,mst:m[4]||null};
  }
  return null;
}
function pendingAmendments(text,name){
  const found=[];
  for(const m of text.matchAll(/「([^」\r\n]+)」 개정 시행예정 \(([^,)\r\n]+), (\d{4}-\d{2}-\d{2}) 공포[^,)\r\n]*, 시행 (\d{4}-\d{2}-\d{2})/g)){
    if(normalize(m[1])===normalize(name)) found.push({kind:m[2].trim(),promulgatedAt:m[3],effectiveAt:m[4]});
  }
  return found;
}
const isoOf=compact=>compact?`${compact.slice(0,4)}-${compact.slice(4,6)}-${compact.slice(6,8)}`:null;
// Amendment marks inside an article: <개정 2019.9.17>, [전문개정 2020.1.1], 삭제<1999.1.29>.
// These are promulgation dates, not effective dates.
function amendmentDates(text){
  const dates=new Set();
  for(const mark of text.matchAll(/[<\[]\s*(?:개정|신설|전문개정|본조신설|제목개정|삭제)?\s*((?:\d{4}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}\.?\s*,?\s*)+)[>\]]/g)){
    for(const d of mark[1].matchAll(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/g)){const parsed=parseDateLoose(`${d[1]}-${d[2]}-${d[3]}`);if(parsed)dates.add(parsed.iso);}
  }
  return [...dates].sort();
}
function articleFacts(text,selector){
  // A body line can open with another article ("제70조의2제1항에도 불구하고",
  // "제5조 및 제6조에 따른"); only a token followed by a title or line end is a header.
  const headers=[...text.matchAll(/^(제\d+조(?:의\d+)?)(?=\(|[^\S\r\n]|$)(?![^\S\r\n]+(?:및|또는|내지|부터|ㆍ|·|,|에\s|에도|에서|의\s|를|을|은|는|이|가))(\([^\r\n]*?\))?[^\S\r\n]*([^\r\n]*)/gm)];
  const first=headers.findIndex(h=>h[1]===selector);
  if(first<0) return null;
  let last=first;
  while(headers[last+1]?.[1]===selector) last++;
  const end=headers[last+1]?.index??text.length;
  const titled=headers.slice(first,last+1).find(h=>h[2]);
  const plain=headers[first][2]?'':headers[first][3].trim();
  const title=titled?titled[2].slice(1,-1).trim():(/^삭제/.test(plain)?'':plain);
  const body=text.slice(headers[last].index,end).trim();
  const inline=headers[last][2]?headers[last][3]:/^삭제(?:\s|<|$)/.test(headers[last][3])?headers[last][3]:'';
  const prose=(inline+'\n'+text.slice(headers[last].index+headers[last][0].length,end)).trim();
  return {title:title||null,deleted:/^삭제\s*(?:<[^>]*>)?\s*$/.test(prose),amendedDates:amendmentDates(body),body};
}

/**
 * Identify each named law in the current-law listing and, for cited articles,
 * report whether the article exists today. One search per law; article bodies
 * share a separate cap. A name that only partly matches is never accepted,
 * except `suffixMatch` names (written without 낫표, so earlier words may have
 * been swept in): the longest listed name that ends the given name is taken.
 */
async function inspectLaws(requests,{client:injectedClient,timeoutMs=15000,totalTimeoutMs=40000,maxLaws=12,maxArticles=8,maxTextChars=3000,now=new Date(),cache,sleep}={}){
  const limits={maxLaws,maxArticles,maxTextChars,timeoutMs,totalTimeoutMs};
  const todayCompact=compactDate(new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}));
  const laws=(Array.isArray(requests)?requests:[]).map((request,i)=>({request,identity:{status:i<maxLaws?'unavailable':'not_checked',...(i<maxLaws?{}:{code:'LAW_LIMIT'})},articles:(request?.articles||[]).map(article=>({article,status:'not_checked'}))}));
  const finish=extra=>{
    const checked=laws.filter(x=>['current','renamed','not_found'].includes(x.identity.status));
    const status=!laws.length?'not_required':checked.length===laws.length&&laws.every(x=>x.articles.every(a=>a.status!=='unavailable'&&a.status!=='not_checked'||x.identity.status==='not_found'))?'retrieved':checked.length?'partial':'unavailable';
    return {status,laws,limits,...extra};
  };
  if(!laws.length) return finish();
  const deadline=Date.now()+totalTimeoutMs;
  let client;
  try{
    client=injectedClient||await legalClient(Math.min(timeoutMs,totalTimeoutMs));
    if(typeof client?.callTool!=='function') throw failure('LEGAL_CONNECTION_FAILED');
  }catch(error){const code=errorCode(error);for(const law of laws) if(law.identity.status==='unavailable') law.identity.code=code;return finish({code,...(code==='LEGAL_MCP_NOT_CONFIGURED'?{setup:legalSetupGuide(error?.reason||'invalid')}:{})});}
  const codeOf=error=>/^LEGAL_/.test(error?.code||'')?error.code:errorCode(error);
  const call=resilientCaller(async(name,args)=>{
    const left=deadline-Date.now();
    if(left<500) throw failure('LEGAL_TOTAL_TIMEOUT');
    const allowed=Math.min(timeoutMs,left);
    return bounded(signal=>client.callTool({name,arguments:args},undefined,{timeout:allowed,signal}),allowed);
  },{cache:cache!==undefined?cache:injectedClient?null:defaultCallCache,deadline:()=>deadline,...(sleep?{sleep}:{})});
  let articleBudget=maxArticles;
  for(const law of laws){
    if(law.identity.status==='not_checked') continue;
    const name=typeof law.request?.name==='string'?law.request.name.trim():'';
    if(!name||name.length>200||/[\r\n\0]/.test(name)){law.identity={status:'unavailable',code:'INVALID_LEGAL_REQUEST'};continue;}
    let current=null;
    try{
      // The provider ANDs the words of a query. A name read from unquoted text may
      // start with words that are not part of the law's name, so shorten it from the left.
      const words=name.split(/\s+/);
      const queries=law.request.suffixMatch?[...new Set([words.slice(-3).join(' '),words.slice(-2).join(' '),words.slice(-1)[0]])]:[name];
      let text='',listed=[],listedAt=null;
      for(const query of queries){
        const response=await call('search_law',{query,display:100});
        text=textOf(response);listedAt=fetchedAt(response);
        // The provider states "no such law" explicitly. An empty body, an error or a
        // maintenance page says nothing about whether the law exists.
        const noResult=/^\[NOT_FOUND\][^\r\n]*검색 결과가 없습니다/m.test(text);
        if(responseFailed(response)&&!noResult) throw failure('LEGAL_LOOKUP_FAILED');
        listed=noResult?[]:listedLaws(text);
        if(!noResult&&!listed.length) throw failure('LEGAL_LISTING_UNVERIFIED');
        if(listed.some(x=>normalize(name).endsWith(normalize(x.name)))) break;
      }
      current=listed.find(x=>normalize(x.name)===normalize(name));
      let renamed=null,corrected=null;
      if(!current&&law.request.suffixMatch){
        current=listed.filter(x=>normalize(name).endsWith(normalize(x.name))).sort((a,b)=>normalize(b.name).length-normalize(a.name).length)[0]||null;
        if(current) corrected=name;
      }
      if(!current){
        renamed=renameNotice(text,name);
        if(renamed) current=listed.find(x=>normalize(x.name)===normalize(renamed.to))||(renamed.mst?{name:renamed.to,lawId:renamed.lawId,mst:renamed.mst,promulgatedAt:null,effectiveAt:null,kind:null,url:`https://www.law.go.kr/법령/${encodeURIComponent(renamed.to)}`}:null);
      }
      if(!current){
        law.identity={status:'not_found',code:'LEGAL_EXACT_LAW_NOT_FOUND',similar:listed.slice(0,3).map(x=>x.name)};
        continue;
      }
      // A [현행] label or a rename notice alone does not prove an effective version.
      if(!compactDate(current.effectiveAt)||current.effectiveAt>todayCompact) throw failure('LEGAL_CURRENT_VERSION_UNVERIFIED');
      law.identity={status:renamed?'renamed':'current',name:current.name,lawId:current.lawId,mst:current.mst,kind:current.kind,
        promulgatedAt:isoOf(current.promulgatedAt),effectiveAt:isoOf(current.effectiveAt),url:current.url,retrievedAt:listedAt||new Date().toISOString(),
        ...(renamed?{renamedFrom:renamed.from}:{}),...(corrected?{matchedFromText:corrected}:{}),
        ...(current.effectiveAt&&current.effectiveAt>todayCompact?{notYetEffective:true}:{}),
        pendingAmendments:pendingAmendments(text,current.name)};
    }catch(error){law.identity={status:'unavailable',code:codeOf(error)};continue;}
    for(const article of law.articles){
      const selector=articleSelector(article.article);
      if(!selector){Object.assign(article,{status:'unavailable',code:'INVALID_LEGAL_REQUEST'});continue;}
      if(articleBudget<=0){article.code='ARTICLE_LIMIT';continue;}
      articleBudget--;
      try{
        const arguments_={mst:current.mst,efYd:current.effectiveAt,jo:selector};
        const response=await call('get_law_text',arguments_);
        const text=textOf(response);
        const header=/^법령명:\s*(.+)$/m.exec(text)?.[1];
        if(!header||normalize(header)!==normalize(current.name)) throw failure(header?'LEGAL_BODY_LAW_MISMATCH':'LEGAL_BODY_ERROR');
        const bodyEffective=compactDate(/^시행일:\s*(.+)$/m.exec(text)?.[1]);
        const versionProblem=bodyVersionProblem(text,current);
        Object.assign(article,{
          versionCheck:versionProblem?'unverified':'matches_listing',
          source:{provider:'Korean Law MCP',tool:'get_law_text',lawName:current.name,mst:current.mst,arguments:arguments_,
            bodyEffectiveAt:isoOf(bodyEffective),retrievedAt:fetchedAt(response),url:current.url},
        });
        // Even an explicit absence/deletion is only evidence for the verified version.
        if(versionProblem) throw failure(versionProblem);
        // "Missing" needs the law's own header plus the provider's explicit statement.
        if(/^\[NOT_FOUND\][^\r\n]*조문(?: 내용)?을 찾을 수 없습니다/m.test(text)){Object.assign(article,{status:'missing',code:'LEGAL_ARTICLE_MISSING'});continue;}
        if(responseFailed(response)||errorText(text)) throw failure('LEGAL_BODY_ERROR');
        const facts=articleFacts(text,selector);
        if(!facts) throw failure('LEGAL_ARTICLE_UNVERIFIED');
        const content=clipped(facts.body,maxTextChars);
        Object.assign(article,{status:facts.deleted?'deleted':'found',title:facts.title,amendedDates:facts.amendedDates,lastAmendedAt:facts.amendedDates.at(-1)||null,
          text:content.text,truncated:content.truncated});
      }catch(error){Object.assign(article,{status:'unavailable',code:codeOf(error)});}
    }
  }
  return finish();
}
async function closeLegalClient(){const pending=connection;connection=null;if(pending){try{const client=await pending.promise;await client.close();}catch{ /* Failed connections already clean up their transport. */ }}}
module.exports={setLegalCallCache,legalCallStats,resetLegalCallStats,callCacheKey,rateLimitOf,resilientCaller,CALL_CACHE_POLICY,queryLegalReferences,closeLegalClient,legalServerState,legalSetupGuide,exactCurrentLaw,inspectLaws,listedLaws,renameNotice,pendingAmendments,articleFacts,amendmentDates};

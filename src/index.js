#!/usr/bin/env node
/**
 * dongguk-rule-mcp v0.6.0
 * 동국대학교 통합규정관리시스템(rule.dongguk.edu) MCP 서버
 *
 * v0.6.0:
 *  - 모든 도구에 구조화 응답과 표준 오류코드 추가.
 *  - 제N조의N 및 부칙 조문 선택 지원.
 *  - 검색 원문 집계/중복 제거 건수를 구분해 표시.
 *  - compare_rule_versions 개정본 비교 도구 추가.
 *  - 실제 운영 파서를 테스트에서 직접 재사용하도록 모듈화.
 *
 * v0.5.1:
 *  - Notion AI의 자연어 query 입력을 지원하고 규정명·관련어를 자동 분리.
 *
 * v0.5.0:
 *  - lookup_dongguk_rule 통합 도구 추가: 규정 검색 → 최신 원문 HWP → 관련 조문·별표를 1회에 반환.
 *  - HWP 원문 표 파싱 추가. HTML 본문에 빠진 별표의 금액표도 조회 가능.
 *  - Notion AI가 같은 질문으로 도구를 반복 호출하지 않도록 도구 설명과 완료 신호 강화.
 *
 * v0.4.0:
 *  - HTTP 모드 추가 (--http): Streamable HTTP, stateless — Notion 커스텀 에이전트 등
 *    원격 MCP 클라이언트 연결용. Bearer 토큰 인증(--token) 선택 지원. /health 엔드포인트.
 *  - stdio 모드(기본)는 그대로 유지 — Claude Desktop 기존 사용자 영향 없음.
 *
 * v0.3.0 하드닝 유지:
 *  - 입력 검증, arguments 누락 방어, --version, deprecation 억제, 파싱 버그픽스
 */
process.noDeprecation = true;

// === 버전/CLI ===
let VERSION = '0.6.0';
try { VERSION = require('../package.json').version; } catch {}

const ARGV = process.argv.slice(2);
const argOf = f => { const i = ARGV.indexOf(f); return i >= 0 ? ARGV[i + 1] : undefined; };

if (ARGV.includes('--version') || ARGV.includes('-v')) { console.log(VERSION); process.exit(0); }
if (ARGV.includes('--help') || ARGV.includes('-h')) {
  console.log(`dongguk-rule-mcp v${VERSION} — 동국대 규정집 MCP 서버

사용법:
  dongguk-rule-mcp                 stdio 모드 (Claude Desktop 등, 기본)
  dongguk-rule-mcp --http          HTTP 모드 (Notion 커스텀 에이전트 등 원격 연결용)

HTTP 옵션:
  --port <n>    포트 (기본 3845, env: DONGGUK_MCP_PORT)
  --host <h>    바인드 주소 (기본 127.0.0.1, env: DONGGUK_MCP_HOST)
  --token <t>   Bearer 인증 토큰 (기본 없음, env: DONGGUK_MCP_TOKEN)

환경변수:
  DONGGUK_RULE_COOKIE   비공개 규정 열람용 쿠키
  DONGGUK_MCP_NO_CACHE  1이면 디스크 캐시 비활성화`);
  process.exit(0);
}

const MODE_HTTP = ARGV.includes('--http');
const HTTP_PORT = Number(argOf('--port') || process.env.DONGGUK_MCP_PORT || 3845);
const HTTP_HOST = argOf('--host') || process.env.DONGGUK_MCP_HOST || '127.0.0.1';
const AUTH_TOKEN = (argOf('--token') || process.env.DONGGUK_MCP_TOKEN || '').trim();

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { clampNumber, searchVariants, rankRuleHits, extractRelevantBlocks } = require('./lookup.js');
const {
  parseSearch,
  parseContent,
  parseHistory,
  searchResultMetrics,
  normalizeArticleSelector,
  extractArticleSections,
  extractChapter,
  grepArticleSections,
} = require('./parsers.js');
const { compareRuleMarkdown, formatVersionComparison } = require('./versioning.js');
const {
  success,
  failure,
  serializeOutcome,
  serializeException,
  TOOL_OUTPUT_SCHEMA,
} = require('./protocol.js');

// === 상수 (Python 원본에서 검증된 엔드포인트) ===
const BASE_URL = 'https://rule.dongguk.edu';
const SEARCH_URL = `${BASE_URL}/lmxsrv/search/lawSerach.srv`;    // POST 전용!
const FULLVIEW_URL = `${BASE_URL}/lmxsrv/law/lawFullView.srv`;
const CONTENT_URL = `${BASE_URL}/lmxsrv/law/lawFullContent.srv`; // GET
const FILE_URL = `${BASE_URL}/fileDown.srv`;                    // POST (원문 HWP)
const MAIN_URL = `${BASE_URL}/lmxsrv/main/main.srv`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const CAMPUS_MAP = { all: '0', seoul: '1', wise: '2' };
const TTL = { search: 3600, searchFull: 86400, history: 600, content: 30*86400 };
let lastReq = 0;

// === 입력 검증 유틸 ===
function toId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
function validStr(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// === 캐시 (Python cache.py 포팅) ===
function cacheDir() {
  const cookie=(process.env.DONGGUK_RULE_COOKIE||'').trim();
  const scope=cookie?`private-${crypto.createHash('sha256').update(cookie).digest('hex').slice(0,12)}`:'public';
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(),'.cache'), 'dongguk-rule-mcp', scope);
}
function noCache() {
  return ['1','true','yes'].includes((process.env.DONGGUK_MCP_NO_CACHE||'').trim().toLowerCase());
}
function hk(...p) { return crypto.createHash('md5').update(p.join('|')).digest('hex'); }
async function cached(cat, key, ttl, fn) {
  if (noCache()) return fn();
  const fp = path.join(cacheDir(), cat, `${key}.json`);
  try {
    if (fs.existsSync(fp) && (Date.now()-fs.statSync(fp).mtimeMs)/1000 < ttl)
      return JSON.parse(fs.readFileSync(fp,'utf-8'));
  } catch(e) {}
  const r = await fn();
  try {
    const d=path.join(cacheDir(),cat);
    fs.mkdirSync(d,{recursive:true,mode:0o700});
    fs.chmodSync(d,0o700);
    fs.writeFileSync(fp,JSON.stringify(r),{encoding:'utf-8',mode:0o600});
    fs.chmodSync(fp,0o600);
  } catch(e) {}
  return r;
}

// === HTTP ===
async function fetchResponse(url, opts={}) {
  const wait = 500-(Date.now()-lastReq);
  if (wait>0) await new Promise(r=>setTimeout(r,wait));
  lastReq = Date.now();
  const h = { 'User-Agent':UA, 'Accept-Language':'ko-KR,ko;q=0.9', Referer:MAIN_URL, ...opts.headers };
  const ck = (process.env.DONGGUK_RULE_COOKIE||'').trim();
  if (ck) h['Cookie'] = ck;
  const res = await fetch(url, { ...opts, headers:h, timeout:20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res;
}
async function fp(url, opts={}) {
  return (await fetchResponse(url, opts)).text();
}
async function fpBuffer(url, opts={}) {
  return Buffer.from(await (await fetchResponse(url, opts)).arrayBuffer());
}

// === 검색 (POST — Python 원본 그대로) ===
async function searchRules(q, {fullText=false, page=1, pageShow=10, lawgroup='0'}={}) {
  const body = new URLSearchParams({
    PAGE:String(page), PAGE_SHOW:String(pageShow), LAWGROUP:lawgroup,
    SEARCH_TYPE: fullText?'CONTENTS':'LAWNAME', SEARCH_TEXT:q,
  });
  const html = await fp(SEARCH_URL, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString(),
  });
  return parseSearch(html, page, pageShow);
}

// === 본문 (GET + CSS 클래스 기반 파싱) ===
async function getContent(lawId, hid) {
  const html = await fp(`${CONTENT_URL}?SEQ=${lawId}&SEQ_HISTORY=${hid}`);
  return parseContent(html);
}

// === 원문 HWP (HTML 본문에 없는 별표·표 포함) ===
let hwpToMarkdown;
async function parseOriginalHwp(buffer) {
  if (!hwpToMarkdown) {
    const mod = await import('@ssabrojs/hwpxjs');
    hwpToMarkdown = mod.hwpToMarkdown;
  }
  if (typeof hwpToMarkdown !== 'function') throw new Error('HWP 파서를 불러올 수 없습니다.');
  const markdown = await hwpToMarkdown(new Uint8Array(buffer));
  if (!validStr(markdown)) throw new Error('HWP 원문에서 텍스트를 추출할 수 없습니다.');
  return markdown.trim();
}
async function getOriginalContent(historyId) {
  const body = new URLSearchParams({ FILE_SEQ:String(historyId), FILE_TYPE:'ori' });
  const buffer = await fpBuffer(FILE_URL, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:body.toString(),
  });
  if (buffer.length < 512) throw new Error(`HISTORY_ID ${historyId}의 HWP 원문을 다운로드할 수 없습니다.`);
  return { markdown:await parseOriginalHwp(buffer) };
}

// === 연혁 (POST → select#histroySeq 파싱) ===
async function getHistory(lawId) {
  const body = new URLSearchParams({
    PAGE:'1', PAGE_SHOW:'10', LAWGROUP:'0',
    SEARCH_TYPE:'LAWNAME', SEARCH_TEXT:' ',
    SEQ:String(lawId), SEQ_HISTORY:'0', REFID:'',
  });
  const html = await fp(FULLVIEW_URL, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString(),
  });
  return parseHistory(html);
}
async function resolve(lawId, hid) {
  const h = toId(hid);
  if(h) return { historyId:h, revisedAt:'', note:null };
  const entries = await cached('history', String(lawId), TTL.history, ()=>getHistory(lawId));
  if(!entries.length) throw new Error(`LAW_ID ${lawId}의 연혁을 찾을 수 없습니다. law_id가 올바른지 확인하세요.`);
  const l=entries[0];
  return { historyId:l.historyId, revisedAt:l.revisedAt, note:`> 자동 해석: LAW_ID ${lawId} / HISTORY_ID ${l.historyId} (최신, ${l.revisedAt})` };
}

// === MCP 핸들러 ===
function cmap(c){ const v=(typeof c==='string'?c:'all').trim().toLowerCase(); return CAMPUS_MAP[v]||(/^\d+$/.test(v)?v:'0'); }

async function hSearch(kw, {fullText=false,limit=10,offset=0,campus='all'}={}) {
  const keyword = validStr(kw);
  if(!keyword) return failure('INVALID_ARGUMENT', '검색어(keyword)를 입력해주세요. 예: "보수규정", "퇴직금", "회계"');
  limit=Math.max(1,Math.min(Number(limit)||10,50)); offset=Math.max(0,Number(offset)||0);
  const lg=cmap(campus), ps=offset+limit;
  const ck=hk(keyword,fullText,1,ps,lg), ttl=fullText?TTL.searchFull:TTL.search;
  const r=await cached('search',ck,ttl,()=>searchRules(keyword,{fullText,page:1,pageShow:ps,lawgroup:lg}));
  const metrics=searchResultMetrics(r);
  const hits=r.hits.slice(offset,offset+limit);
  if(!hits.length){
    const message=`## 규정 검색: '${keyword}' — 결과 없음 (원문 집계 ${r.total}건)\n\n` +
      `다음을 시도해보세요:\n- 짧은 키워드로 (예: "보수규정" → "보수")\n` +
      `- full_text=true로 전문 검색\n- campus를 "all"로 (현재: ${campus||'all'})`;
    return failure('NOT_FOUND', `규정 '${keyword}' 검색 결과가 없습니다.`, {
      text:message,
      details:{keyword,fullText,campus,sourceTotal:r.total,offset,limit},
    });
  }
  let o=`## 규정 검색: '${keyword}' (${fullText?'제목+내용':'제목'})\n` +
    `- 원문 집계: ${r.total}건\n` +
    `- 현재 조회: ${metrics.rawRows}행 → 고유 ${metrics.uniqueRows}건` +
    (metrics.duplicatesRemoved?` (중복 ${metrics.duplicatesRemoved}건 제거)`:``) + `\n` +
    `- 표시: ${offset+1}~${offset+hits.length}\n\n`;
  o+='| 분류 | 제목 | 개정일 | LAW_ID | HISTORY_ID |\n|------|------|--------|--------|------------|\n';
  hits.forEach(h=>{ o+=`| ${h.code} | ${h.title} | ${h.revisedAt} | ${h.lawId} | ${h.historyId} |\n`; });
  if(offset+limit<r.total) o+=`\n다음: offset=${offset+limit}`;
  o+='\n\n💡 get_rule_content로 본문 조회 가능';
  return success(o,{
    query:{keyword,fullText,campus,limit,offset},
    counts:{sourceTotal:r.total,...metrics,returned:hits.length},
    rules:hits,
    nextOffset:offset+limit<r.total?offset+limit:null,
    source:{name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:new Date().toISOString()},
  });
}

async function hContent(rawLawId, hid, {article,chapter,grep,head}={}) {
  const lawId = toId(rawLawId);
  if(!lawId) return failure('INVALID_ARGUMENT', 'law_id는 양의 정수여야 합니다. search_rule 결과의 LAW_ID를 사용하세요. (예: law_id=491)');
  const hasArticle=article!==undefined && article!==null && article!=='';
  const articleSelector=hasArticle?normalizeArticleSelector(article):null;
  if(hasArticle && !articleSelector) return failure('INVALID_ARGUMENT', 'article은 48, "제48조", "제10조의2", "부칙 제2조" 형식이어야 합니다.');
  const chp = toId(chapter);
  if(chapter!==undefined && chapter!==null && !chp) return failure('INVALID_ARGUMENT', 'chapter는 양의 정수여야 합니다. (예: chapter=5 → 제5장)');
  const resolved=await resolve(lawId,hid);
  const {historyId:rid, note}=resolved;
  const c=await cached('content',`${lawId}_${rid}`,TTL.content,()=>getContent(lawId,rid));
  if(!c.markdown) return failure('CONTENT_UNAVAILABLE', `본문을 가져올 수 없습니다 (LAW_ID ${lawId}). law_id/history_id를 확인하세요.`);
  let r=c.markdown;
  let selectedArticles=[];
  if(articleSelector){
    const extracted=extractArticleSections(r,article);
    if(!extracted.text) return failure('NOT_FOUND', `${articleSelector.canonical}를 찾을 수 없습니다. get_rule_toc로 목차를 먼저 확인해보세요.`, {
      details:{lawId,historyId:rid,article:articleSelector.canonical},
    });
    selectedArticles=extracted.sections.map(section=>({
      article:section.canonical,supplementary:section.supplementary,content:section.content,
    }));
    r=extracted.text;
  }
  if(chp){
    const chapterText=extractChapter(r,chp);
    if(!chapterText) return failure('NOT_FOUND', `제${chp}장을 찾을 수 없습니다. get_rule_toc로 목차를 먼저 확인해보세요.`, {
      details:{lawId,historyId:rid,chapter:chp},
    });
    r=chapterText;
  }
  const g = validStr(grep);
  if(g){
    const matches=grepArticleSections(r,g);
    selectedArticles=matches.map(section=>({
      article:section.canonical,supplementary:section.supplementary,content:section.content,
    }));
    r=matches.length?`## '${g}' 포함 조문 (${matches.length}건)\n\n${matches.map(x=>x.content).join('\n\n')}`:`'${g}'을(를) 포함한 조문이 없습니다.`;
  }
  const hd = toId(head);
  if(hd){const ls=r.split('\n');if(ls.length>hd)r=ls.slice(0,hd).join('\n')+`\n\n...(전체 ${ls.length}줄 중 상위 ${hd}줄)`;}
  const text=note?`${note}\n\n${r}`:r;
  return success(text,{
    lawId,historyId:rid,revisedAt:resolved.revisedAt||'',title:c.title||'',
    filters:{article:articleSelector?.canonical||null,chapter:chp||null,grep:g||null,head:hd||null},
    articles:selectedArticles,
    contentMarkdown:r,
    source:{url:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${rid}`,returnedAt:new Date().toISOString()},
  });
}

async function hToc(rawLawId,hid){
  const lawId = toId(rawLawId);
  if(!lawId) return failure('INVALID_ARGUMENT', 'law_id는 양의 정수여야 합니다. (예: law_id=491)');
  const resolved=await resolve(lawId,hid);
  const {historyId:rid,note}=resolved;
  const c=await cached('content',`${lawId}_${rid}`,TTL.content,()=>getContent(lawId,rid));
  if(!c.markdown) return failure('CONTENT_UNAVAILABLE', `본문을 가져올 수 없습니다 (LAW_ID ${lawId}).`);
  const toc=c.markdown.split('\n').filter(l=>/^#{1,3} /.test(l)).join('\n');
  const text=note?`${note}\n\n${toc||'장·조 헤더가 없습니다.'}`:(toc||'장·조 헤더가 없습니다.');
  return success(text,{
    lawId,historyId:rid,revisedAt:resolved.revisedAt||'',title:c.title||'',
    headings:toc?toc.split('\n'):[],
    source:{url:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${rid}`,returnedAt:new Date().toISOString()},
  });
}

async function hHistory(rawLawId){
  const lawId = toId(rawLawId);
  if(!lawId) return failure('INVALID_ARGUMENT', 'law_id는 양의 정수여야 합니다. search_rule 결과의 LAW_ID를 사용하세요.');
  const e=await getHistory(lawId);
  if(!e.length) return failure('NOT_FOUND', `LAW_ID ${lawId}의 연혁이 없습니다. law_id를 확인하세요.`, {details:{lawId}});
  let o=`## LAW_ID ${lawId} 연혁 (${e.length}건)\n\n| HISTORY_ID | 개정일 |\n|------------|--------|\n`;
  e.forEach(x=>{o+=`| ${x.historyId} | ${x.revisedAt} |\n`;});
  return success(o,{
    lawId,history:e,
    source:{url:`${FULLVIEW_URL}?SEQ=${lawId}`,returnedAt:new Date().toISOString()},
  });
}

async function hDeep(rawQuery,{top=3,perDoc}={}){
  const query = validStr(rawQuery);
  if(!query) return failure('INVALID_ARGUMENT', '검색어(query)를 입력해주세요. 예: "겸직", "위임전결"');
  top=Math.max(1,Math.min(Number(top)||3,10));
  const pd = toId(perDoc);
  const ps=top*5, ck=hk(query,true,1,ps,'0');
  const r=await cached('search',ck,TTL.searchFull,()=>searchRules(query,{fullText:true,page:1,pageShow:ps}));
  const metrics=searchResultMetrics(r);
  if(!r.hits.length) return failure('NOT_FOUND', `'${query}' 전문 검색 결과가 없습니다. 더 일반적인 키워드로 시도해보세요.`, {details:{query}});
  const hits=r.hits.slice(0,top);
  const documents=[];
  let o=`# '${query}' 깊이 검색\n- 원문 집계 ${r.total}건, 고유 후보 ${metrics.uniqueRows}건, 상위 ${hits.length}개 grep\n\n`;
  for(let i=0;i<hits.length;i++){
    const h=hits[i];
    o+=`## [${i+1}] ${h.title} (LAW_ID ${h.lawId})\n`;
    try{
      const c=await cached('content',`${h.lawId}_${h.historyId}`,TTL.content,()=>getContent(h.lawId,h.historyId));
      if(!c.markdown){
        o+='- 본문 조회 실패\n\n';
        documents.push({...h,error:{code:'CONTENT_UNAVAILABLE',message:'본문 조회 실패'}});
        continue;
      }
      let matches=grepArticleSections(c.markdown,query);
      const count=matches.length;
      if(pd&&count>pd)matches=matches.slice(0,pd);
      o+=count?`- 매칭 ${count}건\n\n${matches.map(x=>x.content).join('\n\n')}\n\n`:`- 매칭 조문 없음 (제목/메타 매칭)\n\n`;
      documents.push({...h,matchCount:count,articles:matches.map(x=>({article:x.canonical,supplementary:x.supplementary,content:x.content}))});
    }catch(e){
      o+=`- 오류: ${e.message}\n\n`;
      documents.push({...h,error:{code:'DOCUMENT_FETCH_FAILED',message:e.message}});
    }
  }
  return success(o,{
    query,counts:{sourceTotal:r.total,uniqueCandidates:metrics.uniqueRows,duplicatesRemoved:metrics.duplicatesRemoved,returned:hits.length},documents,
    source:{name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:new Date().toISOString()},
  });
}

async function hLookup(rawKeyword, {
  terms='',
  campus='all',
  maxRules=1,
  maxSections=4,
  maxChars=12000,
  includeHistory=false,
}={}) {
  const keyword = validStr(rawKeyword);
  if(!keyword) return failure('INVALID_ARGUMENT', '규정명 또는 질문(rule_keyword 또는 query)을 입력해주세요. 예: "여비규정", "대전 출장 여비규정의 일비와 숙박비"');
  maxRules=clampNumber(maxRules,1,1,3);
  maxSections=clampNumber(maxSections,4,1,12);
  maxChars=clampNumber(maxChars,12000,1000,30000);
  const lg=cmap(campus), pageShow=Math.max(10,maxRules*5);

  const variants=searchVariants(keyword);
  let searchMode='제목', queryUsed=keyword, result=null;
  for(const fullText of [false,true]){
    searchMode=fullText?'전문':'제목';
    for(const variant of variants){
      const ck=hk(variant,fullText,1,pageShow,lg);
      const candidate=await cached('search',ck,fullText?TTL.searchFull:TTL.search,()=>searchRules(variant,{
        fullText,page:1,pageShow,lawgroup:lg,
      }));
      if(candidate.hits.length){result=candidate;queryUsed=variant;break;}
    }
    if(result) break;
  }
  if(!result){
    const text=`## 통합 규정 조회: '${keyword}' — 결과 없음\n\n` +
      `시도한 검색어: ${variants.join(', ')}\n\n더 짧은 규정명으로 다시 시도하세요. 예: "여비규정" → "여비".`;
    return failure('NOT_FOUND', `규정 '${keyword}'을 찾지 못했습니다.`, {
      text,details:{keyword,variants,campus},
    });
  }

  const hits=rankRuleHits(result.hits,keyword).slice(0,maxRules);
  const metrics=searchResultMetrics(result);
  const rawTerms=Array.isArray(terms)?terms.join(', '):String(terms || '');
  const domesticPlace=/서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주/;
  const effectiveTerms=domesticPlace.test(rawTerms) && !/국내|국외/.test(rawTerms)
    ? `${rawTerms}, 국내`
    : rawTerms;
  let out=`# 통합 규정 조회: '${keyword}'\n\n` +
    `> 조회 완료: 아래 결과에는 최신 개정 메타데이터와 원문 HWP의 관련 조문·별표가 포함되어 있습니다. ` +
    `동일 질문으로 search_rule, get_rule_content, search_rule_deep을 다시 호출하지 마세요.\n\n` +
    `- 검색 방식: ${searchMode}\n` +
    (queryUsed!==keyword?`- 정규화 검색어: ${queryUsed}\n`:``) +
    `- 원문 집계 / 고유 후보: ${result.total}건 / ${metrics.uniqueRows}건\n` +
    `- 선택 규정: ${hits.length}건\n`;

  const rules=[];

  for(let i=0;i<hits.length;i++){
    const hit=hits[i];
    const lawId=hit.lawId;
    const historyId=hit.historyId || (await resolve(lawId)).historyId;
    let markdown, sourceType='원문 HWP(별표 포함)', warning='', warningData=null;
    try{
      const original=await cached('original',`${lawId}_${historyId}`,TTL.content,
        ()=>getOriginalContent(historyId));
      markdown=original.markdown;
    }catch(e){
      const html=await cached('content',`${lawId}_${historyId}`,TTL.content,
        ()=>getContent(lawId,historyId));
      markdown=html.markdown;
      sourceType='HTML 본문';
      warning=`\n- 주의: HWP 원문 파싱 실패로 HTML 본문을 사용했습니다. 별표가 누락될 수 있습니다. (${e.message})`;
      warningData={code:'HWP_FALLBACK',message:e.message};
    }

    const excerpt=extractRelevantBlocks(markdown,effectiveTerms,{
      maxBlocks:maxSections,maxChars,
    });
    let historyText='';
    let history=[];
    if(includeHistory){
      history=await cached('history',String(lawId),TTL.history,()=>getHistory(lawId));
      history=history.slice(0,5);
      historyText=history.map(x=>`${x.revisedAt || '날짜 미상'} (HISTORY_ID ${x.historyId})`).join(', ');
    }
    const sourceUrl=`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${historyId}`;
    out+=`\n\n## [${i+1}] ${hit.title}\n` +
      `- 분류: ${hit.code || '미상'}\n` +
      `- 최신 개정일: ${hit.revisedAt || '확인 필요'}\n` +
      `- LAW_ID / HISTORY_ID: ${lawId} / ${historyId}\n` +
      `- 원문 유형: ${sourceType}\n` +
      `- 원문: ${sourceUrl}` +
      (historyText?`\n- 최근 연혁: ${historyText}`:'') +
      warning;

    if(validStr(terms)){
      out+=excerpt.text
        ? `\n\n### 관련 조문·별표\n\n${excerpt.text}`
        : `\n\n### 관련 조문·별표\n\n'${terms}'과 직접 일치하는 부분을 찾지 못했습니다. ` +
          `terms에는 핵심 명사만 입력해 다시 조회하세요.`;
    }else{
      out+=`\n\n### 원문 앞부분\n\n${excerpt.text}`;
    }
    rules.push({
      ...hit,lawId,historyId,sourceType,sourceUrl,history,
      warning:warningData,
      excerpt:{text:excerpt.text,matchedTerms:excerpt.matchedTerms,blockCount:excerpt.blockCount,truncated:excerpt.truncated},
    });
  }
  return success(out,{
    query:{keyword,queryUsed,variants,terms:rawTerms,effectiveTerms,campus,maxRules,maxSections,maxChars,includeHistory},
    search:{mode:searchMode,sourceTotal:result.total,...metrics},
    rules,
    source:{name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:new Date().toISOString()},
  });
}

async function hCompareVersions(rawLawId, rawFromHistoryId, rawToHistoryId, {article,maxChanges=20}={}) {
  const lawId=toId(rawLawId);
  const fromHistoryId=toId(rawFromHistoryId);
  if(!lawId) return failure('INVALID_ARGUMENT', 'law_id는 양의 정수여야 합니다.');
  if(!fromHistoryId) return failure('INVALID_ARGUMENT', 'from_history_id는 비교 시작 개정본의 양의 정수 HISTORY_ID여야 합니다.');
  const hasArticle=article!==undefined && article!==null && article!=='';
  if(hasArticle && !normalizeArticleSelector(article)) {
    return failure('INVALID_ARGUMENT', 'article은 48, "제48조", "제10조의2", "부칙 제2조" 형식이어야 합니다.');
  }
  const history=await cached('history',String(lawId),TTL.history,()=>getHistory(lawId));
  const toHistoryId=rawToHistoryId?toId(rawToHistoryId):history[0]?.historyId;
  if(!toHistoryId) return failure('INVALID_ARGUMENT', 'to_history_id는 양의 정수여야 하며, 생략 시 최신 연혁을 조회할 수 있어야 합니다.');
  const fromEntry=history.find(x=>x.historyId===fromHistoryId);
  const toEntry=history.find(x=>x.historyId===toHistoryId);
  const [before,after]=await Promise.all([
    cached('content',`${lawId}_${fromHistoryId}`,TTL.content,()=>getContent(lawId,fromHistoryId)),
    cached('content',`${lawId}_${toHistoryId}`,TTL.content,()=>getContent(lawId,toHistoryId)),
  ]);
  if(!before.markdown || !after.markdown) {
    return failure('CONTENT_UNAVAILABLE', '비교할 개정본 중 하나의 본문을 가져올 수 없습니다.', {
      details:{lawId,fromHistoryId,toHistoryId},
    });
  }
  const comparison=compareRuleMarkdown(before.markdown,after.markdown,{article});
  if(comparison.error) return failure(comparison.error, '조문 선택자를 해석할 수 없습니다.');
  maxChanges=clampNumber(maxChanges,20,1,50);
  const title=after.title||before.title||`LAW_ID ${lawId}`;
  const text=formatVersionComparison(comparison,{
    title:`${title} (${fromHistoryId} → ${toHistoryId})`,fromHistoryId,toHistoryId,maxChanges,
  });
  return success(text,{
    lawId,title,fromHistoryId,toHistoryId,
    fromRevisedAt:fromEntry?.revisedAt||'',toRevisedAt:toEntry?.revisedAt||'',
    article:comparison.article,counts:comparison.counts,changes:comparison.changes,
    source:{
      fromUrl:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${fromHistoryId}`,
      toUrl:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${toHistoryId}`,
      returnedAt:new Date().toISOString(),
    },
  });
}

function normalizeLookupArguments(args={}) {
  const query=validStr(args.query) || '';
  const explicitKeyword=validStr(args.rule_keyword) || '';
  const ruleName=query.match(/([가-힣A-Za-z0-9·]+규정)/)?.[1] || '';
  return {
    keyword:explicitKeyword || ruleName || query,
    terms:validStr(args.terms) || (!explicitKeyword ? query : ''),
  };
}

// === MCP 서버 팩토리 (stdio: 1회 / HTTP: 요청당 1회 — stateless) ===
function createServer() {
const server = new Server({ name:'dongguk-rule-mcp', version:VERSION }, { capabilities:{tools:{}} });

server.setRequestHandler(ListToolsRequestSchema, async ()=>({ tools:[
  { name:'lookup_dongguk_rule', description:'동국대학교 규정 질문의 기본·우선 도구. 자연어 query 또는 짧은 rule_keyword를 받아 규정 검색→최신 원문 HWP→관련 조문·별표(금액표 포함)를 한 번에 반환합니다. 보통 이 도구 1회로 답하고, 결과에 조회 완료가 표시되면 같은 질문으로 다른 규정 도구를 추가 호출하지 마세요.',
    inputSchema:{ type:'object', properties:{
      query:{type:'string',description:'전체 자연어 질문. 예: 대전 출장 여비규정의 최신 개정일, 철도운임, 일비, 숙박비를 알려줘'},
      rule_keyword:{type:'string',description:'선택 입력. 규정명 또는 짧은 검색어. query가 있으면 생략 가능. 예: 여비규정, 보수, 위임전결'},
      terms:{type:'string',description:'찾을 핵심 명사. 쉼표로 구분. query에 핵심 명사가 있으면 생략 가능. 예: 국내, 철도운임, 숙박비, 일비'},
      campus:{type:'string',description:'all/seoul/wise',default:'all'},
      max_rules:{type:'number',description:'조회할 규정 수. 기본 1, 최대 3',default:1},
      max_sections:{type:'number',description:'규정별 관련 블록 수. 기본 4, 최대 12',default:4},
      max_chars:{type:'number',description:'규정별 최대 반환 글자 수. 기본 12000, 최대 30000',default:12000},
      include_history:{type:'boolean',description:'최근 개정 연혁 5건 포함 여부',default:false},
    }},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'search_rule', description:'규정 후보 목록만 필요할 때 사용하는 보조 도구. 일반적인 동국대학교 규정 질문은 lookup_dongguk_rule을 먼저 사용하세요.',
    inputSchema:{ type:'object', properties:{
      keyword:{type:'string',description:'검색어'},
      full_text:{type:'boolean',description:'전문검색 여부',default:false},
      limit:{type:'number',default:10}, offset:{type:'number',default:0},
      campus:{type:'string',description:'all/seoul/wise',default:'all'},
    }, required:['keyword']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'get_rule_content', description:'LAW_ID를 이미 알고 특정 조·장만 볼 때 사용하는 보조 도구. 별표·금액표가 필요하면 lookup_dongguk_rule을 사용하세요.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
      history_id:{type:'number',description:'HISTORY_ID (생략=최신)'},
      article:{oneOf:[{type:'number'},{type:'string'}],description:'특정 조문. 예: 48, 제48조, 제10조의2, 부칙 제2조'},
      chapter:{type:'number',description:'특정 장만'},
      grep:{type:'string',description:'키워드 포함 조문'},
      head:{type:'number',description:'상위 N줄'},
    }, required:['law_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'get_rule_toc', description:'규정 목차(장·절·조) 빠른 조회.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number'}, history_id:{type:'number'},
    }, required:['law_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'list_rule_history', description:'규정 개정 연혁 목록 조회.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
    }, required:['law_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'compare_rule_versions', description:'같은 규정의 두 HISTORY_ID를 조문 단위로 비교합니다. to_history_id를 생략하면 최신 개정본과 비교합니다.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
      from_history_id:{type:'number',description:'비교 시작 HISTORY_ID'},
      to_history_id:{type:'number',description:'비교 종료 HISTORY_ID. 생략하면 최신'},
      article:{oneOf:[{type:'number'},{type:'string'}],description:'선택 조문. 예: 제10조의2, 부칙 제2조'},
      max_changes:{type:'number',description:'본문에 표시할 최대 변경 조문 수. 기본 20, 최대 50',default:20},
    }, required:['law_id','from_history_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'search_rule_deep', description:'여러 규정의 전문을 탐색해야 할 때만 사용하는 보조 도구. 단일 규정 질문에는 lookup_dongguk_rule을 사용하세요.',
    inputSchema:{ type:'object', properties:{
      query:{type:'string'}, top:{type:'number',default:3}, per_doc:{type:'number'},
    }, required:['query']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
]}));

server.setRequestHandler(CallToolRequestSchema, async (req)=>{
  const name = req.params.name;
  const a = req.params.arguments || {};   // [하드닝] arguments 누락 방어
  try{
    let r;
    switch(name){
      case 'lookup_dongguk_rule': {
        const normalized=normalizeLookupArguments(a);
        r=await hLookup(normalized.keyword,{
          terms:normalized.terms,campus:a.campus,maxRules:a.max_rules,maxSections:a.max_sections,
          maxChars:a.max_chars,includeHistory:a.include_history,
        });
        break;
      }
      case 'search_rule': r=await hSearch(a.keyword,{fullText:a.full_text,limit:a.limit,offset:a.offset,campus:a.campus}); break;
      case 'get_rule_content': r=await hContent(a.law_id,a.history_id,{article:a.article,chapter:a.chapter,grep:a.grep,head:a.head}); break;
      case 'get_rule_toc': r=await hToc(a.law_id,a.history_id); break;
      case 'list_rule_history': r=await hHistory(a.law_id); break;
      case 'compare_rule_versions': r=await hCompareVersions(a.law_id,a.from_history_id,a.to_history_id,{article:a.article,maxChanges:a.max_changes}); break;
      case 'search_rule_deep': r=await hDeep(a.query,{top:a.top,perDoc:a.per_doc}); break;
      default: r=failure('UNKNOWN_TOOL', `알 수 없는 도구: ${name}`, {isError:true});
    }
    return serializeOutcome(name,r);
  }catch(e){
    return serializeException(name,e);
  }
});

return server;
}

// === HTTP 모드 (Streamable HTTP, stateless) ===
function startHttp() {
  const http = require('http');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });

  const json = (res, code, obj, extra = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };

  const httpServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');

    // 상태 확인 (무인증)
    if (u.pathname === '/health') {
      return json(res, 200, { status: 'ok', name: 'dongguk-rule-mcp', version: VERSION, transport: 'streamable-http' });
    }
    if (u.pathname !== '/mcp') {
      return json(res, 404, { error: 'not found — MCP endpoint: POST /mcp, health: GET /health' });
    }

    // Bearer 인증 (토큰 설정 시)
    if (AUTH_TOKEN && (req.headers['authorization'] || '') !== `Bearer ${AUTH_TOKEN}`) {
      return json(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: Bearer 토큰이 필요합니다' }, id: null });
    }

    // stateless: POST만 지원 (GET SSE 스트림/DELETE 세션 없음)
    if (req.method !== 'POST') {
      return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed — stateless HTTP는 POST만 지원' }, id: null }, { 'Allow': 'POST' });
    }

    let body;
    try { body = JSON.parse((await readBody(req)) || 'null'); }
    catch (e) {
      return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: 유효한 JSON이 아닙니다' }, id: null });
    }

    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error('HTTP 처리 오류:', e.message);
      if (!res.headersSent) {
        json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    console.error(`dongguk-rule-mcp v${VERSION} HTTP 모드 시작 — http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
    console.error(AUTH_TOKEN ? '인증: Bearer 토큰 필수' : '⚠️ 인증 없음 — 공개 URL로 노출 시 --token 사용 권장');
  });
  httpServer.on('error', e => { console.error('HTTP 서버 오류:', e.message); process.exit(1); });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// === 기동 ===
if (MODE_HTTP) {
  startHttp();
} else {
  (async () => {
    const s = createServer();
    await s.connect(new StdioServerTransport());
    console.error(`dongguk-rule-mcp v${VERSION} 시작됨 (stdio, Node ${process.version})`);
  })().catch(e => { console.error('서버 시작 실패:', e.message); process.exit(1); });
}

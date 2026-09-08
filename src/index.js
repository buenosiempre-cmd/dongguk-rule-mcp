#!/usr/bin/env node
/**
 * dongguk-rule-mcp
 * 동국대학교 통합규정관리시스템(rule.dongguk.edu) MCP 서버
 *
 * v0.7.0:
 *  - verify_rule_citations 추가: 기안문·공문 텍스트의 규정 인용을 실존·조문 제목·항 번호까지
 *    대조하는 환각 게이트. 낫표·가운뎃점 5종·"같은 규정" 조응(문단 경계 리셋) 처리,
 *    검색 0건은 ✗가 아닌 ⚠로 보고(검증 미가동 ≠ 통과).
 *  - applicable_rule 추가: 기준일에 시행 중이던(개정일 기준) 개정본을 자동 특정해 본문과
 *    현행 대비 변경 요약을 반환. 소급 업무·감사 대응용. 개정일≠시행일 한계를 항상 명시.
 *  - 별칭 사전 추가: 내장 별칭 + DONGGUK_RULE_ALIASES(JSON)로 확장, 검색어 변형에
 *    가운뎃점 표기(·ㆍ‧•・) 흡수. lookup/search 계열 전체에 적용.
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
let VERSION = '0.7.0';
try { VERSION = require('../package.json').version; } catch {}

const ARGV = process.argv.slice(2);
function validHost(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return false;
  if (require('node:net').isIP(value)) return true;
  if (/^[\d.]+$/.test(value)) return false;
  return value.length <= 253 && value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}
function validPort(value) { return /^\d+$/.test(String(value)) && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535; }
function parseCliArguments(argv) {
  const valued = new Set(['--profile','--port','--host','--token','--token-file','--print-config']);
  const flags = new Set(['--http','--doctor','--json','--live','--help','-h','--version','-v']);
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (flags.has(name)) continue;
    if (!valued.has(name)) throw new Error('알 수 없는 옵션이 있습니다. --help로 사용법을 확인하세요.');
    const value = argv[++i];
    // Never interpret another option as a credential, or fall back to an
    // environment credential after an explicitly missing/empty CLI value.
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error(`${name}에는 비어 있지 않은 값이 필요합니다. 다음 옵션을 값으로 사용할 수 없습니다.`);
    if (values.has(name)) throw new Error(`${name}은 한 번만 지정하세요.`);
    if (name === '--profile' && !['rules','finance'].includes(value)) throw new Error('--profile은 rules 또는 finance여야 합니다.');
    if (name === '--host' && !validHost(value)) throw new Error('--host는 IP 주소 또는 유효한 호스트 이름이어야 합니다. URL·포트·경로를 포함하지 마세요.');
    if (name === '--port' && !validPort(value)) throw new Error('--port는 1~65535 범위의 정수여야 합니다.');
    values.set(name, value);
  }
  return values;
}
let CLI_ARGUMENTS = new Map();
if (require.main === module) {
  try { CLI_ARGUMENTS = parseCliArguments(ARGV); }
  catch (error) { console.error('서버 시작 실패:', error.message); process.exit(1); }
}
const argOf = f => CLI_ARGUMENTS.get(f);

if (require.main === module && (ARGV.includes('--version') || ARGV.includes('-v'))) { console.log(VERSION); process.exit(0); }
if (require.main === module && (ARGV.includes('--help') || ARGV.includes('-h'))) {
  console.log(`dongguk-rule-mcp v${VERSION} — 동국대 규정집 MCP 서버

사용법:
  dongguk-rule-mcp                 stdio 모드 (Claude Desktop 등, 기본)
  dongguk-rule-mcp --http          HTTP 모드 (공용 서버)
  dongguk-rule-mcp --doctor --json 설치 자체 점검 (--live: 실제 원문 조회 추가)
  dongguk-rule-mcp --print-config codex  설치 경로에 맞는 설정 출력 (claude/cursor 지원)
  --profile rules|finance         기본 rules, 내부 재무 기능은 finance 선택

HTTP 옵션:
  --port <n>    포트 (기본 3845, env: DONGGUK_MCP_PORT)
  --host <h>    바인드 주소 (기본 127.0.0.1, env: DONGGUK_MCP_HOST)
  --token <t>   기존 운영자 Bearer 토큰 (env: DONGGUK_MCP_TOKEN 권장)
  --token-file <path> 구성원별 SHA-256 토큰 등록부 (env: DONGGUK_MCP_TOKEN_FILE)

환경변수:
  DONGGUK_RULE_COOKIE   비공개 규정 열람용 쿠키
  DONGGUK_MCP_NO_CACHE  1이면 디스크 캐시 비활성화`);
  process.exit(0);
}

const MODE_HTTP = ARGV.includes('--http');
const {normalizeProfile,withProfile,requestCookie,normalizeCampus,campusScope}=require('./runtime-context.js');
const PROFILE=argOf('--profile') || process.env.DONGGUK_MCP_PROFILE || 'rules';
const HTTP_PORT = Number(argOf('--port') || process.env.DONGGUK_MCP_PORT || 3845);
const HTTP_HOST = argOf('--host') || process.env.DONGGUK_MCP_HOST || '127.0.0.1';
const AUTH_TOKEN = (argOf('--token') || process.env.DONGGUK_MCP_TOKEN || '').trim();

const { loadFinancePack, routeFinance, getFinanceContext, hasSensitiveInput } = require('./finance.js');
const { queryLegalReferences } = require('./legal-client.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { clampNumber, searchVariants, rankRuleHits, selectRuleCandidate, extractRelevantBlocks } = require('./lookup.js');
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
const { verifyRuleCitations } = require('./citations.js');
const { TIMELINE_CAVEAT, parseDateLoose, resolveHistoryAtDate, extractEnforcementDates } = require('./timeline.js');
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
// LAWGROUP is document type, not campus (official screen verified 2026-09-08).
const TTL = { search: 3600, searchFull: 86400, history: 600, content: 30*86400 };
let lastReq = 0;

// === 입력 검증 유틸 ===
function toId(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\d+$/.test(v.trim()))) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function validStr(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// === 캐시 (Python cache.py 포팅) ===
function cacheDir() {
  const cookie=requestCookie();
  const scope=cookie?`private-${crypto.createHash('sha256').update(cookie).digest('hex').slice(0,12)}`:'public';
  // Parser fixes must not reuse older search titles or incomplete parsed bodies.
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(),'.cache'), 'dongguk-rule-mcp', 'v2', scope);
}
function noCache() {
  return ['1','true','yes'].includes((process.env.DONGGUK_MCP_NO_CACHE||'').trim().toLowerCase());
}
function hk(...p) { return crypto.createHash('md5').update(p.join('|')).digest('hex'); }
const inflightCache = new Map();
async function cached(cat, key, ttl, fn) {
  if (noCache()) return fn();
  const keyPath = path.join(cacheDir(), cat, `${key}.json`);
  if (inflightCache.has(keyPath)) return inflightCache.get(keyPath);
  const pending = loadCached(cat, key, ttl, fn);
  inflightCache.set(keyPath, pending);
  try { return await pending; } finally { inflightCache.delete(keyPath); }
}
async function loadCached(cat, key, ttl, fn) {
  if (noCache()) return fn();
  const fp = path.join(cacheDir(), cat, `${key}.json`);
  try {
    if (fs.existsSync(fp) && (Date.now()-fs.statSync(fp).mtimeMs)/1000 < ttl)
      return JSON.parse(fs.readFileSync(fp,'utf-8'));
  } catch(e) {}
  const r = await fn();
  try {
    const d=path.join(cacheDir(),cat);
    fs.mkdirSync(cacheDir(),{recursive:true,mode:0o700});
    fs.chmodSync(cacheDir(),0o700);
    fs.mkdirSync(d,{recursive:true,mode:0o700});
    fs.chmodSync(d,0o700);
    const temp = `${fp}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp,JSON.stringify(r),{encoding:'utf-8',mode:0o600});
      fs.renameSync(temp,fp);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  } catch(e) {}
  return r;
}

// === HTTP ===
async function fetchResponse(url, opts={}) {
  const now = Date.now();
  const wait = Math.max(0,lastReq+500-now);
  lastReq = now+wait; // Reserve before awaiting so concurrent callers get distinct slots.
  if (wait>0) await new Promise(r=>setTimeout(r,wait));
  const h = { 'User-Agent':UA, 'Accept-Language':'ko-KR,ko;q=0.9', Referer:MAIN_URL, ...opts.headers };
  const ck = requestCookie();
  if (ck) h['Cookie'] = ck;
  const res = await fetch(url, { ...opts, headers:h, timeout:20000, size:25*1024*1024, redirect:'error' });
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
  const entries = await cached('history', String(lawId), TTL.history, ()=>getHistory(lawId));
  if(!entries.length) throw new Error(`LAW_ID ${lawId}의 연혁을 찾을 수 없습니다. law_id가 올바른지 확인하세요.`);
  const l=h?entries.find(entry=>entry.historyId===h):entries[0];
  if(!l) throw Object.assign(new Error(`HISTORY_ID ${h}는 LAW_ID ${lawId}의 연혁에 없습니다.`),{code:'HISTORY_NOT_FOUND'});
  if(h) return {historyId:h,revisedAt:l.revisedAt,note:null};
  return { historyId:l.historyId, revisedAt:l.revisedAt, note:`> 자동 해석: LAW_ID ${lawId} / HISTORY_ID ${l.historyId} (최신, ${l.revisedAt})` };
}

// === MCP 핸들러 ===
function cmap(){ return '0'; }

async function hSearch(kw, {fullText=false,limit=10,offset=0,campus='all'}={}) {
  const keyword = validStr(kw);
  if(!keyword) return failure('INVALID_ARGUMENT', '검색어(keyword)를 입력해주세요. 예: "보수규정", "퇴직금", "회계"');
  limit=clampNumber(limit,10,1,50); offset=clampNumber(offset,0,0,500);
  if(!Number.isInteger(Number(offset))) return failure('INVALID_ARGUMENT','offset은 정수여야 합니다.');
  const lg=cmap(campus), ps=offset+limit;
  const ck=hk(keyword,fullText,1,ps,lg), ttl=fullText?TTL.searchFull:TTL.search;
  const r=await cached('search',ck,ttl,()=>searchRules(keyword,{fullText,page:1,pageShow:ps,lawgroup:lg}));
  const metrics=searchResultMetrics(r);
  const hits=r.hits.slice(offset,offset+limit);
  if(!hits.length){
    const message=`## 규정 검색: '${keyword}' — 결과 없음 (원문 집계 ${r.total}건)\n\n` +
      `다음을 시도해보세요:\n- 짧은 키워드로 (예: "보수규정" → "보수")\n` +
      `- full_text=true로 전문 검색\n- 공식 목록 전체를 검색했으며 캠퍼스는 필터로 사용하지 않습니다.`;
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
    if(extracted.error) return failure(extracted.error,'여러 부칙에 같은 조문 번호가 있습니다. 원문에서 부칙 제목과 개정일을 선택하세요.',{details:{candidates:extracted.sections.map(x=>({article:x.canonical,supplementaryHeading:x.supplementaryHeading}))}});
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
      const selected=await resolve(h.lawId);
      const currentHit={...h,historyId:selected.historyId,revisedAt:selected.revisedAt};
      const c=await cached('content',`${h.lawId}_${selected.historyId}`,TTL.content,()=>getContent(h.lawId,selected.historyId));
      if(!c.markdown){
        o+='- 본문 조회 실패\n\n';
        documents.push({...currentHit,error:{code:'CONTENT_UNAVAILABLE',message:'본문 조회 실패'}});
        continue;
      }
      let matches=grepArticleSections(c.markdown,query);
      const count=matches.length;
      if(pd&&count>pd)matches=matches.slice(0,pd);
      o+=count?`- 매칭 ${count}건\n\n${matches.map(x=>x.content).join('\n\n')}\n\n`:`- 매칭 조문 없음 (제목/메타 매칭)\n\n`;
      o+=`- 조회 개정일: ${selected.revisedAt} / HISTORY_ID ${selected.historyId}\n\n`;
      documents.push({...currentHit,matchCount:count,articles:matches.map(x=>({article:x.canonical,supplementary:x.supplementary,content:x.content}))});
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
  asOf=null,
  explicitLawId=null,
}={}) {
  const keyword = validStr(rawKeyword) || (explicitLawId ? `LAW_ID ${explicitLawId}` : null);
  if(!keyword) return failure('INVALID_ARGUMENT', '규정명 또는 질문(rule_keyword 또는 query)을 입력해주세요. 예: "여비규정", "대전 출장 여비규정의 일비와 숙박비"');
  maxRules=clampNumber(maxRules,1,1,3);
  maxSections=clampNumber(maxSections,4,1,12);
  maxChars=clampNumber(maxChars,12000,1000,30000);
  const lg=cmap(campus), pageShow=Math.max(10,maxRules*5);

  const variants=searchVariants(keyword);
  let searchMode='제목', queryUsed=keyword, result=null;
  if(explicitLawId){
    const latest=await resolve(explicitLawId);
    const content=await cached('content',`${explicitLawId}_${latest.historyId}`,TTL.content,()=>getContent(explicitLawId,latest.historyId));
    result={total:1,hits:[{lawId:explicitLawId,historyId:latest.historyId,title:content.title||keyword,revisedAt:latest.revisedAt}]};
    searchMode='LAW_ID';
  }
  const candidateHits=new Map();
  for(const fullText of (result?[]:[false,true])){
    for(const variant of variants){
      const ck=hk(variant,fullText,1,pageShow,lg);
      const candidate=await cached('search',ck,fullText?TTL.searchFull:TTL.search,()=>searchRules(variant,{fullText,page:1,pageShow,lawgroup:lg}));
      for(const hit of candidate.hits) candidateHits.set(hit.lawId,hit);
      if(candidate.hits.length){
        if(!result){result=candidate;queryUsed=variant;searchMode=fullText?'전문':'제목';}
        const identity=selectRuleCandidate(candidate.hits,keyword);
        if(identity.matchType==='exact'){
          result=candidate;queryUsed=variant;searchMode=fullText?'전문':'제목';
        }
      }
    }
    // Search every title spelling/alias before asserting a unique identity.
    // Full-text fallback is needed only when title searches found no candidates.
    if(result)break;
  }
  if(candidateHits.size){
    const collected=[...candidateHits.values()];
    const identity=selectRuleCandidate(collected,keyword);
    result={...result,hits:identity.matchType==='exact'?identity.candidates:collected};
  }
  if(!result){
    const text=`## 통합 규정 조회: '${keyword}' — 결과 없음\n\n` +
      `시도한 검색어: ${variants.join(', ')}\n\n더 짧은 규정명으로 다시 시도하세요. 예: "여비규정" → "여비".`;
    return failure('NOT_FOUND', `규정 '${keyword}'을 찾지 못했습니다.`, {
      text,details:{keyword,variants,campus},
    });
  }

  const selection=selectRuleCandidate(result.hits,keyword);
  const candidates=selection.candidates;
  if(!explicitLawId && maxRules===1 && selection.status!=='unique') return failure('AMBIGUOUS_RULE','여러 규정 후보가 있습니다. 제목과 적용범위를 확인한 뒤 law_id로 선택하세요.',{details:{candidates:candidates.map(x=>({lawId:x.lawId,title:x.title,revisedAt:x.revisedAt})),campus:campusScope(campus)}});
  const hits=(selection.status==='unique'?[selection.hit]:rankRuleHits(result.hits,keyword)).slice(0,maxRules);
  const identityStatus=explicitLawId?'explicit_id':selection.status==='unique'?'exact_title':'candidate_preview';
  const metrics=searchResultMetrics(result);
  const rawTerms=Array.isArray(terms)?terms.join(', '):String(terms || '');
  const effectiveTerms=rawTerms; // Campus names are not travel destinations.
  let out=`# 통합 규정 조회: '${keyword}'\n\n` +
    `> ${asOf ? `기준일 ${asOf}의 개정일 기준 후보를 조회했습니다. 시행일·경과조치를 확인하세요.` : '연혁의 최신 개정본을 조회했습니다(연혁 캐시 최대 10분).'} 원문 유형과 누락 경고를 확인하세요.\n\n` +
    `- 검색 방식: ${searchMode}\n` +
    (queryUsed!==keyword?`- 정규화 검색어: ${queryUsed}\n`:``) +
    `- 원문 집계 / 고유 후보: ${result.total}건 / ${metrics.uniqueRows}건\n` +
    `- 선택 규정: ${hits.length}건\n`;
  if(identityStatus==='candidate_preview') out+='\n> 여러 후보의 미리보기입니다. 적용할 규정이 확정된 결과가 아닙니다. 제목과 적용범위를 확인하고 law_id로 다시 조회하세요.\n';

  const rules=[];

  for(let i=0;i<hits.length;i++){
    const hit=hits[i];
    const lawId=hit.lawId;
    const latest=await resolve(lawId);
    let selected=latest;
    if(asOf){
      const history=await cached('history',String(lawId),TTL.history,()=>getHistory(lawId));
      const candidate=resolveHistoryAtDate(history,asOf);
      if(candidate.error) return failure(candidate.error,'기준일의 개정본 후보를 확인할 수 없습니다.');
      selected=candidate.entry;
    }
    const {historyId,revisedAt}=selected;
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

    if(!validStr(markdown)) return failure('CONTENT_UNAVAILABLE', 'HWP 원문과 HTML 대체 본문에서 규정 내용을 확인할 수 없습니다.', {
      details:{lawId,historyId,sourceType,warning:warningData},
    });
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
      `- 조회 개정일: ${revisedAt || '확인 필요'}\n` +
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
      ...hit,lawId,historyId,revisedAt,sourceType,sourceUrl,history,
      latestHistoryId:latest.historyId,selectionBasis:asOf?'revision_date':'latest_revision',targetDate:asOf,
      applicability:'requires_enforcement_review',
      enforcementDates:extractEnforcementDates(markdown).map(x=>x.iso),
      warning:warningData,
      excerpt:{text:excerpt.text,matchedTerms:excerpt.matchedTerms,blockCount:excerpt.blockCount,truncated:excerpt.truncated},
    });
  }
  return success(out,{
    query:{keyword,queryUsed,variants,terms:rawTerms,effectiveTerms,campus,maxRules,maxSections,maxChars,includeHistory},
    search:{mode:searchMode,sourceTotal:result.total,...metrics,identityStatus},
    rules,
    source:{name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:new Date().toISOString()},
  });
}

async function hCompareVersions(rawLawId, rawFromHistoryId, rawToHistoryId, {article,maxChanges=20,includeAppendices=true}={}) {
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
  if(!fromEntry || !toEntry) return failure('HISTORY_NOT_FOUND', '비교할 HISTORY_ID가 해당 규정의 연혁에 없습니다.', {
    details:{lawId,fromHistoryId,toHistoryId},
  });
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
  if(comparison.error) return failure(comparison.error, comparison.error === 'NOT_FOUND'
    ? '선택한 조문이 두 개정본 모두에 없습니다.'
    : '비교할 조문을 추출할 수 없습니다. 원문과 목차를 확인하세요.');
  maxChanges=clampNumber(maxChanges,20,1,50);
  const title=after.title||before.title||`LAW_ID ${lawId}`;
  let text='> 조문 비교 범위: HTML 본문입니다. HWP 별표 비교 결과는 별도로 표시하며, 첨부파일·시행일 판단은 포함하지 않습니다.\n\n'+formatVersionComparison(comparison,{
    title:`${title} (${fromHistoryId} → ${toHistoryId})`,fromHistoryId,toHistoryId,maxChanges,
  });
  let appendixComparison={status:'not_requested',scope:'hwp_appendix_text'};
  if(includeAppendices){
    try{
      const [left,right]=await Promise.all([
        cached('original',`${lawId}_${fromHistoryId}`,TTL.content,()=>getOriginalContent(fromHistoryId)),
        cached('original',`${lawId}_${toHistoryId}`,TTL.content,()=>getOriginalContent(toHistoryId)),
      ]);
      appendixComparison=require('./appendices.js').compareAppendices(left.markdown,right.markdown,{maxChanges});
      text+=`\n\n## HWP 별표·서식 텍스트 비교\n상태: ${appendixComparison.status}\n${appendixComparison.caveat}\n`;
      for(const change of appendixComparison.changes) text+=`\n### ${change.appendix}: ${change.type}\n이전:\n${change.before}\n\n이후:\n${change.after}\n`;
    }catch{appendixComparison={status:'unavailable',scope:'hwp_appendix_text',code:'HWP_COMPARISON_UNAVAILABLE'};text+='\n\n> HWP 별표 비교를 완료하지 못했습니다. HTML 조문 결과만으로 별표가 동일하다고 판단하지 마세요.';}
  }
  return success(text,{
    lawId,title,fromHistoryId,toHistoryId,
    appendixComparison,evidenceStatus:includeAppendices&&appendixComparison.status!=='compared'?'partial':'retrieved',
    fromRevisedAt:fromEntry?.revisedAt||'',toRevisedAt:toEntry?.revisedAt||'',
    article:comparison.article,counts:comparison.counts,changes:comparison.changes.slice(0,maxChanges),changesTruncated:comparison.changes.length>maxChanges,
    comparisonScope:'html_articles',
    source:{
      fromUrl:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${fromHistoryId}`,
      toUrl:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${toHistoryId}`,
      returnedAt:new Date().toISOString(),
    },
  });
}

async function hVerifyCitations(rawText,{campus='all'}={}) {
  const text=validStr(rawText);
  if(!text) return failure('INVALID_ARGUMENT', '검증할 텍스트(text)를 입력해주세요. 예: 기안문·품의서 본문 전체');
  if(text.length>20000) return failure('INVALID_ARGUMENT', 'text는 20,000자 이하여야 합니다. 문단 단위로 나눠 호출하세요.');
  const lg=cmap(campus);
  const deps={
    searchRule: async q=>{
      const ck=hk(q,false,1,10,lg);
      return cached('search',ck,TTL.search,()=>searchRules(q,{fullText:false,page:1,pageShow:10,lawgroup:lg}));
    },
    getRuleMarkdown: async(lawId,historyId)=>{
      const c=await cached('content',`${lawId}_${historyId}`,TTL.content,()=>getContent(lawId,historyId));
      return c.markdown||'';
    },
    resolveLatest: async lawId=>await resolve(lawId),
  };
  const r=await verifyRuleCitations(text,deps,{maxCitations:40,maxRules:8});
  if(!r.citations.length && !r.floating.length){
    return failure('NOT_FOUND', '텍스트에서 규정 인용을 찾지 못했습니다. 「규정명」 제N조 형식이 포함되어 있는지 확인하세요.', {
      details:{textLength:text.length},
    });
  }
  return success(r.text,{
    summary:r.summary,citations:r.citations,floating:r.floating,rules:r.rules,truncated:r.truncated,
    basis:'각 규정의 최신 개정본 기준',
    source:{name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:new Date().toISOString()},
  });
}

async function hApplicableRule({law_id,rule_keyword,date,article,compare_with_current=true,max_changes=10}={}) {
  const target=parseDateLoose(date);
  if(!target) return failure('INVALID_ARGUMENT', 'date는 기준일이며 YYYY-MM-DD, YYYY.MM.DD, YYYYMMDD 형식이어야 합니다. 예: 2024-03-15');
  const hasArticle=article!==undefined && article!==null && article!=='';
  if(hasArticle && !normalizeArticleSelector(article)){
    return failure('INVALID_ARGUMENT', 'article은 48, "제48조", "제10조의2", "부칙 제2조" 형식이어야 합니다.');
  }
  max_changes=clampNumber(max_changes,10,1,30);

  // 규정 특정: law_id 우선, 없으면 규정명 검색
  let lawId=toId(law_id), matched=null;
  if(!lawId){
    const keyword=validStr(rule_keyword);
    if(!keyword) return failure('INVALID_ARGUMENT', 'law_id 또는 rule_keyword 중 하나는 필요합니다. 예: rule_keyword="여비규정"');
    const candidates=new Map();
    for(const variant of searchVariants(keyword)){
      const ck=hk(variant,false,1,10,'0');
      const r=await cached('search',ck,TTL.search,()=>searchRules(variant,{fullText:false,page:1,pageShow:10}));
      for(const hit of r.hits)candidates.set(hit.lawId,hit);
    }
    const selection=selectRuleCandidate([...candidates.values()],keyword);
    if(selection.status==='unique')matched=selection.hit;
    if(!matched&&candidates.size)return failure('AMBIGUOUS_RULE','정확한 규정명이 확인되지 않았습니다. 제목과 적용범위를 확인하고 law_id로 선택하세요.',{details:{candidates:[...candidates.values()]}});
    if(!matched) return failure('NOT_FOUND', `규정 '${rule_keyword}'을 찾지 못했습니다. 더 짧은 규정명으로 시도하세요.`, {details:{rule_keyword}});
    lawId=matched.lawId;
  }

  const history=await cached('history',String(lawId),TTL.history,()=>getHistory(lawId));
  if(!history.length) return failure('NOT_FOUND', `LAW_ID ${lawId}의 연혁을 찾을 수 없습니다.`, {details:{lawId}});
  const res=resolveHistoryAtDate(history,date);
  if(res.error==='NO_DATED_HISTORY'){
    return failure('CONTENT_UNAVAILABLE', '연혁에 개정일 정보가 없어 시점 판단을 할 수 없습니다.', {details:{lawId,undatedCount:res.undatedCount}});
  }
  if(res.error==='BEFORE_FIRST'){
    return failure('NOT_FOUND', `기준일 ${res.targetIso}는 연혁상 최초 개정일(${res.earliest.revisedAt}) 이전입니다. 그 이전 개정본은 시스템에 없습니다.`, {
      details:{lawId,targetDate:res.targetIso,earliest:res.earliest},
    });
  }

  if(res.error) return failure(res.error,'같은 날짜의 복수 개정본 등으로 기준일 후보를 확정할 수 없습니다.',{details:res});
  const picked=res.entry;
  const c=await cached('content',`${lawId}_${picked.historyId}`,TTL.content,()=>getContent(lawId,picked.historyId));
  if(!c.markdown) return failure('CONTENT_UNAVAILABLE', `적용 개정본 본문을 가져올 수 없습니다 (LAW_ID ${lawId} / HISTORY_ID ${picked.historyId}).`);
  const title=c.title||matched?.title||`LAW_ID ${lawId}`;

  let bodyText=c.markdown, selectedArticles=[];
  if(hasArticle){
    const extracted=extractArticleSections(c.markdown,article);
    if(extracted.error) return failure(extracted.error,'여러 부칙에 같은 조문 번호가 있습니다. 원문에서 부칙 제목과 개정일을 선택하세요.',{details:{candidates:extracted.sections.map(x=>({article:x.canonical,supplementaryHeading:x.supplementaryHeading}))}});
    if(!extracted.text) return failure('NOT_FOUND', `${extracted.selector.canonical}를 기준일 적용본에서 찾을 수 없습니다. get_rule_toc로 목차를 확인하세요.`, {
      details:{lawId,historyId:picked.historyId,article:extracted.selector.canonical},
    });
    selectedArticles=extracted.sections.map(x=>({article:x.canonical,supplementary:x.supplementary,content:x.content}));
    bodyText=extracted.text;
  }

  // 부칙 명시 시행일 추출(전체 본문 기준) — 개정일≠시행일 위험을 근거와 함께 표시
  const enforcement=extractEnforcementDates(c.markdown);
  const latestEnf=enforcement.length?enforcement[enforcement.length-1]:null;
  const enfAfterTarget=!!(latestEnf && latestEnf.ts>target.ts);

  const rangeText=res.next?`${picked.revisedAt} ~ ${res.next.revisedAt} 개정 전`:`${picked.revisedAt} ~ 현행`;
  let out=`# 기준일 규정 후보: ${title} — 기준일 ${res.targetIso}\n\n`+
    `- 개정일 기준 후보: HISTORY_ID ${picked.historyId} (개정 ${picked.revisedAt})\n`+
    `- 적용 구간(개정일 기준): ${rangeText}\n`+
    `- 현행 여부: ${res.isLatest?'기준일 적용본이 곧 현행':`이후 ${res.laterCount}회 개정됨 (현행 HISTORY_ID ${res.latest.historyId}, ${res.latest.revisedAt})`}\n`+
    (enforcement.length?`- 부칙에서 확인된 명시 시행일: ${enforcement.length>3?'… ':''}${enforcement.slice(-3).map(x=>x.iso).join(', ')}\n`:``)+
    (enfAfterTarget?`- ⚠ 이 개정본 부칙의 최신 시행일(${latestEnf.iso})이 기준일 이후입니다 — `+
      `직전 개정본${res.previous?`(HISTORY_ID ${res.previous.historyId}, 개정 ${res.previous.revisedAt})`:''} 적용 가능성을 함께 확인하세요.\n`:``)+
    (res.undatedCount?`- 참고: 개정일 미상 연혁 ${res.undatedCount}건은 판단에서 제외\n`:``)+
    `\n${TIMELINE_CAVEAT}\n\n## 기준일 적용 본문${hasArticle?` — ${selectedArticles.map(x=>x.article).join(', ')}`:''}\n\n${bodyText}`;

  let comparison=null;
  if(compare_with_current && !res.isLatest){
    const latest=await cached('content',`${lawId}_${res.latest.historyId}`,TTL.content,()=>getContent(lawId,res.latest.historyId));
    if(latest.markdown){
      comparison=compareRuleMarkdown(c.markdown,latest.markdown,hasArticle?{article}:{});
      if(!comparison.error){
        out+=`\n\n${formatVersionComparison(comparison,{
          title:`현행 대비 변경 (${picked.historyId} → ${res.latest.historyId})`,
          fromHistoryId:picked.historyId,toHistoryId:res.latest.historyId,maxChanges:max_changes,
        })}`;
      }
    }
  }

  return success(out,{
    lawId,title,targetDate:res.targetIso,
    applied:{historyId:picked.historyId,revisedAt:picked.revisedAt},
    previous:res.previous?{historyId:res.previous.historyId,revisedAt:res.previous.revisedAt}:null,
    next:res.next?{historyId:res.next.historyId,revisedAt:res.next.revisedAt}:null,
    latest:{historyId:res.latest.historyId,revisedAt:res.latest.revisedAt},
    isLatest:res.isLatest,laterCount:res.laterCount,undatedCount:res.undatedCount,
    enforcement:{dates:enforcement.map(x=>x.iso),latest:latestEnf?latestEnf.iso:null,afterTarget:enfAfterTarget},
    basis:'개정일',applicability:'requires_enforcement_review',caveat:TIMELINE_CAVEAT,
    filters:{article:hasArticle?normalizeArticleSelector(article).canonical:null},
    articles:selectedArticles,
    comparison:comparison&&!comparison.error?{counts:comparison.counts,changes:comparison.changes.slice(0,max_changes)}:null,
    source:{url:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${picked.historyId}`,returnedAt:new Date().toISOString()},
  });
}

async function hFinanceEvidence(args){
  const pack=loadFinancePack();
  if(!pack) return failure('FINANCE_PACK_NOT_CONFIGURED','재무지식 팩을 연결하세요.');
  const context=routeFinance(pack,args.query,args.facts||{},args.workflow_id);
  if(context.error) return failure(context.error,context.message);
  if(context.missing_facts.length || !context.base_date || !context.campus) {
    return success(`# ${context.workflow.title} 근거 조회에 필요한 사실\n\n`+
      context.missing_facts.map(x=>`- ${x.label}`).join('\n')+
      '\n\n기준일·캠퍼스와 필수 조건을 확인한 뒤 근거를 조회하세요.', {
      context,rules:[],legal:{status:'not_requested',results:[]},freshness:[],
      evidence_status:'needs_input',applicability:'not_determined',
    });
  }
  const rules=[];
  for(const request of context.rule_requests.slice(0,2)){
    try{rules.push(serializeOutcome('lookup_dongguk_rule',await hLookup(request.keyword,{terms:request.terms,maxChars:7000,asOf:context.base_date,campus:context.campus})));}
    catch(error){rules.push(serializeException('lookup_dongguk_rule',error));}
  }
  let legal={status:'not_required',results:[]};
  if(context.legal_requests.length){
    try{legal=await queryLegalReferences(context.legal_requests);}
    catch(error){legal={status:'unavailable',code:error.message==='LEGAL_MCP_NOT_CONFIGURED'?'LEGAL_MCP_NOT_CONFIGURED':'LEGAL_LOOKUP_FAILED',results:[]};}
  }
  const freshness=rules.flatMap((x,i)=>(x.structuredContent.data?.rules||[]).map(r=>({
    law_id:r.lawId,baseline_history_id:context.rule_requests[i]?.baseline_history_id||null,
    latest_history_id:r.latestHistoryId,selected_history_id:r.historyId,
    status:context.rule_requests[i]?.baseline_history_id ? (context.rule_requests[i].baseline_history_id===r.latestHistoryId?'unchanged':'revision_changed'):'baseline_missing',
    meaning:'개정본 식별자 비교입니다. 해당 업무 조항의 실질 변경을 의미하지 않습니다.'
  })));
  const partial=rules.some(x=>!x.structuredContent.ok||(x.structuredContent.data?.rules||[]).some(r=>r.warning||r.excerpt.truncated||!r.excerpt.matchedTerms.length))||legal.status==='unavailable'||legal.status==='partial';
  return success(`# ${context.workflow.title} 근거 확인\n\n조회상태: ${partial?'일부 확인 필요':'조회됨'}\n\n${context.notice}\n\n${rules.map(r=>r.content[0].text).join('\n\n')}`,{
    context,rules,legal,freshness,legal_date_scope:'검색 시점 현행 후보. 기준일 적용 조문은 별도 확인.',evidence_status:partial?'partial':'retrieved',applicability:'requires_review',retrieved_at:new Date().toISOString(),
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
function createServer({profile=PROFILE}={}) {
profile=normalizeProfile(profile);
const server = new Server({ name:'dongguk-rule-mcp', version:VERSION }, { capabilities:{tools:{}} });

server.setRequestHandler(ListToolsRequestSchema, async ()=>({ tools:[
  {name:'get_service_info',description:'동국 규정 MCP 버전·공통/내부 기능 범위·캠퍼스 검색 한계·입력 안내를 확인합니다.',inputSchema:{type:'object',properties:{}},outputSchema:TOOL_OUTPUT_SCHEMA,annotations:{readOnlyHint:true}},
  {name:'get_finance_context',description:'재무팀 출장·강사료·소득정정 질문을 판단카드·필수 사실·법령/규정 조회 경로·처리절차·완료증빙으로 연결합니다. 실제 신고·지급은 수행하지 않습니다.',inputSchema:{type:'object',properties:{query:{type:'string'},facts:{type:'object'},workflow_id:{type:'string'}},required:['query']},annotations:{readOnlyHint:true},outputSchema:TOOL_OUTPUT_SCHEMA},
  {name:'get_finance_evidence',description:'재무지식 팩이 지정한 교내 규정과 국가 법령 식별자를 실조회해 사전검토용 근거 묶음을 반환합니다. 각 출처의 조회 성공과 적용 판단은 구분합니다.',inputSchema:{type:'object',properties:{query:{type:'string'},facts:{type:'object'},workflow_id:{type:'string'}},required:['query']},annotations:{readOnlyHint:true},outputSchema:TOOL_OUTPUT_SCHEMA},
  { name:'lookup_dongguk_rule', description:'동국대학교 규정 질문의 기본·우선 도구. 자연어 query 또는 짧은 rule_keyword를 받아 규정 검색→최신 원문 HWP→관련 조문·별표(금액표 포함)를 한 번에 반환합니다. 근거가 충분하면 중복 조회를 생략하세요. partial·모호한 후보·적용범위 미확인 시 추가 확인이 필요합니다.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'선택 LAW_ID. 모호한 후보를 선택한 후 직접 원문·별표 조회'},
      query:{type:'string',description:'전체 자연어 질문. 예: 대전 출장 여비규정의 최신 개정일, 철도운임, 일비, 숙박비를 알려줘'},
      rule_keyword:{type:'string',description:'선택 입력. 규정명 또는 짧은 검색어. query가 있으면 생략 가능. 예: 여비규정, 보수, 위임전결'},
      terms:{type:'string',description:'찾을 핵심 명사. 쉼표로 구분. query에 핵심 명사가 있으면 생략 가능. 예: 국내, 철도운임, 숙박비, 일비'},
      campus:{type:'string',description:'업무 캠퍼스 맥락 all/seoul/wise. 공식 목록에는 캠퍼스 필터가 없어 전체 검색 후 적용범위를 확인합니다.',default:'all'},
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
      campus:{type:'string',description:'업무 캠퍼스 맥락 all/seoul/wise. 공식 목록에는 캠퍼스 필터가 없어 전체 검색 후 적용범위를 확인합니다.',default:'all'},
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
      include_appendices:{type:'boolean',description:'HWP 별표·서식 텍스트도 비교(기본 true)',default:true},
      to_history_id:{type:'number',description:'비교 종료 HISTORY_ID. 생략하면 최신'},
      article:{oneOf:[{type:'number'},{type:'string'}],description:'선택 조문. 예: 제10조의2, 부칙 제2조'},
      max_changes:{type:'number',description:'본문에 표시할 최대 변경 조문 수. 기본 20, 최대 50',default:20},
    }, required:['law_id','from_history_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'verify_rule_citations', description:'기안문·품의서·공문·AI 답변 텍스트에 인용된 동국대학교 규정 조문을 실제 규정집과 대조 검증하는 환각 게이트. 「규정명」 제N조(제목) 제N항 표기를 추출해 규정 실존, 조문 실존(본칙 존재 범위 안내), 조문 제목 일치, 항 번호까지 확인합니다. 결재 전 인용 점검에 사용하세요. 규정 내용 질문에는 lookup_dongguk_rule을 사용하세요.',
    inputSchema:{ type:'object', properties:{
      text:{type:'string',description:'검증할 전체 텍스트 (20,000자 이하). 예: 품의서 본문'},
      campus:{type:'string',description:'업무 캠퍼스 맥락 all/seoul/wise. 공식 목록에는 캠퍼스 필터가 없어 전체 검색 후 적용범위를 확인합니다.',default:'all'},
    }, required:['text']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'applicable_rule', description:'기준일(date) 이전에 개정된 동국대학교 규정 후보를 찾아, 해당 시점 본문과 현행 대비 변경 요약을 반환합니다. 소급 업무·감사 대응·과거 지급기준 확인용. HISTORY_ID를 몰라도 날짜만으로 조회됩니다. 개정일과 실제 시행일이 다를 수 있음을 항상 안내합니다. 최신 규정 질문에는 lookup_dongguk_rule을 사용하세요.',
    inputSchema:{ type:'object', properties:{
      date:{type:'string',description:'기준일. YYYY-MM-DD / YYYY.MM.DD / YYYYMMDD. 예: 2024-03-15'},
      rule_keyword:{type:'string',description:'규정명. law_id가 있으면 생략 가능. 예: 여비규정'},
      law_id:{type:'number',description:'LAW_ID. rule_keyword 대신 사용 가능'},
      article:{oneOf:[{type:'number'},{type:'string'}],description:'특정 조문만. 예: 15, 제10조의2, 부칙 제2조'},
      compare_with_current:{type:'boolean',description:'현행 대비 변경 요약 포함 여부',default:true},
      max_changes:{type:'number',description:'변경 요약 최대 조문 수. 기본 10, 최대 30',default:10},
    }, required:['date']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'search_rule_deep', description:'여러 규정의 전문을 탐색해야 할 때만 사용하는 보조 도구. 단일 규정 질문에는 lookup_dongguk_rule을 사용하세요.',
    inputSchema:{ type:'object', properties:{
      query:{type:'string'}, top:{type:'number',default:3}, per_doc:{type:'number'},
    }, required:['query']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
].filter(t=>profile==='finance'||!t.name.startsWith('get_finance_'))}));

server.setRequestHandler(CallToolRequestSchema, async (req)=>withProfile(profile,async()=>{
  const name = req.params.name;
  const a = req.params.arguments || {};   // [하드닝] arguments 누락 방어
  try{
    if(['query','keyword','rule_keyword','terms','text','grep'].some(key=>typeof a[key]==='string'&&hasSensitiveInput(a[key]))) return serializeOutcome(name,failure('SENSITIVE_INPUT','개인번호·계좌·인증정보를 제거한 업무 질문만 입력하세요.'));
    for(const [key,min,max] of [['limit',1,50],['offset',0,500],['top',1,10],['per_doc',1,100],['head',1,10000]]){if(a[key]!==undefined&&(!Number.isInteger(a[key])||a[key]<min||a[key]>max))return serializeOutcome(name,failure('INVALID_ARGUMENT',`${key}는 ${min}~${max} 범위 정수여야 합니다.`));}
    if(a.include_appendices!==undefined&&typeof a.include_appendices!=='boolean')return serializeOutcome(name,failure('INVALID_ARGUMENT','include_appendices는 boolean이어야 합니다.'));
    if(profile!=='finance' && name.startsWith('get_finance_')) return serializeOutcome(name,failure('TOOL_NOT_AVAILABLE','공통 규정 프로필에서는 내부 재무 기능을 제공하지 않습니다.'));
    for(const [key,value] of Object.entries(a)) {
      if(typeof value==='string' && value.length>(key==='text'?20000:2000)) return serializeOutcome(name,failure('INVALID_ARGUMENT',`${key} 입력이 너무 깁니다.`));
    }
    if(a.campus!==undefined && !normalizeCampus(a.campus)) return serializeOutcome(name,failure('INVALID_ARGUMENT','campus는 all, seoul, wise 중 하나여야 합니다.'));
    if(a.campus!==undefined) a.campus=normalizeCampus(a.campus);
    for (const key of ['law_id','history_id','from_history_id','to_history_id']) {
      if (a[key] !== undefined && !toId(a[key])) {
        return serializeOutcome(name,failure('INVALID_ARGUMENT', `${key}는 양의 정수여야 합니다(최대 9007199254740991).`));
      }
    }
    let r;
    switch(name){
      case 'get_service_info': r=success(`동국 규정 MCP v${VERSION} · ${profile}\n\n${campusScope().notice}`,{version:VERSION,profile,toolCount:profile==='rules'?10:12,readOnly:true,source:'https://rule.dongguk.edu',campus:campusScope(),privacy:{privateKnowledge:profile==='finance',authenticatedUpstream:profile==='finance'&&!!requestCookie()},limits:{historyCacheSeconds:600,contentScope:'공식 규정 원문. 별표 비교는 추출 텍스트 범위.'},usage:['질문에 기준일·캠퍼스·직군을 포함하세요.','규정명·LAW_ID·HISTORY_ID·조문 또는 별표·조회일을 함께 인용하세요.','개인번호·계좌·인증정보를 입력하지 마세요.']}); break;
      case 'get_finance_context': r=getFinanceContext(a.query,a.facts,a.workflow_id); break;
      case 'get_finance_evidence': r=await hFinanceEvidence(a); break;
      case 'lookup_dongguk_rule': {
        const normalized=normalizeLookupArguments(a);
        r=await hLookup(normalized.keyword,{
          terms:normalized.terms,campus:a.campus,maxRules:a.max_rules,maxSections:a.max_sections,
          maxChars:a.max_chars,includeHistory:a.include_history,explicitLawId:a.law_id,
        });
        break;
      }
      case 'search_rule': r=await hSearch(a.keyword,{fullText:a.full_text,limit:a.limit,offset:a.offset,campus:a.campus}); break;
      case 'get_rule_content': r=await hContent(a.law_id,a.history_id,{article:a.article,chapter:a.chapter,grep:a.grep,head:a.head}); break;
      case 'get_rule_toc': r=await hToc(a.law_id,a.history_id); break;
      case 'list_rule_history': r=await hHistory(a.law_id); break;
      case 'compare_rule_versions': r=await hCompareVersions(a.law_id,a.from_history_id,a.to_history_id,{article:a.article,maxChanges:a.max_changes,includeAppendices:a.include_appendices}); break;
      case 'verify_rule_citations': r=await hVerifyCitations(a.text,{campus:a.campus}); break;
      case 'applicable_rule': r=await hApplicableRule(a); break;
      case 'search_rule_deep': r=await hDeep(a.query,{top:a.top,perDoc:a.per_doc}); break;
      default: r=failure('UNKNOWN_TOOL', `알 수 없는 도구: ${name}`, {isError:true});
    }
    const response=serializeOutcome(name,r);
    if(a.campus && a.campus!=='all'){
      if(response.structuredContent.ok) response.structuredContent.data.campusScope=campusScope(a.campus);
      response.content[0].text=`> ${campusScope(a.campus).notice}\n\n`+response.content[0].text;
    }
    return response;
  }catch(e){
    return serializeException(name,e);
  }
}));

return server;
}

// === HTTP 모드 (Streamable HTTP, stateless) ===
function startHttp() {
  normalizeProfile(PROFILE);
  if (!validHost(HTTP_HOST)) throw new Error('HTTP host는 IP 주소 또는 유효한 호스트 이름이어야 합니다.');
  if (!validPort(argOf('--port') || process.env.DONGGUK_MCP_PORT || '3845')) throw new Error('HTTP port는 1~65535 범위의 정수여야 합니다.');
  const {createHttpServer}=require('./http-server.js');
  const server=createHttpServer({
    createServer:()=>createServer({profile:PROFILE}),version:VERSION,host:HTTP_HOST,token:AUTH_TOKEN,
    tokenFile:argOf('--token-file')||process.env.DONGGUK_MCP_TOKEN_FILE,
    endpointFactories:{'/mcp':()=>createServer({profile:PROFILE}),'/mcp/rules':()=>createServer({profile:'rules'})},
    publicPage:fs.readFileSync(path.join(__dirname,'../docs/quickstart.html'),'utf8'),
    maxConcurrent:Number(process.env.DONGGUK_MCP_MAX_CONCURRENT||8),
    maxQueue:Number(process.env.DONGGUK_MCP_MAX_QUEUE||32),
    allowedOrigins:(process.env.DONGGUK_MCP_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean),
  });
  server.listen(HTTP_PORT,HTTP_HOST,()=>console.error(`dongguk-rule-mcp v${VERSION} HTTP 시작 (${PROFILE}, ${HTTP_HOST}:${HTTP_PORT})`));
  server.on('error',()=>{console.error('HTTP 기동 실패: 바인드 주소·포트·인증 설정을 확인하세요.');process.exitCode=1;});
  const shutdown=()=>server.shutdown().finally(()=>process.exit(0));
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  return server;
}

// === 기동 ===
if (require.main === module) {
  (async()=>{
    normalizeProfile(PROFILE);
    if(ARGV.includes('--print-config')){console.log(require('./cli.js').printConfig(argOf('--print-config'),PROFILE));return;}
    if(ARGV.includes('--doctor')){
      const result=await require('./cli.js').doctor({createServer,version:VERSION,profile:PROFILE,live:ARGV.includes('--live')});
      console.log(ARGV.includes('--json')?JSON.stringify(result,null,2):`동국 규정 MCP ${VERSION}: ${result.ok?'정상':'점검 필요'}\n${JSON.stringify(result.checks,null,2)}\n${result.notice}`);
      if(!result.ok)process.exitCode=1;return;
    }
    if(MODE_HTTP){startHttp();return;}
    const server=createServer({profile:PROFILE});await server.connect(new StdioServerTransport());
    console.error(`dongguk-rule-mcp v${VERSION} 시작됨 (${PROFILE}, stdio, Node ${process.version})`);
  })().catch(e=>{console.error('서버 시작 실패:',e.message);process.exitCode=1;});
}
module.exports={createServer};

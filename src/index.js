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
const DISCLAIMER='동국대학교의 공식 서비스가 아닌 개인 운영 도구입니다. 공개 규정 원문(rule.dongguk.edu)을 조회해 전달하며, 최종 판단은 공식 원문과 소관 부서 해석을 따르세요.';

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
  const flags = new Set(['--http','--doctor','--json','--live','--help','-h','--version','-v','--build-index','--build-semantic-index']);
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
  dongguk-rule-mcp --build-index   전체 공개 규정의 전문 색인 생성·갱신 (약 5분, 바뀐 규정만 다시 읽음)
  dongguk-rule-mcp --build-semantic-index  의미검색용 조문 임베딩 색인 생성·갱신 (선택 기능, @huggingface/transformers 별도 설치 필요)
  --profile rules|finance         기본 rules, 내부 재무 기능은 finance 선택

HTTP 옵션:
  --port <n>    포트 (기본 3845, env: DONGGUK_MCP_PORT)
  --host <h>    바인드 주소 (기본 127.0.0.1, env: DONGGUK_MCP_HOST)
  --token <t>   기존 운영자 Bearer 토큰 (env: DONGGUK_MCP_TOKEN 권장)
  --token-file <path> 구성원별 SHA-256 토큰 등록부 (env: DONGGUK_MCP_TOKEN_FILE)

환경변수:
  DONGGUK_RULE_COOKIE   비공개 규정 열람용 쿠키
  DONGGUK_MCP_NO_CACHE  1이면 디스크 캐시 비활성화
  DONGGUK_MCP_INDEX_REFRESH_HOURS  HTTP 모드에서 전문 색인을 이 시간마다 갱신 (예: 24)`);
  process.exit(0);
}

const MODE_HTTP = ARGV.includes('--http');
const {normalizeProfile,currentProfile,withProfile,withPublicWarmup,refreshAhead,requestCookie,normalizeCampus,campusScope}=require('./runtime-context.js');
const PROFILE=argOf('--profile') || process.env.DONGGUK_MCP_PROFILE || 'rules';
const HTTP_PORT = Number(argOf('--port') || process.env.DONGGUK_MCP_PORT || 3845);
const HTTP_HOST = argOf('--host') || process.env.DONGGUK_MCP_HOST || '127.0.0.1';
const AUTH_TOKEN = (argOf('--token') || process.env.DONGGUK_MCP_TOKEN || '').trim();

const { loadFinancePack, routeFinance, getFinanceContext, hasSensitiveInput } = require('./finance.js');
const {searchHandbook}=require('./handbook.js');
const {selectPractice}=require('./practice.js');
const {reviewFinanceCase,formatFinanceReview}=require('./finance-desk.js');
const { compareUniversityRules, formatComparison, validateArguments: validateComparison, safeCode: comparisonErrorCode } = require('./university-rules');
const FINANCE_TOOLS=new Set(['get_finance_context','get_finance_evidence','search_finance_handbook','review_finance_case']);
const { queryLegalReferences, inspectLaws } = require('./legal-client.js');
const { buildUpperLaws, formatUpperLaws, latestAnnotatedDate, CAVEAT: UPPER_LAW_CAVEAT } = require('./upper-laws.js');
const { lawLinkConfigured, fetchCitedLaws, formatCitedLaws } = require('./law-link.js');
const { summarizeRuleCoverage, lawTextCoverage } = require('./evidence-status.js');
const { formatLegalEvidence } = require('./legal-format.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { clampNumber, normalizeText, searchVariants, rankRuleHits, selectRuleCandidate, extractRelevantBlocks, ruleNameFromQuery, titleInQuery, withoutRuleName, queryContentTokens, parseKeywords, appendixSelectors, articleSelectors, requestedRuleScope, selectRuleEditions } = require('./lookup.js');
const {
  parseSearch,
  parseContent,
  CONTENT_PARSER_VERSION,
  parseHistory,
  searchResultMetrics,
  normalizeArticleSelector,
  extractArticleSections,
  supplementarySelector,
  extractChapter,
  grepArticleSections,
  rankArticlesByTokens,
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
const { CATALOG_PAGE_SIZE, validateCatalog, isoDate, checkRuleUpdates, formatRuleUpdates } = require('./catalog.js');
const { semanticScores, semanticStatus, warmSemantic, sharedEmbedder, buildSemanticIndex, loadSemanticIndex, createEmbedder } = require('./semantic.js');
const { blocksOf, buildCorpus, saveCorpus, loadCorpus, corpusCoverage, matchBlocks, searchCorpus } = require('./corpus.js');
const { normalizeName, createResolver, extractReferences, summarizeExternalLaws } = require('./references.js');

// === 상수 (Python 원본에서 검증된 엔드포인트) ===
const BASE_URL = 'https://rule.dongguk.edu';
const SEARCH_URL = `${BASE_URL}/lmxsrv/search/lawSerach.srv`;    // POST 전용!
const FULLVIEW_URL = `${BASE_URL}/lmxsrv/law/lawFullView.srv`;
const CONTENT_URL = `${BASE_URL}/lmxsrv/law/lawFullContent.srv`; // GET
const FILE_URL = `${BASE_URL}/fileDown.srv`;                    // POST (원문 HWP)
const MAIN_URL = `${BASE_URL}/lmxsrv/main/main.srv`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
// LAWGROUP is document type, not campus (official screen verified 2026-09-08).
// Bump when parseContent output changes; parsed bodies are cached for 30 days.
// v4: unnumbered article bodies and paragraph continuations are now kept.
const CONTENT_CACHE = `content-v${CONTENT_PARSER_VERSION}`;
const TTL = { search: 3600, searchFull: 86400, history: 600, content: 30*86400, catalog: 600 };
// A local index older than this is ignored unless the caller asks for it.
const INDEX_MAX_AGE_MS = 8*86400*1000;
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
// The full-text index holds public rule text only, whatever the request profile.
function publicCacheDir() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(),'.cache'), 'dongguk-rule-mcp', 'v2', 'public');
}
function noCache() {
  return ['1','true','yes'].includes((process.env.DONGGUK_MCP_NO_CACHE||'').trim().toLowerCase());
}
function hk(...p) { return crypto.createHash('md5').update(p.join('|')).digest('hex'); }
const cached = require('./cache.js').createDiskCache({ directory:cacheDir, disabled:noCache, refreshAhead });

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

async function loadDonggukComparison(topic, terms, {signal, searchTerms=[topic], titleHints=terms}={}) {
  const timeout=()=>Object.assign(new Error('comparison timeout'),{code:'TOTAL_TIMEOUT'});
  // 검색 결과는 조문 단위 행이라 같은 규정이 여러 번 나온다. 20행을 받아 규정 단위로 합친다.
  const PAGE=20, queries=[...new Set(searchTerms)].slice(0,2);
  const run=async(fullText)=>{
    const seen=new Set(), hits=[]; let total=0;
    for (const q of queries) {
      if(signal?.aborted) throw timeout();
      const r=await cached(fullText?'university-full-search':'university-title-search',hk(q,1,PAGE),TTL.history,()=>searchRules(q,{fullText,pageShow:PAGE}));
      total+=r.total||0;
      for (const h of r.hits) if(!seen.has(h.lawId)){seen.add(h.lawId);hits.push(h);}
    }
    return {hits,total};
  };
  const titled=await run(false);
  if(signal?.aborted) throw timeout();
  const found=titled.hits.length?{...titled,mode:'title_search'}:{...await run(true),mode:'full_text_search'};
  const {ruleTitleScore, MAX_RULES}=require('./university-rules');
  const ranked=rankRuleHits(found.hits,topic).map((hit,i)=>({hit,i,s:ruleTitleScore(hit.title,terms,titleHints)}))
    .sort((a,b)=>b.s-a.s||a.i-b.i).map(x=>x.hit);
  const rules=[], failures=[];
  for (const hit of ranked.slice(0,MAX_RULES)) {
    if(signal?.aborted) break;
    try {
      const latest=await resolve(hit.lawId);
      if(signal?.aborted) break;
      const content=await cached(CONTENT_CACHE,`${hit.lawId}_${latest.historyId}`,TTL.content,()=>getContent(hit.lawId,latest.historyId));
      if (!content.markdown) throw Object.assign(new Error('empty content'),{code:'UPSTREAM_FORMAT_CHANGED'});
      const title=/^(?:\S\s+)+\S$/.test(content.title||'')?content.title.replace(/\s+/g,''):content.title;
      const effectiveAt=require('./university-rules').latestAddendaEffective(content.markdown);
      rules.push({...hit,...content,title,historyId:latest.historyId,revisedAt:latest.revisedAt,
        effectiveAt,effectiveSource:effectiveAt?'addenda':null,
        url:`${FULLVIEW_URL}?SEQ=${hit.lawId}&SEQ_HISTORY=${latest.historyId}`});
    } catch(e) { const code=comparisonErrorCode(e);failures.push({lawId:hit.lawId,code});if(code!=='UPSTREAM_FORMAT_CHANGED') break; }
  }
  return {rules,failures,coverage:{mode:found.mode,queries,totalCandidates:found.total,uniqueRules:ranked.length,scannedRules:rules.length,truncated:ranked.length>rules.length}};
}

// === 원문 HWP (HTML 본문에 없는 별표·표 포함) ===
async function getOriginalContent(historyId) {
  const body = new URLSearchParams({ FILE_SEQ:String(historyId), FILE_TYPE:'ori' });
  const buffer = await fpBuffer(FILE_URL, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:body.toString(),
  });
  if (buffer.length < 512) throw new Error(`HISTORY_ID ${historyId}의 HWP 원문을 다운로드할 수 없습니다.`);
  return require('./hwp-evidence.js').parseOriginalEvidence(buffer);
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

// === 현행 규정 전체 목록 (요청 1회) ===
async function loadCatalog() {
  return cached('catalog','all',TTL.catalog,async()=>validateCatalog(await searchRules(' ',{pageShow:CATALOG_PAGE_SIZE})));
}

// === 전문 색인 (후보 탐색용, 공개 규정만) ===
async function buildRuleIndex({onProgress}={}) {
  return withProfile('rules',async()=>{
    const catalog=await loadCatalog();
    // Keep the old catalog-size guard during migration, but never serve its incomplete bodies.
    const previous=loadCorpus(publicCacheDir(),{allowStaleParser:true});
    const corpus=await buildCorpus({
      catalog,previous,onProgress,
      loadContent:(lawId,historyId)=>cached(CONTENT_CACHE,`${lawId}_${historyId}`,TTL.content,()=>getContent(lawId,historyId)),
    });
    const filename=saveCorpus(publicCacheDir(),corpus);
    const coverage=corpusCoverage(corpus);
    return {ok:corpus.failed.length<=corpus.catalogTotal*0.05,file:filename,...coverage,reusedRules:corpus.reused,failed:corpus.failed.slice(0,20)};
  });
}
// Article vectors for semantic search, made from the full-text index. The model is downloaded
// by the build command (never while answering a question) and unchanged articles keep their vectors.
// A running server refreshing its own vectors reuses the model it already holds.
async function buildSemanticRuleIndex({onProgress,shared=false}={}) {
  const directory=publicCacheDir(), corpus=loadCorpus(directory);
  if(!corpus) return {ok:false,code:'INDEX_UNAVAILABLE',message:'전문 색인이 없습니다. 먼저 --build-index를 실행하세요.'};
  let embedder;
  try{embedder=shared?sharedEmbedder(directory):await createEmbedder({directory,download:true});}
  catch(error){return {ok:false,code:error.code||'SEMANTIC_MODEL_UNAVAILABLE',message:error.code==='SEMANTIC_RUNTIME_MISSING'?error.message+' 서버 설치 폴더에서 `npm install @huggingface/transformers`를 실행하거나 DONGGUK_MCP_SEMANTIC_RUNTIME에 설치 폴더를 지정하세요.':'임베딩 모델을 불러오지 못했습니다.'};}
  const started=Date.now();
  let built;
  // Only a completed build atomically publishes a new index description.
  try{built=await buildSemanticIndex({corpus,directory,embedder,previous:loadSemanticIndex(directory),onProgress});}
  catch{return {ok:false,code:'SEMANTIC_BUILD_FAILED',message:'조문 벡터를 만들지 못해 새 색인을 게시하지 않았습니다. 이전 색인이 있다면 유지됩니다. 사용 가능 여부는 의미검색 상태에서 확인하세요.'};}
  return {ok:true,model:built.meta.model,articles:built.meta.articles,vectors:built.meta.rows,dims:built.meta.dims,reusedArticles:built.reused,seconds:Math.round((Date.now()-started)/1000),builtAt:built.meta.builtAt};
}
function indexStatus() {
  const corpus=loadCorpus(publicCacheDir());
  if(!corpus) return {available:false};
  return {available:true,...corpusCoverage(corpus),stale:Date.now()-Date.parse(corpus.builtAt)>INDEX_MAX_AGE_MS};
}

// === MCP 핸들러 ===
function cmap(){ return '0'; }

async function hCheckUpdates({law_ids,previous,since,limit}={}) {
  const hasIds=law_ids!==undefined&&law_ids!==null;
  if(hasIds&&(!Array.isArray(law_ids)||!law_ids.length||law_ids.length>50||law_ids.some(id=>!toId(id)))) return failure('INVALID_ARGUMENT','law_ids는 LAW_ID(양의 정수) 1~50개의 배열이어야 합니다. 예: [184, 103]');
  const sinceDate=since===undefined||since===null||since===''?null:isoDate(since);
  if(since!==undefined&&since!==null&&since!==''&&!sinceDate) return failure('INVALID_ARGUMENT','since는 YYYY-MM-DD 형식의 실제 날짜여야 합니다. 예: 2026-10-01');
  if(!hasIds&&!sinceDate) return failure('INVALID_ARGUMENT','law_ids(점검할 규정) 또는 since(이 날짜 이후 개정된 규정 목록) 중 하나를 입력하세요.');
  const snapshot={};
  if(previous!==undefined&&previous!==null){
    if(typeof previous!=='object'||Array.isArray(previous)) return failure('INVALID_ARGUMENT','previous는 이전 응답의 nextSnapshot 객체({LAW_ID: HISTORY_ID})여야 합니다.');
    for(const [key,value] of Object.entries(previous)){
      if(!toId(key)||!toId(value)) return failure('INVALID_ARGUMENT','previous의 키와 값은 양의 정수여야 합니다.');
      snapshot[Number(key)]=Number(value);
    }
  }
  const catalog=await loadCatalog();
  const data=checkRuleUpdates({catalog,lawIds:hasIds?law_ids.map(Number):[],previous:snapshot,since:sinceDate,limit:clampNumber(limit,50,1,50)});
  data.checkedAt=new Date().toISOString();
  data.catalogCacheSeconds=TTL.catalog;
  data.source={name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:data.checkedAt};
  return success(formatRuleUpdates(data),data);
}

async function hReferences(rawLawId,{article,historyId,direction='outgoing',limit,includeLawText=false}={}) {
  const lawId=toId(rawLawId);
  if(!lawId) return failure('INVALID_ARGUMENT','law_id는 양의 정수여야 합니다. search_rule 결과의 LAW_ID를 사용하세요.');
  if(!['outgoing','incoming','both'].includes(direction)) return failure('INVALID_ARGUMENT','direction은 outgoing, incoming, both 중 하나여야 합니다.');
  const hasArticle=article!==undefined&&article!==null&&article!=='';
  const selector=hasArticle?normalizeArticleSelector(article):null;
  if(hasArticle&&!selector) return failure('INVALID_ARGUMENT','article은 48, "제48조", "제10조의2", "부칙(2024.8.27.) 제1조" 형식이어야 합니다.');
  limit=clampNumber(limit,30,1,50);
  const resolved=await resolve(lawId,historyId);
  const rid=resolved.historyId;
  const c=await cached(CONTENT_CACHE,`${lawId}_${rid}`,TTL.content,()=>getContent(lawId,rid));
  if(!c.markdown) return failure('CONTENT_UNAVAILABLE',`본문을 가져올 수 없습니다 (LAW_ID ${lawId}).`);
  let catalog=[],catalogAvailable=true;
  try{catalog=await loadCatalog();}catch{catalogAvailable=false;}
  const title=catalog.find(rule=>rule.lawId===lawId)?.title||String(c.title||'').replace(/\s+/g,'');
  const references=[];
  const totals={outgoing:0,incoming:0};
  const location=(rule,block)=>({lawId:rule.lawId,historyId:rule.historyId,title:rule.title,article:block.article?(block.supplementary?`부칙 ${block.article}`:block.article):null,supplementaryHeading:block.supplementaryHeading||null});

  if(direction!=='incoming'){
    let blocks=blocksOf(c.markdown);
    if(selector){
      const extracted=extractArticleSections(c.markdown,article);
      if(extracted.error) return failure(extracted.error,ambiguousArticleMessage(extracted.sections));
      if(!extracted.sections.length) return failure('NOT_FOUND',`${selector.label}를 찾을 수 없습니다. get_rule_toc로 목차를 먼저 확인해보세요.`,{details:{lawId,historyId:rid,article:selector.canonical}});
      blocks=extracted.sections.map(section=>({article:section.canonical,supplementary:section.supplementary,supplementaryHeading:section.supplementaryHeading,content:section.content}));
    }
    const resolver=createResolver(catalog,{lawId,title});
    for(const block of blocks){
      // The heading repeats the article's own number; cite only the body.
      for(const item of extractReferences(block.content.replace(/^###.*$/m,''),resolver)){
        if(item.scope==='same_rule'&&!item.article) continue;
        totals.outgoing++;
        if(references.filter(x=>x.direction==='outgoing').length<limit) references.push({direction:'outgoing',...item,sourceLocation:location({lawId,historyId:rid,title},block)});
      }
    }
  }

  let incoming={scanned:false};
  if(direction!=='outgoing'){
    const corpus=loadCorpus(publicCacheDir());
    if(!corpus) incoming={scanned:false,code:'INDEX_UNAVAILABLE',notice:'역방향 조회에는 전문 색인이 필요합니다. 운영자가 `dongguk-rule-mcp --build-index`를 실행해야 합니다.'};
    else{
      const key=normalizeName(title);
      for(const rule of corpus.rules){
        if(rule.lawId===lawId) continue;
        const resolver=createResolver(catalog.length?catalog:[{lawId,title,historyId:rid}],{lawId:rule.lawId,title:rule.title});
        for(const block of rule.blocks){
          if(!normalizeName(block.content).includes(key)) continue;
          for(const item of extractReferences(block.content.replace(/^###.*$/m,''),resolver)){
            if(item.scope!=='dongguk_rule'||item.target.lawId!==lawId) continue;
            if(selector&&item.article!==selector.canonical.replace(/^부칙 /,'')) continue;
            totals.incoming++;
            if(references.filter(x=>x.direction==='incoming').length<limit) references.push({direction:'incoming',...item,sourceLocation:location(rule,block)});
          }
        }
      }
      incoming={scanned:true,...corpusCoverage(corpus),stale:Date.now()-Date.parse(corpus.builtAt)>INDEX_MAX_AGE_MS};
    }
  }

  const externalLaws=summarizeExternalLaws(references.filter(x=>x.direction==='outgoing'));
  const shown={outgoing:references.filter(x=>x.direction==='outgoing').length,incoming:references.filter(x=>x.direction==='incoming').length};
  const omittedCount=(totals.outgoing-shown.outgoing)+(totals.incoming-shown.incoming);
  const scopeLabel={same_rule:'같은 규정',dongguk_rule:'교내 규정',external_law:'국가 법령',unresolved:'미확정'};
  const row=x=>`| ${x.sourceLocation.title} ${x.sourceLocation.article||''} | ${scopeLabel[x.scope]} | ${x.target.title||x.target.lawName||x.target.name}${x.target.lawId?` (LAW_ID ${x.target.lawId})`:''} ${x.article||''} | ${x.citationText.replace(/\|/g,'/')} |`;
  let o=`## ${title} ${selector?selector.label+' ':''}인용 관계\n- LAW_ID ${lawId} / HISTORY_ID ${rid} (${resolved.revisedAt||'개정일 미상'})\n`;
  if(!catalogAvailable) o+='- 현행 규정 목록을 불러오지 못해 교내 규정명 대조를 생략했습니다.\n';
  if(direction!=='incoming'){
    o+=`\n### 이 규정이 인용하는 근거 (${totals.outgoing}건)\n`;
    o+=shown.outgoing?`\n| 위치 | 구분 | 인용 대상 | 원문 |\n|---|---|---|---|\n${references.filter(x=>x.direction==='outgoing').map(row).join('\n')}\n`:'\n명시적으로 인용한 다른 규정·법령을 찾지 못했습니다.\n';
    if(externalLaws.length) o+=`\n**한국법령 MCP로 확인할 법령**\n${externalLaws.map(x=>`- ${x.lawName}${x.articles.length?` ${x.articles.join(', ')}`:''}${x.confirmedLawName?'':' (법령 여부 미확인)'}`).join('\n')}\n`;
  }
  if(direction!=='outgoing'){
    o+=`\n### 이 규정을 인용하는 교내 규정 (${totals.incoming}건)\n`;
    if(!incoming.scanned) o+=`\n${incoming.notice}\n`;
    else o+=(shown.incoming?`\n| 위치 | 구분 | 인용 대상 | 원문 |\n|---|---|---|---|\n${references.filter(x=>x.direction==='incoming').map(row).join('\n')}\n`:'\n색인 범위에서 이 규정을 이름으로 인용한 조문을 찾지 못했습니다.\n')+
      `\n- 색인 기준: ${incoming.indexedAt}, ${incoming.indexedRules}/${incoming.totalRules}개 규정${incoming.complete?'':' (일부 누락)'}${incoming.stale?' — 색인이 오래되어 최근 개정이 빠졌을 수 있습니다':''}\n`;
  }
  // Law text is an addition: a failure here never fails the rule lookup.
  let lawTexts=null;
  if(includeLawText===true&&direction!=='incoming'){
    try{lawTexts=await fetchCitedLaws(externalLaws,{profile:currentProfile(),cached,queryLegalReferences});}
    catch{lawTexts={status:'unavailable',code:'LEGAL_LOOKUP_FAILED',laws:[],skipped:[],limits:{}};}
    o+=formatCitedLaws(lawTexts);
  }
  if(omittedCount) o+=`\n표시 한도(${limit}건)를 넘은 ${omittedCount}건은 생략했습니다. article을 지정하거나 limit를 늘리세요.\n`;
  o+='\n이름을 적은 인용과, 같은 조문 안에서 그 이름을 받는 "동법"·"같은 법"·정의된 약칭을 찾습니다. "관계 법령"처럼 이름이 없는 인용은 빠지며, 인용이 있다는 것과 해당 근거가 적용된다는 것은 다릅니다.';
  return success(o,{
    source:{lawId,historyId:rid,revisedAt:resolved.revisedAt||'',title,article:selector?.canonical||null,sourceUrl:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${rid}`},
    direction,references,externalLaws,...(lawTexts?{lawTexts}:{}),
    counts:{...totals,shown},
    coverage:{outgoing:direction==='incoming'?null:{scope:selector?'selected_article':'whole_rule',complete:true},incoming:direction==='outgoing'?null:incoming,catalogAvailable},
    truncated:omittedCount>0,omittedCount,
    evidenceStatus:(direction==='outgoing'||(incoming.scanned&&incoming.complete&&!incoming.stale))&&catalogAvailable&&!omittedCount?'retrieved':'partial',
    returnedAt:new Date().toISOString(),
  });
}

// National laws behind a rule: cited laws checked against the current-law
// listing, with the points a reviewer should look at again.
async function hUpperLaws(rawLawId,{article,historyId,includeText=false,includeCandidates=true,maxLaws}={}) {
  const lawId=toId(rawLawId);
  if(!lawId) return failure('INVALID_ARGUMENT','law_id는 양의 정수여야 합니다. search_rule 결과의 LAW_ID를 사용하세요.');
  for(const [key,value] of [['include_text',includeText],['include_candidates',includeCandidates]]) if(typeof value!=='boolean') return failure('INVALID_ARGUMENT',`${key}는 boolean이어야 합니다.`);
  if(maxLaws!==undefined&&(!Number.isInteger(maxLaws)||maxLaws<1||maxLaws>12)) return failure('INVALID_ARGUMENT','max_laws는 1~12 범위 정수여야 합니다.');
  const hasArticle=article!==undefined&&article!==null&&article!=='';
  const selector=hasArticle?normalizeArticleSelector(article):null;
  if(hasArticle&&!selector) return failure('INVALID_ARGUMENT','article은 48, "제48조", "제10조의2", "부칙(2024.8.27.) 제1조" 형식이어야 합니다.');
  const resolved=await resolve(lawId,historyId);
  const rid=resolved.historyId;
  const c=await cached(CONTENT_CACHE,`${lawId}_${rid}`,TTL.content,()=>getContent(lawId,rid));
  if(!c.markdown) return failure('CONTENT_UNAVAILABLE',`본문을 가져올 수 없습니다 (LAW_ID ${lawId}).`);
  let catalog=[],catalogAvailable=true;
  try{catalog=await loadCatalog();}catch{catalogAvailable=false;}
  const title=catalog.find(rule=>rule.lawId===lawId)?.title||String(c.title||'').replace(/\s+/g,'');
  let blocks=blocksOf(c.markdown);
  if(selector){
    const extracted=extractArticleSections(c.markdown,article);
    if(extracted.error) return failure(extracted.error,ambiguousArticleMessage(extracted.sections));
    if(!extracted.sections.length) return failure('NOT_FOUND',`${selector.label}를 찾을 수 없습니다. get_rule_toc로 목차를 먼저 확인해보세요.`,{details:{lawId,historyId:rid,article:selector.canonical}});
    blocks=extracted.sections.map(section=>({article:section.canonical,supplementary:section.supplementary,supplementaryHeading:section.supplementaryHeading,content:section.content}));
  }
  blocks=blocks.map((block,index)=>({...block,id:`rule-block-${index}`}));
  const source={lawId,historyId:rid,revisedAt:resolved.revisedAt||'',title,article:selector?.canonical||null,sourceUrl:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${rid}`};
  const resolver=createResolver(catalog,{lawId,title});
  const references=[];
  for(const block of blocks){
    const ruleArticleAnnotatedAt=latestAnnotatedDate(block.content);
    for(const item of extractReferences(block.content.replace(/^###.*$/m,''),resolver)){
      if(item.scope!=='external_law'&&!item.externalCandidate) continue;
      references.push({...item,ruleArticleAnnotatedAt,sourceLocation:{blockId:block.id,article:block.article?(block.supplementary?`부칙 ${block.article}`:block.article):null}});
    }
  }
  const result=await buildUpperLaws({
    references,title,ruleRevisedAt:resolved.revisedAt,includeText,maxLaws:maxLaws||8,
    // Topic candidates describe the whole rule, not one article.
    includeCandidates:includeCandidates&&!selector,
    configured:lawLinkConfigured(currentProfile()),cached,inspectLaws,
  });
  // lookup.status covers the identity/existence check; a cut law body is tracked apart.
  const textCoverage=lawTextCoverage(result.laws,{includeText,maxTextChars:result.limits.maxTextChars,lookupCode:result.lookup.code});
  result.comparison=require('./upper-law-comparison').buildComparison(result,{blocks,source,includeText});
  const incompleteReasons=[...new Set([
    ...(['retrieved','not_required'].includes(result.lookup.status)?[]:['LAW_LOOKUP_INCOMPLETE']),
    ...(result.omitted.length?['LAW_LIMIT']:[]),...(catalogAvailable?[]:['CATALOG_UNAVAILABLE']),
    ...(textCoverage.truncatedArticles.length?['LAW_TEXT_TRUNCATED']:[]),
    ...(textCoverage.missingArticles.length?['LAW_TEXT_UNAVAILABLE']:[]),
    ...result.comparison.incompleteReasons,
  ])];
  const complete=!incompleteReasons.length;
  let text=formatUpperLaws(result,{title,selectorLabel:selector?.label});
  text+=`\n\n근거 상태: ${complete?'retrieved':'partial'}${incompleteReasons.length?` (${incompleteReasons.join(', ')})`:''}`;
  if(textCoverage.missingArticles.length) text+=`\n\n본문을 가져오지 못한 법령 조문이 있습니다(${textCoverage.missingArticles.map(x=>`${x.lawName} ${x.article}: ${x.reason}`).join(', ')}). 본문을 확인한 것이 아니므로 한국법령 MCP나 국가법령정보센터에서 직접 확인하세요.`;
  if(textCoverage.truncatedArticles.length) text+=`\n\n법령 본문 일부가 ${textCoverage.maxTextChars}자에서 잘렸습니다(${textCoverage.truncatedArticles.map(x=>`${x.lawName} ${x.article}`).join(', ')}). 전문은 한국법령 MCP의 get_law_text나 국가법령정보센터에서 확인하세요.`;
  if(!catalogAvailable) text+='\n\n현행 규정 목록을 불러오지 못해 교내 규정명과 법령명을 구분하지 못한 인용이 있을 수 있습니다.';
  return success(text,{
    source,
    ...result,caveat:UPPER_LAW_CAVEAT,applicability:'requires_review',
    coverage:{scope:selector?'selected_article':'whole_rule',catalogAvailable,citationBasis:'explicit_names_only'},
    textCoverage,evidenceStatus:complete?'retrieved':'partial',incompleteReasons,returnedAt:new Date().toISOString(),
  });
}

// Candidate search over the local index. Each hit is checked against the
// current catalog and re-read from the source when its revision has changed.
async function deepFromIndex(query,{top,perDoc,required}) {
  if(requestCookie()) return null;
  const corpus=loadCorpus(publicCacheDir());
  if(!corpus) return null;
  const stale=Date.now()-Date.parse(corpus.builtAt)>INDEX_MAX_AGE_MS;
  if(stale&&!required) return null;
  const found=searchCorpus(corpus,query,{top,perDoc});
  if(!found.hits.length) return null;
  let current=null;
  try{current=new Map((await loadCatalog()).map(rule=>[rule.lawId,rule]));}catch{}
  const documents=[];
  for(const hit of found.hits){
    const doc={lawId:hit.lawId,historyId:hit.historyId,title:hit.title,code:hit.code,revisedAt:hit.revisedAt,matchedTerms:hit.matchedTerms,matchCount:hit.matchCount,articles:hit.articles,versionCheck:'current'};
    const latest=current?.get(hit.lawId);
    if(!current) doc.versionCheck='unverified';
    else if(!latest) doc.versionCheck='not_in_current_catalog';
    else if(latest.historyId!==hit.historyId){
      try{
        const c=await cached(CONTENT_CACHE,`${hit.lawId}_${latest.historyId}`,TTL.content,()=>getContent(hit.lawId,latest.historyId));
        const {scored}=matchBlocks(blocksOf(c.markdown),found.searchTerms||found.tokens,new Map());
        Object.assign(doc,{historyId:latest.historyId,revisedAt:latest.revisedAt,title:latest.title,matchCount:scored.length,versionCheck:'refetched',
          articles:scored.slice(0,perDoc).map(x=>({article:x.block.article,supplementary:x.block.supplementary,supplementaryHeading:x.block.supplementaryHeading,content:x.block.content,matchedTerms:x.matched}))});
      }catch{doc.versionCheck='unverified';}
    }
    documents.push(doc);
  }
  const coverage={...corpusCoverage(corpus),stale,newRulesNotIndexed:current?[...current.keys()].filter(id=>!corpus.rules.some(rule=>rule.lawId===id)).length:null};
  const note={current:'색인과 현행 개정본 일치',refetched:'색인 이후 개정되어 현행 본문을 다시 읽음',unverified:'현행 개정본 여부를 확인하지 못함',not_in_current_catalog:'현행 목록에 없음(폐지·통합 가능)'};
  let o=`# '${query}' 깊이 검색 (전문 색인)\n- 핵심어: ${found.tokens.join(', ')}`+(found.missingTerms.length?` / 어느 규정에도 없는 단어: ${found.missingTerms.join(', ')}`:'')+
    `\n- 색인 기준 ${coverage.indexedAt}, ${coverage.indexedRules}/${coverage.totalRules}개 규정${coverage.complete?'':' (일부 누락)'}${stale?' — 색인이 오래되었습니다':''}\n\n`;
  documents.forEach((doc,i)=>{
    o+=`## [${i+1}] ${doc.title} (LAW_ID ${doc.lawId})\n- 일치 조문 ${doc.matchCount}건 / 일치 단어: ${doc.matchedTerms.join(', ')}\n\n`;
    if(doc.articles.length) o+=`${doc.articles.map(x=>(x.supplementary&&x.supplementaryHeading?`(${x.supplementaryHeading.replace(/^#+\s*/,'')})\n`:'')+x.content).join('\n\n')}\n\n`;
    o+=`- 조회 개정일: ${doc.revisedAt} / HISTORY_ID ${doc.historyId} — ${note[doc.versionCheck]}\n\n`;
  });
  o+='색인 검색은 단어가 많이 일치하는 조문 순의 후보입니다. 별표·금액표는 lookup_dongguk_rule(law_id 지정)로 원문을 확인하세요.';
  return success(o,{
    query,searchMode:'index',terms:found.tokens,missingTerms:found.missingTerms,index:coverage,
    counts:{returned:documents.length},documents,
    evidenceStatus:documents.every(doc=>['current','refetched'].includes(doc.versionCheck))?'retrieved':'partial',
    source:{name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:new Date().toISOString()},
  });
}

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
  o+='\n\n💡 조문·별표는 lookup_dongguk_rule로 조회하세요. get_rule_content는 HTML 본문 전용이며 별표가 빠질 수 있습니다.';
  return success(o,{
    query:{keyword,fullText,campus,limit,offset},
    counts:{sourceTotal:r.total,...metrics,returned:hits.length},
    rules:hits,
    nextOffset:offset+limit<r.total?offset+limit:null,
    source:{name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:new Date().toISOString()},
  });
}

function ambiguousArticleMessage(sections) {
  const selectors=[...new Set(sections.map(supplementarySelector).filter(Boolean))];
  return '여러 부칙에 같은 조문 번호가 있습니다. article에 "부칙(2024.8.27.) 제1조"처럼 부칙 개정일을 함께 지정하세요.'+
    (selectors.length?` 선택 가능: ${selectors.slice(-8).join(', ')}`:'');
}

async function hContent(rawLawId, hid, {article,chapter,grep,head}={}) {
  const lawId = toId(rawLawId);
  if(!lawId) return failure('INVALID_ARGUMENT', 'law_id는 양의 정수여야 합니다. search_rule 결과의 LAW_ID를 사용하세요. (예: law_id=491)');
  const hasArticle=article!==undefined && article!==null && article!=='';
  const articleSelector=hasArticle?normalizeArticleSelector(article):null;
  if(hasArticle && !articleSelector) return failure('INVALID_ARGUMENT', 'article은 48, "제48조", "제10조의2", "부칙 제2조", "부칙(2024.8.27.) 제1조" 형식이어야 합니다.');
  const chp = toId(chapter);
  if(chapter!==undefined && chapter!==null && !chp) return failure('INVALID_ARGUMENT', 'chapter는 양의 정수여야 합니다. (예: chapter=5 → 제5장)');
  const resolved=await resolve(lawId,hid);
  const {historyId:rid, note}=resolved;
  const c=await cached(CONTENT_CACHE,`${lawId}_${rid}`,TTL.content,()=>getContent(lawId,rid));
  if(!c.markdown) return failure('CONTENT_UNAVAILABLE', `본문을 가져올 수 없습니다 (LAW_ID ${lawId}). law_id/history_id를 확인하세요.`);
  let r=c.markdown;
  let selectedArticles=[];
  if(articleSelector){
    const extracted=extractArticleSections(r,article);
    if(extracted.error) return failure(extracted.error,ambiguousArticleMessage(extracted.sections),{details:{candidates:extracted.sections.map(x=>({article:x.canonical,supplementaryHeading:x.supplementaryHeading,selector:supplementarySelector(x)}))}});
    if(!extracted.text) return failure('NOT_FOUND', `${articleSelector.label}를 찾을 수 없습니다. get_rule_toc로 목차를 먼저 확인해보세요.`, {
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
  const c=await cached(CONTENT_CACHE,`${lawId}_${rid}`,TTL.content,()=>getContent(lawId,rid));
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

// Rule candidates for a natural-language question from the local index. Hits
// only name rules: hLookup still resolves the current revision and reads the
// live body, so a stale index is acceptable for finding candidates. The top
// hit is "dominant" when it matches at least two words and clearly outscores
// the runner-up; callers may preview it instead of asking for a law_id.
const INDEX_PREVIEW_RULES=3;
const KEYWORDS_MAX_CHARS=200;
// Scope words name where a rule applies, not what the question is about.
const SCOPE_WORD=/^(?:WISE|WISE캠퍼스|경주|경주캠퍼스|서울캠퍼스|캠퍼스|산학협력단|산단|의학계열|의과대학|병원|대학원)$/i;
// Articles to excerpt first: the one the ranking chose, then the one closest in meaning to the
// question (when semantic search ran), then the one holding the most question words. The semantic
// article is added beside the word choices and never replaces the first.
function excerptPriority(first,semanticArticle,rest){
  const base=[...new Set([...first,...rest].filter(Boolean))];
  if(!semanticArticle||base.includes(semanticArticle)) return base;
  return [...base.slice(0,1),semanticArticle,...base.slice(1)];
}
function rankIndexHits(found,{top,campus,scopeQuery}){
  const families=new Map();
  for(const hit of found.hits){
    const body=hit.articles[0]&&!hit.articles[0].supplementary;
    const rankedArticles=hit.articles.filter(item=>item.article&&!item.supplementary).map(item=>item.article);
    const entry={lawId:hit.lawId,historyId:hit.historyId,title:hit.title,code:hit.code,revisedAt:hit.revisedAt,
      matchedTerms:hit.matchedTerms,matchedConcepts:hit.matchedConcepts,matchCount:hit.matchCount,topArticle:hit.articles[0]?.article||null,topArticleInBody:!!body,score:hit.score,wordScore:hit.wordScore,edition:hit.edition,family:hit.family,
      priorityArticles:excerptPriority(body?rankedArticles.slice(0,1):[],hit.semanticArticle,[hit.wordArticle,...(body?rankedArticles.slice(1,2):[])]),rankedArticles,
      // Only the institution or campus name matched; no article is about the topic.
      scopeNameOnly:hit.matchedConcepts.length>0&&hit.matchedConcepts.every(term=>SCOPE_WORD.test(term))};
    if(!families.has(hit.family)) families.set(hit.family,[]);
    families.get(hit.family).push(entry);
  }
  const scope=requestedRuleScope(scopeQuery,campus);
  let ranked=[...families.values()].flatMap(members=>selectRuleEditions(members,scope))
    .sort((a,b)=>Number(b.scopeMatch)-Number(a.scopeMatch)||b.score-a.score||a.lawId-b.lawId);
  // A specified, available scope must not be padded with unrelated editions.
  if(scope.specified&&!scope.ambiguous&&ranked.some(hit=>hit.scopeMatch)) ranked=ranked.filter(hit=>hit.scopeMatch);
  // A rule that shares only the institution's name with the question comes after every rule
  // with a matching topic. It stays a candidate: its answer may sit in an appendix the index lacks.
  if(ranked.some(hit=>!hit.scopeNameOnly)) ranked=[...ranked.filter(hit=>!hit.scopeNameOnly),...ranked.filter(hit=>hit.scopeNameOnly)];
  // A rule named after a question word (위임전결규정 for "누가 전결해") is previewed even when another
  // rule's articles match more words: its answer may sit in an appendix the index does not cover.
  const titleFamilies=term=>new Set(ranked.filter(x=>x.title.includes(term)).map(x=>x.family)).size;
  const anchored=ranked.slice(1).filter(x=>!x.scopeNameOnly&&x.scopeMatch===ranked[0].scopeMatch&&x.score>=ranked[0].score*0.4&&found.tokens.some(term=>term.length>=2&&x.title.includes(term)&&titleFamilies(term)<=2&&!ranked[0].title.includes(term)));
  const leading=ranked.slice(0,INDEX_PREVIEW_RULES);
  for(const extra of anchored.slice(0,1)) if(!leading.includes(extra)) leading.splice(INDEX_PREVIEW_RULES-1,1,extra);
  const hits=[...leading,...ranked.filter(x=>!leading.includes(x))].slice(0,top);
  const [first,second]=hits;
  // How clearly the first rule leads is judged by word scores. The semantic lift orders rules;
  // it is not evidence that one rule alone answers the question.
  const searchable=found.tokens.length-found.missingTerms.length;
  const dominant=!first.scopeAmbiguous&&first.scopeMatch!==false&&!anchored.length&&first.matchedConcepts.length>=Math.min(2,searchable)&&first.matchedConcepts.length>=1&&(!second||first.scopeMatch!==second.scopeMatch||first.wordScore>=Math.max(...hits.slice(1).map(hit=>hit.wordScore))*1.3);
  return {hits,dominant};
}
const RULE_NAME_SUFFIX=/(?:규정|규칙|세칙|내규|지침|요강|정관|회칙|학칙)$/;
// Semantic scores for a question, and for the question with its keywords. Null when semantic
// search is unavailable; the word index then answers alone. The vectors describe the current
// revision, so a lookup of a past revision does not use them.
async function questionSemantics(question,keywordPhrases,{asOf=null}={}){
  if(asOf||requestCookie()||!validStr(question)) return null;
  const directory=publicCacheDir(), corpus=loadCorpus(directory);
  if(!corpus) return null;
  const asked=await semanticScores({corpus,directory,text:question});
  if(!asked) return null;
  const keyed=keywordPhrases?.length?await semanticScores({corpus,directory,text:`${question} ${keywordPhrases.map(phrase=>phrase.join(' ')).join(', ')}`}):null;
  return {question:asked,keyed:keyed||asked};
}
function candidatesFromIndex(keyword,{top=5,campus='all',scopeQuery=keyword,keywords=null,previewLimit=INDEX_PREVIEW_RULES,semantic=null}={}){
  if(requestCookie()) return null;
  const corpus=loadCorpus(publicCacheDir());
  if(!corpus) return null;
  // Scope selection must see editions beyond the unscoped score cutoff.
  const found=searchCorpus(corpus,keyword,{top:corpus.rules.length,perDoc:3,keywords,semantic:keywords?.length?semantic?.keyed:semantic?.question});
  if(!found.hits.length) return null;
  // Campus and institution are read from the question, never from the keywords.
  let {hits,dominant}=rankIndexHits(found,{top,campus,scopeQuery});
  // Keywords can be off the mark. The rule the question alone would have chosen stays among
  // the previews, and its article stays in the excerpt of a rule both searches found.
  let keywordInfo=null;
  if(keywords?.length){
    keywordInfo={...found.keywords,applied:found.keywordMode,questionRuleKept:null};
    const alone=found.keywordMode?searchCorpus(corpus,keyword,{top:corpus.rules.length,perDoc:1,semantic:semantic?.question}):null;
    if(alone?.hits.length){
      const question=rankIndexHits(alone,{top:corpus.rules.length,campus,scopeQuery});
      const byId=new Map(question.hits.map(hit=>[hit.lawId,hit]));
      // Excerpt order: the two articles the keywords rank first, then the one the question alone ranked first.
      // Excerpt order inside a rule: the article the keywords rank first, the article the question
      // alone ranked first, then the keywords' next articles.
      hits=hits.map(hit=>{
        const ranked=hit.topArticleInBody?hit.rankedArticles:[], asked=byId.get(hit.lawId)?.priorityArticles.slice(0,1)||[];
        return {...hit,priorityArticles:[...new Set([...ranked.slice(0,1),...asked,...ranked.slice(1),...hit.priorityArticles])]};
      });
      const chosen=question.hits[0];
      // The rule the question alone ranks first always keeps the last preview slot.
      if(!hits.slice(0,previewLimit).some(hit=>hit.lawId===chosen.lawId)){
        hits=[...hits.slice(0,previewLimit-1),{...chosen,selectedBy:'question'},...hits.slice(previewLimit-1).filter(hit=>hit.lawId!==chosen.lawId)].slice(0,top);
        keywordInfo.questionRuleKept=chosen.lawId;
      }
      // One rule is shown alone only when the question by itself also singles out that rule.
      if(hits[0].lawId!==chosen.lawId||!question.dominant) dominant=false;
    }
  }
  return {total:hits.length,hits,semantic:found.semantic,tokens:found.tokens,missingTerms:found.missingTerms,rewrittenTerms:found.rewrittenTerms||{},searchTerms:found.searchTerms,dominant,
    ...(keywordInfo?{keywordInfo}:{}),
    indexedAt:corpus.builtAt,stale:Date.now()-Date.parse(corpus.builtAt)>INDEX_MAX_AGE_MS};
}
// A question that names its rule ("연구비로 출장 갈 때도 여비규정 따라야 돼?"). The rest of the
// question is everyday wording, so the excerpt is chosen with the same vocabulary and intent
// reading as the index search, inside that one rule. Null when the index cannot help.
function focusWithinRule(lawId,question,keywords=null,semantic=null){
  if(requestCookie()) return null;
  const corpus=loadCorpus(publicCacheDir());
  if(!corpus) return null;
  const within=options=>{
    const found=searchCorpus(corpus,question,{top:corpus.rules.length,perDoc:1,...options,semantic:options.keywords?semantic?.keyed:semantic?.question});
    const hit=found.hits.find(x=>x.lawId===lawId);
    if(!hit) return null;
    const top=hit.articles[0];
    return {searchTerms:found.searchTerms,topArticle:top&&!top.supplementary?top.article:null,wordArticle:hit.wordArticle,semanticArticle:hit.semanticArticle,semantic:found.semantic,keywordInfo:found.keywords?{...found.keywords,applied:found.keywordMode}:null};
  };
  // The article the words chose stays first; the article closest in meaning follows it.
  const alone=validStr(question)?within({}):null;
  if(!keywords?.length) return alone&&{...alone,priorityArticles:excerptPriority([alone.topArticle],alone.semanticArticle,[])};
  // Keywords that this rule does not contain fall back to the question's own words.
  const keyed=within({keywords});
  if(!keyed) return alone&&{...alone,priorityArticles:excerptPriority([alone.topArticle],alone.semanticArticle,[]),keywordInfo:{used:[],missing:[],rewritten:{},applied:false}};
  return {...keyed,priorityArticles:excerptPriority([keyed.topArticle],keyed.semanticArticle,[alone?.topArticle,keyed.wordArticle])};
}
const describeRewrites=map=>Object.keys(map||{}).length?Object.entries(map).map(([from,to])=>`${from}→${to}`).join(', '):'';

// Keyword fallback for questions whose literal wording is absent. The upstream
// full-text search ANDs every word and takes about 10 seconds per request, so
// search the content words first, then drop the longest word (usually a
// compound such as 국내출장 or 교내근로장학금 that the rule text spells
// differently), then the trailing word, within a fixed budget.
const TERM_SEARCH_BUDGET_MS=35000;
function termSearchAttempts(tokens){
  const attempts=[tokens];
  if(tokens.length>1){
    const longest=tokens.reduce((a,b)=>b.length>a.length?b:a,tokens[0]), last=tokens[tokens.length-1];
    const without=(...drop)=>tokens.filter(t=>!drop.includes(t));
    attempts.push(without(longest));
    if(last!==longest){attempts.push(without(longest,last));attempts.push(without(last));}
  }
  const seen=new Set();
  return attempts.filter(x=>x.length&&!seen.has(x.join(' '))&&seen.add(x.join(' ')));
}
async function searchByTerms(query,{pageShow=15,lawgroup='0',skipOriginal=false}={}){
  const tokens=queryContentTokens(query);
  if(!tokens.length) return null;
  const attempts=termSearchAttempts(tokens);
  const original=String(query).trim();
  const started=Date.now();
  let tried=0,firstError=null;
  for(const terms of attempts.filter(x=>!skipOriginal||x.join(' ')!==original).slice(0,4)){
    if(tried&&Date.now()-started>TERM_SEARCH_BUDGET_MS) break;
    tried++;
    const text=terms.join(' ');
    try{
      const result=await cached('search',hk(text,true,1,pageShow,lawgroup),TTL.searchFull,()=>searchRules(text,{fullText:true,page:1,pageShow,lawgroup}));
      if(result.hits.length) return {...result,tokens:terms,droppedTerms:tokens.filter(x=>!terms.includes(x))};
    }catch(error){firstError=firstError||error;}
  }
  // An upstream outage is not evidence that no rule matches.
  if(firstError) throw firstError;
  return null;
}

async function hDeep(rawQuery,{top=3,perDoc,mode='auto'}={}){
  const query = validStr(rawQuery);
  if(!query) return failure('INVALID_ARGUMENT', '검색어(query)를 입력해주세요. 예: "겸직", "위임전결"');
  if(!['auto','index','live'].includes(mode)) return failure('INVALID_ARGUMENT','mode는 auto, index, live 중 하나여야 합니다.');
  top=Math.max(1,Math.min(Number(top)||3,10));
  const pd = toId(perDoc);
  if(mode!=='live'){
    const indexed=await deepFromIndex(query,{top,perDoc:pd||5,required:mode==='index'});
    if(indexed) return indexed;
    if(mode==='index') return indexStatus().available
      ? failure('NOT_FOUND',`'${query}'의 핵심어가 색인된 규정에 없습니다. mode="live"로 공식 사이트 전문검색을 시도하세요.`,{details:{query}})
      : failure('INDEX_UNAVAILABLE','전문 색인이 없습니다. 운영자가 `dongguk-rule-mcp --build-index`를 실행하거나 mode="live"로 조회하세요.');
  }
  const ps=top*5, ck=hk(query,true,1,ps,'0');
  let r=await cached('search',ck,TTL.searchFull,()=>searchRules(query,{fullText:true,page:1,pageShow:ps}));
  let fallback=null;
  if(!r.hits.length){
    fallback=await searchByTerms(query,{pageShow:ps,skipOriginal:true});
    if(fallback) r=fallback;
  }
  const metrics=searchResultMetrics(r);
  if(!r.hits.length) return failure('NOT_FOUND', `'${query}' 전문 검색 결과가 없습니다. 더 일반적인 키워드로 시도해보세요.`, {details:{query}});
  const hits=r.hits.slice(0,top);
  const documents=[];
  let o=`# '${query}' 깊이 검색\n`+
    (fallback?`- 입력 문구 그대로는 결과가 없어 핵심어 '${fallback.tokens.join(' ')}'로 검색했습니다.`+
      (fallback.droppedTerms.length?` '${fallback.droppedTerms.join(', ')}'은(는) 함께 나오는 규정이 없어 제외했으니 원문에서 해당 내용을 확인하세요.`:'')+'\n':'')+
    `- 원문 집계 ${r.total}건, 고유 후보 ${metrics.uniqueRows}건, 상위 ${hits.length}개 grep\n\n`;
  for(let i=0;i<hits.length;i++){
    const h=hits[i];
    o+=`## [${i+1}] ${h.title} (LAW_ID ${h.lawId})\n`;
    try{
      const selected=await resolve(h.lawId);
      const currentHit={...h,historyId:selected.historyId,revisedAt:selected.revisedAt};
      const c=await cached(CONTENT_CACHE,`${h.lawId}_${selected.historyId}`,TTL.content,()=>getContent(h.lawId,selected.historyId));
      if(!c.markdown){
        o+='- 본문 조회 실패\n\n';
        documents.push({...currentHit,error:{code:'CONTENT_UNAVAILABLE',message:'본문 조회 실패'}});
        continue;
      }
      let matches=fallback?rankArticlesByTokens(c.markdown,fallback.tokens):grepArticleSections(c.markdown,query);
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
    query,indexUsed:false,...(fallback?{searchMode:'content_terms',terms:fallback.tokens,droppedTerms:fallback.droppedTerms}:{searchMode:'phrase'}),counts:{sourceTotal:r.total,uniqueCandidates:metrics.uniqueRows,duplicatesRemoved:metrics.duplicatesRemoved,returned:hits.length},documents,
    source:{name:'동국대학교 통합규정관리시스템',url:BASE_URL,returnedAt:new Date().toISOString()},
  });
}

async function hLookup(rawKeyword, {
  terms='',
  autoTerms=!validStr(terms),
  scopeQuery=rawKeyword,
  campus='all',
  maxRules=1,
  maxSections=4,
  maxChars=12000,
  includeHistory=false,
  asOf=null,
  explicitLawId=null,
  catalogRule=null,
  keywords=null,
  topicAsRuleKeyword=null,
}={}) {
  const keyword = validStr(rawKeyword) || (explicitLawId ? `LAW_ID ${explicitLawId}` : null);
  const keywordPhrases=parseKeywords(keywords);
  if(!keyword) return failure('INVALID_ARGUMENT', '규정명 또는 질문(rule_keyword 또는 query)을 입력해주세요. 예: "여비규정", "대전 출장 여비규정의 일비와 숙박비"');
  maxRules=clampNumber(maxRules,1,1,3);
  maxSections=clampNumber(maxSections,4,1,12);
  maxChars=clampNumber(maxChars,12000,1000,30000);
  const lg=cmap(campus), pageShow=Math.max(10,maxRules*5);

  const variants=searchVariants(keyword);
  let searchMode='제목', queryUsed=keyword, result=null;
  if(explicitLawId){
    const latest=await resolve(explicitLawId);
    const content=await cached(CONTENT_CACHE,`${explicitLawId}_${latest.historyId}`,TTL.content,()=>getContent(explicitLawId,latest.historyId));
    // The body title is letter-spaced ("여 비 규 정"); join it without another source request.
    const bodyTitle=/^(?:\S\s+)+\S$/.test(content.title||'')?content.title.replace(/\s+/g,''):content.title;
    result={total:1,hits:[{lawId:explicitLawId,historyId:latest.historyId,title:catalogRule?.title||bodyTitle||keyword,code:catalogRule?.code||'',revisedAt:latest.revisedAt}]};
    searchMode=catalogRule?'현행 목록 제목':'LAW_ID';
  }
  const candidateHits=new Map();
  let semantic=null;
  const questionTerms=queryContentTokens(keyword);
  for(const fullText of (result?[]:[false,true])){
    // A multi-word question rarely appears verbatim; searchByTerms below
    // covers full text with its content words instead of 10-second literal tries.
    if(fullText&&questionTerms.length>1) break;
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
  // A question without a rule title: the local index scores rules by the
  // words they contain, so it finds 여비규정 for "일비·숙박비" questions that
  // the literal upstream search cannot. Title hits that merely share a word
  // with the question ("등록금 반환 기준" → 등록금심의위원회규정) do not
  // override it; only an exact title does. Falls through to the live search
  // when the index is missing or has no match.
  const exactTitle=candidateHits.size>0&&selectRuleCandidate([...candidateHits.values()],keyword).matchType==='exact';
  // One content word with no title candidate ("책 연체하면 어떻게 돼") is still a question for the index.
  if(!explicitLawId&&!exactTitle&&(questionTerms.length>1||(questionTerms.length===1&&!candidateHits.size)||keywordPhrases.length)){
    semantic=await questionSemantics(keyword,keywordPhrases,{asOf});
    const indexed=candidatesFromIndex(keyword,{top:Math.max(5,maxRules*5),campus,scopeQuery,keywords:keywordPhrases,previewLimit:maxRules===1?INDEX_PREVIEW_RULES:maxRules,semantic});
    if(indexed){result=indexed;queryUsed=indexed.tokens.join(' ');searchMode='핵심어 색인';}
  }
  if(!result){
    const fallback=await searchByTerms(keyword,{pageShow,lawgroup:lg});
    if(fallback){result=fallback;queryUsed=fallback.tokens.join(' ');searchMode='핵심어 전문';}
  }
  if(candidateHits.size&&searchMode!=='핵심어 색인'){
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
  // An index hit that clearly outscores the others is previewed as an
  // unconfirmed candidate (evidenceStatus partial) instead of a second round
  // trip; close or scope-ambiguous hits remain separate previews.
  const indexMode=searchMode==='핵심어 색인';
  const indexPreview=indexMode&&result.dominant===true;
  // Several rules answer the question about equally: show the matching
  // articles of the closest few as unconfirmed previews instead of a bare list.
  const expandPreview=indexMode&&!indexPreview&&maxRules===1&&!explicitLawId;
  if(!explicitLawId && maxRules===1 && selection.status!=='unique' && !indexMode) {
    const titleUnmatched=selection.matchType==='none';
    const message=titleUnmatched
      ?`제목이 '${keyword}'에 해당하는 규정은 없습니다. 아래는 ${searchMode==='제목'?'제목에':'본문에'} '${queryUsed}' 검색어가 나오는 규정 후보입니다. 질문에 맞는 규정을 확인한 뒤 law_id로 선택하세요.`
      :'여러 규정 후보가 있습니다. 제목과 적용범위를 확인한 뒤 law_id로 선택하세요.';
    const describe=x=>`- ${x.title} (LAW_ID ${x.lawId}, 개정 ${x.revisedAt||'미상'})`+(x.matchedTerms?` — 일치어: ${x.matchedTerms.join(', ')}${x.topArticle?` / ${x.topArticle}`:''}`:'');
    const rewrites=describeRewrites(result.rewrittenTerms);
    const text=`${message}\n\n`+candidates.map(describe).join('\n')+(rewrites?`\n\n규정 본문에 없는 단어는 짧은 형태로 바꿔 찾았습니다: ${rewrites}`:'');
    return failure('AMBIGUOUS_RULE',message,{text,details:{
      matchType:selection.matchType,searchMode,queryUsed,...(rewrites?{rewrittenTerms:result.rewrittenTerms}:{}),
      candidates:candidates.map(x=>({lawId:x.lawId,title:x.title,revisedAt:x.revisedAt,...(x.matchedTerms?{matchedTerms:x.matchedTerms,topArticle:x.topArticle}:{})})),
      campus:campusScope(campus),
    }});
  }
  const hits=(selection.status==='unique'?[selection.hit]:indexMode?result.hits:rankRuleHits(result.hits,keyword)).slice(0,expandPreview?INDEX_PREVIEW_RULES:maxRules);
  if(indexMode&&result.keywordInfo?.questionRuleKept&&!hits.some(hit=>hit.lawId===result.keywordInfo.questionRuleKept)) result.keywordInfo.questionRuleKept=null;
  const indexMulti=indexMode&&hits.length>1;
  if(indexMulti){maxSections=Math.min(maxSections,3);maxChars=Math.min(maxChars,6000);}
  const identityStatus=catalogRule?'catalog_title':explicitLawId?'explicit_id':selection.status==='unique'?'exact_title':'candidate_preview';
  const metrics=searchResultMetrics(result);
  const rawTerms=Array.isArray(terms)?terms.join(', '):String(terms || '');
  // Explicit excerpt conditions take precedence over candidate-search words.
  // Only derived conditions expand vocabulary, retaining structural selectors.
  // The rule was identified by its name and the rest of the question is in `terms`.
  const namedRule=selection.status==='unique'&&autoTerms&&validStr(rawTerms)&&hits.length===1&&rawTerms!==keyword;
  // Keywords also choose the articles of a rule picked by its name or its law_id.
  const keyedRule=!indexMode&&autoTerms&&keywordPhrases.length>0&&hits.length===1;
  const focusQuestion=namedRule?rawTerms:scopeQuery;
  const focus=namedRule||keyedRule?focusWithinRule(hits[0].lawId,focusQuestion,keywordPhrases,await questionSemantics(focusQuestion,keywordPhrases,{asOf})):null;
  const keywordInfo=keywordPhrases.length?(indexMode?result.keywordInfo:focus?.keywordInfo)||{used:[],missing:[],rewritten:{},applied:false}:null;
  const keywordSelectors=keywordPhrases.length?[...articleSelectors(String(keywords)),...appendixSelectors(String(keywords))]:[];
  // The question's own words stay (an appendix may hold words the index lacks); rule vocabulary is added.
  // Topic words sent as terms beside a rule_keyword that names no rule: the excerpt keeps those
  // terms and also gets the vocabulary and articles the index chose, as for keywords.
  const topicTerms=indexMode&&!autoTerms&&!!topicAsRuleKeyword&&!articleSelectors(rawTerms).length&&!appendixSelectors(rawTerms).length;
  const effectiveTerms=focus ? [...new Set([...(namedRule?[rawTerms]:[]),...focus.searchTerms,...keywordSelectors])].join(', ')
    : indexMode&&autoTerms
    ? [...new Set([...result.searchTerms,...articleSelectors(rawTerms||keyword),...appendixSelectors(rawTerms||keyword),...keywordSelectors])].join(', ')
    : topicTerms ? [...new Set([rawTerms,...result.searchTerms])].join(', ')
    : rawTerms;
  let out=`# 통합 규정 조회: '${keyword}'\n\n` +
    `> ${asOf ? `기준일 ${asOf}의 개정일 기준 후보를 조회했습니다. 시행일·경과조치를 확인하세요.` : '연혁의 최신 개정본을 조회했습니다(연혁 캐시 최대 10분).'} 원문 유형과 누락 경고를 확인하세요.\n\n` +
    `- 검색 방식: ${searchMode}${result.semantic||focus?.semantic?' + 의미검색(조문 임베딩)':''}\n` +
    (queryUsed!==keyword?`- 정규화 검색어: ${queryUsed}\n`:``) +
    `- 원문 집계 / 고유 후보: ${result.total}건 / ${metrics.uniqueRows}건\n` +
    `- 선택 규정: ${hits.length}건\n`+
    (topicAsRuleKeyword?`- rule_keyword '${topicAsRuleKeyword}'은(는) 규정명과 일치하지 않아 핵심어로 쓰고 질문으로 규정을 찾았습니다. 규정명을 정확히 알 때만 rule_keyword에 넣으세요.\n`:'') +
    (keywordInfo?`- 핵심어(keywords): ${keywordInfo.applied?`${keywordInfo.used.join(', ')} 적용`:'규정 본문에서 찾지 못해 질문만으로 조회'}${keywordInfo.missing?.length?` / 어느 규정에도 없는 핵심어: ${keywordInfo.missing.join(', ')}`:''}${keywordInfo.questionRuleKept?' / 질문만으로 고른 규정도 함께 표시':''}\n`:'') +
    (result.indexedAt?`- 색인 기준: ${result.indexedAt}${result.stale?' (8일 초과, 현행 개정본은 다시 확인함)':''}${result.missingTerms?.length?` / 어느 규정에도 없는 단어: ${result.missingTerms.join(', ')}`:''}${describeRewrites(result.rewrittenTerms)?` / 짧게 바꿔 찾은 단어: ${describeRewrites(result.rewrittenTerms)}`:''}\n`:'');
  const editionNote=hit=>hit.editions?.length?` 같은 규정의 다른 판: ${hit.editions.map(x=>`${x.title}(LAW_ID ${x.lawId})`).join(', ')}.`:'';
  if(identityStatus==='candidate_preview') out+=indexMulti
    ?`\n> 질문에 맞는 규정이 하나로 정해지지 않아, 질문의 핵심어가 많이 나오는 규정 ${hits.length}개의 해당 조문을 함께 보여 줍니다. 적용할 규정이 확정된 결과가 아닙니다. 제목과 적용범위를 확인하고 law_id로 다시 조회하세요.${result.hits.slice(hits.length,hits.length+3).length?` 그 밖의 후보: ${result.hits.slice(hits.length,hits.length+3).map(x=>`${x.title}(LAW_ID ${x.lawId})`).join(', ')}.`:''}\n`
    :indexPreview
    ?`\n> 질문의 핵심어(${result.hits[0].matchedTerms.join(', ')})가 가장 많이 나오는 규정의 미리보기입니다. 적용할 규정이 확정된 결과가 아닙니다. 다른 후보: ${result.hits.slice(1,4).map(x=>`${x.title}(LAW_ID ${x.lawId})`).join(', ')||'없음'}.${editionNote(result.hits[0])} 제목과 적용범위를 확인하고 law_id로 다시 조회하세요.\n`
    :'\n> 규정 후보의 미리보기입니다. 적용할 규정이 확정된 결과가 아닙니다. 제목과 적용범위를 확인하고 law_id로 다시 조회하세요.\n';

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
    let markdown, sourceType='원문 HWP(별표 포함)', warning='', warningData=null, originalCoverage=null;
    try{
      const original=await cached('original-structure-v2',`${lawId}_${historyId}`,TTL.content,
        ()=>getOriginalContent(historyId));
      markdown=original.markdown;
      originalCoverage=original.structure?.coverage||null;
    }catch(e){
      const html=await cached(CONTENT_CACHE,`${lawId}_${historyId}`,TTL.content,
        ()=>getContent(lawId,historyId));
      markdown=html.markdown;
      sourceType='HTML 본문';
      warning=`\n- 주의: HWP 원문 파싱 실패로 HTML 본문을 사용했습니다. 별표가 누락될 수 있습니다. (${e.message})`;
      warningData={code:'HWP_FALLBACK',message:e.message};
    }

    if(!validStr(markdown)) return failure('CONTENT_UNAVAILABLE', 'HWP 원문과 HTML 대체 본문에서 규정 내용을 확인할 수 없습니다.', {
      details:{lawId,historyId,sourceType,warning:warningData},
    });
    const noSelectors=!articleSelectors(rawTerms||keyword).length&&!appendixSelectors(rawTerms||keyword).length&&!keywordSelectors.length;
    const preferredArticles=!noSelectors?[]:focus?focus.priorityArticles:indexMode&&(autoTerms||topicTerms)?hit.priorityArticles:[];
    const excerpt=extractRelevantBlocks(markdown,effectiveTerms,{
      maxBlocks:maxSections,maxChars,...(indexMode||focus?{order:'relevance'}:{}),
      ...(preferredArticles.length?{priorityArticles:preferredArticles}:{}),
    });
    let historyText='';
    let history=[];
    if(includeHistory){
      history=await cached('history',String(lawId),TTL.history,()=>getHistory(lawId));
      history=history.slice(0,5);
      historyText=history.map(x=>`${x.revisedAt || '날짜 미상'} (HISTORY_ID ${x.historyId})`).join(', ');
    }
    const incompleteReasons = [
      ...(warningData ? [warningData.code] : []),
      ...(originalCoverage?.status==='partial' ? ['HWP_STRUCTURE_PARTIAL'] : []),
      ...(!excerpt.text.trim() ? ['NO_MATCHING_EXCERPT'] : []),
      ...(excerpt.missingAppendices.length ? ['APPENDIX_NOT_FOUND'] : []),
      ...(excerpt.truncated ? ['EXCERPT_TRUNCATED'] : []),
      ...(excerpt.blocksTruncated ? ['EXCERPT_BLOCK_LIMIT'] : []),
      ...(identityStatus === 'candidate_preview' ? ['RULE_IDENTITY_UNCONFIRMED'] : []),
    ];
    const evidenceStatus=incompleteReasons.length?'partial':'retrieved';
    const sourceUrl=`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${historyId}`;
    out+=`\n\n## [${i+1}] ${hit.title}\n` +
      `- 분류: ${hit.code || '미상'}\n` +
      `- 조회 개정일: ${revisedAt || '확인 필요'}\n` +
      `- LAW_ID / HISTORY_ID: ${lawId} / ${historyId}\n` +
      `- 원문 유형 (sourceType): ${sourceType}\n` +
      `- 근거 조회 상태 (evidenceStatus): ${evidenceStatus}\n` +
      (incompleteReasons.length ? `- 일부 확인 필요 사유 (incompleteReasons): ${incompleteReasons.join(', ')}\n` : '') +
      `- 원문: ${sourceUrl}` +
      (hit.editions?.length?`\n- 같은 규정의 다른 판: ${hit.editions.map(x=>`${x.title}(LAW_ID ${x.lawId})`).join(', ')}`:'') +
      (hit.scopeNameOnly?'\n- 일치 근거: 기관·캠퍼스 이름만 일치합니다. 질문의 주제어가 나오는 조문은 색인에서 찾지 못했습니다(별표·서식은 색인 범위 밖).':'') +
      (hit.selectedBy==='question'?'\n- 선택 근거: 핵심어가 아니라 질문 문장으로 고른 규정입니다.':'') +
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

    if(excerpt.missingAppendices.length) out+=`\n\n> 요청한 ${excerpt.missingAppendices.join(', ')}의 본체를 조회 본문에서 찾지 못했습니다. 본문의 참조 문구만으로 별표 내용이 확인된 것은 아닙니다. 사이트의 별도 첨부는 직접 확인해야 합니다.`;
    if(incompleteReasons.length) out+='\n\n> 근거 조회 상태: 일부 확인 필요. 원문 유형·발췌 누락·잘림과 규정 선택 상태를 확인하세요.';
    rules.push({
      ...hit,lawId,historyId,revisedAt,sourceType,sourceUrl,history,
      latestHistoryId:latest.historyId,selectionBasis:asOf?'revision_date':'latest_revision',targetDate:asOf,
      applicability:'requires_enforcement_review',
      enforcementDates:extractEnforcementDates(markdown).map(x=>x.iso),
      warning:warningData,
      evidenceStatus,incompleteReasons,originalCoverage,
      excerpt:{text:excerpt.text,matchedTerms:excerpt.matchedTerms,blockCount:excerpt.blockCount,truncated:excerpt.truncated,omittedBlockCount:excerpt.omittedBlockCount,blocksTruncated:excerpt.blocksTruncated,charactersTruncated:excerpt.charactersTruncated,missingAppendices:excerpt.missingAppendices},
    });
  }
  return success(out,{
    query:{keyword,queryUsed,variants,terms:rawTerms,effectiveTerms,...(keywordInfo?{keywords:keywordPhrases.map(phrase=>phrase.join(' '))}:{}),...(topicAsRuleKeyword?{ruleKeywordUsedAsKeyword:topicAsRuleKeyword}:{}),campus,maxRules,maxSections,maxChars,includeHistory},
    search:{mode:searchMode,sourceTotal:result.total,...metrics,identityStatus,...(keywordInfo?{keywords:keywordInfo}:{}),
      ...(focus?.semantic?{semantic:true}:{}),
      ...(indexMode?{semantic:!!result.semantic,selection:indexMulti?'multiple_candidates':'single_candidate',searchTerms:result.searchTerms,
        otherCandidates:result.hits.slice(hits.length,hits.length+3).map(x=>({lawId:x.lawId,title:x.title,matchedTerms:x.matchedTerms,topArticle:x.topArticle}))}:{})},
    rules,
    evidenceStatus:rules.some(rule=>rule.evidenceStatus==='partial')?'partial':'retrieved',
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
    return failure('INVALID_ARGUMENT', 'article은 48, "제48조", "제10조의2", "부칙 제2조", "부칙(2024.8.27.) 제1조" 형식이어야 합니다.');
  }
  const history=await cached('history',String(lawId),TTL.history,()=>getHistory(lawId));
  const toHistoryId=rawToHistoryId?toId(rawToHistoryId):history[0]?.historyId;
  if(!toHistoryId) return failure('INVALID_ARGUMENT', 'to_history_id는 양의 정수여야 하며, 생략 시 최신 연혁을 조회할 수 있어야 합니다.');
  const fromEntry=history.find(x=>x.historyId===fromHistoryId);
  const toEntry=history.find(x=>x.historyId===toHistoryId);
  if(!fromEntry || !toEntry) return failure('HISTORY_NOT_FOUND', '비교할 HISTORY_ID가 해당 규정의 연혁에 없습니다.', {
    details:{lawId,fromHistoryId,toHistoryId},
  });
  const [beforeOriginal,afterOriginal,beforeHtml,afterHtml]=await Promise.all([
    cached('original-structure-v2',`${lawId}_${fromHistoryId}`,TTL.content,()=>getOriginalContent(fromHistoryId)).catch(()=>null),
    cached('original-structure-v2',`${lawId}_${toHistoryId}`,TTL.content,()=>getOriginalContent(toHistoryId)).catch(()=>null),
    cached(CONTENT_CACHE,`${lawId}_${fromHistoryId}`,TTL.content,()=>getContent(lawId,fromHistoryId)).catch(()=>null),
    cached(CONTENT_CACHE,`${lawId}_${toHistoryId}`,TTL.content,()=>getContent(lawId,toHistoryId)).catch(()=>null),
  ]);
  maxChanges=clampNumber(maxChanges,20,1,50);
  const {compareEvidence,formatEvidence}=require('./comparison-evidence.js');
  const result=compareEvidence({beforeOriginal,afterOriginal,beforeHtml,afterHtml,article,maxChanges,includeAppendices});
  if(result.error) return failure(result.error,result.error==='NOT_FOUND'
    ?'선택한 조문이 두 개정본 모두에 없습니다.'
    :'비교할 조문을 확인할 수 없습니다. 원본 HWP와 HTML 본문을 확인하세요.');
  const title=afterHtml?.title||beforeHtml?.title||`LAW_ID ${lawId}`;
  const {comparison,...evidence}=result;
  return success(formatEvidence(result,{title:`${title} (${fromHistoryId} → ${toHistoryId})`,fromHistoryId,toHistoryId,maxChanges}),{
    lawId,title,fromHistoryId,toHistoryId,...evidence,
    fromRevisedAt:fromEntry?.revisedAt||'',toRevisedAt:toEntry?.revisedAt||'',
    article:comparison.article,counts:comparison.counts,changes:comparison.changes.slice(0,maxChanges),
    source:{fromUrl:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${fromHistoryId}`,
      toUrl:`${FULLVIEW_URL}?SEQ=${lawId}&SEQ_HISTORY=${toHistoryId}`,returnedAt:new Date().toISOString()},
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
      const c=await cached(CONTENT_CACHE,`${lawId}_${historyId}`,TTL.content,()=>getContent(lawId,historyId));
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
    return failure('INVALID_ARGUMENT', 'article은 48, "제48조", "제10조의2", "부칙 제2조", "부칙(2024.8.27.) 제1조" 형식이어야 합니다.');
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
  const c=await cached(CONTENT_CACHE,`${lawId}_${picked.historyId}`,TTL.content,()=>getContent(lawId,picked.historyId));
  if(!c.markdown) return failure('CONTENT_UNAVAILABLE', `적용 개정본 본문을 가져올 수 없습니다 (LAW_ID ${lawId} / HISTORY_ID ${picked.historyId}).`);
  const title=c.title||matched?.title||`LAW_ID ${lawId}`;

  let bodyText=c.markdown, selectedArticles=[];
  if(hasArticle){
    const extracted=extractArticleSections(c.markdown,article);
    if(extracted.error) return failure(extracted.error,ambiguousArticleMessage(extracted.sections),{details:{candidates:extracted.sections.map(x=>({article:x.canonical,supplementaryHeading:x.supplementaryHeading,selector:supplementarySelector(x)}))}});
    if(!extracted.text) return failure('NOT_FOUND', `${extracted.selector.label}를 기준일 적용본에서 찾을 수 없습니다. get_rule_toc로 목차를 확인하세요.`, {
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
    const latest=await cached(CONTENT_CACHE,`${lawId}_${res.latest.historyId}`,TTL.content,()=>getContent(lawId,res.latest.historyId));
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

async function lookupFinanceRules(requests,context){
  const results=[];
  for(const request of requests.slice(0,8)){
    try{
      let response;
      if(request.article&&context.base_date) response=serializeOutcome('applicable_rule',await hApplicableRule({rule_keyword:request.keyword,date:context.base_date,article:request.article,compare_with_current:false}));
      else {
        response=serializeOutcome('lookup_dongguk_rule',await hLookup(request.keyword,{terms:request.terms,maxChars:7000,asOf:context.base_date||undefined,campus:context.campus||'all'}));
        if(request.article&&response.structuredContent.ok){
          const matched=response.structuredContent.data?.rules||[];
          if(matched.length===1)response=serializeOutcome('get_rule_content',await hContent(matched[0].lawId,matched[0].historyId,{article:request.article}));
          else response=serializeOutcome('get_rule_content',failure('AMBIGUOUS_RULE','요청한 규정 조문의 대상을 하나로 정할 수 없습니다.'));
        }
      }
      response.requested_reference=request;
      results.push(response);
    }
    catch(error){results.push(serializeException('lookup_dongguk_rule',error));}
  }
  // A child lookup that is itself partial keeps the batch partial.
  return summarizeRuleCoverage(results,requests,8);
}

async function hReviewFinanceCase(args){
  const result=await reviewFinanceCase(args,{searchHandbook,selectPractice,queryLegalReferences,lookupRules:lookupFinanceRules,
    verifyCitations:async(text,campus)=>serializeOutcome('verify_rule_citations',await hVerifyCitations(text,{campus})),
  });
  if(result.error)return failure(result.error,result.message);
  return success(formatFinanceReview(result),result);
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
  const [ruleCoverage,legal]=await Promise.all([
    lookupFinanceRules(context.rule_requests,context),
    context.legal_requests.length ? queryLegalReferences(context.legal_requests,{baseDate:context.base_date})
      .catch(()=>({status:'unavailable',code:'LEGAL_LOOKUP_FAILED',results:[]}))
      : Promise.resolve({status:'not_required',results:[]}),
  ]);
  const rules=ruleCoverage.results;
  const freshness=rules.flatMap((x,i)=>(x.structuredContent.data?.rules||[]).map(r=>({
    law_id:r.lawId,baseline_history_id:context.rule_requests[i]?.baseline_history_id||null,
    latest_history_id:r.latestHistoryId,selected_history_id:r.historyId,
    status:context.rule_requests[i]?.baseline_history_id ? (context.rule_requests[i].baseline_history_id===r.latestHistoryId?'unchanged':'revision_changed'):'baseline_missing',
    meaning:'개정본 식별자 비교입니다. 해당 업무 조항의 실질 변경을 의미하지 않습니다.'
  })));
  const partial=ruleCoverage.status!=='retrieved'||legal.status==='unavailable'||legal.status==='partial';
  return success(`# ${context.workflow.title} 근거 확인\n\n조회상태: ${partial?'일부 확인 필요':'조회됨'}\n\n${context.notice}\n\n## 교내 규정 근거\n\n${rules.map(r=>r.content[0].text).join('\n\n')}\n\n${formatLegalEvidence(legal)}`,{
    context,rules,rule_coverage:ruleCoverage,legal,freshness,legal_date_scope:legal.scope||'거래 기준일에 따른 조회 상태를 출처별로 확인하세요.',evidence_status:partial?'partial':'retrieved',applicability:'requires_review',retrieved_at:new Date().toISOString(),
  });
}

function normalizeLookupArguments(args={},catalog=null) {
  const query=validStr(args.query) || '';
  const explicitKeyword=validStr(args.rule_keyword) || '';
  const ruleName=ruleNameFromQuery(query);
  // A title written with spaces ("등록금에 관한 시행세칙") is recognized from the
  // current list; the bare-name pattern alone sees only its last word.
  const listed=!explicitKeyword&&!args.law_id&&catalog?titleInQuery(query,catalog):null;
  const useListed=listed&&listed.title.replace(/\s+/g,'').length>ruleName.replace(/\s+/g,'').length;
  const name=explicitKeyword || (useListed?listed.title:ruleName);
  // The rule's own name must not rank its articles: "이 개정 취업규칙은…" is in every 부칙.
  const derivedTerms=name?withoutRuleName(query,name):query;
  return {
    keyword:name || query,
    terms:validStr(args.terms) || derivedTerms,
    autoTerms:!validStr(args.terms),
    catalogRule:useListed&&listed.rules.length===1?listed.rules[0]:null,
  };
}

// === MCP 서버 팩토리 (stdio: 1회 / HTTP: 요청당 1회 — stateless) ===
function createServer({profile=PROFILE}={}) {
profile=normalizeProfile(profile);
const server = new Server({ name:'dongguk-rule-mcp', version:VERSION }, { capabilities:{tools:{}}, instructions:DISCLAIMER });

server.setRequestHandler(ListToolsRequestSchema, async ()=>({ tools:[
  {name:'get_service_info', title:'동국 규정 MCP 서비스 정보',description:'동국 규정 MCP 버전·공통/내부 기능 범위·캠퍼스 검색 한계·입력 안내를 확인합니다.',inputSchema:{type:'object',properties:{}},outputSchema:TOOL_OUTPUT_SCHEMA,annotations:{readOnlyHint:true}},
  {name:'get_finance_context', title:'재무 업무 검토 안내',description:'재무팀 출장·강사료·소득정정 질문을 판단카드·필수 사실·법령/규정 조회 경로·처리절차·완료증빙으로 연결합니다. 실제 신고·지급은 수행하지 않습니다.',inputSchema:{type:'object',properties:{query:{type:'string'},facts:{type:'object'},workflow_id:{type:'string'}},required:['query']},annotations:{readOnlyHint:true},outputSchema:TOOL_OUTPUT_SCHEMA},
  {name:'get_finance_evidence', title:'재무 업무 근거 조회',description:'재무지식 팩이 지정한 교내 규정과 국가 법령 식별자를 실조회해 사전검토용 근거 묶음을 반환합니다. 각 출처의 조회 성공과 적용 판단은 구분합니다.',inputSchema:{type:'object',properties:{query:{type:'string'},facts:{type:'object'},workflow_id:{type:'string'}},required:['query']},annotations:{readOnlyHint:true},outputSchema:TOOL_OUTPUT_SCHEMA},
  {name:'search_finance_handbook', title:'재무 해설서 검색',description:'특례규칙 해설서의 계정과목·회계 개념·사례를 짧은 질문으로 검색합니다. 판본·원문 위치·추출 품질을 반환합니다. 법적 적용과 분개표 원문 검증은 별도입니다.',inputSchema:{type:'object',properties:{query:{type:'string',maxLength:200},limit:{type:'integer',minimum:1,maximum:5}},required:['query']},annotations:{readOnlyHint:true},outputSchema:TOOL_OUTPUT_SCHEMA},
  {name:'review_finance_case', title:'재무 사례 공동 검토',description:'출장비·외부 강사료의 교내 규정과 한국법령을 자동 연계하는 기본 도구. 확인한 기준일·캠퍼스·회계·대상 조건을 facts로 전달하세요. 필요한 사실이 없으면 먼저 질문하며 지원 범위 밖 급여·연금·국외 강연·비거주자 업무는 별도 조회가 필요합니다. 일반 교비 비용·계정·증빙·기안문 검토도 지원합니다. 부분 조회·적용 미확인을 지급 가능이나 소득구분 확정으로 해석하지 마세요.',inputSchema:{type:'object',properties:{query:{type:'string',maxLength:2000},text:{type:'string',maxLength:20000,description:'검토할 기안문 본문. 개인번호·계좌·인증정보 제외.'},facts:{type:'object',additionalProperties:false,properties:Object.fromEntries(Object.entries(require('./finance-desk.js').FACT_LABELS).map(([key,label])=>[key,{type:'string',maxLength:120,description:label}]))}},required:['query']},annotations:{readOnlyHint:true},outputSchema:TOOL_OUTPUT_SCHEMA},
  { name:'lookup_dongguk_rule', title:'동국 규정 통합 조회', description:'동국대학교 규정 질문의 기본·우선 도구. 규정 검색→최신 원문 HWP→관련 조문·원문 내 별표(금액표·주석 포함)를 한 번에 반환합니다. 보통은 query와 keywords 두 가지만 넣으세요. query에는 사용자의 질문을 그대로, keywords에는 그 질문을 규정 문장에 쓰이는 명사로 바꾼 핵심어를 넣습니다(예: 질문 "빌린 장비 잃어버리면 물어내야 해?" → keywords "물품, 분실, 변상"). keywords를 함께 넣으면 규정 용어로 더 정확히 찾습니다. 확신이 없으면 비워 두세요(query만으로도 찾습니다). rule_keyword는 규정의 정확한 이름을 알 때만, terms는 조문·별표 번호를 알 때만 쓰고, 주제어는 모두 keywords에 넣으세요. 별도 첨부 자동 조회·OCR은 미지원입니다. 근거가 충분하면 중복 조회를 생략하세요. partial이면 사유를 확인하고, 발췌 한도인 경우 max_sections·max_chars를 늘려 조회하세요. 모호한 후보·적용범위는 추가 확인이 필요합니다.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'선택 LAW_ID. 모호한 후보를 선택한 후 직접 원문·별표 조회'},
      query:{type:'string',description:'전체 자연어 질문. 사용자가 쓴 문장을 줄이지 말고 그대로 넣습니다. 캠퍼스·기관(WISE, 산학협력단, 대학원 등)은 여기서 읽습니다. 예: 대전 출장 가면 일비랑 숙박비 얼마 받아?'},
      keywords:{type:'string',maxLength:KEYWORDS_MAX_CHARS,description:'query와 함께 넣는 규정 용어 핵심어. 명사 2~6개를 쉼표로 구분합니다. 규정 고르기와 조문 고르기에 모두 쓰이며 query의 구어 표현보다 우선합니다. 고르는 요령: (1) 무엇에 관한 일인지 주제 명사와 대상(예: 물품, 계약, 휴학, 여비, 징계 / 직원, 교원, 학생). (2) 무엇을 묻는지 조문 제목에 나올 명사(예: 사유, 자격, 절차, 기간, 지급 기준, 제한, 신고, 위원회 구성). (3) 구어와 동사는 규정의 한자어 명사로 바꿉니다(잃어버리다→분실, 물어내다→변상, 계약을 끊다→계약 해지, 쉬다→휴학·휴직, 깎아 주다→감면, 돌려받다→반환). (4) 규정이 다르게 쓸 수 있는 같은 뜻의 말을 1~2개 더 넣습니다(예: 해지, 해제 / 분실, 망실). 문장·조사·동사와 "규정", "동국대" 같은 말은 넣지 않습니다. 맞는 말이 떠오르지 않으면 비워 두세요. 비우거나 규정에 없는 말이면 query만으로 찾습니다. 예: "휴학 사유, 기간", "계약 해지, 계약상대자, 불이행".'},
      rule_keyword:{type:'string',description:'규정의 정확한 이름을 알 때만 넣습니다(예: 여비규정, 취업규칙, 위임전결규정). 사용자가 규정명을 말하지 않았으면 비워 두세요. 주제어(예: 병가, 출장, 장학금)는 여기가 아니라 keywords에 넣습니다. query와 함께 보낸 값이 규정명과 일치하지 않으면 핵심어로 처리하고 query로 규정을 찾습니다.'},
      terms:{type:'string',description:'조문·별표 번호를 알 때만 넣는 발췌 조건. 예: 제10조, 제10조의2, 별표1. 명시하면 이 조건으로만 발췌하므로, 번호를 모르면 비워 두고 주제어는 keywords에 넣으세요. 생략하면 query와 keywords에서 발췌 조건을 만듭니다.'},
      campus:{type:'string',description:'업무 캠퍼스 맥락 all/seoul/wise. 공식 목록에는 캠퍼스 필터가 없어 전체 검색 후 적용범위를 확인합니다.',default:'all'},
      max_rules:{type:'number',description:'조회할 규정 수. 기본 1, 최대 3. 자연어 색인의 모호한 후보는 기본 1 요청에도 최대 3개 미확정 미리보기로 반환하며 selection은 실제 반환 개수를 따릅니다.',default:1},
      max_sections:{type:'number',description:'규정별 관련 블록 수. 기본 4, 최대 12. 자연어 색인의 다중 미리보기는 최대 3.',default:4},
      max_chars:{type:'number',description:'규정별 최대 반환 글자 수. 기본 12000, 최대 30000. 자연어 색인의 다중 미리보기는 최대 6000.',default:12000},
      include_history:{type:'boolean',description:'최근 개정 연혁 5건 포함 여부',default:false},
    }},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'search_rule', title:'규정 후보 검색', description:'규정 후보 목록만 필요할 때 사용하는 보조 도구. 일반적인 동국대학교 규정 질문은 lookup_dongguk_rule을 먼저 사용하세요.',
    inputSchema:{ type:'object', properties:{
      keyword:{type:'string',description:'검색어'},
      full_text:{type:'boolean',description:'전문검색 여부',default:false},
      limit:{type:'number',default:10}, offset:{type:'number',default:0},
      campus:{type:'string',description:'업무 캠퍼스 맥락 all/seoul/wise. 공식 목록에는 캠퍼스 필터가 없어 전체 검색 후 적용범위를 확인합니다.',default:'all'},
    }, required:['keyword']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'get_rule_content', title:'규정 조문 조회', description:'LAW_ID를 이미 알고 특정 조·장만 볼 때 사용하는 보조 도구. 관련 발췌는 lookup_dongguk_rule, 별표·서식을 포함한 전문은 get_rule_full_text를 사용하세요.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
      history_id:{type:'number',description:'HISTORY_ID (생략=최신)'},
      article:{oneOf:[{type:'number'},{type:'string'}],description:'특정 조문. 예: 48, 제48조, 제10조의2, 부칙 제2조, 부칙(2024.8.27.) 제1조(여러 부칙의 같은 번호는 개정일로 선택)'},
      chapter:{type:'number',description:'특정 장만'},
      grep:{type:'string',description:'키워드 포함 조문'},
      head:{type:'number',description:'상위 N줄'},
    }, required:['law_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'get_rule_full_text', title:'규정 전문 조회', description:'LAW_ID(선택 HISTORY_ID)로 규정 하나의 조문·부칙·별표·서식 텍스트 전문을 원문 순서로 조회합니다. HWP 우선, 실패 시 HTML 대체와 partial 사유를 표시합니다. 긴 전문은 textCoverage.nextArguments로 이어 받고 contentMarkdown만 순서대로 합치세요. 그림 OCR·원본 화면 배치·법적 적용성은 보증하지 않습니다.',
    inputSchema:{type:'object',properties:{
      law_id:{type:'integer',minimum:1,description:'LAW_ID'},
      history_id:{type:'integer',minimum:1,description:'HISTORY_ID (첫 요청 생략=최신, 이어받기는 cursor에 고정된 개정본)'},
      max_chars:{type:'integer',minimum:1000,maximum:60000,default:30000,description:'페이지당 최대 UTF-16 코드 단위 수. 메타데이터 제외'},
      cursor:{type:'string',description:'직전 응답 textCoverage.nextCursor. 직접 만들거나 수정하지 마세요.'},
    },required:['law_id'],additionalProperties:false},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'get_rule_toc', title:'규정 목차 조회', description:'규정 목차(장·절·조) 빠른 조회.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number'}, history_id:{type:'number'},
    }, required:['law_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'list_rule_history', title:'규정 개정 연혁', description:'규정 개정 연혁 목록 조회.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
    }, required:['law_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'compare_rule_versions', title:'규정 개정본 비교', description:'원본 HWP의 조문·별표와 표의 셀·병합 구조, 그림 파일 변경을 비교합니다. 원문 실패 시 HTML 대체 여부와 구체적인 추출 진단을 표시합니다. to_history_id 생략 시 최신 개정본입니다.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
      from_history_id:{type:'number',description:'비교 시작 HISTORY_ID'},
      include_appendices:{type:'boolean',description:'HWP 별표·서식의 텍스트·표 구조·그림도 비교(기본 true)',default:true},
      to_history_id:{type:'number',description:'비교 종료 HISTORY_ID. 생략하면 최신'},
      article:{oneOf:[{type:'number'},{type:'string'}],description:'선택 조문. 예: 제10조의2, 부칙 제2조'},
      max_changes:{type:'number',description:'본문에 표시할 최대 변경 조문 수. 기본 20, 최대 50',default:20},
    }, required:['law_id','from_history_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'verify_rule_citations', title:'규정 인용 검증', description:'기안문·품의서·공문·AI 답변 텍스트에 인용된 동국대학교 규정 조문을 실제 규정집과 대조 검증하는 환각 게이트. 「규정명」 제N조(제목) 제N항 표기를 추출해 규정 실존, 조문 실존(본칙 존재 범위 안내), 조문 제목 일치, 항 번호까지 확인합니다. 결재 전 인용 점검에 사용하세요. 규정 내용 질문에는 lookup_dongguk_rule을 사용하세요.',
    inputSchema:{ type:'object', properties:{
      text:{type:'string',description:'검증할 전체 텍스트 (20,000자 이하). 예: 품의서 본문'},
      campus:{type:'string',description:'업무 캠퍼스 맥락 all/seoul/wise. 공식 목록에는 캠퍼스 필터가 없어 전체 검색 후 적용범위를 확인합니다.',default:'all'},
    }, required:['text']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'applicable_rule', title:'기준일 규정 조회', description:'기준일(date) 이전에 개정된 동국대학교 규정 후보를 찾아, 해당 시점 본문과 현행 대비 변경 요약을 반환합니다. 소급 업무·감사 대응·과거 지급기준 확인용. HISTORY_ID를 몰라도 날짜만으로 조회됩니다. 개정일과 실제 시행일이 다를 수 있음을 항상 안내합니다. 최신 규정 질문에는 lookup_dongguk_rule을 사용하세요.',
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
  { name:'search_rule_deep', title:'여러 규정 전문 탐색', description:'여러 규정의 전문을 탐색해야 할 때만 사용하는 보조 도구. 단일 규정 질문에는 lookup_dongguk_rule을 사용하세요.',
    inputSchema:{ type:'object', properties:{
      query:{type:'string'}, top:{type:'number',default:3}, per_doc:{type:'number'},
      mode:{type:'string',enum:['auto','index','live'],default:'auto',description:'auto: 전문 색인이 있으면 색인, 없으면 공식 사이트 검색. index: 색인만. live: 공식 사이트 전문검색만(모든 단어 일치).'},
    }, required:['query']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'compare_university_rules', title:'타대학 규정 조문 비교',
    description:'동국대와 타대학의 같은 사안 조문을 나란히 발췌합니다. 법적 동등성을 판정하지 않습니다. 서버에서 DONGGUK_UNIVERSITY_COMPARISON_ENABLED=1 허용 필요. 등록된 사안(겸직·여비·연구비·등록금 반환·퇴직급여·근로장학·장학금)은 사안 프레임으로 조문을 고릅니다: 주체·행위·규율 요소(허가권자·기간·보수 등)의 문자열 대조로 같은 단어가 다른 뜻인 조문(교내 겸무의 "겸직" 등)을 제외하고, 대학별 주규정·보조규정을 가르고, 규율 요소 × 대학 표(slotMatrix)와 조문이 인용한 근거 법령 대조를 돌려줍니다. 미등록 주제는 주제어 일치 발췌만 제공합니다. 서울시립·국민·숭실·경희·숙명여대는 규정 제목 검색(대표어·제목 단서)으로 전담 규정을 먼저 찾은 뒤 전문검색(대표어·동의어)을 더하고, 건국·광운·명지는 공개 규정 트리의 제목 대조, 고려는 로그인 없이 공개된 규정(약 55개)의 분류 목록에서 제목을 대조하며 비공개 규정은 조회할 수 없습니다. 주제어는 「교내근로장학금」→「근로장학」처럼 접두어를 떼고 동의어로 넓힙니다. 대학별 최대 5개 규정, 전체 60초 제한입니다. 시행일은 목록 시행일자 또는 마지막 부칙 명시 시행일만 표시합니다. 미지원 대학·접속 실패·미발견을 구분합니다. 중앙대는 PDF 텍스트 레이어의 조문만 비교하며 표·별표·부록·서식·그림은 원문에서 확인해야 합니다. HTML 별표 누락 및 조문별 시행일·경과조치 미확인에 유의하세요.',
    inputSchema:{type:'object',properties:{
      topic:{type:'string',minLength:1,maxLength:100,description:'예: 여비, 겸직, 연구비, 등록금 반환, 퇴직급여, 근로장학, 장학금(사안 프레임 등록 주제). 그 밖의 주제는 주제어 일치만.'},
      universities:{type:'array',minItems:1,maxItems:5,items:{type:'string'},description:'타대학 키: korea(고려) uos(서울시립) konkuk(건국) kookmin(국민) ssu(숭실) khu(경희) sookmyung(숙명여대) kw(광운) mju(명지) sogang(서강) ewha(이화) snu(서울대·OC키 필요) yonsei(연세) cau(중앙·PDF 조문만) hongik(홍익) hanyang(한양) skku(성균관·PDF 조문만) sejong(세종·PDF 조문만) gachon(가천·문서 조문만). dongguk은 자동 포함. 다른 키는 unsupported로 표시.'},
      max_articles:{type:'integer',minimum:1,maximum:5,default:3}
    },required:['topic','universities']}, outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'check_rule_updates', title:'규정 개정 여부 일괄 점검', description:'여러 규정의 최신 개정본을 한 번에 확인합니다. law_ids와 이전 응답의 nextSnapshot(previous)을 주면 규정별로 개정됨·변동 없음·첫 확인을 구분하고, since(날짜)를 주면 그 날짜 이후 개정된 규정 목록을 반환합니다. 변경 내용은 compare_rule_versions로 이어서 확인하세요. 시행일·적용 여부는 판단하지 않습니다.',
    inputSchema:{ type:'object', properties:{
      law_ids:{type:'array',items:{type:'integer',minimum:1},minItems:1,maxItems:50,description:'점검할 LAW_ID 목록. 예: [184, 103, 180]'},
      previous:{type:'object',additionalProperties:{type:'integer',minimum:1},description:'이전 응답의 nextSnapshot. {LAW_ID: HISTORY_ID}'},
      since:{type:'string',description:'이 날짜 이후 개정된 규정 목록. YYYY-MM-DD'},
      limit:{type:'integer',minimum:1,maximum:50,default:50,description:'since 목록의 최대 건수'},
    }},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'get_rule_references', title:'규정 인용 관계 조회', description:'규정(또는 특정 조문)이 명시적으로 인용한 다른 교내 규정·국가 법령(outgoing)과, 이 규정을 인용하는 교내 규정(incoming, 전문 색인 필요)을 찾습니다. 국가 법령은 법령명·조문을 externalLaws로 정리합니다. include_law_text=true이면 인용된 법령 조문의 현행 원문(최대 3개 조문)을 한국법령 MCP에서 함께 가져옵니다. 인용의 존재와 적용 여부는 다릅니다.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
      article:{oneOf:[{type:'number'},{type:'string'}],description:'선택 조문. 예: 3, 제10조의2'},
      history_id:{type:'number',description:'HISTORY_ID (생략=최신). 인용 대상은 현행 목록과 대조합니다.'},
      direction:{type:'string',enum:['outgoing','incoming','both'],default:'outgoing'},
      limit:{type:'integer',minimum:1,maximum:50,default:30,description:'방향별 최대 표시 건수'},
      include_law_text:{type:'boolean',default:false,description:'true이면 인용된 국가 법령 조문의 현행 원문을 함께 가져옵니다(조문이 특정된 인용만, 최대 3개). 법령 서버가 응답하지 않아도 규정 인용 결과는 반환합니다.'},
    }, required:['law_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
  { name:'get_rule_upper_laws', title:'규정의 상위법령 관계', description:'동국대 규정(또는 한 조문)이 근거로 인용한 국가 법령을 현행 법령 목록과 대조합니다. 법령별로 현행 여부·종류·시행일, 인용한 조문이 지금도 있는지(삭제·없음), 옛 법령명 인용(제명 변경), 규정 개정 뒤 법령·조문 개정, 시행예정 개정을 점검 신호로 보여 줍니다. include_text=true이면 인용이 나온 규정 조문 원문(HTML)과 현행 법령 조문 원문을 나란히 붙이며 comparison에 연결 관계와 전달 범위를 제공합니다. 법령을 인용하지 않은 규정에는 제목으로 고른 주제 후보 법령을 따로 표시합니다. 점검 신호는 충돌·적용 여부의 판정이 아닙니다. 법령 연계가 꺼진 서버에서는 확인할 법령명·조문 목록을 제공하고 include_text=true이면 규정 원문과 법령 본문 미확보 상태를 함께 반환합니다.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
      article:{oneOf:[{type:'number'},{type:'string'}],description:'선택 조문. 예: 45, 제10조의2. 지정하면 그 조문의 인용만 보고 주제 후보는 생략합니다.'},
      history_id:{type:'number',description:'HISTORY_ID (생략=최신)'},
      include_text:{type:'boolean',default:false,description:'true이면 인용 규정 조문(조문당 6,000자·합계 24,000자)과 현행 법령 조문(조문당 3,000자)을 대조. 인용 24건까지, 누락·잘림은 partial'},
      include_candidates:{type:'boolean',default:true,description:'규정 제목으로 고른 주제 후보 법령 포함 여부'},
      max_laws:{type:'integer',minimum:1,maximum:12,default:8,description:'확인할 법령 수. 인용 법령이 주제 후보보다 먼저입니다.'},
    }, required:['law_id']},
    outputSchema:TOOL_OUTPUT_SCHEMA,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
].filter(t=>profile==='finance'||!FINANCE_TOOLS.has(t.name))}));

server.setRequestHandler(CallToolRequestSchema, async (req)=>withProfile(profile,async()=>{
  const name = req.params.name;
  const a = req.params.arguments || {};   // [하드닝] arguments 누락 방어
  try{
    // Some clients send the comma list as an array; it is checked as the same text.
    if(Array.isArray(a.keywords)&&a.keywords.every(item=>typeof item==='string')) a.keywords=a.keywords.join(', ');
    if(a.keywords!==undefined&&a.keywords!==null&&typeof a.keywords!=='string') return serializeOutcome(name,failure('INVALID_ARGUMENT','keywords는 쉼표로 구분한 문자열이어야 합니다. 예: "분실, 변상"'));
    if(typeof a.keywords==='string'&&a.keywords.length>KEYWORDS_MAX_CHARS) return serializeOutcome(name,failure('INVALID_ARGUMENT',`keywords는 ${KEYWORDS_MAX_CHARS}자 이내로 입력하세요. 핵심 명사 2~6개면 충분합니다.`));
    if(['query','keyword','rule_keyword','terms','keywords','text','grep','topic'].some(key=>typeof a[key]==='string'&&hasSensitiveInput(a[key]))) return serializeOutcome(name,failure('SENSITIVE_INPUT','개인번호·계좌·인증정보를 제거한 업무 질문만 입력하세요.'));
    for(const [key,min,max] of [['limit',1,50],['offset',0,500],['top',1,10],['per_doc',1,100],['head',1,10000]]){if(a[key]!==undefined&&(!Number.isInteger(a[key])||a[key]<min||a[key]>max))return serializeOutcome(name,failure('INVALID_ARGUMENT',`${key}는 ${min}~${max} 범위 정수여야 합니다.`));}
    if(a.include_appendices!==undefined&&typeof a.include_appendices!=='boolean')return serializeOutcome(name,failure('INVALID_ARGUMENT','include_appendices는 boolean이어야 합니다.'));
    if(profile!=='finance' && FINANCE_TOOLS.has(name)) return serializeOutcome(name,failure('TOOL_NOT_AVAILABLE','공통 규정 프로필에서는 내부 재무 기능을 제공하지 않습니다.'));
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
      case 'get_service_info': {
        const data={version:VERSION,profile,disclaimer:DISCLAIMER,toolCount:profile==='rules'?15:19,readOnly:true,source:'https://rule.dongguk.edu',campus:campusScope(),privacy:{privateKnowledge:profile==='finance',authenticatedUpstream:profile==='finance'&&!!requestCookie()},limits:{historyCacheSeconds:600,contentScope:'원본 HWP 조문·별표, 셀 위치·병합 구조, 그림 파일 해시 비교. OCR·화면 배치·법적 적용성 제외. 문서별 추출 진단 제공.'},usage:['평소처럼 규정 조회나 업무 검토를 요청하세요. 적용 판단에 필요한 사실만 추가로 확인합니다.','규정·법령·해설의 원문 위치와 조회일을 함께 인용하세요.','개인번호·계좌·인증정보를 입력하지 마세요.']};
        data.integrations={koreanLaw:{configured:profile==='finance'&&process.env.DONGGUK_LEGAL_MCP_ENABLED==='1'&&Boolean(process.env.DONGGUK_LEGAL_MCP_TRANSPORT==='streamable-http'?process.env.DONGGUK_LEGAL_MCP_URL:process.env.LAW_OC),transport:profile==='finance'?(process.env.DONGGUK_LEGAL_MCP_TRANSPORT||'stdio'):null},jointWorkflows:profile==='finance'?['travel_expenses','external_honoraria']:[]};
        data.fullText={tool:'get_rule_full_text',defaultMaxChars:30000,maxChars:60000,continuation:'textCoverage.nextArguments',source:'HWP first; HTML fallback is partial',images:'no OCR'};
        data.fullTextIndex=indexStatus();
        data.integrations.universityComparison={configured:process.env.DONGGUK_UNIVERSITY_COMPARISON_ENABLED==='1',tool:'compare_university_rules',totalTimeoutMs:require('./university-rules').TOTAL_TIMEOUT_MS,issueFrames:require('./university-rules').FRAMES.map(f=>({topic:f.topic,label:f.label,slots:f.slots.length}))};
        data.integrations.lawLink={configured:lawLinkConfigured(profile),tool:'get_rule_references',argument:'include_law_text',upperLawTool:'get_rule_upper_laws',upperLawComparison:{argument:'include_text',response:'comparison',ruleSource:'HTML 본문',lawSource:'현행 법령 조문',...require('./upper-law-comparison').LIMITS}};
        data.privacy.privatePacksConfigured=profile==='finance'&&['DONGGUK_FINANCE_PACK_PATH','DONGGUK_HANDBOOK_PACK_PATH','DONGGUK_PRACTICE_PACK_PATH'].some(key=>Boolean(process.env[key]));
        r=success([
          '동국 규정 MCP 서비스 정보',
          '',
          '- version: '+data.version,
          '- profile: '+data.profile,
          '- toolCount: '+data.toolCount,
          '- 규정 전문·별표: get_rule_full_text (긴 전문은 textCoverage.nextArguments로 이어받기)',
          '- 상위법령 조문 대조: get_rule_upper_laws(include_text=true), comparison에 규정 원문과 현행 법령 조문 연결 제공',
          '- readOnly: '+data.readOnly,
          '- source: '+data.source,
          '- koreanLawConfigured: '+data.integrations.koreanLaw.configured+' (설정 여부이며 실제 연결 검증은 별도)',
          '- jointWorkflows: '+(data.integrations.jointWorkflows.join(', ')||'없음'),
          '- privatePacksConfigured: '+data.privacy.privatePacksConfigured,
          '- fullTextIndex: '+(data.fullTextIndex.available?`${data.fullTextIndex.indexedRules}/${data.fullTextIndex.totalRules}개 규정, ${data.fullTextIndex.indexedAt}${data.fullTextIndex.stale?' (오래됨)':''}`:'없음(공식 사이트 검색 사용)'),
          '',
          '공식 목록에는 캠퍼스 필터가 없습니다. 캠퍼스·직군별 적용은 규정 제목과 적용범위 조문을 확인하세요.',
          '',
          '※ '+DISCLAIMER,
        ].join('\n'),data);
        break;
      }
      case 'get_finance_context': r=getFinanceContext(a.query,a.facts,a.workflow_id); break;
      case 'get_finance_evidence': r=await hFinanceEvidence(a); break;
      case 'search_finance_handbook': {const result=searchHandbook(a.query,{limit:a.limit});r=['ok','no_match'].includes(result.status)?success(result.results.map(x=>`${x.heading}\n${x.excerpt}`).join('\n\n')||'해당 해설을 찾지 못했습니다.',result):failure('HANDBOOK_'+result.status.toUpperCase(),result.notice||'해설서 조회를 완료하지 못했습니다.');break;}
      case 'review_finance_case': r=await hReviewFinanceCase(a); break;
      case 'lookup_dongguk_rule': {
        let catalog=null, input=a, topicAsRuleKeyword=null;
        // A rule_keyword sent with a question must be a rule's name. A topic word there ("병가") would be
        // searched as a title and end in a list of candidates, so it joins the keywords and the question leads.
        if(validStr(a.rule_keyword)&&validStr(a.query)&&!a.law_id&&indexStatus().available&&!requestCookie()){
          try{catalog=await loadCatalog();}catch{}
          const identity=catalog&&selectRuleCandidate(catalog,validStr(a.rule_keyword));
          // A shortened rule name ("인사규정 시행세칙") that fits one title keeps the rule-name path. A bare topic
          // word that happens to sit in one title ("기숙사", "취업") is still a topic word and goes to the index.
          // Only a name the title contains counts; a longer name that merely contains a title is not that rule.
          if(identity?.matchType==='partial'&&identity.candidates.length===1&&RULE_NAME_SUFFIX.test(String(a.rule_keyword).replace(/\s+/g,''))
            &&normalizeText(identity.candidates[0].title).includes(normalizeText(validStr(a.rule_keyword)))){
            input={...a,rule_keyword:identity.candidates[0].title};
          } else if(identity&&identity.matchType!=='exact'){
            topicAsRuleKeyword=validStr(a.rule_keyword);
            // Topic words sent as terms help choose the rule too; terms with an article or appendix number stay excerpt-only.
            const terms=validStr(a.terms), topicTerms=terms&&!articleSelectors(terms).length&&!appendixSelectors(terms).length?terms:null;
            input={...a,rule_keyword:undefined,keywords:[validStr(a.keywords),topicAsRuleKeyword,topicTerms].filter(Boolean).join(', ').slice(0,KEYWORDS_MAX_CHARS)};
          }
        }
        // Only a question with several words can hide a spaced title; a failed list read falls back to the name pattern.
        if(!catalog&&!validStr(input.rule_keyword)&&!input.law_id&&/\s/.test(validStr(input.query)||'')){try{catalog=await loadCatalog();}catch{}}
        const normalized=normalizeLookupArguments(input,catalog);
        r=await hLookup(normalized.keyword,{
          terms:normalized.terms,autoTerms:normalized.autoTerms,scopeQuery:validStr(input.query)||normalized.keyword,campus:input.campus,maxRules:input.max_rules,maxSections:input.max_sections,
          maxChars:input.max_chars,includeHistory:input.include_history,explicitLawId:input.law_id||normalized.catalogRule?.lawId,catalogRule:normalized.catalogRule,
          keywords:input.keywords,topicAsRuleKeyword,
        });
        break;
      }
      case 'compare_university_rules': {
        if(process.env.DONGGUK_UNIVERSITY_COMPARISON_ENABLED!=='1'){r=failure('NOT_CONFIGURED','타대학 비교는 서버 운영자가 DONGGUK_UNIVERSITY_COMPARISON_ENABLED=1로 켠 경우에만 외부 요청을 수행합니다.');break;}
        const invalid=validateComparison(a);
        if(invalid){r=failure('INVALID_ARGUMENT',invalid);break;}
        const data=await compareUniversityRules(a,{loadDongguk:loadDonggukComparison});
        r=success(formatComparison(data),data);break;
      }
      case 'search_rule': r=await hSearch(a.keyword,{fullText:a.full_text,limit:a.limit,offset:a.offset,campus:a.campus}); break;
      case 'get_rule_content': r=await hContent(a.law_id,a.history_id,{article:a.article,chapter:a.chapter,grep:a.grep,head:a.head}); break;
      case 'get_rule_full_text': r=await require('./full-text').getRuleFullText(a,{
        resolve,
        loadOriginal:(lawId,historyId)=>cached('original-structure-v2',`${lawId}_${historyId}`,TTL.content,()=>getOriginalContent(historyId)),
        loadHtml:(lawId,historyId)=>cached(CONTENT_CACHE,`${lawId}_${historyId}`,TTL.content,()=>getContent(lawId,historyId)),
      }); break;
      case 'get_rule_toc': r=await hToc(a.law_id,a.history_id); break;
      case 'list_rule_history': r=await hHistory(a.law_id); break;
      case 'compare_rule_versions': r=await hCompareVersions(a.law_id,a.from_history_id,a.to_history_id,{article:a.article,maxChanges:a.max_changes,includeAppendices:a.include_appendices}); break;
      case 'verify_rule_citations': r=await hVerifyCitations(a.text,{campus:a.campus}); break;
      case 'applicable_rule': r=await hApplicableRule(a); break;
      case 'search_rule_deep': r=await hDeep(a.query,{top:a.top,perDoc:a.per_doc,mode:a.mode}); break;
      case 'check_rule_updates': r=await hCheckUpdates(a); break;
      case 'get_rule_references': r=await hReferences(a.law_id,{article:a.article,historyId:a.history_id,direction:a.direction,limit:a.limit,includeLawText:a.include_law_text}); break;
      case 'get_rule_upper_laws': r=await hUpperLaws(a.law_id,{article:a.article,historyId:a.history_id,includeText:a.include_text,includeCandidates:a.include_candidates,maxLaws:a.max_laws}); break;
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
  const {parseWarmRules,startWarmup}=require('./warmup.js');
  const warmRules=noCache()?[]:parseWarmRules(process.env.DONGGUK_MCP_WARM_RULES||'');
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
    rateLimitPerMinute:Number(process.env.DONGGUK_MCP_RATE_LIMIT_PER_MINUTE??60),
    rateLimitPerDay:Number(process.env.DONGGUK_MCP_RATE_LIMIT_PER_DAY??1000),
    trustProxy:process.env.DONGGUK_MCP_TRUST_PROXY!=='0',
    allowedOrigins:(process.env.DONGGUK_MCP_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean),
  });
  let warmer;
  const baseStatus=server.getStatus.bind(server);
  server.getStatus=()=>({...baseStatus(),cacheWarmup:warmer?.getStatus()||{enabled:false,ruleCount:0}});
  server.listen(HTTP_PORT,HTTP_HOST,()=>{
    console.error(`dongguk-rule-mcp v${VERSION} HTTP 시작 (${PROFILE}, ${HTTP_HOST}:${HTTP_PORT})`);
    if(!noCache()&&warmSemantic(publicCacheDir())) console.error('의미검색: 임베딩 모델을 불러오는 중입니다. 준비 전 질문은 낱말 색인만으로 답합니다.');
    warmer=startWarmup({
      rules:warmRules,
      isBusy:()=>{const s=baseStatus();return s.status!=='ok'||s.activeRequests>0||s.queuedRequests>0;},
      warm:keyword=>withPublicWarmup(()=>hLookup(keyword,{maxChars:1000})),
    });
  });
  const refreshHours=Number(process.env.DONGGUK_MCP_INDEX_REFRESH_HOURS||0);
  let indexTimer,indexRunning=false,indexLast=null;
  if(Number.isFinite(refreshHours)&&refreshHours>=1&&!noCache()){
    const refresh=async()=>{
      if(indexRunning) return;
      indexRunning=true;
      try{
        const r=await buildRuleIndex();indexLast={ok:r.ok,at:new Date().toISOString(),indexedRules:r.indexedRules,failedRules:r.failedRules};
        // Vectors follow the refreshed index only where an operator has already built them.
        if(r.ok&&semanticStatus(publicCacheDir()).indexAvailable&&semanticStatus(publicCacheDir()).setting!=='off'){
          const v=await buildSemanticRuleIndex({shared:true});indexLast.semantic=v.ok?{ok:true,articles:v.articles,reusedArticles:v.reusedArticles}:{ok:false,code:v.code};
        }
      }
      catch(e){indexLast={ok:false,at:new Date().toISOString(),error:'INDEX_BUILD_FAILED'};}
      finally{indexRunning=false;}
    };
    indexTimer=setInterval(refresh,refreshHours*3600*1000);indexTimer.unref();
    // Serve immediately, then rebuild stale/missing parser generations in the background.
    // refresh catches failures so startup remains available and the interval can retry.
    server.once('listening',()=>{void refresh();});
  }
  const withWarmStatus=server.getStatus;
  server.getStatus=()=>({...withWarmStatus(),fullTextIndex:{...indexStatus(),autoRefreshHours:indexTimer?refreshHours:0,running:indexRunning,lastRefresh:indexLast},
    semanticSearch:semanticStatus(publicCacheDir(),loadCorpus(publicCacheDir()))});
  server.once('close',()=>{warmer?.stop();clearInterval(indexTimer);});
  server.on('error',()=>{console.error('HTTP 기동 실패: 바인드 주소·포트·인증 설정을 확인하세요.');process.exitCode=1;});
  const shutdown=()=>{warmer?.stop();return server.shutdown().finally(()=>process.exit(0));};
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
    if(ARGV.includes('--build-index')){
      let last=0;
      const result=await buildRuleIndex({onProgress:p=>{if(p.done-last>=50||p.done===p.total){last=p.done;console.error(`색인 ${p.done}/${p.total} (재사용 ${p.reused}, 실패 ${p.failed})`);}}});
      console.log(JSON.stringify(result,null,2));
      if(!result.ok)process.exitCode=1;return;
    }
    if(ARGV.includes('--build-semantic-index')){
      let last=0;
      const result=await buildSemanticRuleIndex({onProgress:p=>{if(p.done-last>=500||p.done===p.total){last=p.done;console.error(`임베딩 ${p.done}/${p.total} (재사용 ${p.reused})`);}}});
      console.log(JSON.stringify(result,null,2));
      if(!result.ok)process.exitCode=1;return;
    }
    if(MODE_HTTP){startHttp();return;}
    const server=createServer({profile:PROFILE});await server.connect(new StdioServerTransport());
    console.error(`dongguk-rule-mcp v${VERSION} 시작됨 (${PROFILE}, stdio, Node ${process.version})`);
  })().catch(e=>{console.error('서버 시작 실패:',e.message);process.exitCode=1;});
}
module.exports={createServer,buildRuleIndex,buildSemanticRuleIndex};

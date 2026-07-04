#!/usr/bin/env node
/**
 * dongguk-rule-mcp v0.3.0
 * 동국대학교 통합규정관리시스템(rule.dongguk.edu) MCP 서버
 *
 * v0.3.0 하드닝:
 *  - 입력 검증 (keyword/law_id) — 잘못된 입력에 친절한 한국어 안내
 *  - arguments 누락 시 TypeError 방지
 *  - 검색 0건 시 안내 메시지
 *  - --version 플래그
 *  - deprecation 경고 억제 (로그 청결)
 *  - 파싱 버그픽스 유지: &quot; 엔티티, option onclick 속성, span onclick 폴백
 */
process.noDeprecation = true;

// --version / -v 플래그 (MCP 기동 전에 처리)
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  try { console.log(require('../package.json').version); } catch { console.log('unknown'); }
  process.exit(0);
}

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// === 상수 (Python 원본에서 검증된 엔드포인트) ===
const BASE_URL = 'https://rule.dongguk.edu';
const SEARCH_URL = `${BASE_URL}/lmxsrv/search/lawSerach.srv`;    // POST 전용!
const FULLVIEW_URL = `${BASE_URL}/lmxsrv/law/lawFullView.srv`;
const CONTENT_URL = `${BASE_URL}/lmxsrv/law/lawFullContent.srv`; // GET
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
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(),'.cache'), 'dongguk-rule-mcp');
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
  try { const d=path.join(cacheDir(),cat); fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(fp,JSON.stringify(r),'utf-8'); } catch(e) {}
  return r;
}

// === HTTP ===
async function fp(url, opts={}) {
  const wait = 500-(Date.now()-lastReq);
  if (wait>0) await new Promise(r=>setTimeout(r,wait));
  lastReq = Date.now();
  const h = { 'User-Agent':UA, 'Accept-Language':'ko-KR,ko;q=0.9', Referer:MAIN_URL, ...opts.headers };
  const ck = (process.env.DONGGUK_RULE_COOKIE||'').trim();
  if (ck) h['Cookie'] = ck;
  const res = await fetch(url, { ...opts, headers:h, timeout:20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
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
function parseSearch(html, page, pageShow) {
  const $ = cheerio.load(html);
  let total=0;
  const il = $('p.infoLeft').html()||'';
  const tm = il.match(/(\d+)\s*<\/span>\s*건/); if(tm) total=parseInt(tm[1]);
  const hits=[], seen=new Set(); let rawCount=0;
  $('tbody.tbody tr').each(function(){
    const td = $(this).find('td.tbody_txt'); if(!td.length) return;
    const s = td.html()||'';
    const m = /lawSearchFullViewSrv\(\s*'(\d+)'\s*,\s*'(\d+)'/.exec(s); if(!m) return;
    const lawId=parseInt(m[1]), historyId=parseInt(m[2]); rawCount++;
    const k=`${lawId}_${historyId}`; if(seen.has(k)) return; seen.add(k);
    // [버그픽스] cheerio는 &quot;를 그대로 두므로 엔티티도 매칭
    const st=[]; let sm; const re=/showSearchText\(\s*(?:"|&quot;)([^"&]*)(?:"|&quot;)/g;
    while((sm=re.exec(s))!==null) st.push(sm[1]);
    // [버그픽스] 개정일은 html 또는 span onclick 속성 양쪽에서 탐색
    let revisedAt='';
    $(this).find('td.tbody_c').each(function(){
      const src=$(this).html()||''; const span=$(this).find('span').attr('onclick')||'';
      const dm=/showDate\(\s*'(\d{8})'/.exec(src+' '+span);
      if(dm){ const d=dm[1]; revisedAt=`${d.slice(0,4)}.${d.slice(4,6)}.${d.slice(6)}`; }
    });
    hits.push({ lawId, historyId, code:st[0]||'', title:st[1]||'', revisedAt });
  });
  return { total, page, pageShow, hits, rawCount };
}

// === 본문 (GET + CSS 클래스 기반 파싱) ===
async function getContent(lawId, hid) {
  const html = await fp(`${CONTENT_URL}?SEQ=${lawId}&SEQ_HISTORY=${hid}`);
  return parseContent(html);
}
function parseContent(html) {
  const $ = cheerio.load(html);
  const fb = $('div.fullbody').length ? $('div.fullbody') : $('body');
  const title = fb.find('div.lawname').text().trim();
  const lines = []; if(title) lines.push(`# ${title}`,'');
  fb.find('div').each(function(){
    const cls=($(this).attr('class')||'').split(/\s+/);
    const t=$(this).text().replace(/\s+/g,' ').trim(); if(!t) return;
    if(cls.includes('lawname')) return;
    if(cls.includes('chapter')) lines.push('',`## ${t}`,'');
    else if(cls.includes('section')) lines.push('',`### ${t}`,'');
    else if(cls.includes('article')) lines.push('',`### ${t}`);
    else if(cls.includes('none')) lines.push(t);
    else if(cls.includes('hang')) lines.push(t);
    else if(cls.includes('ho')) lines.push(`  ${t}`);
    else if(cls.includes('mok')) lines.push(`    ${t}`);
  });
  return { title, markdown:lines.join('\n').trim() };
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
  const $ = cheerio.load(html);
  const sel = $('#histroySeq'); if(!sel.length) return [];
  const entries = [];
  sel.find('option').each(function(){
    const v=($(this).attr('value')||'').trim();
    if(!v||v==='0'||!/^\d+$/.test(v)) return;
    // [버그픽스] 날짜는 onclick 속성에 있음 (html/text 폴백)
    let ra=''; const dm=/showDate\(\s*'(\d{8})'/.exec($(this).attr('onclick')||$(this).html()||$(this).text());
    if(dm){const d=dm[1]; ra=`${d.slice(0,4)}.${d.slice(4,6)}.${d.slice(6)}`;}
    entries.push({ historyId:parseInt(v), revisedAt:ra });
  });
  return entries;
}
async function resolve(lawId, hid) {
  const h = toId(hid);
  if(h) return { historyId:h, note:null };
  const entries = await cached('history', String(lawId), TTL.history, ()=>getHistory(lawId));
  if(!entries.length) throw new Error(`LAW_ID ${lawId}의 연혁을 찾을 수 없습니다. law_id가 올바른지 확인하세요.`);
  const l=entries[0];
  return { historyId:l.historyId, note:`> 자동 해석: LAW_ID ${lawId} / HISTORY_ID ${l.historyId} (최신, ${l.revisedAt})` };
}

// === MCP 핸들러 ===
function cmap(c){ const v=(typeof c==='string'?c:'all').trim().toLowerCase(); return CAMPUS_MAP[v]||(/^\d+$/.test(v)?v:'0'); }

async function hSearch(kw, {fullText=false,limit=10,offset=0,campus='all'}={}) {
  const keyword = validStr(kw);
  if(!keyword) return '검색어(keyword)를 입력해주세요. 예: "보수규정", "퇴직금", "회계"';
  limit=Math.max(1,Math.min(Number(limit)||10,50)); offset=Math.max(0,Number(offset)||0);
  const lg=cmap(campus), ps=offset+limit;
  const ck=hk(keyword,fullText,1,ps,lg), ttl=fullText?TTL.searchFull:TTL.search;
  const r=await cached('search',ck,ttl,()=>searchRules(keyword,{fullText,page:1,pageShow:ps,lawgroup:lg}));
  const hits=r.hits.slice(offset,offset+limit);
  if(!hits.length){
    return `## 규정 검색: '${keyword}' — 결과 없음 (총 ${r.total}건)\n\n` +
      `다음을 시도해보세요:\n` +
      `- 짧은 키워드로 (예: "보수규정" → "보수")\n` +
      `- full_text=true로 전문 검색\n` +
      `- campus를 "all"로 (현재: ${campus||'all'})`;
  }
  let o=`## 규정 검색: '${keyword}' (${fullText?'제목+내용':'제목'})\n- 총 ${r.total}건\n- 표시: ${offset+1}~${offset+hits.length}\n\n`;
  o+='| 분류 | 제목 | 개정일 | LAW_ID | HISTORY_ID |\n|------|------|--------|--------|------------|\n';
  hits.forEach(h=>{ o+=`| ${h.code} | ${h.title} | ${h.revisedAt} | ${h.lawId} | ${h.historyId} |\n`; });
  if(offset+limit<r.total) o+=`\n다음: offset=${offset+limit}`;
  o+='\n\n💡 get_rule_content로 본문 조회 가능';
  return o;
}

async function hContent(rawLawId, hid, {article,chapter,grep,head}={}) {
  const lawId = toId(rawLawId);
  if(!lawId) return 'law_id는 양의 정수여야 합니다. search_rule 결과의 LAW_ID를 사용하세요. (예: law_id=491)';
  // [하드닝] 형식 검증은 네트워크 호출 전에 (즉시 안내)
  const art = toId(article);
  if(article!==undefined && article!==null && !art) return 'article은 양의 정수여야 합니다. (예: article=48 → 제48조)';
  const chp = toId(chapter);
  if(chapter!==undefined && chapter!==null && !chp) return 'chapter는 양의 정수여야 합니다. (예: chapter=5 → 제5장)';
  const {historyId:rid, note}=await resolve(lawId,hid);
  const c=await cached('content',`${lawId}_${rid}`,TTL.content,()=>getContent(lawId,rid));
  if(!c.markdown) return `본문을 가져올 수 없습니다 (LAW_ID ${lawId}). law_id/history_id를 확인하세요.`;
  let r=c.markdown;
  if(art){
    const m=new RegExp(`^### 제${art}조(?=[\\(\\s]|$)`,'m').exec(r);
    if(!m) return `제${art}조를 찾을 수 없습니다. get_rule_toc로 목차를 먼저 확인해보세요.`;
    const s=m.index;
    const em=/^(?:### 제\d+조|## 제\s*\d+\s*장)/m.exec(r.slice(s+m[0].length));
    r=r.slice(s,em?s+m[0].length+em.index:r.length).trimEnd();
  }
  if(chp){
    const m=new RegExp(`^## 제\\s*${chp}\\s*장`,'m').exec(r);
    if(!m) return `제${chp}장을 찾을 수 없습니다. get_rule_toc로 목차를 먼저 확인해보세요.`;
    const s=m.index;
    const em=/^## 제\s*\d+\s*장/m.exec(r.slice(s+m[0].length));
    r=r.slice(s,em?s+m[0].length+em.index:r.length).trimEnd();
  }
  const g = validStr(grep);
  if(g){
    const tk=g.split(/\s+/).filter(Boolean);
    const pts=r.split(/(?=^### 제\d+조)/m);
    const mt=pts.filter(p=>p.startsWith('### 제')&&tk.every(t=>p.includes(t)));
    r=mt.length?`## '${g}' 포함 조문 (${mt.length}건)\n\n${mt.join('\n\n')}`:`'${g}'을(를) 포함한 조문이 없습니다.`;
  }
  const hd = toId(head);
  if(hd){const ls=r.split('\n');if(ls.length>hd)r=ls.slice(0,hd).join('\n')+`\n\n...(전체 ${ls.length}줄 중 상위 ${hd}줄)`;}
  return note?`${note}\n\n${r}`:r;
}

async function hToc(rawLawId,hid){
  const lawId = toId(rawLawId);
  if(!lawId) return 'law_id는 양의 정수여야 합니다. (예: law_id=491)';
  const {historyId:rid,note}=await resolve(lawId,hid);
  const c=await cached('content',`${lawId}_${rid}`,TTL.content,()=>getContent(lawId,rid));
  if(!c.markdown) return `본문을 가져올 수 없습니다 (LAW_ID ${lawId}).`;
  const toc=c.markdown.split('\n').filter(l=>/^#{1,3} /.test(l)).join('\n');
  return note?`${note}\n\n${toc||'장·조 헤더가 없습니다.'}`:(toc||'장·조 헤더가 없습니다.');
}

async function hHistory(rawLawId){
  const lawId = toId(rawLawId);
  if(!lawId) return 'law_id는 양의 정수여야 합니다. search_rule 결과의 LAW_ID를 사용하세요.';
  const e=await getHistory(lawId);
  if(!e.length) return `LAW_ID ${lawId}의 연혁이 없습니다. law_id를 확인하세요.`;
  let o=`## LAW_ID ${lawId} 연혁 (${e.length}건)\n\n| HISTORY_ID | 개정일 |\n|------------|--------|\n`;
  e.forEach(x=>{o+=`| ${x.historyId} | ${x.revisedAt} |\n`;});
  return o;
}

async function hDeep(rawQuery,{top=3,perDoc}={}){
  const query = validStr(rawQuery);
  if(!query) return '검색어(query)를 입력해주세요. 예: "겸직", "위임전결"';
  top=Math.max(1,Math.min(Number(top)||3,10));
  const pd = toId(perDoc);
  const ps=top*5, ck=hk(query,true,1,ps,'0');
  const r=await cached('search',ck,TTL.searchFull,()=>searchRules(query,{fullText:true,page:1,pageShow:ps}));
  if(!r.hits.length) return `'${query}' 전문 검색 결과가 없습니다. 더 일반적인 키워드로 시도해보세요.`;
  const hits=r.hits.slice(0,top);
  let o=`# '${query}' 깊이 검색\n- 총 ${r.total}건, 상위 ${hits.length}개 grep\n\n`;
  for(let i=0;i<hits.length;i++){
    const h=hits[i];
    o+=`## [${i+1}] ${h.title} (LAW_ID ${h.lawId})\n`;
    try{
      const c=await cached('content',`${h.lawId}_${h.historyId}`,TTL.content,()=>getContent(h.lawId,h.historyId));
      if(!c.markdown){o+='- 본문 조회 실패\n\n';continue;}
      const tk=query.split(/\s+/).filter(Boolean);
      let mt=c.markdown.split(/(?=^### 제\d+조)/m).filter(p=>p.startsWith('### 제')&&tk.every(t=>p.includes(t)));
      const n=mt.length; if(pd&&n>pd)mt=mt.slice(0,pd);
      o+=n?`- 매칭 ${n}건\n\n${mt.join('\n\n')}\n\n`:`- 매칭 조문 없음 (제목/메타 매칭)\n\n`;
    }catch(e){o+=`- 오류: ${e.message}\n\n`;}
  }
  return o;
}

// === MCP 서버 ===
const server = new Server({ name:'dongguk-rule-mcp', version:'0.3.0' }, { capabilities:{tools:{}} });

server.setRequestHandler(ListToolsRequestSchema, async ()=>({ tools:[
  { name:'search_rule', description:'동국대 규정 키워드 검색 (제목/전문). 예: "보수규정", "퇴직금"',
    inputSchema:{ type:'object', properties:{
      keyword:{type:'string',description:'검색어'},
      full_text:{type:'boolean',description:'전문검색 여부',default:false},
      limit:{type:'number',default:10}, offset:{type:'number',default:0},
      campus:{type:'string',description:'all/seoul/wise',default:'all'},
    }, required:['keyword']}},
  { name:'get_rule_content', description:'규정 본문 마크다운 조회. history_id 생략 시 최신. article/chapter/grep 필터 지원.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
      history_id:{type:'number',description:'HISTORY_ID (생략=최신)'},
      article:{type:'number',description:'특정 조문만'},
      chapter:{type:'number',description:'특정 장만'},
      grep:{type:'string',description:'키워드 포함 조문'},
      head:{type:'number',description:'상위 N줄'},
    }, required:['law_id']}},
  { name:'get_rule_toc', description:'규정 목차(장·절·조) 빠른 조회.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number'}, history_id:{type:'number'},
    }, required:['law_id']}},
  { name:'list_rule_history', description:'규정 개정 연혁 목록 조회.',
    inputSchema:{ type:'object', properties:{
      law_id:{type:'number',description:'LAW_ID'},
    }, required:['law_id']}},
  { name:'search_rule_deep', description:'전문검색 → 상위 N개 규정 본문에서 키워드 조문 자동 추출.',
    inputSchema:{ type:'object', properties:{
      query:{type:'string'}, top:{type:'number',default:3}, per_doc:{type:'number'},
    }, required:['query']}},
]}));

server.setRequestHandler(CallToolRequestSchema, async (req)=>{
  const name = req.params.name;
  const a = req.params.arguments || {};   // [하드닝] arguments 누락 방어
  try{
    let r;
    switch(name){
      case 'search_rule': r=await hSearch(a.keyword,{fullText:a.full_text,limit:a.limit,offset:a.offset,campus:a.campus}); break;
      case 'get_rule_content': r=await hContent(a.law_id,a.history_id,{article:a.article,chapter:a.chapter,grep:a.grep,head:a.head}); break;
      case 'get_rule_toc': r=await hToc(a.law_id,a.history_id); break;
      case 'list_rule_history': r=await hHistory(a.law_id); break;
      case 'search_rule_deep': r=await hDeep(a.query,{top:a.top,perDoc:a.per_doc}); break;
      default: r=`알 수 없는 도구: ${name}`;
    }
    return {content:[{type:'text',text:r}]};
  }catch(e){
    const hint = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network|timeout/i.test(e.message)
      ? '\n\n네트워크 연결을 확인하세요.'
      : /HTTP 503/.test(e.message)
      ? '\n\nrule.dongguk.edu가 이 IP를 차단했습니다. 국내 IP(가정/캠퍼스 망)에서 실행하세요.'
      : '\n\nrule.dongguk.edu 응답 형식이 변경되었을 수 있습니다.';
    return {content:[{type:'text',text:`❌ ${e.message}${hint}`}],isError:true};
  }
});

(async()=>{
  const t=new StdioServerTransport();
  await server.connect(t);
  console.error('dongguk-rule-mcp v0.3.0 시작됨 (Node ' + process.version + ')');
})().catch(e=>{ console.error('서버 시작 실패:', e.message); process.exit(1); });

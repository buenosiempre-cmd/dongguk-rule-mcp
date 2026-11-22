'use strict';
const assert = require('node:assert/strict');
const { SOURCES, parsePairs, parseUniversitySearch, parseExternalContent, createPublicClient, compareUniversityRules, formatComparison, validateArguments, loadExternal } = require('../src/university-rules');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'university-test-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_MCP_NO_CACHE = '0';
const fetchPath = require.resolve('node-fetch');
require.cache[fetchPath].exports = async url => {
  assert(String(url).startsWith('https://rule.dongguk.edu/lmxsrv/search/'));
  return response(`<p class="infoLeft"><span>1</span>건</p><table><tbody class="tbody"><tr><td class="tbody_txt"><a href="javascript:lawSearchFullViewSrv('1','2');"><span onclick='showSearchText("1-1")'></span><span onclick='showSearchText("여비규정")'></span></a></td></tr></tbody></table>`);
};
const { createServer } = require('../src/index');
function seed(category,key,value) {
  const dir=path.join(root,'dongguk-rule-mcp','v2','public',category);
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,key+'.json'),JSON.stringify(value));
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`); }
const body = title => `<div class="fullbody"><div class="lawname">${title}</div><div class="article">제3조(여비)</div><div class="hang">출장 숙박 여비는 실비 지급한다.</div><div class="article">제5조(기타)</div><div class="hang">기타 사항</div><div class="addenda">부칙</div><div class="article">제1조(여비)</div><div class="hang">여비 경과 규정</div></div>`;
const rule = { title: '합성 여비규정', lawId: 1, historyId: 2, markdown: '### 제9조(여비)\n출장 숙박 여비는 지급한다.\n### 제10조(기타)\n기타 사항', url: 'https://rule.dongguk.edu/test', revisedAt: '2026.01.01' };
const dongguk = async () => ({ rules: [rule], failures: [], coverage: { mode: 'fixture', truncated: false } });
const response = (html, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => html });
async function main() {
  await check('포팅 파서: 숫자·문자 ID, 중복, 링크, 제목', () => {
    const p = parsePairs(`<a onclick="fullPopupPost(73, 3551,'x')">여비규정</a><a onclick="fullPopupPost('73','3551','x')">중복</a><a href="/x?SEQ=80&amp;SEQ_HISTORY=900">학칙</a>`);
    assert.deepEqual(p, [{ lawId: 73, historyId: 3551, title: '여비규정' }, { lawId: 80, historyId: 900, title: '학칙' }]);
    assert.equal(parsePairs('fullPopupPost(0,1)').length, 0);
  });
  await check('서울시립 총계 span 유무와 일반 링크·공개 로그인 링크 회귀', async () => {
    const html='<p class="infoLeft">전체 23건</p><a href="javascript:lawSearchFullViewSrv(\'164\', \'2095\',\'\');">여비</a>';
    assert.equal(parseUniversitySearch(html).total,23);assert.equal(parseUniversitySearch(html).hits[0].lawId,164);
    assert.equal(parseUniversitySearch('<p class="infoLeft">0건</p>').hits.length,0);
    assert.throws(()=>parseUniversitySearch('<p class="infoLeft">2건</p>'),/UPSTREAM_FORMAT_CHANGED/);
    const c=createPublicClient({minIntervalMs:0,fetchImpl:async()=>response('<a href="/member/oauthLogin.do">로그인</a>'+html)});
    assert.match(await c.request(SOURCES[1],'/lmxsrv/law/lawNewList.do'),/23건/);
  });
  await check('입력 상한·형식 및 미지원 키 구분', () => {
    for (const a of [{}, { topic:' ',universities:['uos'] }, {topic:'여비',universities:['dongguk']}, {topic:'여비',universities:['https://localhost']}, {topic:'여비',universities:['uos'],max_articles:6}, {topic:'여비',universities:Array(6).fill('uos')}]) assert(validateArguments(a));
    assert.equal(validateArguments({ topic:'여비',universities:['yonsei'] }), null);
  });
  await check('같은 원문 요청 합치기, 캐시 만료, 쿠키·리다이렉트 차단 설정', async () => {
    let count = 0, now = 0;
    const client = createPublicClient({minIntervalMs:0, now: () => now, ttlMs: 10, fetchImpl: async (url, opts) => {
      count++; assert.equal(opts.redirect, 'manual'); assert(!Object.keys(opts.headers).some(k => /cookie|authorization/i.test(k)));
      assert.equal(opts.size, 2097152); assert(opts.signal); return response(body('여비규정'));
    }});
    const s = SOURCES[1], path = '/lmxsrv/law/lawFullContent.do?SEQ=1&SEQ_HISTORY=2';
    await Promise.all([client.request(s,path),client.request(s,path)]); assert.equal(count,1);
    await client.request(s,path); assert.equal(count,1);
    now = 11; await client.request(s,path); assert.equal(count,2);
    process.env.DONGGUK_MCP_NO_CACHE='true'; await client.request(s,path);assert.equal(count,3);process.env.DONGGUK_MCP_NO_CACHE='0';
    await assert.rejects(client.request({...s,origin:'http://127.0.0.1'},path), /SOURCE_NOT_ALLOWED/);
  });
  await check('외부 리다이렉트·차단·로그인·HTTP 실패 분리, 실패 캐시 금지', async () => {
    for (const [html,status,code] of [['',302,'REDIRECT_NOT_FOLLOWED'],['',403,'ACCESS_DENIED'],['Access Denied',200,'ACCESS_DENIED'],['<input type="password">',200,'SESSION_REQUIRED'],['',503,'UPSTREAM_UNAVAILABLE'],['<html>maintenance</html>',200,'UPSTREAM_FORMAT_CHANGED']]) {
      let calls=0; const c=createPublicClient({minIntervalMs:0,fetchImpl:async()=>{calls++;return response(html,status);}});
      for(let i=0;i<2;i++) await assert.rejects(c.request(SOURCES[1],'/lmxsrv/law/lawNewList.do'), e=>e.code===code);
      assert.equal(calls,2);
    }
  });
  await check('시간 제한은 실제 fetch 신호를 취소', async () => {
    const c=createPublicClient({minIntervalMs:0,timeoutMs:5,fetchImpl:async(url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
    await assert.rejects(c.request(SOURCES[1],'/lmxsrv/law/lawNewList.do'), /aborted/);
  });
  await check('비교: 다른 조 번호 유지, 본문·출처·시행일 미확인, 최근 목록 부분 결과', async () => {
    const c={request:async(s,path)=>path.includes('lawNewList')?'<a onclick="fullPopupPost(3,4)">여비규정</a>':body('여비규정')};
    const data=await compareUniversityRules({topic:'여비',universities:['korea','korea','yonsei']},{loadDongguk:dongguk,client:c});
    assert.equal(data.columns.length,3); assert.equal(data.columns[0].articles[0].article,'제9조');
    assert.equal(data.columns[1].articles[0].article,'제3조'); assert.equal(data.columns[1].articles.length,1);
    assert.equal(data.columns[1].status,'partial'); assert.equal(data.columns[1].articles[0].effectiveAt,null);
    assert.equal(data.columns[2].status,'unsupported'); assert.match(data.columns[1].articles[0].url,/policies.korea.ac.kr/);
    assert.match(formatComparison(data),/시행일 미확인/); assert.match(formatComparison(data),/법적 대응/);
  });
  await check('대학 장애 격리·미발견과 형식 변경 구분', async () => {
    const c={request:async(s,path)=>s.key==='korea'?'<html>maintenance</html>':path.includes('lawNewList')?'<a onclick="fullPopupPost(3,4)">학칙</a>':body('학칙').replaceAll('여비','기타').replaceAll('출장','교원').replaceAll('숙박','연구')};
    const d=await compareUniversityRules({topic:'여비',universities:['korea','konkuk']},{loadDongguk:async()=>{throw new Error('cookie=DO_NOT_ECHO')},client:c});
    assert.deepEqual(d.columns.map(x=>x.status),['unavailable','unavailable','no_match_in_scope']);
    assert.equal(d.columns[1].code,'UPSTREAM_FORMAT_CHANGED'); assert(!JSON.stringify(d).includes('DO_NOT_ECHO'));
  });
  await check('후보 3개 제한·우선순위·조문 잘림을 표시', async () => {
    let contentCalls=0;
    const c={request:async(s,path)=>path.includes('lawNewList')?Array.from({length:12},(_,i)=>`<a onclick="fullPopupPost(${i+1},${i+20})">${i===11?'여비':'기타'}규정</a>`).join(''):(contentCalls++,body('여비규정'))};
    const r=await loadExternal(SOURCES[1],'여비',['여비'],c); assert.equal(contentCalls,3);assert.equal(r.rules[0].lawId,12); assert(r.coverage.truncated);
    const d=await compareUniversityRules({topic:'여비',universities:['korea'],max_articles:1},{loadDongguk:async()=>({...await dongguk(),rules:[{...rule,markdown:'### 제1조(여비)\n'+'여비'.repeat(1500)+'\n### 제2조(여비)\n여비 지급'}]}),client:c});
    assert(d.columns[0].articlesTruncated);assert(d.columns[0].articles[0].textTruncated);assert.equal(d.columns[0].status,'partial');
  });
  await check('외부 조문 구조: span 조문·caption 제거·가지조문', () => {
    const html='<div class="lawname">여비규정</div><div class="JO"><span class="article"><span class="doc_btn">버튼</span>제1조(여비)</span><div class="hang">여비 지급</div></div><div class="article"><table><caption>조항</caption><tr><td>제2조의 2(출장)</td></tr></table></div><div class="hang">숙박비</div>';
    const p=parseExternalContent(html);assert.match(p.markdown,/### 제1조/);assert.match(p.markdown,/### 제2조의 2/);assert(!p.markdown.includes('조항'));assert(!p.markdown.includes('버튼'));
  });
  await check('.do 전문검색: 최근 목록 밖 조문과 thisReadLaw 링크', async () => {
    const c={request:async(s,path,data)=>{
      if(path.includes('searchEngineTotal')) {
        assert.equal(new URLSearchParams(data).get('search_type'),'lawContents');
        return '<p>전체:1건</p><a href="javascript:thisReadLaw(\'7\',\'8\',\'r\');">여비규정</a>';
      }
      assert(path.includes('SEQ=7&SEQ_HISTORY=8'));return body('여비규정');
    }};
    const d=await compareUniversityRules({topic:'여비',universities:['kookmin','ssu']},{loadDongguk:dongguk,client:c});
    assert.deepEqual(d.columns.map(x=>x.status),['retrieved','retrieved','retrieved']);
    assert.equal(d.columns[1].coverage.mode,'full_text_search_first_page');
    assert.equal(parseUniversitySearch('<p>전체:0건</p>',true).hits.length,0);
  });
  await check('전체 시간 제한 후 후속 대학 요청 금지 및 취소 전달', async () => {
    let calls=0,signal;
    const started=Date.now();
    const d=await compareUniversityRules({topic:'여비',universities:['korea','uos']},{
      totalTimeoutMs:20,loadDongguk:async(t,terms,options)=>{signal=options.signal;return new Promise(()=>{});},
      client:{request:async()=>{calls++;throw new Error('unexpected');}}
    });
    assert(Date.now()-started<500);assert(signal.aborted);assert.equal(calls,0);
    assert(d.columns.every(c=>c.code==='TOTAL_TIMEOUT'));
  });
  await check('같은 대학 요청은 간격을 두고 실행', async () => {
    const starts=[];
    const c=createPublicClient({minIntervalMs:30,fetchImpl:async()=>{starts.push(Date.now());return response(body('여비규정'));}});
    await Promise.all([1,2,3].map(id=>c.request(SOURCES[1],`/lmxsrv/law/lawFullContent.do?SEQ=${id}&SEQ_HISTORY=1`)));
    assert.equal(starts.length,3);assert(starts[1]-starts[0]>=20);assert(starts[2]-starts[1]>=20);
  });
  await check('MCP 등록·서비스 개수·입력 검증·민감 입력 거부', async () => {
    const server=createServer({profile:'rules'}),client=new Client({name:'comparison-test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
    try {
      const tools=(await client.listTools()).tools;assert(tools.some(t=>t.name==='compare_university_rules'));
      const info=(await client.callTool({name:'get_service_info',arguments:{}})).structuredContent;assert.equal(info.data.toolCount,tools.length);
      const disabled=(await client.callTool({name:'compare_university_rules',arguments:{topic:'여비',universities:['uos']}})).structuredContent;assert.equal(disabled.error.code,'NOT_CONFIGURED');
      process.env.DONGGUK_UNIVERSITY_COMPARISON_ENABLED='1';
      seed('history','1',[{historyId:3,revisedAt:'2026.11.01'}]);
      seed('content-v3','1_3',{title:'여비규정',markdown:'### 제2조(여비)\n여비 출장 숙박 지급'});
      const live=(await client.callTool({name:'compare_university_rules',arguments:{topic:'여비',universities:['yonsei']}})).structuredContent;
      assert.equal(live.data.columns[0].status,'retrieved');assert.equal(live.data.columns[0].articles[0].historyId,3);
      assert.equal(live.data.columns[0].articles[0].revisedAt,'2026.11.01');
      assert.equal(live.data.columns[1].status,'unsupported');
      const invalid=(await client.callTool({name:'compare_university_rules',arguments:{topic:'여비',universities:[]}})).structuredContent;assert.equal(invalid.error.code,'INVALID_ARGUMENT');
      const sensitive=(await client.callTool({name:'compare_university_rules',arguments:{topic:'password=example-secret',universities:['uos']}})).structuredContent;assert.equal(sensitive.error.code,'SENSITIVE_INPUT');
    } finally {delete process.env.DONGGUK_UNIVERSITY_COMPARISON_ENABLED;await client.close();await server.close();}
  });
  fs.rmSync(root,{recursive:true,force:true});
  console.log(`📊 타대학 비교 검증: ${passed}개 통과`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

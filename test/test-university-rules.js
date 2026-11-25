'use strict';
const assert = require('node:assert/strict');
const { SOURCES, parsePairs, parseTree, parseFolderListing, PUBLIC_ONLY_NOTICE, htmlToArticleMarkdown, parseUniversitySearch, parseExternalContent, createPublicClient, compareUniversityRules, formatComparison, validateArguments, loadExternal, expandTopic, cleanListTitle, latestAddendaEffective } = require('../src/university-rules');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'university-test-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_MCP_NO_CACHE = '0';
const fetchPath = require.resolve('node-fetch');
const searchModes=[];
require.cache[fetchPath].exports = async (url,options) => {
  const params=new URLSearchParams(options.body);searchModes.push(params.get('SEARCH_TYPE'));
  if(params.get('SEARCH_TEXT')==='빈제목'&&params.get('SEARCH_TYPE')==='LAWNAME') return response('<p class="infoLeft"><span>0</span>건</p>');
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
  await check('최근 목록 대체 시 3개 제한·우선순위·조문 잘림을 표시', async () => {
    let contentCalls=0;
    const c={request:async(s,path)=>path.includes('lawTree')||path.includes('lawListManager')?'<html>stub</html>':path.includes('lawNewList')?Array.from({length:12},(_,i)=>`<a onclick="fullPopupPost(${i+1},${i+20})">${i===11?'여비':'기타'}규정</a>`).join(''):(contentCalls++,body('여비규정'))};
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
  await check('전문검색 후보는 주제 규정 제목을 먼저 조회', async () => {
    const paths=[];
    const c={request:async(s,path)=>{
      if(path.includes('searchEngineTotal')) return '<p>전체:7건</p>'+[1,2,3,4,5,6,7].map(id=>`<a onclick="thisReadLaw(${id},10)">${id===4?'여비규정':'기타규정'} 제1조</a>`).join('');
      paths.push(path);return body('여비규정');
    }};
    const r=await loadExternal(SOURCES[4],'여비',['여비'],c);
    assert.match(paths[0],/SEQ=4&/);assert.equal(paths.length,5);assert(r.coverage.truncated);
  });
  await check('주제어 확장: 접두어·끝 금 제거, 동의어, 미등록 주제', () => {
    const k=expandTopic('교내근로장학금');
    assert.equal(k.terms[0],'근로장학');assert(k.terms.includes('근로보조금'));assert.deepEqual(k.searchTerms,['근로장학','근로보조금']);assert.deepEqual(k.titleHints,['장학']);
    assert.equal(expandTopic('근로장학금').terms[0],'근로장학');assert.equal(expandTopic('여비').terms[0],'여비');
    assert.deepEqual(expandTopic('학부졸업유예').terms,['학부졸업유예','졸업유예']);assert.deepEqual(expandTopic('학부졸업유예').searchTerms,['졸업유예','학부졸업유예']);
    assert.deepEqual(expandTopic('등록금 반환').terms,['등록금','반환','환불']);assert.deepEqual(expandTopic('교원 겸직').terms,['겸직','겸업']);assert.equal(expandTopic('교원 겸직').frame.id,'external_concurrent_office');assert.deepEqual(expandTopic('교원 복무').terms,['교원','복무']);
  });
  await check('목록 제목의 스크립트 제거와 시행일자 추출', () => {
    const t=cleanListTitle(`if(chekFutureDate('20261015')){document.write("<span style='color: red;'>[시행예정]</span>");} 3-1-47 포상규정 newIcon('20261015');`);
    assert.deepEqual(t,{title:'3-1-47 포상규정',effectiveAt:'2026-10-15'});
    const p=parsePairs(`<a href="/lmxsrv/law/lawFullView.do?SEQ=114&amp;SEQ_HISTORY=2793">if(chekFutureDate('20261015')){document.write("[시행예정]");} 3-1-47 포상규정 newIcon('20261015');</a>`);
    assert.deepEqual(p,[{lawId:114,historyId:2793,title:'3-1-47 포상규정',effectiveAt:'2026-10-15'}]);
  });
  await check('고려·건국 조문 span.article2 파싱', () => {
    const html='<div class="lawname">포상규정</div><div class="JO"><span class="article2"><span class="doc_btn">조항 연혁</span>제1조(목적)</span><div class="none level1">이 규정은 포상을 정한다.</div></div><div class="addenda">부   칙</div><div class="none">이 규정은 2026년 10월 15일부터 시행한다.</div>';
    const p=parseExternalContent(html);assert.match(p.markdown,/### 제1조\(목적\)/);assert(!p.markdown.includes('조항 연혁'));
    assert.equal(latestAddendaEffective(p.markdown),'2026-10-15');
  });
  await check('부칙 시행일: 마지막 부칙만, 날짜 없는 부칙은 미확인', () => {
    assert.equal(latestAddendaEffective('### 제1조(목적)\n목적\n## 부칙\n이 규정은 2020년 3월 1일부터 시행한다.\n## 부칙\n이 규정은 2026. 3. 13.부터 시행한다. 다만 제7조는 2026년 9월 1일부터 시행한다.'),'2026-03-13');
    assert.equal(latestAddendaEffective('## 부칙\n이 규정은 2020년 3월 1일부터 시행한다.\n## 부칙\n이 규정은 공포한 날부터 시행한다.'),null);
    assert.equal(latestAddendaEffective('### 제1조(목적)\n2026년 1월 1일부터 시행'),null);
  });
  await check('트리 모드: 전체 규정 제목 대조, 트리 없으면 최근 목록', async () => {
    const nodes=[{folder:'1',id:1,hseq:0,name:'규정'},...Array.from({length:25},(_,i)=>({folder:'0',id:100+i,hseq:900+i,name:`3-5-${i} 기타규정`})),{folder:'0',id:382,hseq:3766,name:'3-5-1 장학규정'}];
    const tree=`<script>var zNodes = ${JSON.stringify(nodes)};</script>`;
    assert.equal(parseTree(tree).length,26);assert.equal(parseTree('<html></html>').length,0);
    const paths=[];
    const c={request:async(s,path)=>{paths.push(path);if(path.includes('lawTree'))return tree;return '<div class="lawname">장학규정</div><span class="article2">제7조(근로장학금)</span><div class="hang">근로장학생에게 지급한다.</div><div class="addenda">부칙</div><div class="none">이 규정은 2026년 3월 1일부터 시행한다.</div>';}};
    const spec=expandTopic('교내근로장학금');
    const r=await loadExternal(SOURCES.find(x=>x.key==='konkuk'),'교내근로장학금',spec.terms,c,undefined,spec);
    assert.equal(r.coverage.mode,'title_tree');assert.equal(r.coverage.titleMatches,1);assert.equal(r.rules[0].lawId,382);
    assert(!paths.some(x=>x.includes('lawNewList')));assert.equal(r.rules[0].effectiveAt,'2026-03-01');assert.equal(r.rules[0].effectiveSource,'addenda');
    const d=await compareUniversityRules({topic:'교내근로장학금',universities:['konkuk']},{loadDongguk:dongguk,client:c});
    assert.equal(d.columns[1].articles[0].article,'제7조');assert.match(formatComparison(d),/시행일 2026-03-01 \(마지막 부칙 명시 시행일\)/);
    const stub={request:async(s,path)=>path.includes('lawTree')?'<script>var zNodes = [{"folder":"0","id":15,"hseq":2502,"name":"2-1-1 학칙"}];</script>':path.includes('lawNewList')?`<a onclick="fullPopupPost(5,6)">if(chekFutureDate('20260901')){} 3-5-1 장학규정 newIcon('20260901');</a>`:'<div class="lawname">장학규정</div><span class="article2">제7조(근로장학금)</span><div class="hang">근로장학 지급</div>'};
    const k=await loadExternal(SOURCES.find(x=>x.key==='korea'),'근로장학',spec.terms,stub,undefined,spec);
    assert.equal(k.coverage.mode,'recent_list_only');assert.equal(k.rules[0].effectiveAt,'2026-09-01');assert.equal(k.rules[0].effectiveSource,'list');
  });
  await check('동의어 검색은 후보가 부족할 때만 추가 조회, 조문 제목 일치 우선', async () => {
    const queries=[];
    const c={request:async(s,path,data)=>{
      if(path.includes('lawSerach')){const q=new URLSearchParams(data).get('SEARCH_TEXT');queries.push(q);
        return q==='근로장학'?'<p class="infoLeft">1건</p><a onclick="fullPopupPost(1,2)">사무분장규정</a>':'<p class="infoLeft">1건</p><a onclick="fullPopupPost(3,4)">장학규정</a>';}
      return path.includes('SEQ=3&')?'<div class="lawname">장학규정</div><div class="article">제3조(종류)</div><div class="hang">근로보조금은 근로 대가로 지급한다.</div>'
        :'<div class="lawname">사무분장규정</div><div class="article">제5조(학생팀)</div><div class="hang">근로장학생 관리</div>';
    }};
    const d=await compareUniversityRules({topic:'교내근로장학금',universities:['uos']},{loadDongguk:dongguk,client:c});
    assert.deepEqual(queries,['근로장학','근로보조금']);assert.equal(d.columns[1].articles.length,2);assert.equal(d.columns[1].articles[0].universityRule,'장학규정');
    assert.equal(d.columns[1].coverage.truncated,false);assert.deepEqual(d.searchTerms,['근로장학','근로보조금']);
  });
  await check('자체 시스템 대학(서강 JSON·이화 HTML): 어댑터 등록·경로 제한·조문 추출', async () => {
    const byKey=Object.fromEntries(SOURCES.map(x=>[x.key,x]));
    assert.equal(byKey.sogang?.adapter,'sogang_json');assert.deepEqual(byKey.sogang.pathPrefixes,['/api/api/v1/mainEn/rule/']);
    assert.equal(byKey.ewha?.adapter,'ewha_html');assert.equal(byKey.ewha.origin,'https://www.ewha.ac.kr');
    // &nbsp;로 조문이 이어지는 서강류 content도 ### 제N조로 분리
    const md=htmlToArticleMarkdown('출장비 지급 규정&nbsp;제정 1984.3.1개정 2024.4.15.&nbsp;&nbsp;제1조(목적) 이 규정은 …&lt;개정 2012.12.13&gt;&nbsp;제2조(출장의 승인) 사전 승인.&nbsp;부칙 이 규정은 2024년 4월 15일부터 시행한다.');
    assert.match(md,/### 제1조\(목적\)/);assert.match(md,/### 제2조\(출장의 승인\)/);assert.match(md,/## 부칙/);
    // 서강 어댑터: 제목 질의 → content에서 조문/개정일 추출. 프레임 선별과 무관하게
    // loadExternal 원본 rules로 추출 자체를 검증한다(사안 프레임은 별도 테스트).
    const sgList=JSON.stringify({data:{list:[{pkid:279,title:'출장비 지급 규정',content:'출장비 지급 규정&nbsp;제정 1984.3.1개정 2024.4.15.&nbsp;&nbsp;제1조(목적) 공무 출장 여비.&nbsp;제2조(여비의 종류) 운임, 숙박비, 일비로 구분한다.&nbsp;부칙 이 규정은 2024년 4월 15일부터 시행한다.'},{pkid:999,title:'무관한 규정',content:'제1조(기타) 내용'}]}});
    const sgClient={request:async(s,path)=>{assert(path.startsWith('/api/api/v1/mainEn/rule/searchRuleData'),path);return sgList;}};
    const sgSpec=expandTopic('여비');
    const sgRes=await loadExternal(byKey.sogang,'여비',sgSpec.terms,sgClient,undefined,sgSpec);
    assert.equal(sgRes.coverage.mode,'rest_json');assert.equal(sgRes.rules.length,1);
    assert.equal(sgRes.rules[0].title,'출장비 지급 규정');assert.equal(sgRes.rules[0].revisedAt,'2024.04.15');assert.equal(sgRes.rules[0].effectiveAt,'2024-04-15');
    assert.match(sgRes.rules[0].markdown,/### 제1조\(목적\)/);assert.match(sgRes.rules[0].markdown,/### 제2조\(여비의 종류\)/);
    assert.match(sgRes.rules[0].url,/\/ko\/regulation\/home$/);
    // 이화 어댑터: 목록 HTML(view-rule 링크) → 규정별 view의 .fr-view 조문. 개정일은
    // 부칙 헤딩(…개정)에서, 시행일은 마지막 부칙 '…부터 시행'에서.
    const ewhaList='<a href="?mode=view-rule&amp;srRuleCd1=996&amp;srRuleCd2=1871">여비 규정</a><a href="?mode=view-rule&amp;srRuleCd1=993&amp;srRuleCd2=1000">정관</a>';
    const ewhaView='<div class="fr-view"><p>제 1 조 (목적) 국내외 여행 여비.</p><p>제 2 조 (여비의 종류) 운임, 숙박비, 일비로 구분한다.</p><p>부칙 (2020. 1. 14. 개정)</p><p>이 규정은 2019년 11월 26일부터 시행한다.</p></div>';
    const ewhaClient={request:async(s,path)=>path.includes('view-rule')?ewhaView:ewhaList};
    const ewSpec=expandTopic('여비');
    const ewRes=await loadExternal(byKey.ewha,'여비',ewSpec.terms,ewhaClient,undefined,ewSpec);
    assert.equal(ewRes.coverage.mode,'html_catalog');assert.equal(ewRes.rules.length,1);
    assert.equal(ewRes.rules[0].title,'여비 규정');assert.equal(ewRes.rules[0].revisedAt,'2020.01.14');assert.equal(ewRes.rules[0].effectiveAt,'2019-11-26');
    assert.match(ewRes.rules[0].markdown,/### 제 1 조 \(목적\)/);assert.match(ewRes.rules[0].markdown,/### 제 2 조 \(여비의 종류\)/);
    assert.match(ewRes.rules[0].url,/srRuleCd1=996&srRuleCd2=1871/);
    // 어댑터 소스는 선언한 경로 밖은 차단
    const c=createPublicClient({minIntervalMs:0,fetchImpl:async()=>response('x')});
    await assert.rejects(c.request(byKey.sogang,'/lmxsrv/law/x'), e=>e.code==='SOURCE_NOT_ALLOWED');
    await assert.rejects(c.request(byKey.ewha,'/other/path'), e=>e.code==='SOURCE_NOT_ALLOWED');
  });
  await check('신규 4개 대학 등록(경희·숙명·광운·명지)과 명지 본문 파싱(lawname2/addenda2)', () => {
    const byKey=Object.fromEntries(SOURCES.map(x=>[x.key,x]));
    assert.equal(byKey.khu?.mode,'search_do');assert.equal(byKey.sookmyung?.mode,'search_do');
    assert.equal(byKey.kw?.mode,'tree');assert.equal(byKey.mju?.mode,'tree');
    assert.equal(byKey.mju.origin,'https://law.mju.ac.kr');assert.equal(byKey.khu.origin,'https://rule.khu.ac.kr');
    // 명지대는 제목·부칙을 lawname2·addenda2로, 조문을 article2로 표시한다.
    const html='<div class="lawname2">교직원 여비 규정</div><div class="JO"><span class="article2"><span class="doc_btn">버튼</span>제 2 조 (여비의 종류)</span><div class="hang">여비는 운임, 일비, 숙박비로 구분한다.</div></div><div class="addenda2">부   칙</div><div class="none">이 규정은 2026년 11월 1일부터 시행한다.</div>';
    const p=parseExternalContent(html);
    assert.equal(p.title,'교직원 여비 규정');assert.match(p.markdown,/### 제 2 조 \(여비의 종류\)/);
    assert(!p.markdown.includes('버튼'));assert.equal(latestAddendaEffective(p.markdown),'2026-11-01');
  });
  await check('고려대 공개 분류 목록: 페이지 넘김·제목 대조·공개 범위 표시', async () => {
    const listing=(total,rows)=>`<p>전체: ${total} 건&nbsp; 페이지:</p>`+rows.map(([id,h,t])=>`<a href="/lmxsrv/law/lawFullView.do?SEQ=${id}&amp;SEQ_HISTORY=${h}">${t}</a>`).join('');
    const parsed=parseFolderListing(listing(2,[[1,2,'3-4-5 장학금 지급 규정'],[3,4,'3-1-1 직제규정']]));
    assert.equal(parsed.total,2);assert.equal(parsed.pairs[0].lawId,1);
    assert.throws(()=>parseFolderListing('<html>login</html>'),/UPSTREAM_FORMAT_CHANGED/);
    const requests=[];
    const c={request:async(s,path,body)=>{
      if(path.includes('lawListManager')){const q=new URLSearchParams(body);requests.push(`${q.get('SEQ')}/${q.get('PAGE')}`);
        const folder=q.get('SEQ'),page=q.get('PAGE');
        if(folder==='3') return page==='1'?listing(12,Array.from({length:10},(_,i)=>[100+i,900+i,`2-1-${i} 대학원학칙 세칙${i}`])):listing(12,[[110,910,'2-1-10 학칙'],[111,911,'2-1-11 학사운영 규정']]);
        if(folder==='11') return listing(1,[[55,555,'3-4-5 장학금 지급 규정']]);
        return listing(0,[]);
      }
      assert(path.includes('SEQ=55&SEQ_HISTORY=555'),path);
      return '<div class="lawname">장학금 지급 규정</div><span class="article2">제5조(근로장학금)</span><div class="hang">근로장학금은 근로 시간에 따라 지급한다.</div><div class="addenda">부칙</div><div class="none">이 규정은 2025년 3월 1일부터 시행한다.</div>';
    }};
    const spec=expandTopic('교내근로장학금');
    const r=await loadExternal(SOURCES.find(x=>x.key==='korea'),'교내근로장학금',spec.terms,c,undefined,spec);
    assert.equal(r.coverage.mode,'public_folder_list');assert.equal(r.coverage.totalCandidates,13);assert.equal(r.coverage.publicOnly,true);assert.equal(r.coverage.notice,PUBLIC_ONLY_NOTICE);
    assert.deepEqual(r.coverage.folders.find(f=>f.folder===3),{folder:3,total:12});assert(requests.includes('3/2')&&!requests.includes('3/3'));
    assert.equal(r.rules.length,1);assert.equal(r.rules[0].lawId,55);assert.equal(r.rules[0].effectiveAt,'2025-03-01');
    const d=await compareUniversityRules({topic:'교내근로장학금',universities:['korea']},{loadDongguk:dongguk,client:c});
    assert.equal(d.columns[1].articles[0].article,'제5조');assert.match(formatComparison(d),/partial — 공개 규정만/);
    assert(d.supportedUniversities.find(x=>x.key==='korea').publicOnly);
    const none=await loadExternal(SOURCES.find(x=>x.key==='korea'),'여비',['여비','출장','숙박'],c,undefined,expandTopic('여비'));
    assert.equal(none.rules.length,0);assert.equal(none.coverage.titleMatches,0);assert.equal(none.coverage.publicOnly,true);
  });
  await check('고려대 목록 형식이 바뀌면 최근 목록으로 대체', async () => {
    const c={request:async(s,path)=>path.includes('lawListManager')?'<html>maintenance</html>':path.includes('lawNewList')?'<a onclick="fullPopupPost(5,6)">장학규정</a>':'<div class="lawname">장학규정</div><span class="article2">제7조(근로장학금)</span><div class="hang">근로장학 지급</div>'};
    const spec=expandTopic('근로장학');
    const k=await loadExternal(SOURCES.find(x=>x.key==='korea'),'근로장학',spec.terms,c,undefined,spec);
    assert.equal(k.coverage.mode,'recent_list_only');assert.equal(k.rules[0].lawId,5);
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
  await check('공유 원문은 한 호출 취소로 다른 대기자가 실패하지 않음', async () => {
    let calls=0,release;
    const ready=new Promise(resolve=>{release=resolve;});
    const c=createPublicClient({minIntervalMs:0,fetchImpl:async(url,opts)=>{calls++;await ready;assert(!opts.signal.aborted);return response(body('여비규정'));}});
    const controller=new AbortController(),path='/lmxsrv/law/lawFullContent.do?SEQ=1&SEQ_HISTORY=2';
    const first=c.request(SOURCES[1],path,undefined,8000,controller.signal);
    const rejected=assert.rejects(first,e=>e.code==='TOTAL_TIMEOUT');
    const second=c.request(SOURCES[1],path);
    controller.abort();await rejected;release();
    assert.match(await second,/여비규정/);assert.equal(calls,1);
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
      seed('content-v3','1_3',{title:'여 비 규 정',markdown:'### 제2조(여비)\n여비 출장 숙박 지급'});
      const live=(await client.callTool({name:'compare_university_rules',arguments:{topic:'여비',universities:['yonsei']}})).structuredContent;
      assert.equal(live.data.columns[0].status,'retrieved');assert.equal(live.data.columns[0].articles[0].historyId,3);assert.equal(live.data.columns[0].articles[0].universityRule,'여비규정');
      assert.equal(live.data.columns[0].articles[0].revisedAt,'2026.11.01');
      assert.equal(live.data.columns[1].status,'unsupported');
      const fallback=(await client.callTool({name:'compare_university_rules',arguments:{topic:'빈제목',universities:['yonsei']}})).structuredContent;
      assert.equal(fallback.data.columns[0].coverage.mode,'full_text_search');assert.deepEqual(searchModes.slice(-2),['LAWNAME','CONTENTS']);
      const invalid=(await client.callTool({name:'compare_university_rules',arguments:{topic:'여비',universities:[]}})).structuredContent;assert.equal(invalid.error.code,'INVALID_ARGUMENT');
      const sensitive=(await client.callTool({name:'compare_university_rules',arguments:{topic:'password=example-secret',universities:['uos']}})).structuredContent;assert.equal(sensitive.error.code,'SENSITIVE_INPUT');
    } finally {delete process.env.DONGGUK_UNIVERSITY_COMPARISON_ENABLED;await client.close();await server.close();}
  });
  fs.rmSync(root,{recursive:true,force:true});
  console.log(`📊 타대학 비교 검증: ${passed}개 통과`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

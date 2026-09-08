'use strict';
const assert=require('node:assert/strict');
const {queryLegalReferences,exactCurrentLaw}=require('../src/legal-client.js');
const TODAY='2026-09-08';
const NOW=new Date(`${TODAY}T03:00:00Z`);
const LAW='사학기관 재무ㆍ회계 규칙에 대한 특례규칙';
const text=value=>({content:[{type:'text',text:value}]});
const current=(name=LAW,mst='251375',effective='20260701')=>text(`1. ${name} [현행]\n   - 법령ID: 007333\n   - MST: ${mst}\n   - 공포일: 20260101 / 시행일: ${effective}\n`);
const lawBody=(name=LAW,article='제2조',effective='20260701',body='① 이 규칙은 학교법인과 사립학교의 재무 및 회계에 관한 사항을 정한다.')=>text(`법령명: ${name}\n공포일: 20260101\n시행일: ${effective}\n\n${article}(정의)\n${body}\n`);
const historical=(name=LAW,date='2024.01.15',effective='2020.01.01',mst='111111')=>text(`═══ 행위시법 판단: ${name} @ ${date} ═══\n\n▶ 기준일에 시행 중이던 버전\n  ${name} [시행 ${effective}] [제123호, 2019.12.01, 일부개정] (MST ${mst})\n  ↳ 기준일 이후 현재까지 2차례 개정·시행됨\n\n▶ 적용례·경과조치: 관련 부칙에서 경과규정 신호 미발견\n`);
const annex=(suffix='',name=LAW,number='1')=>text(`${name} - 자금계산서 계정과목 명세표(제17조 관련)\n(파일 형식: HWP)\n\n■ ${name} [별표 ${number}] <개정 2023. 5. 31.>\n<table><tr><th colspan="2">과목</th><th>적용회계</th></tr><tr><td rowspan="2">등록금수입</td><td>5111</td><td>학교회계</td></tr></table>${suffix}`);
function fake(handler,{tools=['legal_analysis'],listTools}={}){
  const calls=[];
  return {calls,async callTool(request,unused,options){calls.push({name:request.name,arguments:request.arguments,options});if(handler){const out=await handler(request,calls);if(out!==undefined)return out;}if(request.name==='search_law')return current(request.arguments.query);if(request.name==='get_law_text')return lawBody(LAW,request.arguments.jo||'제1조',request.arguments.efYd);if(request.name==='legal_analysis'||request.name==='applicable_law')return historical();if(request.name==='get_annexes')return annex();throw new Error('Unknown tool');},async listTools(...args){calls.push({name:'listTools'});return listTools?listTools(...args):{tools:tools.map(name=>({name}))};}};
}
const run=(requests,client,options={})=>queryLegalReferences(requests,{now:NOW,client,...options});
const tests=[];
const test=(name,fn)=>tests.push({name,fn});

test('exact current-law parser keeps compatibility and excludes substring/future entries',()=>{
  const response=text('1. 소득세법 시행령 [현행]\n   - 법령ID: 003956\n   - MST: 111\n   - 공포일: 20260101 / 시행일: 20260101\n2. 소득세법 [현행]\n   - 법령ID: 001565\n   - MST: 222\n   - 공포일: 20260101 / 시행일: 20260701\n시행예정 MST: 333');
  assert.equal(exactCurrentLaw(response,'소득세법').mst,'222');
  assert.equal(exactCurrentLaw(response,'국세기본법'),null);
  assert.equal(exactCurrentLaw({...response,isError:true},'소득세법'),null);
  assert.equal(exactCurrentLaw(current(LAW,'111','20260230'),LAW),null);
});
test('all three requests are retrieved with one shared exact-name search',async()=>{
  const client=fake();const requests=[2,17,12].map(n=>({law_name:LAW,article:`제${n}조`}));
  const response=await run(requests,client);
  assert.equal(response.status,'retrieved');
  assert.deepEqual(response.counts,{requested:3,attempted:3,retrieved:3,partial:0,unavailable:0,notRequested:0,notRetrieved:0,bodyRetrieved:3});
  assert.equal(client.calls.filter(c=>c.name==='search_law').length,1);
  assert.equal(client.calls.filter(c=>c.name==='get_law_text').length,3);
  assert.equal(response.results[2].articles[0].source.arguments.efYd,'20260701');
  assert.equal(response.results[0].articles[0].source.mst,'251375');
  assert.equal(response.applicability,'requires_review');
});
test('explicit eight-request limit accounts for every omitted input',async()=>{
  const response=await run(Array.from({length:10},(_,i)=>({law_name:LAW,article:`제${i+1}조`})),fake());
  assert.equal(response.results.length,10);assert.equal(response.counts.attempted,8);assert.equal(response.counts.retrieved,8);assert.equal(response.counts.notRequested,2);assert.equal(response.counts.notRetrieved,2);assert.equal(response.status,'partial');
  assert.equal(response.results[9].code,'LEGAL_REQUEST_LIMIT');
});
test('partial-name search cannot be used as exact law evidence',async()=>{
  const client=fake(r=>r.name==='search_law'?current(`${LAW} 시행령`):undefined);
  const response=await run([{law_name:LAW,article:'제2조'}],client);
  assert.equal(response.results[0].code,'LEGAL_EXACT_LAW_NOT_FOUND');
  assert.equal(response.counts.retrieved,0);assert.equal(client.calls.filter(c=>c.name==='get_law_text').length,0);
});
test('missing, empty, error and title-only responses never count as retrieved bodies',async()=>{
  for(const body of [null,{},text(''),text('   '),text('[NOT_FOUND] 조문 내용이 없습니다.'),{...lawBody(),isError:true},{...lawBody(),structuredContent:{ok:false}},text(`법령명: ${LAW}\n시행일: 20260701\n\n제2조(정의)\n`)]){
    const client=fake(r=>r.name==='get_law_text'?body:undefined);
    const response=await run([{law_name:LAW,article:'제2조'}],client);
    assert.equal(response.status,'unavailable');assert.equal(response.counts.bodyRetrieved,0);assert.equal(response.results[0].articles[0].text,undefined);
  }
});
test('law identity, article branch and returned effective date are checked',async()=>{
  for(const body of [lawBody('다른 법률'),lawBody(LAW,'제2조의2'),lawBody(LAW,'제2조','20260101'),text(`법령명: ${LAW}\n제2조(정의)\n이 규칙은 학교에 적용한다.`)]){
    const response=await run([{law_name:LAW,article:'제2조'}],fake(r=>r.name==='get_law_text'?body:undefined));
    assert.equal(response.status,'unavailable');assert.equal(response.counts.bodyRetrieved,0);
  }
});
test('live duplicate article titles are excluded and only following prose counts',async()=>{
  const header=`법령명: ${LAW}\n공포일: 20230531\n시행일: 20230601\nℹ️ 조회기준일 20260908 — 위 시행일 버전 본문.\n\n제17조 계정과목\n제17조(계정과목)\n`;
  for(const [body,expected] of [[header+'①법인회계 및 학교회계의 계정과목 및 그 내용은 별표 1의 계정과목 명세표로 한다.\n','retrieved'],[header,'unavailable'],[header.replace('제17조(계정과목)\n',''),'unavailable']]){
    const client=fake(r=>r.name==='search_law'?current(LAW,'251375','20230601'):r.name==='get_law_text'?text(body):undefined);
    const response=await run([{law_name:LAW,article:'제17조'}],client);
    assert.equal(response.status,expected);
  }
});
test('no article requests the actual body and handles full text',async()=>{
  const client=fake();const response=await run([{law_name:LAW}],client);
  assert.equal(response.status,'retrieved');assert.equal(response.results[0].articles[0].selector,null);assert.equal(response.counts.bodyRetrieved,1);
  const call=client.calls.find(c=>c.name==='get_law_text');assert.equal('jo' in call.arguments,false);
});
test('no article returning a table of contents is partial without a retrieved body',async()=>{
  const client=fake(r=>r.name==='get_law_text'?text(`법령명: ${LAW}\n시행일: 20260701\n\n목차 (총 50개 조문)\n제1조 목적\n제2조 정의\n\n특정 조문 조회: get_law_text(mst="251375", jo="제XX조")`):undefined);
  const response=await run([{law_name:LAW}],client);
  assert.equal(response.status,'partial');assert.equal(response.counts.bodyRetrieved,0);assert.equal(response.results[0].articles[0].code,'LEGAL_TOC_ONLY');
});
test('historical date resolves version and passes the actual effective slice to the body tool',async()=>{
  const client=fake();const response=await run([{law_name:LAW,article:'제2조'}],client,{baseDate:'2024-01-15'});
  assert.equal(response.status,'retrieved');assert.equal(response.results[0].dateStatus,'historical_version_retrieved');assert.equal(response.results[0].referenceOnly,false);
  assert.deepEqual(client.calls.find(c=>c.name==='legal_analysis').arguments,{mode:'applicable_law',lawName:LAW,date:'2024-01-15'});
  assert.deepEqual(client.calls.find(c=>c.name==='get_law_text').arguments,{mst:'111111',efYd:'20200101',jo:'제2조'});
  assert.equal(response.results[0].dateResolution.tool,'legal_analysis');assert.equal(response.results[0].articles[0].source.baseDate,'2024-01-15');
});
test('legacy applicable_law tool is supported',async()=>{
  const client=fake(undefined,{tools:['applicable_law']});const response=await run([{law_name:LAW}],client,{baseDate:'20240115'});
  assert.equal(response.status,'retrieved');assert.deepEqual(client.calls.find(c=>c.name==='applicable_law').arguments,{lawName:LAW,date:'2024-01-15'});
});
test('historical tool discovery follows pagination',async()=>{
  let pages=0;const client=fake(undefined,{listTools:()=>++pages===1?{tools:[{name:'search_law'}],nextCursor:'page2'}:{tools:[{name:'legal_analysis'}]}});
  const response=await run([{law_name:LAW,article:'제2조'}],client,{baseDate:'2024-01-15'});assert.equal(response.status,'retrieved');assert.equal(pages,2);
});
test('unsupported historical resolution does not silently return current text',async()=>{
  for(const client of [fake(undefined,{tools:['search_law','get_law_text']}),{callTool:async()=>{throw new Error('must not call');}}]){
    const response=await run([{law_name:LAW,article:'제2조'}],client,{baseDate:'2024-01-15'});
    assert.equal(response.status,'unavailable');assert.equal(response.results[0].code,'HISTORICAL_LOOKUP_UNAVAILABLE');assert.equal(response.results[0].referenceOnly,true);assert.equal(response.results[0].dateStatus,'historical_unverified');
    if(client.calls)assert.equal(client.calls.some(c=>c.name==='get_law_text'),false);
  }
});
test('historical law, date and effective-date mismatches are not accepted',async()=>{
  for(const body of [historical('다른 법률'),historical(LAW,'2024.01.16'),historical(LAW,'2024.01.15','2025.01.01'),text('✗ 기준일 당시 이 법령은 시행 전입니다.'),text('')]){
    const client=fake(r=>r.name==='legal_analysis'?body:undefined);
    const response=await run([{law_name:LAW,article:'제2조'}],client,{baseDate:'2024-01-15'});
    assert.equal(response.status,'unavailable');assert.equal(response.results[0].code,'HISTORICAL_VERSION_UNVERIFIED');assert.equal(client.calls.some(c=>c.name==='get_law_text'),false);
  }
});
test('historical body with a current effective date is not accepted',async()=>{
  const response=await run([{law_name:LAW,article:'제2조'}],fake(r=>r.name==='get_law_text'?lawBody():undefined),{baseDate:'2024-01-15'});
  assert.equal(response.status,'unavailable');assert.equal(response.results[0].code,'LEGAL_BODY_VERSION_UNVERIFIED');assert.equal(response.results[0].dateStatus,'historical_unverified');
});
test('future date is explicitly unverified and makes no legal calls',async()=>{
  const client=fake();const response=await run([{law_name:LAW,article:'제2조'}],client,{baseDate:'2027-01-01'});
  assert.equal(response.code,'FUTURE_DATE_UNVERIFIED');assert.equal(response.results[0].dateStatus,'future_unverified');assert.equal(response.counts.attempted,0);assert.equal(response.counts.notRequested,1);assert.equal(client.calls.length,0);
});
test('invalid calendar dates, input types and options are handled explicitly',async()=>{
  for(const baseDate of ['2026-02-30','not-a-date','']){
    const response=await run([{law_name:LAW}],fake(),{baseDate});assert.equal(response.code,'INVALID_BASE_DATE');assert.equal(response.counts.attempted,0);
  }
  assert.equal((await run('wrong',fake())).code,'INVALID_LEGAL_REQUESTS');
  assert.equal((await run([],fake())).status,'not_required');
  const response=await run([null,{},[],{law_name:LAW,article:'제2조제1항'},{law_name:LAW,annex:'별표 0'}],fake());
  assert.equal(response.counts.unavailable,5);assert.equal(response.counts.attempted,0);
  assert.equal((await run([{law_name:LAW}],fake(),{maxRequests:9})).code,'INVALID_LEGAL_OPTIONS');
});
test('JO code is normalized without confusing article and branch digits',async()=>{
  const client=fake();const response=await run([{law_name:LAW,article:'023402'}],client);
  assert.equal(response.status,'retrieved');assert.equal(client.calls.find(c=>c.name==='get_law_text').arguments.jo,'제234조의2');
});
test('call timeout is explicit even when injected client ignores SDK abort',async()=>{
  const client={callTool:()=>new Promise(()=>{})};const start=Date.now();
  const response=await run([{law_name:LAW,article:'제2조'}],client,{timeoutMs:15});
  assert.equal(response.results[0].code,'LEGAL_TIMEOUT');assert.ok(Date.now()-start<1000);assert.equal(response.counts.retrieved,0);
});
test('connection failures expose stable codes without leaking error text',async()=>{
  const client={callTool:async()=>{throw Object.assign(new Error('private connection details must not be echoed'),{code:'ECONNRESET'});}};
  const response=await run([{law_name:LAW,article:'제2조'}],client);
  assert.equal(response.results[0].code,'LEGAL_CONNECTION_FAILED');assert.equal(JSON.stringify(response).includes('private connection details'),false);
});
test('current annex includes unchanged HTML, selector and honest source metadata',async()=>{
  const client=fake();const response=await run([{law_name:LAW,article:'제17조',annex:'별표 1'}],client);
  assert.equal(response.status,'retrieved');assert.equal(response.results[0].articles.length,1);
  const result=response.results[0].annexes[0];assert.equal(result.text,annex().content[0].text);assert.equal(result.dateStatus,'current_unpinned');assert.equal(result.referenceOnly,false);assert.equal(result.truncated,false);assert.equal(result.source.mst,null);assert.equal(result.source.currentLawMst,'251375');assert.equal(result.source.versionVerified,false);
  assert.deepEqual(client.calls.find(c=>c.name==='get_annexes').arguments,{lawName:LAW,annexNo:'1',jo:'제17조'});
});
test('annex-only historical request returns only current reference with unverified past date',async()=>{
  const client=fake();const response=await run([{law_name:LAW,annex:'별표 1'}],client,{baseDate:'2024-01-15'});
  const result=response.results[0].annexes[0];assert.equal(result.status,'partial');assert.equal(response.status,'partial');assert.equal(result.dateStatus,'historical_unverified');assert.equal(result.referenceOnly,true);assert.equal(result.code,'HISTORICAL_ANNEX_UNVERIFIED');assert.equal(response.counts.bodyRetrieved,1);assert.equal(client.calls.some(c=>c.name==='legal_analysis'),false);assert.equal(client.calls.some(c=>c.name==='get_law_text'),false);
});
test('historical article failure still allows explicitly unverified annex reference',async()=>{
  const response=await run([{law_name:LAW,article:'제17조',annex:'별표 1'}],fake(undefined,{tools:[]}),{baseDate:'2024-01-15'});
  assert.equal(response.status,'partial');assert.equal(response.results[0].articles[0].status,'unavailable');assert.equal(response.results[0].annexes[0].bodyRetrieved,true);assert.equal(response.results[0].referenceOnly,true);
});
test('annex empty, links-only, image PDF and wrong selector are not body evidence',async()=>{
  for(const body of [text(''),text(`${LAW} - 별표 1\n다운로드 링크: https://www.law.go.kr/example.pdf`),text(`${LAW} - 별표 1\n(파일 형식: PDF)\n\n이미지 기반 PDF입니다 (1페이지). 텍스트 추출이 불가합니다.\n다운로드 링크: https://www.law.go.kr/example.pdf`),text(`${LAW} - 별표 1\n(파일 형식: HWP)\n\n■ ${LAW} [별표 1] <개정 2023. 5. 31.>\n`),text(`${LAW} - 별표 1\n(파일 형식: HWP)\n\n<table><tr><th>관</th><th>항</th><th>목</th><th>적용 회계</th></tr></table>`),annex('',LAW,'2'),annex('','다른 법률')]){
    const response=await run([{law_name:LAW,annex:'별표 1'}],fake(r=>r.name==='get_annexes'?body:undefined));
    assert.equal(response.status,'unavailable');assert.equal(response.counts.bodyRetrieved,0);
  }
});
test('both local cap and upstream 50000-character warning make results partial',async()=>{
  const limited=await run([{law_name:LAW,annex:'별표 1'}],fake(),{maxTextChars:120});
  const small=limited.results[0].annexes[0];assert.equal(small.truncated,true);assert.equal(small.returnedChars,120);assert.ok(small.originalChars>120);assert.equal(limited.status,'partial');
  const warning='\n⚠️ 응답이 너무 길어 50,000자로 잘렸습니다.';
  const response=await run([{law_name:LAW,annex:'별표 1'}],fake(r=>r.name==='get_annexes'?annex(warning):undefined));
  assert.equal(response.results[0].annexes[0].upstreamTruncated,true);assert.equal(response.results[0].annexes[0].truncated,true);assert.equal(response.status,'partial');
});
test('incomplete HTML tables and canonical-link fallback are reported',async()=>{
  const incomplete=text(annex().content[0].text.replace('</table>',''));
  const response=await run([{law_name:LAW,annex:'별표 1'}],fake(r=>r.name==='get_annexes'?incomplete:undefined));
  assert.equal(response.status,'partial');assert.equal(response.results[0].annexes[0].incompleteTable,true);
  const fallback=await run([{law_name:LAW,annex:'별표 1'}],fake(r=>r.name==='get_annexes'?annex('\n⚠️ 정본 링크 확인 불가 (현행 본문 조회 실패) — 검색 인덱스 링크로 조회했습니다.'):undefined));
  assert.equal(fallback.status,'partial');assert.equal(fallback.results[0].annexes[0].dateStatus,'current_unverified');assert.equal(fallback.results[0].annexes[0].referenceOnly,true);
});
test('upstream article truncation remains explicit',async()=>{
  const response=await run([{law_name:LAW,article:'제2조'}],fake(r=>r.name==='get_law_text'?lawBody(LAW,'제2조','20260701','① 학교의 회계에 관한 기준을 정한다.\n\n[응답 크기 제한] 30개 조문 중 1개만 포함'):undefined));
  assert.equal(response.status,'partial');assert.equal(response.results[0].articles[0].upstreamTruncated,true);assert.equal(response.results[0].articles[0].bodyRetrieved,true);
});

(async()=>{
  let passed=0;
  for(const {name,fn} of tests){try{await fn();passed++;console.log(`ok ${passed} - ${name}`);}catch(error){console.error(`not ok - ${name}`);throw error;}}
  console.log(JSON.stringify({suite:'legal-client',passed,total:tests.length,network:'none (injected client)'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});

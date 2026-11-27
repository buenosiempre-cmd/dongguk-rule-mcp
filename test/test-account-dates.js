'use strict';
const assert=require('node:assert/strict');
const {queryLegalReferences}=require('../src/legal-client.js');
const {reviewFinanceCase,formatFinanceReview}=require('../src/finance-desk.js');
const {findAccountCandidates}=require('../src/accounts.js');
const {LAW,NOW,createClient}=require('./fixtures/account-dates.js');
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const facts={campus:'서울',accounting_unit:'교비회계',purpose:'일반비용'};
const query='복사용지를 구입했는데 무슨 계정으로 처리해야 하는지 검토해줘';
async function evidence(options={}){return queryLegalReferences([{law_name:LAW,article:'제17조',annex:'별표 1'}],{client:createClient(options),now:NOW,baseDate:'2026-11-20'});}
(async()=>{
 for(const [label,extra] of [['기준일 없음',{}],['기준일',{base_date:'2026-11-20'}],['기준일과 계정코드',{base_date:'2026-11-20',account_code:'4223'}]])await check(label+' 실제 법령 어댑터를 거쳐 계정 후보 보존',async()=>{
  const client=createClient();
  const r=await reviewFinanceCase({query,facts:{...facts,...extra}},{searchHandbook:()=>({status:'ok',results:[]}),lookupRules:async()=>({status:'retrieved',results:[]}),queryLegalReferences:(requests,options)=>queryLegalReferences(requests,{...options,client,now:NOW})});
  assert.equal(r.accounts.status,'candidates_found');assert.equal(r.accounts.candidates.length,1);
  const c=r.accounts.candidates[0];assert.equal(c.code,'4223');assert.equal(c.name,'소모품비');assert.equal(c.decision_status,'candidate_requires_review');assert.equal(r.draft.fields.account_code,null);assert.equal(r.applicability,'requires_review');
  if(extra.base_date){assert.equal(c.law.lawId,null);assert.equal(c.law.mst,'251375');assert.equal(c.date_status,'historical_version_retrieved');assert.equal(c.reference_only,true);assert.equal(c.application_status,'requires_review');assert.match(formatFinanceReview(r),/적용 회계연도는 부칙 확인 필요/);assert(!client.calls.some(x=>x.name==='search_law'));}
  else {assert.equal(c.law.lawId,'007333');assert.equal(c.reference_only,true);assert.equal(c.application_status,'requires_review');assert.match(formatFinanceReview(r),/적용 회계연도는 부칙 확인 필요/);}
 });
 for(const [date,year,code] of [['2021-01-20','2021','4238'],['2025-02-15','2025','4999']])await check('시행 판본과 개정 별표 적용 회계연도를 구분: '+date,async()=>{
  const resolutionNote=`적용례·경과조치 발췌 (기준일 사건에 영향 가능 — 반드시 확인)\n부칙 제2조: 별표 1의 개정규정은 ${year}회계연도의 예산을 편성하는 경우부터 적용한다.`;
  const client=createClient({resolutionNote,account:{code,name:'회의비'}});
  const r=await reviewFinanceCase({query:'회의비 계정을 검토해줘',facts:{...facts,base_date:date}},{searchHandbook:()=>({status:'ok',results:[]}),lookupRules:async()=>({status:'retrieved',results:[]}),queryLegalReferences:(requests,options)=>queryLegalReferences(requests,{...options,client,now:NOW})});
  const c=r.accounts.candidates[0];assert.equal(c.code,code);assert.equal(c.date_status,'historical_version_retrieved');assert.equal(c.reference_only,true);assert.equal(c.application_status,'requires_review');assert.match(c.application_notice,/적용 회계연도는 부칙 확인 필요/);
  assert(r.legal.results.some(x=>x.dateResolution?.text.includes(resolutionNote)));assert.match(formatFinanceReview(r),/적용 회계연도는 부칙 확인 필요/);assert.equal(r.draft.fields.account_code,null);assert.equal(r.applicability,'requires_review');
 });
 for(const [label,mutate] of [['판단 근거 누락',r=>{delete r.dateResolution;}],['판단 근거 잘림',r=>{r.dateResolution={text:'적용례·경과조치',truncated:true};}]])await check('적용례를 판단할 수 없어도 적용 확정 금지: '+label,async()=>{
  const r=await evidence();mutate(r.results[0]);const c=findAccountCandidates(r,'복사용지','school').candidates[0];assert(c);assert.equal(c.reference_only,true);assert.equal(c.application_status,'requires_review');assert.equal(c.date_status,'historical_version_retrieved');
 });
 for(const proof of ['missing','mismatch'])await check('검증되지 않은 기준일 별표로 후보 생성 금지: '+proof,async()=>{const r=await evidence({proof});assert.equal(r.status,'partial');assert.equal(findAccountCandidates(r,'복사용지','school').candidates.length,0);});
 for(const [label,mutate] of [
  ['판본번호 누락',r=>{r.law.mst=null;}],['판본번호 불일치',r=>{r.annexes[0].source.mst='999999';}],
  ['시행일 불일치',r=>{r.annexes[0].source.effectiveAt='20210101';}],['기준일 불일치',r=>{r.annexes[0].source.baseDate='2026-11-21';}],
  ['법령명 불일치',r=>{r.annexes[0].source.lawName='다른 법령';}],['검증 표시 없음',r=>{delete r.annexes[0].source.versionVerified;}],
  ['본문 없음',r=>{r.annexes[0].bodyRetrieved=false;}],['다른 별표',r=>{r.annexes[0].selector='별표 2';}],
 ])await check('기준일 계정 출처 경계: '+label,async()=>{const r=await evidence();mutate(r.results[0]);assert.equal(findAccountCandidates(r,'복사용지','school').candidates.length,0);});
 await check('판본이 확인돼도 다른 회계에는 적용하지 않음',async()=>{const r=await evidence();assert.equal(findAccountCandidates(r,'복사용지','corporation_general').candidates.length,0);});
 await check('검증된 판본의 부분 본문은 참고·잘림 경고 유지',async()=>{const r=await evidence();const a=r.results[0].annexes[0];r.results[0].status='partial';a.status='partial';a.truncated=true;a.referenceOnly=true;a.dateStatus='historical_unverified';const c=findAccountCandidates(r,'복사용지','school').candidates[0];assert(c);assert.equal(c.reference_only,true);assert.equal(c.source_truncated,true);assert.equal(c.date_status,'historical_unverified');});
 console.log(`Dated account candidates: ${passed} passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
const assert=require('node:assert/strict');
const {prepareFinanceCase,reviewFinanceCase,formatFinanceReview,FACT_LABELS}=require('../src/finance-desk.js');
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const travel={base_date:'2026-10-27',campus:'서울',accounting_unit:'교비회계',employee_role:'직원',travel_scope:'국내'};
const honoraria={base_date:'2026-10-27',campus:'서울',accounting_unit:'교비회계',employment_relationship:'없음',tax_residency:'거주자',service_pattern:'일시적',service_location:'국내'};
const travelQuery='직원의 국내 출장 숙박비 비과세 기준 검토';
const honorariaQuery='외부 강사료 소득구분과 원천징수 검토';
function adapters(calls){
 return {
  searchHandbook:()=>{calls.push('handbook');throw Error('unrelated handbook');},
  selectPractice:()=>{calls.push('practice');throw Error('unrelated practice');},
  lookupRules:async(requests,context)=>{calls.push({kind:'rules',requests,context});return {status:'retrieved',results:requests.map(request=>({requested_reference:request,content:[{type:'text',text:'합성 교내 근거: '+request.keyword}]})),requested:requests.length};},
  queryLegalReferences:async(requests,options)=>{calls.push({kind:'legal',requests,options});return {status:'retrieved',baseDate:options.baseDate,results:requests.map(request=>({request,status:'retrieved',articles:[{selector:request.article,status:'retrieved',bodyRetrieved:true,dateStatus:'current',text:'합성 법령 근거',source:{url:'https://www.law.go.kr/법령/소득세법'}}]}))};},
 };
}
function expectNoSpecialRule(context){assert(!context.legal_requests.some(r=>r.law_name.includes('특례규칙')));}
async function main(){
 await check('travel routes to actual expense and tax source candidates',()=>{
  const r=prepareFinanceCase({query:travelQuery,facts:travel});
  assert.equal(r.workflow_id,'travel_expenses');assert.equal(r.routing_status,'ready');
  assert.deepEqual(r.rule_requests.map(x=>x.keyword),['여비규정']);
  assert.deepEqual(r.legal_requests,[{law_name:'소득세법',article:'제12조'},{law_name:'소득세법 시행령',article:'제12조'}]);
  assert.equal(r.applicability,'not_determined');expectNoSpecialRule(r);
 });
 await check('travel preserves overseas context rather than defaulting to domestic',()=>{
  const r=prepareFinanceCase({query:'국외출장 여비 검토',facts:{...travel,travel_scope:'국외'}});
  assert(r.rule_requests[0].terms.startsWith('국외,'));assert(!r.rule_requests[0].terms.includes('국내'));
 });
 await check('joint date and source calls use the same provided baseline',async()=>{
  const calls=[];const r=await reviewFinanceCase({query:travelQuery,facts:travel},adapters(calls));
  assert.equal(r.evidence_status,'retrieved');assert.equal(r.review.status,'requires_review');
  assert.equal(calls.find(x=>x.kind==='legal').options.baseDate,'2026-10-27');
  assert.equal(calls.find(x=>x.kind==='rules').context.base_date,'2026-10-27');
  assert(!calls.includes('handbook'));assert(!calls.includes('practice'));assert.equal(r.external_action_state,'none');
 });
 await check('missing critical date or relationship never queries current evidence by default',async()=>{
  for(const [query,facts,key] of [[travelQuery,travel,'base_date'],[travelQuery,travel,'employee_role'],[honorariaQuery,honoraria,'tax_residency'],[honorariaQuery,honoraria,'employment_relationship']]){
   const input={...facts};delete input[key];const calls=[];
   const r=await reviewFinanceCase({query,facts:input},adapters(calls));
   assert.equal(r.evidence_status,'needs_input');assert.equal(calls.length,0);assert(r.context.missing_facts.some(x=>x.key===key));
   assert(r.context.questions.length<=3);assert.equal(r.legal.status,'not_requested');
  }
 });
 await check('missing all facts prompts only necessary joint-workflow fields',()=>{
  const r=prepareFinanceCase({query:honorariaQuery});assert.equal(r.questions.length,3);
  assert(!r.missing_facts.some(x=>['evidence_status','evidence_type','payment_route','purpose'].includes(x.key)));
  assert(r.missing_facts.every(x=>Object.hasOwn(FACT_LABELS,x.key)));
 });
 await check('WISE is preserved with explicit original-scope review',async()=>{
  const calls=[];const r=await reviewFinanceCase({query:travelQuery,facts:{...travel,campus:'WISE'}},adapters(calls));
  assert.equal(calls.find(x=>x.kind==='rules').context.campus,'wise');assert(r.review.findings.some(x=>x.includes('WISE')));
 });
 await check('non-school accounting units are not given school tax/payment defaults',async()=>{
  for(const accounting_unit of ['산학협력단','병원','수익사업']){
   const calls=[];const r=await reviewFinanceCase({query:travelQuery,facts:{...travel,accounting_unit}},adapters(calls));
   assert.equal(calls.length,0);assert.equal(r.evidence_status,'scope_review_required');
  }
 });
 await check('external traveler is not treated as employee travel compensation',async()=>{
  const calls=[];const r=await reviewFinanceCase({query:travelQuery,facts:{...travel,employee_role:'외부 강사'}},adapters(calls));
  assert.equal(calls.length,0);assert.equal(r.context.routing_status,'scope_review_required');
 });
 await check('honoraria checks classification alternatives without selecting income type',()=>{
  const r=prepareFinanceCase({query:honorariaQuery,facts:honoraria});
  assert.equal(r.workflow_id,'external_honoraria');assert.equal(r.routing_status,'ready');expectNoSpecialRule(r);
  assert.deepEqual(r.legal_requests.map(x=>x.article),['제19조','제20조','제21조','제127조']);
  assert.equal(r.income_type,undefined);assert.equal(r.tax_rate,undefined);
  assert(r.workflow_warnings.some(x=>x.includes('기타소득')));
 });
 await check('lecture rule gap stays partial even when both MCP calls succeed',async()=>{
  const calls=[];const r=await reviewFinanceCase({query:honorariaQuery,facts:honoraria},adapters(calls));
  assert.equal(r.evidence_status,'partial');assert(r.context.source_gaps.some(x=>x.code==='HONORARIA_PAYMENT_RULE_UNCONFIRMED'));
  assert(r.review.findings.some(x=>x.includes('단가')));assert.equal(r.legal.status,'retrieved');
  assert.equal(r.handbook.status,'not_requested');assert.equal(r.practice.status,'not_requested');
 });
 await check('caller-identified payment rule is queried without inventing its existence',()=>{
  const r=prepareFinanceCase({query:honorariaQuery,facts:{...honoraria,internal_rule_name:'합성 외부강사 지급지침'}});
  assert.equal(r.rule_requests.at(-1).keyword,'합성 외부강사 지급지침');assert.equal(r.source_gaps.length,0);
  assert(!r.rule_requests.some(x=>x.keyword==='강사 인사규정 시행세칙'));
 });
 await check('missing or ambiguous caller-identified rule remains a source failure',async()=>{
  const calls=[];const d=adapters(calls);d.lookupRules=async()=>({status:'partial',results:[],requested:2});
  const r=await reviewFinanceCase({query:honorariaQuery,facts:{...honoraria,internal_rule_name:'합성 지급지침'}},d);
  assert.equal(r.evidence_status,'partial');assert(r.review.findings.some(x=>x.includes('미조회')));
 });
 await check('nonresident, overseas service, and employment cases branch away from resident external workflow',async()=>{
  for(const override of [{tax_residency:'비거주자'},{service_location:'국외'},{employment_relationship:'있음'}]){
   const calls=[];const r=await reviewFinanceCase({query:honorariaQuery,facts:{...honoraria,...override}},adapters(calls));
   assert.equal(calls.length,0);assert.equal(r.context.routing_status,'scope_review_required');
   assert.equal(r.legal.status,'not_requested');expectNoSpecialRule(r.context);
  }
 });
 await check('recurring service keeps classification alternatives rather than asserting other income',()=>{
  const r=prepareFinanceCase({query:honorariaQuery,facts:{...honoraria,service_pattern:'계속·반복'}});
  assert.equal(r.routing_status,'ready');assert(r.legal_requests.some(x=>x.article==='제19조'));assert.equal(r.income_type,undefined);
 });
 await check('mixed travel and lecture topics request separation before any calls',async()=>{
  const calls=[];const r=await reviewFinanceCase({query:'외부 강사료와 출장 여비 비과세 검토',facts:{...honoraria,...travel}},adapters(calls));
  assert.equal(r.context.routing_status,'ambiguous_workflow');assert.equal(calls.length,0);expectNoSpecialRule(r.context);
 });
 await check('retirement and payroll tax do not fall through to generic accounting provisions',async()=>{
  for(const query of ['퇴직연금 부담금 검토','직원 급여 원천징수 검토','직원 임금 지급 적정성 검토','소득세법 제21조 내용 찾아줘']){
   const calls=[];const r=await reviewFinanceCase({query,facts:travel},adapters(calls));
   assert.equal(r.context.routing_status,'specialist_review_required');assert.equal(calls.length,0);expectNoSpecialRule(r.context);
  }
 });
 await check('specific internal clauses stay internal including 취업규칙 payment day',async()=>{
  const calls=[];const r=await reviewFinanceCase({query:'취업규칙 제62조 임금 지급일 알려줘'},adapters(calls));
  assert.equal(r.context.intent,'reference_lookup');assert.equal(r.context.routing_status,undefined);
  assert.equal(calls.length,1);assert.equal(calls[0].kind,'rules');assert.equal(calls[0].requests[0].keyword,'취업규칙');
  assert.equal(calls[0].requests[0].article,'제62조');assert.equal(r.legal.status,'not_requested');
 });
 await check('both source directions fail visibly without marking the other as failed',async()=>{
  for(const failing of ['lookupRules','queryLegalReferences']){
   const calls=[];const d=adapters(calls);d[failing]=async()=>{throw Error('fixture source failure');};
   const r=await reviewFinanceCase({query:travelQuery,facts:travel},d);
   assert.equal(r.evidence_status,'partial');assert.equal(failing==='lookupRules'?r.rule_coverage.status:r.legal.status,'unavailable');
   assert.equal(failing==='lookupRules'?r.legal.status:r.rule_coverage.status,'retrieved');
   const rendered=formatFinanceReview(r);assert(rendered.includes('확인'));assert(!rendered.includes('fixture source failure'));
  }
 });
 await check('sensitive and malformed facts are blocked before route lookup',async()=>{
  for(const [query,facts] of [[travelQuery,{...travel,employee_role:'주민등록번호 900101-1234567'}],[honorariaQuery,{...honoraria,tax_residency:'maybe'}],[travelQuery,{...travel,travel_scope:'unclear'}],[honorariaQuery,{...honoraria,service_pattern:'모호함'}],[honorariaQuery,{...honoraria,internal_rule_name:'https://untrusted.example/rule'}]]){
   const calls=[];const r=await reviewFinanceCase({query,facts},adapters(calls));assert(r.error);assert.equal(calls.length,0);
  }
 });
 console.log(`Joint workflow routing: ${passed} passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {routeFinance,loadFinancePack}=require('../src/finance.js');
const {exactCurrentLaw}=require('../src/legal-client.js');
const configs=[
 ['travel',['출장','여비','숙박비','철도운임','일비'],['base_date','campus','employee_role','destination_type','travel_period','evidence_status']],
 ['lecturer',['강사료','강연료','외부강사','강사비','자문료'],['base_date','campus','employment_relation','recurrence','residency','payment_stage','evidence_status']],
 ['correction',['소득정정','소득수정','정정','과다지급','과소지급','수정신고','환입'],['base_date','campus','income_period','payment_period','reported_status','correction_direction','evidence_status']]
];
const pack=process.env.DONGGUK_FINANCE_PACK_PATH?loadFinancePack():{version:'synthetic-test',schema_version:'1.0',source_checked_at:'2026-09-05',workflows:configs.map(([id,keywords,keys])=>({id,title:id,keywords,required_facts:keys.map(key=>({key,label:key})),steps:['담당자 검토'],completion_evidence:['시스템 확인'],rule_requests:[],legal_requests:[],checks:[],source_notes:[]})),cards:configs.flatMap(([id])=>Array.from({length:5},(_,i)=>({id:`${id}:${i}`,workflow_id:id})))};
function facts(id){return Object.fromEntries(pack.workflows.find(w=>w.id===id).required_facts.map(f=>[f.key,f.key==='base_date'?'2026-09-05':f.key==='campus'?'서울':'확인함']));}
const groups={travel:['서울 출장 기준 확인','출장 여비를 검토','숙박비 증빙이 부족해','철도운임 확인','일비는 어디서 찾지','여비 기준이 예전과 달라','출장 기간이 길어','해외 출장 계획','팀원 출장 사전검토','출장 결의서 작성 준비'],lecturer:['강사료를 지급하려고 해','외부강사 사례 검토','강연료 지급 조건','강사비 소득 구분','자문료 지급 검토','외부 강사 계약 확인','강사료 비거주자 지급','강연료 원천세 준비','강사비 증빙 확인','자문료 고용관계가 불분명해'],correction:['소득정정이 필요해','소득 수정 절차','지급 뒤 정정해야 해','과다지급을 발견','과소지급 후 처리','수정신고 검토 준비','급여 환입 후 신고 확인','강사료 지급 후 소득정정','귀속월 정정 처리','지급명세서 정정 경로']};
const results=[];
const check=(id,fn)=>{try{fn();results.push({id,pass:true});}catch(e){results.push({id,pass:false,reason:e.message});}};
for(const [id,queries] of Object.entries(groups)) queries.forEach((q,i)=>check(`${id}-${i+1}`,()=>{const r=routeFinance(pack,q,facts(id));assert.equal(r.workflow?.id,id);assert.equal(r.status,'review_required');assert.equal(r.external_action_state,'none');assert.equal(r.cards.length,5);assert.equal(r.applicability,'not_determined');}));
for(const id of ['travel','lecturer','correction'])check(`missing-${id}`,()=>{const r=routeFinance(pack,groups[id][0]);assert.equal(r.status,'needs_input');assert(r.missing_facts.length>=6);});
check('unknown-is-missing',()=>{const f=facts('travel');f.employee_role='미확인';assert.equal(routeFinance(pack,'출장',f).missing_facts[0].key,'employee_role');});
for(const date of ['2026-02-30','2025-02-29','yesterday'])check(`date-${date}`,()=>assert.equal(routeFinance(pack,'출장',{...facts('travel'),base_date:date}).error,'INVALID_DATE'));
for(const [name,query] of [['empty',''],['too-long','출'.repeat(2001)],['unsupported','도서관 연장'],['ambiguous','출장 강사료']])check(name,()=>assert(routeFinance(pack,query).error));
check('invalid-object',()=>assert.equal(routeFinance(pack,'출장',[]).error,'INVALID_ARGUMENT'));
check('nested-facts',()=>assert.equal(routeFinance(pack,'출장',{base_date:{value:'2026-09-05'}}).error,'INVALID_ARGUMENT'));
check('unlisted-field',()=>assert.equal(routeFinance(pack,'출장',{...facts('travel'),private_note:'extra'}).error,'INVALID_ARGUMENT'));
check('sensitive-id',()=>assert.equal(routeFinance(pack,'출장 '+['000000','1000000'].join('-')).error,'SENSITIVE_INPUT'));
check('secret',()=>assert.equal(routeFinance(pack,'출장 password=example-only').error,'SENSITIVE_INPUT'));
check('unknown-workflow',()=>assert.equal(routeFinance(pack,'출장',{},'missing').error,'UNSUPPORTED_WORKFLOW'));
check('explicit-choice',()=>assert.equal(routeFinance(pack,'출장 강사료',facts('travel'),'travel').workflow.id,'travel'));
check('historical-date',()=>assert.equal(routeFinance(pack,'출장',{...facts('travel'),base_date:'2024년 2월 29일'}).base_date,'2024-02-29'));
// Search parser must not confuse a partial/future result with a current exact match.
check('legal-exact-current',()=>{const response={content:[{type:'text',text:'1. 소득세법 시행령 [현행]\n   - 법령ID: 003956\n   - MST: 111\n   - 공포일: 20260101 / 시행일: 20260101\n2. 소득세법 [현행]\n   - 법령ID: 001565\n   - MST: 222\n   - 공포일: 20260101 / 시행일: 20260701\n시행예정 MST: 333'}]};assert.equal(exactCurrentLaw(response,'소득세법').mst,'222');assert.equal(exactCurrentLaw(response,'국세기본법'),null);});
assert.equal(results.length,50);
if(pack.nodes){const ids=new Set(pack.nodes.map(n=>n.id));assert.equal(ids.size,pack.nodes.length);assert(pack.edges.every(e=>ids.has(e.source)&&ids.has(e.target)));assert.equal(pack.cards.length,15);}
const report={evaluated_at:new Date().toISOString(),pack_version:pack.version,method:'업무 라우팅·필수 사실·입력 경계·법령 식별 파싱의 자동 회귀 검증. 법률 정답률·현업 시간절감의 평가가 아님.',total:results.length,passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results};
console.log(JSON.stringify(report,null,2));
if(process.env.FINANCE_EVAL_OUTPUT)fs.writeFileSync(process.env.FINANCE_EVAL_OUTPUT,JSON.stringify(report,null,2)+'\n');
if(report.failed)process.exitCode=1;

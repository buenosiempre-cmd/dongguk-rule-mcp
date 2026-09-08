'use strict';
const fs = require('fs');
const { parseDateLoose } = require('./timeline.js');
const { success, failure } = require('./protocol.js');

function loadFinancePack() {
  const file = process.env.DONGGUK_FINANCE_PACK_PATH;
  if (!file) return null;
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pack.version || !Array.isArray(pack.workflows) || !Array.isArray(pack.cards)) throw new Error('재무지식 팩 형식이 올바르지 않습니다.');
  return pack;
}
function hasSensitiveInput(text) {
  return /\b01[016789][ -]?\d{3,4}[ -]?\d{4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:계좌|카드|주민등록)\s*(?:번호)?\s*[:=]?\s*\d[\d -]{7,}\d|\b\d{6}\s*[- ]\s*[1-8]\d{6}\b|\b(?:\d[ -]?){13,19}\b|(?:비밀번호|password|api[_ -]?key|인증토큰)\s*[:=]\s*\S+/i.test(text);
}
function routeFinance(pack, query, facts = {}, workflowId) {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) return {error:'INVALID_ARGUMENT',message:'질문은 1~2000자로 입력하세요.'};
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return {error:'INVALID_ARGUMENT',message:'facts는 확인한 사실의 객체여야 합니다.'};
  if (hasSensitiveInput(JSON.stringify({query,facts}))) return {error:'SENSITIVE_INPUT',message:'개인번호·계좌·인증정보를 제외한 업무 조건만 입력하세요.'};
  if(Object.keys(facts).length>20 || Object.values(facts).some(v=>typeof v!=='string'||v.length>120)) return {error:'INVALID_ARGUMENT',message:'업무 조건은 120자 이내의 문자열로 입력하세요.'};
  const normalized = query.replace(/\s+/g,'').toLowerCase();
  let candidates = pack.workflows.map(w=>({w,score:w.keywords.filter(k=>normalized.includes(k)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  if(workflowId) candidates=pack.workflows.filter(w=>w.id===workflowId).map(w=>({w,score:100}));
  if(!candidates.length) return {error:'UNSUPPORTED_WORKFLOW',message:'현재 지원하는 출장·강사료·소득정정 업무 중 하나를 선택하세요.'};
  if(candidates.length>1 && candidates[0].score===candidates[1].score) return {error:'AMBIGUOUS_WORKFLOW',message:'여러 업무가 함께 포함되어 있습니다. 먼저 처리할 업무를 선택하세요.',candidates:candidates.map(x=>x.w.id)};
  const w=candidates[0].w;
  const allowed=new Set(w.required_facts.map(f=>f.key));
  if(Object.keys(facts).some(k=>!allowed.has(k))) return {error:'INVALID_ARGUMENT',message:'선택한 업무에 필요한 조건만 입력하세요.'};
  const date=facts.base_date ? parseDateLoose(facts.base_date):null;
  if(facts.base_date && !date) return {error:'INVALID_DATE',message:'기준일을 실제 존재하는 날짜로 입력하세요.'};
  const required=w.required_facts;
  const missing=required.filter(f=>typeof facts[f.key]!=='string'||!facts[f.key].trim()||/^(미상|모름|unknown|미확인)$/.test(facts[f.key].trim()));
  const campusValue=(facts.campus||'').trim().toLowerCase();
  const campus=new Map([['서울','seoul'],['seoul','seoul'],['wise','wise'],['경주','wise']]).get(campusValue)||null;
  if(campusValue && !campus && !missing.some(f=>f.key==='campus')) return {error:'INVALID_ARGUMENT',message:'캠퍼스는 서울(seoul) 또는 WISE(경주)로 입력하세요.'};
  const cards=pack.cards.filter(c=>c.workflow_id===w.id);
  return {
    workflow:{id:w.id,title:w.title,owner_role:w.owner_role},
    pack:{version:pack.version,schema_version:pack.schema_version,source_checked_at:pack.source_checked_at},
    base_date:date?.iso||null, campus, status:missing.length?'needs_input':'review_required',
    missing_facts:missing, cards, steps:w.steps, completion_evidence:w.completion_evidence,
    rule_requests:w.rule_requests, legal_requests:w.legal_requests,
    source_notes:w.source_notes, sources:(pack.sources||[]).filter(s=>w.source_notes.includes(s.id)), checks:w.checks,
    review_state:'required',external_action_state:'none',
    scope_status:campus==='seoul'?'seoul_reference':'requires_campus_review',
    applicability:'not_determined',
    notice:'검토용 업무 경로입니다. 법령·규정 원문과 대상·시행일·증빙을 확인한 뒤 담당자가 판단합니다. 실제 저장·신고·지급은 수행하지 않았습니다.'
  };
}
function getFinanceContext(query, facts, workflowId, pack=loadFinancePack()) {
  if(!pack) return failure('FINANCE_PACK_NOT_CONFIGURED','재무지식 팩이 아직 연결되지 않았습니다.');
  const r=routeFinance(pack,query,facts,workflowId);
  if(r.error) return failure(r.error,r.message,{details:{candidates:r.candidates||[]}});
  const text=`# ${r.workflow.title}\n\n${r.notice}\n\n`+
    (r.missing_facts.length?`## 먼저 확인할 사실\n${r.missing_facts.map(x=>`- ${x.label}`).join('\n')}\n\n`:'')+
    `## 처리 순서\n${r.steps.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\n`+
    `## 완료 확인\n${r.completion_evidence.map(x=>`- ${x}`).join('\n')}`;
  return success(text,r);
}
module.exports={loadFinancePack,routeFinance,getFinanceContext,hasSensitiveInput};

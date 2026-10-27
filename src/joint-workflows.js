'use strict';

// These are source-selection maps, not income classifications or payment rules.
// On 2026-10-27 the live Korean Law MCP returned the named articles and titles:
// Income Tax Act 12 (비과세소득), 19 (사업소득), 20 (근로소득),
// 21 (기타소득), 127 (원천징수의무); Enforcement Decree 12 (실비변상적 급여의 범위).
// Each request still resolves the version for the user's actual base date.
const SOURCE_REVIEW = {
  checked_at:'2026-10-27',
  method:'Korean Law MCP search_law + dated get_law_text',
  sources:['https://www.law.go.kr/법령/소득세법','https://www.law.go.kr/법령/소득세법시행령'],
};
const JOINT_FACT_LABELS = {
  travel_scope:'국내 출장인가요, 국외 출장인가요?',
  employment_relationship:'강사와 학교 사이에 고용관계가 있나요(있음/없음)?',
  tax_residency:'소득세법상 거주자인가요, 비거주자인가요?',
  service_pattern:'강연 용역은 일시적인가요, 계속·반복하는 활동인가요?',
  service_location:'강연 용역을 국내에서 제공하나요, 국외에서 제공하나요?',
  internal_rule_name:'별도로 확인한 교내 지급 기준의 정확한 규정명은 무엇인가요?',
};
const flat = value => String(value||'').replace(/[\s·ㆍ]/g,'').toLowerCase();
const has = (value, choices) => choices.includes(flat(value));
const TRAVEL = /출장|여비|숙박비|철도운임|일비/;
const HONORARIA = /강사\s*료|강연\s*료|특강료|강연사례|강의\s*료|외부\s*강사|초청\s*강사|강사\s*인건비/;
const LEGAL_ISSUE = /비과세|과세|세금|세율|원천징수|소득구분|소득세|법령|법적|세법/;
const SPECIALIST_TOPIC = /퇴직|연금|급여|보수|임금|근로소득|원천징수|소득세|부가가치세|법인세|증여세|상속세|청탁금지|조세조약|비거주자/;
const baseRequired=['base_date','campus','accounting_unit'];

function prepareJointWorkflow({query,text='',known,unit,campus,referenceOnly,namedRules,explicitSpecial,labels}) {
  const all=query+'\n'+text;
  // A named internal article lookup (including 취업규칙) does not need a tax
  // workflow merely because the regulation concerns payroll or travel.
  if(referenceOnly && ((namedRules.length&&!LEGAL_ISSUE.test(query)) || explicitSpecial)) return null;
  const travel=TRAVEL.test(all),honoraria=HONORARIA.test(all);
  if(!travel&&!honoraria&&!SPECIALIST_TOPIC.test(all)) return null;
  const workflow=travel&&honoraria?'mixed':travel?'travel_expenses':honoraria?'external_honoraria':'specialist_topic';
  const required=workflow==='travel_expenses'?[...baseRequired,'employee_role','travel_scope']:
    workflow==='external_honoraria'?[...baseRequired,'employment_relationship','tax_residency','service_pattern','service_location']:[];
  const missing=required.filter(key=>!known[key]).map(key=>({key,label:labels[key]}));
  const warnings=[],gaps=[];
  let routingStatus=missing.length?'needs_input':'ready';
  let notice='교내 규정과 법령의 검토 근거를 함께 조회합니다. 소득구분·비과세·지급 가능 여부를 자동 확정하지 않습니다.';
  let questions=missing.slice(0,3);
  const rules=[],legal=[];
  if(workflow==='mixed') {
    routingStatus='ambiguous_workflow';
    notice='출장비와 강사료가 함께 포함되어 있습니다. 두 업무를 각각 나누어 조회하세요.';
    questions=[{key:'query',label:'출장비와 강사료 중 먼저 검토할 업무 하나로 질문을 나누어 주세요.'}];
  } else if(workflow==='specialist_topic') {
    routingStatus='specialist_review_required';
    notice='이 질문은 출장비·외부 강사료 자동 연결 범위 밖입니다. 일반 회계 조문으로 대체하지 않고 해당 직군·제도·세목의 법령을 별도로 조회해야 합니다.';
  } else if(unit&&!['school','corporation_general'].includes(unit)) {
    routingStatus='scope_review_required';
    notice='산학협력단·병원·수익사업의 지급·세무 검토에는 해당 회계와 대상의 별도 근거가 필요합니다. 교비 기준을 자동 적용하지 않습니다.';
  } else if(workflow==='travel_expenses') {
    if(known.travel_scope&&!has(known.travel_scope,['국내','국내출장','domestic','국외','해외','국외출장','해외출장','international']))
      return {error:'INVALID_ARGUMENT',message:'travel_scope는 국내 또는 국외로 입력하세요.'};
    if(known.employee_role&&!has(known.employee_role,['직원','교원','교수','교직원','employee','staff','faculty'])) {
      routingStatus='scope_review_required';
      notice='교원·직원의 출장비 원문 연결 범위입니다. 외부인·학생 등의 여비를 근로소득 비과세 근거에 자동 연결하지 않습니다.';
    }
    const scope=has(known.travel_scope,['국외','해외','국외출장','해외출장','international'])?'국외':'국내';
    rules.push({keyword:known.internal_rule_name||'여비규정',terms:`${scope},숙박비,운임,일비,실비,별표`,purpose:'출장비 지급 조건·별표의 원문 확인'});
    legal.push({law_name:'소득세법',article:'제12조'},{law_name:'소득세법 시행령',article:'제12조'});
    warnings.push('출장 목적·실제 지출·중복 보전·정액 지급 여부와 표의 행·단위를 확인해야 합니다.');
  } else {
    const resident=has(known.tax_residency,['거주자','국내거주자','resident']);
    const nonresident=has(known.tax_residency,['비거주자','nonresident','non-resident']);
    const employed=has(known.employment_relationship,['있음','고용관계있음','고용','employed','yes']);
    const independent=has(known.employment_relationship,['없음','고용관계없음','비고용','independent','no']);
    const domestic=has(known.service_location,['국내','대한민국','한국','domestic']);
    const overseas=has(known.service_location,['국외','해외','overseas']);
    if(known.service_pattern&&!has(known.service_pattern,['일시적','일시','일회성','일회','계속반복','계속적','반복적','계속','반복','temporary','recurring']))
      return {error:'INVALID_ARGUMENT',message:'service_pattern은 일시적 또는 계속·반복으로 입력하세요. 지급 횟수만으로 소득을 분류하지 않습니다.'};
    if((known.tax_residency&&!resident&&!nonresident)||(known.employment_relationship&&!employed&&!independent)||(known.service_location&&!domestic&&!overseas))
      return {error:'INVALID_ARGUMENT',message:'고용관계(있음/없음), 거주자 구분(거주자/비거주자), 용역 제공 장소(국내/국외)를 명확히 입력하세요.'};
    if(nonresident||employed||overseas) {
      routingStatus='scope_review_required';
      notice='국내 용역을 제공하는 거주자 외부 강사의 근거 연결 범위를 벗어납니다. 고용관계·국내원천소득·조세조약 등 대상별 법령 검토로 분기해야 합니다.';
    }
    rules.push({keyword:'위임전결규정',terms:'재무팀,지출,지급,승인',purpose:'결재 권한·절차 확인용이며 강사료 지급 단가의 근거가 아님'});
    if(known.internal_rule_name) rules.push({keyword:known.internal_rule_name,terms:'강사료,강연료,지급,수당',purpose:'사용자가 확인한 교내 지급 기준의 원문·적용범위 대조'});
    else gaps.push({code:'HONORARIA_PAYMENT_RULE_UNCONFIRMED',message:'외부 강사료의 교내 지급 기준·단가 근거가 확인되지 않았습니다. 위임전결규정만으로 지급 기준 확보를 완료한 것으로 보지 마세요.'});
    legal.push(...['제19조','제20조','제21조','제127조'].map(article=>({law_name:'소득세법',article})));
    warnings.push('강사료라는 명칭이나 일시 지급이라는 이유만으로 기타소득으로 분류하지 않습니다. 고용관계·활동의 계속성·독립성·계약 내용을 대조하세요.');
  }
  if(known.internal_rule_name&&!/^[가-힣A-Za-z0-9·ㆍ‧•・()（） \t]{1,110}(?:규정|규칙|세칙|학칙|정관|지침|내규|요령)$/.test(known.internal_rule_name))
    return {error:'INVALID_ARGUMENT',message:'internal_rule_name에는 확인한 교내 규정·지침의 정확한 명칭만 입력하세요.'};
  if(campus==='wise') warnings.push('WISE 캠퍼스는 서울 기준으로 자동 확정하지 않습니다. 조회된 규정의 제목과 적용범위를 별도로 확인하세요.');
  const ready=routingStatus==='ready';
  return {
    workflow_id:workflow,routing_status:routingStatus,intent:'joint_evidence_review',
    needs_handbook:false,needs_practice:false,
    missing_facts:missing,questions,remaining_question_count:Math.max(0,missing.length-3),
    rule_requests:ready?rules:[],legal_requests:ready?legal:[],
    planned_rule_requests:rules,planned_legal_requests:legal,
    source_gaps:gaps,workflow_warnings:warnings,source_map_review:SOURCE_REVIEW,
    source_mapping_status:'reference_candidates_not_applicability',
    suggested_next_tools:ready?[]:['lookup_dongguk_rule','search_law','legal_analysis'],
    notice,
  };
}
module.exports={prepareJointWorkflow,JOINT_FACT_LABELS};

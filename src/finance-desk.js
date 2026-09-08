'use strict';
const {parseDateLoose} = require('./timeline.js');
const {hasSensitiveInput} = require('./finance.js');
const {findAccountCandidates}=require('./accounts.js');

const SPECIAL_RULE = '사학기관 재무ㆍ회계 규칙에 대한 특례규칙';
const FACT_LABELS = {
  base_date:'어느 날짜의 거래 또는 검토인가요?', campus:'서울캠퍼스와 WISE 중 어디 업무인가요?',
  accounting_unit:'교비회계·법인회계·산학협력단 등 어느 회계의 업무인가요?',
  purpose:'새 비용 지급인가요, 자산 취득이나 기존 거래의 취소·반환인가요?',
  payment_route:'학교에서 직접 지급하나요, e나라도움 등에서 지급하나요?',
  payment_status:'이미 지급했나요, 지급 전인가요?',
  evidence_type:'받은 증빙은 세금계산서·법인카드·현금영수증 중 무엇인가요?',
  evidence_status:'증빙이 nDRIMS에 접수·확인됐나요?',
  fund_source:'어떤 재원의 예산인가요?', account_code:'검토할 계정과목은 무엇인가요?',
  employee_role:'어느 직군에 적용할 업무인가요?',
};
const UNKNOWN = /^(미상|모름|unknown|미확인|확인필요)$/i;
const compact = value => String(value || '').replace(/\s+/g,'');
const UNIT_ALIASES = new Map([
  ['교비','school'],['교비회계','school'],['등록금회계','school'],['비등록금회계','school'],['school','school'],
  ['법인','corporation_general'],['법인회계','corporation_general'],['법인일반업무회계','corporation_general'],['corporation_general','corporation_general'],
  ['산학협력단','industry_academic'],['산학협력단회계','industry_academic'],['industry_academic','industry_academic'],
  ['병원','hospital'],['부속병원회계','hospital'],['부속병원','hospital'],['hospital','hospital'],
  ['수익사업','profit_business'],['수익사업회계','profit_business'],['profit_business','profit_business'],
]);

function prepareFinanceCase({query, text='', facts={}} = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length>2000 || typeof text!=='string' || text.length>20000) return {error:'INVALID_ARGUMENT',message:'질문은 1~2000자, 검토할 본문은 20000자 이내로 입력하세요.'};
  if (!facts || typeof facts!=='object' || Array.isArray(facts) || Object.keys(facts).some(k=>!Object.hasOwn(FACT_LABELS,k)) || Object.values(facts).some(v=>typeof v!=='string'||v.length>120)) return {error:'INVALID_ARGUMENT',message:'확인한 업무 조건만 120자 이내의 문자열로 입력하세요.'};
  if (hasSensitiveInput(JSON.stringify({query,text,facts}))) return {error:'SENSITIVE_INPUT',message:'개인번호·계좌·인증정보를 제외한 업무 내용만 입력하세요.'};
  const known = Object.fromEntries(Object.entries(facts).map(([k,v])=>[k,v.trim()]).filter(([,v])=>v&&!UNKNOWN.test(v)));
  const basis = Object.fromEntries(Object.keys(known).map(k=>[k,'provided_fact']));
  const queryText = query+'\n'+text;
  // Infer only unambiguous explicit mentions, never an unstated transaction date or campus.
  if (!known.accounting_unit) {
    const mentions = [...new Set((queryText.match(/산학협력단(?:회계)?|부속병원(?:회계)?|수익사업회계|법인일반업무회계|법인회계|비등록금회계|등록금회계|교비회계/g)||[]).map(x=>UNIT_ALIASES.get(x)))];
    if (mentions.length===1) { known.accounting_unit=mentions[0]; basis.accounting_unit='explicit_query_mention'; }
  }
  const date = known.base_date ? parseDateLoose(known.base_date) : null;
  if (known.base_date && !date) return {error:'INVALID_DATE',message:'거래 기준일을 실제 존재하는 날짜로 입력하세요.'};
  if(date) known.base_date=date.iso;
  let campus=null;
  if(known.campus) {
    campus=new Map([['서울','seoul'],['서울캠퍼스','seoul'],['seoul','seoul'],['wise','wise'],['경주','wise'],['wise캠퍼스','wise']]).get(known.campus.toLowerCase());
    if(!campus) return {error:'INVALID_ARGUMENT',message:'캠퍼스는 서울 또는 WISE로 입력하세요.'};
  }
  const unit = known.accounting_unit ? UNIT_ALIASES.get(compact(known.accounting_unit)) : null;
  if(known.accounting_unit&&!unit) return {error:'INVALID_ARGUMENT',message:'회계구분을 교비·법인 일반·산학협력단·병원·수익사업 중 해당 범위로 알려주세요.'};
  const unsupported = unit && !['school','corporation_general'].includes(unit);
  const referenceOnly = !text && /(?:조문|해설|설명|내용|불러|찾아|제\s*\d+\s*조)/.test(query) && !/(?:검토|적정|맞[는아]|처리|지급|샀|구입|구매|취득)/.test(query);
  const needsPractice = /(?:증빙|결의|세금계산서|카드|영수증|지급)/.test(queryText);
  const required = referenceOnly ? [] : ['base_date','campus','accounting_unit','purpose',...(needsPractice?['payment_route','payment_status','evidence_type','evidence_status']:[])];
  const missing = required.filter(key=>!known[key]).map(key=>({key,label:FACT_LABELS[key]}));
  const terms=[...new Set(queryText.match(/선급금|집기비품|기계기구|건물|수선비|소모품비|소모품|도서|인쇄출판비|여비교통비|지급수수료|임차료|교육훈련비|예비비|업무추진비|회의비|등록금|기부금|기본금|감가상각|계정과목|세금계산서|증빙|자산|전결|구매|계약/g)||[])];
  const lookupQuery = [known.account_code,terms.join(' '),query].filter(Boolean).join(' ').slice(0,200);
  const quotedRules = [...new Set([...queryText.matchAll(/[「『]([^」』\n]{2,60}규정)[」』]/g)].map(m=>m[1]))];
  const plainRules = [...new Set([...query.matchAll(/(?:^|\s)([가-힣·ㆍ]{2,25}규정)/g)].map(m=>m[1]))];
  const namedRules=quotedRules.length?quotedRules:plainRules;
  const explicitSpecial=/특례규칙/.test(query);
  const explicitArticles=[...new Set([...query.matchAll(/제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g)].map(m=>`제${Number(m[1])}조${m[2]?'의'+Number(m[2]):''}`))];
  const explicitAnnexes=[...new Set([...query.matchAll(/별표\s*(\d+)/g)].map(m=>`별표 ${Number(m[1])}`))];
  const ruleRequests = unsupported || (referenceOnly&&explicitSpecial&&!namedRules.length) ? [] : (namedRules.length?namedRules:['위임전결 규정']).flatMap(keyword=>{
    const articles=namedRules.length&&!explicitSpecial?explicitArticles:[];
    return articles.length?articles.map(article=>({keyword,article,terms:article,purpose:'요청한 규정 조문 원문 확인'})):[{keyword,terms:terms.join(' ')||'전결',purpose:'기관 기준 원문 확인'}];
  });
  const legalRequests = unsupported || (referenceOnly&&namedRules.length&&!explicitSpecial) ? [] : explicitSpecial&&(explicitArticles.length||explicitAnnexes.length) ? [
    ...explicitArticles.map(article=>({law_name:SPECIAL_RULE,article})),
    ...explicitAnnexes.map(annex=>({law_name:SPECIAL_RULE,annex})),
  ] : [
    {law_name:SPECIAL_RULE,article:'제2조'},
    {law_name:SPECIAL_RULE,article:'제17조'},
    ...(!referenceOnly?[{law_name:SPECIAL_RULE,article:'제12조'}]:[]),
    ...(/계정|분개|자산|선급|소모품|구입|구매/.test(queryText)?[{law_name:SPECIAL_RULE,article:'제17조',annex:'별표 1'}]:[]),
  ];
  return {
    query, facts:known, fact_basis:basis, base_date:date?.iso||null,campus,accounting_unit:unit,
    intent:referenceOnly?'reference_lookup':'case_review',needs_practice:needsPractice&&!referenceOnly,
    needs_handbook:!referenceOnly||(!namedRules.length&&!explicitSpecial)||/해설/.test(query),
    scope_status:unsupported?'unsupported_accounting_unit':unit?'accounting_unit_identified':'accounting_unit_unconfirmed',
    missing_facts:missing,questions:missing.slice(0,3),remaining_question_count:Math.max(0,missing.length-3),
    lookup_query:lookupQuery,lookup_query_shortened:[known.account_code||'',terms.join(' '),query].join(' ').length>200,rule_requests:ruleRequests,legal_requests:legalRequests,
    applicability:'not_determined',external_action_state:'none',
    notice:unsupported?'해당 회계단위는 이번 일반 비용 검토 범위 밖입니다. 특례규칙·교비 해설을 자동 적용하지 않습니다.':'원문 조회와 업무 적정성 판단을 구분합니다. 필요한 조건과 근거가 갖춰진 결론만 제시하세요.',
  };
}

async function reviewFinanceCase(args, {searchHandbook,selectPractice,queryLegalReferences,lookupRules,verifyCitations} = {}) {
  const context=prepareFinanceCase(args);
  if(context.error) return context;
  if(context.scope_status==='unsupported_accounting_unit') return {context,evidence_status:'scope_review_required',handbook:{status:'not_requested',results:[]},practice:{status:'not_requested',candidates:[]},rules:[],legal:{status:'not_requested',results:[]},review:{status:'requires_specialist_review',findings:[context.notice]},applicability:'not_determined',external_action_state:'none'};
  const safe = async (fn, fallback) => {try{return await fn();}catch{return fallback;}};
  const [handbook,practice,rules,legal,citations]=await Promise.all([
    context.needs_handbook ? safe(()=>searchHandbook(context.lookup_query),{status:'unavailable',results:[],code:'HANDBOOK_LOOKUP_FAILED'}) : {status:'not_requested',results:[]},
    context.accounting_unit==='school' ? safe(()=>selectPractice({...context.facts,campus:context.campus||context.facts.campus}),{status:'unavailable',candidates:[],code:'PRACTICE_LOOKUP_FAILED'}) : {status:'not_requested',candidates:[],reason:'school_accounting_not_confirmed'},
    context.rule_requests.length ? safe(()=>lookupRules(context.rule_requests,context),{results:[],status:'unavailable',requested:context.rule_requests.length,omitted:context.rule_requests}) : {status:'not_requested',results:[]},
    context.legal_requests.length ? safe(()=>queryLegalReferences(context.legal_requests,{baseDate:context.base_date}),{status:'unavailable',results:[],requested:context.legal_requests.length,code:'LEGAL_LOOKUP_FAILED'}) : {status:'not_requested',results:[]},
    args.text && verifyCitations ? safe(()=>verifyCitations(args.text,context.campus||'all'),{status:'unavailable'}) : {status:'not_requested'},
  ]);
  const practiceIncomplete=context.needs_practice&&context.accounting_unit==='school'&&['unavailable','not_configured','invalid_pack','invalid_facts','no_match'].includes(practice.status);
  const citationData=citations.structuredContent?.data;
  const citationTruncated=citationData?.truncated===true||['citations','rules'].some(key=>citationData?.truncated?.[key]>0);
  const citationsIncomplete=!!args.text&&(citations.status==='unavailable'||citations.structuredContent?.ok===false||citationTruncated||['notFound','needsReview','floating'].some(key=>citationData?.summary?.[key]>0));
  const findings=[];
  if(context.missing_facts.length) findings.push('거래 조건이 부족하여 적정 여부와 계정을 확정하지 않았습니다.');
  if(!context.base_date) findings.push('기준일 미확인: 법령은 현재 조회 시점의 참고 자료입니다.');
  if(!context.accounting_unit) findings.push('회계단위 미확인: 교비·법인 일반회계의 자료를 적용 근거로 확정하지 마세요.');
  if(context.needs_handbook&&handbook.status!=='ok') findings.push('해설서 근거를 충분히 확보하지 못했습니다.');
  if(handbook.results?.some(r=>!r.usable_for_definitive_journal_entries)) findings.push('해설서 변환본의 분개·금액은 원문 표를 대조하기 전 확정하지 마세요.');
  if((context.rule_requests.length&&rules.status!=='retrieved')||(context.legal_requests.length&&legal.status!=='retrieved')) findings.push('법령 또는 교내 규정에 미조회·일부조회·시점 확인이 필요한 근거가 있습니다.');
  if(practice.candidates?.length) findings.push('실무 후보는 보유 매뉴얼 근거이며 현재 nDRIMS 화면과 담당 검토는 별도입니다.');
  if(practiceIncomplete) findings.push('요청한 증빙·실무 절차 근거를 조회하지 못했습니다.');
  if(citationsIncomplete) findings.push('기안문의 규정 인용 검증을 완료하지 못했습니다. 인용이 없거나 원문 확인이 필요한 항목을 확인하세요.');
  const partial=(context.needs_handbook&&handbook.status!=='ok')||(context.rule_requests.length&&rules.status!=='retrieved')||(context.legal_requests.length&&legal.status!=='retrieved')||practiceIncomplete||citationsIncomplete;
  const accounts=findAccountCandidates(legal,context.lookup_query,context.accounting_unit);
  return {
    context,handbook,practice,accounts,rules:rules.results||[],rule_coverage:rules,legal,citations,
    evidence_status:partial?'partial':'retrieved',
    review:{status:context.missing_facts.length?'needs_input':'requires_review',findings,questions:context.questions,
      output_contract:['검토 의견과 그 이유','주장별 법령·규정·해설의 인용 위치','확인된 조건과 미확인 조건','계정·증빙·절차 후보와 수정안'],
      prohibit:['조회 성공만으로 적정·지급가능 확정','해설서 검색 점수를 법적 효력으로 해석','미확인 계정코드·금액·담당자 생성'],
    },
    draft:{status:'outline_only',fields:{title:null,purpose:context.facts.purpose||null,base_date:context.base_date,accounting_unit:context.accounting_unit,account_code:null,amount:null},notice:'제공하지 않은 계정·금액·제목은 미입력 상태입니다. 근거 검토 후 사용자가 초안을 완성합니다.'},
    applicability:'requires_review',external_action_state:'none',retrieved_at:new Date().toISOString(),
  };
}

function formatFinanceReview(result) {
  const parts=['# Finance Desk 검토',result.context.notice];
  if(result.review?.findings?.length) parts.push(result.review.findings.map(x=>'- '+x).join('\n'));
  if(result.context.questions?.length) parts.push('## 필요한 확인',result.context.questions.map(x=>'- '+x.label).join('\n'));
  if(result.handbook?.results?.length) parts.push('## 해설서 근거',result.handbook.results.map(r=>`${r.heading}\n${r.excerpt}\n출처: ${r.edition}, ${r.locator?.start_line}~${r.locator?.end_line}줄 (${r.original_url})`).join('\n\n'));
  if(result.legal?.results?.length) parts.push('## 법령 근거',result.legal.results.map(r=>`${r.request?.law_name} ${r.request?.article||''}: ${r.status}\n${(r.articles||[]).map(a=>a.text||'').join('\n')}`).join('\n\n'));
  if(result.practice?.candidates?.length) parts.push('## 실무 후보',JSON.stringify(result.practice.candidates,null,2));
  if(result.accounts?.candidates?.length) parts.push('## 계정 후보',result.accounts.candidates.map(a=>`${a.code} ${a.name}: ${a.description}\n${result.accounts.notice}`).join('\n\n'));
  if(result.citations?.content?.length) parts.push('## 기안문 인용 확인',result.citations.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
  if(result.rules?.length) parts.push('## 교내 규정 근거',result.rules.map(r=>(r.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')).join('\n\n'));
  parts.push('조회한 규정 원문·별표·시점·누락 상태는 구조화 근거 묶음에서 함께 확인하세요.');
  return parts.filter(Boolean).join('\n\n');
}
module.exports={prepareFinanceCase,reviewFinanceCase,formatFinanceReview,FACT_LABELS};

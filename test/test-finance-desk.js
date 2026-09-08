'use strict';
const assert=require('node:assert/strict');
const {prepareFinanceCase,reviewFinanceCase,formatFinanceReview}=require('../src/finance-desk.js');
const {selectFinanceCards,routeFinance}=require('../src/finance.js');
const {parseAccountAppendix,findAccountCandidates}=require('../src/accounts.js');
const {verifyRuleCitations}=require('../src/citations.js');
const {success,serializeOutcome}=require('../src/protocol.js');
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const facts={base_date:'2026-09-08',campus:'서울',accounting_unit:'교비회계',purpose:'일반비용',payment_route:'학교직접지급',payment_status:'지급전',evidence_type:'세금계산서',evidence_status:'접수확인'};
const annex='<table><tr><th colspan="11">자금계산서 계정과목 명세표</th></tr><tr><td colspan="6">과목</td><td colspan="4">적용회계</td><td rowspan="2">해설</td></tr><tr><td colspan="2">관</td><td colspan="2">항</td><td colspan="2">목</td><td colspan="2">법인<br>회계</td><td colspan="2">학교<br>회계</td></tr><tr><td colspan="2"></td><td colspan="2"></td><td colspan="2">4223</td><td colspan="2"></td><td colspan="2"></td><td></td></tr><tr><td colspan="2"></td><td colspan="2"></td><td colspan="2">소모품비</td><td colspan="2">×</td><td colspan="2">○</td><td>합성 테스트 설명</td></tr></table>';
const deps={searchHandbook:()=>({status:'ok',results:[{heading:'소모품비',usable_for_definitive_journal_entries:false}]}),selectPractice:()=>({status:'review_required',candidates:[{tab:'세금계산서',review_status:'manual_reference_unverified_current_ui'}]}),queryLegalReferences:async requests=>({status:'retrieved',results:requests.map(request=>({request,status:'retrieved',law:{name:'사학기관 재무ㆍ회계 규칙에 대한 특례규칙',lawId:'007333'},articles:[],annexes:request.annex?[{text:annex,status:'retrieved',bodyRetrieved:true,selector:'별표 1',dateStatus:'current',referenceOnly:false}]:[]}))}),lookupRules:async requests=>({status:'retrieved',results:requests.map(request=>({request})),requested:requests.length,omitted:[]})};
const accountEvidence=()=>({status:'retrieved',results:[{status:'retrieved',law:{name:'사학기관 재무ㆍ회계 규칙에 대한 특례규칙',lawId:'007333',mst:'251375',sourceUrl:'https://www.law.go.kr/lsInfoP.do?lsId=007333'},request:{annex:'별표 1'},annexes:[{status:'retrieved',bodyRetrieved:true,selector:'별표 1',text:annex,dateStatus:'current',referenceOnly:false}]}]});
const citationDeps={searchRule:async()=>({hits:[{lawId:900,historyId:901,title:'합성규정',revisedAt:'2026.01.01'}]}),resolveLatest:async()=>({historyId:901,revisedAt:'2026.01.01'}),getRuleMarkdown:async()=> '### 제1조(목적)\n① 합성 회귀 검증을 위한 조문이다.'};
async function checkedCitations(text){const r=await verifyRuleCitations(text,citationDeps);return serializeOutcome('verify_rule_citations',success(r.text,r));}
async function main(){
  await check('short question needs at most three questions',()=>{const r=prepareFinanceCase({query:'이거 무슨 계정이야?'});assert(!r.error);assert.equal(r.questions.length,3);assert.equal(r.accounting_unit,null);assert(r.remaining_question_count>0);});
  await check('reference lookup does not require transaction facts',()=>{const r=prepareFinanceCase({query:'소모품비 해설서 내용 찾아줘'});assert.equal(r.intent,'reference_lookup');assert.equal(r.questions.length,0);});
  await check('known facts not asked again',()=>{const r=prepareFinanceCase({query:'소모품비 증빙 검토',facts});assert.equal(r.missing_facts.length,0);assert.equal(r.campus,'seoul');assert.equal(r.accounting_unit,'school');});
  await check('unknown facts stay unknown',()=>assert(prepareFinanceCase({query:'증빙 검토',facts:{...facts,evidence_status:'미확인'}}).missing_facts.some(x=>x.key==='evidence_status')));
  await check('invalid calendar date rejected',()=>assert.equal(prepareFinanceCase({query:'검토',facts:{base_date:'2026-02-30'}}).error,'INVALID_DATE'));
  await check('unknown facts rejected',()=>assert.equal(prepareFinanceCase({query:'검토',facts:{secret:'x'}}).error,'INVALID_ARGUMENT'));
  await check('nested facts rejected',()=>assert.equal(prepareFinanceCase({query:'검토',facts:{purpose:{x:1}}}).error,'INVALID_ARGUMENT'));
  await check('sensitive text blocked',()=>assert.equal(prepareFinanceCase({query:'검토',text:'password=synthetic-only'}).error,'SENSITIVE_INPUT'));
  await check('body max enforced',()=>assert.equal(prepareFinanceCase({query:'검토',text:'x'.repeat(20001)}).error,'INVALID_ARGUMENT'));
  await check('explicit campus required',()=>assert.equal(prepareFinanceCase({query:'검토',facts:{campus:'부산'}}).error,'INVALID_ARGUMENT'));
  await check('reference to two accounting units remains unknown',()=>assert.equal(prepareFinanceCase({query:'교비회계와 산학협력단회계 차이를 검토'}).accounting_unit,null));
  for(const unit of ['산학협력단','병원','수익사업'])await check(unit+' excluded before any source lookup',async()=>{let count=0;const d=Object.fromEntries(Object.keys(deps).map(k=>[k,()=>{count++;throw Error('should not run');}]));const r=await reviewFinanceCase({query:'계정 검토',facts:{...facts,accounting_unit:unit}},d);assert.equal(count,0);assert.equal(r.evidence_status,'scope_review_required');assert.equal(r.applicability,'not_determined');});
  await check('all requests and actual date passed to adapters',async()=>{let requests,options;const r=await reviewFinanceCase({query:'소모품비 계정과 증빙 검토',facts},{...deps,queryLegalReferences:async(a,b)=>{requests=a;options=b;return deps.queryLegalReferences(a,b);}});assert.equal(requests.length,4);assert.equal(options.baseDate,'2026-09-08');assert.equal(r.review.status,'requires_review');assert.equal(r.applicability,'requires_review');assert.equal(r.external_action_state,'none');assert.equal(r.accounts.candidates[0].code,'4223');assert.equal(r.draft.fields.account_code,null);});
  await check('source failure never claims full retrieval',async()=>{const r=await reviewFinanceCase({query:'소모품비 검토',facts},{...deps,queryLegalReferences:()=>{throw Error('unavailable');}});assert.equal(r.evidence_status,'partial');assert.equal(r.legal.status,'unavailable');});
  await check('missing handbook remains partial',async()=>{const r=await reviewFinanceCase({query:'소모품비 검토',facts},{...deps,searchHandbook:()=>({status:'not_configured',results:[]})});assert.equal(r.evidence_status,'partial');});
  await check('citations checked only when document provided',async()=>{let called=false;const r=await reviewFinanceCase({query:'이 기안문 검토',text:'「합성규정」 제1조에 따른다.',facts},{...deps,verifyCitations:async()=>{called=true;return {status:'checked'};}});assert(called);assert.equal(r.citations.status,'checked');});
  const cards=[{id:'a',workflow_id:'expense',conditions:{accounting_unit:'교비회계',employee_role:['직원']}},{id:'b',workflow_id:'expense',conditions:{accounting_unit:'법인회계'}},{id:'old',workflow_id:'expense',valid_until:'2025-12-31'},{id:'legacy',workflow_id:'expense'}];
  await check('mismatched accounts and expired cards excluded',()=>{const r=selectFinanceCards(cards,'expense',{...facts,employee_role:'직원'});assert.deepEqual(r.selected.map(x=>x.id),['a','legacy']);assert.deepEqual(r.excluded.map(x=>x.id),['b','old']);assert.equal(r.selected[1].condition_status,'unscoped_requires_review');});
  await check('unconfirmed card conditions are pending',()=>{const r=selectFinanceCards(cards,'expense',{base_date:'2026-09-08'});assert.equal(r.pending.length,2);assert.deepEqual(r.selected.map(x=>x.id),['legacy']);});
  await check('invalid card schema rejected',()=>assert.throws(()=>selectFinanceCards([{id:'x',workflow_id:'expense',conditions:{a:{}}}],'expense',{})));
  await check('merged header mapped to account code and scope',()=>{const r=parseAccountAppendix(annex);assert.equal(r.length,1);assert.equal(r[0].code,'4223');assert.equal(r[0].name,'소모품비');assert.equal(r[0].applicable_to.school,true);assert.equal(r[0].applicable_to.corporation_general,false);});
  await check('scope mismatch never becomes account candidate',()=>{const legal={results:[{status:'retrieved',law:{name:'사학기관 재무ㆍ회계 규칙에 대한 특례규칙',lawId:'007333'},request:{annex:'별표 1'},annexes:[{status:'retrieved',bodyRetrieved:true,selector:'별표 1',text:annex}]}]};assert.equal(findAccountCandidates(legal,'소모품비','corporation_general').candidates.length,0);assert.equal(findAccountCandidates(legal,'소모품비',null).status,'scope_unconfirmed');});
  await check('table without verified header not parsed',()=>assert.equal(parseAccountAppendix('<table><tr><td>4223 소모품비</td></tr></table>').length,0));
  await check('unknown generic purchase does not invent account',()=>assert.equal(findAccountCandidates({results:[]},'이거 구입했어','school').candidates.length,0));
  await check('explicit special-rule article reaches legal adapter unchanged',async()=>{
    let observed;const forbidden=()=>{throw Error('unrelated source adapter must not run');};
    const r=await reviewFinanceCase({query:'특례규칙 제9조 내용 찾아줘'}, {...deps,searchHandbook:forbidden,lookupRules:forbidden,queryLegalReferences:async requests=>{observed=requests;return deps.queryLegalReferences(requests);}});
    assert.deepEqual(observed,[{law_name:'사학기관 재무ㆍ회계 규칙에 대한 특례규칙',article:'제9조'}]);
    assert.equal(r.context.intent,'reference_lookup');assert.equal(r.rule_coverage.status,'not_requested');
    assert.equal(r.handbook.status,'not_requested');assert.equal(r.evidence_status,'retrieved');
  });
  await check('explicit branch article and annex preserve their selectors',()=>{
    const r=prepareFinanceCase({query:'특례규칙 제26조의2 및 별표 3 내용 찾아줘'});
    assert.deepEqual(r.legal_requests.map(x=>x.article||x.annex),['제26조의2','별표 3']);assert.equal(r.rule_requests.length,0);
  });
  for(const query of ['여비규정 제3조 내용 찾아줘','「여비규정」 제3조 내용 찾아줘'])await check('named internal article routes exactly: '+query,async()=>{
    let observed;const r=await reviewFinanceCase({query},{...deps,lookupRules:async requests=>{observed=requests;return deps.lookupRules(requests);}});
    assert.equal(observed.length,1);assert.equal(observed[0].keyword,'여비규정');assert.equal(observed[0].article,'제3조');
    assert.equal(r.legal.status,'not_requested');assert.equal(r.handbook.status,'not_requested');assert.equal(r.evidence_status,'retrieved');
  });
  for(const status of ['unavailable','not_configured','invalid_pack','invalid_facts','no_match'])await check('requested practice failure remains partial: '+status,async()=>{
    const r=await reviewFinanceCase({query:'소모품비 증빙 검토',facts},{...deps,selectPractice:()=>({status,candidates:[]})});
    assert.equal(r.evidence_status,'partial');assert(r.review.findings.some(x=>/증빙|실무/.test(x)&&/조회하지 못|확보하지 못/.test(x)));
  });
  await check('corporation scope does not invoke school-only practice',async()=>{
    let called=false;const r=await reviewFinanceCase({query:'증빙 검토',facts:{...facts,accounting_unit:'법인회계'}},{...deps,selectPractice:()=>{called=true;return deps.selectPractice();}});
    assert.equal(called,false);assert.equal(r.practice.status,'not_requested');assert.equal(r.context.accounting_unit,'corporation_general');
  });
  await check('failed citation tool becomes partial evidence with visible warning',async()=>{
    const r=await reviewFinanceCase({query:'기안문 검토',text:'「합성규정」 제1조',facts},{...deps,verifyCitations:()=>({structuredContent:{ok:false,error:{code:'TEST_UNAVAILABLE'}}})});
    assert.equal(r.evidence_status,'partial');assert(r.review.findings.some(x=>/인용/.test(x)));assert(/인용/.test(formatFinanceReview(r)));
  });
  for(const [text,key] of [['「합성규정」 제999조','notFound'],['「합성규정」 제1조(잘못된제목)','needsReview']])await check('actual citation summary propagates '+key,async()=>{
    const r=await reviewFinanceCase({query:'기안문 검토',text,facts},{...deps,verifyCitations:checkedCitations});
    assert.equal(r.citations.structuredContent.ok,true);assert(r.citations.structuredContent.data.summary[key]>0);
    assert.equal(r.evidence_status,'partial');assert(r.review.findings.some(x=>/인용/.test(x)));
    const rendered=formatFinanceReview(r);assert(rendered.includes('합성규정'));assert(rendered.includes(r.citations.structuredContent.data.citations[0].note));
  });
  await check('floating reference from actual citation parser needs review',async()=>{
    const r=await reviewFinanceCase({query:'기안문 검토',text:'제9조에 따라 검토한다.',facts},{...deps,verifyCitations:checkedCitations});
    assert(r.citations.structuredContent.data.summary.floating>0);assert.equal(r.evidence_status,'partial');assert(r.review.findings.some(x=>/인용/.test(x)));
  });
  await check('verified citation does not become a false missing-source failure',async()=>{
    const r=await reviewFinanceCase({query:'기안문 검토',text:'「합성규정」 제1조',facts},{...deps,verifyCitations:checkedCitations});
    assert.equal(r.citations.structuredContent.data.summary.verified,1);assert.equal(r.evidence_status,'retrieved');
  });
  await check('actual omitted citations stay partial even when returned citations verify',async()=>{
    const verifyLimited=async text=>{const checked=await verifyRuleCitations(text,citationDeps,{maxCitations:1});return serializeOutcome('verify_rule_citations',success(checked.text,checked));};
    const r=await reviewFinanceCase({query:'기안문 검토',text:'「합성규정」 제1조와 「합성규정」 제2조를 확인한다.',facts},{...deps,verifyCitations:verifyLimited});
    assert.equal(r.citations.structuredContent.data.summary.verified,1);assert.equal(r.citations.structuredContent.data.truncated.citations,1);
    assert.equal(r.evidence_status,'partial');assert(r.review.findings.some(x=>/인용/.test(x)));
  });
  for(const [name,mutate] of [
    ['unavailable result',r=>{r.status='unavailable';}],['missing law',r=>{r.law=null;}],['missing law identity',r=>{delete r.law.lawId;}],
    ['wrong law',r=>{r.law.name='다른 법령';}],['unavailable annex',r=>{r.annexes[0].status='unavailable';}],
    ['body not retrieved',r=>{r.annexes[0].bodyRetrieved=false;}],['missing selector',r=>{delete r.annexes[0].selector;}],['other annex',r=>{r.annexes[0].selector='별표 3';}],
  ])await check('unverified account source cannot create candidate: '+name,()=>{
    const legal=accountEvidence();mutate(legal.results[0]);assert.equal(findAccountCandidates(legal,'소모품비','school').candidates.length,0);
  });
  await check('partial account appendix retains reference and date limitations',()=>{
    const legal=accountEvidence();const a=legal.results[0].annexes[0];legal.status='partial';legal.results[0].status='partial';
    a.status='partial';a.dateStatus='historical_unverified';a.referenceOnly=true;a.truncated=true;
    const r=findAccountCandidates(legal,'소모품비','school');assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].reference_only,true);
    assert.equal(r.candidates[0].date_status,'historical_unverified');assert.equal(r.candidates[0].source_truncated,true);
  });
  await check('explicit four-digit account code finds the verified appendix candidate',()=>{
    const r=findAccountCandidates(accountEvidence(),'4223 계정 검토','school');assert.equal(r.candidates[0]?.code,'4223');
    assert.equal(findAccountCandidates(accountEvidence(),'14223 계정 검토','school').candidates.length,0);
  });
  await check('provided account code reaches account lookup without inventing a code',async()=>{
    const r=await reviewFinanceCase({query:'이 계정 검토해줘',facts:{...facts,account_code:'4223'}},{...deps,queryLegalReferences:async()=>accountEvidence()});
    assert(r.context.lookup_query.includes('4223'));assert.equal(r.accounts.candidates[0]?.code,'4223');assert.equal(r.draft.fields.account_code,null);
  });
  await check('supported campus aliases select the same applicable card through routing',()=>{
    const workflow={id:'expense',title:'합성 업무',keywords:['검토'],required_facts:[{key:'campus',label:'캠퍼스'}],source_notes:[],steps:[],completion_evidence:[],rule_requests:[],legal_requests:[],checks:[]};
    const pack={version:'synthetic',workflows:[workflow],cards:[{id:'seoul-card',workflow_id:'expense',conditions:{campus:'서울'}}],sources:[]};
    for(const campus of ['서울','seoul']){const r=routeFinance(pack,'검토',{campus});assert.equal(r.campus,'seoul');assert.deepEqual(r.cards.map(x=>x.id),['seoul-card']);}
  });
  console.log(`Finance Desk: ${passed} passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

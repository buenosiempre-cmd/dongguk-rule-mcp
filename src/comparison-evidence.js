'use strict';
const {compareRuleMarkdown,formatVersionComparison}=require('./versioning.js');
const {compareAppendices,extractAppendices,normalizeAppendixText}=require('./appendices.js');
const {compareOriginalEvidence}=require('./hwp-evidence.js');

function combineAppendices(before,after,structure,maxChanges) {
  const result=compareAppendices(before.markdown,after.markdown,{maxChanges:50});
  const left=extractAppendices(before.markdown),right=extractAppendices(after.markdown);
  const byKey=new Map(result.changes.map(x=>[x.appendix,x]));
  const structureKeys=new Set(structure.changedAppendices||[]);
  for(const group of ['tables','images','objects']) {
    for(const change of structure[group]?.changes||[]) {
      const key=change.appendix||change.after?.appendix||change.before?.appendix;
      if(key) structureKeys.add(key);
    }
  }
  for(const key of structureKeys) {
    if(byKey.has(key)||result.ambiguous.includes(key)) continue;
    const a=left.filter(x=>x.key===key),b=right.filter(x=>x.key===key);
    if(a.length!==1||b.length!==1) continue;
    if(normalizeAppendixText(a[0].text)!==normalizeAppendixText(b[0].text)) continue;
    result.counts.unchanged--;result.counts.changed++;
    byKey.set(key,{appendix:key,type:'changed',reason:'STRUCTURE_CHANGED',before:a[0].text.slice(0,2000),after:b[0].text.slice(0,2000),truncated:a[0].text.length>2000||b[0].text.length>2000});
  }
  const changes=[...byKey.values()];
  result.changes=changes.slice(0,maxChanges);
  result.changesTruncated=result.changesTruncated||changes.length>maxChanges;
  result.scope='hwp_appendix_text_and_structure';
  result.status=result.ambiguous.length||result.boundaryWarnings.length||structure.status!=='compared'?'partial':
    !left.length&&!right.length?'not_identified':'compared';
  result.caveat='별표 텍스트와 표의 셀 위치·병합 구조, 포함된 그림 파일의 내용을 비교했습니다.';
  if(result.boundaryWarnings.length) result.caveat+=' 서식과 본칙 경계가 모호한 위치는 아래 진단을 확인하세요.';
  return result;
}

function compareEvidence({beforeOriginal,afterOriginal,beforeHtml,afterHtml,article,maxChanges=20,includeAppendices=true}) {
  const originals=beforeOriginal?.structure&&afterOriginal?.structure;
  let comparison,scope='hwp_original_articles',fallback=null;
  if(originals) comparison=compareRuleMarkdown(beforeOriginal.bodyMarkdown,afterOriginal.bodyMarkdown,{article});
  if(!originals||comparison?.error==='CONTENT_UNAVAILABLE') {
    fallback={code:originals?'HWP_ARTICLES_UNAVAILABLE':'HWP_ORIGINAL_UNAVAILABLE',message:originals?'HWP 본문에서 비교할 조문을 식별하지 못해 HTML 조문으로 대체했습니다.':'두 개정본의 HWP 구조를 모두 확보하지 못해 HTML 조문으로 대체했습니다.'};
    comparison=compareRuleMarkdown(beforeHtml?.markdown,afterHtml?.markdown,{article});
    scope='html_articles_fallback';
  }
  if(comparison.error) return {error:comparison.error};
  const originalComparison=originals?compareOriginalEvidence(beforeOriginal,afterOriginal,{maxChanges:50,includeAppendices}):
    {status:'unavailable',scope:'hwp_original_structure',coverage:{diagnostics:[fallback]},tables:null,images:null,objects:null};
  const appendixComparison=!includeAppendices?{status:'not_requested',scope:'hwp_appendix_text_and_structure'}:
    originals?combineAppendices(beforeOriginal,afterOriginal,originalComparison,maxChanges):
    {status:'unavailable',scope:'hwp_appendix_text_and_structure',code:'HWP_COMPARISON_UNAVAILABLE'};
  const changesTruncated=comparison.changes.length>maxChanges||comparison.changes.some(x=>x.truncated);
  const hasTruncation=value=>!!value&&typeof value==='object'&&(Object.entries(value).some(([key,x])=>/Truncated$|^truncated$/.test(key)&&x===true)||Object.values(value).some(x=>typeof x==='object'&&hasTruncation(x)));
  const structuresTruncated=hasTruncation(originalComparison)||['tables','images','objects'].some(k=>(originalComparison[k]?.changes.length||0)>maxChanges||originalComparison[k]?.changes.some(x=>JSON.stringify(x).length>3500));
  const appendixIncomplete=includeAppendices&&(appendixComparison.status==='partial'||appendixComparison.status==='unavailable'||appendixComparison.changesTruncated||appendixComparison.changes?.some(x=>x.truncated));
  const evidenceStatus=fallback||originalComparison.status!=='compared'||changesTruncated||structuresTruncated||appendixIncomplete?'partial':'retrieved';
  return {comparison,comparisonScope:scope,originalComparison,appendixComparison,fallback,evidenceStatus,changesTruncated};
}

function formatEvidence(result,{title,fromHistoryId,toHistoryId,maxChanges=20}) {
  let text=result.fallback?'> '+result.fallback.message:
    '> 조문 비교 기준: 원본 HWP. 표의 셀 위치·병합 구조와 그림 파일 변경도 함께 확인합니다.';
  text+='\n\n'+formatVersionComparison(result.comparison,{title,fromHistoryId,toHistoryId,maxChanges});
  const ap=result.appendixComparison,oc=result.originalComparison;
  if(ap.status!=='not_requested') {
    text+='\n\n## HWP 별표·서식 비교\n상태: '+ap.status+'\n';
    if(ap.caveat) text+=ap.caveat+'\n';
    if(ap.status==='unavailable') text+='원본 HWP 비교를 완료하지 못했습니다. 별표가 같다고 판단할 수 없습니다.\n';
    if(ap.status==='not_identified') text+='파싱된 원문에서 별표·서식 제목을 식별하지 못했습니다.\n';
    for(const x of ap.changes||[]) text+='\n### '+x.appendix+': '+x.type+(x.reason?' (셀·그림 구조 변경)':'')+'\n이전:\n'+x.before+'\n\n이후:\n'+x.after+'\n'+(x.truncated?'\n> 이 별표의 표시 내용이 잘렸습니다.\n':'');
    if(ap.changesTruncated) text+='\n> 일부 별표 변경 표시가 생략됐습니다.\n';
  }
  text+='\n\n## 원본 구조 비교\n상태: '+oc.status+'\n';
  for(const [key,label] of [['tables','표'],['images','그림 파일'],['objects','기타 개체']]) {
    const group=oc[key];if(!group)continue;
    const c=group.counts;
    text+='\n- '+label+': 추가 '+c.added+', 삭제 '+c.removed+', 변경 '+c.changed+', 동일 '+c.unchanged;
    for(const x of (group.changes||[]).slice(0,maxChanges)) {
      // Evidence objects contain coordinates, text and digests only, never image bytes.
      text+='\n  - '+(x.appendix||x.location||x.key||label)+': '+(x.type||x.status);
      const details=JSON.stringify(x);
      text+='\n\n'+(details.length<=3500?details:details.slice(0,3500)+' …(표시 생략)')+'\n';
    }
    if(group.changesTruncated||group.changes.length>maxChanges)text+='\n> 일부 구조 변경 표시가 생략됐습니다.\n';
  }
  const diagnostics=oc.coverage?.diagnostics||['before','after'].flatMap(side=>(oc.coverage?.[side]?.diagnostics||[]).map(x=>({...x,side})));
  if(diagnostics.length) {
    text+='\n\n### 확인된 추출 진단\n';
    for(const x of diagnostics.slice(0,50))text+='- '+(x.side?x.side+' ':'')+(x.code||'HWP_COVERAGE')+': '+(x.message||x.reason||'')+(x.location?' ('+x.location+')':'')+'\n';
  }
  text+='\n\n그림은 파일 내용의 동일·변경을 비교합니다. 그림 속 글자의 OCR·의미 판단, 원본 화면의 배치 및 법적 적용성은 이 비교 범위에 포함하지 않습니다.';
  text+='\n\n근거 조회 상태: '+result.evidenceStatus+'.';
  return text;
}
module.exports={compareEvidence,formatEvidence,combineAppendices};

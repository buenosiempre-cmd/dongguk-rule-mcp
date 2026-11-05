'use strict';
const assert=require('node:assert/strict');
const {buildOriginalEvidence}=require('../src/hwp-evidence.js');
const {compareEvidence,formatEvidence}=require('../src/comparison-evidence.js');
const p=(text,controls=[])=>({text,runs:[],controls});
const cell=(text,col=0,colSpan=1)=>({row:0,col,rowSpan:1,colSpan,paragraphs:[p(text)]});
const table=cells=>({kind:'table',rowCount:1,colCount:2,cells});
function original({body='원문 기준',cells=[cell('A',0),cell('B',1)],image='same',id=1,unsupported=false}={}) {
  return buildOriginalEvidence({sections:[{paragraphs:[p('제1조(기준)'),p(body),p('<별표 1> 지급표'),
    p('',[table(cells),{kind:'picture',binDataId:id},...(unsupported?[{kind:'unknown',ctrlId:'test'}]:[])])]}],
    binData:new Map([[id,{data:Buffer.from(image),extension:'png'}]]),docInfo:{binData:[]}});
}
const html={markdown:'### 제1조(기준)\nHTML에는 없는 원문 변경'};
const run=(a,b,options={})=>compareEvidence({beforeOriginal:a,afterOriginal:b,beforeHtml:html,afterHtml:html,...options});
let count=0;function check(name,f){f();count++;console.log('PASS '+name);}
check('HWP article change wins over identical HTML',()=>{
 const r=run(original(),original({body:'원문 변경'}));
 assert.equal(r.comparisonScope,'hwp_original_articles');assert.equal(r.comparison.counts.changed,1);
 assert.equal(r.evidenceStatus,'retrieved');
});
check('merge-only changes are part of appendix and table evidence',()=>{
 const r=run(original({cells:[cell('A',0,2)]}),original({cells:[cell('A',0),cell('',1)]}));
 assert.equal(r.originalComparison.tables.counts.changed,1);
 assert.equal(r.appendixComparison.counts.changed,1);
 assert(r.originalComparison.tables.changes[0].cellChanges.some(x=>x.mergeChanged));
});
check('same image bytes with a new storage ID remain equal',()=>{
 assert.equal(run(original(),original({id:12})).originalComparison.images.counts.unchanged,1);
});
check('changed image bytes mark appendix changed',()=>{
 const r=run(original(),original({image:'different'}));
 assert.equal(r.originalComparison.images.counts.changed,1);
 assert.equal(r.appendixComparison.counts.changed,1);
});
check('parser diagnostics reach text clients and force partial',()=>{
 const r=run(original(),original({unsupported:true}));
 const t=formatEvidence(r,{title:'test',maxChanges:20});
 assert.equal(r.evidenceStatus,'partial');assert.match(t,/UNSUPPORTED_CONTROL/);
});
check('legacy unstructured evidence cannot claim HWP comparison',()=>{
 const r=run({markdown:'제1조(기준)'},{markdown:'제1조(기준)'});
 assert.equal(r.comparisonScope,'html_articles_fallback');assert.equal(r.evidenceStatus,'partial');
 assert.equal(r.originalComparison.status,'unavailable');
});
check('HWP remains usable if HTML retrieval fails',()=>{
 const r=compareEvidence({beforeOriginal:original(),afterOriginal:original({body:'수정'})});
 assert.equal(r.comparisonScope,'hwp_original_articles');assert.equal(r.comparison.counts.changed,1);
});
check('missing selected HWP article is not invented by HTML',()=>{
 const r=run(original(),original(),{article:'제99조'});assert.equal(r.error,'NOT_FOUND');
});
check('long article output is marked partial',()=>{
 const r=run(original({body:'가'.repeat(2000)}),original({body:'나'.repeat(2000)}));
 assert.equal(r.evidenceStatus,'partial');assert.equal(r.changesTruncated,true);
});
check('long cell excerpts are marked partial',()=>{
 const r=run(original({cells:[cell('가'.repeat(1500),0),cell('B',1)]}),original({cells:[cell('나'.repeat(1500),0),cell('B',1)]}));
 assert.equal(r.evidenceStatus,'partial');
});
check('requested scope excludes appendix structures explicitly',()=>{
 const r=run(original(),original({image:'different'}),{includeAppendices:false});
 assert.equal(r.appendixComparison.status,'not_requested');
 assert.equal(r.originalComparison.images.counts.changed,0);
});
const scopedOriginal=(value,{appendix=false,supplement=false,nested=false}={})=>buildOriginalEvidence({
 sections:[{paragraphs:[p('제1조(목적)'),p('같은 내용'),p('제2조(금액)'),
 p('',[table([cell(value,0),cell('B',1)])]),
 ...(supplement?[p('부칙 (2026.1.1.)'),p('제1조(시행일)'),p('',[table([cell(value,0),cell('B',1)])])]:[]),
 ...(nested?[p('제3조(별도)'),p('',[{kind:'footnote',paragraphs:[p('',[table([cell(value,0),cell('B',1)])])]}])]:[]),
 ...(appendix?[p('<별표 1> 지급표'),p('',[table([cell(value,0),cell('B',1)])])]:[])]}],
 binData:new Map(),docInfo:{binData:[]}
});
check('selected article excludes structures belonging to other body articles',()=>{
 const r=run(scopedOriginal('100원'),scopedOriginal('200원'),{article:'제1조',includeAppendices:false});
 assert.equal(r.comparison.counts.unchanged,1);
 assert.equal(r.originalComparison.tables.beforeCount,0);
 assert.equal(r.originalComparison.tables.counts.changed,0);
 assert.equal(r.originalComparison.article,'제1조');
 assert.equal(r.originalComparison.bodyScope,'selected_article');
 assert.equal(r.evidenceStatus,'retrieved');
});
check('selected article retains its table changes and independently includes appendices',()=>{
 const a=scopedOriginal('100원',{appendix:true}),b=scopedOriginal('200원',{appendix:true});
 const selected=run(a,b,{article:2,includeAppendices:false});
 assert.equal(selected.originalComparison.tables.counts.changed,1);
 const withAppendix=run(a,b,{article:'제1조'});
 assert.equal(withAppendix.originalComparison.tables.counts.changed,1);
 assert.equal(withAppendix.originalComparison.tables.changes[0].appendix,'별표 1');
 assert.match(formatEvidence(withAppendix,{title:'test'}),/본문 범위: 제1조; 별표·서식: 별도로 전체 비교/);
});
check('supplement articles and nested structures retain their article identity',()=>{
 const a=scopedOriginal('100원',{supplement:true}),b=scopedOriginal('200원',{supplement:true});
 assert.equal(run(a,b,{article:'제1조',includeAppendices:false}).originalComparison.tables.counts.changed,0);
 assert.equal(run(a,b,{article:'부칙 제1조',includeAppendices:false}).originalComparison.tables.counts.changed,1);
 const nested=run(scopedOriginal('100원',{nested:true}),scopedOriginal('200원',{nested:true}),{article:'제3조',includeAppendices:false});
 assert.equal(nested.originalComparison.tables.counts.changed,1);
 assert.equal(nested.originalComparison.objects.counts.changed,1);
});
check('main article table deletion cannot renumber identical supplementary tables',()=>{
 const doc=mainTable=>buildOriginalEvidence({sections:[{paragraphs:[
  p('제1조(목적)'),p('본문'),...(mainTable?[p('',[table([cell('main',0),cell('B',1)])])]:[]),
  p('부칙 (2026.1.1.)'),p('제1조(시행일)'),p('',[table([cell('same',0),cell('B',1)])])
 ]}],binData:new Map(),docInfo:{binData:[]}});
 const r=run(doc(true),doc(false),{article:'부칙 제1조',includeAppendices:false});
 assert.equal(r.comparison.counts.unchanged,1);
 assert.deepEqual(r.originalComparison.tables.counts,{added:0,removed:0,changed:0,unchanged:1});
 assert.equal(r.evidenceStatus,'retrieved');
});
check('distinct supplementary headings keep independent structure ordinals',()=>{
 const doc=firstTable=>buildOriginalEvidence({sections:[{paragraphs:[
  p('제1조(목적)'),p('본문'),
  p('부칙 (2025.1.1.)'),p('제1조(시행일)'),...(firstTable?[p('',[table([cell('old',0),cell('B',1)])])]:[]),
  p('부칙 (2026.1.1.)'),p('제1조(시행일)'),p('',[table([cell('same',0),cell('B',1)])])
 ]}],binData:new Map(),docInfo:{binData:[]}});
 const r=run(doc(true),doc(false),{includeAppendices:false});
 assert.deepEqual(r.originalComparison.tables.counts,{added:0,removed:1,changed:0,unchanged:1});
 assert.equal(r.evidenceStatus,'retrieved');
});
check('legacy structure caches without article identity are explicitly partial',()=>{
 const a=scopedOriginal('100원'),b=scopedOriginal('200원');
 for(const doc of [a,b])for(const item of doc.structure.tables)delete item.article;
 const r=run(a,b,{article:'제1조',includeAppendices:false});
 assert.equal(r.evidenceStatus,'partial');
 assert.equal(r.originalComparison.status,'partial');
 assert.equal(r.originalComparison.coverage.articleScope.unassignedStructures,2);
 assert.match(formatEvidence(r,{title:'test'}),/STRUCTURE_ARTICLE_SCOPE_UNAVAILABLE/);
});
check('missing originals and HTML fail instead of returning empty success',()=>{
 assert.equal(compareEvidence({}).error,'CONTENT_UNAVAILABLE');
});
check('many clipped appendix changes keep exact nonnegative counts',()=>{
 const doc=value=>buildOriginalEvidence({sections:[{paragraphs:[p('제1조(기준)'),...Array.from({length:60},(_,i)=>[p('<별표 '+(i+1)+'> 지급기준'),p('',[table([cell(value,0),cell('B',1)])])]).flat()]}],binData:new Map(),docInfo:{binData:[]}});
 const r=run(doc('old'),doc('new'),{maxChanges:50});
 assert.deepEqual(r.appendixComparison.counts,{added:0,removed:0,changed:60,unchanged:0});
 assert.equal(r.appendixComparison.changesTruncated,true);assert.equal(r.evidenceStatus,'partial');
});
console.log('Original comparison integration: '+count+' passed');

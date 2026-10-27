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

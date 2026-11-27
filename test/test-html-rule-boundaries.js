'use strict';
process.env.DONGGUK_LAWGO_OC='synthetic-fixture-only';
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const current=require('../src/university-rules'),{listArticleBlocks}=require('../src/parsers');
const {inspectArticleStructure,BOUNDARY_NOTICE}=require('../src/html-rule-boundaries');
const {cases,adapterCases,runAdapter,withoutReview}=require('./helpers/html-boundary-cases');
const baseline=require('./fixtures/html-boundary-main-0973a7e.json');
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
(async()=>{
 assert(baseline.commit.startsWith('0973a7e'));assert.equal(cases.length,313);assert.equal(cases.length,baseline.rows.length);
 let passed=0;const groups={};
 for(const c of cases){
  const expected=baseline.rows.find(r=>r.id===c.id),p=current.parseHtmlArticleContent(c.input);
  assert.equal(hash(p.markdown),expected.markdownSha256,c.id+': exact main Markdown');
  assert.equal(hash(listArticleBlocks(p.markdown)),expected.blocksSha256,c.id+': exact main article ownership');
  assert.equal(current.latestAddendaEffective(p.markdown),expected.effectiveAt,c.id+': exact main date');
  assert.equal(p.tailExcluded,false,c.id+': no new text removal');
  if(c.group.endsWith('-reference')&&!c.group.endsWith('annex-reference'))assert(p.boundaryUnverified,c.id+': ambiguous order must be visible');
  if(c.group==='expanded-annex')assert(p.boundaryUnverified,c.id+': appendix boundary must be visible');
  const group=groups[c.group]||={cases:0,identicalToMain:0,worsened:0,marked:0};group.cases++;group.identicalToMain++;group.marked+=Number(p.boundaryUnverified);passed++;
 }
 for(const[id,html]of Object.entries(adapterCases))for(const key of ['sogang','ewha','snu','yonsei']){
  const expected=baseline.adapters.find(r=>r.id===id&&r.key===key),r=await runAdapter(current,key,html);
  // Only the newly added review field is ignored. Text, numbers, dates, status,
  // coverage, failures and ordering all remain part of the exact comparison.
  assert.equal(hash(withoutReview(r.data)),expected.responseSha256,id+'/'+key+': exact main response');
  const warning=`> ${r.data.columns[1].name}: ${BOUNDARY_NOTICE}`;
  const display=r.formatted.split('\n').filter(line=>line!==warning).join('\n');
  assert.equal(hash(display),expected.formattedSha256,id+'/'+key+': main display plus warning only');
  const col=r.data.columns[1];
  if(col.coverage?.articleBoundaryReview){assert(r.formatted.includes(warning));assert(col.articles.every(a=>a.articleBoundaryReview?.required));}
  if(['expanded-마저 준용한다./<br>','expanded-true-annex-demonstrative'].includes(id))assert(col.coverage?.articleBoundaryReview?.required,id+key);
  passed++;
 }
 assert.equal(inspectArticleStructure('### 제1조(목적)\n### 제1조의2(범위)\n### 제1조의3(예외)\n### 제2조(지급)\n## 부칙\n### 제1조(시행일)').required,false);
 assert.equal(inspectArticleStructure('### 제1조(목적)\n### 제1조(중복)').required,true);
 assert.equal(inspectArticleStructure('### 제1조(목적)\n### 제9조(참조)\n### 제3조(정산)').required,true);passed++;
 console.log('HTML main comparison: '+JSON.stringify(groups));
 console.log(`HTML boundary regression: ${passed} passed / 0 failed`);
})().catch(e=>{console.error(e);process.exitCode=1});

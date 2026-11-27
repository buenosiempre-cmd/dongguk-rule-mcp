'use strict';
const assert = require('node:assert/strict');
const {parseHtmlArticleContent,htmlToArticleMarkdown,latestAddendaEffective,loadExternal,selectArticles,SOURCES,expandTopic,formatComparison}=require('../src/university-rules');
const {listArticleBlocks}=require('../src/parsers');
const matrix=require('./fixtures/html-boundary-review.json');
let passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('  PASS '+name);};
const intro='<p>제1조(목적) 이 규정은 업무 절차를 정한다.</p>';
const normal=intro+'<p>제2조(일비) 출장 여비는 100원을 지급한다.</p>';
const addenda='<p>부칙</p><p>제1조(시행일) 이 규정은 2023.5.26.부터 시행한다.</p>';
const cases={normal:normal+addenda,original:'<p>제1조(지급) 국내출장 일비는 제9조(일비) 에서 정한 기준을 적용한다.</p><p>제2조(정산) 증빙을 제출한다.</p>',originalAnnex:normal+'<p>〔별표〕</p><p>제99조(금액) 출장 여비 999원을 지급한다.</p>',particle:'<p>제1조(지급) 국내출장 일비는<br>제9조(일비) 에서만 정한 기준을 적용한다.</p><p>제2조(정산) 증빙을 제출한다.</p>',attachedBody:intro+'<p><strong>제2조(일비)</strong>출장 여비는 100원을 지급한다.</p>'+addenda,plainTitle:intro+'<p>제2조 일비</p><p>출장 여비는 100원을 지급한다.</p>'+addenda,splitAnnexReference:'<p>제1조(지급) 출장 여비 지급기준은</p><p>별표 1</p><p>에 따른다.</p><p>제2조(정산) 출장 여비를 정산한다.</p>'+addenda,inlineAnnexReference:'<p>제1조(지급) 출장 여비 지급기준은 별표 1에 따른다.</p><p>제2조(정산) 출장 여비를 정산한다.</p>'+addenda,annexThenAddendum:normal+'<p>부칙</p><p>이 규정은 2020.1.1.부터 시행한다.</p><p>〔별표〕</p><p>제99조(금액) 출장 여비 999원을 지급한다.</p>'+addenda};
function fake(key,html){const id='12345678-1234-1234-1234-123456789abc',flight=x=>`<script>self.__next_f.push([1,${JSON.stringify(x)}])</script>`;return {request:async(source,path)=>{
 if(key==='sogang')return JSON.stringify({data:{list:[{pkid:1,title:'여비규정',content:html}]}});
 if(key==='ewha')return path.includes('mode=view-rule')?`<div class="fr-view">${html}</div>`:'<a href="?mode=view-rule&srRuleCd1=1&srRuleCd2=2">여비규정</a>';
 if(key==='yonsei')return path==='/regulations'?flight(`{"id":"${id}","name":"여비규정","order":1,"organization":{},"status":"current","revisionHistories":[{"revision_date":"2023-05-25"}]}`):flight(`{"html":"$a"}\na:T${Buffer.byteLength(html).toString(16)},${html}`);
 if(key==='snu')return path.includes('lawSearch')?'<AdmRulSearch><admrul><행정규칙일련번호>1234</행정규칙일련번호><행정규칙명>서울대학교 여비규정</행정규칙명><소관부처명>서울대학교</소관부처명><현행연혁구분>현행</현행연혁구분><발령일자>20230525</발령일자><시행일자>20230526</시행일자></admrul></AdmRulSearch>':'<AdmRulService><발령일자>20230525</발령일자><발령번호>123</발령번호>'+html.replace(/<br>/g,'\n').split(/<\/p>\s*/).filter(Boolean).map(p=>'<조문내용><![CDATA['+p+']]></조문내용>').join('')+'</AdmRulService>';
 throw Error('unexpected fixture');
}};}
(async()=>{
 await check('PR81 reference matrix: 208 combinations preserve the preceding sentence',()=>{
  const inputs=matrix.filter(r=>r.group==='reference');assert.equal(inputs.length,208);
  for(const {input} of inputs){const blocks=listArticleBlocks(htmlToArticleMarkdown(input));assert.deepEqual(blocks.map(b=>b.canonical),['제1조','제2조'],input);assert.match(blocks[0].content,/제9조/);assert.match(blocks[0].content,/정한 기준을 적용한다/);}
 });
 await check('PR81 normal heading matrix: 6 headings keep text under article 2',()=>{
  const inputs=matrix.filter(r=>r.group==='normal');assert.equal(inputs.length,6);
  for(const {input} of inputs){const blocks=listArticleBlocks(htmlToArticleMarkdown(input));assert.deepEqual(blocks.map(b=>b.canonical),['제1조','제2조'],input);assert(!blocks[0].content.includes('출장 여비'));assert(blocks[1].content.includes('출장 여비'));}
 });
 await check('PR81 appendix reference matrix: 12 wrap variants preserve following articles and date',()=>{
  const inputs=matrix.filter(r=>r.group==='annex-reference');assert.equal(inputs.length,12);
  for(const {input} of inputs){const p=parseHtmlArticleContent(input);assert.equal(p.tailExcluded,false,input);assert.deepEqual(listArticleBlocks(p.markdown).map(b=>b.canonical),['제1조','제2조']);assert.equal(latestAddendaEffective(p.markdown),'2023-05-26');}
 });
 await check('particle prefixes inside ordinary words do not swallow the next article',()=>{
  for(const body of ['이의신청은 7일 이내에 접수한다.','이 규정은 출장 여비에 적용한다.','이 경우 지급 기준을 확인한다.','의무교육은 매년 실시한다.']){
   const blocks=listArticleBlocks(htmlToArticleMarkdown(intro+'<p>제2조(신청)'+body+'</p>'));
   assert.deepEqual(blocks.map(b=>b.canonical),['제1조','제2조']);
   assert(!blocks[0].content.includes(body));assert(blocks[1].content.includes(body));
  }
 });
 await check('unknown boundaries are excluded instead of assigned to the preceding article',()=>{
  const p=parseHtmlArticleContent(intro+'<p>제2조(일비) 미완성</p><p>출장 여비 100원</p><p>제3조(정산) 증빙을 제출한다.</p>');
  assert.equal(p.boundaryUnverified,true);const blocks=listArticleBlocks(p.markdown);assert.deepEqual(blocks.map(b=>b.canonical),['제1조','제3조']);assert(blocks.every(b=>!b.content.includes('100원')));
 });
 await check('4 HTML adapters x 9 red-team cases: article ownership, references and date sources',async()=>{
  for(const [id,html]of Object.entries(cases))for(const key of ['sogang','ewha','snu','yonsei']){
   const source={...SOURCES.find(x=>x.key===key),...(key==='snu'?{oc:'synthetic-fixture-only'}:{})};
   const spec=expandTopic('여비'),loaded=await loadExternal(source,'여비',spec.terms,fake(key,html),undefined,spec);assert.equal(loaded.failures.length,0,id+key);assert.equal(loaded.rules.length,1,id+key);
   const chosen=selectArticles(loaded.rules,['출장','여비','일비'],5).articles;
   assert(chosen.every(a=>!['제9조','제99조'].includes(a.article)),id+key);
   if(['normal','attachedBody','plainTitle'].includes(id)){assert(chosen.some(a=>a.article==='제2조'&&a.text.includes('100원')),id+key);assert(!chosen.some(a=>a.article==='제1조'&&a.text.includes('100원')),id+key);}
   if(id==='splitAnnexReference'){assert(chosen.some(a=>a.article==='제2조'));assert.equal(loaded.rules[0].appendicesExcluded,undefined);assert.equal(loaded.rules[0].effectiveAt,'2023-05-26');}
   if(['originalAnnex','annexThenAddendum'].includes(id)){assert.equal(loaded.rules[0].appendicesExcluded,true);assert.equal(loaded.rules[0].effectiveAt,key==='snu'?'2023-05-26':null);}
  }
 });
 await check('ambiguous HTML stays excluded and visibly unverified in all 4 adapters',async()=>{
  const html=normal+'<p>제3조(일비) 미완성</p><p>출장 여비 999원</p>'+addenda;
  for(const key of ['sogang','ewha','snu','yonsei']){
   const source={...SOURCES.find(x=>x.key===key),...(key==='snu'?{oc:'synthetic-fixture-only'}:{})};
   const spec=expandTopic('여비'),loaded=await loadExternal(source,'여비',spec.terms,fake(key,html),undefined,spec);
   assert.equal(loaded.failures.length,0,key);
   const chosen=selectArticles(loaded.rules,['출장','여비','일비'],5).articles;
   assert(chosen.length>0,key);assert(chosen.every(a=>a.articleBoundaryUnverified&&!a.text.includes('999원')),key);
   assert.equal(loaded.rules[0].effectiveAt,key==='snu'?'2023-05-26':null,key);
   const display=formatComparison({topic:'여비',columns:[{university:key,name:key,status:'partial',articles:chosen}],caveat:'합성 검증'});
   assert.match(display,/일부 조문 경계가 불명확/);
  }
 });
 console.log(`HTML boundary regression: ${passed} passed / 0 failed`);
})().catch(e=>{console.error(e);process.exitCode=1;});

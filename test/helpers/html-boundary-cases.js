'use strict';
const original=require('../fixtures/html-boundary-review.json');
const expanded=require('../fixtures/html-boundary-expanded.json');
const intro='<p>제1조(목적) 이 규정은 업무 절차를 정한다.</p>';
const normal=intro+'<p>제2조(일비) 출장 여비는 100원을 지급한다.</p>';
const addenda='<p>부칙</p><p>제1조(시행일) 이 규정은 2023.5.26.부터 시행한다.</p>';
const adapterCases={normal:normal+addenda,original:'<p>제1조(지급) 국내출장 일비는 제9조(일비) 에서 정한 기준을 적용한다.</p><p>제2조(정산) 증빙을 제출한다.</p>',originalAnnex:normal+'<p>〔별표〕</p><p>제99조(금액) 출장 여비 999원을 지급한다.</p>',particle:'<p>제1조(지급) 국내출장 일비는<br>제9조(일비) 에서만 정한 기준을 적용한다.</p><p>제2조(정산) 증빙을 제출한다.</p>',attachedBody:intro+'<p><strong>제2조(일비)</strong>출장 여비는 100원을 지급한다.</p>'+addenda,plainTitle:intro+'<p>제2조 일비</p><p>출장 여비는 100원을 지급한다.</p>'+addenda,splitAnnexReference:'<p>제1조(지급) 출장 여비 지급기준은</p><p>별표 1</p><p>에 따른다.</p><p>제2조(정산) 출장 여비를 정산한다.</p>'+addenda,inlineAnnexReference:'<p>제1조(지급) 출장 여비 지급기준은 별표 1에 따른다.</p><p>제2조(정산) 출장 여비를 정산한다.</p>'+addenda,annexThenAddendum:normal+'<p>부칙</p><p>이 규정은 2020.1.1.부터 시행한다.</p><p>〔별표〕</p><p>제99조(금액) 출장 여비 999원을 지급한다.</p>'+addenda};
function fake(key,html){const id='12345678-1234-1234-1234-123456789abc',flight=x=>`<script>self.__next_f.push([1,${JSON.stringify(x)}])</script>`;return {request:async(source,path)=>{
 if(key==='sogang')return JSON.stringify({data:{list:[{pkid:1,title:'여비규정',content:html}]}});
 if(key==='ewha')return path.includes('mode=view-rule')?`<div class="fr-view">${html}</div>`:'<a href="?mode=view-rule&srRuleCd1=1&srRuleCd2=2">여비규정</a>';
 if(key==='yonsei')return path==='/regulations'?flight(`{"id":"${id}","name":"여비규정","order":1,"organization":{},"status":"current","revisionHistories":[{"revision_date":"2023-05-25"}]}`):flight(`{"html":"$a"}\na:T${Buffer.byteLength(html).toString(16)},${html}`);
 if(key==='snu')return path.includes('lawSearch')?'<AdmRulSearch><admrul><행정규칙일련번호>1234</행정규칙일련번호><행정규칙명>서울대학교 여비규정</행정규칙명><소관부처명>서울대학교</소관부처명><현행연혁구분>현행</현행연혁구분><발령일자>20230525</발령일자><시행일자>20230526</시행일자></admrul></AdmRulSearch>':'<AdmRulService><발령일자>20230525</발령일자><발령번호>123</발령번호>'+html.replace(/<br>/g,'\n').split(/<\/p>\s*/).filter(Boolean).map(p=>'<조문내용><![CDATA['+p+']]></조문내용>').join('')+'</AdmRulService>';
 throw Error('unexpected fixture');
}};}

const cases = original.map((r,i)=>({...r,id:'original-'+i,group:'original-'+r.group}));
for(const r of expanded) cases.push({...r,id:'expanded-'+r.id,group:'expanded-'+r.group});
const documents = {
 regular:['제1조(목적)','제2조(지급)','제3조(정산)'],
 branches:['제1조(목적)','제1조의2(범위)','제1조의3(요건)','제2조(지급)'],
 deleted:['제1조(목적)','제2조(삭제)','제3조(정산)'],
 excerpt:['제6조(지급)','제7조(정산)','제8조(기타)'],
 gap:['제1조(목적)','제3조(정산)','제4조(기타)'],
 plain:['제1조 목적','제2조 지급','제3조 정산'],
};
for(const [kind,headers] of Object.entries(documents))for(const layout of ['inline','strong','br','paragraph']){
 const html=headers.map(h=>layout==='inline'?`<p>${h} 출장 여비는 지급한다.</p>`:layout==='strong'?`<p><strong>${h}</strong>이 학교의 출장 여비는 지급한다.</p>`:layout==='br'?`<p>${h}교직원에게<br>출장 여비를 지급한다.</p>`:`<p>${h}</p><p>다음 각 호의 출장 여비를 지급한다.</p>`).join('')+addenda;
 cases.push({id:`control-${kind}-${layout}`,group:'normal-control',input:html});
}
for(const r of expanded.filter(c=>['이 학교의/ ','교직원에게/<br>','마저 준용한다./<br>','true-annex-demonstrative'].includes(c.id)))adapterCases['expanded-'+r.id]=r.input;
function withoutReview(value) {
 if(Array.isArray(value))return value.map(withoutReview);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='articleBoundaryReview').map(([k,v])=>[k,withoutReview(v)]));
 return value;
}
async function runAdapter(m,key,html){
 const data=await m.compareUniversityRules({topic:'여비',universities:[key],max_articles:5},{client:fake(key,html),now:()=>new Date('2026-11-27T00:00:00.000Z'),loadDongguk:async()=>({rules:[],failures:[],coverage:{complete:false}})});
 return {data,formatted:m.formatComparison(data)};
}
module.exports={cases,adapterCases,runAdapter,withoutReview};

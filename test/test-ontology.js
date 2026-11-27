'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const ontology = require('../src/ontology');
const aliases = require('../src/aliases');
let passed=0;
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`); }
check('기존 71문항·727용어의 사전/대상/범위/가중치 출력 보존', () => {
  const expected=require('./fixtures/ontology-legacy-signature.json');
  const questions=['train','dev'].flatMap(s=>require(`./fixtures/natural-language-benchmark.${s}.json`).map(r=>r.q));
  const words=[...new Set(aliases.CONCEPT_GROUPS.flat(2))];
  const a=aliases;
  const snapshot={groups:a.CONCEPT_GROUPS,vocabulary:[...a.RULE_VOCABULARY],words:words.map(w=>[w,a.businessTerms(w),a.comparisonTerms(w),a.knownTerm(w)]),questions:questions.map(q=>[q,a.questionScope(q),a.questionSubject(q),expected.titles.map(t=>[a.subjectWeight(t,a.questionSubject(q)),a.generalRuleWeight(t,q,true,{code:'3-1-1',forms:words.slice(0,4)})])])};
  assert.equal(questions.length,expected.questions);assert.equal(words.length,expected.words);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),expected.sha256);
});
for(const probe of require('./fixtures/ontology-development.json')) check(`새 개발 문항 ${probe.id}`,()=>{
  const result=ontology.questionFacets(probe.query,probe.keywords);
  for(const key of ['subjects','scopes','concepts']) assert.deepEqual(result[key],probe.expected[key]);
});
const rule=(title,content,code='')=>({lawId:901,title,code,blocks:content?[{article:'제2조',content}]:[]});
check('제목에 없는 범위·대상은 적용범위 조문에서 추출',()=>{
  const r=ontology.ruleFacets(rule('업무 처리 내규','### 제2조(적용범위)\nWISE캠퍼스 직원에게 적용한다.'));
  assert.deepEqual(r.subjects,['직원']);assert.deepEqual(r.scopes.campus,['wise']);assert.equal(r.kind,'내규');assert.equal(r.articleCount,1);
  assert(r.evidence.some(e=>e.source==='application'&&e.blockIndex===0));
});
check('일반 본문·부칙의 대상 언급으로 적용범위를 단정하지 않음',()=>{
  const r=ontology.ruleFacets({title:'업무규정',blocks:[{content:'### 제3조(협조)\n교원과 WISE캠퍼스가 협조한다.'},{supplementary:true,content:'### 제2조(적용범위)\nWISE캠퍼스 직원에게 적용'}]});
  assert.deepEqual(r.subjects,[]);assert.deepEqual(r.scopes.campus,[]);
});
check('제목과 적용대상 충돌·제외/준용 문구는 미확정',()=>{
  const conflict=ontology.ruleFacets(rule('직원 규정','### 제2조(적용대상)\n학생에게 적용한다.'));
  assert.deepEqual(conflict.subjects,[]);assert(conflict.ambiguities.includes('CONFLICT_SUBJECT'));
  const qualified=ontology.ruleFacets(rule('교원 규정','### 제2조(적용대상)\n교원을 제외하고 직원에게 적용한다.'));
  assert.equal(ontology.matchFacets(ontology.questionFacets('교원'),qualified).subject,'unknown');
});
check('제목이 교직원이어도 적용대상이 직원으로 좁으면 교원 일치로 보지 않음',()=>{
  const r=ontology.ruleFacets(rule('교직원 업무규정','### 제2조(적용대상)\n직원에게 적용한다.'));
  assert.deepEqual(r.subjects,['직원']);assert.equal(ontology.matchFacets(ontology.questionFacets('교원'),r).subject,'mismatch');
});
check('편제 코드만으로 서울판·기관 적용을 확정하지 않음',()=>{
  const r=ontology.ruleFacets(rule('업무규정','', '8-1-1'));
  assert(r.evidence.some(e=>e.inferred&&e.value==='industry'));assert.deepEqual(r.scopes.campus,[]);
  assert.equal(ontology.matchFacets(ontology.questionFacets('산단'),r).institution,'unknown');
});
check('대상 포함관계·명시 범위 일치와 불일치·다중 질문 미확정',()=>{
  assert.equal(ontology.matchFacets(ontology.questionFacets('강사'),ontology.ruleFacets(rule('교원규정'))).subject,'match');
  assert.equal(ontology.matchFacets(ontology.questionFacets('직원'),ontology.ruleFacets(rule('교원규정'))).subject,'mismatch');
  assert.equal(ontology.matchFacets(ontology.questionFacets('WISE'),ontology.ruleFacets(rule('서울캠퍼스 규정'))).campus,'mismatch');
  assert.equal(ontology.matchFacets(ontology.questionFacets('교원 학생'),ontology.ruleFacets(rule('학생규정'))).subject,'unknown');
  assert.equal(ontology.matchFacets(ontology.questionFacets('직원'),ontology.ruleFacets(rule('교직원규정'))).subject,'match');
});
check('자료와 폴백 동기화·누락/손상/잘못된 관계/정규식 폴백',()=>{
  assert.deepEqual(ontology.data,require('../src/ontology-defaults'));
  for(const read of [()=>{throw Error('missing');},()=>'{',()=>JSON.stringify({...ontology.data,version:99}),()=>JSON.stringify({...ontology.data,subjects:[{id:'x',ask:'[',title:'x',covers:[]}]})]) {
    const result=ontology.loadOntologyData(read);assert.equal(result.status,'fallback');assert.deepEqual(result.data,ontology.data);
  }
  assert.throws(()=>ontology.validateData({...ontology.data,subjects:[{id:'x',ask:'x',title:'x',covers:['missing']}]}));
});
check('실제 aliases 기동도 손상된 자료에서 기본값으로 복구',()=>{
  const script="const fs=require('fs'),read=fs.readFileSync;fs.readFileSync=function(p,...a){return String(p).endsWith('data/ontology.json')?'broken':read.call(this,p,...a)};const a=require('./src/aliases'),o=require('./src/ontology');console.log(JSON.stringify([o.dataStatus,a.businessTerms('강사료'),a.questionScope('WISE')]));";
  const [status,terms,scope]=JSON.parse(execFileSync(process.execPath,['-e',script],{cwd:require('node:path').join(__dirname,'..'),encoding:'utf8'}));
  assert.equal(status,'fallback');assert(terms.includes('강의료'));assert(scope.wise);
});
check('fusion 계약·잘못된 입력·동일 객체 캐시·불변 결과',()=>{
  assert.equal(ontology.createFacetSignal(),null);
  const corpus={rules:[rule('직원규정')]};const a=ontology.createFacetSignal({corpus,query:'직원'}),b=ontology.createFacetSignal({corpus,query:'교원'});
  assert.strictEqual(a.ruleOf(901),b.ruleOf(901));assert.equal(a.matchOf(901).subject,'match');assert.equal(b.matchOf(901).subject,'mismatch');
  assert.equal(a.ruleOf(999),null);assert.equal(a.matchOf(999).subject,'unknown');
  assert(Object.isFrozen(a.question));assert.throws(()=>a.ruleOf(901).subjects.push('교원'));
  assert.deepEqual(ontology.questionFacets(null,{bad:true}).subjects,[]);
});
console.log(`📊 온톨로지 검증: ${passed}개 통과`);

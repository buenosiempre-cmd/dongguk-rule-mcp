'use strict';
const assert=require('node:assert/strict');
const {validateQuestions,callArguments,scoreResponse,evaluate,statistics,headingPattern,parseArgs,formatMarkdown}=require('../scripts/benchmark-natural-language');
const questions=require('./fixtures/natural-language-benchmark.train.json');
const response=rules=>({structuredContent:{ok:true,data:{rules}}});
const rule=(lawId,text)=>({lawId,title:'fixture',excerpt:{text}});
const q={id:'test',q:'질문',gt:[{lawId:7,articles:['제3조','제10조의2','별표 1']},{lawId:8,articles:['제5조']}]};
let passed=0;function check(name,fn){fn();passed++;console.log('  ✅ '+name);}
async function main(){
 check('개발용 25문항 고정 파일 검증',()=>{const dev=validateQuestions(require('./fixtures/natural-language-benchmark.dev.json'));assert.equal(dev.length,25);assert(dev.every(row=>!questions.some(known=>known.id===row.id||known.q===row.q)));});
 check('46문항·기존 배열 입력 모두 검증, 중복 ID/잘못된 정답 거절',()=>{assert.equal(validateQuestions(questions).length,46);validateQuestions(require('./fixtures/natural-language-questions.json'));assert.throws(()=>validateQuestions([q,q]));assert.throws(()=>validateQuestions([{...q,gt:[{lawId:0,articles:['제3조']}]}]));});
 check('같은 규정 본문만 적중; 다른 규정·목차·topArticle 메타데이터는 불인정',()=>{let r=scoreResponse(q,response([rule(9,'### 제3조(목적) 내용'),{...rule(7,'### 제4조(내용) 본문'),topArticle:'제3조',toc:'제3조(목적)'}]));assert.equal(r.bodyIncluded,false);assert.equal(r.top3,true);assert.equal(r.top1,false);});
 check('대체 정답 중 하나, 가지조문·띄어쓰기·전각 괄호',()=>{for(const text of ['### 제 10 조 의 2（기준） 본문','### 제3조(목적) 본문'])assert(scoreResponse(q,response([rule('7',text)])).bodyIncluded);assert(scoreResponse(q,response([rule(8,'### 제5조(적용) 본문')])).bodyIncluded);assert(!headingPattern('제3조').test('### 제3조의2(가지) 본문'));});
 check('별표 번호 경계·부속 표제; 문장 속 인용은 표제로 세지 않음',()=>{for(const text of ['[별표 1]','별표 1 기준','〔별표 1〕'])assert(headingPattern('별표 1').test(text));for(const text of ['[별표 10]','별표 1에 따른다.','이 내용은 제3조(목적)에 따른다.'])assert(!headingPattern(text.includes('제3조')?'제3조':'별표 1').test(text));});
 check('본문 포함은 반환 전체, top3는 상위 3개만; 후보 목록은 제외',()=>{const r=response([rule(1,''),rule(2,''),rule(3,''),rule(7,'### 제3조(목적) 본문')]);r.structuredContent.data.search={otherCandidates:[{lawId:8}]};const s=scoreResponse(q,r);assert(s.bodyIncluded);assert(!s.top3);assert(!s.top1);});
 check('오류 응답의 텍스트 불인정·본문 없는 규정 선택 수',()=>{const r={structuredContent:{ok:false,error:{code:'AMBIGUOUS_RULE'},data:{rules:[]}}};const s=scoreResponse(q,r);assert(s.choiceOnly);assert(!s.bodyIncluded);assert(!s.top1);});
 check('중간값·nearest-rank p95·오류 분모 명시',()=>{const rows=[10,20,30,40].map((elapsedMs,i)=>({...scoreResponse(q,response([rule(i===0?7:9,'### 제3조(목적) 본문')])),elapsedMs}));const s=statistics(rows);assert.equal(s.medianMs,25);assert.equal(s.p95Ms,40);assert.deepEqual(s.bodyIncluded,{hits:1,total:4,rate:0.25});});
 check('시행일 표제·짧은 정답 규정은 적중률과 별도 집계',()=>{
   const row={...scoreResponse(q,response([rule(7,'### 제3조(목적) 본문\n\n### 제1조(시행일) 시행한다.'),rule(9,'본문 속 제1조(시행일) 언급')])),elapsedMs:1};
   const quality=statistics([row]).excerptQuality;
   assert.equal(quality.enforcementHeadingRules,1);assert.equal(quality.enforcementHeadingQuestions,1);assert.equal(quality.shortExpectedRules,1);assert.equal(quality.meanRules,2);
 });
 check('기존 배열은 기존 제목/키워드 기준 유지',()=>{const r=scoreResponse(['여비',['여비규정'],'숙박'],response([{title:'여비규정',excerpt:{text:'숙박비'}}]));assert(r.bodyIncluded);assert(r.top1);assert.equal(scoreResponse(['미채점',null,null],response([])).bodyIncluded,null);});
 check('문항별 args는 query 옆에 합치고, --query-only면 query만 보냄',()=>{
   const row={...q,args:{keywords:'분실, 변상'}};
   assert.deepEqual(callArguments(row),{query:'질문',keywords:'분실, 변상'});
   assert.deepEqual(callArguments(row,{useArgs:false}),{query:'질문'});
   assert.deepEqual(callArguments(q),{query:'질문'});
   assert.deepEqual(callArguments(row,{argsById:{test:{keywords:'망실',campus:'wise'}}}),{query:'질문',keywords:'망실',campus:'wise'});
   assert.deepEqual(callArguments(['배열 질문',null,null],{argsById:{x:{keywords:'a'}}}),{query:'배열 질문'});
   validateQuestions([row]);
   for(const args of ['분실',null,['분실']])assert.throws(()=>validateQuestions([{...q,args}]),/INVALID_QUESTION/);
 });
 const sent=[];
 const both=await evaluate([{...q,args:{keywords:'분실, 변상'}},{...q,id:'plain'}],async(query,args)=>{sent.push(args);return response([rule(7,'### 제3조(목적) 본문')]);},()=>{},()=>0);
 const alone=await evaluate([{...q,args:{keywords:'분실, 변상'}}],async(query,args)=>{sent.push(args);return response([rule(7,'### 제3조(목적) 본문')]);},()=>{},()=>0,{useArgs:false});
 check('같은 문항을 인수 포함·질문만으로 나눠 측정하고 보낸 인수를 결과에 기록',()=>{
   assert.deepEqual(sent,[{query:'질문',keywords:'분실, 변상'},{query:'질문'},{query:'질문'}]);
   assert.deepEqual(both.results[0].args,{keywords:'분실, 변상'});assert.equal(both.results[1].args,undefined);
   assert.equal(both.summary.withArgs,1);assert.equal(alone.summary.withArgs,0);assert.equal(alone.results[0].args,undefined);
   assert.match(formatMarkdown({...both,argsMode:'query+문항에 든 args'}),/호출 인수: query\+문항에 든 args \(query 외 인수를 보낸 문항 1\/2\)/);
 });
 check('CLI: --args 파일과 --query-only, 둘을 함께 쓰면 거절',()=>{
   assert.equal(parseArgs(['--output','x.json','--args','a.json']).args,'a.json');
   assert.equal(parseArgs(['--output','x.json','--query-only']).queryOnly,true);
   assert.throws(()=>parseArgs(['--output','x.json','--query-only','--args','a.json']));
   assert.throws(()=>parseArgs(['--output','x.json','--args']));
 });
 check('CLI 출력 경로 필수·잘못된 옵션/시간 제한 거절',()=>{assert.throws(()=>parseArgs([]));assert.throws(()=>parseArgs(['--output','x','--timeout','0']));assert.equal(parseArgs(['--output','x.json']).output,'x.json');});
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-bench-'));
 try {
   const output=path.join(dir,'existing.json');fs.writeFileSync(output,'preserve');
   await assert.rejects(require('../scripts/benchmark-natural-language').main(['--output',output]),/OUTPUT_EXISTS/);
   check('기존 출력 파일은 네트워크 실행 전에 거절하고 보존',()=>assert.equal(fs.readFileSync(output,'utf8'),'preserve'));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
 let ticks=0;const r=await evaluate([q,{...q,id:'second'}],async query=>{if(ticks>1)throw new Error('PRIVATE');return response([rule(7,'### 제3조(목적) 본문')]);},()=>{},()=>ticks++*10);
 check('순차 호출·전송 실패 후 보고 유지',()=>{assert.equal(r.results.length,2);assert.equal(r.summary.errors.CALL_FAILED,1);assert.equal(r.summary.bodyIncluded.hits,1);});
 console.log(`📊 자연어 벤치 검증: ${passed}개 통과`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

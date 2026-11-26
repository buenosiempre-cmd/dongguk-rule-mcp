'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runWatch, fingerprint, compareSnapshot, saveSnapshot, readSnapshot, formatWatch, UNIVERSITIES } = require('../src/university-watch');
const { createPublicClient, loadExternal, SOURCES } = require('../src/university-rules');
const { main, parse } = require('../scripts/university-watch');
const { postToSlack } = require('../src/slack-webhook');
const source = key => SOURCES.find(s => s.key === key);
const rule = { title: '여비 규정', lawId: 1, revisedAt: '2026.11.01', effectiveAt: '2026-11-02', markdown: '### 제1조(일비) 출장 일비를 지급한다.\n### 제2조(정산) 정산한다.' };
const loaded = { rules: [rule], failures: [], coverage: { complete: false } };
const row = () => ({ key: 'cau', checkedAt: '2026-11-26T00:00:00+09:00', success: true, rules: [fingerprint(rule)], failureCodes: [] });
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ✅ '+name); };
async function test() {
  await check('지문: 본문은 저장하지 않고 조문 앞부분만 SHA-256, 제목만 있는 조문 거절', () => {
    const f=fingerprint(rule); assert.match(f.hash,/^[a-f0-9]{64}$/);assert.equal(f.revisedAt,'2026-11-01');assert.equal(f.effectiveAt,'2026-11-02');assert(!JSON.stringify(f).includes('출장 일비를 지급'));
    assert.equal(fingerprint({...rule,markdown:'### 제1조(일비)'}),null);
    assert.equal(fingerprint({...rule,revisedAt:null,markdown:rule.markdown+' 1961.03.01 참고 날짜'}).revisedAt,null);
    const long={...rule,markdown:rule.markdown+'x'.repeat(9000)};assert.equal(fingerprint(long).hash,fingerprint({...long,markdown:long.markdown+'tail'}).hash);
  });
  await check('직전 성공과 변경·예정·연속 실패·회복 비교, 대표 교체는 개정과 구분', () => {
    const first=compareSnapshot(row());assert(first.changes.includes('BASELINE_CREATED'));
    const next=row();next.rules[0].hash='a'.repeat(64);next.rules[0].revisedAt='2026-11-25';next.rules[0].upcomingRevisionAt='2027-01-01';
    compareSnapshot(next,first);assert.deepEqual(next.changes,['REVISION_DATE_CHANGED','BODY_HASH_CHANGED','UPCOMING_REVISION']);
    const fail=compareSnapshot({...row(),success:false,rules:[],failureCodes:['UPSTREAM_FORMAT_CHANGED']},first);
    const fail2=compareSnapshot({...fail},fail);assert.equal(fail2.consecutiveFailures,2);assert(fail2.changes.includes('CONSECUTIVE_FAILURE'));
    const recovered=compareSnapshot(next,fail2);assert(recovered.changes.includes('RECOVERED'));assert(recovered.changes.includes('BODY_HASH_CHANGED'));
    const other=row();other.rules[0].lawId='2';compareSnapshot(other,first);assert.deepEqual(other.changes,['REPRESENTATIVE_CHANGED']);
  });
  await check('19개 대학 직접 로더, 대표 1개·단일 검색어, 동국대·게시 호출 없음', async () => {
    const calls=[];const report=await runWatch({}, {loader:async (s,t,terms,c,signal,spec)=>{calls.push(s.key);assert.deepEqual(terms,['여비']);assert.deepEqual(spec.searchTerms,['여비','출장']);assert.deepEqual(spec.titleHints,['여비','출장','출장비']);assert.deepEqual(spec.titleQueries,['여비','출장','출장비']);assert.equal(spec.titleOnly,true);assert.equal(spec.maxRules,1);return loaded;},clientFactory:()=>({})});
    assert.equal(report.universities.length,19);assert.equal(calls.length,19);assert(!calls.includes('dongguk'));assert(report.universities.every(r=>r.success&&r.status==='partial'));assert.match(report.checkedAt,/\+09:00$/);
    for (const format of ['markdown','slack','json']) assert(formatWatch(report,format).includes('중앙대학교'));
  });
  await check('대학/전체 제한에 걸린 미완료 결과는 실패, 나머지 대학 요청 시작 금지', async () => {
    const calls=[];const report=await runWatch({totalTimeoutMs:25,universityTimeoutMs:15,concurrency:1},{sources:UNIVERSITIES.slice(0,4),clientFactory:()=>({}),loader:async s=>{calls.push(s.key);return new Promise(()=>{});}});
    assert(calls.length<=2);assert.equal(report.universities.length,4);assert(report.universities.every(r=>!r.success&&r.failureCodes.includes('TOTAL_TIMEOUT')));
    await assert.rejects(runWatch({totalTimeoutMs:60001}),/INVALID_WATCH_LIMITS/);
  });
  await check('전담 주제 제목이 아닌 대표 규정은 조회 성공과 별개로 주의 표시', async () => {
    const report=await runWatch({}, {sources:[source('uos')],clientFactory:()=>({}),loader:async()=>({...loaded,rules:[{...rule,title:'정보공개심의회 규정'}]})});
    assert(report.universities[0].success);assert(report.universities[0].changes.includes('TOPIC_TITLE_NOT_MATCHED'));
  });
  await check('출장·출장비가 제목에 있으면 여비 주제로 인정한다', async () => {
    for (const title of ['출장비 지급 규정','출장비규정','서울시립대학교 전임교원 국외출장 지침']) {
      const report=await runWatch({}, {sources:[source('sogang')],clientFactory:()=>({}),loader:async()=>({...loaded,rules:[{...rule,title}]})});
      assert(report.universities[0].success);assert(!report.universities[0].changes.includes('TOPIC_TITLE_NOT_MATCHED'), title);
    }
  });
  await check('조회 없음·형식 오류·현행본 미확인·OC 미설정은 코드로 구분', async () => {
    const cases=[{rules:[],failures:[],coverage:{}},{rules:[],failures:[{code:'UPSTREAM_FORMAT_CHANGED'}],coverage:{}},{...loaded,coverage:{currentRevisionUnverified:1}}];
    const report=await runWatch({}, {sources:UNIVERSITIES.slice(0,3),clientFactory:()=>({}),loader:async()=>cases.shift()});
    assert.deepEqual(report.universities.map(r=>r.failureCodes[0]),['NO_MATCH_IN_SCOPE','UPSTREAM_FORMAT_CHANGED','PDF_REVISION_UNVERIFIED']);assert(report.universities.every(r=>!r.success));
    const missing=await runWatch({}, {sources:[source('snu')],clientFactory:()=>({}),loader:async()=>{throw {code:'LAWGO_OC_NOT_CONFIGURED'};}});assert.equal(missing.universities[0].failureCodes[0],'LAWGO_OC_NOT_CONFIGURED');
    const hidden=await runWatch({}, {sources:[source('korea')],clientFactory:()=>({}),loader:async()=>({rules:[],failures:[],coverage:{mode:'public_folder_list',publicOnly:true,titleMatches:0}})});
    assert.equal(hidden.universities[0].failureCodes[0],'NOT_PUBLIC');assert.equal(hidden.universities[0].status,'not_public');assert(!hidden.universities[0].success);
  });
  await check('대표 제한은 실제 로더의 본문 요청을 1개로 제한; 일반 비교 기본값 유지', async () => {
    let bodies=0;const s=source('cau');const client={request:async(s,p)=>{
      if(p.includes('CampusRuleList'))return JSON.stringify({data:[1,2].map(n=>({RULES_NO:String(n),RULES:'여비 규정 '+n,MAX_DT:'2026-11-01'}))});
      if(p.includes('RulesDetailView'))return `<a onclick="fileDown('/CAU/911/${new URL('https://x'+p).searchParams.get('RULES_NO')}/20261101/','x.pdf')">file</a>`;
      bodies++;return Buffer.from('%PDF-');
    }};
    const opts={extractPdf:async()=>({text:'제1조(여비) 출장 여비를 지급한다.'})};
    await loadExternal(s,'여비',['여비'],client,undefined,{maxRules:1},opts);assert.equal(bodies,1);
    bodies=0;await loadExternal(s,'여비',['여비'],client,undefined,{},opts);assert.equal(bodies,2);
  });
  await check('공통 텍스트 캐시는 기본 10분 유지', async () => {
    let at=0,n=0;const c=createPublicClient({now:()=>at,minIntervalMs:0,disabled:()=>false,fetchImpl:async()=>({ok:true,status:200,text:async()=>{n++;return 'fixture';}})});
    const s=source('ewha');await c.request(s,'/ewha/intro/rules.do');at=599999;await c.request(s,'/ewha/intro/rules.do');assert.equal(n,1);at=600000;await c.request(s,'/ewha/intro/rules.do');assert.equal(n,2);
  });
  await check('스냅샷 저장·이전 파일 읽기, 잘못된 파일은 조용히 초기화하지 않음', async () => {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'watch-test-'));try{
      const file=path.join(dir,'snapshot.json');assert.equal(await readSnapshot(file),undefined);
      await saveSnapshot(file,{schemaVersion:1,universities:[compareSnapshot(row())]});assert.equal((await readSnapshot(file)).universities.length,1);
      await fs.writeFile(file,'broken');await assert.rejects(readSnapshot(file),/INVALID_SNAPSHOT/);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
  await check('CLI 기본 dry-run·로그 전용은 무네트워크, post는 명시할 때만', async () => {
    let watches=0,posts=0;const deps={env:{},watch:async()=>{watches++;return {checkedAt:'test',universities:[]};},post:async()=>{posts++;},output:()=>{}};
    await main([],deps);assert.equal(watches,1);assert.equal(posts,0);await main(['--usage-only'],deps);assert.equal(watches,1);
    await main(['--usage-only','--post'],deps);assert.equal(posts,1);assert.throws(()=>parse(['--format','bad']));assert.throws(()=>parse(['--snapshot']));
  });
  await check('기존 Slack 웹훅 방식만 허용, 전송 예외에 주소 포함하지 않음', async () => {
    let n=0;const fetchImpl=async()=>{n++;return {ok:true};};
    for(const url of ['http://hooks.slack.com/services/test','https://example.com/test','https://hooks.slack.com.evil/test','https://user:pass@hooks.slack.com/test']) await assert.rejects(postToSlack('text',{env:{DONGGUK_SLACK_WEBHOOK_URL:url},fetchImpl}));
    assert.equal(n,0);await postToSlack('text',{env:{DONGGUK_SLACK_WEBHOOK_URL:'https://hooks.slack.com/services/test'},fetchImpl});assert.equal(n,1);
    await assert.rejects(postToSlack('text',{env:{DONGGUK_SLACK_WEBHOOK_URL:'https://hooks.slack.com/services/test'},fetchImpl:async()=>{throw new Error('SECRET_URL');}}),e=>!e.message.includes('SECRET_URL'));
  });
  console.log(`📊 대학 감시 검증: ${passed}개 통과`);
}
test().catch(e=>{console.error(e);process.exitCode=1;});

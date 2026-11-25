'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createHttpServer } = require('../src/http-server');
const { createUsageLog, aggregateUsage, kst } = require('../src/usage-log');
const data={columns:[{university:'dongguk',status:'partial'}, {university:'cau',status:'unavailable',code:'UPSTREAM_FORMAT_CHANGED',failures:[{code:'UPSTREAM_FORMAT_CHANGED',message:'PRIVATE_BODY'}],articles:[{text:'PRIVATE_BODY'}]}, {university:'skku',status:'partial',failures:[{code:'PDF_REVISION_UNVERIFIED'}]}, {university:'uos',status:'retrieved',articles:[]}]};
const result={content:[{type:'text',text:'PRIVATE_BODY'}],structuredContent:{ok:true,data}};
function factory(){const s=new Server({name:'usage-test',version:'1'},{capabilities:{tools:{}}});s.setRequestHandler(CallToolRequestSchema,async()=>result);return s;}
async function call(server){return fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'compare_university_rules',arguments:{query:'PRIVATE_ARGUMENT',token:'PRIVATE_TOKEN',webhook:'PRIVATE_WEBHOOK'}}})});}
const wait = () => new Promise(r=>setImmediate(r));
let passed=0;
async function check(name,fn){await fn();passed++;console.log('  ✅ '+name);}
async function test(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usage-test-'));
  try{
    await check('무설정 비활성·KST 월 경계',()=>{assert.equal(createUsageLog({}),null);assert.equal(kst(Date.parse('2026-11-30T16:00:00Z')).slice(0,7),'2026-12');});
    await check('실제 HTTP 응답 유지, 비교 대학별 실패만 JSONL에 저장',async()=>{
      const server=createHttpServer({createServer:factory,host:'127.0.0.1',usageLogDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
      try {const res=await call(server);assert.equal(res.status,200);const body=await res.json();assert.deepEqual(body.result,result);await wait();await server.flushUsageLog();}
      finally{await server.shutdown();}
      const files=await fs.readdir(dir);assert.equal(files.length,1);const text=await fs.readFile(path.join(dir,files[0]),'utf8');
      assert.doesNotMatch(text,/PRIVATE_|query|cookie|headers|Authorization|webhook|articles|127\.0\.0\.1/i);
      const entry=JSON.parse(text);assert.equal(entry.tool,'compare_university_rules');assert.equal(entry.universities.length,3);assert.deepEqual(entry.universities[0].codes,['UPSTREAM_FORMAT_CHANGED']);
      assert.equal((await fs.stat(path.join(dir,files[0]))).mode & 0o777,0o600);
      const agg=await aggregateUsage({dir});assert.equal(agg.calls,1);assert.equal(agg.universities.find(c=>c.university==='cau').failedCalls,1);assert.equal(agg.universities.find(c=>c.university==='uos').failedCalls,0);
    });
    await check('디렉터리 쓰기 실패가 HTTP 응답을 바꾸지 않음',async()=>{
      const file=path.join(dir,'not-a-directory');await fs.writeFile(file,'fixture');
      const server=createHttpServer({createServer:factory,host:'127.0.0.1',usageLogDir:file});await new Promise(r=>server.listen(0,'127.0.0.1',r));
      try{const res=await call(server);assert.equal(res.status,200);assert.deepEqual((await res.json()).result,result);await wait();await server.flushUsageLog();}finally{await server.shutdown();}
    });
    await check('SSE·finish/close 중복 방지·임의 코드 비밀값 제외',async()=>{
      const sub=path.join(dir,'sse'),log=createUsageLog({dir:sub});const res=new EventEmitter();res.statusCode=200;res.write=()=>true;res.end=()=>{};
      log.track({},res,'unused',Date.now(),{method:'tools/call',params:{name:'compare_university_rules'}});
      res.write('event: message\ndata: '+JSON.stringify({result:{structuredContent:{ok:true,data:{columns:[{university:'cau',status:'unavailable',code:'PRIVATE_CODE'}]}}}})+'\n\n');res.end();res.emit('finish');res.emit('close');await log.flush();
      const lines=(await fs.readFile(path.join(sub,(await fs.readdir(sub))[0]),'utf8')).trim().split('\n');assert.equal(lines.length,1);assert(!lines[0].includes('PRIVATE_CODE'));assert.deepEqual(JSON.parse(lines[0]).universities[0].codes,['UPSTREAM_UNAVAILABLE']);
    });
    await check('기간별 집계, 손상 줄·구버전 미관측·미설정 및 없는 로그',async()=>{
      assert.equal((await aggregateUsage({})).status,'no_logs');assert.equal((await aggregateUsage({dir:path.join(dir,'missing')})).status,'no_logs');
      const sub=path.join(dir,'period');await fs.mkdir(sub);
      const old={ts:'2026-10-01T00:00:00+09:00',tool:'compare_university_rules',universities:[]};const current={ts:'2026-11-25T00:00:00+09:00',tool:'compare_university_rules',universities:[{university:'cau',status:'unavailable',codes:['PDF_REVISION_UNVERIFIED','PDF_REVISION_UNVERIFIED']}]};
      await fs.writeFile(path.join(sub,'usage-2026-11.jsonl'),[old,current,{...current,universities:undefined}].map(JSON.stringify).join('\n')+'\nmalformed\n');
      const agg=await aggregateUsage({dir:sub,since:'2026-11-01',until:Date.parse('2026-11-26')});assert.equal(agg.calls,2);assert.equal(agg.unobservedCalls,1);assert.equal(agg.malformedLines,1);assert.equal(agg.universities[0].codes.PDF_REVISION_UNVERIFIED,1);
    });
    await check('큰 응답은 캡처 생략을 표시하고 본문을 보관하지 않음',async()=>{
      const sub=path.join(dir,'oversize'),log=createUsageLog({dir:sub});const res=new EventEmitter();res.statusCode=200;res.write=()=>true;res.end=()=>{};
      log.track({},res,'unused',Date.now(),{method:'tools/call',params:{name:'compare_university_rules'}});res.end('x'.repeat(8*1024*1024+1));res.emit('finish');await log.flush();
      const e=JSON.parse(await fs.readFile(path.join(sub,(await fs.readdir(sub))[0]),'utf8'));assert.equal(e.capture,'oversize');assert.equal(e.status,'unobserved');assert.deepEqual(e.universities,[]);
    });
    console.log(`📊 사용 로그 검증: ${passed}개 통과`);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
}
test().catch(e=>{console.error(e);process.exitCode=1;});

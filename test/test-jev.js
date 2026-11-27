'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { FEATURE_NAMES, evidenceFeatures, reciprocalRankFusion, aggregateRules, createRetriever, rerank } = require('../src/jev');
const { assertFullVectorCoverage } = require('../scripts/collect-jev-evidence');

async function main() {
  // Golden values generated with upstream features.py at 13ae4cc.
  const golden = [[0,-1.4142135381698608,1,-.30000001192092896,-1.4142135381698608,1,0,.5,.5,0,0,.3333333432674408,1,1,.9959757328033447,.375],
    [1,.7071067690849304,.5,0,.7071067690849304,.5,-.20000000298023224,0,0,-.10000000149011612,-.10000000149011612,.6666666865348816,1,0,1,.375],
    [1,.7071067690849304,.7924812436103821,0,.7071067690849304,.7924812436103821,-.10000000149011612,1,1,-.30000001192092896,-.30000001192092896,1,1,1,.9978256225585938,.375]];
  const actual = evidenceFeatures([[0,1],[1,0],[1,2]], [[.2,.3,.4],[.5,.1,.3],[.5,.2,.1]], [1,.5], [1,1,.5], 1);
  actual.forEach((row, i) => row.forEach((x, j) => assert(Math.abs(x - golden[i][j]) < 1e-6)));
  assert.deepEqual(evidenceFeatures([], [], [1], [1]), []);
  for (const B of [[[0]], [[0],[0]], [[1],[1]]]) {
    const f = evidenceFeatures(B, B, [1], [1], null, 1);
    assert(f.flat().every(Number.isFinite)); assert(f.every(r => r[6] === 0 && r[13] === 1));
  }
  const rrf = reciprocalRankFusion([[1,2],[2,3]]);
  assert.equal(rrf.get(2), 1/62 + 1/61);
  const docs = [{ id:0,lawId:1 },{ id:1,lawId:2 }];
  const base = aggregateRules(docs, [.8,.7]);
  const duplicated = aggregateRules([...docs,...Array(100).fill(docs[1])], [.8,.7,...Array(100).fill(.7)]);
  assert.deepEqual(base.map(x=>[x.lawId,x.score]), duplicated.map(x=>[x.lawId,x.score]));
  const model = n => ({ mean:Array(n).fill(0),scale:Array(n).fill(1),weights:Array(n).fill(1),intercept:0 });
  const artifact = {version:1,fingerprint:'test',featureNames:FEATURE_NAMES,article:model(16),rule:model(1)};
  const candidates = [{id:0,lawId:1,features:Array(16).fill(0)}];
  assert.equal(rerank(candidates,artifact,'test')[0].score,.5);
  for (const broken of [null, {...artifact,version:2}, {...artifact,featureNames:[]}, {...artifact,article:{...model(16),weights:[NaN]}}, {...artifact,rule:{...model(1),weights:[-1]}}, {...artifact,article:{...model(16),scale:Array(16).fill(0)}}]) assert.equal(rerank(candidates,broken,'test'),null);
  assert.equal(rerank(candidates,artifact,'stale'),null);
  assert.equal(rerank([{...candidates[0],features:[Infinity]}],artifact,'test'),null);
  assert.equal(rerank([null],artifact,'test'),null);
  const overflow = {...artifact,article:{...model(16),scale:Array(16).fill(1e-320),weights:[1,-1,...Array(14).fill(1)]}};
  assert.equal(rerank([{...candidates[0],features:Array(16).fill(1)}],overflow,'test'),null);
  assert.deepEqual(rerank([],artifact,'test'),[]);
  assert.throws(()=>createRetriever(null,null),/INDEX_MISSING/);
  const blocks = [{article:'제1조',content:'제1조(출장) 출장 여비 숙박비를 지급한다.'}, {article:'제2조',content:'제2조(휴학) 학생 휴학 신청'}];
  const corpus = {rules:[{lawId:1,title:'여비규정',blocks:[blocks[0]]},{lawId:2,title:'학칙',blocks:[blocks[1]]}]};
  const hash = (title,content) => crypto.createHash('sha1').update(`${title}\n${content}`).digest('hex').slice(0,16);
  const index = {meta:{dims:2,rows:2,rules:corpus.rules.map(r=>({lawId:r.lawId,blocks:[[0,hash(r.title,r.blocks[0].content),1]]}))},vectors:new Float32Array([1,0,0,1])};
  const retriever = createRetriever(corpus,index);
  assert.equal(retriever.coverage.vectorArticles,2);
  assert.doesNotThrow(()=>assertFullVectorCoverage(retriever));
  const repaired = structuredClone(corpus);
  repaired.rules[0].blocks[0].content += ' 복구된 본문';
  const partiallyAligned = createRetriever(repaired,index);
  assert.equal(partiallyAligned.coverage.vectorArticles,1);
  assert.throws(()=>assertFullVectorCoverage(partiallyAligned),/JEV_VECTOR_COVERAGE_INCOMPLETE: 1\/2/);
  assert.throws(()=>assertFullVectorCoverage({coverage:{articles:0,vectorArticles:0}}),/INCOMPLETE/);
  const evidence = await retriever.gather('출장비를 지급받으려면', async()=>new Float32Array([1,0]));
  assert(evidence.keys.length<=4); assert.equal(evidence.keys[0],'출장비를 지급받으려면');
  assert(evidence.candidates.every(c=>c.features.length===16 && c.features.every(Number.isFinite)));
  assert.equal([...evidence.candidates].sort((a,b)=>b.rrf-a.rrf)[0].lawId,1);
  await assert.rejects(retriever.gather('출장',async()=>new Float32Array([1])),/VECTOR_INVALID/);
  console.log('✅ JEV: upstream 16-feature parity, degeneracy, RRF, length-neutral max, invalid model fallback, Korean local retrieval');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

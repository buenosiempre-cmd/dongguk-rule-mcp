'use strict';
// Inference only: this file has no fitting or parameter-selection path.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { rerank, aggregateRules } = require('../src/jev');
const { DEV_OPEN_SHAS } = require('./collect-jev-evidence');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const FROZEN_REPORTS = {
  single: 'db88764d6a16dcc3510bd2b0393b32bc592436d5ee97385f39a85d8414b39f7b',
  full: 'c01c5c0b922b5e6ed172ed14e8156eddfb1482fbd0f78aa1525ccf3a8cba96e5',
};
function validateInputs(evidence, trained, trainedBytes) {
  if (sha(trainedBytes) !== FROZEN_REPORTS[evidence.keyEncoding]) throw new Error('NOT_FROZEN_D1_MODEL');
  if (evidence.sources.length !== 1 || !DEV_OPEN_SHAS.includes(evidence.sources[0].sha256) || evidence.records.length !== 20 || new Set(evidence.records.map(r => r.id)).size !== 20) throw new Error('NOT_APPROVED_DEV_OPEN');
  for (const key of ['fingerprint', 'corpusHash', 'vectorHash', 'keyEncoding', 'textVersion']) {
    if (evidence[key] !== trained.metadata[key]) throw new Error(`MODEL_EVIDENCE_MISMATCH:${key}`);
  }
  for (const file of ['src/jev.js','src/corpus.js','src/lookup.js','src/aliases.js','src/semantic.js']) {
    if (evidence.codeHashes[file] !== trained.metadata.codeHashes[file]) throw new Error(`SOURCE_CHANGED:${file}`);
  }
  const trainQuestions = ['train', 'dev'].flatMap(split => {
    const bytes = fs.readFileSync(`${__dirname}/../test/fixtures/natural-language-benchmark.${split}.json`);
    if (sha(bytes) !== trained.metadata.sources.find(s => s.split === split)?.sha256) throw new Error('TRAINING_FIXTURE_CHANGED');
    return JSON.parse(bytes);
  });
  const laws = new Set(trainQuestions.flatMap(r => r.gt.map(g => g.lawId)));
  const overlap = [...new Set(evidence.records.flatMap(r => r.gt.map(g => g.lawId)))].filter(id => laws.has(id));
  if (overlap.length) throw new Error('TRAINING_RULE_OVERLAP');
  return { trainingQuestions: trainQuestions.length, trainingRules: laws.size, newRules: new Set(evidence.records.flatMap(r => r.gt.map(g => g.lawId))).size, overlap };
}
function score(record, rules) {
  const truth = new Set(record.gt.map(g => g.lawId));
  const all = rules.flatMap(r => r.articles).sort((a,b) => b.score-a.score || a.id-b.id);
  return { top1: !!rules.length && truth.has(rules[0].lawId), top3: rules.slice(0,3).some(r=>truth.has(r.lawId)),
    selectedArticleHit: rules.slice(0,3).some(r=>r.articles.some(a=>a.label)), articleTop3: all.slice(0,3).some(a=>a.label),
    topRules: rules.slice(0,3), ruleProbabilities: rules.map(r=>({lawId:r.lawId,probability:r.probability??null})) };
}
function compare(rows, before, after) {
  return Object.fromEntries(['top1','top3','selectedArticleHit'].map(metric => [metric, {
    newWrong: rows.filter(r=>r[before][metric] && !r[after][metric]).map(r=>r.id),
    fixed: rows.filter(r=>!r[before][metric] && r[after][metric]).map(r=>r.id),
  }]));
}
function summarize(rows, method) {
  const top3 = rows.filter(r=>r[method].top3).length;
  const selected = rows.filter(r=>r[method].selectedArticleHit).length;
  return { total:rows.length, top1:rows.filter(r=>r[method].top1).length, top3, selectedArticleHit:selected,
    conditionalArticle:{hits:selected,total:top3}, fullMcpStrict:null };
}
function quantiles(a) {
  const s=[...a].sort((x,y)=>x-y), p=q=>{const i=(s.length-1)*q,l=Math.floor(i);return s[l]+(s[Math.ceil(i)]-s[l])*(i-l);};
  return {p50:p(.5),p95:p(.95)};
}
function evaluate(evidence, trained) {
  return evidence.records.map(r=>{
    const start=performance.now(), rules=rerank(r.candidates,trained.model,evidence.fingerprint), predictionMs=performance.now()-start;
    if (!rules) throw new Error('FROZEN_MODEL_REJECTED');
    const baseline=key=>{const c=r.candidates.filter(c=>c[key]>0);return score(r,aggregateRules(c,c.map(c=>c[key])));};
    return {id:r.id,q:r.q,gt:r.gt,tags:r.tags,pair:r.pair,queryEncodings:r.queryEncodings,
      rrf:baseline('rrf'),expandedRrf:baseline('expandedRrf'),jev:score(r,rules),
      off:{...r.production.off,top1:r.gt.some(g=>g.lawId===r.production.off.rules[0]?.lawId)},
      on:{...r.production.on,top1:r.gt.some(g=>g.lawId===r.production.on.rules[0]?.lawId)},
      rrfGatherMs:r.rrfMs,jevGatherMs:r.jevMs,predictionMs,candidateHit:r.candidates.some(c=>c.label)};
  });
}
function main(argv=process.argv.slice(2)) {
  const args={};for(let i=0;i<argv.length;i+=2){if(!['--evidence','--trained-report','--output'].includes(argv[i])||!argv[i+1])throw new Error('INVALID_OPTIONS');args[argv[i].slice(2)]=argv[i+1];}
  if(!args.evidence||!args['trained-report']||!args.output)throw new Error('REQUIRED_OPTIONS');
  if(fs.existsSync(args.output))throw new Error('OUTPUT_EXISTS');
  const raw=fs.readFileSync(args.evidence), trainedBytes=fs.readFileSync(args['trained-report']);
  const evidence=JSON.parse(raw), trained=JSON.parse(trainedBytes), split=validateInputs(evidence,trained,trainedBytes), records=evaluate(evidence,trained);
  const methods=['off','on','rrf','expandedRrf','jev'];
  const summary=Object.fromEntries(methods.map(m=>[m,summarize(records,m)]));
  const tags=Object.fromEntries(['S','C','D'].map(t=>[t,Object.fromEntries(methods.map(m=>[m,summarize(records.filter(r=>r.tags.includes(t)),m)]))]));
  const comparisons=Object.fromEntries(['off','on','rrf','expandedRrf'].map(m=>[m,compare(records,m,'jev')]));
  const {records:_,...metadata}=evidence;
  const report={scope:'Development comparison only; weakness-targeted public 20. Frozen 71-question model; no fitting/tuning on these 20. Not box-held-out effectiveness evidence; not full MCP.',metadata,split,
    evidenceSha256:sha(raw),trainedReportSha256:sha(trainedBytes),evaluatorSha256:sha(fs.readFileSync(__filename)),gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    summary,tags,comparisons,latencyMs:Object.fromEntries(['rrfGatherMs','jevGatherMs','predictionMs'].map(k=>[k,quantiles(records.map(r=>r[k]))])),
    latencyScope:'Warm sequential single pass. RRF/JEV gathering includes query inference. Prediction separate. Production scoring excludes query inference; full MCP latency unmeasured.',records};
  fs.writeFileSync(args.output,JSON.stringify(report)+'\n',{flag:'wx'});console.log(JSON.stringify({summary,tags,comparisons,latencyMs:report.latencyMs,split},null,2));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={validateInputs,score,compare,summarize,evaluate};

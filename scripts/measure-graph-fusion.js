'use strict';
// Offline experiment wrapper. Production response formats and index.js remain unchanged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function main(argv=process.argv.slice(2)){
  const measure=require('./measure-natural-language'),options=measure.parseArgs(argv);
  if(!options.out||fs.existsSync(options.out))throw new Error('NEW_OUTPUT_REQUIRED');
  const publicDir=path.join(path.resolve(options.cache),'dongguk-rule-mcp/v2/public');
  const corpusFile=path.join(publicDir,'corpus/corpus-v1.json');
  const corpusHash=sha(fs.readFileSync(corpusFile));
  if(corpusHash!=='59c2e11fe66e57af1ad2e88d732b12e42233ec1446e9a9d43784754e464dcb15')throw new Error('COMMON_CORPUS_REQUIRED');
  const meta=JSON.parse(fs.readFileSync(path.join(publicDir,'semantic/semantic-v1.json')));
  if(meta.vectorHash!=='c76feb89f199072fecf644f59f1c880519595276b8ec3af54f7a539388da2f7e'||meta.textVersion!==3)throw new Error('COMMON_VECTOR_REQUIRED');
  if(sha(fs.readFileSync(path.join(publicDir,'semantic',meta.vectorFile)))!==meta.vectorHash)throw new Error('VECTOR_HASH_MISMATCH');
  const sources=options.questions.map(file=>({file,sha256:sha(fs.readFileSync(file)),count:JSON.parse(fs.readFileSync(file)).length}));
  if(process.env.DONGGUK_MCP_SEMANTIC_RUNTIME&&process.env.DONGGUK_MCP_SEMANTIC_MODEL_DIR){
    const runtimePath=createRequire(path.join(process.env.DONGGUK_MCP_SEMANTIC_RUNTIME,'package.json')).resolve('@huggingface/transformers');
    const runtime=await import(pathToFileURL(runtimePath).href);runtime.env.localModelPath=process.env.DONGGUK_MCP_SEMANTIC_MODEL_DIR;
  }
  const fusion=require('../src/fusion'),original=fusion.rankRules,trace=[];
  fusion.rankRules=args=>{const start=performance.now(),result=original(args);if(result.graphAudit)trace.push({query:args.query,...result.graphAudit,elapsedMs:performance.now()-start,ranked:result.ranked.map(r=>({lawId:r.lawId,order:r.order,graphScore:r.graphScore}))});return result;};
  const report=await measure.main(argv);
  for(const source of sources)if(sha(fs.readFileSync(source.file))!==source.sha256)throw new Error('QUESTIONS_CHANGED');
  if(sha(fs.readFileSync(corpusFile))!==corpusHash)throw new Error('CORPUS_CHANGED');
  Object.assign(report,{provenance:{gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),corpusHash,vectorFile:meta.vectorFile,vectorHash:meta.vectorHash,textVersion:meta.textVersion,sources,queryOnly:options.queryOnly,keywordSha256:options.keywords?sha(fs.readFileSync(options.keywords)):null},graphTrace:trace,
    graphDirections:{downwardApplied:trace.reduce((n,r)=>n+r.downward.length,0),upwardBlocked:trace.reduce((n,r)=>n+r.upwardBlocked.length,0),referenceBlocked:trace.reduce((n,r)=>n+r.referenceBlocked.length,0),missingCandidates:trace.reduce((n,r)=>n+r.missingCandidates.length,0)}});
  fs.writeFileSync(options.out,JSON.stringify(report)+'\n');
}
if(require.main===module)main().then(()=>process.exit(0),e=>{console.error(e.stack);process.exit(1);});
module.exports={main};

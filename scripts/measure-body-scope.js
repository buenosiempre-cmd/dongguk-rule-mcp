'use strict';
// Requires the coordinator's fixed corpus/vector hashes; never chooses a cache generation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function parseExpected(argv){
  const args=[],expected={};
  for(let i=0;i<argv.length;i++){
    if(['--expected-corpus-sha','--expected-vector-sha'].includes(argv[i])){const key=argv[i];if(!/^[a-f0-9]{64}$/.test(argv[i+1]||''))throw new Error('FULL_HASH_REQUIRED');expected[key]=argv[++i];}
    else args.push(argv[i]);
  }
  if(!expected['--expected-corpus-sha']||!expected['--expected-vector-sha'])throw new Error('ANNOUNCED_COMMON_HASHES_REQUIRED');
  return {args,expected};
}
async function main(argv=process.argv.slice(2)){
  const {args,expected}=parseExpected(argv),measure=require('./measure-natural-language'),options=measure.parseArgs(args);
  if(!['hybrid','hybrid-scope'].includes(options.ranking)||!options.out||fs.existsSync(options.out))throw new Error('NEW_OUTPUT_AND_COMPARISON_METHOD_REQUIRED');
  const publicDir=path.join(path.resolve(options.cache),'dongguk-rule-mcp/v2/public'),corpusFile=path.join(publicDir,'corpus/corpus-v1.json');
  const bytes=fs.readFileSync(corpusFile),corpus=JSON.parse(bytes),corpusHash=sha(bytes);
  if(corpusHash!==expected['--expected-corpus-sha'])throw new Error('COMMON_CORPUS_MISMATCH');
  const meta=JSON.parse(fs.readFileSync(path.join(publicDir,'semantic/semantic-v1.json')));
  if(meta.vectorHash!==expected['--expected-vector-sha']||sha(fs.readFileSync(path.join(publicDir,'semantic',meta.vectorFile)))!==meta.vectorHash)throw new Error('COMMON_VECTOR_MISMATCH');
  const sources=options.questions.map(file=>({file,sha256:sha(fs.readFileSync(file)),count:JSON.parse(fs.readFileSync(file)).length}));
  if(process.env.DONGGUK_MCP_SEMANTIC_RUNTIME&&process.env.DONGGUK_MCP_SEMANTIC_MODEL_DIR){
    const runtimePath=createRequire(path.join(process.env.DONGGUK_MCP_SEMANTIC_RUNTIME,'package.json')).resolve('@huggingface/transformers');
    const runtime=await import(pathToFileURL(runtimePath).href);runtime.env.localModelPath=process.env.DONGGUK_MCP_SEMANTIC_MODEL_DIR;
  }
  const report=await measure.main(args);
  if(sha(fs.readFileSync(corpusFile))!==corpusHash)throw new Error('CORPUS_CHANGED');
  for(const source of sources)if(sha(fs.readFileSync(source.file))!==source.sha256)throw new Error('QUESTIONS_CHANGED');
  const {inferRuleScope}=require('../src/scope');
  Object.assign(report,{provenance:{gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),corpusHash,vectorHash:meta.vectorHash,vectorFile:meta.vectorFile,textVersion:meta.textVersion,sources,queryOnly:options.queryOnly,
    sourceHashes:Object.fromEntries(['src/scope.js','src/fusion.js','src/ontology.js','src/data/ontology.json','src/index.js','src/corpus.js'].map(f=>[f,sha(fs.readFileSync(path.join(__dirname,'..',f)))]))},scopeDecisions:corpus.rules.map(inferRuleScope)});
  fs.writeFileSync(options.out,JSON.stringify(report)+'\n');
}
if(require.main===module)main().then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1);});
module.exports={parseExpected,main};

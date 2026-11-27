'use strict';
// Reads corpus only. No evaluation questions, network, or model fitting.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {inferRuleScope}=require('../src/scope');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function main(args=process.argv.slice(2)){
  if(args.length!==2)throw new Error('USAGE corpus.json new-output.json');
  const [input,output]=args;if(fs.existsSync(output))throw new Error('OUTPUT_EXISTS');
  const bytes=fs.readFileSync(input),corpus=JSON.parse(bytes);
  if(!Array.isArray(corpus.rules))throw new Error('INVALID_CORPUS');
  const rows=corpus.rules.map(inferRuleScope);
  const summary={rules:rows.length,bodyAugmented:rows.filter(r=>r.campus.source==='body'||r.institution.source==='body').length,
    campus:Object.fromEntries(['title','body','unknown'].map(s=>[s,rows.filter(r=>r.campus.source===s).length])),
    institution:Object.fromEntries(['title','body','unknown'].map(s=>[s,rows.filter(r=>r.institution.source===s).length])),
    conflicts:rows.filter(r=>r.campus.status==='conflict'||r.institution.status==='conflict').map(r=>r.lawId),
    ambiguous:rows.filter(r=>r.campus.status==='ambiguous'||r.institution.status==='ambiguous').map(r=>r.lawId)};
  const report={scope:'Development audit only; not retrieval accuracy or legal applicability. All corpus rules, including unknown/conflict cases.',createdAt:new Date().toISOString(),gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    corpus:{input:path.resolve(input),sha256:sha(bytes),builtAt:corpus.builtAt,version:corpus.version,contentVersion:corpus.contentVersion,catalogTotal:corpus.catalogTotal},
    codeSha256:sha(fs.readFileSync(path.join(__dirname,'../src/scope.js'))),summary,rows};
  if(sha(fs.readFileSync(input))!==report.corpus.sha256)throw new Error('CORPUS_CHANGED');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(summary));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={main};

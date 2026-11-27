'use strict';
// Opt-in integration adapter. Never infer hierarchy from a query or benchmark label.
const path = require('node:path');
const os = require('node:os');
const { loadCorpus } = require('./corpus');
const { buildRuleGraph, loadRuleGraph, rankRelatedRules } = require('./rule-graph');
const cache = new WeakMap();
function prepare(corpus, directory) {
  if (!corpus) return null;
  if (cache.has(corpus)) return cache.get(corpus);
  const graph = (directory && loadRuleGraph(directory, corpus)) || buildRuleGraph(corpus);
  const rules = new Map(corpus.rules.map(r=>[r.lawId,r]));
  const children = new Map(), parents = new Map(), references = new Map();
  const add=(map,a,b)=>{if(!map.has(a))map.set(a,new Set());map.get(a).add(b);};
  const hierarchy=[];
  for(const edge of graph.edges){
    const from=Number(edge.from.split(':')[1]),to=Number(edge.to.split(':')[1]);
    if(from===to)continue;
    if(edge.type==='implements'){
      const child=rules.get(from),parent=rules.get(to);
      // A parent must be larger in main-article count, and the child an explicit detailed rule.
      const count=r=>r.blocks.filter(b=>!b.supplementary).length;
      if(child&&parent&&/(?:시행세칙|내규)$/.test(child.title.trim())&&count(parent)>count(child)){
        add(children,to,from);add(parents,from,to);hierarchy.push(edge);
      }
    } else if(['cites','applies'].includes(edge.type)){add(references,from,to);add(references,to,from);}
  }
  const value={graph:{...graph,edges:hierarchy},children,parents,references,rules};
  cache.set(corpus,value);return value;
}
function graphSignal(ranked, { corpus, directory, enabled=true }={}) {
  const audit={direction:'downward-only',seeds:[],downward:[],upwardBlocked:[],referenceBlocked:[],missingCandidates:[],status:'unused'};
  const scores=new Map();
  if(!enabled)return {scores,audit};
  try{
    if(corpus===undefined){
      directory=path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache'),'dongguk-rule-mcp/v2/public');
      corpus=loadCorpus(directory);
    }
    const index=prepare(corpus,directory);
    if(!index){audit.status='missing-corpus';return {scores,audit};}
    const byId=new Map(ranked.map(r=>[r.lawId,r]));
    const seeds=ranked.slice(0,3);audit.seeds=seeds.map(r=>r.lawId);audit.status='ready';
    for(const [i,seed] of seeds.entries()){
      for(const target of index.parents.get(seed.lawId)||[])audit.upwardBlocked.push({from:seed.lawId,to:target,score:0});
      for(const target of index.references.get(seed.lawId)||[])audit.referenceBlocked.push({from:seed.lawId,to:target,score:0});
      // Filter graph before calling its API so ordinary citations cannot consume the result limit.
      const related=rankRelatedRules(index.graph,[{lawId:seed.lawId,score:1/(i+1)}],{limit:50});
      for(const item of related){
        if(!index.children.get(seed.lawId)?.has(item.lawId))continue;
        const target=byId.get(item.lawId);
        if(!target){audit.missingCandidates.push({from:seed.lawId,to:item.lawId});continue;}
        // Never counteract an explicit campus/institution mismatch selected by hybrid.
        if(target.scopeMatch===false)continue;
        if(target.historyId&&target.historyId!==item.historyId)continue;
        scores.set(item.lawId,Math.min(1,(scores.get(item.lawId)||0)+item.score));
        audit.downward.push({from:seed.lawId,to:item.lawId,score:item.score,evidence:item.evidence});
      }
    }
  }catch(error){audit.status='failed';audit.error=error.name;scores.clear();}
  return {scores,audit};
}
module.exports={graphSignal};

'use strict';
// Pure classification after a single packaged-data read. No ranking or network.
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('./ontology-defaults');
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const strings = value => Array.isArray(value) && value.every(x => typeof x === 'string' && x.length > 0 && x.length <= 200);
function validateData(d) {
  if (!d || d.version !== 1) throw new Error('ONTOLOGY_SCHEMA');
  for (const key of ['concepts','facetConcepts','subjects','scopes']) {
    if (!Array.isArray(d[key]) || !d[key].length || d[key].length > 1000) throw new Error('ONTOLOGY_SCHEMA');
    const ids = new Set();
    for (const item of d[key]) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('ONTOLOGY_SCHEMA');
      ids.add(item.id);
    }
  }
  if (!d.concepts.every(x => strings(x.everyday) && x.everyday.length && strings(x.rule) && x.rule.length) || !d.facetConcepts.every(x => strings(x.terms) && x.terms.length) || !strings(d.ruleKinds) || !d.ruleKinds.length) throw new Error('ONTOLOGY_SCHEMA');
  const subjectIds = new Set(d.subjects.map(x => x.id));
  for (const x of d.subjects) if (!strings(x.covers) || x.covers.some(id => !subjectIds.has(id))) throw new Error('ONTOLOGY_SCHEMA');
  const pattern = (text, flags = '') => {
    if (typeof text !== 'string' || !text || text.length > 1000 || !/^(?:i)?$/.test(flags)) throw new Error('ONTOLOGY_SCHEMA');
    return new RegExp(text, flags);
  };
  for (const x of [...d.subjects,...d.scopes]) { pattern(x.ask,x.flags); pattern(x.title,x.flags); }
  for (const x of d.scopes) if ((x.legacy !== undefined && typeof x.legacy !== 'boolean') || !['campus','institution'].includes(x.axis)) throw new Error('ONTOLOGY_SCHEMA');
  if (!d.scopeClasses || !strings(d.scopeClasses.unitParts)) throw new Error('ONTOLOGY_SCHEMA');
  pattern(d.scopeClasses.unitTitle); pattern(d.scopeClasses.selfGoverningTitle); pattern(d.mixedSubjectPattern);
  return d;
}
function loadOntologyData(read = () => fs.readFileSync(path.join(__dirname,'data/ontology.json'),'utf8')) {
  try { return { data:freeze(validateData(JSON.parse(read()))), status:'packaged' }; }
  catch { return { data:freeze(validateData(defaults)), status:'fallback' }; }
}
const loaded = loadOntologyData();
const data = loaded.data;
const compiledSubjects = data.subjects.map(x => ({...x,ask:new RegExp(x.ask),title:new RegExp(x.title)}));
const compiledScopes = data.scopes.map(x => ({...x,ask:new RegExp(x.ask,x.flags),title:new RegExp(x.title,x.flags)}));
const compact = text => typeof text === 'string' ? text.replace(/\s+/g,'') : '';
const unique = values => [...new Set(values)];
function subjectsIn(text, field) {
  // Mixed subjects are explicit unions in the new interface. Legacy callers
  // retain their previous mixed-subject handling in aliases.js.
  const mixed = /교직원/.test(text) ? ['교원','직원'] : [];
  const plain = text.replace(new RegExp(data.mixedSubjectPattern,'g'),' ');
  return unique([...mixed,...compiledSubjects.filter(x => x[field].test(plain)).map(x => x.id)]);
}
function scopesIn(text, field) {
  const scopes = {campus:[],institution:[]};
  for (const entry of compiledScopes) if (entry[field].test(compact(text))) scopes[entry.axis].push(entry.id);
  return scopes;
}
function conceptIds(text) {
  const plain = text.replace(/하자\s*보수|유지\s*보수|보수\s*공사|개보수/g,'');
  return data.facetConcepts.filter(x => x.terms.some(term => plain.includes(term))).map(x => x.id);
}
function emptyFacets() { return {subjects:[],scopes:{campus:[],institution:[]},concepts:[],evidence:[],ambiguities:[]}; }
function evidenceFor(facets, source, blockIndex) {
  return [
    ...facets.subjects.map(value => ({dimension:'subject',value,source,...(blockIndex === undefined ? {} : {blockIndex})})),
    ...Object.entries(facets.scopes).flatMap(([dimension,values]) => values.map(value => ({dimension,value,source,...(blockIndex === undefined ? {} : {blockIndex})}))),
  ];
}
function questionFacets(query, keywords = '') {
  const text = typeof query === 'string' ? query : '';
  const words = Array.isArray(keywords) ? keywords.filter(x=>typeof x==='string').join(' ') : typeof keywords === 'string' ? keywords : '';
  const result = emptyFacets();
  result.subjects = subjectsIn(text,'ask');
  result.scopes = scopesIn(text,'ask');
  result.evidence = evidenceFor(result,'query');
  // Subjects may fall back to keywords, as in questionSubject; institution and
  // campus names in keywords never create scope constraints.
  if (!result.subjects.length) {
    result.subjects = subjectsIn(words,'ask');
    result.evidence.push(...result.subjects.map(value=>({dimension:'subject',value,source:'keywords'})));
  }
  result.concepts = conceptIds(text+' '+words);
  if (result.subjects.length > 1) result.ambiguities.push('MULTIPLE_SUBJECTS');
  if (result.scopes.campus.length > 1) result.ambiguities.push('MULTIPLE_CAMPUSES');
  return freeze(result);
}
function ruleFacets(rule) {
  const result = emptyFacets();
  if (!rule || typeof rule !== 'object') return freeze({...result,kind:null,articleCount:0});
  const title = typeof rule.title === 'string' ? rule.title : '';
  result.subjects = subjectsIn(title,'title'); result.scopes = scopesIn(title,'title');
  result.evidence = evidenceFor(result,'title');
  const blocks = Array.isArray(rule.blocks) ? rule.blocks : [];
  const claims = [];
  blocks.forEach((block,blockIndex) => {
    if (!block || block.supplementary || typeof block.content !== 'string') return;
    const heading = /^\s*(?:#{1,6}\s*)?제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[(（]([^\n)）]+)[)）]/.exec(block.content);
    if (!heading || !/^(?:적용범위|적용대상|적용)$/.test(compact(heading[1]))) return;
    const claim = {subjects:subjectsIn(block.content,'title'),scopes:scopesIn(block.content,'title')};
    if (/제외|아니|않|준용|참조/.test(block.content)) { result.ambiguities.push('QUALIFIED_APPLICATION'); return; }
    claims.push(claim); result.evidence.push(...evidenceFor(claim,'application',blockIndex));
  });
  const resolve = (titleValues, applicationValues, dimension) => {
    const app = unique(applicationValues);
    if (titleValues.length && app.length && !titleValues.some(x=>app.includes(x))) {
      result.ambiguities.push('CONFLICT_'+dimension.toUpperCase()); return [];
    }
    if (titleValues.length && app.length) return titleValues.filter(value => app.includes(value));
    return titleValues.length ? titleValues : app;
  };
  result.subjects = resolve(result.subjects,claims.flatMap(x=>x.subjects),'subject');
  for (const axis of ['campus','institution']) result.scopes[axis] = resolve(result.scopes[axis],claims.flatMap(x=>x.scopes[axis]),axis);
  if (result.ambiguities.includes('QUALIFIED_APPLICATION')) {
    result.subjects = []; result.scopes = {campus:[],institution:[]};
  }
  // Part 8 is evidence of an institutional collection, never proof of campus.
  if (!result.scopes.institution.length && /^8-/.test(String(rule.code || '')) && !result.ambiguities.includes('CONFLICT_INSTITUTION')) {
    result.evidence.push({dimension:'institution',value:'industry',source:'code',inferred:true});
  }
  result.kind = data.ruleKinds.find(kind => compact(title).endsWith(kind)) || null;
  result.articleCount = blocks.filter(b=>b && !b.supplementary && typeof b.content==='string').length;
  result.concepts = conceptIds(title+' '+blocks.filter(b=>b && !b.supplementary).map(b=>b.content || '').join(' '));
  result.ambiguities = unique(result.ambiguities);
  return freeze(result);
}
function matchFacets(question, rule) {
  const compare = (asked, found, subject = false) => {
    if (!Array.isArray(asked) || asked.length !== 1 || !Array.isArray(found) || !found.length) return 'unknown';
    return found.some(value => value === asked[0] || (subject && data.subjects.find(x=>x.id===value)?.covers.includes(asked[0]))) ? 'match' : 'mismatch';
  };
  return freeze({subject:compare(question?.subjects,rule?.subjects,true),campus:compare(question?.scopes?.campus,rule?.scopes?.campus),institution:compare(question?.scopes?.institution,rule?.scopes?.institution)});
}
const cache = new WeakMap();
function createFacetSignal({corpus, query, keywords} = {}) {
  if (!corpus || !Array.isArray(corpus.rules)) return null;
  let rules = cache.get(corpus);
  if (!rules) {
    rules = new Map();
    for (const rule of corpus.rules) if (rule && Number.isSafeInteger(rule.lawId) && rule.lawId > 0) rules.set(rule.lawId,ruleFacets(rule));
    cache.set(corpus,rules);
  }
  const question = questionFacets(query,keywords);
  const ruleOf = lawId => rules.get(Number(lawId)) || null;
  return Object.freeze({question,ruleOf,matchOf:lawId=>matchFacets(question,ruleOf(lawId)),status:loaded.status});
}
module.exports = { data, dataStatus:loaded.status, validateData, loadOntologyData, questionFacets, ruleFacets, matchFacets, createFacetSignal };

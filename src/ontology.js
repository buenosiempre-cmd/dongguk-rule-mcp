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
  for (const x of d.scopes) {
    if (x.edition !== undefined && typeof x.edition !== 'boolean') throw new Error('ONTOLOGY_SCHEMA');
    if (x.place !== undefined) { if (!x.place || typeof x.place !== 'object') throw new Error('ONTOLOGY_SCHEMA'); pattern(x.place.ask,x.flags); pattern(x.place.title,x.flags); }
  }
  if (d.bodySubject !== undefined) {
    const b = d.bodySubject;
    if (!b || ![b.share,b.perArticle,b.mentions].every(n => Number.isFinite(n) && n > 0) || !b.terms || typeof b.terms !== 'object') throw new Error('ONTOLOGY_SCHEMA');
    pattern(b.mixed);
    for (const [id,text] of Object.entries(b.terms)) { if (!subjectIds.has(id)) throw new Error('ONTOLOGY_SCHEMA'); pattern(text); }
  }
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
  if (!rule || typeof rule !== 'object') return freeze({...result,bodySubject:null,kind:null,articleCount:0});
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
  // Read only when neither the title nor an article on application names a class.
  result.bodySubject = result.subjects.length || result.ambiguities.length ? null : bodySubject(rule);
  if (result.bodySubject) result.evidence.push({dimension:'subject',value:result.bodySubject,source:'body',inferred:true});
  result.ambiguities = unique(result.ambiguities);
  return freeze(result);
}
// ── 본문이 말하는 대상 ──
// Most rules do not name their audience in the title or in an article on application:
// 취업규칙 is for 직원, 학사과정 학칙시행세칙 for 학생. The articles say so by whom they keep
// naming. A rule has a body subject when one class takes `share` of all class mentions in its
// main articles and appears about once an article or more. An inference, never a finding on
// whom the rule binds.
const bodyTerms = data.bodySubject ? Object.entries(data.bodySubject.terms).map(([id,text]) => [id,new RegExp(text,'g')]) : [];
function bodySubject(rule) {
  const settings = data.bodySubject;
  const blocks = Array.isArray(rule?.blocks) ? rule.blocks.filter(b => b && !b.supplementary && typeof b.content === 'string') : [];
  if (!settings || !blocks.length) return null;
  const text = blocks.map(b => b.content).join('\n').replace(new RegExp(settings.mixed,'g'),' ');
  const counts = bodyTerms.map(([id,term]) => [id,(text.match(term) || []).length]).sort((a,b) => b[1]-a[1]);
  const total = counts.reduce((sum,[,count]) => sum+count,0);
  const [id,count] = counts[0];
  const numbered = blocks.filter(b => b.article).length || 1;
  return total >= settings.mentions && count/total >= settings.share && count/numbered >= settings.perArticle ? id : null;
}
// ── 장소(캠퍼스·기관)와 판 ──
// The place a question asks for, as the ranking reads it. Unlike the scopes above, an
// institution counts only when it has its own editions of university rules (산학협력단,
// 의학계열), and it is named by the body itself (의대, 의학과, 병원), not by a field of study:
// 불교의학연구소 is a research institute, not the medical school. `campus` is the caller's
// campus argument ('all' when none was given).
const places = compiledScopes.filter(x => x.axis === 'campus' || x.edition).map(x => ({
  id:x.id, axis:x.axis, ask:x.place ? new RegExp(x.place.ask,x.flags) : x.ask, title:x.place ? new RegExp(x.place.title,x.flags) : x.title,
}));
function placeRequest(query, campus = 'all') {
  const text = compact(query);
  const campuses = new Set(campus === 'wise' || campus === 'seoul' ? [campus] : []), institutions = [];
  for (const place of places) if (place.ask.test(text)) place.axis === 'campus' ? campuses.add(place.id) : institutions.push(place.id);
  return freeze({campuses:[...campuses],institutions,specified:campuses.size > 0 || institutions.length > 0,ambiguous:campuses.size > 1 || institutions.length > 1});
}
const titlePlaces = new Map();
function placeOf(title) {
  const text = compact(title);
  if (!titlePlaces.has(text)) titlePlaces.set(text,freeze({campus:places.filter(x => x.axis === 'campus' && x.title.test(text)).map(x => x.id),institution:places.filter(x => x.axis === 'institution' && x.title.test(text)).map(x => x.id)}));
  return titlePlaces.get(text);
}
// How well a rule's place fits the asked one: positive when the rule is written for a place
// the question names, negative when it is written for a place the question leaves out, and 0
// for a university-wide rule (취업규칙 still answers a WISE question when no WISE edition
// exists) or when the question names no place.
function placeAgreement(title, request) {
  if (!request?.specified) return 0;
  const rule = placeOf(title);
  let agreement = 0;
  for (const campus of rule.campus) {
    if (request.campuses.includes(campus)) agreement += 1;
    else if (request.campuses.length) agreement -= 1;
  }
  for (const place of places) {
    if (place.axis !== 'institution') continue;
    const asked = request.institutions.includes(place.id), named = rule.institution.includes(place.id);
    if (asked && named) agreement += 1;
    else if (!asked && named) agreement -= 1;
  }
  return agreement;
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
  // covers(wider, narrower): a rule for the wider class also answers for the narrower (교원 → 강사).
  const covers = (wider, narrower) => !!data.subjects.find(x => x.id === wider)?.covers.includes(narrower);
  return Object.freeze({question,ruleOf,matchOf:lawId=>matchFacets(question,ruleOf(lawId)),covers,status:loaded.status});
}
module.exports = { data, dataStatus:loaded.status, validateData, loadOntologyData, questionFacets, ruleFacets, matchFacets, createFacetSignal, bodySubject, placeRequest, placeOf, placeAgreement };

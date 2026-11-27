'use strict';
// Rule-based scope evidence, not a legal applicability determination.
const path = require('node:path');
const os = require('node:os');
const { placeOf, placeAgreement } = require('./ontology');
const { loadCorpus } = require('./corpus');
const memo = new WeakMap();
const heading = text => /^\s*(?:#{1,6}\s*)?제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[（(]([^）)]+)[）)]/.exec(text);
const directCampus = /(?:동국대학교|본교|본\s*대학교)\s*(?:\([^)]{0,80}\)\s*)?(?:서울|WISE|경주|와이즈)\s*캠퍼스|(?:동국대학교|본교)\s*\(\s*(?:서울|WISE|경주|와이즈)\s*캠퍼스\s*\)/i;
const explicitApplication = /(?:에|에게|을|를)\s*(?:적용한다|적용함|적용하는|적용된다|적용됨|적용대상으로|대상으로)/;
const ownInstitution = /(?:동국대학교|본교)\s*(?:\([^)]{0,80}\)\s*)?(?:(?:서울|WISE|경주|와이즈)\s*캠퍼스\s*)?(?:산학협력단|의학계열|의과대학|한의과대학|의학전문대학원|의료원)(?=\s*(?:\([^)]{0,80}\)\s*)?의)/i;
const institutionalTarget = /(?:산학협력단|의학계열|의과대학|한의과대학|의학전문대학원|의료원)\s*(?:(?:의|소속)\s*(?:임직원|직원|교직원|구성원)|(?:에게|에)\s*$)/;
const institutionalDomain = /(?:산학협력단|의학계열|의과대학|한의과대학|의학전문대학원|의료원)\s*(?:\([^)]{0,80}\)\s*)?의\s*(?:조직|운영|설치|인사|복무)/;
const negative = /(?:적용|준용)\s*(?:하지|되지|아니)|(?:제외|예외|다만|적용하지|적용되지)/;
const withoutTitles = text => text.replace(/[「『][^」』]*[」』]/g, ' ');
const unique = values => [...new Set(values)].sort();
const freeze = value => { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; };

function inferRuleScope(rule) {
  const title = placeOf(rule?.title || '');
  const evidence = [];
  const accepted = { campus: [], institution: [] }, uncertain = { campus: false, institution: false };
  const first = (rule?.blocks || []).map((b,index)=>({b,index})).filter(({b})=>b&&!b.supplementary&&typeof b.content==='string').slice(0,3);
  for (const {b,index} of first) {
    const h=heading(b.content), name=h?.[1]?.replace(/\s/g,'')||'';
    const body=h?b.content.slice(h[0].length):b.content;
    const eligible=/^(?:목적|적용범위|적용대상|범위|대상)(?:및(?:적용범위|적용대상|대상|범위))?$/.test(name);
    const cleaned=withoutTitles(body), named=placeOf(cleaned);
    const scopeSentence=cleaned.split(/[.!?。]\s*|\n+/).filter(s=>explicitApplication.test(s));
    const applicationTarget=scopeSentence.map(s=>s.split(/(?:에\s*따라|에\s*의하여|에\s*의거하여|에\s*근거하여)/).at(-1).split(/(?:적용한다|적용함|적용하는|적용된다|적용됨|적용대상으로|대상으로)/)[0]).join(' ');
    for (const axis of ['campus','institution']) {
      if(!named[axis].length)continue;
      let reason=null;
      let values=[];
      if(!eligible)reason='not_purpose_or_application';
      else if(negative.test(cleaned)){reason='exception_or_negative';uncertain[axis]=true;}
      else {
        const ownership=axis==='campus'?directCampus.test(cleaned):ownInstitution.test(cleaned);
        const application=!!applicationTarget;
        // Only the direct target clause (not a preceding cited source) establishes scope.
        values=application ? placeOf(applicationTarget)[axis] : ownership ? placeOf((axis==='campus'?directCampus:ownInstitution).exec(cleaned)[0])[axis] : [];
        if(application && /(?:전교|양\s*캠퍼스|모든\s*캠퍼스|캠퍼스에\s*관계없이)/.test(applicationTarget))values=[];
        if(axis==='institution'&&!(application?institutionalTarget.test(applicationTarget.trim()):institutionalDomain.test(cleaned))){values=[];reason='institution_admin_or_subject_not_scope';}
        if(!application&&named[axis].length>1){values=[];uncertain[axis]=true;}
        if(!values.length)reason=reason||'mention_without_direct_scope';
        // A bare citation/analogy is never enough to establish the current rule's scope.
        else if(/(?:준용한다|준용함|따른다)\s*[.。]?\s*$/.test(cleaned.trim())&&!/목적|정한다|적용한다/.test(cleaned))reason='reference_only';
      }
      const item={axis,values:reason?[...named[axis]]:[...values],blockIndex:index,article:b.article||null,heading:name,text:body.trim(),accepted:!reason,reason:reason||'explicit_purpose_or_application'};
      evidence.push(item);
      if(!reason)accepted[axis].push(...values);
    }
  }
  const axes={};
  for(const axis of ['campus','institution']){
    const body=unique(accepted[axis]), fromTitle=unique(title[axis]);
    const conflict=fromTitle.length&&body.some(value=>!fromTitle.includes(value));
    if(fromTitle.length)axes[axis]={values:fromTitle,source:'title',status:conflict?'conflict':fromTitle.length>1?'multiple':'single',bodyValues:body};
    else if(uncertain[axis])axes[axis]={values:[],source:'unknown',status:'ambiguous',bodyValues:body};
    else axes[axis]={values:body,source:body.length?'body':'unknown',status:body.length>1?'multiple':body.length?'single':'unknown',bodyValues:body};
  }
  return freeze({lawId:rule?.lawId,historyId:rule?.historyId,title:rule?.title||'',...axes,evidence});
}
function scopeAgreement(scope, request, title) {
  if(!request?.specified)return 0;
  if(!scope||request.ambiguous)return placeAgreement(title,request);
  let score=0;
  const campus=scope.campus.values;
  // A multi-campus/body scope is shared, not an exclusive edition to boost or penalize.
  if(scope.campus.source==='title'){for(const c of campus){if(request.campuses.includes(c))score++;else if(request.campuses.length)score--;}}
  else if(campus.length===1&&request.campuses.length)score+=request.campuses.includes(campus[0])?1:-1;
  const institutions=scope.institution.values;
  if(scope.institution.source==='title'){for(const institution of institutions)score+=request.institutions.includes(institution)?1:-1;}
  else if(institutions.length===1)score+=request.institutions.includes(institutions[0])?1:-1;
  return score;
}
// Exclude-only: only an explicit BODY campus mismatch supplies a penalty.
// Matching/unknown scopes fall back to the title, preserving its existing signal.
function excludeScopeAgreement(scope, request, title) {
  if(!scope||!request?.specified||request.ambiguous||!request.campuses.length)return null;
  if(scope.campus.source!=='body'||scope.campus.values.length!==1)return null;
  if(request.campuses.includes(scope.campus.values[0]))return null;
  return Math.min(-1,placeAgreement(title,request));
}
function createScopeSignal({corpus,mode='body'}={}) {
  try {
    if(!['body','exclude'].includes(mode))return null;
    if(corpus===undefined)corpus=loadCorpus(path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache'),'dongguk-rule-mcp/v2/public'));
    if(!corpus||!Array.isArray(corpus.rules))return null;
    let rows=memo.get(corpus);
    if(!rows){rows=new Map(corpus.rules.map(rule=>[rule.lawId,inferRuleScope(rule)]));memo.set(corpus,rows);}
    return {rows:()=>[...rows.values()],of:lawId=>rows.get(lawId)||null,agreement(member,request){
      const row=rows.get(member.lawId);
      if(!row||row.title!==member.title||(member.historyId&&row.historyId!==member.historyId))return null;
      if(mode==='exclude')return excludeScopeAgreement(row,request,member.title);
      if(!['campus','institution'].some(axis=>row[axis].source==='body'))return null;
      return scopeAgreement(row,request,member.title);
    }};
  } catch {return null;}
}
module.exports={inferRuleScope,scopeAgreement,excludeScopeAgreement,createScopeSignal};

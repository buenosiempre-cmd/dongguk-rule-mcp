'use strict';
const crypto = require('node:crypto');
const { normalizeName } = require('./references');
const LIMITS = { maxNames:8, totalTimeoutMs:6000, timeoutMs:2000 };

// Only newly detected unquoted/unnumbered names enter this gate. Existing
// numbered/quoted citations keep their established lookup and warning paths.
async function verifyLawNameMentions(references, {configured, cached, inspectLaws}) {
  const decisions = new Map(), deadline = Date.now() + LIMITS.totalTimeoutMs;
  for (const item of references) {
    if (!item.nameVerificationRequired) continue;
    const key = JSON.stringify([normalizeName(item.name),normalizeName(item.nameCandidate)]);
    if (decisions.has(key)) continue;
    let decision = {status:'needs_review',code:item.nameVerificationBlocked||'LAW_NAME_NOT_CONFIGURED'};
    if (configured && !item.nameVerificationBlocked) {
      const left = deadline - Date.now();
      if (decisions.size >= LIMITS.maxNames || left < 500) decision = {status:'needs_review',code:'LAW_NAME_CHECK_LIMIT'};
      else {
        try {
          const cacheKey = crypto.createHash('sha256').update('unnumbered-v1|' + key + '|' + new Date().toISOString().slice(0,10)).digest('hex');
          const identity = await cached('law-name-verification',cacheKey,6*60*60,async()=>{
            const result = await inspectLaws([{name:item.name,articles:[],suffixMatch:true,...(item.nameCandidate?{nameCandidate:item.nameCandidate}:{})}],{
              maxLaws:1,maxArticles:0,timeoutMs:Math.min(left,LIMITS.timeoutMs),totalTimeoutMs:left,
            });
            const id = result.laws?.[0]?.identity;
            const confirmedName = normalizeName(id?.status === 'renamed' ? id.renamedFrom : id?.name);
            const fromText = confirmedName && [item.name,item.nameCandidate].filter(Boolean).some(n=>{const words=n.trim().split(/\s+/);return words.some((_,i)=>normalizeName(words.slice(i).join(' '))===confirmedName);});
            if (!['current','renamed'].includes(id?.status) || !fromText) throw Object.assign(new Error('law name not verified'),{reviewCode:id?.code||'LAW_NAME_NOT_VERIFIED'});
            return id; // Never cache failed/ambiguous classifications here.
          });
          decision = {status:'confirmed',identity};
        } catch (error) { decision = {status:'needs_review',code:error.reviewCode||'LAW_NAME_LOOKUP_FAILED'}; }
      }
    }
    decisions.set(key,decision);
  }
  const verified = references.map(item=>{
    if (!item.nameVerificationRequired) return item;
    const key = JSON.stringify([normalizeName(item.name),normalizeName(item.nameCandidate)]);
    const decision = decisions.get(key);
    const {nameVerificationRequired, ...rest} = item;
    if (decision.status !== 'confirmed') return {...rest,nameVerification:decision};
    // Keep the cited spelling when an explicit rename was reported.
    const name = decision.identity.status === 'renamed' ? item.name : decision.identity.name;
    return {...rest,name,scope:'external_law',target:{lawName:name,...(item.article?{article:item.article}:{})},
      nameCandidate:undefined,nameExtended:false,resolutionStatus:'official_law_name',nameVerification:{...decision,citedName:item.name}};
  });
  const unverified = verified.filter(item=>item.nameVerification?.status==='needs_review').map(item=>({
    name:item.name,...(item.nameCandidate?{nameCandidate:item.nameCandidate}:{}),article:item.article,
    citationText:item.citationText,sourceLocation:item.sourceLocation,status:'needs_review',code:item.nameVerification.code,
  }));
  return {references:verified,unverified};
}
function formatUnverifiedLawMentions(mentions) {
  return mentions.length ? '\n\n### 법령명 확인 필요\n공식 법령명과 대조하지 못한 표현입니다. 국가 법령으로 확정하지 않았으며 인용 위치를 보존합니다.\n' +
    mentions.map(m=>`- ${m.sourceLocation?.article||'조문 미상'}: ${m.name}${m.article?' '+m.article:''} — 확인 필요 (${m.code})`).join('\n') : '';
}
module.exports = {verifyLawNameMentions,formatUnverifiedLawMentions,LIMITS};

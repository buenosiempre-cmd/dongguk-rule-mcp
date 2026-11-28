'use strict';
const crypto = require('node:crypto');
const { normalizeName } = require('./references');
const { createLegalCallBudget } = require('./legal-client');
const LIMITS = { maxNames:8, maxCalls:8, requestMaxCalls:32, notFoundTtlSeconds:60, totalTimeoutMs:6000, timeoutMs:2000 };

// Word boundaries are significant: "가짜 병역법" can end in the official name,
// while "가짜병역법" cannot. Do not merge their cache keys by removing spaces.
const mentionKey = item => JSON.stringify([item.name,item.nameCandidate].map(name=>String(name||'').trim().split(/\s+/).map(normalizeName).join(' ')));

// Only newly detected unquoted/unnumbered names enter this gate. Existing
// numbered/quoted citations keep their established lookup and warning paths.
async function verifyLawNameMentions(references, {configured, cached, inspectLaws, callBudget}) {
  const nameBudget = createLegalCallBudget(LIMITS.maxCalls,callBudget);
  const decisions = new Map(), deadline = Date.now() + LIMITS.totalTimeoutMs;
  for (const item of references) {
    if (!item.nameVerificationRequired) continue;
    const key = mentionKey(item);
    if (decisions.has(key)) continue;
    let decision = {status:'needs_review',code:item.nameVerificationBlocked||'LAW_NAME_NOT_CONFIGURED'};
    if (configured && !item.nameVerificationBlocked) {
      const left = deadline - Date.now();
      if (decisions.size >= LIMITS.maxNames || left < 500) decision = {status:'needs_review',code:'LAW_NAME_CHECK_LIMIT'};
      else {
        try {
          const cacheKey = crypto.createHash('sha256').update('unnumbered-v2|' + key + '|' + new Date().toISOString().slice(0,10)).digest('hex');
          const identity = await cached('law-name-verification',cacheKey,6*60*60,async()=>{
            // A separate short-lived negative cache never becomes a successful
            // identity/body cache entry. The scoped disk cache also coalesces
            // concurrent same-key loads (including failures); no global map leaks
            // private/public cache scopes or retains settled promises.
            try {
              const missing = await cached('law-name-not-found',cacheKey,LIMITS.notFoundTtlSeconds,async()=>{
                const result = await inspectLaws([{name:item.name,articles:[],suffixMatch:true,...(item.nameCandidate?{nameCandidate:item.nameCandidate}:{})}],{
                  maxLaws:1,maxArticles:0,timeoutMs:Math.min(left,LIMITS.timeoutMs),totalTimeoutMs:left,callBudget:nameBudget,
                });
                const id = result.laws?.[0]?.identity;
                const confirmedName = normalizeName(id?.status === 'renamed' ? id.renamedFrom : id?.name);
                const fromText = confirmedName && [item.name,item.nameCandidate].filter(Boolean).some(n=>{const words=n.trim().split(/\s+/);return words.some((_,i)=>normalizeName(words.slice(i).join(' '))===confirmedName);});
                if (['current','renamed'].includes(id?.status) && fromText) throw Object.assign(new Error('confirmed identity'),{confirmedIdentity:id});
                // Only an explicit NOT_FOUND on every attempted query qualifies.
                // Similar-name mismatch, limits, outages and timeouts are retried.
                if (id?.status==='not_found' && id.notFoundConfirmed===true) return {code:id.code};
                throw Object.assign(new Error('law name not verified'),{reviewCode:id?.code||'LAW_NAME_NOT_VERIFIED'});
              });
              throw Object.assign(new Error('law name not found'),{reviewCode:missing.code});
            } catch (error) {
              if (error.confirmedIdentity) return error.confirmedIdentity;
              throw error;
            }
          });
          decision = {status:'confirmed',identity};
        } catch (error) { decision = {status:'needs_review',code:error.reviewCode||'LAW_NAME_LOOKUP_FAILED'}; }
      }
    }
    decisions.set(key,decision);
  }
  const verified = references.map(item=>{
    if (!item.nameVerificationRequired) return item;
    const key = mentionKey(item);
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

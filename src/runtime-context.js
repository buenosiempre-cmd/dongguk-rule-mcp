'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const context=new AsyncLocalStorage();
function normalizeProfile(value='rules') {
  if (!['rules','finance'].includes(value)) throw Object.assign(new Error('profile은 rules 또는 finance여야 합니다.'),{code:'INVALID_ARGUMENT'});
  return value;
}
function withProfile(profile, fn) { return context.run({profile:normalizeProfile(profile)},fn); }
function requestCookie() { return context.getStore()?.profile==='finance' ? (process.env.DONGGUK_RULE_COOKIE||'').trim() : ''; }
function normalizeCampus(value='all') {
  if(typeof value!=='string') return null;
  return new Map([['all','all'],['전체','all'],['seoul','seoul'],['서울','seoul'],['wise','wise'],['경주','wise']]).get(value.trim().toLowerCase())||null;
}
function campusScope(value='all') {
  return {requested:normalizeCampus(value),filterApplied:false,upstreamLawgroup:'0',basis:'공식 LAWGROUP은 캠퍼스가 아닌 문서종류입니다(0=전체, 1=규정).',sourceUrl:'https://rule.dongguk.edu/lmxsrv/main/main.srv',verifiedAt:'2026-09-08',notice:'통합목록을 검색했습니다. 캠퍼스·직군별 적용은 규정 제목과 적용범위 조문을 확인하세요.'};
}
module.exports={normalizeProfile,withProfile,requestCookie,normalizeCampus,campusScope};

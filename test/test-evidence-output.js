'use strict';
const assert=require('node:assert/strict');
const {formatLegalEvidence}=require('../src/legal-format.js');
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await check('unrequested laws do not create an unavailable warning',()=>assert.equal(formatLegalEvidence({status:'not_requested'}),''));
 await check('partial annex preserves reference-only and source limits',()=>{
  const t=formatLegalEvidence({status:'partial',results:[{request:{law_name:'합성법'},status:'partial',annexes:[{selector:'별표 1',status:'partial',referenceOnly:true,truncated:true,dateStatus:'historical_unverified',text:'합성 별표'}]}]});
  for(const expected of ['참고용','잘림','historical_unverified','미확인','합성 별표'])assert(t.includes(expected));
 });
 console.log(`Evidence formatting: ${passed} passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});

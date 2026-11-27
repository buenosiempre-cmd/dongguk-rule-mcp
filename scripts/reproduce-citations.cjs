// Synthetic red-team fixtures; no network or shared cache access.
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),out=process.argv[2];
const body='### 제1조(목적)\n합성 규정의 본칙 목적이다.\n\n### 제1조의12(특례)\n가지조문 본문이다.\n\n## 부칙(2020.1.1.)\n\n### 제1조(시행일)\n이 합성 규정은 2020년 1월 1일부터 시행한다.';
const input=['「검수규정」 제1조','「검수규정」 제1조의12','「검수규정」 부칙 제1조','「검수규정」 부칙(2099.1.1.) 제1조','「검수규정」 별표999','「검수규정」 제1조의123','「검수규정」 제1조 제999항'];
(async()=>{const results=[];for(const name of ['current']){const {verifyRuleCitations}=require(path.join(root,'src/citations.js'));const deps={searchRule:async()=>({hits:[{lawId:1,historyId:2,title:'검수규정'}]}),resolveLatest:async()=>({historyId:2,revisedAt:'2026.01.01'}),getRuleMarkdown:async()=>body};for(const text of input){const r=await verifyRuleCitations(text,deps);results.push({repo:name,input:text,summary:r.summary,citations:r.citations});}for(const kind of ['search','history','body']){const bad={...deps};bad[{search:'searchRule',history:'resolveLatest',body:'getRuleMarkdown'}[kind]]=async()=>{throw Error('synthetic outage')};const r=await verifyRuleCitations(input[0],bad);results.push({repo:name,input:'outage-'+kind,summary:r.summary,citations:r.citations});}}
if(out)fs.writeFileSync(out,JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));})();

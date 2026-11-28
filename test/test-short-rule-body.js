'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const W=path.resolve(__dirname,'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'short-body-'));
let passed=0;
const check=(name,ok)=>{assert.ok(ok,name);passed++;};
process.env.XDG_CACHE_HOME=root;process.env.DONGGUK_RULE_COOKIE='';process.env.DONGGUK_MCP_NO_CACHE='0';process.env.DONGGUK_MCP_PROFILE='rules';process.env.DONGGUK_LEGAL_MCP_ENABLED='0';process.env.DONGGUK_MCP_SEMANTIC='off';process.env.DONGGUK_MCP_RANKING='legacy';
const req=x=>require(require.resolve(x,{paths:[W]}));const fetchPath=require.resolve('node-fetch',{paths:[W]});require(fetchPath);require.cache[fetchPath].exports=async()=>({ok:true,status:200,text:async()=>'<p class="infoLeft"><span>0</span>건</p><table><tbody class="tbody"></tbody></table>'});
const {Client}=req('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=req('@modelcontextprotocol/sdk/inMemory.js');const {createServer}=require(path.join(W,'src/index.js'));const {buildCorpus,saveCorpus}=require(path.join(W,'src/corpus.js'));
let short=Array.from({length:6},(_,i)=>`### 제${i+1}조(온실 교육 ${i+1})\n온실 교육 신청 절차에 관한 세부 내용 ${'설명'.repeat(80)}`).join('\n\n');short+='가'.repeat(2000-short.length);
const annex='### 제1조(목적)\n도서 선발을 정한다.\n\n### 제2조(선발 승인)\n도서 선발 신청은 관리부서에 한다.\n\n[별표 1] 도서 선발 신청 기준\n'+('도서 선발 신청 기준 및 세부 내용입니다.\n').repeat(600);
const catalog=[{lawId:1,historyId:101,title:'교육시설 운영규정',code:'3-1-1',revisedAt:'2026.11.28'},{lawId:2,historyId:102,title:'자료실 운영규정',code:'3-1-2',revisedAt:'2026.11.28'}];const contents=[short,annex];const dir=path.join(root,'dongguk-rule-mcp/v2/public');
const seed=(kind,key,value)=>{const d=path.join(dir,kind);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,key+'.json'),JSON.stringify(value));};
(async()=>{seed('catalog','all',catalog);for(const r of catalog){const markdown=contents[r.lawId-1];seed('history',r.lawId,[{historyId:r.historyId,revisedAt:r.revisedAt}]);seed('content-v4',`${r.lawId}_${r.historyId}`,{title:r.title,markdown});seed('original-structure-v2',`${r.lawId}_${r.historyId}`,{markdown,structure:{coverage:{articles:'complete'}}});}
saveCorpus(dir,await buildCorpus({catalog,loadContent:async id=>({title:catalog[id-1].title,markdown:contents[id-1]})}));const server=createServer({profile:'rules'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'redteam-excerpt',version:'1'});await client.connect(b);
const cases=[{query:'온실 교육 신청 절차',max_sections:1,max_chars:1000},{query:'온실 교육 신청 절차',max_sections:1,max_chars:3000},{query:'온실 교육 신청 절차'},{query:'온실 교육 신청 절차',terms:'온실',max_sections:1},{query:'온실 교육 제6조',max_sections:1},{query:'도서 선발 신청 기준'},{query:'온실 교육 신청 절차',max_chars:1000},{query:'온실 교육 신청 절차',max_sections:4}];let rows=[];
for(let i=0;i<cases.length;i++){const args=cases[i],response=await client.callTool({name:'lookup_dongguk_rule',arguments:args});rows.push({id:'E'+(i+1),args,response});}
await client.close();await server.close();
const data=rows.map(x=>x.response.structuredContent.data.rules[0]);
const headings=r=>[...r.excerpt.text.matchAll(/^### (제\d+조)/gm)].map(m=>m[1]);
for(const i of [0,1,3,4]) {
 check('explicit max_sections preserves one article '+i,headings(data[i]).length===1);
 check('explicit sections/selectors have no whole-body claim '+i,!data[i].excerpt.wholeBody&&!rows[i].response.content[0].text.includes('본문 전체를 보여'));
}
check('default short body expands',data[2].excerpt.wholeBody===true&&headings(data[2]).length===6&&!data[2].excerpt.charactersTruncated);
check('automatic expansion rejected by character limit',!data[6].excerpt.wholeBody&&!rows[6].response.content[0].text.includes('본문 전체를 보여')&&headings(data[6]).length<6);
check('explicit default section count also disables expansion',!data[7].excerpt.wholeBody&&headings(data[7]).length<=4);
check('long annex does not claim whole body',!data[5].excerpt.wholeBody&&!rows[5].response.content[0].text.includes('본문 전체를 보여'));
const {extractRelevantBlocks}=require('../src/lookup.js');
for(const length of [1999,2000,2001]) for(const maxChars of [1000,2000,12000]) for(const maxBlocks of [1,3,4]) {
 const text=length<=2000?short.slice(0,length):short+'가';
 const options={maxChars,maxBlocks,order:'relevance'};
 const original=extractRelevantBlocks(text,'온실 교육 신청',options);
 const actual=extractRelevantBlocks(text,'온실 교육 신청',{...options,wholeBodyChars:2000});
 if(length<=2000&&length<=maxChars) {
  check(`complete body ${length}/${maxChars}/${maxBlocks}`,actual.wholeBody===true&&!actual.charactersTruncated&&[...actual.text.matchAll(/^### (제\d+조)/gm)].length===6);
 } else {
  assert.deepEqual(actual,original,`exact fallback ${length}/${maxChars}/${maxBlocks}`);passed++;
 }
}
const options={maxBlocks:3,maxChars:6000,order:'relevance'};
assert.deepEqual(extractRelevantBlocks(annex,'도서 선발 신청 기준',{...options,wholeBodyChars:2000}),extractRelevantBlocks(annex,'도서 선발 신청 기준',options));passed++;
fs.rmSync(root,{recursive:true,force:true});
console.log(`📊 짧은 본문 한도 검증: ${passed}개 통과 / 0개 실패`);
})().catch(e=>{console.error(e);process.exitCode=1});

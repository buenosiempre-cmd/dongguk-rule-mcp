'use strict';
const assert = require('node:assert/strict');
const { extractPdfText, LIMITS } = require('../src/pdf-text');
const { selectPdf, articleMarkdown, NOTICE } = require('../src/cau-pdf');
const { SOURCES, createPublicClient, loadExternal, expandTopic, compareUniversityRules, formatComparison } = require('../src/university-rules');
const { listArticleBlocks } = require('../src/parsers');
const cau = SOURCES.find(s => s.key === 'cau');
const spec = expandTopic('여비');
const pdfPath = '/ajaxFile/FR_SVC/CampusRulePDFDownload2.do?FILE_PATH=test&FILE_NM=test.pdf';
// Small, valid text-layer PDF generated locally; exercises the actual parser in a worker.
function pdf(pages = 1, text = 'Hello PDF fixture') {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages} /Kids [${Array.from({length:pages},(_,i)=>`${4+i*2} 0 R`).join(' ')}] >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i=0;i<pages;i++) {
    const stream = text ? `BT /F1 12 Tf 50 750 Td (${text}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let body='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
const link=(date='20251027',file='travel.pdf',no='0026')=>`<a onclick="fileDown('/CAU/911/${no}/${date}/','${file}')">download</a>`;
const catalog=(count=1)=>JSON.stringify({data:Array.from({length:count},(_,i)=>({RULES_NO:String(26+i).padStart(4,'0'),RULES:`여비 규정 ${i}`,MAX_DT:'2025-10-27'}))});
const text='여비 규정\n제1조(목적) 출장 여비를 정한다. <개정 2025.10.27.>\n제2조(일비) 출장 일비와 숙박비를 지급한다. 제9조(감액)에 따른다.\n부칙\n2025년 10월 27일부터 시행한다.\n[별표 1]\n제99조(여비) 별표고유금액 999원';
function client({ list=catalog(), detail, bytes=pdf(), fail }={}) {
  return { request: async (source,path,body,budget,signal,opts) => {
    if (fail) throw Object.assign(new Error('fixture'),{code:fail});
    if (path.includes('CampusRuleList')) return list;
    if (path.includes('RulesDetailView')) return detail ?? link('20190523','old.pdf',new URL('https://x'+path).searchParams.get('RULES_NO'))+link('20251027','new.pdf',new URL('https://x'+path).searchParams.get('RULES_NO'));
    assert.equal(opts.binary,true); assert(path.includes('/20251027/'.replaceAll('/','%2F')));
    return bytes;
  } };
}
const load=(c=client(),opts={})=>loadExternal(cau,'여비',spec.terms,c,undefined,spec,{extractPdf:async()=>({text,pages:1}),...opts});
// Exact redteam PDFs: only network responses are synthetic. The comparison uses
// the production download validation, PDF worker, adapter and frame selection.
async function compareFixture(name) {
  const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname,'fixtures/cau-pdf',name+'.pdf'));
  const extracted = await extractPdfText(bytes);
  const publicClient = createPublicClient({minIntervalMs:0,fetchImpl:async url=>{
    if(url.includes('CampusRuleList')) return {ok:true,status:200,text:async()=>catalog()};
    if(url.includes('RulesDetailView')) return {ok:true,status:200,text:async()=>link()};
    if(url.includes('CampusRulePDFDownload2')) return {ok:true,status:200,buffer:async()=>bytes};
    throw new Error('Unexpected fixture request');
  }});
  const result=await compareUniversityRules({topic:'여비',universities:['cau'],max_articles:5},{client:publicClient,loadDongguk:async()=>({rules:[],failures:[],coverage:{complete:true}})});
  const column=result.columns.find(c=>c.university==='cau');
  assert.equal(column.status,'partial');
  return {extracted,result,column};
}
let passed=0;
async function check(name,fn) { await fn();passed++;console.log('  ✅ '+name); }
async function main() {
  await check('실제 PDF 텍스트 추출기: 유효 PDF의 텍스트와 페이지',async()=>{const r=await extractPdfText(pdf());assert.match(r.text,/Hello PDF fixture/);assert.equal(r.pages,1);});
  await check('스캔형 빈 PDF·손상 PDF를 원문 없음으로 숨기지 않음',async()=>{await assert.rejects(extractPdfText(pdf(1,'')),e=>e.code==='PDF_NO_TEXT');await assert.rejects(extractPdfText(Buffer.from('%PDF-1.4 damaged')),e=>e.code==='PDF_PARSE_FAILED');});
  await check('PDF 바이트·페이지 상한',async()=>{const b=Buffer.alloc(LIMITS.maxBytes+1);b.write('%PDF-1.4');await assert.rejects(extractPdfText(b),e=>e.code==='PDF_TOO_LARGE');await assert.rejects(extractPdfText(pdf(201)),e=>e.code==='PDF_TOO_MANY_PAGES');});
  await check('PDF 파서 시간 제한 후 정상 재사용',async()=>{await assert.rejects(extractPdfText(pdf(),{timeoutMs:1}),e=>e.code==='PDF_PARSE_TIMEOUT');assert.match((await extractPdfText(pdf())).text,/Hello/);});
  await check('PDF 추출 취소와 동시 실행 상한',async()=>{
    const a=new AbortController();a.abort();await assert.rejects(extractPdfText(pdf(),{signal:a.signal}),e=>e.code==='TOTAL_TIMEOUT');
    const b=new AbortController();const jobs=[extractPdfText(pdf(),{signal:b.signal}),extractPdfText(pdf(),{signal:b.signal})];
    const settled=Promise.allSettled(jobs);await assert.rejects(extractPdfText(pdf()),e=>e.code==='PDF_PARSE_BUSY');b.abort();
    assert((await settled).every(x=>x.status==='rejected'&&x.reason.code==='TOTAL_TIMEOUT'));
  });
  await check('상세 순서와 관계없이 MAX_DT에 맞는 PDF 선택',()=>{const f=selectPdf(link('20190523','old.pdf')+link(),'0026','2025-10-27');assert.equal(f.date,'20251027');assert.equal(f.file,'travel.pdf');});
  await check('개정본 불일치·복수 첨부·다른 규정·경로 변형은 확인 실패',()=>{
    for(const detail of [link('20190523'),link()+link('20251027','appendix.pdf'),link('20251027','x.pdf','9999'),link('20251027','../x.pdf')]) assert.throws(()=>selectPdf(detail,'0026','2025-10-27'),e=>e.code==='PDF_REVISION_UNVERIFIED');
    assert.throws(()=>selectPdf(link(),'0026',null),e=>e.code==='PDF_REVISION_UNVERIFIED');
  });
  await check('PDF 문구·개정 표시 보존, 문장 속 조문을 새 제목으로 만들지 않음',()=>{const m=articleMarkdown(text);assert.match(m,/<개정 2025.10.27.>/);assert.match(m,/제9조\(감액\)에 따른다/);assert.deepEqual(listArticleBlocks(m).map(x=>x.canonical),['제1조','제2조']);});
  await check('별표·별지·부록은 조문 비교 대상에서 제외',()=>{
    for(const marker of ['[별표 1]','<별표1>','【별표 1】','별지 제1호 서식','부록','붙임 1']) {const m=articleMarkdown(`제1조(여비) 여비를 지급한다.\n${marker}\n제9조(여비) 부록금액`);assert.doesNotMatch(m,/부록금액/);}
    assert.match(articleMarkdown('제1조(여비)\n별표에 따른다.'),/별표에 따른다/);
  });
  await check('중앙대 목록·다운로드·조문화 연결과 출처/개정본',async()=>{const r=await load();assert.equal(r.rules.length,1);const rule=r.rules[0];assert.equal(rule.historyId,'20251027');assert.equal(rule.revisedAt,'2025.10.27');assert.equal(rule.effectiveAt,null);assert.match(rule.originalPdfUrl,/CampusRulePDFDownload2/);assert.equal(rule.sourceType,'PDF 텍스트 레이어');assert.equal(r.coverage.notice,NOTICE);assert.equal(r.coverage.appendicesCompared,false);});
  await check('제목 후보 상한 이전 건수와 잘림 표시',async()=>{const r=await load(client({list:catalog(7)}));assert.equal(r.coverage.titleMatches,7);assert.equal(r.rules.length,5);assert.equal(r.coverage.truncated,true);assert.equal(r.coverage.attemptedRules,5);});
  await check('명시 날짜 없는 공포일 시행을 개정일로 대신하지 않음',async()=>{const r=await load(client(),{extractPdf:async()=>({text:'제1조(여비) 여비를 지급한다.\n부칙 <개정 2025.10.27.>\n공포일부터 시행한다.'})});assert.equal(r.rules[0].effectiveAt,null);});
  await check('차단·목록 형식 실패·스캔/조문 없음의 실패 사유 보존',async()=>{
    await assert.rejects(load(client({fail:'ACCESS_DENIED'})),e=>e.code==='ACCESS_DENIED');
    await assert.rejects(load(client({list:'<html>bad</html>'})),e=>e.code==='UPSTREAM_FORMAT_CHANGED');
    const r=await load(client(),{extractPdf:async()=>({text:'조문을 읽을 수 없음'})});assert.equal(r.rules.length,0);assert.equal(r.failures[0].code,'PDF_NO_ARTICLES');
    const scan=await load(client(),{extractPdf:async()=>{throw Object.assign(new Error('scan'),{code:'PDF_NO_TEXT'});}});assert.equal(scan.failures[0].code,'PDF_NO_TEXT');
  });
  await check('별표 뒤 최신 부칙이 잘리면 앞 부칙 날짜를 현행 시행일로 쓰지 않음',async()=>{
    const r=await load(client(),{extractPdf:async()=>({text:'제1조(여비) 여비를 정한다.\n부칙\n2001년 4월 3일부터 시행한다.\n[별표 1]\n금액표\n부칙\n2025년 10월 27일부터 시행한다.'})});assert.equal(r.rules[0].effectiveAt,null);
    const complete=await load(client(),{extractPdf:async()=>({text:'제1조(여비) 여비를 정한다.\n부칙\n2025년 10월 27일부터 시행한다.'})});assert.equal(complete.rules[0].effectiveAt,'2025-10-27');
  });
  await check('실패한 후보 뒤 다른 규정은 계속 조회',async()=>{let n=0;const r=await load(client({list:catalog(2)}),{extractPdf:async()=>{if(!n++)throw Object.assign(new Error(),{code:'PDF_NO_TEXT'});return {text};}});assert.equal(r.rules.length,1);assert.equal(r.failures.length,1);});
  await check('PDF 바이너리 요청은 외부 쿠키 없이 크기/리다이렉트 제한',async()=>{
    let options;const c=createPublicClient({minIntervalMs:0,fetchImpl:async(url,opts)=>{options=opts;return {ok:true,status:200,buffer:async()=>pdf()};}});
    assert(Buffer.isBuffer(await c.request(cau,pdfPath,undefined,8000,undefined,{binary:true})));assert.equal(options.size,LIMITS.maxBytes);assert.equal(options.redirect,'manual');assert.equal(options.headers.Cookie,undefined);
    await assert.rejects(c.request(SOURCES.find(x=>x.key==='yonsei'),'/regulations',undefined,8000,undefined,{binary:true}),e=>e.code==='SOURCE_NOT_ALLOWED');
  });
  await check('PDF 대신 HTML·로그인·차단·리다이렉트 응답 거절',async()=>{
    for(const [body,status,code] of [['<html>error</html>',200,'PDF_INVALID'],['접근이 차단',200,'ACCESS_DENIED'],['<input type="password">',200,'SESSION_REQUIRED'],['',302,'REDIRECT_NOT_FOLLOWED'],['',403,'ACCESS_DENIED']]) {
      const c=createPublicClient({minIntervalMs:0,fetchImpl:async()=>({ok:status===200,status,buffer:async()=>Buffer.from(body)})});await assert.rejects(c.request(cau,pdfPath,undefined,8000,undefined,{binary:true}),e=>e.code===code);
    }
  });
  await check('다운로드 선언 크기와 실제 크기 모두 제한',async()=>{
    let read=false;const c=createPublicClient({minIntervalMs:0,fetchImpl:async()=>({ok:true,status:200,headers:{get:()=>String(LIMITS.maxBytes+1)},buffer:async()=>{read=true;return pdf();}})});
    await assert.rejects(c.request(cau,pdfPath,undefined,8000,undefined,{binary:true}),e=>e.code==='PDF_TOO_LARGE');assert.equal(read,false);
    const b=Buffer.alloc(LIMITS.maxBytes+1);b.write('%PDF-1.4');const d=createPublicClient({minIntervalMs:0,fetchImpl:async()=>({ok:true,status:200,buffer:async()=>b})});await assert.rejects(d.request(cau,pdfPath,undefined,8000,undefined,{binary:true}),e=>e.code==='PDF_TOO_LARGE');
  });
  await check('A안 비교 결과 partial·PDF 링크·별표 원문 안내',async()=>{
    const data=await compareUniversityRules({topic:'여비',universities:['cau']},{loadDongguk:async()=>({rules:[],failures:[],coverage:{complete:true}}),loadExternalImpl:()=>load()});
    const c=data.columns[1];assert.equal(c.status,'partial');assert.equal(c.coverage.comparisonScope,'articles_only');assert(c.articles.every(x=>x.originalPdfUrl));assert(!c.articles.some(x=>/별표고유/.test(x.text)));
    const output=formatComparison(data);assert.match(output,/별표.*원문/);assert.match(output,/\[PDF 원문\]/);assert(data.supportedUniversities.some(x=>x.key==='cau'));
  });
  await check('스캔 PDF는 no_match가 아닌 unavailable',async()=>{
    const data=await compareUniversityRules({topic:'여비',universities:['cau']},{loadDongguk:async()=>({rules:[],failures:[],coverage:{complete:true}}),loadExternalImpl:()=>load(client(),{extractPdf:async()=>{throw Object.assign(new Error(),{code:'PDF_NO_TEXT'});}})});
    assert.equal(data.columns[1].status,'unavailable');assert.equal(data.columns[1].failures[0].code,'PDF_NO_TEXT');
  });
  await check('I1 실제 한국어 PDF: 부속 제99조와 금액을 조문·비교 근거에서 제외', async()=>{
    for (const name of ['recognized-appendix','unrecognized-brackets','unrecognized-appendix','unrecognized-form']) {
      const { extracted, result, column } = await compareFixture(name);
      assert.match(extracted.text, /제99조/); // the parser really saw the counterexample
      assert.deepEqual(listArticleBlocks(articleMarkdown(extracted.text)).map(b=>b.canonical), ['제1조']);
      assert(!column.articles.some(a=>a.article==='제99조'));
      assert.doesNotMatch(JSON.stringify({ articles:column.articles, slots:result.slotMatrix }), /999원|제99조/);
      assert.doesNotMatch(formatComparison(result), /999원|제99조/);
      assert.equal(column.coverage.appendicesCompared, false);
    }
  });
  await check('I2 실제 한국어 PDF: 별표 참조 문장과 후속 조문 보존', async()=>{
    const { extracted, column } = await compareFixture('appendix-mention-in-body');
    assert.deepEqual(listArticleBlocks(articleMarkdown(extracted.text)).map(b=>b.canonical), ['제1조','제2조']);
    assert.match(column.articles.find(a=>a.article==='제1조').text, /별표 1에 따른 여비를 지급한다/);
    assert(column.articles.some(a=>a.article==='제2조'));
  });
  await check('I3 실제 한국어 PDF: 줄바꿈된 인용도 앞 조문 문장에 남음', async()=>{
    const wrapped = await compareFixture('wrapped-article-citation');
    const inline = await compareFixture('inline-article-citation');
    assert.match(wrapped.extracted.text, /일비는\s*\n제9조/);
    for (const r of [wrapped, inline]) {
      assert.deepEqual(listArticleBlocks(articleMarkdown(r.extracted.text)).map(b=>b.canonical), ['제1조','제2조']);
      assert.match(r.column.articles.find(a=>a.article==='제1조').text, /제9조\(일비\)에 따른다/);
      assert(!r.column.articles.some(a=>a.article==='제9조'));
    }
    const body = r=>r.column.articles.find(a=>a.article==='제1조').text.replace(/\s+/g,' ');
    assert.equal(body(wrapped),body(inline));
  });
  await check('I3 r2 실제 PDF: 괄호 뒤 공백 유무와 관계없이 참조 조건 보존', async()=>{
    for (const [name, reference] of [
      ['spaced-article-reference', '제9조(일비) 에서 정한 기준을 적용한다.'],
      ['spaced-possessive-reference', '제9조(일비) 의 지급 기준을 적용한다.'],
      ['unspaced-reference-control', '제9조(일비)에서 정한 기준을 적용한다.'],
    ]) {
      const {extracted, result, column}=await compareFixture(name);
      assert(extracted.text.includes(reference));
      assert.deepEqual(listArticleBlocks(articleMarkdown(extracted.text)).map(b=>b.canonical), ['제1조','제2조']);
      assert(column.articles.find(a=>a.article==='제1조').text.includes(reference));
      assert(!column.articles.some(a=>a.article==='제9조'));
      assert(JSON.stringify(result.slotMatrix).includes(reference));
      assert(formatComparison(result).includes(reference));
    }
  });
  await check('I3 r2: 참조 조사 공백 변형과 정상 이 규정 본문을 구분',()=>{
    for (const gap of ['', ' ', '\t', '  ']) {
      for (const clause of ['에서 정한 기준을 적용한다.', '의 지급 기준을 적용한다.', '에 따른다.', '를 준용한다.', '으로 정한다.', '까지 적용한다.']) {
        const reference=`제9조(일비)${gap}${clause}`;
        const blocks=listArticleBlocks(articleMarkdown(`제1조(지급) 국내출장 일비는\n${reference}\n제2조(정산) 이 규정은 정산에 적용한다.`));
        assert.deepEqual(blocks.map(b=>b.canonical), ['제1조','제2조']);
        assert(JSON.stringify(blocks[0]).includes(clause));
      }
    }
    for (const gap of [' ', '\t', '  ']) {
      const blocks=listArticleBlocks(articleMarkdown(`제1조(목적)${gap}이 규정은 여비에 적용한다.\n제2조의2(기준)${gap}이 기준은 정산에 적용한다.\n제3조 삭제`));
      assert.deepEqual(blocks.map(b=>b.canonical), ['제1조','제2조의2','제3조']);
      assert(JSON.stringify(blocks[0]).includes('이 규정은 여비에 적용한다.'));
    }
  });
  await check('부속 표제 구분 기호·서식과 본문 조사 구분, 시행일 보존', async()=>{
    for (const marker of ['〔별표〕','〔부록〕','[서식]','［별표 1］','《부록 1》','별표 1 지급 기준','[별표 1] 의료비 지급 기준','별지 제1호 서식']) {
      assert.doesNotMatch(articleMarkdown(`제1조(여비) 출장 여비를 지급한다.\n${marker}\n제99조(여비) 999원`), /제99조|999원/);
    }
    for (const reference of ['별표 1에 따른 여비를 지급한다.','별지 제1호 서식으로 신청한다.','[별표 1]에 따른다.','〔부록 1〕을 참조한다.','서식 1을 사용한다.','별표 1 에 따른 여비를 지급한다.']) {
      const input=`제1조(여비) 출장 여비를 지급한다.\n${reference}\n제2조(정산) 출장 여비를 정산한다.\n부칙\n2025년 10월 27일부터 시행한다.`;
      const r=await load(client(),{extractPdf:async()=>({text:input})});
      assert(r.rules[0].markdown.includes(reference));
      assert.deepEqual(listArticleBlocks(r.rules[0].markdown).map(b=>b.canonical),['제1조','제2조']);
      assert.equal(r.rules[0].effectiveAt,'2025-10-27');
    }
  });
  await check('줄바꿈 인용 조사·가지조문과 정상 제목/본문 구분',()=>{
    for (const reference of ['제9조(일비)에 따른다.','제9조(일비)를 준용한다.','제9조의2(국내(서울) 일비)에 따른다.','제9조（일비）에 따른다.','제9조(일비) 에 따른다.']) {
      const blocks=listArticleBlocks(articleMarkdown(`제1조(지급) 국내출장 일비는\n${reference}\n제2조(정산) 이 규정은 정산에 적용한다.`));
      assert.deepEqual(blocks.map(b=>b.canonical),['제1조','제2조']);
      assert(JSON.stringify(blocks[0]).includes(reference));
    }
    const normal=articleMarkdown('제1조(목적) 이 규정은 여비에 적용한다.\n제2조(범위)\n여비를 정한다.\n제3조 삭제\n제4조(지급)① 여비를 지급한다.');
    assert.deepEqual(listArticleBlocks(normal).map(b=>b.canonical),['제1조','제2조','제3조','제4조']);
  });
  console.log(`📊 중앙대 PDF 검증: ${passed}개 통과`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

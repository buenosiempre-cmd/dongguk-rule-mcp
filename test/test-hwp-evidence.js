'use strict';
const assert=require('node:assert/strict');
const CFB=require('cfb');
const zlib=require('node:zlib');
const {buildOriginalEvidence,compareOriginalEvidence,parseOriginalEvidence,auditOriginalBytes,LIMITS}=require('../src/hwp-evidence');
const p=(text='',controls=[])=>({text,runs:[],controls});
const cell=(row,col,text,rowSpan=1,colSpan=1)=>({row,col,rowSpan,colSpan,paragraphs:[p(text)]});
const table=cells=>({kind:'table',rowCount:2,colCount:2,cells});
const doc=(paragraphs,binData=new Map())=>({sections:[{paragraphs}],binData,docInfo:{binData:[]}});
const evidence=paragraphs=>buildOriginalEvidence(doc(paragraphs));
const codes=x=>x.structure.coverage.diagnostics.map(d=>d.code);
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function record(tag,level,data) {
  const header=Buffer.alloc(4);header.writeUInt32LE(((data.length<<20)|(level<<10)|tag)>>>0);
  return Buffer.concat([header,data]);
}
function hwp(sections,{compressed=false,docInfo=Buffer.alloc(0),flags=0}={}) {
  const container=CFB.utils.cfb_new(),header=Buffer.alloc(256);
  header.write('HWP Document File');header[35]=5;header.writeUInt32LE(flags|(compressed?1:0),36);
  CFB.utils.cfb_add(container,'FileHeader',header);
  CFB.utils.cfb_add(container,'DocInfo',compressed?zlib.deflateRawSync(docInfo):docInfo);
  for(const [i,data] of sections.entries())CFB.utils.cfb_add(container,`BodyText/Section${i}`,compressed?zlib.deflateRawSync(data):data);
  return CFB.write(container,{type:'buffer'});
}
(async()=>{
  await test('same flattened values with different merged cells produce structural changes',()=>{
    const a=evidence([p('별표 1'),p('',[table([cell(0,0,'같음',1,2),cell(1,0,'같음',1,2)])])]);
    const b=evidence([p('별표 1'),p('',[table([cell(0,0,'같음',2,1),cell(0,1,'같음',2,1)])])]);
    const result=compareOriginalEvidence(a,b);
    assert.equal(result.status,'compared');assert.equal(result.tables.counts.changed,1);
    assert.equal(result.tables.changes[0].appendix,'별표 1');
    assert(result.tables.changes[0].cellChanges.some(c=>c.mergeChanged));
    assert.equal(a.structure.coverage.counts.mergedCells,2);
  });
  await test('cell value change identifies row and column and preserves full text hash',()=>{
    const make=text=>evidence([p('별표 2'),p('',[table([cell(0,0,'구분'),cell(0,1,'금액'),cell(1,0,'서울'),cell(1,1,text)])])]);
    const r=compareOriginalEvidence(make('100,000'),make('120,000'));
    const change=r.tables.changes[0].cellChanges[0];
    assert.equal(change.coordinate,'1,1');assert.equal(change.textChanged,true);assert.equal(change.mergeChanged,false);
    assert.equal(change.after.text,'120,000');assert.equal(r.coordinateBase,0);
  });
  await test('image fingerprints ignore parser IDs but detect changed bytes',()=>{
    const make=(id,bytes)=>buildOriginalEvidence(doc([p('별표 1'),p('',[{kind:'picture',binDataId:id}])],new Map([[id,{data:Buffer.from(bytes),extension:'png'}]])));
    const a=make(1,'image one'),b=make(72,'image one'),c=make(72,'image two');
    assert.equal(a.markdown,b.markdown);
    assert.equal(compareOriginalEvidence(a,b).images.counts.unchanged,1);
    assert.equal(compareOriginalEvidence(a,c).images.counts.changed,1);
    assert.equal(compareOriginalEvidence(a,c).images.changes[0].appendix,'별표 1');
    assert(!JSON.stringify(a).includes('base64'));assert(!JSON.stringify(a).includes('image one'));
  });
  await test('picture ordinal resolves the corresponding binary storage ID',()=>{
    const make=(ids)=>{const d=doc([p('그림',[{kind:'picture',binDataId:1},{kind:'picture',binDataId:2}])],new Map([[9,{data:Buffer.from('A'),extension:'png'}],[4,{data:Buffer.from('B'),extension:'png'}]]));d.docInfo.binData=ids.map(storageId=>({storageId,type:'embedding',extension:'png'}));return buildOriginalEvidence(d);};
    const a=make([9,4]),b=make([4,9]);
    assert.equal(a.structure.coverage.status,'covered');
    assert.equal(compareOriginalEvidence(a,b).images.counts.changed,2);
  });
  await test('missing image cannot compare unchanged and returns a document-specific diagnostic',()=>{
    const a=evidence([p('제1조(그림)'),p('',[{kind:'picture',binDataId:4}])]);
    assert(codes(a).includes('MISSING_IMAGE_BYTES'));
    const r=compareOriginalEvidence(a,a);assert.equal(r.status,'partial');assert.equal(r.images.counts.unchanged,0);
  });
  await test('unsupported controls and empty sections remain partial',()=>{
    const a=buildOriginalEvidence({...doc([p('본문',[{kind:'unknown',ctrlId:'form'},{kind:'shape',shapeType:'rectangle'}])]),sections:[{paragraphs:[]},{paragraphs:[p('본문',[{kind:'unknown',ctrlId:'form'}])]}]});
    assert(codes(a).includes('EMPTY_PARSED_SECTION'));assert(codes(a).includes('UNSUPPORTED_CONTROL'));
    assert.equal(compareOriginalEvidence(a,a).status,'partial');
    assert(codes(evidence([p('')])).includes('EMPTY_EXTRACTED_CONTENT'));
  });
  await test('main articles gain headings and appendix internal articles are excluded from body',()=>{
    const a=evidence([p('여비규정'),p('제1조(목적) 본문이다.'),p('별표 1'),p('국내 여비'),p('별지 제1호 서식'),p('제1조(서약) 서식 내부 문장'),p('부칙'),p('제2조(시행) 다음 날 시행한다.')]);
    assert(a.bodyMarkdown.includes('### 제1조(목적)'));
    assert(!a.bodyMarkdown.includes('국내 여비'));assert(!a.bodyMarkdown.includes('서식 내부 문장'));
    assert(!a.bodyMarkdown.includes('제2조(시행)'));
    assert(codes(a).includes('APPENDIX_BODY_BOUNDARY_AMBIGUOUS'));
  });
  await test('ordinary appendix references do not divert body text',()=>{
    const a=evidence([p('제1조(범위)'),p('별표 1에 따른다.'),p('제2조(지급) 지급한다.')]);
    assert(a.bodyMarkdown.includes('별표 1에 따른다.'));assert(a.bodyMarkdown.includes('### 제2조'));
    assert.equal(a.structure.coverage.status,'covered');
  });
  await test('chapters and supplementary rules inside forms stay out of main body',()=>{
    const a=evidence([p('제1조(본칙) 본문'),p('[별지 제1호 서식] 계약서'),p('제1장 총칙'),p('제1조(목적) 계약서 내부'),p('부칙'),p('서식 부칙 내부')]);
    assert(!a.bodyMarkdown.includes('계약서 내부'));assert(!a.bodyMarkdown.includes('서식 부칙 내부'));
    assert(codes(a).includes('APPENDIX_BODY_BOUNDARY_AMBIGUOUS'));
  });
  await test('invalid table gaps and overlap are detected without expanding an unbounded grid',()=>{
    const a=evidence([p('',[table([cell(0,0,'A'),cell(0,0,'B')])])]);
    assert(codes(a).includes('OVERLAPPING_CELLS'));assert(codes(a).includes('UNCOVERED_TABLE_CELLS'));
    assert.throws(()=>evidence([p('',[{kind:'table',rowCount:1000000,colCount:1000000,cells:[]}])]),{code:'HWP_RESOURCE_LIMIT'});
    let nested=p('x');for(let i=0;i<40;i++)nested=p('',[{kind:'header',paragraphs:[nested]}]);
    assert.throws(()=>evidence([nested]),{code:'HWP_RESOURCE_LIMIT'});
    assert.throws(()=>evidence([p('x'.repeat(LIMITS.textChars+1))]),{code:'HWP_RESOURCE_LIMIT'});
  });
  await test('comparison output limits preserve counts and mark truncated cell evidence',()=>{
    const make=text=>evidence([p('별표 1'),p('',[table([cell(0,0,text),cell(0,1,text),cell(1,0,text),cell(1,1,text)])])]);
    const r=compareOriginalEvidence(make('이전'),make('새 값'.repeat(500)),{maxChanges:1});
    assert.equal(r.tables.changes[0].cellChanges.length,1);assert.equal(r.tables.changes[0].cellChangesTotal,4);
    assert.equal(r.changesTruncated,true);assert.equal(r.tables.changes[0].cellChanges[0].after.textTruncated,true);
    assert.equal(r.tables.changes[0].cellChanges[0].after.text.length,1000);
    assert.equal(compareOriginalEvidence(make('이전'),make('이후'),{includeAppendices:false}).tables.beforeCount,0);
  });
  await test('a missing structure cache cannot claim a complete comparison',()=>{
    assert.equal(compareOriginalEvidence({markdown:'x'},{markdown:'x'}).code,'STRUCTURE_EVIDENCE_MISSING');
  });
  await test('changed appendix keys remain exhaustive when detail is clipped',()=>{
    const make=value=>evidence([p('별표 1'),p('',[table([cell(0,0,value,2,2)])]),p('별표 2'),p('',[table([cell(0,0,value,2,2)])])]);
    const r=compareOriginalEvidence(make('이전'),make('이후'),{maxChanges:1});
    assert.equal(r.tables.changes.length,1);assert.deepEqual(r.changedAppendices,['별표 1','별표 2']);
    assert.equal(r.tables.counts.changed,2);
  });
  await test('actual CFB HWP parse audits records and retains source fingerprints',async()=>{
    const bytes=hwp([Buffer.concat([record(66,0,Buffer.alloc(24)),record(67,1,Buffer.from('제1조(목적) 합성 HWP 원문\r','utf16le'))])],{compressed:true});
    const a=await parseOriginalEvidence(bytes);
    assert(a.bodyMarkdown.includes('### 제1조(목적) 합성 HWP 원문'));
    assert.equal(a.structure.coverage.status,'covered');assert.equal(a.structure.coverage.rawAudit,'checked');
    assert.equal(a.structure.sourceSha256.length,64);
  });
  await test('raw record audit detects captions and parser skipped paragraphs',async()=>{
    const ctrl=Buffer.alloc(4);ctrl.writeUInt32LE(0x74626c20);
    const bytes=hwp([Buffer.concat([record(66,0,Buffer.alloc(24)),record(71,1,ctrl),record(72,2,Buffer.alloc(16)),record(66,2,Buffer.alloc(24)),record(67,3,Buffer.from('누락될 캡션\r','utf16le')),record(77,2,Buffer.alloc(8))])]);
    const a=await parseOriginalEvidence(bytes);
    assert(codes(a).includes('TABLE_CAPTION_UNPARSED'));assert(codes(a).includes('PARSER_RECORD_COUNT_MISMATCH'));
    assert.equal(a.structure.coverage.status,'partial');
  });
  await test('short cell coordinates and zero spans cannot silently receive defaults',async()=>{
    const ctrl=Buffer.alloc(4);ctrl.writeUInt32LE(0x74626c20);const meta=Buffer.alloc(8);meta.writeUInt16LE(1,4);meta.writeUInt16LE(1,6);
    const make=cellMeta=>hwp([Buffer.concat([record(66,0,Buffer.alloc(24)),record(71,1,ctrl),record(77,2,meta),record(72,2,cellMeta),record(66,2,Buffer.alloc(24)),record(67,3,Buffer.from('내용\r','utf16le'))])]);
    assert(codes(await parseOriginalEvidence(make(Buffer.alloc(8)))).includes('SHORT_CELL_METADATA'));
    assert(codes(await parseOriginalEvidence(make(Buffer.alloc(16)))).includes('ZERO_CELL_SPAN'));
  });
  await test('raw text decoder restores hyphen and nonbreaking space correctly',async()=>{
    const bytes=hwp([Buffer.concat([record(66,0,Buffer.alloc(24)),record(67,1,Buffer.from('제1조(목적) A\x18B\x1eC\r','utf16le'))])]);
    const a=await parseOriginalEvidence(bytes);
    assert(a.bodyMarkdown.includes('A-B\u00a0C'));assert.equal(a.structure.coverage.status,'covered');
  });
  await test('duplicate or absent paragraph text and automatic numbering are explicit gaps',async()=>{
    const header=Buffer.alloc(24);header.writeUInt32LE(5);
    const duplicate=hwp([Buffer.concat([record(66,0,header),record(67,1,Buffer.from('첫째\r','utf16le')),record(67,1,Buffer.from('둘째\r','utf16le'))])]);
    assert(codes(await parseOriginalEvidence(duplicate)).includes('MULTIPLE_PARAGRAPH_TEXT_RECORDS'));
    assert(codes(await parseOriginalEvidence(hwp([record(66,0,header)]))).includes('MISSING_PARAGRAPH_TEXT'));
    const shape=Buffer.alloc(54);shape.writeUInt32LE(2<<23);
    const numbered=hwp([Buffer.concat([record(66,0,header),record(67,1,Buffer.from('번호 항목\r','utf16le'))])],{docInfo:record(25,1,shape)});
    assert(codes(await parseOriginalEvidence(numbered)).includes('AUTOMATIC_NUMBERING_UNRENDERED'));
  });
  await test('tracking configuration alone is metadata while actual revisions are diagnosed',async()=>{
    const body=Buffer.concat([record(66,0,Buffer.alloc(24)),record(67,1,Buffer.from('본문\r','utf16le'))]);
    const config=record(32,1,Buffer.alloc(1032,1));
    const plain=await parseOriginalEvidence(hwp([body],{docInfo:config}));
    assert.equal(plain.structure.coverage.status,'covered');assert.equal(plain.structure.metadata[0].kind,'trackingConfiguration');
    for(const tag of [96,97]) {
      const changed=await parseOriginalEvidence(hwp([body],{docInfo:Buffer.concat([config,record(tag,1,Buffer.from('revision'))])}));
      assert(codes(changed).includes('TRACKED_CHANGES_PRESENT'));
    }
    assert(codes(await parseOriginalEvidence(hwp([body],{flags:1<<14}))).includes('TRACKED_DOCUMENT_FLAG'));
    const merged=Buffer.alloc(24);merged.writeUInt16LE(1,22);
    assert(codes(await parseOriginalEvidence(hwp([Buffer.concat([record(66,0,merged),record(67,1,Buffer.from('본문\r','utf16le'))])]))).includes('TRACKED_PARAGRAPH_MERGE'));
  });
  await test('raw audit catches unsupported objects even when the IR silently drops them',async()=>{
    const bytes=hwp([Buffer.concat([record(66,0,Buffer.alloc(24)),record(67,1,Buffer.from('본문\r','utf16le')),record(95,1,Buffer.from('chart'))])]);
    const a=await parseOriginalEvidence(bytes);
    assert(codes(a).includes('UNSUPPORTED_RECORD'));assert(a.structure.objects.some(x=>x.kind==='raw-record'));
  });
  await test('declared but missing HWP sections cannot yield complete coverage',async()=>{
    const properties=Buffer.alloc(26);properties.writeUInt16LE(2);
    const bytes=hwp([Buffer.concat([record(66,0,Buffer.alloc(24)),record(67,1,Buffer.from('일부 섹션\r','utf16le'))])],{docInfo:record(16,0,properties)});
    assert(codes(await parseOriginalEvidence(bytes)).includes('DECLARED_SECTION_COUNT_MISMATCH'));
  });
  await test('oversized inflate and malformed raw records fail before parsing',()=>{
    const bytes=hwp([Buffer.alloc(LIMITS.streamBytes+1)],{compressed:true});
    assert.throws(()=>auditOriginalBytes(bytes),/larger|limit|length/i);
    const header=Buffer.alloc(4);header.writeUInt32LE((100<<20)|66);
    assert.throws(()=>auditOriginalBytes(hwp([header])),{code:'HWP_INVALID_RECORD'});
    const deep=record(66,LIMITS.depth+1,Buffer.alloc(0));
    assert.throws(()=>auditOriginalBytes(hwp([deep])),{code:'HWP_RESOURCE_LIMIT'});
  });
  await test('malformed CFB parser failure is isolated from the server process',async()=>{
    await assert.rejects(parseOriginalEvidence(Buffer.alloc(32)),{code:'HWP_INVALID_INPUT'});
    // The CFB library loops on a cyclic FAT whose stream begins inside a chain.
    // Inspect only the normal container; send the mutated bytes to the isolated
    // public API. Never call CFB.read or auditOriginalBytes on them in this process.
    const c=CFB.utils.cfb_new();CFB.utils.cfb_add(c,'FileHeader',Buffer.alloc(5000));
    const malformed=Buffer.from(CFB.write(c,{type:'buffer'}));const normal=CFB.read(malformed,{type:'buffer'});
    const i=normal.FileIndex.findIndex(x=>x.name==='FileHeader'),e=normal.FileIndex[i];
    const directory=malformed.readInt32LE(48),fat=malformed.readInt32LE(76),sectors=Math.ceil(e.size/512),start=e.start;
    malformed.writeInt32LE(start,(fat+1)*512+(start+sectors-1)*4);
    malformed.writeInt32LE(start+1,(directory+1)*512+i*128+116);
    await assert.rejects(parseOriginalEvidence(malformed),error=>['HWP_PARSE_FAILED','HWP_PARSE_TIMEOUT'].includes(error.code));
    const valid=hwp([Buffer.concat([record(66,0,Buffer.alloc(24)),record(67,1,Buffer.from('서버 생존 확인\r','utf16le'))])]);
    assert((await parseOriginalEvidence(valid)).markdown.includes('서버 생존 확인'));
  });
  console.log(`HWP structural evidence regression: ${passed} passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});

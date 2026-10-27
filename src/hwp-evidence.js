'use strict';

// The HWP IR intentionally omits visual layout. Audit the binary records before
// using it so an omitted caption, object or section cannot become "unchanged".
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {fork}=require('node:child_process');
const {appendixHeading, isBodyBoundary} = require('./appendices');
const LIMITS = Object.freeze({inputBytes:32*1024*1024, streamBytes:16*1024*1024,
  expandedBytes:64*1024*1024, streams:1024, sections:128, records:100000,
  depth:32, paragraphs:50000, controls:20000, cells:50000, grid:100000, appendices:2000,
  textChars:4000000, diagnostics:100, changes:50, excerptChars:1000, parseTimeoutMs:10000, parseConcurrency:2, parseQueue:8});
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clean = value => String(value ?? '').replace(/\r\n?/g,'\n').normalize('NFC');
const fingerprint = value => sha(JSON.stringify(value));
function fail(code, message) { const e=new Error(message); e.code=code; throw e; }
function limit(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value<0 || value>maximum)
    fail('HWP_RESOURCE_LIMIT', `HWP ${label} limit exceeded (${maximum}).`);
}
const freshCounts = () => ({added:0,removed:0,changed:0,unchanged:0});
function joinBounded(parts, separator='\n\n') {
  const length=parts.reduce((n,x)=>n+x.length,0)+Math.max(0,parts.length-1)*separator.length;
  limit(length,LIMITS.textChars*2,'rendered characters');return parts.join(separator);
}

function diagnosticCollector() {
  const diagnostics=[]; let total=0;
  return {diagnostics, add(code, location, message, details) {
    total++;
    if(diagnostics.length<LIMITS.diagnostics) diagnostics.push({code,location,message,...(details?{details}:{})});
  }, get total(){return total;}};
}

// No copies of raw records or binary payloads are returned to callers.
function scanRecords(bytes, location) {
  const records=[]; let offset=0;
  while(offset<bytes.length) {
    if(bytes.length-offset<4) {
      if(bytes.subarray(offset).some(x=>x!==0)) fail('HWP_INVALID_RECORD',`${location}: nonzero trailing record bytes.`);
      break;
    }
    const header=bytes.readUInt32LE(offset); offset+=4;
    let size=header>>>20;
    if(size===0xfff) {
      if(bytes.length-offset<4) fail('HWP_INVALID_RECORD',`${location}: truncated extended record header.`);
      size=bytes.readUInt32LE(offset); offset+=4;
    }
    if(size>bytes.length-offset) fail('HWP_INVALID_RECORD',`${location}: truncated record data.`);
    const level=(header>>>10)&0x3ff;
    limit(level,LIMITS.depth,'record nesting');
    records.push({tag:header&0x3ff,level,data:bytes.subarray(offset,offset+size)});
    offset+=size; limit(records.length,LIMITS.records,'records');
  }
  return records;
}

function decodeParagraphText(data,location,audit) {
  let text='',parserText='';
  if(data.length%2) audit.add('ODD_TEXT_RECORD_LENGTH',location,'UTF-16 문단 텍스트의 마지막 바이트가 불완전합니다.');
  for(let pos=0;pos+1<data.length;) {
    const code=data.readUInt16LE(pos);
    if(code===13) {
      if(data.subarray(pos+2).some(x=>x!==0)) audit.add('TEXT_AFTER_PARAGRAPH_END',location,'문단 종료 뒤에 해석되지 않은 데이터가 있습니다.');
      break;
    }
    if(code===9 || (code>=1&&code<=8) || code===11 || code===12 || (code>=14&&code<=23)) {
      if(pos+16>data.length) audit.add('SHORT_INLINE_CONTROL',location,'인라인 제어문자가 필요한 길이보다 짧습니다.');
      if(code===9){text+='\t';parserText+='\t';}pos+=16;continue;
    }
    if(code===0){pos+=2;continue;}
    if(code===10){text+='\n';parserText+='\n';}
    // Hancom HWP5 table6: 24=hyphen, 30=nonbreaking space,31=fixedspace.
    // hwpxjs 0.4.0 swaps 24/30. Preserve visible text from raw records.
    else if(code===24){text+='-';parserText+=' ';}
    else if(code===30){text+='\u00a0';parserText+='-';}
    else if(code===31){text+=' ';parserText+=' ';}
    else if(code<32){
      audit.add('UNSUPPORTED_INLINE_CONTROL',location,'예약 인라인 제어문자를 해석하지 못했습니다.',{code});
      if(code===25)parserText+=' ';
    } else {text+=String.fromCharCode(code);parserText+=String.fromCharCode(code);}
    pos+=2;
  }
  return {text,parserText};
}

function auditOriginalBytes(input) {
  if(!(input instanceof Uint8Array)) fail('HWP_INVALID_INPUT','HWP input must be bytes.');
  limit(input.byteLength,LIMITS.inputBytes,'input bytes');
  const bytes=Buffer.from(input.buffer,input.byteOffset,input.byteLength);
  if(bytes.length<8 || bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')
    fail('HWP_INVALID_INPUT','HWP 5.0 compound-file signature required.');
  // cfb is pinned alongside the HWP parser; neither parser opens external links.
  const CFB=require('cfb');
  const container=CFB.read(bytes,{type:'buffer'});
  limit(container.FileIndex.length,LIMITS.streams,'streams');
  const streams=container.FileIndex.map((entry,i)=>({entry,path:container.FullPaths[i]})).filter(x=>x.entry.type===2);
  const header=streams.find(x=>/(?:^|\/)FileHeader$/.test(x.path));
  if(!header || header.entry.content.length<256) fail('HWP_INVALID_INPUT','Missing or short HWP FileHeader.');
  const flags=Buffer.from(header.entry.content).readUInt32LE(36);
  if(flags&(2|4|16|256)) fail('HWP_UNSUPPORTED_DOCUMENT','Encrypted, distribution or DRM HWP is unsupported.');
  const audit=diagnosticCollector();
  if(flags&(1<<14)) audit.add('TRACKED_DOCUMENT_FLAG','document','원문에 변경 추적 문서 플래그가 설정되어 있습니다.');
  const result={sectionIndexes:[],paragraphs:0,controls:0,tables:0,pictures:0,
    records:0,binaryStreams:[],diagnostics:audit.diagnostics,rawObjects:[],metadata:[],textParagraphs:[],declaredSections:null};
  let expanded=0;
  let rawTextChars=0;
  const paragraphShapes=[],numberingRecords=[];
  for(const {entry,path} of streams) {
    let data=Buffer.from(entry.content);
    limit(data.length,LIMITS.streamBytes,'stream bytes');
    const section=/(?:^|\/)BodyText\/Section(\d+)$/.exec(path);
    if(/(?:^|\/)ViewText\/Section\d+$/.test(path)) audit.add('VIEW_TEXT_PRESENT','document','본문과 별도로 ViewText 표시용 섹션이 있어 해당 표시 상태는 비교 범위에 포함되지 않습니다.');
    const binary=/(?:^|\/)BinData\/BIN([a-f\d]{4})\.([^/]+)$/i.exec(path);
    const docInfo=/(?:^|\/)DocInfo$/.test(path);
    if((section||docInfo) && (flags&1)) {
      data=zlib.inflateRawSync(data,{maxOutputLength:LIMITS.streamBytes});
    } else if(binary && data.length) {
      try { data=zlib.inflateRawSync(data,{maxOutputLength:LIMITS.streamBytes}); }
      catch(e) { if(e.code==='ERR_BUFFER_TOO_LARGE') fail('HWP_RESOURCE_LIMIT','HWP binary inflation exceeds limit.'); }
    }
    expanded+=data.length; limit(expanded,LIMITS.expandedBytes,'expanded bytes');
    if(binary) result.binaryStreams.push({storageId:parseInt(binary[1],16),extension:binary[2].toLowerCase(),sha256:sha(data),bytes:data.length});
    if(!section && !docInfo) continue;
    const location=section?`section:${Number(section[1])}`:'docInfo';
    const records=scanRecords(data,location);
    result.records+=records.length; limit(result.records,LIMITS.records,'total records');
    if(!section) {
      // Hancom HWP5 revision1.3: tag32 is tracking state/password configuration;
      // its mere existence does not prove revisions in the document. Tags96/97
      // contain actual revision/reviewer data. Keep config as metadata only.
      // https://forum.developer.hancom.com/t/hwp-binary-format/1963
      for(const [i,r] of records.entries()) {
        if(r.tag===16 && r.data.length>=2)result.declaredSections=r.data.readUInt16LE(0);
        if(r.tag===25) paragraphShapes.push({property:r.data.length>=4?r.data.readUInt32LE(0):0,sha256:sha(r.data)});
        if([23,24].includes(r.tag))numberingRecords.push({tag:r.tag,sha256:sha(r.data)});
        if(r.tag===32) result.metadata.push({kind:'trackingConfiguration',location:`docInfo/record:${i}`,sha256:sha(r.data),bytes:r.data.length});
        if([96,97].includes(r.tag) && r.data.length) audit.add('TRACKED_CHANGES_PRESENT',location,'문서에 변경 내용 또는 검토자 레코드가 있어 변경 표시 상태의 별도 확인이 필요합니다.',{tag:r.tag});
      }
      continue;
    }
    result.sectionIndexes.push(Number(section[1]));
    limit(result.sectionIndexes.length,LIMITS.sections,'sections');
    if(!records.length) audit.add('EMPTY_BINARY_SECTION',location,'원문 섹션에 파싱할 레코드가 없습니다.');
    const paragraphStack=[];
    for(let i=0;i<records.length;i++) {
      const r=records[i];
      while(paragraphStack.length && paragraphStack.at(-1).level>=r.level)paragraphStack.pop();
      if(r.tag===66) {
        result.paragraphs++;
        const paragraph={level:r.level,location:`${location}/record:${i}`,text:'',parserText:'',textRecords:0,charCount:r.data.length>=4?r.data.readUInt32LE(0)&0x7fffffff:0,paraShapeId:r.data.length>=10?r.data.readUInt16LE(8):0};
        paragraphStack.push(paragraph);result.textParagraphs.push(paragraph);
        if(r.data.length<22) audit.add('SHORT_PARAGRAPH_HEADER',paragraph.location,'문단 헤더의 필수 정보가 누락되었습니다.');
      }
      if(r.tag===67) {
        const paragraph=paragraphStack.at(-1),loc=`${location}/record:${i}`;
        const decoded=decodeParagraphText(r.data,loc,audit);
        rawTextChars+=decoded.text.length;limit(rawTextChars,LIMITS.textChars,'raw text characters');
        if(!paragraph || paragraph.level!==r.level-1) audit.add('ORPHAN_TEXT_RECORD',loc,'본문 문단에 연결되지 않은 텍스트 레코드가 있습니다.');
        else {
          paragraph.textRecords++;
          if(paragraph.textRecords>1) audit.add('MULTIPLE_PARAGRAPH_TEXT_RECORDS',loc,'한 문단의 여러 텍스트 레코드 중 일부를 파서가 덮어씁니다.');
          paragraph.text=decoded.text;paragraph.parserText=decoded.parserText;
        }
      }
      // Hancom's documented PARA_HEADER ends in a tracked-merge uint16 at22.
      // https://tech.hancom.com/python-hwp-parsing-2/
      if(r.tag===66 && r.data.length>=24 && r.data.readUInt16LE(22)!==0) audit.add('TRACKED_PARAGRAPH_MERGE',`${location}/record:${i}`,'문단에 변경 추적 병합 표시가 있습니다.');
      if(r.tag===70 && r.data.length) audit.add('UNPARSED_RANGE_TAG',`${location}/record:${i}`,'문단 영역 태그의 표시 의미를 현재 파서에서 복원하지 못했습니다.');
      if(r.tag===71) result.controls++;
      if(r.tag===77) result.tables++;
      if(r.tag===85) result.pictures++;
      // Unknown content-bearing records and composite objects cannot be fully
      // represented by this parser. Preserve a byte fingerprint and flag them.
      if([84,86,90,91,92,93,95].includes(r.tag) || r.tag>95 || r.tag<66) {
        const loc=`${location}/record:${i}`;
        audit.add('UNSUPPORTED_RECORD',loc,'해당 원문 개체는 바이너리 변경만 확인하며 내용 해석은 지원하지 않습니다.',{tag:r.tag});
        if(result.rawObjects.length<LIMITS.controls) result.rawObjects.push({kind:'raw-record',location:loc,tag:r.tag,sha256:sha(r.data),bytes:r.data.length});
      }
      // Table captions are discarded before TABLE by hwpxjs 0.4.0.
      if(r.tag===71 && r.data.length>=4 && r.data.readUInt32LE(0)===0x74626c20) {
        let tableSeen=false;
        for(let j=i+1;j<records.length && records[j].level>r.level;j++) {
          const child=records[j];
          if(child.level!==r.level+1) continue;
          if(child.tag===77) tableSeen=true;
          if(child.tag===72 && !tableSeen)
            audit.add('TABLE_CAPTION_UNPARSED',`${location}/record:${j}`,'표 캡션 레코드는 현재 파서에서 본문으로 복원되지 않았습니다.');
          if(child.tag===72 && tableSeen) {
            if(child.data.length<16) audit.add('SHORT_CELL_METADATA',`${location}/record:${j}`,'셀 좌표·병합 정보가 누락되어 파서가 기본값으로 대체했습니다.');
            else if(child.data.readUInt16LE(12)===0 || child.data.readUInt16LE(14)===0) audit.add('ZERO_CELL_SPAN',`${location}/record:${j}`,'셀 병합 크기가 0이어서 파서가 기본값으로 대체했습니다.');
          }
        }
      }
    }
  }
  result.sectionIndexes.sort((a,b)=>a-b);
  if(result.declaredSections!==null && result.declaredSections!==result.sectionIndexes.length) audit.add('DECLARED_SECTION_COUNT_MISMATCH','document','문서 정보에 선언된 섹션 수와 실제 본문 스트림 수가 일치하지 않습니다.',{declared:result.declaredSections,actual:result.sectionIndexes.length});
  // charCount includes the paragraph terminator. A count of1 without PARA_TEXT
  // is an ordinary empty paragraph, found in official Hancom-generated files.
  for(const p of result.textParagraphs) if(p.charCount>1 && !p.textRecords) audit.add('MISSING_PARAGRAPH_TEXT',p.location,'문단에 내용 글자 수는 있으나 텍스트 레코드가 없습니다.');
  for(const p of result.textParagraphs) {
    const shape=paragraphShapes[p.paraShapeId];
    if(shape && ((shape.property>>>23)&3)!==0) {
      audit.add('AUTOMATIC_NUMBERING_UNRENDERED',p.location,'자동 개요·문단 번호·글머리표의 실제 표시 번호는 현재 파서에서 복원하지 못했습니다.');
      if(result.rawObjects.length<LIMITS.controls)result.rawObjects.push({kind:'automatic-numbering',location:p.location,sha256:fingerprint([shape,numberingRecords])});
    }
  }
  const binaryIds=new Set();
  for(const b of result.binaryStreams) {
    if(binaryIds.has(b.storageId))audit.add('DUPLICATE_BINARY_STORAGE_ID','document','원문 바이너리 스트림의 저장 식별자가 중복됩니다.');
    binaryIds.add(b.storageId);
  }
  if(result.sectionIndexes.some((n,i)=>n!==i)) audit.add('SECTION_SEQUENCE_GAP','document','원문 섹션 번호에 공백이 있어 파서가 일부 섹션을 건너뛸 수 있습니다.');
  result.diagnosticsTotal=audit.total;
  return result;
}

/** Build serializable, bounded evidence from the public hwpxjs IR. */
function buildOriginalEvidence(document, options={}) {
  // Accept optional original bytes for synthetic adapters without leaking them.
  if(options instanceof Uint8Array) options={sourceBytes:options};
  const audit=diagnosticCollector();
  const raw=options.rawAudit;
  if(raw) for(const d of raw.diagnostics||[]) audit.add(d.code,d.location,d.message,d.details);
  const tables=[],images=[],objects=[],paragraphs=[];
  const counts={sections:0,paragraphs:0,controls:0,tables:0,cells:0,mergedCells:0,images:0,textChars:0};
  const usedImages=new Set(), groupOrdinals=new Map();
  const sections=Array.isArray(document?.sections)?document.sections:[];
  limit(sections.length,LIMITS.sections,'sections'); counts.sections=sections.length;
  if(!sections.length) audit.add('NO_SECTIONS','document','파싱된 본문 섹션이 없습니다.');
  const assets=document?.binData instanceof Map?document.binData:new Map();
  limit(assets.size,LIMITS.controls,'binary assets');
  limit(document?.docInfo?.binData?.length||0,LIMITS.controls,'binary references');
  let imageBytes=0;
  for(const value of assets.values()) {imageBytes+=value?.data?.byteLength||0;limit(imageBytes,LIMITS.expandedBytes,'image bytes');}
  let group='body', appendix=null, currentArticle=null;
  const nextKey=(kind,context)=>{
    const base=`${context.group}/${kind}`;
    const n=(groupOrdinals.get(base)||0)+1;groupOrdinals.set(base,n);
    return `${base}:${n}`;
  };
  const textValue=value=>{
    const text=clean(value); counts.textChars+=text.length;
    limit(counts.textChars,LIMITS.textChars,'text characters');return text;
  };
  function walkParagraphs(list,context,depth) {
    limit(depth,LIMITS.depth,'IR nesting');
    if(!Array.isArray(list)) {audit.add('MISSING_PARAGRAPHS',context.location,'문단 배열을 추출하지 못했습니다.');return '';}
    const blocks=[];
    for(let index=0;index<list.length;index++) {
      counts.paragraphs++;limit(counts.paragraphs,LIMITS.paragraphs,'paragraphs');
      const p=list[index]||{}, location=`${context.location}/p:${index}`;
      const text=textValue(p.text??(Array.isArray(p.runs)?p.runs.map(r=>r.text||'').join(''):''));
      const out=[];
      if(text) out.push(text);
      paragraphs.push({location,group:context.group,appendix:context.appendix,textHash:sha(text)});
      if(p.controls!==undefined && !Array.isArray(p.controls)) audit.add('INVALID_CONTROLS',location,'문단 개체 목록을 해석하지 못했습니다.');
      for(const control of Array.isArray(p.controls)?p.controls:[]) {
        counts.controls++;limit(counts.controls,LIMITS.controls,'controls');
        const c=control||{}, key=nextKey(c.kind||'unknown',context);
        const common={key,location,group:context.group,appendix:context.appendix||null};
        if(c.kind==='table') {
          counts.tables++;const cells=[];
          const rows=c.rowCount,cols=c.colCount;
          const validDimensions=Number.isSafeInteger(rows)&&rows>0&&Number.isSafeInteger(cols)&&cols>0;
          if(validDimensions) limit(rows*cols,LIMITS.grid,'table grid');
          else audit.add('INVALID_TABLE_DIMENSIONS',key,'표의 행·열 크기를 읽지 못했습니다.');
          const occupied=new Set();
          for(const cell of Array.isArray(c.cells)?c.cells:[]) {
            counts.cells++;limit(counts.cells,LIMITS.cells,'cells');
            const {row,col,rowSpan,colSpan}=cell;
            const valid=[row,col,rowSpan,colSpan].every(Number.isSafeInteger)&&row>=0&&col>=0&&rowSpan>0&&colSpan>0&&validDimensions&&row+rowSpan<=rows&&col+colSpan<=cols;
            if(!valid) audit.add('INVALID_CELL_COORDINATES',key,'셀 좌표나 병합 범위가 표 경계를 벗어나거나 누락되었습니다.');
            if(rowSpan>1||colSpan>1) counts.mergedCells++;
            if(valid) {
              let overlaps=false;
              for(let r=row;r<row+rowSpan;r++)for(let colIndex=col;colIndex<col+colSpan;colIndex++) {
                const slot=r*cols+colIndex;if(occupied.has(slot))overlaps=true;occupied.add(slot);
              }
              if(overlaps) audit.add('OVERLAPPING_CELLS',key,'서로 다른 셀의 병합 범위가 중복됩니다.');
            }
            const value=walkParagraphs(cell.paragraphs,{...context,group:key,location:`${key}/cell:${row},${col}`},depth+1);
            cells.push({row:valid?row:null,col:valid?col:null,rowSpan:valid?rowSpan:null,colSpan:valid?colSpan:null,text:value,textHash:sha(value)});
          }
          cells.sort((a,b)=>(a.row??-1)-(b.row??-1)||(a.col??-1)-(b.col??-1));
          if(!cells.length) audit.add('EMPTY_TABLE',key,'표 개체에 추출된 셀이 없습니다.');
          if(validDimensions && occupied.size!==rows*cols) audit.add('UNCOVERED_TABLE_CELLS',key,'셀 또는 병합 정보가 없는 표 영역이 있습니다.',{expected:rows*cols,covered:occupied.size});
          const table={...common,rows:validDimensions?rows:null,columns:validDimensions?cols:null,cells};
          table.sha256=fingerprint({rows:table.rows,columns:table.columns,cells:cells.map(({row,col,rowSpan,colSpan,textHash})=>({row,col,rowSpan,colSpan,textHash}))});
          tables.push(table);
          // Render each anchor once. Span markers retain information ordinary
          // Markdown tables would otherwise flatten or silently duplicate.
          const lines=['| 행 | 열 | 행 병합 | 열 병합 | 내용 |','| --- | --- | --- | --- | --- |'];
          for(const cell of cells) lines.push(`| ${cell.row===null?'?':cell.row+1} | ${cell.col===null?'?':cell.col+1} | ${cell.rowSpan??'?'} | ${cell.colSpan??'?'} | ${cell.text.replace(/\|/g,'\\|').replace(/\n/g,'<br>')} |`);
          out.push(joinBounded(lines,'\n'));
        } else if(c.kind==='picture') {
          counts.images++;
          // Picture BinItemID is a 1-based DocInfo BIN_DATA reference, not the
          // storageId used as key by loadBinDataContent (HWP5 tables17/107).
          const references=document?.docInfo?.binData||[];
          const ref=references[c.binDataId-1];
          const storageId=ref?.storageId??c.binDataId;
          usedImages.add(storageId);
          const asset=references.length&&(!ref||ref.type==='link')?undefined:assets.get(storageId), data=asset?.data;
          if(!(data instanceof Uint8Array)||!data.length) {
            audit.add('MISSING_IMAGE_BYTES',key,'그림 참조는 있으나 원본 이미지 바이트를 추출하지 못했습니다.');
            images.push({...common,sha256:null,bytes:0,extension:clean(asset?.extension).slice(0,20),status:'missing'});
            out.push('[그림: 원본 바이트 누락]');
          } else {
            const digest=sha(data);
            images.push({...common,sha256:digest,bytes:data.length,extension:clean(asset.extension).toLowerCase().slice(0,20),status:'retrieved'});
            out.push(`[그림 SHA-256: ${digest}]`);
          }
        } else if(['header','footer','footnote'].includes(c.kind)) {
          const value=walkParagraphs(c.paragraphs,{...context,group:key,location:key},depth+1);
          if(!value) audit.add('EMPTY_AUXILIARY_CONTENT',key,'머리말·꼬리말·각주 개체의 내용을 추출하지 못했습니다.');
          objects.push({...common,kind:c.kind,text:value,sha256:sha(value)});
          if(value) out.push(value.split('\n').map(x=>'> '+x).join('\n'));
        } else if(c.kind==='equation') {
          const value=textValue(c.script);
          audit.add('EQUATION_SCRIPT_ONLY',key,'수식은 추출된 스크립트를 비교하며 렌더링 결과는 검증하지 않습니다.');
          objects.push({...common,kind:'equation',text:value,sha256:sha(value)});
          if(value)out.push('```\n'+value+'\n```');
        } else if(c.kind==='field') {
          const value=textValue(c.command);
          objects.push({...common,kind:'field',type:clean(c.ctrlId).slice(0,32),text:value,sha256:fingerprint([c.ctrlId,value])});
          if(!value) audit.add('FIELD_COMMAND_MISSING',key,'필드 명령을 추출하지 못했습니다.');
          // A field command may be a filesystem path or URL, never execute it.
        } else if(c.kind==='unknown' && ['secd','cold','pgnp','pghd','bokm','idxm'].includes(c.ctrlId)) {
          // Known pagination/navigation controls are outside content scope.
        } else {
          const type=clean(c.ctrlId||c.shapeType||c.kind||'unknown').slice(0,32);
          const value=c.kind==='shape'?{type,x1:c.x1??null,y1:c.y1??null,x2:c.x2??null,y2:c.y2??null}:{type};
          objects.push({...common,kind:c.kind||'unknown',type,sha256:fingerprint(value)});
          audit.add('UNSUPPORTED_CONTROL',key,'해당 개체의 전체 내용·모양을 복원하지 못했습니다.',{type});
        }
      }
      blocks.push(joinBounded(out.filter(Boolean)));
    }
    return joinBounded(blocks.filter(Boolean));
  }
  const markdownBlocks=[],bodyBlocks=[];
  const appendixKeys=new Set();
  for(let sectionIndex=0;sectionIndex<sections.length;sectionIndex++) {
    const section=sections[sectionIndex];
    if(!Array.isArray(section?.paragraphs)||!section.paragraphs.length) audit.add('EMPTY_PARSED_SECTION',`section:${sectionIndex}`,'파싱된 섹션이 비어 있습니다. 원문에서 내용 누락 여부를 확인해야 합니다.');
    for(let paragraphIndex=0;paragraphIndex<(section?.paragraphs?.length||0);paragraphIndex++) {
      const p=section.paragraphs[paragraphIndex], text=clean(p.text).trim();
      const heading=appendixHeading(text),boundary=isBodyBoundary(text);
      if(heading) {
        limit(heading.key.length,128,'appendix key characters');
        appendix=heading.key;group=`appendix:${appendix}`;currentArticle=null;
        if(appendixKeys.has(appendix)) audit.add('DUPLICATE_APPENDIX_HEADING',group,'동일한 별표·서식 제목이 반복되어 대응 관계가 불명확합니다.');
        appendixKeys.add(appendix);
        limit(appendixKeys.size,LIMITS.appendices,'appendices');
      } else if(appendix && boundary) {
        audit.add('APPENDIX_BODY_BOUNDARY_AMBIGUOUS',group,'별표·서식 안의 장·조문·부칙일 수 있어 본칙 비교에서 제외했습니다.',{heading:text.slice(0,120)});
      } else if(boundary==='supplementary'||boundary==='chapter') {
        appendix=null;currentArticle=null;group=`body:${text.length>120?text.slice(0,120)+'#'+sha(text).slice(0,16):text}`;
      } else if(boundary==='article') {
        if(appendix) audit.add('APPENDIX_BODY_BOUNDARY_AMBIGUOUS',group,'별표·서식 뒤의 조문은 서식 내부일 수 있어 본칙 비교에서 제외했습니다.',{heading:text.slice(0,120)});
        else {currentArticle=/^제\s*\d+\s*조(?:\s*의\s*\d+)?/.exec(text)?.[0].replace(/\s/g,'')||text;limit(currentArticle.length,128,'article key characters');group=`body:${currentArticle}`;}
      }
      const context={group,appendix,location:`section:${sectionIndex}/paragraph:${paragraphIndex}`};
      let rendered=walkParagraphs([p],context,0);
      if(!appendix && boundary==='article' && rendered) rendered='### '+rendered;
      else if(!appendix && (boundary==='chapter'||boundary==='supplementary') && rendered) rendered='## '+rendered;
      markdownBlocks.push(rendered);if(!appendix)bodyBlocks.push(rendered);
    }
  }
  for(const ref of document?.docInfo?.binData||[]) {
    if(ref.type==='link') audit.add('EXTERNAL_BINARY_LINK','document','외부 연결 그림·첨부 개체의 바이트는 원문에 포함되어 있지 않습니다.');
    else if(!assets.has(ref.storageId)) audit.add('MISSING_BINARY_ASSET','document','문서에 등록된 바이너리 개체를 추출하지 못했습니다.');
  }
  for(const [id,asset] of assets) if(!usedImages.has(id)) {
    audit.add('UNREFERENCED_BINARY_ASSET','document','추출된 바이너리 개체의 본문 위치를 연결하지 못했습니다.');
    if(asset.data instanceof Uint8Array) objects.push({key:`unreferenced:${sha(asset.data)}`,location:'document',group:'unassigned',appendix:null,kind:'binary',sha256:sha(asset.data),bytes:asset.data.length});
  }
  if(raw) {
    for(const [field,actual] of [['paragraphs',counts.paragraphs],['controls',counts.controls],['tables',counts.tables],['pictures',counts.images]]) {
      if(raw[field]!==actual) audit.add('PARSER_RECORD_COUNT_MISMATCH','document','원문 레코드 수와 복원된 개체 수가 일치하지 않습니다.',{kind:field,raw:raw[field],parsed:actual});
    }
    if(raw.sectionIndexes.length!==sections.length) audit.add('PARSER_SECTION_COUNT_MISMATCH','document','원문 섹션 수와 복원된 섹션 수가 일치하지 않습니다.',{raw:raw.sectionIndexes.length,parsed:sections.length});
    for(const entry of raw.rawObjects||[]) objects.push({...entry,key:entry.location,group:'unassigned',appendix:null});
    for(const entry of raw.binaryStreams||[]) if(!assets.has(entry.storageId)) audit.add('BINARY_STREAM_UNPARSED','document','원문 바이너리 스트림이 파서 결과에 없습니다.');
  }
  const markdown=joinBounded(markdownBlocks.filter(Boolean))+'\n';
  const bodyMarkdown=joinBounded(bodyBlocks.filter(Boolean))+'\n';
  if(!markdown.trim()) audit.add('EMPTY_EXTRACTED_CONTENT','document','원문에서 비교 가능한 본문이나 개체를 추출하지 못했습니다.');
  limit(markdown.length,LIMITS.textChars*2,'rendered characters');
  const diagnosticsTotal=audit.total+Math.max(0,(raw?.diagnosticsTotal||0)-(raw?.diagnostics?.length||0));
  const coverage={status:diagnosticsTotal?'partial':'covered',rawAudit:raw?'checked':'not_supplied',counts,diagnostics:audit.diagnostics,diagnosticsTotal,diagnosticsTruncated:diagnosticsTotal>audit.diagnostics.length};
  const structure={schemaVersion:1,scope:'hwp_original_structure',tables,images,objects,coverage,
    metadata:raw?.metadata||[],
    scopeDescription:'HWP 본문 텍스트, 표의 셀 좌표·행열 병합·내용, 내장 이미지 바이트(SHA-256)를 비교합니다. 이미지 OCR·의미 및 시각적 배치·서식은 비교 범위에 포함되지 않습니다.',
    sourceSha256:options.sourceBytes?sha(options.sourceBytes):null};
  return {markdown,bodyMarkdown,structure};
}

async function parseOriginalEvidenceInProcess(buffer) {
  const rawAudit=auditOriginalBytes(buffer);
  const {parseHwp}=await import('@ssabrojs/hwpxjs');
  const document=parseHwp(buffer),paragraphs=[];
  function collect(list,depth=0) {
    limit(depth,LIMITS.depth,'IR nesting');
    for(const p of list||[]) {
      paragraphs.push(p);limit(paragraphs.length,LIMITS.paragraphs,'paragraphs');
      for(const c of p.controls||[]) {
        if(c.kind==='table')for(const cell of c.cells||[])collect(cell.paragraphs,depth+1);
        else if(['header','footer','footnote'].includes(c.kind))collect(c.paragraphs,depth+1);
      }
    }
  }
  for(const section of document.sections)collect(section.paragraphs);
  // Validate the complete raw-to-IR traversal before changing any text. Equal
  // paragraph counts alone do not prove paragraph order or extraction fidelity.
  if(paragraphs.length===rawAudit.textParagraphs.length && paragraphs.every((p,i)=>p.text===rawAudit.textParagraphs[i].parserText)) {
    paragraphs.forEach((p,i)=>{p.text=rawAudit.textParagraphs[i].text;});
  } else {
    const d={code:'RAW_TEXT_ALIGNMENT_MISMATCH',location:'document',message:'원문 텍스트와 파서 문단의 대응이 일치하지 않아 특수문자 복원을 적용하지 못했습니다.'};
    rawAudit.diagnosticsTotal++;
    if(rawAudit.diagnostics.length<LIMITS.diagnostics)rawAudit.diagnostics.push(d);
  }
  return buildOriginalEvidence(document,{sourceBytes:buffer,rawAudit});
}

// The upstream CFB reader allocates before our stream audit runs. A crafted FAT
// can exhaust its heap even for a tiny file, so this boundary must be a process,
// not merely a Promise deadline or a worker sharing the server's address space.
let activeParses=0;
const waitingParses=[];
async function parseOriginalEvidence(buffer) {
  if(!(buffer instanceof Uint8Array))fail('HWP_INVALID_INPUT','HWP input must be bytes.');
  limit(buffer.byteLength,LIMITS.inputBytes,'input bytes');
  if(activeParses>=LIMITS.parseConcurrency) {
    if(waitingParses.length>=LIMITS.parseQueue)fail('HWP_PARSE_BUSY','HWP parser queue is full.');
    await new Promise(resolve=>waitingParses.push(resolve));
  } else activeParses++;
  try {
    return await new Promise((resolve,reject)=>{
      const child=fork(__filename,['--hwp-evidence-worker'],{execArgv:['--max-old-space-size=128'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],env:{NODE_NO_WARNINGS:'1'},windowsHide:true});
      let settled=false;
      const finish=(error,result)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        child.removeAllListeners();child.on('error',()=>{});
        if(child.connected)child.disconnect();child.kill('SIGKILL');
        error?reject(error):resolve(result);
      };
      const parserError=(code,message)=>Object.assign(new Error(message),{code});
      const timer=setTimeout(()=>finish(parserError('HWP_PARSE_TIMEOUT','HWP parsing exceeded its bounded time limit.')),LIMITS.parseTimeoutMs);
      child.once('error',()=>finish(parserError('HWP_PARSE_FAILED','HWP parser process could not complete.')));
      child.once('exit',()=>finish(parserError('HWP_PARSE_FAILED','HWP parser exited before completing within its resource limits.')));
      child.on('message',message=>{
        if(message?.ok===true)finish(null,message.evidence);
        else finish(parserError(message?.code||'HWP_PARSE_FAILED','HWP document could not be parsed within supported format and resource limits.'));
      });
      child.send({bytes:Buffer.from(buffer.buffer,buffer.byteOffset,buffer.byteLength)},error=>{
        if(error)finish(parserError('HWP_PARSE_FAILED','HWP bytes could not be transferred to the parser.'));
      });
    });
  } finally {
    const next=waitingParses.shift();
    if(next)next();else activeParses--;
  }
}

if(require.main===module && process.argv[2]==='--hwp-evidence-worker') {
  process.once('message',async message=>{
    try {const evidence=await parseOriginalEvidenceInProcess(message.bytes);process.send({ok:true,evidence});}
    catch(error){process.send({ok:false,code:/^HWP_[A-Z_]+$/.test(error?.code||'')?error.code:'HWP_PARSE_FAILED'});}
  });
}

function compareOriginalEvidence(before,after,{maxChanges=20,includeAppendices=true}={}) {
  const maximum=Number.isFinite(Number(maxChanges))?Math.max(1,Math.min(LIMITS.changes,Math.floor(Number(maxChanges)))):20;
  const left=before?.structure||before,right=after?.structure||after;
  if(!left?.coverage||!right?.coverage) return {status:'partial',scope:'hwp_original_structure',code:'STRUCTURE_EVIDENCE_MISSING',coverage:{diagnostics:[{code:'STRUCTURE_EVIDENCE_MISSING',message:'구조 정보가 없는 이전 캐시는 다시 조회해야 합니다.'}]}};
  const relevant=x=>includeAppendices||!x.appendix;
  const changedAppendices=new Set();
  let remainingCellDetails=maximum;
  const excerpt=value=>typeof value==='string'?value.slice(0,LIMITS.excerptChars):value;
  const summary=x=>!x?null:{key:x.key,location:x.location,appendix:x.appendix,sha256:x.sha256,...(x.rows!==undefined?{rows:x.rows,columns:x.columns,cells:x.cells.length}:{}),...(x.bytes!==undefined?{bytes:x.bytes}:{}),...(x.status?{status:x.status}:{}),...(x.text!==undefined?{text:excerpt(x.text),textTruncated:x.text.length>LIMITS.excerptChars}:{})};
  function compare(kind) {
    const a=(left[kind]||[]).filter(relevant),b=(right[kind]||[]).filter(relevant);
    const am=new Map(a.map(x=>[x.key,x])),bm=new Map(b.map(x=>[x.key,x]));
    const counts=freshCounts(),changes=[];let changesTotal=0;
    for(const key of new Set([...am.keys(),...bm.keys()])) {
      const old=am.get(key),next=bm.get(key);
      const type=!old?'added':!next?'removed':old.sha256&&next.sha256&&old.sha256===next.sha256?'unchanged':'changed';
      counts[type]++;
      if(type==='unchanged')continue;
      if(old?.appendix)changedAppendices.add(old.appendix);
      if(next?.appendix)changedAppendices.add(next.appendix);
      changesTotal++;
      if(changes.length>=maximum)continue;
      const change={type,key,appendix:next?.appendix??old?.appendix??null,location:next?.location||old?.location,before:summary(old),after:summary(next)};
      if(kind==='tables'&&old&&next) {
        const oldCells=new Map(old.cells.map(x=>[`${x.row},${x.col}`,x]));
        const newCells=new Map(next.cells.map(x=>[`${x.row},${x.col}`,x]));
        const cellChanges=[];let total=0;
        for(const coordinate of new Set([...oldCells.keys(),...newCells.keys()])) {
          const p=oldCells.get(coordinate),q=newCells.get(coordinate);
          if(p&&q&&p.rowSpan===q.rowSpan&&p.colSpan===q.colSpan&&p.textHash===q.textHash)continue;
          total++;
          if(remainingCellDetails>0) {
            remainingCellDetails--;
            const view=x=>x?{row:x.row,col:x.col,rowSpan:x.rowSpan,colSpan:x.colSpan,text:excerpt(x.text),textHash:x.textHash,textTruncated:x.text.length>LIMITS.excerptChars}:null;
            cellChanges.push({coordinate,type:!p?'added':!q?'removed':'changed',mergeChanged:!!p&&!!q&&(p.rowSpan!==q.rowSpan||p.colSpan!==q.colSpan),textChanged:!!p&&!!q&&p.textHash!==q.textHash,before:view(p),after:view(q)});
          }
        }
        change.cellChanges=cellChanges;change.cellChangesTotal=total;change.cellChangesTruncated=total>cellChanges.length;
      }
      changes.push(change);
    }
    return {beforeCount:a.length,afterCount:b.length,counts,changes,changesTotal,changesTruncated:changesTotal>changes.length};
  }
  const tables=compare('tables'),images=compare('images'),objects=compare('objects');
  const coverage={before:left.coverage,after:right.coverage};
  const partial=left.coverage.status!=='covered'||right.coverage.status!=='covered';
  return {status:partial?'partial':'compared',scope:'hwp_original_structure',scopeDescription:left.scopeDescription,
    includeAppendices,coordinateBase:0,tables,images,objects,coverage,
    changedAppendices:[...changedAppendices],
    changesTruncated:[tables,images,objects].some(x=>x.changesTruncated||x.changes.some(c=>c.cellChangesTruncated)),
    sourceHashes:{before:left.sourceSha256,after:right.sourceSha256}};
}

module.exports={parseOriginalEvidence,buildOriginalEvidence,compareOriginalEvidence,auditOriginalBytes,LIMITS};

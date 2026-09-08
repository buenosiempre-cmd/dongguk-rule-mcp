'use strict';
const crypto=require('node:crypto');
const normalize=text=>String(text||'').replace(/\r\n?/g,'\n').split('\n').map(x=>headingText(x).replace(/[ \t]+/g,' ')).filter(Boolean).join('\n');

function headingText(line) {
  // Formatting emitted by HWP converters does not belong to the heading's
  // identity. Keep the original line in the returned evidence text.
  return String(line||'').trim().replace(/^#{1,6}[ \t]*/, '').replace(/\*\*|__/g, '').trim();
}

function isBodyBoundary(line) {
  const text=headingText(line);
  if(/^부[ \t]*칙(?=[ \t(（<〈「\[【]|$)/.test(text)) return 'supplementary';
  if(/^제[ \t]*\d+[ \t]*(?:장|절|관)(?=[ \t(（.:]|$)/.test(text)) return 'chapter';
  if(/^제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?(?=[ \t(（.:]|$)/.test(text)) return 'article';
  return null;
}

function appendixHeading(line) {
  const text=headingText(line).replace(/(\d+)[ \t]*호[ \t]*의[ \t]*(\d+)/g,'$1의$2호');
  const match=/^([<\[〈「(（【]?)[ \t]*(별[ \t]*표|별[ \t]*지(?:[ \t]*서[ \t]*식)?|서[ \t]*식)[ \t]*(?:제[ \t]*)?(\d+(?:[ \t]*(?:의|-)[ \t]*\d+)?)?[ \t]*(?:호)?([ \t]*서[ \t]*식)?[ \t]*([>\]〉」)）】]?)(.*)$/.exec(text);
  if(!match) return null;
  const [,open,rawKind,number,formSuffix,close,remainder]=match;
  const tail=remainder.trim();
  // An ordinary sentence referring to a table is not the table itself, even
  // when a paragraph or converter line break happens to start at "별표".
  if(/^(?:에서(?:는|도)?|에게|으로|에는|와|과|은|는|의|에|를|을|로)(?:\s|따|정|의하|의한|같|기재|기록|기준|명시|제시)/.test(tail) ||
    /^(?:참조|참고)(?:\s|하|한|할|\.|$)/.test(tail)) return null;
  // A numberless appendix must have an explicit enclosure, or stand alone.
  // This avoids treating prose such as "별표 지급기준을 적용한다" as a header.
  if(!number && !(open && close) && tail) return null;
  if(Boolean(open)!==Boolean(close)) return null;
  let kind=rawKind.replace(/\s/g,'');
  if(kind.startsWith('별지') && (kind.includes('서식') || formSuffix)) kind='별지서식';
  return {key:kind+(number?' '+number.replace(/\s/g,''):''),heading:String(line).trim()};
}

function extractAppendices(markdown) {
  const lines=String(markdown||'').replace(/\r\n?/g,'\n').split('\n');
  const found=[];
  for(let i=0;i<lines.length;i++) {
    const heading=appendixHeading(lines[i]);
    if(heading) found.push({...heading,start:i});
  }
  return found.map((item,i)=>{
    let end=found[i+1]?.start??lines.length;
    let boundary=null;
    for(let row=item.start+1;row<end;row++) {
      const kind=isBodyBoundary(lines[row]);
      if(kind) {end=row;boundary={kind,heading:lines[row].trim(),ambiguous:kind==='article' && /별지|서식/.test(item.key)};break;}
    }
    return {...item,boundary,text:lines.slice(item.start,end).join('\n').trim()};
  });
}
function compareAppendices(before,after,{maxChanges=20,maxChars=2000}={}) {
  const left=extractAppendices(before),right=extractAppendices(after);
  const boundaryWarnings=[...left,...right].filter(x=>x.boundary?.ambiguous).map(x=>({appendix:x.key,heading:x.boundary.heading,reason:'서식 내부 조문인지 본칙 재개인지 텍스트만으로 구분할 수 없습니다.'}));
  const keys=[...new Set([...left,...right].map(x=>x.key))];
  const changes=[],ambiguous=[];const counts={added:0,removed:0,changed:0,unchanged:0};
  for(const key of keys) {
    const a=left.filter(x=>x.key===key),b=right.filter(x=>x.key===key);
    if(a.length>1||b.length>1){ambiguous.push(key);continue;}
    const old=a[0]?.text||'',next=b[0]?.text||'';
    const type=!a.length?'added':!b.length?'removed':normalize(old)===normalize(next)?'unchanged':'changed';counts[type]++;
    if(type!=='unchanged') changes.push({appendix:key,type,before:old.slice(0,maxChars),after:next.slice(0,maxChars),truncated:old.length>maxChars||next.length>maxChars,beforeHash:crypto.createHash('sha256').update(normalize(old)).digest('hex'),afterHash:crypto.createHash('sha256').update(normalize(next)).digest('hex')});
  }
  return {status:!keys.length?'not_identified':(!left.length||!right.length||ambiguous.length||boundaryWarnings.length)?'partial':'compared',scope:'hwp_appendix_text',counts,changes:changes.slice(0,maxChanges),changesTruncated:changes.length>maxChanges,ambiguous,boundaryWarnings,beforeCount:left.length,afterCount:right.length,caveat:'HWP에서 추출된 별표·서식의 텍스트 비교입니다. 병합 셀·그림·첨부파일·파서가 추출하지 못한 내용과 법적 적용성은 원문 대조가 필요합니다.'+(boundaryWarnings.length?' 서식 안의 조문일 수 있는 경계에서 추출을 중단했으므로 서식 전체를 원문 대조하세요.':'')};
}
module.exports={extractAppendices,compareAppendices};

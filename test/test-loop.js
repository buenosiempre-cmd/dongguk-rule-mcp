const cheerio = require('cheerio');
const { SEARCH_HTML, CONTENT_HTML, HISTORY_HTML, EMPTY_SEARCH_HTML } = require('./fixtures.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

// ===== 수정된 index.js 파서 로직 (동일 복제) =====
function parseSearch(html, page, pageShow) {
  const $ = cheerio.load(html);
  let total=0;
  const il = $('p.infoLeft').html()||'';
  const tm = il.match(/(\d+)\s*<\/span>\s*건/); if(tm) total=parseInt(tm[1]);
  const hits=[], seen=new Set(); let rawCount=0;
  $('tbody.tbody tr').each(function(){
    const td = $(this).find('td.tbody_txt'); if(!td.length) return;
    const s = td.html()||'';
    const m = /lawSearchFullViewSrv\(\s*'(\d+)'\s*,\s*'(\d+)'/.exec(s); if(!m) return;
    const lawId=parseInt(m[1]), historyId=parseInt(m[2]); rawCount++;
    const k=`${lawId}_${historyId}`; if(seen.has(k)) return; seen.add(k);
    // [수정] &quot; 엔티티도 매칭
    const st=[]; let sm; const re=/showSearchText\(\s*(?:"|&quot;)([^"&]*)(?:"|&quot;)/g;
    while((sm=re.exec(s))!==null) st.push(sm[1]);
    // [수정] span onclick 폴백
    let revisedAt='';
    $(this).find('td.tbody_c').each(function(){
      const src=$(this).html()||''; const span=$(this).find('span').attr('onclick')||'';
      const dm=/showDate\(\s*'(\d{8})'/.exec(src+' '+span);
      if(dm){ const d=dm[1]; revisedAt=`${d.slice(0,4)}.${d.slice(4,6)}.${d.slice(6)}`; }
    });
    hits.push({ lawId, historyId, code:st[0]||'', title:st[1]||'', revisedAt });
  });
  return { total, page, pageShow, hits, rawCount };
}

function parseContent(html) {
  const $ = cheerio.load(html);
  const fb = $('div.fullbody').length ? $('div.fullbody') : $('body');
  const title = fb.find('div.lawname').text().trim();
  const lines = []; if(title) lines.push(`# ${title}`,'');
  fb.find('div').each(function(){
    const cls=($(this).attr('class')||'').split(/\s+/);
    const t=$(this).text().replace(/\s+/g,' ').trim(); if(!t) return;
    if(cls.includes('lawname')) return;
    if(cls.includes('chapter')) lines.push('',`## ${t}`,'');
    else if(cls.includes('section')) lines.push('',`### ${t}`,'');
    else if(cls.includes('article')) lines.push('',`### ${t}`);
    else if(cls.includes('none')) lines.push(t);
    else if(cls.includes('hang')) lines.push(t);
    else if(cls.includes('ho')) lines.push(`  ${t}`);
    else if(cls.includes('mok')) lines.push(`    ${t}`);
  });
  return { title, markdown:lines.join('\n').trim() };
}

function parseHistory(html) {
  const $ = cheerio.load(html);
  const sel = $('#histroySeq'); if(!sel.length) return [];
  const entries = [];
  sel.find('option').each(function(){
    const v=($(this).attr('value')||'').trim();
    if(!v||v==='0'||!/^\d+$/.test(v)) return;
    // [수정] onclick 속성 우선
    let ra=''; const dm=/showDate\(\s*'(\d{8})'/.exec($(this).attr('onclick')||$(this).html()||$(this).text());
    if(dm){const d=dm[1]; ra=`${d.slice(0,4)}.${d.slice(4,6)}.${d.slice(6)}`;}
    entries.push({ historyId:parseInt(v), revisedAt:ra });
  });
  return entries;
}

function filterArticle(md, article) {
  const m=new RegExp(`^### 제${article}조(?=[\\(\\s]|$)`,'m').exec(md);
  if(!m) return null; const s=m.index;
  const em=/^(?:### 제\d+조|## 제\s*\d+\s*장)/m.exec(md.slice(s+m[0].length));
  return md.slice(s,em?s+m[0].length+em.index:md.length).trimEnd();
}
function filterChapter(md, chapter) {
  const m=new RegExp(`^## 제\\s*${chapter}\\s*장`,'m').exec(md);
  if(!m) return null; const s=m.index;
  const em=/^## 제\s*\d+\s*장/m.exec(md.slice(s+m[0].length));
  return md.slice(s,em?s+m[0].length+em.index:md.length).trimEnd();
}
function filterGrep(md, grep) {
  const tk=grep.split(/\s+/).filter(Boolean);
  const pts=md.split(/(?=^### 제\d+조)/m);
  return pts.filter(p=>p.startsWith('### 제')&&tk.every(t=>p.includes(t)));
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔁 dongguk-rule-mcp 루프 검증 (수정 후 재실행)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n[1] search_rule');
const sr = parseSearch(SEARCH_HTML, 1, 10);
check('총 건수 파싱', sr.total === 3, `(got ${sr.total})`);
check('중복 제거 (3행→2건)', sr.hits.length === 2, `(got ${sr.hits.length})`);
check('rawCount=3', sr.rawCount === 3, `(got ${sr.rawCount})`);
check('LAW_ID 추출', sr.hits[0].lawId === 491, `(got ${sr.hits[0].lawId})`);
check('HISTORY_ID 추출', sr.hits[0].historyId === 1437, `(got ${sr.hits[0].historyId})`);
check('분류코드 추출', sr.hits[0].code === '3-2-1', `(got "${sr.hits[0].code}")`);
check('제목 추출', sr.hits[0].title === '재정시행세칙', `(got "${sr.hits[0].title}")`);
check('개정일 변환', sr.hits[0].revisedAt === '2024.03.01', `(got "${sr.hits[0].revisedAt}")`);


console.log('\n[1b] 검색 결과 0건 처리');
const empty = parseSearch(EMPTY_SEARCH_HTML, 1, 10);
check('0건 total 파싱', empty.total === 0, `(got ${empty.total})`);
check('0건 hits 빈 배열', empty.hits.length === 0, `(got ${empty.hits.length})`);

console.log('\n[2] get_rule_content');
const ct = parseContent(CONTENT_HTML);
check('제목 추출', ct.title === '재정시행세칙', `(got "${ct.title}")`);
check('H1 제목', ct.markdown.includes('# 재정시행세칙'));
check('장 → ##', ct.markdown.includes('## 제1장 총칙'));
check('조 → ###', ct.markdown.includes('### 제1조(목적)'));
check('항 본문', ct.markdown.includes('① 이 세칙은 교비회계에 적용한다.'));
check('호 들여쓰기(2칸)', ct.markdown.includes('  1. 인건비'));
check('목 들여쓰기(4칸)', ct.markdown.includes('    가. 일반운영비'));

console.log('\n[2a] --article 48');
const art = filterArticle(ct.markdown, 48);
check('제48조 추출', art !== null);
check('제48조만', art && art.includes('제48조(결산)'));
check('제1조 제외', art && !art.includes('제1조'));

console.log('\n[2b] 조문 경계 (제4조 != 제48조)');
check('제4조 → null', filterArticle(ct.markdown, 4) === null);

console.log('\n[2c] --chapter 1');
const ch = filterChapter(ct.markdown, 1);
check('제1장 추출', ch !== null);
check('제1조 포함', ch && ch.includes('제1조(목적)'));
check('제2장 제외', ch && !ch.includes('제2장'));

console.log('\n[2d] --grep "회계"');
const grep = filterGrep(ct.markdown, '회계');
check('"회계" 조문 검색', grep.length > 0, `(${grep.length}건)`);
check('제2조 매칭', grep.some(g => g.includes('제2조')));

console.log('\n[2e] grep AND "예산 인건비"');
const grepAnd = filterGrep(ct.markdown, '예산 인건비');
check('두 토큰 AND', grepAnd.length === 1, `(${grepAnd.length}건)`);

console.log('\n[3] get_rule_toc');
const toc = ct.markdown.split('\n').filter(l => /^#{1,3} /.test(l)).join('\n');
check('장 포함', toc.includes('## 제1장 총칙'));
check('조 포함', toc.includes('### 제1조(목적)'));
check('본문 제외', !toc.includes('교비회계에 적용'));
check('라인 수 7', toc.split('\n').length === 7, `(got ${toc.split('\n').length})`);

console.log('\n[4] list_rule_history');
const hist = parseHistory(HISTORY_HTML);
check('연혁 3건', hist.length === 3, `(got ${hist.length})`);
check('최신 첫번째', hist[0].historyId === 1437, `(got ${hist[0].historyId})`);
check('연혁 개정일', hist[0].revisedAt === '2024.03.01', `(got "${hist[0].revisedAt}")`);
check('과거 연혁', hist[2].historyId === 980, `(got ${hist[2].historyId})`);

console.log('\n[4a] resolve (최신 자동)');
check('최신 자동 선택', hist[0].historyId === 1437);

console.log('\n[5] search_rule_deep');
const deepHits = parseSearch(SEARCH_HTML, 1, 15).hits;
check('검색 단계', deepHits.length === 2);
const deepGrep = filterGrep(parseContent(CONTENT_HTML).markdown, '결산');
check('본문 조문 추출', deepGrep.length === 1);
check('파이프라인 일관성', deepGrep[0].includes('제48조'));

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 결과: ${pass}개 통과 / ${fail}개 실패 (총 ${pass+fail}개)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(fail > 0 ? 1 : 0);

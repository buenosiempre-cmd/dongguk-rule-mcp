const { SEARCH_HTML, CONTENT_HTML, HISTORY_HTML, EMPTY_SEARCH_HTML } = require('./fixtures.js');
const {
  parseSearch,
  parseContent,
  parseHistory,
  searchResultMetrics,
  extractArticleSections,
  extractChapter,
  grepArticleSections,
} = require('../src/parsers.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔁 dongguk-rule-mcp 루프 검증 (수정 후 재실행)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n[1] search_rule');
const sr = parseSearch(SEARCH_HTML, 1, 10);
check('총 건수 파싱', sr.total === 3, `(got ${sr.total})`);
check('중복 제거 (3행→2건)', sr.hits.length === 2, `(got ${sr.hits.length})`);
check('rawCount=3', sr.rawCount === 3, `(got ${sr.rawCount})`);
check('중복 제거 건수=1', sr.duplicateCount === 1, `(got ${sr.duplicateCount})`);
check('고유 결과 건수=2', sr.uniqueCount === 2, `(got ${sr.uniqueCount})`);
const legacyMetrics = searchResultMetrics({ total:3, rawCount:3, hits:sr.hits });
check('구버전 캐시 고유 건수 보정', legacyMetrics.uniqueRows === 2 && legacyMetrics.duplicatesRemoved === 1);
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
const art = extractArticleSections(ct.markdown, 48).text;
check('제48조 추출', art.length > 0);
check('제48조만', art && art.includes('제48조(결산)'));
check('제1조 제외', art && !art.includes('제1조'));

console.log('\n[2b] 조문 경계 (제4조 != 제48조)');
check('제4조 → 빈 결과', extractArticleSections(ct.markdown, 4).text === '');

console.log('\n[2c] 가지조문·부칙 조문');
const extended = `${ct.markdown}\n\n### 제48조의2(추가 결산)\n추가 결산을 실시한다.\n\n부 칙\n\n### 제1조(시행일)\n2024년 3월 1일부터 시행한다.\n\n### 제2조(경과조치)\n종전 규정을 적용한다.`;
check('제48조의2 추출', extractArticleSections(extended, '제48조의2').text.includes('추가 결산'));
check('부칙 제2조 추출', extractArticleSections(extended, '부칙 제2조').text.includes('경과조치'));
check('일반 제1조는 본칙 우선', extractArticleSections(extended, '제1조').text.includes('목적'));

console.log('\n[2d] --chapter 1');
const ch = extractChapter(ct.markdown, 1);
check('제1장 추출', ch.length > 0);
check('제1조 포함', ch && ch.includes('제1조(목적)'));
check('제2장 제외', ch && !ch.includes('제2장'));

console.log('\n[2e] --grep "회계"');
const grep = grepArticleSections(ct.markdown, '회계');
check('"회계" 조문 검색', grep.length > 0, `(${grep.length}건)`);
check('제2조 매칭', grep.some(g => g.content.includes('제2조')));

console.log('\n[2f] grep AND "예산 인건비"');
const grepAnd = grepArticleSections(ct.markdown, '예산 인건비');
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
const deepGrep = grepArticleSections(parseContent(CONTENT_HTML).markdown, '결산');
check('본문 조문 추출', deepGrep.length === 1);
check('파이프라인 일관성', deepGrep[0].content.includes('제48조'));

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 결과: ${pass}개 통과 / ${fail}개 실패 (총 ${pass+fail}개)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(fail > 0 ? 1 : 0);

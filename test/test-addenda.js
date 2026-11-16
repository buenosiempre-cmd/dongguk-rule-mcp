'use strict';
// 부칙(div.addenda) parsing, dated 부칙 selection and question keyword extraction.
const assert = require('node:assert/strict');
const { parseContent, extractArticleSections, supplementarySelector, listArticleBlocks } = require('../src/parsers.js');
const { queryContentTokens } = require('../src/lookup.js');

let passed = 0;
function check(name, callback) { callback(); passed++; console.log(`  ✅ ${name}`); }

// Mirrors rule.dongguk.edu lawFullContent markup (여비규정, 2026-11-09).
const HTML = `<div class="fullbody"><div class="lawname">여 비 규 정</div>
<div class="chapter">제 1 장 총 칙</div>
<div class="JO"><div class="article">제1조(목적)</div><div class="none">이 규정은 여비에 관한 사항을 정한다.</div></div>
<div class="JO"><div class="article">제2조(출장의 구분)</div><div class="none">출장은 국내출장과 국외출장으로 구분한다.</div></div>
<div class="addenda">
  부       칙
</div>
<div class="JO"><div class="article">제1조(시행일)</div><div class="none">이 규정은 1990년 1월 1일부터 시행한다.</div></div>
<div class="JO"><div class="article">제2조(세칙)</div><div class="none">세칙은 따로 정한다.</div></div>
<div class="addenda">부   칙(2005.6.27.개정)</div>
<div class="none">이 개정규정은 2005년 4월 1일부터 시행한다.</div>
<div class="addenda">부    칙(2024.8.27. 개정)</div>
<div class="JO"><div class="article">제1조(시행일)</div><div class="none">이 개정 규정은 2024년 9월 1일부터 시행한다.</div></div>
</div>`;

const { markdown } = parseContent(HTML);

check('부칙 머리글을 제목으로 보존', () => assert.match(markdown, /^## 부칙 \(2024\.8\.27\. 개정\)$/m));
check('본칙 제1조는 부칙 제1조와 섞이지 않음', () => {
  const result = extractArticleSections(markdown, 1);
  assert.equal(result.error, undefined);
  assert.match(result.text, /제1조\(목적\)/);
});
check('부칙 조문은 부칙으로 표시', () => {
  const blocks = listArticleBlocks(markdown).filter(block => block.supplementary);
  assert.deepEqual(blocks.map(block => block.canonical), ['제1조', '제2조', '제1조']);
});
check('여러 부칙의 같은 번호는 모호 처리', () => assert.equal(extractArticleSections(markdown, '부칙 제1조').error, 'AMBIGUOUS_ARTICLE'));
check('하나뿐인 부칙 조문은 그대로 조회', () => assert.match(extractArticleSections(markdown, '부칙 제2조').text, /세칙/));
for (const selector of ['부칙(2024.8.27.) 제1조', '부칙 2024-08-27 제1조', '부칙(2024.08.27 개정) 제1조', '부칙 2024년 8월 27일 제1조']) {
  check(`부칙 개정일로 선택: ${selector}`, () => {
    const result = extractArticleSections(markdown, selector);
    assert.equal(result.error, undefined);
    assert.match(result.text, /2024년 9월 1일/);
    assert.equal(result.selector.canonical, '부칙 제1조');
  });
}
check('없는 개정일의 부칙은 빈 결과', () => assert.equal(extractArticleSections(markdown, '부칙(1999.1.1.) 제1조').text, ''));
check('날짜 있는 부칙만 선택자 제안', () => {
  const sections = extractArticleSections(markdown, '부칙 제1조').sections;
  assert.deepEqual(sections.map(supplementarySelector), [null, '부칙(2024.8.27.) 제1조']);
});
check('인용 검증 기준인 본칙 제2조가 하나뿐', () => {
  const body = listArticleBlocks(markdown).filter(block => !block.supplementary && block.number === 2);
  assert.equal(body.length, 1);
});

check('질문의 조사·물음표 제거', () => assert.deepEqual(queryContentTokens('교원 연구년 신청 자격은?'), ['교원', '연구년', '신청', '자격']));
check('질문 상투어 제거', () => assert.deepEqual(queryContentTokens('휴가 일수는 얼마인가요'), ['휴가', '일수']));
check('세 글자 ~가 명사는 보존', () => assert.deepEqual(queryContentTokens('전문가 자문료'), ['전문가', '자문료']));
check('최대 4개, 긴 단어 우선·질문 순서 유지', () => assert.deepEqual(queryContentTokens('국내 출장 숙박비 상한 금액 기준'), ['국내', '출장', '숙박비', '상한']));

console.log(`📊 부칙·질문 검색어 회귀 검증: ${passed}개 통과`);

const {
  clampNumber,
  searchVariants,
  rankRuleHits,
  termTokens,
  extractRelevantBlocks,
} = require('../src/lookup.js');

let pass = 0, fail = 0;
function check(name, cond, detail='') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

const ORIGINAL_MARKDOWN = `
**여 비 규 정**

제6조(운임의 구분) 운임은 철도운임, 선박운임, 버스운임, 항공운임으로 구분한다.

제9조(일비 등의 지급) 일비와 숙박비는 국내 여비지급 구분표에 따라 지급한다.

< 별 표 1 > 국내 여비지급 구분표

| 구분 | 철도 | 일비 | 숙박비 |
| --- | --- | --- | --- |
| 교원·팀장 | 1등급 | 20,000원 | 120,000원 |
| 팀원·기타 교직원 | 2등급 | 20,000원 | 120,000원 |

① 운임은 지급 기준에 따라 실비로 정산한다.

② 예외 지급은 별도의 증빙을 첨부한다.

③ 국외 출장 구분은 별표 2 참조.

< 별 표 2 > 국외 여비지급 구분표

| 구분 | 일비 | 숙박비 |
| --- | --- | --- |
| A등급 국가 | 45달러 | 220달러 |

부칙 이 규정은 2025년 4월 29일부터 시행한다.
`.trim();

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔎 통합 조회 로직 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n[1] 범위 제한');
check('기본값', clampNumber(undefined, 6, 1, 12) === 6);
check('최댓값 제한', clampNumber(99, 6, 1, 12) === 12);
check('최솟값 제한', clampNumber(-1, 6, 1, 12) === 1);

console.log('\n[2] 규정 후보 순위');
const ranked = rankRuleHits([
  { title:'국외출장규정', lawId:2, revisedAt:'2024.01.01' },
  { title:'여비규정', lawId:1, revisedAt:'2025.04.29' },
], '여비규정');
check('정확한 제목 우선', ranked[0].lawId === 1);
check('띄어쓰기 검색어 정규화', searchVariants('보수 규정').includes('보수규정'));
check('규정 접미사 축약', searchVariants('보수 규정').includes('보수'));

console.log('\n[3] 검색어 확장');
const tokens = termTokens('철도운임, 숙박비, 일비');
check('원래 검색어 유지', tokens.includes('철도운임') && tokens.includes('숙박비'));
check('표 헤더용 검색어 확장', tokens.includes('철도') && tokens.includes('숙박'));

console.log('\n[4] 관련 조문·별표 추출');
const found = extractRelevantBlocks(ORIGINAL_MARKDOWN, '철도운임, 숙박비, 일비', {
  maxBlocks:4,
  maxChars:5000,
});
check('철도운임 조문 포함', found.text.includes('제6조'));
check('별표 제목 포함', found.text.includes('별 표 1'));
check('금액표 포함', found.text.includes('120,000원') && found.text.includes('20,000원'));
check('관련 없는 부칙 제외', !found.text.includes('부칙'));
check('관련어 보고', found.matchedTerms.includes('철도') && found.matchedTerms.includes('일비'));
check('표 뒤 여러 문단의 주석 보존', found.text.includes('② 예외 지급') && found.text.includes('③ 국외 출장'));
const domesticOnly = extractRelevantBlocks(ORIGINAL_MARKDOWN, '국내, 숙박비, 일비', {
  maxBlocks:4,
  maxChars:5000,
});
check('국내 범위 우선', domesticOnly.text.includes('국내 여비지급 구분표'));
check('국외 표 제외', !domesticOnly.text.includes('국외 여비지급 구분표'));
const foreignOnly = extractRelevantBlocks(ORIGINAL_MARKDOWN, '국외 별표 숙박비', { maxBlocks:4 });
check('주석의 국외 참조로 국내표를 반환하지 않음', foreignOnly.text.includes('220달러') && !foreignOnly.text.includes('120,000원'));

console.log('\n[5] 길이 제한·빈 결과');
const clipped = extractRelevantBlocks(ORIGINAL_MARKDOWN.repeat(20), '숙박비', {
  maxBlocks:12,
  maxChars:1000,
});
check('결과 길이 제한', clipped.truncated && clipped.text.length < 1100);
const missing = extractRelevantBlocks(ORIGINAL_MARKDOWN, '등록금', {});
check('일치 없음', missing.text === '' && missing.blockCount === 0);

console.log('\n[6] 자연어 별표 선택과 주석 보존');
const appendixQuery = extractRelevantBlocks(ORIGINAL_MARKDOWN, '여비규정 별표를 보여줘');
check('조사가 붙은 별표 질문으로 두 표 조회', appendixQuery.text.includes('120,000원') && appendixQuery.text.includes('220달러'));
const numberedMarkdown = ORIGINAL_MARKDOWN + '\n\n<별표 10> 열 번째 표\n\n열번째고유내용\n\n<별표 1의2> 가지 표\n\n가지고유내용';
const firstOnly = extractRelevantBlocks(numberedMarkdown, '여비규정 별 표 제1호를 보여줘', { maxBlocks:1 });
check('별표 1 번호 정확 선택', firstOnly.text.includes('120,000원') && !firstOnly.text.includes('220달러') && !firstOnly.text.includes('열번째고유내용') && !firstOnly.text.includes('가지고유내용'));
check('블록 한도 1에서도 주석 전체 보존', firstOnly.text.includes('③ 국외 출장 구분은 별표 2 참조.'));
check('다른 별표 참조가 다음 표를 끌어오지 않음', !firstOnly.text.includes('국외 여비지급 구분표'));
const branchOnly = extractRelevantBlocks(numberedMarkdown, '별표 1의2를 보여줘');
check('가지 별표 선택', branchOnly.text.includes('가지고유내용') && !branchOnly.text.includes('120,000원') && !branchOnly.text.includes('열번째고유내용'));
const spacedBranch = extractRelevantBlocks(numberedMarkdown, '별표 제 1 호 의 2를 보여줘');
check('호의 가지번호 띄어쓰기 정규화', spacedBranch.text.includes('가지고유내용') && !spacedBranch.text.includes('120,000원'));
const mixed = extractRelevantBlocks(ORIGINAL_MARKDOWN, '제9조와 별표1', { maxBlocks:2 });
check('조문과 별표 동시 요청', mixed.text.includes('제9조') && mixed.text.includes('120,000원') && mixed.text.includes('② 예외 지급'));
const noAppendix = extractRelevantBlocks(numberedMarkdown, '여비규정 별표99');
check('없는 번호를 다른 별표로 대체하지 않음', !noAppendix.text.includes('120,000원') && !noAppendix.text.includes('가지고유내용'));
const referenceOnly = extractRelevantBlocks('제1조(지급) 지급액은 별표99에 따른다.', '별표99를 보여줘');
check('본문 참조만 있는 별표는 미확인 표시', referenceOnly.text.includes('제1조') && referenceOnly.missingAppendices.includes('별표99'));
const limitedAppendices = extractRelevantBlocks(ORIGINAL_MARKDOWN, '별표를 보여줘', { maxBlocks:1 });
check('별표 수 한도 초과 표시', limitedAppendices.blocksTruncated && limitedAppendices.omittedBlockCount > 0);
const longAppendix = extractRelevantBlocks('<별표 1>\n\n| 항목 | 기준 |\n|---|---|\n| 합성 | 1 |\n\n' + '주석 내용 '.repeat(400), '별표1', { maxChars:1000 });
check('긴 별표 주석 글자 수 초과 표시', longAppendix.charactersTruncated && longAppendix.truncated);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 통합 조회 검증: ${pass}개 통과 / ${fail}개 실패`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(fail > 0 ? 1 : 0);

const { compareRuleMarkdown, formatVersionComparison } = require('../src/versioning.js');
const { success, failure, serializeOutcome, serializeException } = require('../src/protocol.js');

let pass = 0, fail = 0;
function check(name, condition, detail='') {
  if (condition) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

const BEFORE = `# 규정\n\n## 제1장 총칙\n\n### 제1조(목적)\n종전 목적이다.\n\n### 제2조(기준)\n종전 기준이다.\n\n부 칙\n\n### 제1조(시행일)\n2024년부터 시행한다.`;
const AFTER = `# 규정\n\n## 제1장 총칙\n\n### 제1조(목적)\n새로운 목적이다.\n\n### 제3조(신설)\n새 기준이다.\n\n부 칙\n\n### 제1조(시행일)\n2025년부터 시행한다.`;

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧭 개정 비교·구조화 응답 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n[1] 전체 조문 비교');
const compared = compareRuleMarkdown(BEFORE, AFTER);
check('변경 2건(본칙·부칙)', compared.counts.changed === 2, JSON.stringify(compared.counts));
check('삭제 1건', compared.counts.removed === 1, JSON.stringify(compared.counts));
check('추가 1건', compared.counts.added === 1, JSON.stringify(compared.counts));
check('부칙 구분 유지', compared.changes.some(x => x.key === '부칙 제1조'));
const formatted = formatVersionComparison(compared, { title:'테스트 규정', maxChanges:10 });
check('사람용 요약 생성', formatted.includes('추가: 1건') && formatted.includes('## 제1조 — 변경'));

console.log('\n[2] 특정 조문 비교');
const article = compareRuleMarkdown(BEFORE, AFTER, { article:'제1조' });
check('특정 조문 변경', article.counts.changed === 1);
check('본칙 제1조 선택', article.changes[0].before.includes('종전 목적'));
check('동일 조문명은 변경 플래그 없음', article.changes[0].headingChanged === false);
const supplementary = compareRuleMarkdown(BEFORE, AFTER, { article:'부칙 제1조' });
check('부칙 제1조 선택', supplementary.changes[0].before.includes('2024년'));
const renamed = compareRuleMarkdown('### 제1조(구 목적)\n내용', '### 제1조(새 목적)\n내용', { article:'제1조' });
check('조문명 변경 감지', renamed.changes[0].headingChanged === true);

console.log('\n[3] MCP 구조화 응답');
const ok = serializeOutcome('sample', success('완료', { count:2 }));
check('성공 structuredContent', ok.structuredContent.ok === true && ok.structuredContent.data.count === 2);
const bad = serializeOutcome('sample', failure('INVALID_ARGUMENT', '잘못된 입력'));
check('오류코드 structuredContent', bad.structuredContent.error.code === 'INVALID_ARGUMENT');
check('입력 오류는 전송 오류 아님', bad.isError !== true);
const upstream = serializeException('sample', new Error('HTTP 503: blocked'));
check('503 오류 분류', upstream.structuredContent.error.code === 'UPSTREAM_BLOCKED' && upstream.isError === true);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 개정 비교·구조화 응답: ${pass}개 통과 / ${fail}개 실패`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(fail > 0 ? 1 : 0);

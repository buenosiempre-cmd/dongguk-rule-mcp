'use strict';
const assert = require('node:assert/strict');
const { extractRelevantBlocks } = require('../src/lookup');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`); }
const extract = (text, options = {}, terms = '수당') => extractRelevantBlocks(text, terms, { maxBlocks: 2, order: 'relevance', ...options });
const body = '### 제2조(지급대상)\n교직원에게 수당을 지급한다.\n\n추가 지급대상 본문.\n\n### 제4조(지급액)\n수당 지급액은 별표와 같다.\n\n[별표 1] 수당 산정표\n\n| 수당 | 금액 |\n|---|---|\n| 수당 | 300원 |';
for (const boundary of ['## 부칙', '**부 칙**', '부칙(2026. 1. 1.)']) {
  check(`대표 조문은 본칙에만 적용: ${boundary}`, () => {
    const text = body + `\n\n${boundary}\n\n### 제2조(시행일)\n2026년부터 시행한다.\n\n## 제1장 기타\n\n### 제2조(시행일)\n2027년부터 시행한다.`;
    const r = extract(text, { priorityArticles: ['제2조'] });
    assert(r.text.startsWith('### 제2조(지급대상)'));
    assert(r.text.includes('추가 지급대상 본문'));
    assert(r.text.includes('[별표 1]'));
    assert(!r.text.includes('시행일'));
    assert(!r.matchedTerms.includes('제2조'));
  });
}
check('같은 문단의 부칙 표제도 가산에서 제외', () => {
  const r = extract('## 부칙\n### 제2조(시행일)\n수당 시행일', {priorityArticles:['제2조']}, '없는검색어');
  assert.equal(r.text, '');
});
check('본문 없는 번호·본문 속 번호 언급으로 대체하지 않음', () => {
  const r = extract('### 제8조(참고)\n제2조에 따른다.\n\n## 부칙\n\n### 제2조(시행일)\n시행한다.', {priorityArticles:['제2조']});
  assert.equal(r.text, '');
});
for (const title of ['목적','정의','용어의 정의']) {
  check(`${title} 조문을 우선하지 않고 기존 별표 선택 유지`, () => {
    const text = `### 제1조(${title})\n수당을 정한다.\n\n` + body;
    assert.deepEqual(extract(text,{priorityArticles:['제1조']}), extract(text));
    assert(extract(text,{priorityArticles:['제1조']}).text.includes('[별표 1]'));
  });
}
check('대표 조문 문단이 여러 개여도 한 자리만 쓰고 나머지는 원래 순위', () => {
  const text = body.replace('추가 지급대상 본문.', '수당 수당 수당\n\n수당 수당 수당');
  const r = extract(text,{priorityArticles:['제2조']});
  assert(r.text.includes('제2조(지급대상)'));
  assert(r.text.includes('[별표 1]'));
  assert(!r.text.includes('제4조(지급액)'));
});
check('원문 어휘가 달라도 본칙 대표 조문을 한 자리로 포함', () => {
  const r = extract('### 제5조의2(특례)\n특수 비용을 보전한다.\n\n'+body, {maxBlocks:1,priorityArticles:['제5조의2']});
  assert(r.text.includes('제5조의2(특례)'));
  assert(!r.text.includes('[별표 1]'));
});
check('별표 속 같은 번호 조문에는 가산하지 않음', () => {
  const r = extract('[별표 1]\n\n### 제2조(지급대상)\n예시 조문', {priorityArticles:['제2조']});
  assert.equal(r.text, '');
});
check('대표 조문 삽입으로 마지막 별표가 밀리면 일반 블록 대신 보존', () => {
  const text = '### 제2조(특례)\n별도 비용을 보전한다.\n\n### 제4조(수당 지급 기준)\n수당 지급 기준 수당 지급 기준\n\n[별표 1]\n\n| 수당 | 100원 |\n\n[별표 2]\n\n| 수당 | 200원 |';
  const plain = extract(text, {maxBlocks:3}, '수당 지급 기준');
  const prioritized = extract(text, {maxBlocks:3,priorityArticles:['제2조']}, '수당 지급 기준');
  assert(plain.text.includes('[별표 1]') && plain.text.includes('[별표 2]'));
  assert(prioritized.text.includes('제2조(특례)') && prioritized.text.includes('[별표 1]') && prioritized.text.includes('[별표 2]'));
  assert(!prioritized.text.includes('제4조('));
});
console.log(`📊 대표 조문·부칙 분리 검증: ${passed}개 통과`);

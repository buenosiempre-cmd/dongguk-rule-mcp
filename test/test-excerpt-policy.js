'use strict';
const assert = require('node:assert/strict');
const { excerptPolicy, excerptInputs, articleUnits } = require('../src/excerpt-policy');
const { extractRelevantBlocks } = require('../src/lookup');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`✅ ${name}`); };
const extract = (text, terms = '신청', options = {}) => extractRelevantBlocks(text, terms, { maxBlocks: 2, order: 'relevance', policy: 'article', ...options });
const compact = text => text.replace(/\s/g, '');
const headings = result => [...result.text.matchAll(/^### (제\d+조(?:의\d+)?)/gm)].map(x => x[1]);
const first = '### 제4조(접수)\n① 신청 신청 신청\n② 신청 신청\n③ 제외 대상은 접수하지 않는다.';
const second = '### 제9조(처리)\n신청 처리 담당자는 기록한다.';
const third = '### 제15조(보관)\n신청 기록을 보관한다.';
check('미설정·오타는 legacy, 실험 조합은 각각 구분', () => {
  for (const value of ['', 'legacy', 'ARTICLE', 'unknown']) assert.deepEqual(excerptPolicy(value), { name: 'legacy', article: false, literal: false });
  assert(excerptPolicy('article').article && !excerptPolicy('article').literal);
  assert(excerptPolicy('literal').literal && !excerptPolicy('literal').article);
  assert(excerptPolicy('article-literal').literal && excerptPolicy('article-literal').article);
});
check('문단을 1~4개 빈 줄로 나눠도 선택 조문·횟수·본문은 같다', () => {
  const source = [first, second, third].join('\n\n');
  const expected = extract(source);
  assert.deepEqual(headings(expected), ['제4조', '제9조']);
  for (let n = 1; n <= 4; n++) {
    const changed = source.replace(/\n/g, '\n'.repeat(n));
    const actual = extract(changed);
    assert.deepEqual(headings(actual), headings(expected));
    assert.equal(actual.blockCount, 2);
    assert.equal(actual.omittedBlockCount, expected.omittedBlockCount);
    assert.equal(compact(actual.text), compact(expected.text));
    assert(actual.text.includes('제외 대상'));
  }
});
check('같은 조문의 일치 문단이 여러 자리를 소모하지 않는다', () => {
  const text = [first.replace(/\n/g, '\n\n'), second, third].join('\n\n');
  assert.deepEqual(headings(extract(text)), ['제4조', '제9조']);
  assert.deepEqual(headings(extract(text, '신청', {policy:'legacy'})), ['제4조']);
});
check('동점은 문서 순서로 안정적으로 선택', () => {
  const text = '### 제8조(하나)\n신청.\n\n### 제7조(둘)\n신청.';
  assert.deepEqual(headings(extract(text, '신청', {maxBlocks:1})), ['제8조']);
});
check('줄바꿈으로 시작한 상호 인용이 조문 표제 가산을 받지 않음', () => {
  const source = '### 제8조(먼저)\n신청.\n\n### 제9조(나중)\n신청은 제15조에 따른다.';
  const wrapped = source.replace('신청은 제15조', '신청은\n\n제15조');
  assert.deepEqual(headings(extract(source, '신청', {maxBlocks:1})), headings(extract(wrapped, '신청', {maxBlocks:1})));
});
check('장·부칙·첨부 경계를 조문에 합치지 않는다', () => {
  const text = `${first}\n\n## 제2장 처리\n\n${second}\n\n## 부칙\n\n### 제4조(시행일)\n나중에 시행한다.\n\n[별지 1]\n서식 내용`;
  const units = articleUnits(text);
  assert(units.includes('## 부칙') && units.includes('## 제2장 처리'));
  assert(!units[0].includes('제2장'));
  const result = extract(text, '신청', {priorityArticles:['제4조']});
  assert(!result.text.includes('시행일') && !result.text.includes('서식 내용'));
});
check('명시 조문은 본문 언급보다 우선하고 가지번호를 보존', () => {
  const text = '### 제4조(참조)\n제9조의2에 따른다.\n\n### 제9조의2(특례)\n첫 문단\n\n둘째 문단';
  const result = extract(text, '제9조의2', {maxBlocks:1});
  assert.deepEqual(headings(result), ['제9조의2']);
  assert(result.text.includes('둘째 문단'));
});
check('별표 본체와 후속 주석을 함께 보존하고 없는 별표를 알린다', () => {
  const text = `${first}\n\n[별표 3] 신청 양식\n\n| 항목 | 값 |\n|---|---|\n| 신청 | 2 |\n\n주석 첫째\n\n주석 둘째\n\n## 부칙\n시행일`;
  const result = extract(text, '별표3', {maxBlocks:1});
  assert(result.text.includes('주석 둘째') && !result.text.includes('시행일'));
  assert.deepEqual(extract(text, '별표9').missingAppendices, ['별표9']);
});
check('조문 안 표 때문에 앞뒤 다른 조문이 끌려오지 않는다', () => {
  const text = '### 제3조(다른 내용)\n비밀없는 앞 조문\n\n### 제4조(신청)\n| 신청 | 값 |\n|---|---|\n\n### 제5조(다른 내용)\n뒤 조문';
  assert.deepEqual(headings(extract(text, '신청', {maxBlocks:1})), ['제4조']);
});
check('길이 제한은 유지하고 절단을 표시', () => {
  const result = extract(`${first}\n\n${'추가 내용 '.repeat(600)}`, '신청', {maxChars:1000});
  assert(result.charactersTruncated && result.truncated);
});
check('사전 낱말·사전 기반 우선 조문은 literal 조건에 전파하지 않음', () => {
  for (const mode of ['literal', 'article-literal']) {
    assert.deepEqual(excerptInputs(excerptPolicy(mode), {expandedTerms:'연령 정년 퇴직',literalTerms:'연령',priorityArticles:['제9조']}), {terms:'연령',priorityArticles:[]});
  }
  assert.deepEqual(excerptInputs(excerptPolicy('article'), {expandedTerms:'연령 정년',literalTerms:'연령',priorityArticles:['제9조']}), {terms:'연령 정년',priorityArticles:['제9조']});
});
check('명시 legacy와 알 수 없는 옵션은 기존 경로와 동일', () => {
  delete process.env.DONGGUK_MCP_EXCERPT;
  for (const source of ['', first, [first,second,third].join('\n\n')]) {
    for (const terms of ['', '신청', '제9조', '별표2']) {
      const expected = extractRelevantBlocks(source, terms);
      for (const policy of ['legacy', 'typo']) assert.deepEqual(extractRelevantBlocks(source, terms, {policy}), expected);
    }
  }
});
console.log(`발췌 정책 합성 검증 ${passed}개 통과`);

'use strict';
const assert = require('node:assert/strict');
const { extractRelevantBlocks } = require('../src/lookup');
const opts = { maxBlocks: 1, maxChars: 3000, priorityArticles: ['제11조'], order: 'relevance' };
const article = (n, body) => `### 제${n}조(처리 ${n})\n${body}`;
const source = body => [article(11, body), article(12, '보완 서류를 제출한다.\n\n다만 예외 신청은 제13조에 따른다.'), article(13, '다음 달에 별도 심사한다.')].join('\n\n');
const run = (text, extra = {}) => extractRelevantBlocks(text, '신청', { ...opts, referenceChars: 2000, ...extra });
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('  ✅ ' + name); };
check('선택된 조문이 인용한 본칙 전체와 예외를 한 단계만 덧붙인다', () => {
  const text = source('신청자는 제12조에 따라 보완한다.');
  const baseline = extractRelevantBlocks(text, '신청', opts);
  const actual = run(text);
  assert(actual.text.startsWith(baseline.text.split('\n\n...(블록')[0]));
  assert(actual.text.includes('### 제12조('));
  assert(actual.text.includes('다만 예외 신청은 제13조에 따른다.'));
  assert(!actual.text.includes('### 제13조('));
  assert.deepEqual(actual.referencedArticles, [{ article: '제12조', fromArticles: ['제11조'] }]);
  assert(!actual.wholeBody);
});
check('조의 번호와 항을 읽되 인용 횟수로 본문을 중복하지 않는다', () => {
  const text = article(11, '신청자는 제12조의2제3항에 따라 처리하며 제12조의2에 따른 요건을 지킨다.') + '\n\n' + article('12의2', '하위번호의 요건');
  // Render the canonical heading, rather than a misleading 제12의2조.
  const actual = run(text.replace('제12의2조', '제12조의2'));
  assert.equal(actual.referencedArticles.length, 1);
  assert(actual.text.includes('### 제12조의2('));
});
for (const body of [
  '신청은 「자료실 운영규정」 제12조에 따른다.',
  '신청은 연구관리규정 제12조에 따른다.',
  '신청은 민법 제12조에 따른다.',
  '신청은 같은 법 제12조에 따른다.',
  '신청은 시행령 제12조에 따른다.',
  '신청은 그 지침의 제12조에 따른다.',
  '신청은 부칙 제12조에 따른다.',
  '신청을 처리한다. [제12조에서 제11조로 개정ㆍ이동]',
]) check('외부 또는 개정 참조 제외: ' + body, () => {
  assert(!run(source(body)).referencedArticles);
});
check('부칙 및 별지 속 같은 번호를 본칙으로 따라가지 않는다', () => {
  for (const boundary of ['## 부칙', '[별지 1]']) {
    const actual = run(article(11, '신청은 제12조에 따른다.') + '\n\n' + boundary + '\n\n' + article(12, '동일번호의 다른 범위'));
    assert(!actual.referencedArticles);
    assert(!actual.text.includes('동일번호의 다른 범위'));
  }
});
check('앞 문단이 외부 출처나 약칭을 정의하면 뒤의 맨번호를 따라가지 않는다', () => {
  for (const intro of ['「별도 관리지침」을 준용한다.', '국가법 제21조를 준용한다.', '별도 관리기준(이하 “기준”)을 적용한다.']) {
    assert(!run(source(intro + '\n\n신청은 제12조에 따른다.')).referencedArticles);
  }
});
check('없는 번호와 중복 본칙 번호를 임의로 해석하지 않는다', () => {
  assert(!run(source('신청은 제99조에 따른다.')).referencedArticles);
  const duplicate = source('신청은 제12조에 따른다.') + '\n\n' + article(12, '같은 번호의 두 번째 조문');
  assert(!run(duplicate).referencedArticles);
});
check('기존 발췌에 들어간 조문을 다시 덧붙이지 않는다', () => {
  const actual = run(source('신청은 제12조에 따른다.'), { maxBlocks: 2, priorityArticles: ['제11조', '제12조'] });
  assert.equal((actual.text.match(/### 제12조\(/g) || []).length, 1);
});
check('문자 한도 및 보충 한도에 맞지 않으면 기존 결과를 그대로 보존한다', () => {
  const text = article(11, '신청은 제12조에 따른다.') + '\n\n' + article(12, '상세 절차 '.repeat(200));
  for (const extra of [{ referenceChars: 100 }, { maxChars: 1000 }]) {
    assert.deepEqual(run(text, extra), extractRelevantBlocks(text, '신청', { ...opts, ...extra, referenceChars: 0 }));
  }
  assert(run(text).text.length <= 3000);
});
check('기존 결과가 이미 문자 한도에서 잘렸으면 보충하지 않는다', () => {
  const text = source('신청은 제12조에 따른다. ' + '상세 절차 '.repeat(300));
  assert.deepEqual(run(text, { maxChars: 1000 }), extractRelevantBlocks(text, '신청', { ...opts, maxChars: 1000 }));
});
check('옵션을 켜지 않은 직접 발췌는 종전 구간 수를 유지한다', () => {
  const actual = extractRelevantBlocks(source('신청은 제12조에 따른다.'), '신청', opts);
  assert(!actual.referencedArticles);
  assert(!actual.text.includes('### 제12조('));
});
console.log(`📊 발췌 인용 조문 검증: ${checks}개 통과`);

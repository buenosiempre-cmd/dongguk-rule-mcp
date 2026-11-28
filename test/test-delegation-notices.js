'use strict';
const assert = require('node:assert/strict');
const { delegationNotices, annotateDelegationExcerpt, delegationSummary, formatDelegationNotices } = require('../src/delegation-notices');
const rule = text => ({ lawId: 543, historyId: 3760, title: '교직원 수당에 관한 규정', excerpt: { text } });
const extract = body => delegationNotices([rule('### 제4조(회의비)\n' + body)]);
let checks = 0;
for (const body of [
  '② 회의비 지급 기준은 예산편성지침으로 따로 정한다.',
  '② 지급 기준은 지침으로 정한다.',
  '② 지급 기준은 「운영세칙」으로 정한다.',
  '② 지급 기준은 총장이 따로 정한다.',
  '② 지급 기준은 별도로 정한다.',
  '1.5억원 이상의 기준은 따로 정한다.',
  '1.05억원 이상 2.5억원 미만의 기준은 따로 정한다.',
  '2026.11.28. 이후의 지급 기준은 따로 정한다.',
  '1. 지급 기준은 따로 정한다.',
  '1.5억원 이상인 경우에만\n지급 기준은 따로 정한다.',
  '원칙은 1.5억원이다. 이를 초과한 경우에만 기준을 따로 정한다.',
  '기준은 따로 정한다.(2026.11.28. 개정)',
]) {
  const notices = extract(body);
  assert.equal(notices.length, 1, body);
  assert.equal(notices[0].article, '제4조');
  assert.equal(notices[0].quote, body, 'Never remove any number or condition');
  checks++;
}
for (const body of [
  '회의비는 1인당 3만원으로 정한다.',
  '회의비 지급 기준은 따로 정하지 않는다.',
  '회의비 지급 기준은 따로 정하지 아니한다.',
  '회의비 지급 기준을 따로 정할 수 있다.',
  '회의비 지급 기준은 따로 정한 바 없다.',
  '회의비 지급 기준은 지침으로 정하지 않는다.',
  '별표에서 정한 기준을 적용한다.',
  '지침으로 정한다는 것은 아니다.',
  '다른 기관에서는 따로 정한다고 한다.',
  '“지급 기준은 따로 정한다.”라는 문구는 삭제한다.',
  '「지급 기준은 따로 정한다.」는 폐지한다.',
  '「\n기준은 따로 정한다.\n」는 폐지한다.',
  '예시: 지급 기준은 따로 정한다.',
  '예시:\n회의비 기준은 따로 정한다.',
  '예시:\n### 제2조(예문)\n기준은 따로 정한다.',
  '운영한다.\n### 별표 1\n표준계약서\n제2조(보수)\n보수는 따로 정한다.',
  '운영한다.\n[별지 1]\n제2조(보수)\n보수는 따로 정한다.',
  '```\n### 제2조(예문)\n기준은 따로 정한다.\n```',
  '> 「예시」\n기준은 따로 정한다.',
  '회의비 지급 기준은 따로 정한다… [잘림]',
  '회의비 지급 기준은 따로 정한다. 다만, 1.5억원 이상인',
  '회의비 지급 기준은 따로 정한',
  '가'.repeat(1000) + '기준은 따로 정한다.',
  '',
]) { assert.deepEqual(extract(body), [], body); checks++; }
const original = rule('### 제4조(회의비) ① 회의비를 지급할 수 있다.\n\n② 회의비 지급 기준은 예산편성지침으로 따로 정한다.\n\n### 제5조(보수)\n보수는 100원이다.');
const saved = JSON.stringify(original), notices = delegationNotices([original]);
assert.equal(JSON.stringify(original), saved);
assert.equal(notices.length, 1); assert.equal(notices[0].paragraph, '②');
const rendered = annotateDelegationExcerpt(original.excerpt.text, notices);
assert(rendered.indexOf('별도 기준 확인') > rendered.indexOf(notices[0].quote));
assert(rendered.indexOf('별도 기준 확인') < rendered.indexOf('### 제5조'));
assert.equal(rendered.replace(/\n\n> \*\*별도 기준 확인[^\n]*/g,''), original.excerpt.text);
checks++;
assert.deepEqual(delegationSummary(notices,{identityStatus:'candidate_preview',requestedArticles:['제4조']}), []);
assert.deepEqual(delegationSummary(notices,{identityStatus:'exact_title',requestedArticles:[]}), []);
assert.deepEqual(delegationSummary(notices,{identityStatus:'explicit_id',requestedArticles:['제5조']}), []);
assert.equal(delegationSummary(notices,{identityStatus:'explicit_id',requestedArticles:['제4조']}).length,1);
assert(formatDelegationNotices(notices).includes('교직원 수당에 관한 규정 제4조'));
assert.equal(formatDelegationNotices([]),''); checks += 6;
assert.deepEqual(delegationNotices([rule('지급 기준은 따로 정한다.')]), []);
assert.equal(extract('지급 기준은 따로 정한다.\n\n### 제5조(기준)\n운영 기준은 따로 정한다.')[1].article,'제5조');
assert.equal(delegationNotices([rule('## 부칙 (2020.1.1.)\n### 제2조(세칙)\n기준은 따로 정한다.')])[0].article,'부칙 (2020.1.1.) 제2조'); checks += 3;
console.log(`delegation notices: ${checks} cases passed`);

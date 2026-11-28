'use strict';
const assert = require('node:assert/strict');
const { delegationNotices, formatDelegationNotices } = require('../src/delegation-notices');
const rule = text => ({ lawId: 543, historyId: 3760, title: '교직원 수당에 관한 규정', excerpt: { text } });
const extract = body => delegationNotices([rule('### 제4조(회의비)\n' + body)]);
let checks = 0;
for (const body of [
  '② 회의비 지급 기준은 예산편성지침으로 따로 정한다.',
  '② 지급 기준은 지침으로 정한다.',
  '② 지급 기준은 「운영세칙」으로 정한다.',
  '② 지급 기준은 총장이 따로 정한다.',
  '② 지급 기준은 별도로 정한다.',
]) {
  const notices = extract(body);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].article, '제4조');
  assert.equal(notices[0].paragraph, '②');
  assert.equal(notices[0].quote, body);
  checks++;
}
for (const body of [
  '회의비는 1인당 3만원으로 정한다.',
  '회의비 지급 기준은 따로 정하지 않는다.',
  '회의비 지급 기준을 따로 정할 수 있다.',
  '회의비 지급 기준은 따로 정한 바 없다.',
  '회의비 지급 기준은 지침으로 정하지 않는다.',
  '별표에서 정한 기준을 적용한다.',
  '지침으로 정한다는 것은 아니다.',
  '다른 기관에서는 따로 정한다고 한다.',
  '“지급 기준은 따로 정한다.”라는 문구는 삭제한다.',
  '「지급 기준은 따로 정한다.」는 예시이다.',
  '예시: 지급 기준은 따로 정한다.',
  '회의비 지급 기준은 따로 정한다… [잘림]',
  '회의비 지급 기준은 따로 정한',
  '',
]) { assert.deepEqual(extract(body), []); checks++; }
const original = rule('### 제4조(회의비) ① 회의비를 지급할 수 있다.\n\n② 회의비 지급 기준은 예산편성지침으로 따로 정한다.\n\n### 제5조(보수)\n보수는 100원이다.');
const saved = JSON.stringify(original);
const notices = delegationNotices([original]);
assert.equal(JSON.stringify(original), saved);
assert.equal(notices.length, 1);
assert.equal(notices[0].paragraph, '②');
assert(formatDelegationNotices(notices).includes('교직원 수당에 관한 규정 제4조②'));
assert.equal(formatDelegationNotices([]), '');
checks++;
// No full-document scan or attribution to the preceding article across an appendix.
assert.deepEqual(delegationNotices([rule('지급 기준은 따로 정한다.')]), []);
assert.deepEqual(extract('회의비를 지급한다.\n\n### 별표 1\n지급 기준은 따로 정한다.'), []);
assert.equal(extract('지급 기준은 따로 정한다.\n\n### 제5조(기준)\n운영 기준은 따로 정한다.')[1].article, '제5조');
assert.equal(delegationNotices([rule('## 부칙 (2020.1.1.)\n### 제2조(세칙)\n기준은 따로 정한다.')])[0].article, '부칙 (2020.1.1.) 제2조');
assert(formatDelegationNotices(Array.from({length: 7}, (_, i) => ({...notices[0], article: '제'+i+'조'}))).includes('그 밖의 1건'));
checks += 5;
console.log(`delegation notices: ${checks} cases passed`);

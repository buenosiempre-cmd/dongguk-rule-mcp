'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { verifyRuleCitations } = require(path.join(root, 'src/citations.js'));
const deps = {
  searchRule: async () => ({ hits: [{ lawId: 1, historyId: 2, title: '검수규정' }] }),
  resolveLatest: async () => ({ historyId: 2, revisedAt: '2026.01.01' }),
  getRuleMarkdown: async () => '### 제1조(목적)\n① 첫항\n② 둘째항\n\n### 제1조의2(특례)\n가지조문\n\n### 제2조(대상)\n대상\n\n### 제3조(준용)\n준용',
};
const inputs = [
  '「검수규정」 제1조 제1항 99호',
  '「검수규정」 제1조 제1항 "가"목',
  '「검수규정」 제1조의2의3',
  '「검수규정」 제1조 제1항의2',
  '「검수규정」 제1조 제1항 제99호',
  '「검수규정」',
  '「검수규정」 제1조에 따라 다목적실을 사용한다.',
  '「검수규정」 제1조의 서식을 따른다.',
  '「검수규정」 제1조 내지 제3조',
  '「검수규정」 제1조~제3조',
];
(async () => {
  const results = [];
  for (const input of inputs) {
    const result = await verifyRuleCitations(input, deps);
    results.push({ input, summary: result.summary, citations: result.citations });
  }
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

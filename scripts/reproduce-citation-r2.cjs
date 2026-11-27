'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || '.');
const { verifyRuleCitations } = require(path.join(root, 'src/citations.js'));
const body = '### 제1조(목적)\n① 첫항\n\n### 제1조의2(특례)\n가지본문\n\n### 제3조(준용)\n본문\n\n## 부칙(2020.1.1.)\n\n### 제1조(시행일)\n시행일';
const deps = {
  searchRule: async () => ({ hits: [{ lawId: 1, historyId: 2, title: '검수규정' }] }),
  resolveLatest: async () => ({ historyId: 2 }),
  getRuleMarkdown: async () => body,
};
const inputs = [];
for (const a of ['', ' ']) for (const b of ['', ' ']) for (const c of ['', ' ']) {
  for (const prefix of ['', '제']) for (const mok of ['가목', '"가"목', "'가'목", '“가”목']) {
    for (const inside of ['', ' ']) {
      inputs.push(`제1조${a}제1항${b}${prefix}${inside}1${inside}호${c}${mok}`);
    }
  }
}
for (const date of ['2099.1.1.', '2020.1.1.']) {
  for (const connector of ['에서 ', ' 중의 ', '에 따른 ', ' 가운데 ', '의 취지를 고려해 ', '을 검토한 후 ']) {
    inputs.push(`부칙(${date})${connector}제1조를 인용한다.`);
  }
}
inputs.push('제1조에 따라 다목적실을 사용한다', '제1조의 서식을 따른다',
  '제1조 제1항에 따라 99호실을 사용한다', '부칙의 취지를 고려해 제3조',
  '부칙 중 적용대상을 검토하여 제3조', '부칙에 따라 시행하며 제3조를 준용한다',
  '부칙(2099.1.1.)을 검토한다. 제3조를 준용한다', '부칙(2020.1.1.)의 제1조',
  '부칙(2099.1.1.)의 제1조', '제1조의 2가지 목적을 본다.', '');
(async () => {
  const rows = [];
  for (const selector of inputs) {
    const input = `「검수규정」 ${selector}`.trimEnd();
    rows.push({ input, ...await verifyRuleCitations(input, deps) });
  }
  const output = JSON.stringify(rows, null, 2) + '\n';
  if (process.argv[3]) fs.writeFileSync(process.argv[3], output);
  else process.stdout.write(output);
})().catch(error => { console.error(error); process.exitCode = 1; });

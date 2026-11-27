'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAppendixFile, collectAppendices, appendixPassages, buildAppendixGraph } = require('../src/appendix-kordoc');
const { buildAppendixIndex, saveAppendixIndex, loadAppendixIndex, searchAppendixIndex } = require('../src/appendix-index');
const source = { lawId: 1, historyId: 2, title: '합성 여비규정', url: 'https://rule.dongguk.edu/example', sha256: 'a'.repeat(64) };
const chunk = (id, text, type = 'text') => ({ id, type, text, blockRange: [Number(id), Number(id)], page: 1 });
const chunks = [chunk('0', '제2조(경과조치) 종전 규정과 같다.\n\n## [별표 1] 국외 기준\n(단위: USD)'),
  chunk('1', '| 구분 | 등급 | 숙박비 |\n| --- | --- | --- |\n| 교원 | A | 123 |\n| 교원 | B | 87 |', 'table'),
  chunk('2', '① 추가 주석\n② 두 번째 주석\n\n[별표 10] 다른 표'),
  chunk('3', '| 구분 | 금액 |\n| --- | --- |\n| 직원 | 42 |', 'table'), chunk('4', '제3조(다시 본칙) 별표에서 제외')];

async function main() {
  const groups = collectAppendices(chunks, source);
  assert.deepEqual(groups.map(g => g.key), ['별표 1', '별표 10']);
  const passages = appendixPassages(groups);
  assert.equal(passages.filter(p => p.type === 'table-row').length, 3);
  const row = passages.find(p => p.rowText?.includes('87'));
  assert(row.text.includes('숙박비') && row.text.includes('교원 | B') && row.text.includes('USD'));
  assert(!row.text.includes('경과조치'));
  assert(passages.some(p => p.text.includes('① 추가 주석\n② 두 번째 주석')));
  assert(!passages.some(p => p.text.includes('다시 본칙')));
  assert.equal(collectAppendices([chunk('0', '별표에서 정한다')], source).length, 0);
  assert.equal(appendixPassages(collectAppendices([...chunks, chunk('5', '[별표 1] 중복')], source)).filter(p => p.appendix === '별표 1').length, 0);
  const form = collectAppendices([chunk('0', '[별지서식 1] 계약서\n제1조(목적) 계약 내용')], source);
  assert(form[0].parts[0].text.includes('계약 내용'));
  assert.equal(appendixPassages(form).length, 0);
  const badTable = collectAppendices([chunk('0', '[별표 1] 복잡표'), chunk('1', '<table><tr><td>원문</td></tr></table>', 'table')], source);
  assert.deepEqual(badTable[0].warnings, ['UNSUPPORTED_TABLE_LAYOUT']);
  assert.equal(appendixPassages(badTable).length, 0);
  const multiHeader = collectAppendices([chunk('0', '[별표 1] 다단 기준'),
    chunk('1', '| 구분 | 운임 |  |\n| --- | --- | --- |\n| 구분 | 철도 | 항공 |\n| 교원 | 1등급 | E |\n| 직원 | 2등급 | " |', 'table')], source);
  const multiRows = appendixPassages(multiHeader);
  assert.equal(multiRows.length, 2);
  assert(multiRows[1].text.includes('| 구분 | 철도 | 항공 |'));
  assert(multiRows[1].rowText.endsWith('| " |'));
  assert.equal(multiRows[1].row, 4);
  assert.throws(() => collectAppendices(chunks, { ...source, sha256: '' }));
  assert.throws(() => collectAppendices([chunk('0', 'x'), chunk('0', 'y')], source));
  const corpus = { rules: [{ lawId: 1, historyId: 2, blocks: [
    { article: '제7조', content: '제7조 별표 1 및 별표 10에 따른다.' },
    { article: '제8조', content: '「다른 규정」 별표 1을 따른다.' },
    { article: '제1조', content: '별표 1 시행일', supplementary: true },
    { article: '제9조', content: '별표 11을 따른다.' }] }] };
  const graph = buildAppendixGraph(groups, corpus);
  assert.equal(graph.edges.filter(e => e.type === 'appendix').length, 2);
  assert(graph.edges.filter(e => e.type === 'appendix').every(e => e.from === 'a:1:0'));
  assert(graph.nodes.some(n => n.kind === 'appendix' && n.text.includes('두 번째 주석')));
  assert.equal(buildAppendixGraph(groups, { rules: [{ ...corpus.rules[0], historyId: 3 }] }).edges.filter(e => e.type === 'appendix').length, 0);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appendix-test-'));
  const file = path.join(directory, 'source.pdf'), output = path.join(directory, 'index.json');
  fs.writeFileSync(file, 'setTimeout(() => {}, 10000)');
  assert.equal((await parseAppendixFile(file, { command: path.join(directory, 'no-such-command') })).status, 'unavailable');
  assert.equal((await parseAppendixFile(file, { command: process.execPath, timeoutMs: 30 })).status, 'failed');
  assert.equal((await parseAppendixFile(file, { execute: async () => ({ stdout: 'not json' }) })).status, 'failed');
  assert.equal((await parseAppendixFile(file, { execute: async () => ({ stdout: '[{}]' }) })).status, 'failed');
  const parsed = await parseAppendixFile(file, { execute: async (command, args, options) => {
    assert(args.includes('--format') && args.includes('chunks') && args.includes('gfm'));
    assert(args.includes('--no-images') && !args.includes('--ocr') && options.timeout > 0);
    return { stdout: JSON.stringify(chunks) };
  } });
  assert.equal(parsed.status, 'parsed');
  assert.equal(parsed.sha256.length, 64);
  const embedder = { model: 'synthetic', embedPassages: async texts => texts.map(t => t.includes('87') ? [1, 0] : [0, 1]) };
  const index = await buildAppendixIndex({ groups, corpus, embedder });
  const options = { model: 'synthetic', catalog: [{ lawId: 1, historyId: 2 }] };
  assert.equal(searchAppendixIndex(index, [1, 0], options)[0].rowText, row.rowText);
  assert.deepEqual(searchAppendixIndex(index, [1, 0], { ...options, catalog: [{ lawId: 1, historyId: 3 }] }), []);
  assert.equal(searchAppendixIndex(index, [1, 0], { ...options, model: 'wrong' }), null);
  assert.equal(searchAppendixIndex(index, [NaN, 0], options), null);
  assert.equal(searchAppendixIndex(index, [0, 0], options), null);
  assert.equal(searchAppendixIndex(index, [1, 0]), null);
  saveAppendixIndex(output, index);
  assert.deepEqual(loadAppendixIndex(output, 'synthetic'), index);
  assert.equal(loadAppendixIndex(output, 'wrong'), null);
  const corrupt = JSON.parse(JSON.stringify(index)); corrupt.passages[0].text += 'tamper';
  assert.equal(searchAppendixIndex(corrupt, [1, 0], options), null);
  fs.writeFileSync(output, JSON.stringify(corrupt));
  assert.equal(loadAppendixIndex(output), null);
  fs.writeFileSync(output, '{'); assert.equal(loadAppendixIndex(output), null);
  await assert.rejects(buildAppendixIndex({ groups, corpus, embedder: { model: 'bad', embedPassages: async () => [] } }));
  // Only files created by this test are removed.
  fs.rmSync(directory, { recursive: true });
  console.log('appendix-kordoc: structure, boundaries, provenance, graph, timeout and fallback checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

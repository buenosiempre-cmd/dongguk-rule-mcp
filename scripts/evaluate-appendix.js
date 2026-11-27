'use strict';

// Fixed public train/dev + new appendix development questions only. No arbitrary
// question-file option, held-out sets or network requests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createEmbedder, articleTexts } = require('../src/semantic');
const { collectAppendices, appendixPassages, gfmRows } = require('../src/appendix-kordoc');
const { buildAppendixIndex, saveAppendixIndex, searchAppendixIndex } = require('../src/appendix-index');
const root = path.join(__dirname, '../experiments/appendix');
const fixtureFile = path.join(root, 'fixtures/travel-3856.json');
const fixture = JSON.parse(fs.readFileSync(fixtureFile));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clean = text => String(text).replace(/<br\s*\/?>/gi, '').replace(/\\([\W])/g, '$1').replace(/\s+/g, '');
const percentile = (numbers, q) => [...numbers].sort((a, b) => a - b)[Math.min(numbers.length - 1, Math.floor(numbers.length * q))];

function reconcile(groups) {
  const differences = []; let anchors = 0, matches = 0, numericCells = 0, replicas = 0, replicaMatches = 0;
  const amounts = {};
  const tables = groups.flatMap(g => g.parts.filter(p => p.type === 'table').map(p => ({ key: g.key, ...gfmRows(p.text) })));
  for (let i = 0; i < fixture.legacyTables.length; i++) {
    const legacy = fixture.legacyTables[i], table = tables[i];
    let oldSum = 0, newSum = 0;
    for (const cell of legacy.cells) {
      anchors++;
      const old = clean(cell.text), next = clean(table?.rows[cell.row]?.[cell.col]);
      if (old === next) matches++; else differences.push({ table: i + 1, row: cell.row + 1, column: cell.col + 1, old, next });
      for (let row = cell.row + 1; row < cell.row + cell.rowSpan; row++) {
        replicas++;
        if (clean(table?.rows[row]?.[cell.col]) === old) replicaMatches++;
        else differences.push({ table: i + 1, row: row + 1, column: cell.col + 1, reason: 'rowspan_replica' });
      }
      if (/^\d[\d,]*(?:원)?$/.test(old)) {
        numericCells++; oldSum += Number(old.replace(/[,원]/g, '')); newSum += Number(next.replace(/[,원]/g, ''));
      }
    }
    amounts[tables[i].key] = { unit: i === 0 ? 'KRW' : i === 1 ? 'USD' : null, oldSum, newSum, difference: newSum - oldSum,
      note: '원본 앵커 셀의 숫자만 합산한 파싱 대사값. 지급 합계가 아님.' };
  }
  return { sourceTables: fixture.legacyTables.length, parsedTables: tables.length, anchors, matches, replicas, replicaMatches, numericCells, amounts, differences };
}

async function main() {
  const output = process.argv[2];
  if (!output || fs.existsSync(output)) throw new Error('새 결과 JSON 경로를 지정하세요. 기존 파일은 덮어쓰지 않습니다.');
  const groups = collectAppendices(fixture.chunks, fixture.source);
  const reconciliation = reconcile(groups);
  const original = fixture.legacyAppendices.flatMap(a => articleTexts(fixture.source.title, a.text).map((text, n) => ({ id: `${a.key}:${n}`, appendix: a.key, text })));
  const corpus = { rules: [{ ...fixture.source, blocks: fixture.bodyBlocks }] };
  const start = performance.now();
  const embedder = await createEmbedder({ directory: root, download: false });
  const loadedMs = performance.now() - start;
  const buildStart = performance.now();
  const index = await buildAppendixIndex({ groups, corpus, embedder });
  const builtMs = performance.now() - buildStart;
  saveAppendixIndex(output + '.index.json', index);
  const vectors = [];
  for (let i = 0; i < original.length; i += 16) vectors.push(...await embedder.embedPassages(original.slice(i, i + 16).map(p => p.text)));
  const sets = ['train', 'dev'].map(set => {
    const file = path.join(__dirname, `../test/fixtures/natural-language-benchmark.${set}.json`);
    const all = JSON.parse(fs.readFileSync(file));
    return { set, file, total: all.length, questions: all.filter(q => q.gt.some(g => g.lawId === 184 && g.articles.some(a => /^별표/.test(a)))) };
  });
  const newFile = path.join(root, 'fixtures/questions.dev.json');
  const questions = [...sets.flatMap(s => s.questions.map(q => ({ ...q, set: s.set,
    expected: q.gt.filter(g => g.lawId === 184).flatMap(g => g.articles.filter(a => /^별표/.test(a))) }))),
    ...JSON.parse(fs.readFileSync(newFile)).map(q => ({ ...q, set: 'new-dev', expected: [q.appendix] }))];
  const results = [];
  for (const q of questions) {
    const begin = performance.now(), query = await embedder.embedQuery(q.q), embeddedMs = performance.now() - begin;
    const oldStart = performance.now();
    const baseline = original.map((p, i) => ({ ...p, score: vectors[i].reduce((sum, n, j) => sum + n * query[j], 0) }))
      .sort((a, b) => b.score - a.score).slice(0, 3);
    const legacyMs = performance.now() - oldStart;
    const nextStart = performance.now();
    const proposed = searchAppendixIndex(index, query, { model: embedder.model, catalog: [fixture.source], top: 3 });
    const proposedMs = performance.now() - nextStart;
    const tableHit = rows => rows.some(p => q.expected.includes(p.appendix));
    const evidenceHit = (rows, structured) => q.terms ? rows.some(p => p.appendix === q.appendix &&
      (!structured || p.row === q.row) && q.terms.every(t => clean(p.text).includes(clean(t)))) : null;
    results.push({ id: q.id, set: q.set, query: q.q, expected: q.expected, row: q.row, terms: q.terms,
      legacy: { tableHit: tableHit(baseline), evidenceHit: evidenceHit(baseline, false), top: baseline },
      kordoc: { tableHit: tableHit(proposed), evidenceHit: evidenceHit(proposed, true), top: proposed.map(({ source, ...p }) => p) },
      time: { embeddedMs, legacyMs, proposedMs } });
  }
  const summary = Object.fromEntries(['train', 'dev', 'new-dev'].map(set => {
    const rows = results.filter(r => r.set === set);
    return [set, { count: rows.length, legacyTableHits: rows.filter(r => r.legacy.tableHit).length,
      kordocTableHits: rows.filter(r => r.kordoc.tableHit).length,
      legacyEvidenceHits: rows.filter(r => r.legacy.evidenceHit).length,
      kordocEvidenceHits: rows.filter(r => r.kordoc.evidenceHit).length,
      newTableFailures: rows.filter(r => r.legacy.tableHit && !r.kordoc.tableHit).map(r => r.id),
      newEvidenceFailures: rows.filter(r => r.legacy.evidenceHit && !r.kordoc.evidenceHit).map(r => r.id) }];
  }));
  const report = { scope: '여비규정 한 개의 별표 후보 안에서 상위 3청크 검색. 규정 선택·답변 생성·MCP 종단 성능 아님.',
    baseline: '기존 좌표 목록을 articleTexts(400자/100자 겹침)로 분할. 별표 미색인 생산 기준선보다 유리한 대조군.',
    evidenceMetric: '새 개발문항: 원문 항목·금액/등급이 한 청크에 함께 존재. kordoc은 정답 행 번호도 일치. 종전은 문자열 공존으로만 채점하여 상한 추정.',
    source: fixture.source, sourceFixtureHash: sha(fixtureFile), model: embedder.model, loadedMs, builtMs,
    node: process.version, codeHashes: Object.fromEntries(['src/appendix-kordoc.js', 'src/appendix-index.js', 'src/semantic.js', 'scripts/evaluate-appendix.js'].map(file => [file, sha(path.join(__dirname, '..', file))])),
    inputCounts: sets.map(s => ({ set: s.set, total: s.total, eligible: s.questions.length, sha256: sha(s.file) })),
    newQuestionsHash: sha(newFile), reconciliation, passages: { legacy: original.length, kordoc: index.passages.length, rows: appendixPassages(groups).filter(p => p.type === 'table-row').length },
    graph: { nodes: index.graph.nodes.length, edges: index.graph.edges.length, articleEdges: index.graph.edges.filter(e => e.type === 'appendix').length },
    summary, timing: Object.fromEntries(['embeddedMs', 'legacyMs', 'proposedMs'].map(key => [key, { median: percentile(results.map(r => r.time[key]), .5), p95: percentile(results.map(r => r.time[key]), .95) }])),
    rssBytes: process.memoryUsage().rss, results };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ summary, reconciliation, timing: report.timing, passages: report.passages, graph: report.graph }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

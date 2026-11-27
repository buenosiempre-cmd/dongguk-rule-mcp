'use strict';

// Candidate-signal experiment, not the production lexical/semantic fusion.
// Policy is fixed: maximum cosine per article/rule, three rules, three evidence
// items per rule. Only the committed train/dev and appendix dev questions enter.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createEmbedder, articleTexts, loadSemanticIndex } = require('../src/semantic');
const { collectAppendices } = require('../src/appendix-kordoc');
const { buildAppendixIndex, searchAppendixIndex, saveAppendixIndex } = require('../src/appendix-index');
const root = path.resolve(__dirname, '..');
const fixture = require('../experiments/appendix/fixtures/travel-3856.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readHash = file => hash(fs.readFileSync(file));
const EXPECTED_CORPUS = '59c2e11fe66e57af1ad2e88d732b12e42233ec1446e9a9d43784754e464dcb15';
const EXPECTED_VECTOR = 'c76feb89f199072fecf644f59f1c880519595276b8ec3af54f7a539388da2f7e';
const BASE_COMMIT = '907b998a095ffbe7c490fdb961dc90b090ddbf5e';
const clean = text => String(text || '').replace(/<br\s*\/?>/gi, '').replace(/\\([\W])/g, '$1').replace(/\s+/g, '');

function alignArticles(index, corpus) {
  const byId = new Map(corpus.rules.map(rule => [rule.lawId, rule]));
  const items = []; let vectorRow = 0;
  for (const entry of index.meta.rules) {
    const rule = byId.get(entry.lawId);
    if (!rule || rule.historyId !== entry.historyId || rule.blocks.length !== entry.blockCount) throw new Error('REVISION_OR_BLOCK_COUNT_MISMATCH');
    for (const [blockIndex, expectedHash, count] of entry.blocks) {
      const block = rule.blocks[blockIndex];
      if (!block || block.supplementary || crypto.createHash('sha1').update(`${rule.title}\n${block.content}`).digest('hex').slice(0, 16) !== expectedHash) throw new Error('ARTICLE_HASH_MISMATCH');
      items.push({ lawId: rule.lawId, historyId: rule.historyId, title: rule.title, article: block.article,
        id: `a:${rule.lawId}:${blockIndex}`, blockIndex, vectorRow, count, type: 'article', text: block.content });
      vectorRow += count;
    }
  }
  if (vectorRow !== index.meta.rows || items.length !== 9790) throw new Error('VECTOR_ALIGNMENT_COUNT_MISMATCH');
  return items;
}

function scoreArticles(items, index, query) {
  const dims = index.meta.dims, vectors = index.vectors;
  return items.map(item => {
    let score = -Infinity;
    for (let row = item.vectorRow; row < item.vectorRow + item.count; row++) {
      let dot = 0;
      for (let col = 0; col < dims; col++) dot += query[col] * vectors[row * dims + col];
      score = Math.max(score, dot);
    }
    return { ...item, score };
  });
}

function selectCandidates(items) {
  const rules = new Map();
  for (const item of items) {
    if (!rules.has(item.lawId)) rules.set(item.lawId, []);
    rules.get(item.lawId).push(item);
  }
  return [...rules].map(([lawId, evidence]) => ({ lawId,
    evidence: evidence.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3) }))
    .sort((a, b) => b.evidence[0].score - a.evidence[0].score || a.lawId - b.lawId).slice(0, 3);
}

function scoreQuestion(question, selected) {
  const top3 = selected.some(rule => question.gt.some(gt => gt.lawId === rule.lawId));
  const strict = selected.some(rule => question.gt.some(gt => gt.lawId === rule.lawId &&
    rule.evidence.some(item => gt.articles.some(article => clean(article) === clean(item.article || item.appendix)))));
  const evidenceHit = question.terms ? selected.some(rule => rule.lawId === 184 && rule.evidence.some(item =>
    item.appendix === question.appendix && (item.type !== 'table-row' || item.row === question.row) &&
    question.terms.every(term => clean(item.text).includes(clean(term))))) : null;
  return { top3, strict, evidenceHit, selected: selected.map(rule => ({ lawId: rule.lawId,
    evidence: rule.evidence.map(({ source, vectorRow, count, ...item }) => item) })) };
}

function summarize(results, condition) {
  const top3 = results.filter(row => row[condition].top3).length;
  const strict = results.filter(row => row[condition].strict).length;
  const labeled = results.filter(row => row[condition].evidenceHit !== null);
  return { questions: results.length, top3, strict, articleGivenTop3: { hits: strict, total: top3 },
    rowEvidence: { hits: labeled.filter(row => row[condition].evidenceHit).length, total: labeled.length } };
}

function compare(results, left, right) {
  return Object.fromEntries(['top3', 'strict', 'evidenceHit'].map(metric => [metric, {
    newWrong: results.filter(row => row[left][metric] === true && row[right][metric] === false).map(row => row.id),
    fixed: results.filter(row => row[left][metric] === false && row[right][metric] === true).map(row => row.id) }]));
}

async function main() {
  const [cache, output] = process.argv.slice(2);
  if (!cache || !output || fs.existsSync(output) || fs.existsSync(output + '.index.json')) throw new Error('NEW_OUTPUT_AND_D1_CACHE_REQUIRED');
  const corpusPath = path.join(cache, 'corpus/corpus-v1.json'), metaPath = path.join(cache, 'semantic/semantic-v1.json');
  if (readHash(corpusPath) !== EXPECTED_CORPUS) throw new Error('D1_CORPUS_MISMATCH');
  const corpus = JSON.parse(fs.readFileSync(corpusPath));
  const index = loadSemanticIndex(cache);
  if (corpus.contentVersion !== 4 || !index || index.meta.textVersion !== 3 || index.meta.rows !== 11422 ||
      index.meta.vectorHash !== EXPECTED_VECTOR || index.meta.model !== 'Xenova/multilingual-e5-small') throw new Error('D1_INDEX_MISMATCH');
  const vectorPath = path.join(cache, 'semantic', index.meta.vectorFile);
  const sourceHashes = Object.fromEntries([corpusPath, metaPath, vectorPath].map(file => [file, readHash(file)]));
  const articles = alignArticles(index, corpus);
  if (!corpus.rules.some(rule => rule.lawId === fixture.source.lawId && rule.historyId === fixture.source.historyId)) throw new Error('APPENDIX_REVISION_MISMATCH');
  const groups = collectAppendices(fixture.chunks, fixture.source);
  const loadStart = performance.now();
  const embedder = await createEmbedder({ directory: path.dirname(output), model: index.meta.model, download: false });
  const modelLoadMs = performance.now() - loadStart;
  const buildStart = performance.now();
  const appendix = await buildAppendixIndex({ groups, corpus, embedder });
  saveAppendixIndex(output + '.index.json', appendix);
  const coordinates = fixture.legacyAppendices.flatMap(a => articleTexts(fixture.source.title, a.text).map((text, n) => ({
    lawId: fixture.source.lawId, historyId: fixture.source.historyId, appendix: a.key,
    id: `coordinate:${a.key}:${n}`, text, type: 'coordinate-chunk' })));
  const coordinateVectors = [];
  for (let i = 0; i < coordinates.length; i += 16) coordinateVectors.push(...await embedder.embedPassages(coordinates.slice(i, i + 16).map(item => item.text)));
  const addedBuildMs = performance.now() - buildStart;
  const files = [], questions = [];
  for (const split of ['train', 'dev', 'new-dev']) {
    const file = path.join(root, split === 'new-dev' ? 'experiments/appendix/fixtures/questions.dev.json' : `test/fixtures/natural-language-benchmark.${split}.json`);
    const rows = JSON.parse(fs.readFileSync(file));
    files.push({ split, file: path.relative(root, file), sha256: readHash(file), count: rows.length });
    questions.push(...rows.map(q => ({ ...q, split, gt: q.gt || [{ lawId: 184, articles: [q.appendix] }] })));
  }
  const results = [];
  for (const question of questions) {
    const start = performance.now(), query = await embedder.embedQuery(question.q), embeddedMs = performance.now() - start;
    const scoreStart = performance.now(), base = scoreArticles(articles, index, query), denseMs = performance.now() - scoreStart;
    const coord = coordinates.map((item, i) => ({ ...item, score: coordinateVectors[i].reduce((sum, n, j) => sum + n * query[j], 0) }));
    const sideStart = performance.now(), side = searchAppendixIndex(appendix, query, { model: embedder.model, catalog: corpus.rules, top: 100 }), sideMs = performance.now() - sideStart;
    results.push({ id: question.id, split: question.split, query: question.q, gt: question.gt,
      row: question.row, terms: question.terms, d1Dense: scoreQuestion(question, selectCandidates(base)),
      d1Coordinates: scoreQuestion(question, selectCandidates([...base, ...coord])),
      d1Kordoc: scoreQuestion(question, selectCandidates([...base, ...side])), timing: { embeddedMs, denseMs, sideMs } });
  }
  for (const [file, expected] of Object.entries(sourceHashes)) if (readHash(file) !== expected) throw new Error('READONLY_SOURCE_CHANGED');
  const conditions = ['d1Dense', 'd1Coordinates', 'd1Kordoc'];
  const summary = Object.fromEntries(['train', 'dev', 'new-dev'].map(split => {
    const rows = results.filter(row => row.split === split);
    return [split, { conditions: Object.fromEntries(conditions.map(name => [name, summarize(rows, name)])),
      deltaVsDense: compare(rows, 'd1Dense', 'd1Kordoc'), deltaVsCoordinates: compare(rows, 'd1Coordinates', 'd1Kordoc') }];
  }));
  const timing = Object.fromEntries(['embeddedMs', 'denseMs', 'sideMs'].map(key => {
    const values = results.map(row => row.timing[key]).sort((a, b) => a - b);
    return [key, { median: values[Math.floor(values.length / 2)], p95: values[Math.ceil(values.length * .95) - 1] }];
  }));
  const report = { scope: 'D1 전체 corpus의 dense 후보 신호 실험. 실제 MCP strict70/71 기준선 및 운영 fusion과 다른 지표.',
    policy: '동일 query vector 1회, 조문별 max cosine, 규정별 max cosine 상위3, 규정별 증거 상위3; 가중치 조정 없음.',
    baselineCommit: BASE_COMMIT, experimentCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    corpusSha256: EXPECTED_CORPUS, textVersion: index.meta.textVersion, vectorFile: index.meta.vectorFile, vectorSha256: EXPECTED_VECTOR,
    sourceHashes, sourceUnchanged: true, codeHashes: Object.fromEntries(['scripts/evaluate-appendix-d1.js', 'src/appendix-kordoc.js', 'src/appendix-index.js', 'src/semantic.js'].map(file => [file, readHash(path.join(root, file))])),
    questionFiles: files, appendixSource: fixture.source, counts: { rules: corpus.rules.length, articles: articles.length,
      vectors: index.meta.rows, coordinates: coordinates.length, kordoc: appendix.passages.length,
      graphNodes: appendix.graph.nodes.length, graphEdges: appendix.graph.edges.length },
    summary, timing, modelLoadMs, addedBuildMs, rssBytes: process.memoryUsage().rss, results };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ summary, counts: report.counts, timing }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { alignArticles, selectCandidates, scoreQuestion, summarize, compare };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { loadCorpus, corpusPath, searchCorpus } = require('../src/corpus');
const { headingPattern } = require('./benchmark-natural-language');
const { loadSemanticIndex, createEmbedder } = require('../src/semantic');
const { createRetriever, FEATURE_NAMES, experimentFingerprint } = require('../src/jev');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function assertFullVectorCoverage(retriever) {
  const { articles, vectorArticles } = retriever.coverage;
  if (!articles || vectorArticles !== articles) {
    throw new Error(`JEV_VECTOR_COVERAGE_INCOMPLETE: ${vectorArticles}/${articles}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--corpus-dir', '--vector-dir', '--output', '--key-encoding'].includes(argv[i]) || !argv[i + 1]) throw new Error('INVALID_OPTIONS');
    options[argv[i].slice(2)] = argv[i] === '--key-encoding' ? argv[i + 1] : path.resolve(argv[i + 1]);
  }
  if (!options['corpus-dir'] || !options['vector-dir'] || !options.output) throw new Error('REQUIRED_OPTIONS');
  const keyEncoding = options['key-encoding'] || 'full';
  if (!['full', 'single'].includes(keyEncoding)) throw new Error('INVALID_KEY_ENCODING');
  if (fs.existsSync(options.output)) throw new Error('OUTPUT_EXISTS');
  // Deliberate allowlist: no arbitrary question path, external DB or held-out set.
  const sources = ['train', 'dev'].map(split => {
    const file = path.join(__dirname, `../test/fixtures/natural-language-benchmark.${split}.json`), bytes = fs.readFileSync(file);
    return { split, file: path.relative(path.join(__dirname, '..'), file), sha256: sha(bytes), rows: JSON.parse(bytes) };
  });
  const corpusBytes = fs.readFileSync(corpusPath(options['corpus-dir']));
  const corpus = loadCorpus(options['corpus-dir']), index = loadSemanticIndex(options['vector-dir']);
  if (!index) throw new Error('SEMANTIC_INDEX_MISSING');
  const start = performance.now(), retriever = createRetriever(corpus, index, { extraDenseKeys: keyEncoding === 'full' });
  // A partial vector alignment is a runtime fallback, not a comparable experiment.
  // Refuse old vectors paired with a repaired corpus before any query inference.
  assertFullVectorCoverage(retriever);
  // Existing operator models use a local model tree rather than an HF HTTP cache.
  if (process.env.DONGGUK_MCP_SEMANTIC_RUNTIME && process.env.DONGGUK_MCP_SEMANTIC_MODEL_DIR) {
    const runtimePath = createRequire(path.join(process.env.DONGGUK_MCP_SEMANTIC_RUNTIME, 'package.json')).resolve('@huggingface/transformers');
    const runtime = await import(pathToFileURL(runtimePath).href);
    runtime.env.localModelPath = process.env.DONGGUK_MCP_SEMANTIC_MODEL_DIR;
  }
  const embedder = await createEmbedder({ directory: options['vector-dir'], model: index.meta.model, download: false });
  await embedder.embedQuery('검색 준비');
  const startupMs = performance.now() - start;
  const records = [];
  for (const source of sources) for (const question of source.rows) {
    const { semantic, ...ev } = await retriever.gather(question.q, q => embedder.embedQuery(q));
    // Compare explicit article identities in the same rule. No title-only credit.
    const canonical = s => String(s || '').replace(/\s/g, '');
    for (const c of ev.candidates) c.label = Number(question.gt.some(g => g.lawId === c.lawId && g.articles.some(a => canonical(a) === canonical(c.article))));
    const production = {};
    for (const [mode, scores] of [['off', null], ['on', semantic]]) {
      const t = performance.now();
      const found = searchCorpus(corpus, question.q, { top: 3, perDoc: 3, semantic: scores });
      const elapsedMs = performance.now() - t;
      const rules = found.hits.map(hit => ({ lawId: hit.lawId, score: hit.score,
        articles: hit.articles.map(article => ({ article: article.article, label: Number(question.gt.some(g => g.lawId === hit.lawId && g.articles.some(a => headingPattern(a).test(article.content)))) })) }));
      const top3 = rules.some(r => question.gt.some(g => g.lawId === r.lawId));
      production[mode] = { elapsedMs, rules, top3, selectedArticleHit: rules.some(r => r.articles.some(a => a.label)) };
    }
    records.push({ ...question, split: source.split, ...ev, production });
    console.log(`${records.length}/71 ${question.id} candidates=${ev.candidates.length} rrf=${ev.rrfMs.toFixed(1)}ms jev=${ev.jevMs.toFixed(1)}ms`);
  }
  const corpusHash = sha(corpusBytes), vectorHash = index.meta.vectorHash;
  if (sha(fs.readFileSync(corpusPath(options['corpus-dir']))) !== corpusHash) throw new Error('CORPUS_CHANGED');
  const report = { version: 1, createdAt: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    featureNames: FEATURE_NAMES, model: index.meta.model, corpusHash, vectorHash,
    vectorFile: index.meta.vectorFile, textVersion: index.meta.textVersion, keyEncoding,
    fingerprint: experimentFingerprint(corpusHash, vectorHash, keyEncoding === 'full'),
    codeHashes: Object.fromEntries(['src/jev.js', 'scripts/collect-jev-evidence.js', 'src/lookup.js', 'src/aliases.js', 'src/corpus.js', 'src/semantic.js'].map(f => [f, sha(fs.readFileSync(path.join(__dirname, '..', f)))])),
    sources: sources.map(({ rows, ...s }) => ({ ...s, count: rows.length })),
    coverage: retriever.coverage, startupMs, peakRssMb: process.resourceUsage().maxRSS / 1024,
    timingScope: 'Warm local e5-small inference included; first-use lexical term cache; no MCP/network/excerpt rendering; JEV includes RRF shared first stage. No query embedding cache.', records };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(report) + '\n', { flag: 'wx' });
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main, assertFullVectorCoverage };

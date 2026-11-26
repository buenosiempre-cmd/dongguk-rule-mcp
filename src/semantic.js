'use strict';

// Article-level semantic search beside the word index. A local embedding model
// turns each article of the full-text index into a vector once; a question is
// embedded once per lookup and compared in memory. Everything here is optional:
// without the runtime, the model files or a matching vector file, callers get
// null and the word index works as before.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const SEMANTIC_VERSION = 1;
// Changes whenever the text given to the model changes, so old vectors are not reused.
const TEXT_VERSION = 1;
const META_FILE = `semantic-v${SEMANTIC_VERSION}.json`;
const VECTOR_FILE = `semantic-v${SEMANTIC_VERSION}.bin`;
const RUNTIME_PACKAGE = '@huggingface/transformers';

// E5 models are trained with "query: " and "passage: " prefixes and mean pooling.
// BGE-M3 takes plain text and the first token.
const MODELS = {
  'Xenova/multilingual-e5-small': { dtype: 'q8', queryPrefix: 'query: ', passagePrefix: 'passage: ', pooling: 'mean' },
  'Xenova/multilingual-e5-base': { dtype: 'q8', queryPrefix: 'query: ', passagePrefix: 'passage: ', pooling: 'mean' },
  'Xenova/bge-m3': { dtype: 'q8', queryPrefix: '', passagePrefix: '', pooling: 'cls' },
};
const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const CHUNK_CHARS = 400;
const CHUNK_OVERLAP = 100;
const MAX_CHUNKS = 12;
const DEFAULT_TIMEOUT_MS = 1500;
// After a failed load, the word index answers alone for this long before another try.
const RETRY_AFTER_MS = 10 * 60 * 1000;

function semanticSetting() {
  const value = String(process.env.DONGGUK_MCP_SEMANTIC || '').trim().toLowerCase();
  return ['0', 'off', 'false', 'no'].includes(value) ? 'off' : 'auto';
}
function modelName() {
  const name = String(process.env.DONGGUK_MCP_SEMANTIC_MODEL || '').trim();
  return MODELS[name] ? name : DEFAULT_MODEL;
}
function timeoutMs() {
  const value = Number(process.env.DONGGUK_MCP_SEMANTIC_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}
function semanticDir(directory) { return path.join(directory, 'semantic'); }
function modelDir(directory) { return process.env.DONGGUK_MCP_SEMANTIC_MODEL_DIR || path.join(semanticDir(directory), 'models'); }

const headingOf = content => /^[^\n]*?(제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[(（][^)）\n]{1,40}[)）])/.exec(content)?.[1] || '';

// The texts one article is embedded as. A long article is cut into overlapping
// pieces, each carrying the rule's name and the article heading, so a proviso
// near the end is as findable as the first paragraph.
function articleTexts(title, content) {
  const body = String(content || '').replace(/\s+/g, ' ').trim();
  const head = String(title || '').trim();
  if (body.length <= CHUNK_CHARS) return [`${head} ${body}`];
  const heading = headingOf(content);
  const texts = [];
  for (let start = 0; start < body.length && texts.length < MAX_CHUNKS; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    const piece = body.slice(start, start + CHUNK_CHARS);
    texts.push(start === 0 || !heading ? `${head} ${piece}` : `${head} ${heading} ${piece}`);
    if (start + CHUNK_CHARS >= body.length) break;
  }
  return texts;
}

const blockHash = (title, content) => crypto.createHash('sha1').update(`${title}\n${content}`).digest('hex').slice(0, 16);
// Supplementary provisions restart numbering and are never chosen as the answer article.
const indexable = block => !block.supplementary && String(block.content || '').trim().length > 0;

// === runtime ===
// The runtime is not a dependency of this package (several hundred MB with its
// native library). An operator installs it where Node can resolve it from this
// package, or names its install directory in DONGGUK_MCP_SEMANTIC_RUNTIME.
async function importRuntime() {
  const hint = String(process.env.DONGGUK_MCP_SEMANTIC_RUNTIME || '').trim();
  const bases = [...(hint ? [path.join(path.resolve(hint), 'package.json')] : []), __filename];
  let lastError = null;
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve(RUNTIME_PACKAGE);
      return await import(pathToFileURL(resolved).href);
    } catch (error) { lastError = error; }
  }
  throw Object.assign(new Error(`의미검색 런타임(${RUNTIME_PACKAGE})을 찾지 못했습니다.`), { code: 'SEMANTIC_RUNTIME_MISSING', cause: lastError });
}

// One model per process. `download` is true only while building the index;
// answering a question never reaches the network.
async function createEmbedder({ directory, model = modelName(), download = false }) {
  const profile = MODELS[model];
  const runtime = await importRuntime();
  runtime.env.cacheDir = modelDir(directory);
  runtime.env.allowRemoteModels = !!download;
  const extractor = await runtime.pipeline('feature-extraction', model, { dtype: profile.dtype });
  const embed = async texts => {
    const output = await extractor(texts, { pooling: profile.pooling, normalize: true });
    const [count, dims] = output.dims;
    return Array.from({ length: count }, (_, row) => Float32Array.from(output.data.subarray(row * dims, (row + 1) * dims)));
  };
  return {
    model,
    embedQuery: async text => (await embed([profile.queryPrefix + text]))[0],
    embedPassages: texts => embed(texts.map(text => profile.passagePrefix + text)),
  };
}

// === building ===
async function buildSemanticIndex({ corpus, directory, embedder, previous = null, batchSize = 16, onProgress = () => {}, now = () => new Date() }) {
  const reusable = new Map();
  if (previous && previous.meta.model === embedder.model && previous.meta.textVersion === TEXT_VERSION) {
    let row = 0;
    for (const rule of previous.meta.rules) for (const [, hash, count] of rule.blocks) {
      reusable.set(`${rule.lawId}:${hash}`, { row, count });
      row += count;
    }
  }
  const pending = [], rules = [];
  let reused = 0, total = 0;
  for (const rule of corpus.rules) {
    const blocks = [];
    rule.blocks.forEach((block, index) => {
      if (!indexable(block)) return;
      const hash = blockHash(rule.title, block.content);
      const kept = reusable.get(`${rule.lawId}:${hash}`);
      const texts = kept ? null : articleTexts(rule.title, block.content);
      const count = kept ? kept.count : texts.length;
      blocks.push([index, hash, count]);
      pending.push({ kept, texts, count });
      if (kept) reused++;
      total++;
    });
    if (blocks.length) rules.push({ lawId: rule.lawId, historyId: rule.historyId, blocks });
  }
  const rows = pending.reduce((sum, item) => sum + item.count, 0);
  let dims = previous?.meta.dims || 0, vectors = null, row = 0, done = 0;
  const write = vector => {
    if (!vectors) { dims = vector.length; vectors = new Float32Array(rows * dims); }
    vectors.set(vector, row * dims);
    row++;
  };
  let queue = [];
  const flush = async () => {
    if (!queue.length) return;
    const embedded = await embedder.embedPassages(queue);
    queue = [];
    return embedded;
  };
  // Vectors are written in article order, so new articles are embedded in runs between reused ones.
  for (let i = 0; i < pending.length;) {
    const item = pending[i];
    if (item.kept) {
      for (let k = 0; k < item.count; k++) write(previous.vectors.subarray((item.kept.row + k) * dims, (item.kept.row + k + 1) * dims));
      i++; done++;
      continue;
    }
    let end = i;
    while (end < pending.length && !pending[end].kept && queue.length + pending[end].texts.length <= Math.max(batchSize, pending[end].texts.length)) {
      queue.push(...pending[end].texts);
      end++;
    }
    for (const vector of await flush()) write(vector);
    done += end - i;
    i = end;
    onProgress({ done, total, reused });
  }
  if (!vectors) vectors = new Float32Array(0);
  const meta = { version: SEMANTIC_VERSION, textVersion: TEXT_VERSION, model: embedder.model, dims, rows, articles: total, builtAt: now().toISOString(), corpusBuiltAt: corpus.builtAt, rules };
  if (directory) saveSemanticIndex(directory, { meta, vectors });
  return { meta, vectors, reused };
}

function saveSemanticIndex(directory, { meta, vectors }) {
  const folder = semanticDir(directory);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const suffix = `.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const files = [[path.join(folder, VECTOR_FILE), Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)], [path.join(folder, META_FILE), JSON.stringify(meta)]];
  // The vector file goes first: a reader that sees the new meta always finds its vectors.
  for (const [filename, data] of files) {
    try {
      fs.writeFileSync(filename + suffix, data, { mode: 0o600 });
      fs.renameSync(filename + suffix, filename);
    } finally { if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix); }
  }
}

// === loading ===
const loadedIndexes = new Map();
function loadSemanticIndex(directory) {
  const metaFile = path.join(semanticDir(directory), META_FILE), vectorFile = path.join(semanticDir(directory), VECTOR_FILE);
  let stamp;
  try {
    const meta = fs.statSync(metaFile), vectors = fs.statSync(vectorFile);
    stamp = `${meta.mtimeMs}:${meta.size}:${vectors.mtimeMs}:${vectors.size}`;
  } catch { return null; }
  const memo = loadedIndexes.get(metaFile);
  if (memo && memo.stamp === stamp) return memo.index;
  let index = null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const buffer = fs.readFileSync(vectorFile);
    const usable = meta?.version === SEMANTIC_VERSION && meta.textVersion === TEXT_VERSION && MODELS[meta.model]
      && Number.isInteger(meta.dims) && meta.dims > 0 && Array.isArray(meta.rules) && buffer.byteLength === meta.rows * meta.dims * 4;
    if (usable) index = { meta, vectors: new Float32Array(buffer.buffer, buffer.byteOffset, meta.rows * meta.dims) };
  } catch { index = null; }
  loadedIndexes.set(metaFile, { stamp, index });
  return index;
}

// Vector rows matched to the articles of the loaded word index. An article
// whose text changed since the vectors were made is left out: it keeps its
// word score and simply has no semantic score.
const alignments = new WeakMap();
function alignToCorpus(index, corpus) {
  let perIndex = alignments.get(corpus);
  if (!perIndex) alignments.set(corpus, perIndex = new WeakMap());
  if (perIndex.has(index)) return perIndex.get(index);
  const byId = new Map(corpus.rules.map(rule => [rule.lawId, rule]));
  const rowBlocks = new Array(index.meta.rows).fill(null);
  let row = 0, matched = 0, articles = 0;
  for (const entry of index.meta.rules) {
    const rule = byId.get(entry.lawId);
    for (const [blockIndex, hash, count] of entry.blocks) {
      const block = rule?.blocks[blockIndex];
      articles++;
      if (block && indexable(block) && blockHash(rule.title, block.content) === hash) {
        for (let k = 0; k < count; k++) rowBlocks[row + k] = block;
        matched++;
      }
      row += count;
    }
  }
  const aligned = { rowBlocks, matched, articles };
  perIndex.set(index, aligned);
  return aligned;
}

function scoreBlocks(index, corpus, queryVector) {
  const { rowBlocks } = alignToCorpus(index, corpus);
  const { dims } = index.meta, vectors = index.vectors;
  if (queryVector.length !== dims) return null;
  const scores = new Map();
  for (let row = 0; row < rowBlocks.length; row++) {
    const block = rowBlocks[row];
    if (!block) continue;
    let dot = 0;
    for (let i = 0, offset = row * dims; i < dims; i++) dot += vectors[offset + i] * queryVector[i];
    if (!(scores.get(block) >= dot)) scores.set(block, dot);
  }
  return scores;
}

// === answering ===
// One embedder is loaded on first use and shared. Questions are embedded one
// at a time: a caller that has stopped waiting does not start a second
// inference beside the first.
const state = { embedder: null, loading: null, failedAt: 0, lastError: null, chain: Promise.resolve(), waiting: 0, override: null };
const MAX_WAITING = 8;
const queryCache = new Map();

function loadEmbedder(directory, model) {
  if (state.override) return Promise.resolve(state.override);
  if (state.embedder?.model === model) return Promise.resolve(state.embedder);
  if (state.failedAt && Date.now() - state.failedAt < RETRY_AFTER_MS) return Promise.reject(state.lastError);
  if (!state.loading) {
    state.loading = createEmbedder({ directory, model })
      .then(embedder => { state.embedder = embedder; state.failedAt = 0; return embedder; })
      .catch(error => { state.failedAt = Date.now(); state.lastError = error; throw error; })
      .finally(() => { state.loading = null; });
    state.loading.catch(() => {});
  }
  return state.loading;
}

function embedQuestion(directory, model, text) {
  const key = `${model}\n${text}`;
  if (queryCache.has(key)) return Promise.resolve(queryCache.get(key));
  if (state.waiting >= MAX_WAITING) return Promise.reject(Object.assign(new Error('semantic queue full'), { code: 'SEMANTIC_BUSY' }));
  state.waiting++;
  const run = state.chain.then(async () => {
    if (queryCache.has(key)) return queryCache.get(key);
    const embedder = await loadEmbedder(directory, model);
    const vector = await embedder.embedQuery(text);
    queryCache.set(key, vector);
    if (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value);
    return vector;
  }).finally(() => { state.waiting--; });
  state.chain = run.catch(() => {});
  return run;
}

// Semantic scores for one question: Map(article block of `corpus` → cosine
// similarity), or null when semantic search is off, not installed, not built
// for this model, or slower than the time limit. Never throws.
async function semanticScores({ corpus, directory, text, limitMs = timeoutMs() }) {
  const query = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!corpus || !directory || !query || semanticSetting() === 'off') return null;
  const index = loadSemanticIndex(directory);
  if (!index || (!state.override && index.meta.model !== modelName())) return null;
  let timer = null;
  try {
    const work = embedQuestion(directory, index.meta.model, query);
    work.catch(() => {});
    const vector = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), limitMs); })]);
    return vector ? scoreBlocks(index, corpus, vector) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// The embedder that answers questions, for refreshing vectors inside a running server
// without loading the model a second time. Rejects when it cannot be loaded.
function sharedEmbedder(directory) { return loadEmbedder(directory, modelName()); }

// Loads the model ahead of the first question (a long-running server calls this at start).
// Does nothing when semantic search is off or no usable vector file exists.
function warmSemantic(directory) {
  if (semanticSetting() === 'off') return false;
  const index = loadSemanticIndex(directory);
  if (!index || index.meta.model !== modelName()) return false;
  loadEmbedder(directory, index.meta.model).catch(() => {});
  return true;
}

function semanticStatus(directory, corpus = null) {
  const setting = semanticSetting();
  const index = directory ? loadSemanticIndex(directory) : null;
  const aligned = index && corpus ? alignToCorpus(index, corpus) : null;
  return {
    setting, model: modelName(), indexAvailable: !!index,
    ...(index ? { indexModel: index.meta.model, builtAt: index.meta.builtAt, articles: index.meta.articles, vectors: index.meta.rows, dims: index.meta.dims, modelMatches: index.meta.model === modelName() } : {}),
    ...(aligned ? { articlesMatchingIndex: aligned.matched } : {}),
    runtimeLoaded: !!state.embedder, // Error text of the runtime can carry local paths; only a code is reported.
    ...(state.failedAt ? { lastError: state.lastError?.code === 'SEMANTIC_RUNTIME_MISSING' ? 'SEMANTIC_RUNTIME_MISSING' : 'SEMANTIC_MODEL_UNAVAILABLE' } : {}),
  };
}

// Tests supply a deterministic embedder instead of a model.
function setEmbedderForTests(embedder) {
  state.override = embedder || null;
  state.embedder = null; state.failedAt = 0; state.lastError = null;
  queryCache.clear();
}

module.exports = {
  SEMANTIC_VERSION, MODELS, DEFAULT_MODEL, articleTexts, createEmbedder, buildSemanticIndex, saveSemanticIndex, loadSemanticIndex,
  semanticScores, semanticStatus, warmSemantic, sharedEmbedder, semanticSetting, modelName, semanticDir, modelDir, setEmbedderForTests,
};

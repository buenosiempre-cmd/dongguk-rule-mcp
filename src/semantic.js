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
const TEXT_VERSION = 2;
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
// Far above the longest article of the rule book (about 5,500 characters, 18 pieces). An article
// longer than this keeps its first pieces and its last one, so the closing proviso stays searchable.
const MAX_CHUNKS = 40;
const DEFAULT_TIMEOUT_MS = 1500;
// After a failed load or a stalled inference, the word index answers alone for this long before
// another try; after a failed inference, for the shorter time.
const RETRY_AFTER_LOAD_MS = 10 * 60 * 1000;
const RETRY_AFTER_INFERENCE_MS = 60 * 1000;
// One inference (a question, or one batch while refreshing vectors) that runs longer than this
// is given up: the model is dropped so it cannot hold the queue.
const INFERENCE_LIMIT_MS = 20 * 1000;

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
  const step = CHUNK_CHARS - CHUNK_OVERLAP;
  const starts = [];
  for (let start = 0; start < body.length; start += step) {
    starts.push(start);
    if (start + CHUNK_CHARS >= body.length) break;
  }
  // Over the limit: the first pieces, then the piece that ends the article.
  const kept = starts.length <= MAX_CHUNKS ? starts : [...starts.slice(0, MAX_CHUNKS - 1), Math.max(0, body.length - CHUNK_CHARS)];
  return kept.map(start => {
    const piece = body.slice(start, start + CHUNK_CHARS);
    return start === 0 || !heading ? `${head} ${piece}` : `${head} ${heading} ${piece}`;
  });
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
  // The hash ties this description to exactly these vectors: the two files are replaced one
  // after the other, and a reader must never pair one generation's rows with another's vectors.
  const meta = { version: SEMANTIC_VERSION, textVersion: TEXT_VERSION, model: embedder.model, dims, rows, articles: total, builtAt: now().toISOString(), corpusBuiltAt: corpus.builtAt, vectorHash: vectorHash(vectors), rules };
  if (directory) saveSemanticIndex(directory, { meta, vectors });
  return { meta, vectors, reused };
}

const vectorHash = vectors => crypto.createHash('sha256').update(Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)).digest('hex');

function saveSemanticIndex(directory, { meta, vectors }) {
  const folder = semanticDir(directory);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const suffix = `.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const files = [[path.join(folder, VECTOR_FILE), Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)], [path.join(folder, META_FILE), JSON.stringify(meta)]];
  // Vectors first, description second. Between the two renames (or after a crash there) the old
  // description sits beside new vectors; its hash does not match them and the pair is not used.
  for (const [filename, data] of files) {
    try {
      fs.writeFileSync(filename + suffix, data, { mode: 0o600 });
      fs.renameSync(filename + suffix, filename);
    } finally { if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix); }
  }
}

// === loading ===
// A description is used only when every part of it is what the builder writes: rule entries
// with [article position, text hash, number of vectors], and vector counts that add up to the
// file's rows. Anything else means a damaged or foreign file, and the index is not used.
function validMeta(meta) {
  if (!meta || meta.version !== SEMANTIC_VERSION || meta.textVersion !== TEXT_VERSION || !MODELS[meta.model]) return false;
  if (!Number.isInteger(meta.dims) || meta.dims <= 0 || !Number.isInteger(meta.rows) || meta.rows < 0) return false;
  if (typeof meta.vectorHash !== 'string' || !Array.isArray(meta.rules)) return false;
  let rows = 0;
  for (const rule of meta.rules) {
    if (!rule || !Number.isInteger(rule.lawId) || !Array.isArray(rule.blocks)) return false;
    for (const entry of rule.blocks) {
      if (!Array.isArray(entry) || entry.length !== 3) return false;
      const [position, hash, count] = entry;
      if (!Number.isInteger(position) || position < 0 || typeof hash !== 'string' || !Number.isInteger(count) || count < 1) return false;
      rows += count;
    }
  }
  return rows === meta.rows;
}

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
    if (validMeta(meta) && buffer.byteLength === meta.rows * meta.dims * 4
      && crypto.createHash('sha256').update(buffer).digest('hex') === meta.vectorHash) {
      // Copied so the view is aligned whatever offset the file buffer has.
      const vectors = new Float32Array(meta.rows * meta.dims);
      Buffer.from(vectors.buffer).set(buffer);
      if (vectors.every(Number.isFinite)) index = { meta, vectors };
    }
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
const state = { embedder: null, loading: null, pausedUntil: 0, lastCode: null, chain: Promise.resolve(), waiting: 0, override: null, inferenceLimitMs: INFERENCE_LIMIT_MS };
const MAX_WAITING = 8;
const queryCache = new Map();
const coded = (error, code) => Object.assign(error instanceof Error ? error : new Error(String(error)), { semanticCode: error?.code === 'SEMANTIC_RUNTIME_MISSING' ? error.code : code });
function pause(error, ms) { state.pausedUntil = Date.now() + ms; state.lastCode = error.semanticCode; }

function loadEmbedder(directory, model) {
  if (Date.now() < state.pausedUntil) return Promise.reject(Object.assign(new Error('semantic search paused'), { semanticCode: state.lastCode }));
  if (state.override) return Promise.resolve(state.override);
  if (state.embedder?.model === model) return Promise.resolve(state.embedder);
  if (!state.loading) {
    state.loading = createEmbedder({ directory, model })
      .then(embedder => { state.embedder = embedder; return embedder; })
      .catch(error => { pause(coded(error, 'SEMANTIC_MODEL_UNAVAILABLE'), RETRY_AFTER_LOAD_MS); throw error; })
      .finally(() => { state.loading = null; });
    state.loading.catch(() => {});
  }
  return state.loading;
}

// Every inference of this process goes through here, one at a time: questions, and the batches
// of a server refreshing its own vectors. An inference cannot be cancelled, so one that stalls
// is abandoned with its model, and the queue moves on.
function inference(directory, model, work) {
  const run = state.chain.then(async () => {
    const embedder = await loadEmbedder(directory, model);
    let timer = null;
    try {
      return await Promise.race([work(embedder), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('semantic inference stalled'), { stalled: true })), state.inferenceLimitMs);
      })]);
    } catch (error) {
      if (error.stalled) { if (state.embedder === embedder) state.embedder = null; pause(coded(error, 'SEMANTIC_INFERENCE_STALLED'), RETRY_AFTER_LOAD_MS); }
      else pause(coded(error, 'SEMANTIC_INFERENCE_FAILED'), RETRY_AFTER_INFERENCE_MS);
      throw error;
    } finally { clearTimeout(timer); }
  });
  state.chain = run.catch(() => {});
  return run;
}

function embedQuestion(directory, model, text) {
  const key = `${model}\n${text}`;
  if (queryCache.has(key)) return Promise.resolve(queryCache.get(key));
  // While paused, or with too many questions already waiting, the caller falls back at once.
  if (Date.now() < state.pausedUntil) return Promise.reject(new Error('semantic search paused'));
  if (state.waiting >= MAX_WAITING) return Promise.reject(new Error('semantic queue full'));
  state.waiting++;
  return inference(directory, model, async embedder => {
    if (queryCache.has(key)) return queryCache.get(key);
    const vector = await embedder.embedQuery(text);
    queryCache.set(key, vector);
    if (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value);
    return vector;
  }).finally(() => { state.waiting--; });
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

// The embedder that answers questions, for refreshing vectors inside a running server without
// loading the model a second time. Its batches take turns with questions in the same queue.
function sharedEmbedder(directory) {
  const model = modelName();
  return { model, embedPassages: texts => inference(directory, model, embedder => embedder.embedPassages(texts)) };
}

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
  let index = null, aligned = null;
  // Status must answer whatever state the files are in.
  try {
    index = directory ? loadSemanticIndex(directory) : null;
    aligned = index && corpus ? alignToCorpus(index, corpus) : null;
  } catch { index = null; aligned = null; }
  return {
    setting, model: modelName(), indexAvailable: !!index,
    ...(index ? { indexModel: index.meta.model, builtAt: index.meta.builtAt, articles: index.meta.articles, vectors: index.meta.rows, dims: index.meta.dims, modelMatches: index.meta.model === modelName() } : {}),
    ...(aligned ? { articlesMatchingIndex: aligned.matched } : {}),
    runtimeLoaded: !!state.embedder, waiting: state.waiting,
    // Only a code is reported: error text of the runtime can carry local paths.
    ...(Date.now() < state.pausedUntil ? { lastError: state.lastCode, pausedUntil: new Date(state.pausedUntil).toISOString() } : {}),
  };
}

// Tests supply a deterministic embedder instead of a model, and may shorten the stall limit.
function setEmbedderForTests(embedder, { inferenceLimitMs = INFERENCE_LIMIT_MS } = {}) {
  state.override = embedder || null;
  state.embedder = null; state.pausedUntil = 0; state.lastCode = null; state.inferenceLimitMs = inferenceLimitMs;
  queryCache.clear();
}

module.exports = {
  SEMANTIC_VERSION, MODELS, DEFAULT_MODEL, articleTexts, createEmbedder, buildSemanticIndex, saveSemanticIndex, loadSemanticIndex,
  semanticScores, semanticStatus, warmSemantic, sharedEmbedder, semanticSetting, modelName, semanticDir, modelDir, setEmbedderForTests,
};

'use strict';

// Experimental JEV evidence fusion; deliberately not wired into lookup_rule.
// Feature equations adapted from Javad Dogani's MIT JEV (13ae4cc).
// License: docs/JEV-LICENSE. Upstream and experiment notes: experiments/jev/README.md.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { queryConcepts } = require('./lookup');

const FEATURE_NAMES = ['bm25_full', 'bm25_full_z', 'bm25_full_rank', 'dense_full',
  'dense_full_z', 'dense_full_rank', 'dense_rocchio', 'bm25_keys_max', 'bm25_keys_mean',
  'dense_keys_max', 'dense_keys_mean', 'bm25_votes', 'dense_votes', 'coverage', 'rrf', 'n_keys'];
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const order = a => Array.from(a.keys()).sort((i, j) => a[j] - a[i] || i - j);
const ranks = a => { const out = new Array(a.length); order(a).forEach((i, j) => { out[i] = j + 1; }); return out; };
const zscores = a => { const m = mean(a), sd = Math.sqrt(mean(a.map(x => (x - m) ** 2))); return a.map(x => sd > 1e-9 ? (x - m) / sd : 0); };
const max = a => a.reduce((m, x) => Math.max(m, x), -Infinity);
const weighted = (a, w) => a.reduce((s, x, i) => s + x * w[i], 0) / Math.max(1e-9, w.reduce((s, x) => s + x, 0));
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const normalize = a => { const norm = Math.sqrt(dot(a, a)) || 1; return Float32Array.from(a, x => x / norm); };

function experimentFingerprint(corpusHash, vectorHash, extraDenseKeys = true) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ corpusHash, vectorHash, version: 1, extraDenseKeys }));
  for (const file of ['jev.js', 'lookup.js', 'aliases.js']) hash.update(fs.readFileSync(path.join(__dirname, file)));
  return hash.digest('hex');
}

function evidenceFeatures(B, D, wb, wd, rocchioCol = null, maxKeys = 5) {
  if (!B.length) return [];
  const n = B.length, logN = Math.log1p(n);
  const bc = wb.map((_, c) => B.map(row => row[c])), dc = wd.map((_, c) => D.map(row => row[c]));
  const bn = bc.map(a => { const m = max(a); return a.map(x => m > 0 ? x / m : 0); });
  const dn = dc.map(a => { const m = max(a); return a.map(x => x - m); });
  const rb = bc.map(ranks), rd = dc.map(ranks), bz = zscores(bc[0]), dz = zscores(dc[0]);
  const be = wb.map((_, i) => i).slice(1), de = wd.map((_, i) => i).filter(i => i > 0 && i !== rocchioCol);
  const rrf = B.map((_, i) => wb.reduce((s, w, c) => s + w / (60 + rb[c][i]), 0) + wd.reduce((s, w, c) => s + w / (60 + rd[c][i]), 0));
  const rrfMax = max(rrf);
  return B.map((_, i) => [bn[0][i], bz[i], Math.log1p(rb[0][i]) / logN,
    dn[0][i], dz[i], Math.log1p(rd[0][i]) / logN, rocchioCol === null ? 0 : dn[rocchioCol][i],
    be.length ? max(be.map(c => bn[c][i])) : bn[0][i], be.length ? weighted(be.map(c => bn[c][i]), be.map(c => wb[c])) : bn[0][i],
    de.length ? max(de.map(c => dn[c][i])) : dn[0][i], de.length ? weighted(de.map(c => dn[c][i]), de.map(c => wd[c])) : dn[0][i],
    weighted(wb.map((_, c) => Number(rb[c][i] <= 20 && B[i][c] > 0)), wb), weighted(wd.map((_, c) => Number(rd[c][i] <= 20)), wd),
    be.length ? weighted(be.map(c => Number(B[i][c] > 0)), be.map(c => wb[c])) : 1,
    rrf[i] / rrfMax, (wb.length + wd.length - 2) / Math.max(1, 2 * (maxKeys - 1))]);
}

function reciprocalRankFusion(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1)));
  return scores;
}

function createRetriever(corpus, index, { extraDenseKeys = true } = {}) {
  if (!corpus?.rules?.length || !index?.meta?.dims || !index?.vectors) throw new Error('JEV_INDEX_MISSING');
  const docs = [], byBlock = new Map();
  for (const rule of corpus.rules) rule.blocks.forEach((block, position) => {
    if (block.supplementary || !block.content?.trim()) return;
    const doc = { lawId: rule.lawId, article: block.article, position, title: rule.title, content: block.content, block, rows: [] };
    byBlock.set(`${rule.lawId}:${position}`, docs.length); docs.push(doc);
  });
  let row = 0;
  for (const rule of index.meta.rules) for (const [position, hash, count] of rule.blocks) {
    const id = byBlock.get(`${rule.lawId}:${position}`), doc = docs[id];
    if (doc && crypto.createHash('sha1').update(`${doc.title}\n${doc.content}`).digest('hex').slice(0, 16) === hash) {
      for (let k = 0; k < count; k++) doc.rows.push(row + k);
    }
    row += count;
  }
  if (row !== index.meta.rows || !docs.some(d => d.rows.length)) throw new Error('JEV_INDEX_MISMATCH');
  const dims = index.meta.dims, vectors = index.vectors;
  const vector = row => vectors.subarray(row * dims, (row + 1) * dims);
  const texts = docs.map(d => `${d.title} ${d.content}`.toLowerCase());
  const lengths = texts.map(s => Math.max(1, s.split(/\s+/).length)), avgLength = mean(lengths);
  // Reuse the corpus text and Korean concept/particle handling. This BM25 scorer
  // is an experimental adapter, not the production searchCorpus score.
  const termCache = new Map();
  const termStats = concept => {
    const forms = [...new Set([concept.term, ...(concept.alternatives || [])])].map(s => s.toLowerCase());
    const key = forms.join('|');
    if (termCache.has(key)) return termCache.get(key);
    const tf = texts.map(text => Math.max(...forms.map(form => form ? text.split(form).length - 1 : 0)));
    const df = tf.filter(Boolean).length, idf = Math.log(1 + (docs.length - df + .5) / (df + .5));
    const value = { tf, df, idf };
    termCache.set(key, value); return value;
  };
  const concepts = text => queryConcepts(text, 12).concepts.filter(c => !c.joinedFrom && termStats(c).df);
  const bm25 = terms => {
    const scores = new Float64Array(docs.length);
    for (const term of terms) {
      const { tf, idf } = termStats(term);
      for (let i = 0; i < docs.length; i++) if (tf[i]) scores[i] += idf * tf[i] * 1.9 / (tf[i] + .9 * (.6 + .4 * lengths[i] / avgLength));
    }
    return Array.from(scores);
  };
  const keysFor = query => {
    const terms = concepts(query), keys = [{ text: query, terms, weight: 1 }];
    const mass = terms.reduce((s, c) => s + termStats(c).idf, 0) || 1;
    const pools = terms.map(c => ({ text: c.written || c.term, terms: [c] }));
    for (let i = 0; i + 1 < terms.length; i++) pools.push({ text: terms.slice(i, i + 2).map(c => c.written || c.term).join(' '), terms: terms.slice(i, i + 2) });
    const selected = [new Set(terms.map(c => c.term))];
    while (keys.length < 4 && pools.length) {
      let best = -1, bestScore = -Infinity, bestWeight = 0;
      pools.forEach((p, i) => {
        const set = new Set(p.terms.map(c => c.term));
        const novelty = 1 - Math.max(...selected.map(s => [...set].filter(t => s.has(t)).length / new Set([...set, ...s]).size));
        const weight = Math.min(1, p.terms.reduce((s, c) => s + termStats(c).idf, 0) / mass);
        if (novelty > 0 && .5 * (weight + novelty) > bestScore) { best = i; bestScore = .5 * (weight + novelty); bestWeight = weight; }
      });
      if (best < 0) break;
      const key = pools.splice(best, 1)[0]; keys.push({ ...key, weight: bestWeight }); selected.push(new Set(key.terms.map(c => c.term)));
    }
    return keys;
  };
  const dense = (q, ids = docs.map((_, i) => i)) => {
    if (q.length !== dims || !Array.from(q).every(Number.isFinite)) throw new Error('JEV_QUERY_VECTOR_INVALID');
    const scores = ids.map(id => docs[id].rows.length ? max(docs[id].rows.map(r => dot(q, vector(r)))) : null);
    const floor = Math.min(0, ...scores.filter(x => x !== null));
    return scores.map(s => s ?? floor);
  };
  const top = (scores, n, positive = false) => order(scores).filter(i => !positive || scores[i] > 0).slice(0, n);
  const gather = async (query, embedQuery) => {
    const start = performance.now(), keys = keysFor(query), b = [bm25(keys[0].terms)];
    const q = await embedQuery(query), d = dense(q);
    const fullB = top(b[0], 100, true), fullD = top(d, 100).filter(i => docs[i].rows.length);
    const rrf = reciprocalRankFusion([fullB, fullD]);
    const rrfMs = performance.now() - start;
    for (const key of keys.slice(1)) b.push(bm25(key.terms));
    const feedback = Float32Array.from(q);
    for (const id of fullD.slice(0, 3)) {
      const bestRow = docs[id].rows.reduce((a, r) => dot(q, vector(r)) > dot(q, vector(a)) ? r : a);
      const v = vector(bestRow); for (let i = 0; i < dims; i++) feedback[i] += .5 * v[i] / Math.min(3, fullD.length);
    }
    const rocchio = normalize(feedback), dr = dense(rocchio);
    const pool = [...new Set([...fullB, ...fullD, ...b.slice(1).flatMap(s => top(s, 50, true)), ...top(dr, 50).filter(i => docs[i].rows.length)])].sort((a, b) => a - b);
    const extra = [];
    if (extraDenseKeys) for (const key of keys.slice(1)) extra.push(dense(await embedQuery(key.text), pool));
    const B = pool.map(id => b.map(s => s[id])), D = pool.map((id, i) => [d[id], dr[id], ...extra.map(s => s[i])]);
    const wb = keys.map(k => k.weight), wd = [1, 1, ...(extraDenseKeys ? wb.slice(1) : [])];
    const featureStart = performance.now(), features = evidenceFeatures(B, D, wb, wd, 1);
    const featureMs = performance.now() - featureStart;
    const allLists = [...b.map((s, i) => top(s, i ? 50 : 100, true)), fullD, top(dr, 50).filter(i => docs[i].rows.length)];
    const expandedRrf = reciprocalRankFusion(allLists);
    const jevMs = performance.now() - start;
    return { keys: keys.map(k => k.text), candidates: pool.map((id, i) => ({ id, lawId: docs[id].lawId, article: docs[id].article, features: features[i], rrf: rrf.get(id) || 0, expandedRrf: expandedRrf.get(id) || 0 })), rrfMs, featureMs, jevMs,
      queryEncodings: 1 + extra.length, semantic: new Map(docs.map((doc, i) => [doc.block, d[i]])) };
  };
  return { docs, gather, keysFor, coverage: { articles: docs.length, vectorArticles: docs.filter(d => d.rows.length).length, chunks: row } };
}

function validModel(m, dimensions) {
  return m && [m.mean, m.scale, m.weights].every(a => Array.isArray(a) && a.length === dimensions && a.every(Number.isFinite)) && m.scale.every(x => x > 0) && Number.isFinite(m.intercept);
}
function probability(features, model) {
  let z = model.intercept;
  for (let i = 0; i < features.length; i++) z += (features[i] - model.mean[i]) / model.scale[i] * model.weights[i];
  return 1 / (1 + Math.exp(-z));
}
function aggregateRules(candidates, scores) {
  const rules = new Map();
  candidates.forEach((c, i) => {
    const rule = rules.get(c.lawId) || { lawId: c.lawId, score: -Infinity, articles: [] };
    rule.score = Math.max(rule.score, scores[i]); rule.articles.push({ ...c, score: scores[i] }); rules.set(c.lawId, rule);
  });
  return [...rules.values()].map(r => ({ ...r, articles: r.articles.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 3) })).sort((a, b) => b.score - a.score || a.lawId - b.lawId);
}
// A caller may opt in later. Null is an explicit signal to retain RRF/current
// behavior. No model or arbitrary hand-picked coefficients ship by default.
function rerank(candidates, artifact, fingerprint) {
  if (!artifact || artifact.version !== 1 || typeof fingerprint !== 'string' || !fingerprint || artifact.fingerprint !== fingerprint || !validModel(artifact.article, 16) || !validModel(artifact.rule, 1)
    || JSON.stringify(artifact.featureNames) !== JSON.stringify(FEATURE_NAMES) || artifact.rule.weights[0] < 0
    || !Array.isArray(candidates) || candidates.some(c => !c || !Number.isSafeInteger(c.lawId) || !Array.isArray(c.features) || c.features.length !== 16 || !c.features.every(Number.isFinite))) return null;
  const scores = candidates.map(c => probability(c.features, artifact.article));
  if (!scores.every(Number.isFinite)) return null;
  const result = aggregateRules(candidates, scores).map(r => ({ ...r, probability: probability([r.score], artifact.rule) }));
  return result.every(r => Number.isFinite(r.probability)) ? result : null;
}

module.exports = { FEATURE_NAMES, experimentFingerprint, evidenceFeatures, reciprocalRankFusion, createRetriever, aggregateRules, probability, rerank };

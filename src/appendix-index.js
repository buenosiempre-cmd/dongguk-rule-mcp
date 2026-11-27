'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { appendixPassages, buildAppendixGraph } = require('./appendix-kordoc');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signature = index => digest([index.version, index.model, index.dims, index.passages, index.vectors, index.graph]);

async function buildAppendixIndex({ groups, corpus, embedder }) {
  const passages = appendixPassages(groups);
  if (!passages.length) return null;
  const vectors = [];
  for (let offset = 0; offset < passages.length; offset += 16) {
    const batch = passages.slice(offset, offset + 16);
    const result = await embedder.embedPassages(batch.map(p => p.text));
    if (result.length !== batch.length) throw new Error('Invalid appendix embedding count');
    vectors.push(...result.map(v => Array.from(v)));
  }
  const index = { version: 1, model: embedder.model, dims: vectors[0]?.length,
    passages, vectors, graph: buildAppendixGraph(groups, corpus) };
  index.sha256 = signature(index);
  if (!validIndex(index)) throw new Error('Invalid appendix index');
  return index;
}

function validIndex(index) {
  try {
    return index?.version === 1 && typeof index.model === 'string' && index.model.length > 0 &&
      Number.isSafeInteger(index.dims) && index.dims > 0 && index.dims <= 4096 &&
      Array.isArray(index.passages) && index.passages.length > 0 && index.passages.length <= 100000 &&
      new Set(index.passages.map(p => p.id)).size === index.passages.length &&
      index.passages.every(p => p && typeof p.id === 'string' && typeof p.text === 'string' && p.text.length > 0 &&
        [p.lawId, p.historyId].every(n => Number.isSafeInteger(n) && n > 0)) &&
      Array.isArray(index.vectors) && index.vectors.length === index.passages.length &&
      index.vectors.every(v => Array.isArray(v) && v.length === index.dims && v.every(Number.isFinite) && v.some(n => n !== 0)) &&
      Array.isArray(index.graph?.nodes) && Array.isArray(index.graph?.edges) && index.sha256 === signature(index);
  } catch { return false; }
}

function saveAppendixIndex(file, index) {
  if (!validIndex(index)) throw new Error('Invalid appendix index');
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(index), { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function loadAppendixIndex(file, model) {
  try {
    if (fs.statSync(file).size > 128 * 1024 * 1024) return null;
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validIndex(index) && (!model || index.model === model) ? index : null;
  } catch { return null; }
}

// Pure query-vector scoring. The caller owns inference, timeout and fusion.
// Current-catalog revision matching is mandatory; stale attachments never vote.
function searchAppendixIndex(index, queryVector, { model, catalog, top = 3 } = {}) {
  if (!validIndex(index) || model !== index.model || !Array.isArray(catalog) ||
      !queryVector || queryVector.length !== index.dims || !Array.from(queryVector).every(Number.isFinite) ||
      !Number.isSafeInteger(top) || top < 1 || top > 100) return null;
  const norm = Math.hypot(...queryVector);
  if (!norm) return null;
  const current = new Set(catalog.map(r => `${r.lawId}:${r.historyId}`));
  return index.passages.map((passage, row) => {
    if (!current.has(`${passage.lawId}:${passage.historyId}`)) return null;
    const vector = index.vectors[row];
    const score = vector.reduce((sum, n, i) => sum + n * queryVector[i], 0) / (Math.hypot(...vector) * norm);
    return { ...passage, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, top);
}

module.exports = { buildAppendixIndex, validIndex, saveAppendixIndex, loadAppendixIndex, searchAppendixIndex };

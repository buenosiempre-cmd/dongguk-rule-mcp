'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listArticleBlocks } = require('./parsers.js');
const { queryContentTokens } = require('./lookup.js');

// Local full-text index of every current rule. It only narrows candidates:
// callers re-check each hit against the current catalog before using its text.
const CORPUS_VERSION = 1;
const CORPUS_FILE = `corpus-v${CORPUS_VERSION}.json`;

function blocksOf(markdown) {
  const articles = listArticleBlocks(markdown).map(block => ({
    article: block.canonical,
    supplementary: block.supplementary,
    supplementaryHeading: block.supplementaryHeading || null,
    content: block.content,
  }));
  if (articles.length) return articles;
  const text = String(markdown || '').trim();
  // Short 내규 without 조 headings are indexed as one block.
  return text ? [{ article: null, supplementary: false, supplementaryHeading: null, content: text }] : [];
}

async function buildCorpus({ catalog, loadContent, previous = null, onProgress = () => {}, now = () => new Date() }) {
  if (previous?.catalogTotal && catalog.length < previous.catalogTotal * 0.8) {
    throw new Error(`규정 목록이 이전 색인(${previous.catalogTotal}건)보다 크게 줄었습니다(${catalog.length}건). 원문 사이트 응답을 확인하세요.`);
  }
  const reusable = new Map((previous?.rules || []).map(rule => [`${rule.lawId}_${rule.historyId}`, rule]));
  const rules = [], failed = [];
  let reused = 0;
  for (let i = 0; i < catalog.length; i++) {
    const entry = catalog[i];
    const kept = reusable.get(`${entry.lawId}_${entry.historyId}`);
    if (kept) {
      rules.push({ ...kept, title: entry.title, code: entry.code, revisedAt: entry.revisedAt });
      reused++;
    } else {
      try {
        const content = await loadContent(entry.lawId, entry.historyId);
        const blocks = blocksOf(content?.markdown);
        if (!blocks.length) failed.push({ lawId: entry.lawId, title: entry.title, code: 'CONTENT_UNAVAILABLE' });
        else rules.push({ ...entry, blocks });
      } catch (error) {
        failed.push({ lawId: entry.lawId, title: entry.title, code: 'FETCH_FAILED' });
      }
    }
    onProgress({ done: i + 1, total: catalog.length, failed: failed.length, reused });
  }
  return { version: CORPUS_VERSION, builtAt: now().toISOString(), catalogTotal: catalog.length, reused, rules, failed };
}

function corpusPath(directory) { return path.join(directory, 'corpus', CORPUS_FILE); }

function saveCorpus(directory, corpus) {
  const filename = corpusPath(directory);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(corpus), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return filename;
}

const loaded = new Map();
function loadCorpus(directory) {
  const filename = corpusPath(directory);
  let stat;
  try { stat = fs.statSync(filename); } catch { return null; }
  const memo = loaded.get(filename);
  if (memo && memo.mtimeMs === stat.mtimeMs) return memo.corpus;
  try {
    const corpus = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (corpus?.version !== CORPUS_VERSION || !Array.isArray(corpus.rules)) return null;
    loaded.set(filename, { mtimeMs: stat.mtimeMs, corpus });
    return corpus;
  } catch { return null; }
}

function corpusCoverage(corpus) {
  return {
    indexedAt: corpus.builtAt,
    indexedRules: corpus.rules.length,
    totalRules: corpus.catalogTotal,
    failedRules: corpus.failed.length,
    complete: corpus.failed.length === 0 && corpus.rules.length === corpus.catalogTotal,
  };
}

// Blocks that contain the most query words, rarer words weighing more.
function matchBlocks(blocks, tokens, weights) {
  let best = 0;
  const scored = [];
  for (const block of blocks) {
    const matched = tokens.filter(token => block.content.includes(token));
    if (!matched.length) continue;
    const score = matched.reduce((sum, token) => sum + (weights.get(token) || 1), 0);
    best = Math.max(best, score);
    scored.push({ block, matched, score });
  }
  return { best, scored: scored.sort((a, b) => b.score - a.score) };
}

// Rules write 근로장학금 where a question says 교내근로장학금, and 출장 where it
// says 국내출장. A word that no rule contains is replaced by its longest
// shorter form that some rule does contain. For four or more syllables the
// head noun is at the end, so leading syllables (교내·국내) are dropped first;
// a three-syllable word such as 특강료 or 강사료 keeps its first two syllables
// (특강, 강사) because its last two (강료, 사료) are fragments of other words.
// Forms shorter than two syllables or found in most rules are not used.
function rewriteMissingToken(token, documentFrequency, total) {
  if (token.length < 3) return null;
  const candidates = [];
  if (token.length === 3) candidates.push(token.slice(0, 2), token.slice(1));
  else {
    for (let drop = 1; token.length - drop >= 2; drop++) candidates.push(token.slice(drop));
    for (let cut = token.length - 1; cut >= 2; cut--) candidates.push(token.slice(0, cut));
    candidates.sort((a, b) => b.length - a.length);
  }
  for (const form of candidates) {
    const df = documentFrequency(form);
    if (df && df <= total * 0.5) return form;
  }
  return null;
}

function searchCorpus(corpus, query, { top = 3, perDoc = 5 } = {}) {
  const original = queryContentTokens(query, 6);
  if (!original.length) return { tokens: original, hits: [] };
  const total = corpus.rules.length || 1;
  const documentFrequency = token => corpus.rules.filter(rule => rule.title.includes(token) || rule.blocks.some(block => block.content.includes(token))).length;
  const rewrittenTerms = {};
  const tokens = [];
  for (const token of original) {
    let form = token;
    if (!documentFrequency(token)) {
      const shorter = rewriteMissingToken(token, documentFrequency, total);
      if (shorter) { rewrittenTerms[token] = shorter; form = shorter; }
    }
    if (!tokens.includes(form)) tokens.push(form);
  }
  const weights = new Map(tokens.map(token => [token, (df => df ? Math.log(1 + total / df) : 0)(documentFrequency(token))]));
  const hits = [];
  for (const rule of corpus.rules) {
    const { best, scored } = matchBlocks(rule.blocks, tokens, weights);
    const titleMatched = tokens.filter(token => rule.title.includes(token));
    if (!best && !titleMatched.length) continue;
    const matchedTerms = [...new Set([...titleMatched, ...scored.flatMap(item => item.matched)])];
    hits.push({
      lawId: rule.lawId, historyId: rule.historyId, title: rule.title, code: rule.code, revisedAt: rule.revisedAt,
      score: best + titleMatched.reduce((sum, token) => sum + (weights.get(token) || 1), 0) * 1.5 + matchedTerms.length * 0.01,
      matchedTerms,
      // Articles containing as many of the query words as the best article does.
      matchCount: scored.filter(item => item.matched.length === Math.max(...scored.map(x => x.matched.length))).length,
      articles: scored.slice(0, perDoc).map(item => ({
        article: item.block.article, supplementary: item.block.supplementary,
        supplementaryHeading: item.block.supplementaryHeading, content: item.block.content, matchedTerms: item.matched,
      })),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.lawId - b.lawId);
  return { tokens, missingTerms: tokens.filter(token => !weights.get(token)), rewrittenTerms, hits: hits.slice(0, top) };
}

module.exports = { CORPUS_VERSION, blocksOf, buildCorpus, saveCorpus, loadCorpus, corpusPath, corpusCoverage, matchBlocks, searchCorpus, rewriteMissingToken };

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

function searchCorpus(corpus, query, { top = 3, perDoc = 5 } = {}) {
  const tokens = queryContentTokens(query, 6);
  if (!tokens.length) return { tokens, hits: [] };
  const total = corpus.rules.length || 1;
  const weights = new Map(tokens.map(token => {
    const df = corpus.rules.filter(rule => rule.title.includes(token) || rule.blocks.some(block => block.content.includes(token))).length;
    return [token, df ? Math.log(1 + total / df) : 0];
  }));
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
  return { tokens, missingTerms: tokens.filter(token => !weights.get(token)), hits: hits.slice(0, top) };
}

module.exports = { CORPUS_VERSION, blocksOf, buildCorpus, saveCorpus, loadCorpus, corpusPath, corpusCoverage, matchBlocks, searchCorpus };

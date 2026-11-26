'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listArticleBlocks } = require('./parsers.js');
const { generalRuleWeight } = require('./aliases.js');
const { queryConcepts, ruleFamily } = require('./lookup.js');

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

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Concepts of the question as the rules spell them. A question word keeps its
// rule vocabulary ("해외출장" also tries 국외출장·국외); a word no rule contains
// is replaced by vocabulary that exists, then by a shorter form.
function planConcepts(query, documentFrequency, total) {
  const { tokens: original, concepts: planned } = queryConcepts(query, 6);
  const rewrittenTerms = {}, concepts = [], missingTerms = [];
  for (const concept of planned) {
    let forms = concept.alternatives.filter(form => documentFrequency(form));
    if (concept.joinedFrom) {
      // "이중 수혜" joined as 이중수혜 counts only when rules write it that way.
      if (forms.length) concepts.push({ term: concept.term, forms, joined: true });
      continue;
    }
    const term = concept.term;
    // "절차가": a noun plus the subject particle when the bare noun is far more common.
    if (term.length === 3 && term.endsWith('가')) {
      const stem = term.slice(0, 2), stemFrequency = documentFrequency(stem);
      if (stemFrequency && documentFrequency(term) < stemFrequency * 0.05) { rewrittenTerms[term] = stem; forms = [stem]; }
    }
    if (!forms.length) {
      const shorter = rewriteMissingToken(term, documentFrequency, total);
      if (shorter) { rewrittenTerms[term] = shorter; forms = [shorter]; }
    } else if (!documentFrequency(term) && !rewrittenTerms[term]) rewrittenTerms[term] = forms[0];
    if (forms.length) concepts.push({ term, forms, joined: false });
    else missingTerms.push(term);
  }
  return { original, concepts, rewrittenTerms, missingTerms };
}

function searchCorpus(corpus, query, { top = 3, perDoc = 5 } = {}) {
  const total = corpus.rules.length || 1;
  const frequencies = new Map();
  const documentFrequency = term => {
    if (!frequencies.has(term)) frequencies.set(term, corpus.rules.filter(rule => rule.title.includes(term) || rule.blocks.some(block => block.content.includes(term))).length);
    return frequencies.get(term);
  };
  const { original, concepts, rewrittenTerms, missingTerms } = planConcepts(query, documentFrequency, total);
  if (!original.length) return { tokens: original, hits: [] };
  const weight = form => Math.log(1 + total / documentFrequency(form));
  const words = concepts.filter(concept => !concept.joined);
  // Adjacent question words that also sit together in an article ("예산의 전용").
  const adjacent = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i].forms[0], words[i + 1].forms[0]];
    adjacent.push({ pattern: new RegExp(`${escapeRegExp(a)}[^\\n]{0,3}${escapeRegExp(b)}`), bonus: (weight(a) + weight(b)) * 0.5 });
  }
  // A concept scores by the rarest of its forms that the text contains.
  const scoreText = text => {
    let score = 0; const matched = [], matchedConcepts = [];
    for (const concept of concepts) {
      const found = concept.forms.filter(form => text.includes(form));
      if (!found.length) continue;
      // A joined pair repeats its two words, so it adds half of its own weight.
      score += Math.max(...found.map(weight)) * (concept.joined ? 0.5 : 1);
      for (const form of found) if (!matched.includes(form)) matched.push(form);
      matchedConcepts.push(concept.term);
    }
    return { score, matched, matchedConcepts };
  };
  const generalFamilies = new Set(corpus.rules.filter(r => !ruleFamily(r.title).edition).map(r => ruleFamily(r.title).family));
  const hits = [];
  for (const rule of corpus.rules) {
    const scored = [];
    for (const block of rule.blocks) {
      const result = scoreText(block.content);
      if (!result.matched.length) continue;
      for (const pair of adjacent) if (pair.pattern.test(block.content)) result.score += pair.bonus;
      // An article titled with a question word ("제31조(휴학)") is about that word, not a passing mention.
      const heading = /^[^\n]*?제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[(（]([^)）\n]{1,40})[)）]/.exec(block.content);
      if (heading) result.score += words.reduce((sum, word) => sum + Math.max(0, ...word.forms.filter(form => heading[1].includes(form)).map(weight)), 0) * 0.5;
      scored.push({ block, ...result });
    }
    scored.sort((a, b) => b.score - a.score);
    const title = scoreText(rule.title);
    if (!scored.length && !title.matched.length) continue;
    const matchedTerms = [...new Set([...title.matched, ...scored.flatMap(item => item.matched)])];
    const matchedConcepts = [...new Set([...title.matchedConcepts, ...scored.flatMap(item => item.matchedConcepts)])].filter(term => words.some(word => word.term === term));
    const mostMatched = Math.max(0, ...scored.map(item => item.matched.length));
    hits.push({
      lawId: rule.lawId, historyId: rule.historyId, title: rule.title, code: rule.code, revisedAt: rule.revisedAt,
      score: ((scored[0]?.score || 0) + title.score * 1.5 + matchedTerms.length * 0.01) * generalRuleWeight(rule.title, query, generalFamilies.has(ruleFamily(rule.title).family)),
      matchedTerms, matchedConcepts, ...ruleFamily(rule.title),
      // Articles containing as many of the query words as the best article does.
      matchCount: scored.filter(item => item.matched.length === mostMatched).length,
      articles: scored.slice(0, perDoc).map(item => ({
        article: item.block.article, supplementary: item.block.supplementary,
        supplementaryHeading: item.block.supplementaryHeading, content: item.block.content, matchedTerms: item.matched,
      })),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.lawId - b.lawId);
  const tokens = words.map(word => word.forms[0]);
  return {
    tokens: [...tokens, ...missingTerms], missingTerms, rewrittenTerms,
    // Every form searched, for callers that re-read or excerpt the matched rules.
    searchTerms: [...new Set(concepts.flatMap(concept => concept.forms))],
    hits: hits.slice(0, top),
  };
}

module.exports = { CORPUS_VERSION, blocksOf, buildCorpus, saveCorpus, loadCorpus, corpusPath, corpusCoverage, matchBlocks, searchCorpus, rewriteMissingToken };

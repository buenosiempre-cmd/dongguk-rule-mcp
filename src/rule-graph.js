'use strict';

// Retrieval evidence only: an edge does not establish legal applicability.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createResolver, extractReferences, normalizeName } = require('./references.js');

const GRAPH_VERSION = 2;
const GRAPH_FILE = `rule-graph-v${GRAPH_VERSION}.json`;
const WEIGHTS = { cites: 0.65, applies: 0.85, implements: 1, appendix: 0.4, revises: 0 };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ruleKey = id => `r:${id}`;
const articleKey = (id, index) => `a:${id}:${index}`;
const canonical = text => {
  const m = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?$/.exec(String(text || '').trim());
  return m ? `제${Number(m[1])}조${m[2] ? `의${Number(m[2])}` : ''}` : null;
};
const validId = id => Number.isSafeInteger(id) && id > 0;
const referenceType = text => /준용/.test(text) && !/준용[^.!?。]{0,20}(?:아니|않|없|배제|제외|금지)/.test(text) ? 'applies' : 'cites';
function completeNamePrefix(prefix, name) {
  const escaped = [...normalizeName(name)].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s·ㆍ‧•・.]*');
  const match = new RegExp(`${escaped}\\s*$`).exec(prefix);
  if (!match) return false;
  const before = prefix.slice(0, match.index);
  // Whitespace alone is not a name boundary: "WISE캠퍼스 시험규정" must
  // not resolve to "시험규정". Accept explicit grammatical boundaries.
  return /^\s*[①-⑳]?\s*$/.test(before) || /[,;:!?。]\s*$/.test(before) ||
    /(?:^|[\s,;:])(?:[가-힣A-Za-z0-9·ㆍ]+(?:은|는|에는|에서는)|및|또는|위하여|따라|의하여|의거하여|근거하여)\s+$/.test(before);
}

function validCorpus(corpus) {
  return !!corpus && Array.isArray(corpus.rules) && corpus.rules.every(rule =>
    rule && validId(rule.lawId) && validId(rule.historyId) && typeof rule.title === 'string' &&
    Array.isArray(rule.blocks) && rule.blocks.every(block => block && typeof block.content === 'string')) &&
    new Set(corpus.rules.map(rule => rule.lawId)).size === corpus.rules.length;
}

function corpusSignature(corpus) {
  return hash(corpus.rules.map(rule => [rule.lawId, rule.historyId, rule.title, rule.scope || null,
    rule.blocks.map(block => [block.article, !!block.supplementary, block.content]) ]));
}

function dateKey(value) {
  const m = /^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? +date : null;
}

function buildRuleGraph(corpus, { histories = {} } = {}) {
  if (!validCorpus(corpus)) throw new TypeError('그래프 입력에 유효한 본문 색인이 필요합니다.');
  const nodes = [], edges = [], unresolved = [];
  const byId = new Map(corpus.rules.map(rule => [rule.lawId, rule]));
  const articles = new Map(), seenEdges = new Set();
  const addEdge = (from, to, type, evidence) => {
    if (from === to) return;
    const key = `${from}|${to}|${type}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, type, weight: WEIGHTS[type], evidence });
  };
  for (const rule of corpus.rules) {
    nodes.push({ id: ruleKey(rule.lawId), kind: 'rule', lawId: rule.lawId, historyId: rule.historyId, title: rule.title, scope: rule.scope || null });
    const names = new Map();
    rule.blocks.forEach((block, blockIndex) => {
      if (block.supplementary) return;
      const article = canonical(block.article);
      nodes.push({ id: articleKey(rule.lawId, blockIndex), kind: 'article', lawId: rule.lawId, historyId: rule.historyId, blockIndex, article });
      if (article) names.set(article, names.has(article) ? null : articleKey(rule.lawId, blockIndex));
    });
    articles.set(rule.lawId, names);
  }

  const missing = (rule, blockIndex, target, reason) => unresolved.push({ lawId: rule.lawId, blockIndex, target, reason });
  for (const rule of corpus.rules) {
    const resolver = createResolver(corpus.rules, rule);
    rule.blocks.forEach((block, blockIndex) => {
      if (block.supplementary) return;
      const from = articleKey(rule.lawId, blockIndex);
      // Remove only the leading article heading, retaining body text on that line.
      const body = block.content.replace(/^\s*(?:#{1,6}\s*)?제\s*\d+\s*조(?:\s*의\s*\d+)?\s*(?:[（(][^）)\n]*[）)])?/, '');
      // Keep a whole sentence for scope; an unknown or external name suppresses
      // unqualified same-rule references in that sentence rather than guessing.
      for (const sentence of body.split(/(?<=[.!?。])\s+/).filter(Boolean)) {
        const acceptedNames = new Set();
        let namedContext = false;
        // Validate the exact occurrence before the shared extractor deduplicates
        // names. An allowed later citation must not validate an earlier qualified
        // name, or steal its article number/evidence.
        const refs = extractReferences(sentence, { ...resolver, titleEndingAt(prefix) {
          const title = resolver.titleEndingAt(prefix);
          if (!title) return null;
          namedContext = true;
          if (!completeNamePrefix(prefix, title)) {
            missing(rule, blockIndex, resolver.ruleByKey(title)?.title || title, 'incomplete_title_match');
            return null;
          }
          acceptedNames.add(title);
          return title;
        } });
        for (const ref of refs) {
          if (!['same_rule', 'dongguk_rule'].includes(ref.scope)) {
            missing(rule, blockIndex, ref.name, ref.resolutionStatus);
            continue;
          }
          const targetId = ref.target.lawId;
          if (ref.resolutionStatus === 'name_heuristic' && !acceptedNames.has(normalizeName(ref.name))) {
            missing(rule, blockIndex, ref.name, 'incomplete_title_match');
            continue;
          }
          const target = byId.get(targetId);
          if (!target) continue;
          const to = ref.article ? articles.get(targetId).get(canonical(ref.article)) : ruleKey(targetId);
          const evidence = { lawId: rule.lawId, historyId: rule.historyId, blockIndex, text: ref.citationText };
          if (!to) missing(rule, blockIndex, `${ref.name} ${ref.article}`, 'missing_or_ambiguous_article');
          else addEdge(from, to, referenceType(ref.citationText), evidence);
          // Direction: implementing rule -> named parent. A mere citation does
          // not prove hierarchy; require an explicit purpose/delegation clause.
          if (targetId !== rule.lawId && refs.length === 1 &&
              /(?:따라|의하여|의거하여|근거하여)/.test(sentence) &&
              /(?:시행에\s*필요한|위임[된한]?\s*사항|세부\s*사항|세부사항)/.test(sentence)) {
            addEdge(ruleKey(rule.lawId), ruleKey(targetId), 'implements', evidence);
          }
        }
        // Do not turn foreign references (including unknown unquoted names and
        // anaphora) into same-numbered articles of this rule.
        const foreignContext = namedContext || refs.length || /[「『]|(?:법|법률|규정|규칙|학칙|정관|내규|세칙)\s*(?:의\s*)?제\s*\d+\s*조|(?:동법|같은\s*(?:법|규정))/.test(sentence);
        if (!foreignContext) {
          for (const m of sentence.matchAll(/제\s*\d+\s*조(?:\s*의\s*\d+)?/g)) {
            const label = canonical(m[0]);
            const to = articles.get(rule.lawId).get(label);
            if (to) addEdge(from, to, referenceType(sentence), { lawId: rule.lawId, historyId: rule.historyId, blockIndex, text: sentence.trim().slice(0, 240) });
            else missing(rule, blockIndex, label, 'missing_or_ambiguous_article');
          }
        }
        // Appendix references are useful evidence but do not fabricate content.
        if (!foreignContext) for (const m of sentence.matchAll(/별표\s*(\d+)(?:\s*의\s*(\d+))?/g)) {
          const label = `별표${Number(m[1])}${m[2] ? `의${Number(m[2])}` : ''}`;
          const id = `p:${rule.lawId}:${label}`;
          if (!nodes.some(node => node.id === id)) nodes.push({ id, kind: 'appendix', lawId: rule.lawId, historyId: rule.historyId, label, available: false });
          addEdge(from, id, 'appendix', { lawId: rule.lawId, historyId: rule.historyId, blockIndex, text: m[0] });
        }
      }
    });

    // Metadata chronology, not enforcement or a semantic amendment comparison.
    // Same-date or conflicting entries cannot establish predecessor order.
    const entries = histories[rule.lawId] || [];
    const unique = new Map(), dates = new Map();
    for (const entry of entries) {
      const date = dateKey(entry.revisedAt);
      if (!validId(entry.historyId) || date === null) continue;
      if (unique.has(entry.historyId) && unique.get(entry.historyId)?.date !== date) unique.set(entry.historyId, null);
      else if (!unique.has(entry.historyId)) unique.set(entry.historyId, { ...entry, date });
    }
    const ordered = [...unique.values()].filter(Boolean).sort((a, b) => a.date - b.date);
    for (const entry of ordered) {
      dates.set(entry.date, (dates.get(entry.date) || 0) + 1);
      nodes.push({ id: `v:${rule.lawId}:${entry.historyId}`, kind: 'version', lawId: rule.lawId, historyId: entry.historyId, revisedAt: entry.revisedAt });
    }
    for (let i = 1; i < ordered.length; i++) {
      const before = ordered[i - 1], after = ordered[i];
      if (dates.get(before.date) !== 1 || dates.get(after.date) !== 1) continue;
      addEdge(`v:${rule.lawId}:${after.historyId}`, `v:${rule.lawId}:${before.historyId}`, 'revises', { lawId: rule.lawId, source: 'history_metadata', fromDate: after.revisedAt, toDate: before.revisedAt });
    }
  }
  return { version: GRAPH_VERSION, corpusSignature: corpusSignature(corpus), nodes, edges, unresolved };
}

function validGraph(graph) {
  if (!graph || graph.version !== GRAPH_VERSION || typeof graph.corpusSignature !== 'string' ||
      !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return false;
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id) || !validId(node.lawId) || !validId(node.historyId) ||
        !['rule', 'article', 'appendix', 'version'].includes(node.kind)) return false;
    if (node.kind === 'article' && (!Number.isInteger(node.blockIndex) || node.blockIndex < 0)) return false;
    nodes.set(node.id, node);
  }
  return graph.edges.every(edge => edge && nodes.has(edge.from) && nodes.has(edge.to) &&
    Object.hasOwn(WEIGHTS, edge.type) && edge.weight === WEIGHTS[edge.type] && edge.evidence && typeof edge.evidence === 'object');
}

function saveRuleGraph(directory, graph) {
  if (!validGraph(graph)) throw new TypeError('유효하지 않은 그래프');
  const filename = path.join(directory, 'graph', GRAPH_FILE);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ checksum: hash(graph), graph }), { mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return filename;
}

function loadRuleGraph(directory, corpus) {
  try {
    if (!validCorpus(corpus)) return null;
    const { graph, checksum } = JSON.parse(fs.readFileSync(path.join(directory, 'graph', GRAPH_FILE), 'utf8'));
    if (checksum !== hash(graph) || !validGraph(graph) || graph.corpusSignature !== corpusSignature(corpus)) return null;
    // A valid checksum alone does not prove that article positions are in range.
    const rules = new Map(corpus.rules.map(rule => [rule.lawId, rule]));
    for (const node of graph.nodes) {
      const rule = rules.get(node.lawId);
      if (!rule || (node.kind !== 'version' && node.historyId !== rule.historyId)) return null;
      if (node.kind === 'article') {
        const block = rule.blocks[node.blockIndex];
        if (!block || block.supplementary || canonical(block.article) !== node.article || node.id !== articleKey(node.lawId, node.blockIndex)) return null;
      }
    }
    return graph;
  } catch { return null; }
}

const prepared = new WeakMap();
function prepare(graph) {
  if (!graph || typeof graph !== 'object') return null;
  if (prepared.has(graph)) return prepared.get(graph);
  if (!validGraph(graph)) return null;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const adjacency = new Map(), rules = new Map();
  for (const node of graph.nodes) if (node.kind === 'rule') rules.set(node.lawId, node);
  for (const edge of graph.edges) {
    if (edge.weight === 0 || edge.type === 'appendix') continue;
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    for (const [source, target] of [[from, to], [to, from]]) {
      const list = adjacency.get(source.lawId) || [];
      list.push({ source, target, edge });
      adjacency.set(source.lawId, list);
    }
  }
  const degrees = new Map([...adjacency].map(([id, links]) => [id,
    new Set(links.map(link => link.target.lawId).filter(target => target !== id)).size]));
  const result = { nodes, adjacency, rules, degrees };
  prepared.set(graph, result);
  return result;
}

function related(graph, seeds, { limit = 10, scope = null, articleOnly = false } = {}) {
  const index = prepare(graph);
  if (!index || !Array.isArray(seeds)) return [];
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(50, Math.floor(limit))) : 10;
  const scores = new Map(), grouped = new Map();
  for (const input of seeds.slice(0, 16)) {
    const seed = typeof input === 'number' ? { lawId: input } : input;
    if (!seed || !index.rules.has(seed.lawId) || (seed.article && !canonical(seed.article))) continue;
    const group = grouped.get(seed.lawId) || { lawId: seed.lawId, articles: new Set(), all: false, score: 0 };
    if (seed.article) group.articles.add(canonical(seed.article)); else group.all = true;
    group.score = Math.max(group.score, Number.isFinite(seed.score) ? Math.max(0, Math.min(1, seed.score)) : 1);
    grouped.set(seed.lawId, group);
  }
  for (const seed of grouped.values()) {
    const sourceRule = index.rules.get(seed.lawId);
    if (scope && sourceRule.scope !== scope) continue;
    const links = index.adjacency.get(seed.lawId) || [];
    const contribution = new Map();
    const confidence = Number.isFinite(seed.score) ? Math.max(0, Math.min(1, seed.score)) : 1;
    for (const { source, target, edge } of links) {
      if (!seed.all && source.kind === 'article' && !seed.articles.has(source.article)) continue;
      const targetRule = index.rules.get(target.lawId);
      if (!targetRule || (scope && targetRule.scope !== scope)) continue;
      if (articleOnly ? target.kind !== 'article' : target.lawId === seed.lawId) continue;
      if (articleOnly && target.lawId === seed.lawId && seed.articles.has(target.article)) continue;
      const key = articleOnly ? target.id : ruleKey(target.lawId);
      const degree = index.degrees.get(target.lawId) || 0;
      const score = confidence * edge.weight / Math.sqrt(Math.max(1, degree));
      const value = { lawId: target.lawId, historyId: target.historyId, title: targetRule.title,
        ...(articleOnly ? { article: target.article, blockIndex: target.blockIndex } : {}), score, evidence: edge.evidence, relation: edge.type };
      if (!contribution.has(key) || contribution.get(key).score < score) contribution.set(key, value);
    }
    // Repeated citations from one seed give one vote, so long regulations do
    // not win merely by repeating the same reference across many articles.
    for (const [key, value] of contribution) {
      const current = scores.get(key);
      scores.set(key, current ? { ...current, score: current.score + value.score } : value);
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.lawId - b.lawId || (a.blockIndex || 0) - (b.blockIndex || 0)).slice(0, count);
}

function rankRelatedRules(graph, seeds, options) { return related(graph, seeds, options); }
function getRelatedArticles(graph, seeds, options) { return related(graph, seeds, { ...options, articleOnly: true }); }

module.exports = { GRAPH_VERSION, buildRuleGraph, saveRuleGraph, loadRuleGraph, rankRelatedRules, getRelatedArticles };

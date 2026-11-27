#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const graphApi = require('../src/rule-graph.js');

// Structural coverage, not natural-language answer accuracy. The caller names
// the corpus explicitly so pre/post-parser data cannot be silently mixed.
function measureRuleGraph(corpus, api = graphApi) {
  const start = performance.now(), graph = api.buildRuleGraph(corpus);
  const buildMs = performance.now() - start;
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const relations = {}, unresolved = {};
  for (const edge of graph.edges) relations[edge.type] = (relations[edge.type] || 0) + 1;
  for (const item of graph.unresolved) unresolved[item.reason] = (unresolved[item.reason] || 0) + 1;
  api.rankRelatedRules(graph, []); // Prepare adjacency before timing warm queries.
  const samples = [];
  let emptySeeds = 0;
  for (let round = 0; round < 5; round++) for (const rule of corpus.rules) {
    const begin = performance.now();
    const result = api.rankRelatedRules(graph, [rule.lawId]);
    samples.push(performance.now() - begin);
    if (round === 0 && !result.length) emptySeeds++;
  }
  samples.sort((a, b) => a - b);
  return { graphVersion: graph.version, corpusBuiltAt: corpus.builtAt || null,
    sourceRules: corpus.rules.length, graphRules: graph.nodes.filter(node => node.kind === 'rule').length,
    sourceMainBlocks: corpus.rules.reduce((n, rule) => n + rule.blocks.filter(block => !block.supplementary).length, 0),
    graphArticles: graph.nodes.filter(node => node.kind === 'article').length,
    relations, totalEdges: graph.edges.length,
    crossRuleEdges: graph.edges.filter(edge => byId.get(edge.from).lawId !== byId.get(edge.to).lawId).length,
    emptySeeds, seedCount: corpus.rules.length, unresolved,
    buildMs: +buildMs.toFixed(2), jsonBytes: Buffer.byteLength(JSON.stringify(graph)),
    queryMedianMs: +(samples[Math.floor(samples.length / 2)] || 0).toFixed(4),
    queryP95Ms: +(samples[Math.floor(samples.length * 0.95)] || 0).toFixed(4), querySamples: samples.length };
}

if (require.main === module) {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length) {
    console.error('사용법: node scripts/measure-rule-graph.js <corpus.json>');
    process.exitCode = 1;
  } else {
    try {
      const raw = fs.readFileSync(filename), corpus = JSON.parse(raw);
      console.log(JSON.stringify({ corpusFile: filename, corpusSHA256: crypto.createHash('sha256').update(raw).digest('hex'),
        ...measureRuleGraph(corpus) }, null, 2));
    } catch (error) {
      console.error(`그래프 구조 측정 실패: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
module.exports = { measureRuleGraph };

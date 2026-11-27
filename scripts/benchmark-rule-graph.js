#!/usr/bin/env node
'use strict';

const { performance } = require('node:perf_hooks');
const { buildRuleGraph, rankRelatedRules, getRelatedArticles } = require('../src/rule-graph.js');
// Synthetic ring: 500 rules, 20 articles each, one citation per article.
const corpus = { rules: Array.from({ length: 500 }, (_, i) => ({
  lawId: i + 1, historyId: (i + 1) * 10, title: `합성${i + 1}규정`,
  blocks: Array.from({ length: 20 }, (_, j) => ({ article: `제${j + 1}조`, supplementary: false,
    content: `### 제${j + 1}조(합성) 「합성${(i + 1) % 500 + 1}규정」 제${j + 1}조를 준용한다.` })),
})) };
global.gc?.();
const before = process.memoryUsage().heapUsed, start = performance.now();
const graph = buildRuleGraph(corpus), buildMs = performance.now() - start;
rankRelatedRules(graph, [1, 2, 3]);
getRelatedArticles(graph, [{ lawId: 1, article: '제1조' }]);
global.gc?.();
const heapDeltaMB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
const samples = [];
for (let i = 0; i < 1000; i++) {
  const begin = performance.now();
  rankRelatedRules(graph, [i % 500 + 1, (i + 1) % 500 + 1]);
  getRelatedArticles(graph, [{ lawId: i % 500 + 1, article: '제1조' }]);
  samples.push(performance.now() - begin);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ 자료: '합성 순환 인용; 실제 정답률·전체 검색 지연 측정 아님',
  규정수: corpus.rules.length, 조문수: 10000, 노드수: graph.nodes.length, 관계수: graph.edges.length,
  생성ms: +buildMs.toFixed(2), 힙증가MB: +heapDeltaMB.toFixed(2), GC사용: !!global.gc,
  JSON크기MB: +(Buffer.byteLength(JSON.stringify(graph)) / 1024 / 1024).toFixed(2),
  조회중간값ms: +samples[500].toFixed(3), 조회P95ms: +samples[950].toFixed(3), 반복수: samples.length,
}, null, 2));

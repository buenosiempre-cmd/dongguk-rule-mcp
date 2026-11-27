#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { buildRuleGraph, saveRuleGraph, loadRuleGraph } = require('../src/rule-graph.js');

// Explicit input only. No source fetching, model download or cache discovery.
const [corpusFile, directory, historyFile, ...extra] = process.argv.slice(2);
if (!corpusFile || !directory || extra.length) {
  console.error('사용법: node scripts/build-rule-graph.js <corpus.json> <색인 디렉터리> [histories.json]');
  process.exitCode = 1;
} else {
  try {
    const corpus = JSON.parse(fs.readFileSync(path.resolve(corpusFile), 'utf8'));
    const histories = historyFile ? JSON.parse(fs.readFileSync(path.resolve(historyFile), 'utf8')) : {};
    const start = performance.now();
    const graph = buildRuleGraph(corpus, { histories });
    const filename = saveRuleGraph(path.resolve(directory), graph);
    const reloaded = loadRuleGraph(path.resolve(directory), corpus);
    if (!reloaded) throw new Error('저장한 그래프의 재조회 검증에 실패했습니다.');
    const relations = {};
    for (const edge of reloaded.edges) relations[edge.type] = (relations[edge.type] || 0) + 1;
    console.log(JSON.stringify({ 파일: filename, 원본규정수: corpus.rules.length,
      그래프규정수: reloaded.nodes.filter(node => node.kind === 'rule').length,
      노드수: reloaded.nodes.length, 관계수: reloaded.edges.length, 관계별건수: relations,
      미해결참조수: reloaded.unresolved.length, 처리시간ms: Math.round((performance.now() - start) * 100) / 100,
      재조회: '일치' }, null, 2));
  } catch (error) {
    console.error(`그래프 생성 실패: ${error.message}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
'use strict';

// Synthetic cached-handler benchmark. It must never contact the rule source.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { createHttpServer } = require('../src/http-server');
const version = require('../package.json').version;
const argv = process.argv.slice(2);
function option(name, fallback, maximum) {
  const i = argv.indexOf(name);
  const value = i < 0 ? fallback : Number(argv[i + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name}: 1~${maximum} 정수가 필요합니다.`);
  return value;
}
const round = n => Math.round(n * 100) / 100;
function percentiles(values) {
  if (!values.length) return { p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

async function main() {
  const requests = option('--requests', 200, 10000);
  const concurrency = option('--concurrency', 40, 1000);
  const maxConcurrent = option('--max-concurrent', 8, 256);
  const maxQueue = option('--max-queue', 32, 4096);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-http-benchmark-'));
  const previousEnv = Object.fromEntries(['XDG_CACHE_HOME', 'DONGGUK_RULE_COOKIE', 'DONGGUK_MCP_NO_CACHE'].map(key => [key, process.env[key]]));
  process.env.XDG_CACHE_HOME = temp;
  process.env.DONGGUK_MCP_NO_CACHE = '0';
  delete process.env.DONGGUK_RULE_COOKIE;
  const fetchPath = require.resolve('node-fetch');
  const sourceFetch = require(fetchPath);
  let blockedSourceRequests = 0;
  require.cache[fetchPath].exports = async () => { blockedSourceRequests++; throw new Error('BENCHMARK_SOURCE_NETWORK_BLOCKED'); };
  let server, deadline;
  const cancellation = new AbortController();
  try {
    const lawId = 900000001, historyId = 900000101;
    const cacheRoot = path.join(temp, 'dongguk-rule-mcp', 'v2', 'public');
    const historyDir = path.join(cacheRoot, 'history');
    const contentDir = path.join(cacheRoot, 'content');
    fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(contentDir, { recursive: true, mode: 0o700 });
    const markdown = '# 합성 부하검증 전용 규정\n\n' + Array.from({ length: 40 }, (_, index) => `### 제${index + 1}조(검증 자료 ${index + 1})\n① 이 문서는 HTTP 캐시 적중 부하를 측정하기 위한 합성 자료이며 실제 학교 규정이 아닙니다.\n② 요청 처리는 공식 원문 연결 없이 임시 캐시의 본문과 연혁을 사용합니다.\n③ 결과의 규정 식별자와 날짜는 실제 업무에 인용하지 않습니다.\n`).join('\n');
    fs.writeFileSync(path.join(historyDir, `${lawId}.json`), JSON.stringify([{ historyId, revisedAt: '2026-01-01', title: '합성 부하검증 전용 규정' }]), { mode: 0o600 });
    fs.writeFileSync(path.join(contentDir, `${lawId}_${historyId}.json`), JSON.stringify({ title: '합성 부하검증 전용 규정', markdown }), { mode: 0o600 });
    // Require after replacing node-fetch and isolating the cache environment.
    const { createServer } = require('../src/index');
    const token = crypto.randomBytes(32).toString('hex');
    server = createHttpServer({ version, token, maxConcurrent, maxQueue, shutdownTimeoutMs: 1000, endpointFactories: { '/mcp/rules': () => createServer({ profile: 'rules' }) } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const endpoint = `http://127.0.0.1:${server.address().port}/mcp/rules`;
    deadline = setTimeout(() => cancellation.abort(), 55000);
    const durations = [], successDurations = [], statuses = {};
    let next = 0, successful = 0, rateLimited = 0, failed = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: Math.min(requests, concurrency) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= requests || cancellation.signal.aborted) return;
        const requestStart = performance.now();
        try {
          const response = await fetch(endpoint, {
            method: 'POST', signal: cancellation.signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: 'get_rule_content', arguments: { law_id: lawId, ...(index % 5 ? { article: `제${index % 40 + 1}조` } : {}) } } }),
          });
          statuses[response.status] = (statuses[response.status] || 0) + 1;
          const body = await response.json();
          const duration = performance.now() - requestStart;
          durations.push(duration);
          if (response.status === 429) { rateLimited++; continue; }
          if (response.status !== 200 || body.result?.structuredContent?.ok !== true || body.result?.structuredContent?.data?.lawId !== lawId || body.result?.structuredContent?.data?.historyId !== historyId) { failed++; continue; }
          successful++;
          successDurations.push(duration);
        } catch {
          durations.push(performance.now() - requestStart);
          failed++;
        }
      }
    }));
    const elapsedMs = performance.now() - started;
    const status = server.getStatus();
    const completed = successful + rateLimited + failed;
    const report = {
      benchmark: 'dongguk-rule-mcp cached HTTP handler', version,
      measuredAt: new Date().toISOString(),
      limitation: '캐시 적중 합성 부하이며 학교 전체 동시 이용·원문 서버 처리량 보장 아님',
      fixture: { profile: 'rules', tool: 'get_rule_content', source: 'temporary synthetic public cache', mix: '80% article selection, 20% full text', contentBytes: Buffer.byteLength(markdown) },
      configuration: { requests, clientConcurrency: concurrency, httpMaxConcurrent: maxConcurrent, httpMaxQueue: maxQueue },
      results: { successful, rateLimited, failed, completed, notStarted: requests - completed, httpStatusCounts: statuses, elapsedMs: round(elapsedMs), throughputPerSecond: { completed: round(completed / elapsedMs * 1000), successful: round(successful / elapsedMs * 1000) }, latencyMs: { all: percentiles(durations), successful: percentiles(successDurations) } },
      server: { peakActiveRequests: status.peakActiveRequests, peakQueuedRequests: status.peakQueuedRequests, activeRequests: status.activeRequests, queuedRequests: status.queuedRequests },
      sourceNetwork: { mode: 'blocked by node-fetch stub', attemptedRequests: blockedSourceRequests },
      timedOut: cancellation.signal.aborted,
    };
    if (failed || blockedSourceRequests || cancellation.signal.aborted || completed !== requests) process.exitCode = 1;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearTimeout(deadline);
    cancellation.abort();
    if (server) await server.shutdown();
    require.cache[fetchPath].exports = sourceFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(JSON.stringify({ benchmark: 'dongguk-rule-mcp cached HTTP handler', error: error.message })); process.exitCode = 1; });

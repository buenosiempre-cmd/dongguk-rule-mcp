'use strict';

// Offline integration tests exercise real local TCP and the installed MCP SDK.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createHttpServer, validateConfiguration, readTokenFile } = require('../src/http-server');
const TOKEN = 'local-http-regression-token';
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const live = new Set();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-http-test-'));
let passed = 0;

function factory(label = 'default', handler) {
  return () => {
    const server = new Server({ name: 'http-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: label, description: 'fixture', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async req => {
      if (handler) await handler(req);
      return { content: [{ type: 'text', text: label }] };
    });
    return server;
  };
}
async function start(options = {}) {
  const server = createHttpServer({ createServer: factory(), version: 'test-version', token: TOKEN, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.base = `http://127.0.0.1:${server.address().port}`;
  live.add(server);
  return server;
}
async function stop(server) { const result = await server.shutdown(); live.delete(server); return result; }
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) {
  for (let i = 0; i < 100; i++) { if (test()) return; await pause(10); }
  assert.ok(test(), 'condition did not become true');
}
async function rpc(server, payload = { jsonrpc: '2.0', id: 1, method: 'tools/list' }, extra = {}) {
  return fetch(server.base + (extra.endpoint || '/mcp'), { method: 'POST', headers: { ...headers, ...extra.headers }, body: JSON.stringify(payload), ...(extra.signal ? { signal: extra.signal } : {}) });
}
function call(id) { return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'wait', arguments: { id } } }; }
function raw(server, { chunks = [], finish = true, customHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(server.base + '/mcp', { method: 'POST', headers: { ...headers, ...customHeaders }, agent: false }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: data }); req.destroy(); });
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    if (finish) req.end();
  });
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  console.log('\n🌐 HTTP 운영 하드닝 검증');
  await check('공개 무인증 바인딩 거절, loopback 무인증 호환', async () => {
    assert.throws(() => validateConfiguration({ createServer: factory(), host: '0.0.0.0' }), /Bearer/);
    assert.throws(() => validateConfiguration({ createServer: factory(), host: '::' }), /Bearer/);
    const s = await start({ token: '' });
    assert.equal((await rpc(s, undefined, { headers: { Authorization: '' } })).status, 200);
    assert.equal((await fetch(s.base + '/status')).status, 401);
    assert.equal((await raw(s, { chunks: ['{}'], customHeaders: { Host: 'attacker.example' } })).status, 403);
    await stop(s);
  });
  const s = await start({ maxBodyBytes: 256, bodyTimeoutMs: 80 });
  await check('기존 health/initialize/stateless MCP 호환', async () => {
    const health = await (await fetch(s.base + '/health')).json();
    assert.deepEqual(health, { status: 'ok', name: 'dongguk-rule-mcp', version: 'test-version', transport: 'streamable-http' });
    const init = await rpc(s, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal((await rpc(s)).status, 200);
    assert.equal((await fetch(s.base + '/mcp', { headers })).status, 405);
    assert.equal((await fetch(s.base + '/health', { method: 'POST' })).status, 405);
    assert.equal((await fetch(s.base + '/not-found')).status, 404);
  });
  await check('인증 401 및 challenge, 인증된 운영상태만 공개', async () => {
    const unauthorized = await rpc(s, undefined, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /^Bearer /);
    assert.equal((await fetch(s.base + '/status')).status, 401);
    const status = await (await fetch(s.base + '/status', { headers })).json();
    assert.equal(status.limits.maxBodyBytes, 256);
    assert.ok(!JSON.stringify(status).includes(TOKEN));
    assert.equal((await fetch(s.base + '/ready')).status, 200);
  });
  await check('Origin 기본 거절 및 명시 허용목록', async () => {
    assert.equal((await rpc(s, undefined, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    const allow = await start({ allowedOrigins: ['https://cop.example.edu'] });
    assert.equal((await rpc(allow, undefined, { headers: { Origin: 'https://cop.example.edu' } })).status, 200);
    assert.equal((await rpc(allow, undefined, { headers: { Origin: 'null' } })).status, 403);
    await stop(allow);
  });
  await check('공개 정적 연결 안내는 CSP 적용, MCP 인증 유지', async () => {
    const page = await start({ publicPage: '<!doctype html><html lang="ko"><title>CoP</title><p>연결 안내</p></html>' });
    for (const endpoint of ['/', '/guide']) {
      const result = await fetch(page.base + endpoint);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-security-policy'), /default-src 'none'/);
      assert.match(result.headers.get('content-type'), /text\/html/);
      assert.match(await result.text(), /연결 안내/);
    }
    assert.equal((await rpc(page, undefined, { headers: { Authorization: '' } })).status, 401);
    await stop(page);
  });
  await check('고정길이 및 chunked 초과본문에 연결 재설정 없이 413', async () => {
    assert.equal((await raw(s, { chunks: ['x'.repeat(300)], customHeaders: { 'Content-Length': 300 } })).status, 413);
    const chunked = await raw(s, { chunks: ['x'.repeat(150), 'x'.repeat(150)] });
    assert.equal(chunked.status, 413);
    assert.equal(JSON.parse(chunked.body).error.message, 'Request body too large');
  });
  await check('본문 수신 timeout 408, 잘못된 JSON 400, batch 400', async () => {
    assert.equal((await raw(s, { chunks: ['{'], finish: false })).status, 408);
    assert.equal((await raw(s, { chunks: ['{broken'] })).status, 400);
    assert.equal((await rpc(s, [call(1), call(2)])).status, 400);
    assert.equal((await rpc(s, null)).status, 400);
    assert.equal((await rpc(s, 42)).status, 400);
    assert.equal((await rpc(s)).status, 200);
  });
  await check('본문 전송 도중 연결 취소도 수신 슬롯 정리', async () => {
    const req = http.request(s.base + '/mcp', { method: 'POST', headers, agent: false });
    req.on('error', () => {});
    req.write('{');
    await until(() => s.getStatus().activeRequests === 1);
    req.destroy();
    await until(() => s.getStatus().activeRequests === 0);
    assert.equal((await rpc(s)).status, 200);
  });
  await stop(s);
  await check('팩토리 예외는 500 후 자원 회수하여 다음 요청 처리', async () => {
    let attempts = 0;
    const ok = factory();
    const recovery = await start({ maxConcurrent: 1, maxQueue: 0, createServer: () => { if (++attempts === 1) throw new Error('private diagnostic'); return ok(); } });
    const failed = await rpc(recovery);
    assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes('private diagnostic'));
    await until(() => recovery.getStatus().activeRequests === 0);
    assert.equal((await rpc(recovery)).status, 200);
    await stop(recovery);
  });

  await check('파일 토큰: 기본 rules 범위, finance 403, 관리자 status 권한, 만료/폐기 401', async () => {
    const tokenFile = path.join(temp, 'tokens.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ tokens: [
      { sha256: digest('member') },
      { sha256: digest('finance'), endpoints: ['/mcp'], admin: true },
      { sha256: digest('expired'), expiresAt: '2000-01-01T00:00:00Z' },
      { sha256: digest('revoked'), enabled: false },
      { sha256: digest(TOKEN), endpoints: ['/mcp/rules'], enabled: false },
    ] }), { mode: 0o600 });
    const f = await start({ tokenFile, endpointFactories: { '/mcp': factory('finance'), '/mcp/rules': factory('rules') } });
    const as = token => ({ Authorization: `Bearer ${token}` });
    const member = await rpc(f, undefined, { endpoint: '/mcp/rules', headers: as('member') });
    assert.equal(member.status, 200);
    assert.equal((await member.json()).result.tools[0].name, 'rules');
    assert.equal((await rpc(f, undefined, { headers: as('member') })).status, 403);
    assert.equal((await fetch(f.base + '/status', { headers: as('member') })).status, 403);
    assert.equal((await fetch(f.base + '/status', { headers: as('finance') })).status, 200);
    assert.equal((await rpc(f, undefined, { endpoint: '/mcp/rules', headers: as('finance') })).status, 403);
    for (const t of ['expired', 'revoked']) assert.equal((await rpc(f, undefined, { endpoint: '/mcp/rules', headers: as(t) })).status, 401);
    assert.equal((await rpc(f)).status, 200); // explicit legacy token overrides a same-digest file record
    assert.equal((await rpc(f, undefined, { endpoint: '/mcp/rules' })).status, 200);
    assert.equal((await fetch(f.base + '/status', { headers })).status, 200);
    await stop(f);
    const invalid = path.join(temp, 'invalid.json');
    fs.writeFileSync(invalid, JSON.stringify({ tokens: [{ sha256: 'bad' }] }));
    assert.throws(() => readTokenFile(invalid), /sha256/);
    fs.writeFileSync(invalid, JSON.stringify({ tokens: [{ sha256: digest('same') }, { sha256: digest('same') }] }));
    assert.throws(() => readTokenFile(invalid), /중복/);
  });
  await check('만료일: 불가능한 날짜·시각 거절, 윤년·표준 시간대 허용', async () => {
    const filename = path.join(temp, 'dates.json');
    for (const expiresAt of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-04-31T00:00:00+09:00', '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:00+25:00', '2027', 0]) {
      fs.writeFileSync(filename, JSON.stringify({ tokens: [{ sha256: digest('date'), expiresAt }] }));
      assert.throws(() => readTokenFile(filename), /expiresAt/);
    }
    for (const expiresAt of ['2028-02-29T00:00:00Z', '2028-02-29T23:59:59.123+09:00', '2028-03-01T00:00:00-05:00']) {
      fs.writeFileSync(filename, JSON.stringify({ tokens: [{ sha256: digest('date'), expiresAt }] }));
      assert.equal(readTokenFile(filename)[0].expiresAt, Date.parse(expiresAt));
    }
  });
  await check('구성원 2000개 토큰 등록, 마지막 토큰 인증 및 endpoint 권한 분리', async () => {
    const filename = path.join(temp, 'large-token-file.json');
    const tokens = Array.from({ length: 2000 }, (_, i) => ({ sha256: digest(`synthetic-member-${i}`) }));
    fs.writeFileSync(filename, JSON.stringify({ tokens }), { mode: 0o600 });
    assert.ok(fs.statSync(filename).size > 65536);
    assert.equal(readTokenFile(filename).length, 2000);
    const large = await start({ token: '', tokenFile: filename, endpointFactories: { '/mcp': factory('finance'), '/mcp/rules': factory('rules') } });
    const memberHeaders = { Authorization: 'Bearer synthetic-member-1999' };
    const response = await rpc(large, undefined, { endpoint: '/mcp/rules', headers: memberHeaders });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.tools[0].name, 'rules');
    assert.equal((await rpc(large, undefined, { headers: memberHeaders })).status, 403);
    assert.equal((await fetch(large.base + '/status', { headers: memberHeaders })).status, 403);
    assert.equal((await rpc(large, undefined, { endpoint: '/mcp/rules', headers: { Authorization: 'Bearer synthetic-member-missing' } })).status, 401);
    await stop(large);
  });

  await check('동시요청 1개 + FIFO 큐 1개, 초과 429와 Retry-After', async () => {
    const waiters = [], order = [];
    const q = await start({ maxConcurrent: 1, maxQueue: 1, createServer: factory('queue', req => { order.push(req.params.arguments.id); return new Promise(resolve => waiters.push(resolve)); }) });
    const first = rpc(q, call(1));
    await until(() => waiters.length === 1);
    const second = rpc(q, call(2));
    await until(() => q.getStatus().queuedRequests === 1);
    const rejected = await rpc(q, call(3));
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get('retry-after'), '5');
    assert.equal((await fetch(q.base + '/ready')).status, 503);
    assert.deepEqual(order, [1]);
    waiters.shift()();
    assert.equal((await first).status, 200);
    await until(() => order.length === 2);
    assert.deepEqual(order, [1, 2]);
    waiters.shift()();
    assert.equal((await second).status, 200);
    await until(() => q.getStatus().activeRequests === 0);
    assert.equal(q.getStatus().peakActiveRequests, 1);
    assert.equal(q.getStatus().peakQueuedRequests, 1);
    assert.equal((await fetch(q.base + '/ready')).status, 200);
    await stop(q);
  });
  await check('대기시간 초과 429 후 큐 제거', async () => {
    let finish;
    const q = await start({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 60, createServer: factory('wait', () => new Promise(resolve => { finish = resolve; })) });
    const first = rpc(q, call(1));
    await until(() => finish);
    assert.equal((await rpc(q, call(2))).status, 429);
    assert.equal(q.getStatus().queuedRequests, 0);
    finish(); await first;
    await stop(q);
  });
  await check('취소된 대기요청 제거 및 실행 중 취소는 실제 작업 완료까지 슬롯 유지', async () => {
    const waiters = [];
    const q = await start({ maxConcurrent: 1, maxQueue: 1, createServer: factory('wait', () => new Promise(resolve => waiters.push(resolve))) });
    const activeAbort = new AbortController();
    const first = rpc(q, call(1), { signal: activeAbort.signal }).catch(() => null);
    await until(() => waiters.length === 1);
    const queuedAbort = new AbortController();
    const queued = rpc(q, call(2), { signal: queuedAbort.signal }).catch(() => null);
    await until(() => q.getStatus().queuedRequests === 1);
    queuedAbort.abort(); await queued;
    await until(() => q.getStatus().queuedRequests === 0);
    activeAbort.abort(); await first;
    assert.equal(q.getStatus().activeRequests, 1);
    const replacement = rpc(q, call(3));
    await until(() => q.getStatus().queuedRequests === 1);
    assert.equal(waiters.length, 1);
    waiters.shift()();
    await until(() => waiters.length === 1);
    waiters.shift()();
    assert.equal((await replacement).status, 200);
    await stop(q);
  });
  await check('정상 종료는 진행 요청 완료 대기, 새 큐는 503', async () => {
    let finish;
    const q = await start({ maxConcurrent: 1, maxQueue: 1, createServer: factory('wait', () => new Promise(resolve => { finish = resolve; })) });
    const first = rpc(q, call(1)); await until(() => finish);
    const second = rpc(q, call(2)); await until(() => q.getStatus().queuedRequests === 1);
    const stopping = q.shutdown();
    assert.equal((await second).status, 503);
    finish(); assert.equal((await first).status, 200);
    assert.equal((await stopping).forced, false);
    live.delete(q);
  });
  await check('완료되지 않는 요청도 종료 제한시간 안에 강제 정리', async () => {
    let began = false;
    const q = await start({ shutdownTimeoutMs: 60, createServer: factory('stuck', () => { began = true; return new Promise(() => {}); }) });
    const pending = rpc(q, call(1)).catch(() => null);
    await until(() => began);
    assert.equal((await stop(q)).forced, true);
    await pending;
  });
  console.log(`\n📊 HTTP 하드닝 검증: ${passed}개 시나리오 통과`);
}

const timeout = setTimeout(() => { console.error('HTTP hardening test timeout'); process.exit(1); }, 30000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled([...live].map(stop));
  fs.rmSync(temp, { recursive: true, force: true });
  clearTimeout(timeout);
});

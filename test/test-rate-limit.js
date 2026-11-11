'use strict';

// Offline tests for the anonymous per-client rate limit.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createHttpServer, validateConfiguration } = require('../src/http-server');
const { createRateLimiter, clientAddress, clientKey } = require('../src/rate-limit');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`); }
function factory() {
  const server = new Server({ name: 'rate-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'fixture', description: 'fixture', inputSchema: { type: 'object' } }] }));
  return server;
}
async function start(options) {
  const server = createHttpServer({ endpointFactories: { '/mcp': factory }, version: 't', ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.base = `http://127.0.0.1:${server.address().port}`;
  return server;
}
function list(server, headers = {}) {
  return fetch(server.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
}

(async () => {
  console.log('Rate limit');
  await check('limiter enforces minute and day windows with Retry-After', () => {
    let t = 0;
    const limiter = createRateLimiter({ perMinute: 2, perDay: 3, now: () => t });
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('a').allowed, true);
    const minute = limiter.take('a');
    assert.equal(minute.allowed, false); assert.equal(minute.window, 'minute'); assert.equal(minute.retryAfter, 60);
    assert.equal(limiter.take('b').allowed, true, 'clients are independent');
    t = 60 * 1000;
    assert.equal(limiter.take('a').allowed, true);
    const day = limiter.take('a');
    assert.equal(day.allowed, false); assert.equal(day.window, 'day');
    t = 24 * 60 * 60 * 1000;
    assert.equal(limiter.take('a').allowed, true, 'day window resets');
  });
  await check('zero disables both windows', () => {
    const limiter = createRateLimiter({ perMinute: 0, perDay: 0 });
    for (let i = 0; i < 500; i++) assert.equal(limiter.take('x').allowed, true);
  });
  await check('client map is bounded', () => {
    const limiter = createRateLimiter({ perMinute: 5, perDay: 5, maxClients: 10 });
    for (let i = 0; i < 100; i++) limiter.take('c' + i);
    assert.ok(limiter.size() <= 10);
  });
  await check('CF-Connecting-IP is trusted only from loopback peers', () => {
    const req = (peer, ip) => ({ socket: { remoteAddress: peer }, headers: ip ? { 'cf-connecting-ip': ip } : {} });
    assert.equal(clientAddress(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
    assert.equal(clientAddress(req('::ffff:127.0.0.1', '2001:db8::1')), '2001:db8:0:0::/64');
    assert.equal(clientAddress(req('198.51.100.2', '203.0.113.7')), '198.51.100.2');
    assert.equal(clientAddress(req('127.0.0.1', 'not-an-ip')), '127.0.0.1');
    assert.equal(clientAddress(req('127.0.0.1', '203.0.113.7'), { trustProxy: false }), '127.0.0.1');
  });
  await check('IPv6 clients are grouped by /64 prefix', () => {
    assert.equal(clientKey('2a09:bac5:4736:db9::15e:137'), '2a09:bac5:4736:db9::/64');
    assert.equal(clientKey('2A09:BAC5:4736:0DB9:1:2:3:4'), '2a09:bac5:4736:db9::/64');
    assert.equal(clientKey('::1'), '0:0:0:0::/64');
    assert.equal(clientKey('::ffff:203.0.113.5'), '203.0.113.5');
    assert.equal(clientKey('64:ff9b::203.0.113.5'), '64:ff9b:0:0::/64');
    assert.equal(clientKey('198.51.100.20'), '198.51.100.20');
  });
  await check('configuration validates limits', () => {
    assert.throws(() => validateConfiguration({ createServer: factory, rateLimitPerMinute: -1 }), /rateLimitPerMinute/);
    assert.equal(validateConfiguration({ createServer: factory }).rateLimitPerMinute, 60);
    assert.equal(validateConfiguration({ createServer: factory }).rateLimitPerDay, 1000);
  });
  await check('anonymous HTTP burst gets 429 with Retry-After per client IP', async () => {
    const server = await start({ rateLimitPerMinute: 3, rateLimitPerDay: 100 });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await list(server, { 'CF-Connecting-IP': '203.0.113.9' })).status, 200);
      const limited = await list(server, { 'CF-Connecting-IP': '203.0.113.9' });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
      assert.match((await limited.json()).error.message, /Rate limit/);
      assert.equal((await list(server, { 'CF-Connecting-IP': '203.0.113.10' })).status, 200, 'other client unaffected');
      const health = await fetch(server.base + '/health');
      assert.equal(health.status, 200, 'health is not limited');
      assert.equal(server.getStatus().counters.rateLimited, 1);
    } finally { await server.shutdown(); }
  });
  await check('authenticated members are not IP limited', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-rate-'));
    const token = 'rate-member-token';
    const file = path.join(dir, 'tokens.json');
    fs.writeFileSync(file, JSON.stringify({ tokens: [{ sha256: crypto.createHash('sha256').update(token).digest('hex'), endpoints: ['/mcp'] }] }));
    const server = await start({ tokenFile: file, rateLimitPerMinute: 1, rateLimitPerDay: 1 });
    try {
      for (let i = 0; i < 4; i++) assert.equal((await list(server, { Authorization: `Bearer ${token}` })).status, 200);
      assert.equal((await list(server)).status, 401, 'anonymous still requires token on auth server');
    } finally { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  console.log(`Rate limit: ${passed} passed`);
})().catch(error => { console.error(error); process.exit(1); });

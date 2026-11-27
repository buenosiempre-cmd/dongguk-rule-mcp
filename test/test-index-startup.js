'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A preload for the real HTTP entry point: no external network, short test-only interval.
if (process.env.INDEX_STARTUP_FIXTURE === '1') {
  const corpus = require('../src/corpus');
  const original = corpus.buildCorpus;
  let attempts = 0, active = 0, intervalTicks = 0;
  corpus.buildCorpus = async options => {
    attempts++; active++;
    process.send({ attempts, active, beforeFirstInterval: intervalTicks === 0 });
    try {
      await delay(650);
      if (attempts === 1) throw new Error('synthetic startup failure');
      return await original(options);
    } finally { active--; }
  };
  const interval = global.setInterval;
  global.setInterval = (callback, ms, ...args) => ms === 3600000
    ? interval(() => { intervalTicks++; callback(...args); }, 400)
    : interval(callback, ms, ...args);
  const fetchPath = require.resolve('node-fetch');
  require(fetchPath);
  require.cache[fetchPath].exports = async () => { throw new Error('UNEXPECTED_NETWORK'); };
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-startup-'));
  const publicDir = path.join(root, 'dongguk-rule-mcp/v2/public');
  const catalog = [{ lawId: 1, historyId: 10, title: '합성규정', code: 'test', revisedAt: '2025.01.01' }];
  for (const [folder, name, value] of [
    ['catalog', 'all', catalog],
    ['content-v4', '1_10', { title: '합성규정', markdown: '### 제1조(목적)\n새 파서 본문을 보존한다.' }],
    ['corpus', 'corpus-v1', { version: 1, catalogTotal: 1, rules: [{ ...catalog[0], blocks: [{ article: '제1조', content: '### 제1조(목적)' }] }], failed: [] }],
  ]) {
    fs.mkdirSync(path.join(publicDir, folder), { recursive: true });
    fs.writeFileSync(path.join(publicDir, folder, name + '.json'), JSON.stringify(value));
  }
  const token = 'startup-test-only';
  const net = require('node:net');
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = fork(path.resolve(__dirname, '../src/index.js'), ['--http', '--host', '127.0.0.1', '--port', String(port), '--token', token], {
    execArgv: ['--require', __filename], silent: true,
    env: { ...process.env, INDEX_STARTUP_FIXTURE: '1', XDG_CACHE_HOME: root, DONGGUK_RULE_COOKIE: '', DONGGUK_MCP_PROFILE: 'rules',
      DONGGUK_MCP_INDEX_REFRESH_HOURS: '1', DONGGUK_MCP_NO_CACHE: '0', DONGGUK_MCP_WARM_RULES: '' },
  });
  const events = []; let stderr = '';
  child.on('message', event => events.push(event));
  child.stderr.on('data', bytes => { stderr += bytes; });
  const base = `http://127.0.0.1:${port}`;
  const status = async () => (await fetch(base + '/status', { headers: { Authorization: `Bearer ${token}` } })).json();
  async function until(predicate) {
    const end = Date.now() + 10000;
    while (Date.now() < end) { try { if (await predicate()) return; } catch {} await delay(10); }
    assert.fail('startup condition timeout: ' + stderr);
  }
  try {
    await until(async () => events.length > 0 && (await fetch(base + '/health')).ok);
    assert.equal(events[0].attempts, 1);
    assert.equal(events[0].beforeFirstInterval, true);
    // Still in the first build: HTTP must already answer before it completes.
    assert.equal((await status()).fullTextIndex.running, true);
    await until(async () => (await status()).fullTextIndex.lastRefresh?.ok === false);
    assert.equal((await fetch(base + '/health')).status, 200);
    await until(async () => (await status()).fullTextIndex.lastRefresh?.ok === true);
    const current = await status();
    assert.equal(current.fullTextIndex.available, true);
    assert.ok(events.length >= 2);
    assert.ok(events.every(event => event.active === 1));
    const stored = JSON.parse(fs.readFileSync(path.join(publicDir, 'corpus/corpus-v1.json')));
    assert.equal(stored.contentVersion, 4);
    assert.ok(stored.rules[0].blocks[0].content.includes('새 파서 본문'));
    console.log('✅ HTTP 시작 갱신: 응답 비차단·첫 실패 후 서버 유지·주기 재시도·중복 실행 방지·구 파서 색인 이행 통과');
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
  }
}

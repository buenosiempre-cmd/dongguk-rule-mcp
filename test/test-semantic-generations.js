'use strict';
// Every mutation is confined to a new temporary tree; no public/model cache.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const s = require('../src/semantic.js');
const { withGenerationLock, GRACE_MS, LOCK_LEASE_MS } = require('../src/semantic-generations.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-retention-'));
const start = Date.now() - 10 * GRACE_MS;
let passed = 0;
function fixture() { return fs.mkdtempSync(path.join(root, 'case-')); }
function index(value) {
  const vectors = Float32Array.from([value, value + 1]);
  const hash = crypto.createHash('sha256').update(Buffer.from(vectors.buffer)).digest('hex');
  return { vectors, meta: { version: 1, textVersion: 3, model: s.DEFAULT_MODEL, dims: 2, rows: 1, articles: 1,
    builtAt: new Date(start).toISOString(), vectorHash: hash, vectorFile: `semantic-v1.${hash}.bin`,
    rules: [{ lawId: 1, historyId: 1, blockCount: 1, blocks: [[0, 'test-hash', 1]] }] } };
}
const A = index(1), B = index(2), C = index(3), D = index(4);
const folder = dir => path.join(dir, 'semantic');
const file = (dir, x) => path.join(folder(dir), x.meta.vectorFile);
const metaFile = dir => path.join(folder(dir), 'semantic-v1.json');
const save = (dir, x, time) => s.saveSemanticIndex(dir, x, { now: () => time });
const clean = (dir, time) => s.cleanupSemanticGenerations(dir, { now: () => time });
const pointer = dir => JSON.parse(fs.readFileSync(metaFile(dir)));
const status = dir => s.semanticStatus(dir).storage;
function three(dir) { save(dir, A, start); save(dir, B, start + 1); save(dir, C, start + 2); }
async function check(name, run) { await run(); passed++; console.log(`  ✅ ${name}`); }
function deadLock(dir) {
  const script = 'require(process.argv[1]).withGenerationLock(process.argv[2],()=>process.exit(0))';
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('../src/semantic-generations.js'), folder(dir)], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(fs.readFileSync(path.join(folder(dir), '.semantic-publish.lock')));
}
async function main() {
  await check('현재·직전은 보존하고 한 시간 지난 더 오래된 세대만 자동 정리', () => {
    const dir = fixture(); three(dir);
    assert(fs.existsSync(file(dir, A)), 'grace is based on retirement, not vector mtime');
    save(dir, D, start + 2 * GRACE_MS);
    assert(!fs.existsSync(file(dir, A))); assert(!fs.existsSync(file(dir, B)));
    assert(fs.existsSync(file(dir, C))); assert(fs.existsSync(file(dir, D)));
    const info = status(dir);
    assert.equal(info.generationCount, 2); assert.equal(info.managedBytes, 16);
    assert.equal(info.protectedGenerations, 2); assert.equal(info.lastCleanup.removedGenerations, 2);
    assert.equal(info.lastCleanup.removedBytes, 16);
    assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, D.meta.vectorHash);
  });
  await check('같은 내용 재게시와 A→B→C→A에서도 직전의 서로 다른 세대를 보존', () => {
    const dir = fixture(); three(dir); save(dir, A, start + 3);
    save(dir, A, start + 4);
    assert.equal(pointer(dir).retention.previous, C.meta.vectorFile);
    assert.equal(pointer(dir).retention.generations.find(r => r.file === A.meta.vectorFile).retiredAt, null);
    save(dir, B, start + 10 * GRACE_MS); save(dir, D, start + 10 * GRACE_MS + 1);
    assert(fs.existsSync(file(dir, A)), 'reactivated A receives a fresh retirement time');
    assert.equal(pointer(dir).retention.generations.find(r => r.file === A.meta.vectorFile).retiredAt, start + 10 * GRACE_MS);
  });
  await check('오래된 파일 수정시각과 무관하게 퇴역 시각부터 유예, 경계 전에는 보존', () => {
    const dir = fixture(); save(dir, A, start); fs.utimesSync(file(dir, A), new Date(0), new Date(0));
    save(dir, B, start + 100 * GRACE_MS); save(dir, C, start + 100 * GRACE_MS + 1);
    assert.equal(clean(dir, start + 101 * GRACE_MS - 1).removedGenerations, 0);
    assert.equal(clean(dir, start + 101 * GRACE_MS).removedGenerations, 1);
  });
  await check('미추적 해시 파일·예전 고정 파일·사용자 자료·세대처럼 생긴 폴더는 삭제하지 않음', () => {
    const dir = fixture(); three(dir);
    const unknown = file(dir, index(99)); fs.writeFileSync(unknown, '사용자 자료');
    const legacy = path.join(folder(dir), 'semantic-v1.bin'); fs.writeFileSync(legacy, '예전 세대');
    const namedDir = file(dir, index(98)); fs.mkdirSync(namedDir); fs.writeFileSync(path.join(namedDir, 'user.txt'), '보존');
    const user = path.join(folder(dir), 'notes.txt'); fs.writeFileSync(user, '보존');
    clean(dir, start + 2 * GRACE_MS);
    assert.equal(fs.readFileSync(unknown, 'utf8'), '사용자 자료');
    assert.equal(fs.readFileSync(legacy, 'utf8'), '예전 세대');
    assert.equal(fs.readFileSync(path.join(namedDir, 'user.txt'), 'utf8'), '보존');
    assert(fs.existsSync(user)); assert.equal(status(dir).untrackedGenerations, 2);
    assert.equal(status(dir).ignoredEntries, 1);
  });
  await check('기존 PR53의 소유 기록 없는 세대는 자동 소유권 획득·삭제하지 않음', () => {
    const dir = fixture(); save(dir, A, start);
    const old = pointer(dir); delete old.retention; fs.writeFileSync(metaFile(dir), JSON.stringify(old));
    save(dir, B, start + 1); save(dir, C, start + 2 * GRACE_MS);
    assert(fs.existsSync(file(dir, A))); assert.equal(status(dir).untrackedGenerations, 1);
  });
  await check('소유 기록이 있어도 파일이 교체되거나 같은 크기 내용이 바뀌면 보존', () => {
    for (const replaceInode of [false, true]) {
      const dir = fixture(); three(dir);
      if (replaceInode) { fs.renameSync(file(dir, A), path.join(folder(dir), 'original.saved')); }
      fs.writeFileSync(file(dir, A), Buffer.alloc(8, 42));
      const report = clean(dir, start + 2 * GRACE_MS);
      assert.equal(report.removedGenerations, 0); assert.equal(report.skippedGenerations, 1);
      assert.deepEqual(fs.readFileSync(file(dir, A)), Buffer.alloc(8, 42));
      assert.equal(status(dir).candidateHashesVerified, false);
    }
  });
  await check('파일 symlink·hardlink와 semantic 디렉터리 symlink는 정리하지 않음', () => {
    const outside = path.join(root, 'outside.bin'); fs.writeFileSync(outside, '외부 자료');
    const dir = fixture(); three(dir); fs.unlinkSync(file(dir, A)); fs.symlinkSync(outside, file(dir, A));
    assert.equal(clean(dir, start + 2 * GRACE_MS).removedGenerations, 0);
    assert(fs.lstatSync(file(dir, A)).isSymbolicLink()); assert.equal(fs.readFileSync(outside, 'utf8'), '외부 자료');
    const hard = fixture(); three(hard); fs.linkSync(file(hard, A), path.join(root, 'linked-copy'));
    assert.equal(clean(hard, start + 2 * GRACE_MS).removedGenerations, 0);
    const alias = fixture(); fs.symlinkSync(folder(hard), folder(alias));
    assert(clean(alias, start + 2 * GRACE_MS).errors.includes('SEMANTIC_UNSAFE_DIRECTORY'));
    assert.equal(status(alias).code, 'SEMANTIC_UNSAFE_DIRECTORY');
  });
  await check('내용 읽기 중 파일이 링크로 교체되어도 외부 파일을 삭제하지 않음', () => {
    const dir = fixture(); three(dir); const outside = path.join(root, 'swap-target'); fs.writeFileSync(outside, '외부');
    const read = fs.readFileSync;
    fs.readFileSync = function (name, ...args) {
      const result = read.call(this, name, ...args);
      if (name === file(dir, A)) { fs.unlinkSync(name); fs.symlinkSync(outside, name); }
      return result;
    };
    try { assert.equal(clean(dir, start + 2 * GRACE_MS).removedGenerations, 0); } finally { fs.readFileSync = read; }
    assert(fs.lstatSync(file(dir, A)).isSymbolicLink()); assert.equal(fs.readFileSync(outside, 'utf8'), '외부');
  });
  await check('손상·경로이탈·중복 소유 기록은 정리를 막고 정상 벡터 로딩은 유지', () => {
    for (const mutate of [m => m.retention.producer = 'user', m => m.retention.generations[0].file = '../user.bin',
      m => m.retention.generations.push(m.retention.generations[0]), m => m.retention.generations[0].retiredAt = -1]) {
      const dir = fixture(); three(dir); const meta = pointer(dir); mutate(meta); fs.writeFileSync(metaFile(dir), JSON.stringify(meta));
      assert(clean(dir, start + 2 * GRACE_MS).errors.includes('SEMANTIC_RETENTION_UNAVAILABLE'));
      assert(fs.existsSync(file(dir, A))); assert(s.loadSemanticIndex(dir));
    }
  });
  await check('미래 퇴역 시각은 삭제하지 않음', () => {
    const dir = fixture(); three(dir); const meta = pointer(dir);
    meta.retention.generations.find(r => r.file === A.meta.vectorFile).retiredAt = Date.now() + GRACE_MS;
    fs.writeFileSync(metaFile(dir), JSON.stringify(meta)); assert.equal(clean(dir, Date.now()).removedGenerations, 0);
  });
  await check('삭제 실패는 게시 성공을 뒤집지 않고 상태에 코드만 남김', () => {
    const dir = fixture(); three(dir); const unlink = fs.unlinkSync;
    fs.unlinkSync = function (name) { if (name === file(dir, A)) throw new Error('private path must not leak'); return unlink.call(this, name); };
    try { save(dir, D, start + 2 * GRACE_MS); } finally { fs.unlinkSync = unlink; }
    assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, D.meta.vectorHash);
    assert(status(dir).lastCleanup.errors.includes('SEMANTIC_GENERATION_DELETE_FAILED'));
    assert(!JSON.stringify(status(dir)).includes('private path'));
  });
  await check('status는 삭제 가능한 세대가 있어도 파일·잠금·포인터를 변경하지 않음', () => {
    const dir = fixture(); three(dir); const before = fs.readdirSync(folder(dir)).sort(), bytes = fs.readFileSync(metaFile(dir));
    const info = status(dir); assert.equal(info.graceExpiredCandidates, 1);
    assert.deepEqual(fs.readdirSync(folder(dir)).sort(), before); assert.deepEqual(fs.readFileSync(metaFile(dir)), bytes);
    assert(fs.existsSync(file(dir, A)));
  });
  await check('15분 전 활성 잠금·손상 잠금·EPERM은 회수하지 않음', () => {
    const dir = fixture(); three(dir);
    withGenerationLock(folder(dir), () => assert.throws(() => save(dir, D, start + 3), /SEMANTIC_PUBLISH_BUSY/));
    const lock = path.join(folder(dir), '.semantic-publish.lock'); fs.writeFileSync(lock, '{}');
    assert.equal(clean(dir, start + 2 * GRACE_MS).errors[0], 'SEMANTIC_PUBLISH_BUSY'); assert.equal(fs.readFileSync(lock, 'utf8'), '{}');
    fs.unlinkSync(lock); deadLock(dir); const old = fs.readFileSync(lock), kill = process.kill;
    process.kill = () => { throw Object.assign(new Error('permission'), { code: 'EPERM' }); };
    try { assert.equal(clean(dir, start + 2 * GRACE_MS).errors[0], 'SEMANTIC_PUBLISH_BUSY'); } finally { process.kill = kill; }
    assert.deepEqual(fs.readFileSync(lock), old);
  });
  await check('죽은 writer 잠금은 회수하지만 15분 전 회수 claim은 보존', () => {
    const dir = fixture(); three(dir); deadLock(dir); save(dir, D, start + 2 * GRACE_MS);
    assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, D.meta.vectorHash);
    const dead = deadLock(dir); const claim = path.join(folder(dir), `.semantic-reclaim.${dead.token}.lock`);
    fs.writeFileSync(claim, JSON.stringify(dead));
    assert.equal(clean(dir, Date.now()).errors[0], 'SEMANTIC_RECLAIM_BLOCKED'); assert(fs.existsSync(claim));
  });
  await check('15분 지난 PID 재사용·빈 파일·손상 잠금은 회수하고 신선한 잠금은 보호', () => {
    for (const contents of ['', '{broken', JSON.stringify({ producer: 'dongguk-rule-mcp/semantic-retention', pid: process.pid, token: 'a'.repeat(32) })]) {
      const dir = fixture(); three(dir); const lock = path.join(folder(dir), '.semantic-publish.lock');
      fs.writeFileSync(lock, contents);
      assert.throws(() => save(dir, D, start + 3), /SEMANTIC_PUBLISH_BUSY/);
      const old = new Date(Date.now() - LOCK_LEASE_MS - 1000); fs.utimesSync(lock, old, old);
      save(dir, D, start + 2 * GRACE_MS);
      assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, D.meta.vectorHash);
      assert(!fs.existsSync(lock));
    }
  });
  await check('15분 지난 중단 claim과 그 회수 claim도 안전하게 회수', () => {
    const dir = fixture(); three(dir); const dead = deadLock(dir);
    const claim = path.join(folder(dir), `.semantic-reclaim.${dead.token}.lock`);
    fs.writeFileSync(claim, '');
    const old = new Date(Date.now() - LOCK_LEASE_MS - 1000); fs.utimesSync(claim, old, old);
    const info = fs.lstatSync(claim);
    const key = crypto.createHash('sha256').update(`${path.basename(claim)}:${info.dev}:${info.ino}:${info.ctimeMs}`).digest('hex');
    const nested = path.join(folder(dir), `.semantic-reclaim.${key}.lock`); fs.writeFileSync(nested, '{broken'); fs.utimesSync(nested, old, old);
    save(dir, D, start + 3);
    assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, D.meta.vectorHash);
    assert(!fs.existsSync(claim)); assert(!fs.existsSync(nested));
  });
  await check('미래 시각 잠금과 만료된 symlink·hardlink 잠금은 회수하지 않음', () => {
    for (const kind of ['future', 'symlink', 'hardlink']) {
      const dir = fixture(); three(dir); const lock = path.join(folder(dir), '.semantic-publish.lock');
      const external = path.join(dir, 'user-lock-data'); fs.writeFileSync(external, '보존');
      if (kind === 'symlink') fs.symlinkSync(external, lock);
      else if (kind === 'hardlink') fs.linkSync(external, lock);
      else fs.writeFileSync(lock, '');
      const time = new Date(Date.now() + (kind === 'future' ? LOCK_LEASE_MS : -2 * LOCK_LEASE_MS));
      fs.utimesSync(lock, time, time);
      assert.throws(() => save(dir, D, start + 3), /SEMANTIC_PUBLISH_BUSY/);
      assert(fs.existsSync(lock)); assert.equal(fs.readFileSync(external, 'utf8'), '보존');
      assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, C.meta.vectorHash);
    }
  });
  await check('회수 뒤 재개한 옛 writer는 새 포인터·벡터를 덮어쓰지 못함', () => {
    const dir = fixture(); three(dir); const write = fs.writeFileSync; let paused = false;
    fs.writeFileSync = function(name, ...args) {
      const result = write.call(this, name, ...args);
      if (!paused && typeof name === 'string' && name.startsWith(metaFile(dir) + '.') && name.endsWith('.tmp')) {
        paused = true;
        const lock = path.join(folder(dir), '.semantic-publish.lock'), old = new Date(Date.now() - LOCK_LEASE_MS - 1000);
        fs.utimesSync(lock, old, old); save(dir, B, start + 4);
      }
      return result;
    };
    try { assert.throws(() => save(dir, D, start + 3), /SEMANTIC_LOCK_LOST/); } finally { fs.writeFileSync = write; }
    assert(paused); assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, B.meta.vectorHash);
    assert(!fs.existsSync(path.join(folder(dir), '.semantic-publish.lock')));
    assert(!fs.readdirSync(folder(dir)).some(name => name.endsWith('.tmp')));
  });
  await check('잠금 만료 뒤 재개한 정리자는 새 게시의 세대를 삭제하지 않음', () => {
    const dir = fixture(); three(dir); const read = fs.readFileSync; let paused = false;
    fs.readFileSync = function(name, ...args) {
      const result = read.call(this, name, ...args);
      if (!paused && name === file(dir, A)) {
        paused = true;
        const lock = path.join(folder(dir), '.semantic-publish.lock'), old = new Date(Date.now() - LOCK_LEASE_MS - 1000);
        fs.utimesSync(lock, old, old);
        // Acquire/release without publication to exercise the ownership guard itself.
        withGenerationLock(folder(dir), () => {});
      }
      return result;
    };
    let result;
    try { result = clean(dir, start + 2 * GRACE_MS); } finally { fs.readFileSync = read; }
    assert(result.errors.includes('SEMANTIC_LOCK_LOST')); assert(fs.existsSync(file(dir, A)));
  });
  await check('semantic symlink 게시·적재는 허용하되 자동·명시 정리 모두 건너뜀', () => {
    const dir = fixture(), target = fixture(); fs.mkdirSync(folder(target)); fs.symlinkSync(folder(target), folder(dir));
    const user = path.join(folder(target), 'notes.txt'); fs.writeFileSync(user, '보존');
    three(dir); save(dir, D, start + 2 * GRACE_MS);
    assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, D.meta.vectorHash);
    assert.equal(pointer(dir).retention.previous, C.meta.vectorFile);
    for (const x of [A, B, C, D]) assert(fs.existsSync(file(dir, x)));
    assert.equal(clean(dir, start + 3 * GRACE_MS).removedGenerations, 0);
    assert.equal(fs.readFileSync(user, 'utf8'), '보존');
    withGenerationLock(folder(target), () => assert.throws(() => save(dir, A, start + 4), /SEMANTIC_PUBLISH_BUSY/));
  });
  await check('유예보다 오래 멈춘 reader는 사라진 벡터 대신 최신 포인터를 한 번 재조회', () => {
    const dir = fixture(); save(dir, A, start); const read = fs.readFileSync; let first = true;
    fs.readFileSync = function (name, ...args) {
      const result = read.call(this, name, ...args);
      if (name === metaFile(dir) && first) { first = false; save(dir, B, start + 1); save(dir, C, start + 2 * GRACE_MS); }
      return result;
    };
    try { assert.equal(s.loadSemanticIndex(dir).meta.vectorHash, C.meta.vectorHash); } finally { fs.readFileSync = read; }
    assert(!fs.existsSync(file(dir, A)));
  });
  await check('죽은·만료·빈 잠금과 만료 claim의 동시 회수자가 새 writer 잠금을 탈취하지 않음', async () => {
    for (const mode of ['dead', 'expired', 'empty', 'claim']) {
    const dir = fixture(); three(dir); const dead = deadLock(dir);
    const lockFile = path.join(folder(dir), '.semantic-publish.lock');
    const old = new Date(Date.now() - LOCK_LEASE_MS - 1000);
    if (mode === 'expired') { fs.writeFileSync(lockFile, JSON.stringify({ ...dead, pid: process.pid })); fs.utimesSync(lockFile, old, old); }
    if (mode === 'empty') { fs.writeFileSync(lockFile, ''); fs.utimesSync(lockFile, old, old); }
    if (mode === 'claim') {
      const claim = path.join(folder(dir), `.semantic-reclaim.${dead.token}.lock`);
      fs.writeFileSync(claim, ''); fs.utimesSync(claim, old, old);
    }
    const expected = fs.readFileSync(lockFile, 'utf8');
    const go = path.join(dir, 'go'), active = path.join(dir, 'active');
    const script = `
      const fs=require('node:fs'),g=require(process.argv[1]); const [dir,ready,go,active,expected]=process.argv.slice(2);
      const read=fs.readFileSync; let waited=false;
      fs.readFileSync=function(name,...args){const result=read.call(this,name,...args);
        if(String(name).endsWith('.semantic-publish.lock')&&!waited&&String(result)===expected){
          waited=true;fs.writeFileSync(ready,'ready');while(!fs.existsSync(go))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
        }return result;};
      try{g.withGenerationLock(dir,()=>{let fd;try{fd=fs.openSync(active,'wx')}catch{throw Error('OVERLAP')}
        fs.closeSync(fd);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);fs.unlinkSync(active);});process.stdout.write('OK')}
      catch(e){process.stdout.write(e.message);process.exitCode=e.message.includes('OVERLAP')?2:0;}`;
    const children = [0, 1].map(i => {
      const ready = path.join(dir, `ready-${i}`);
      const child = spawn(process.execPath, ['-e', script, require.resolve('../src/semantic-generations.js'), folder(dir), ready, go, active, expected]);
      let out = ''; child.stdout.on('data', bytes => out += bytes); child.stderr.on('data', bytes => out += bytes);
      return { child, ready, done: new Promise(resolve => child.on('exit', code => resolve({ code, output: out }))) };
    });
    try {
      const deadline = Date.now() + 10000;
      while (!children.every(item => fs.existsSync(item.ready)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert(children.every(item => fs.existsSync(item.ready)), 'both reclaimers saw the same dead lock');
      fs.writeFileSync(go, 'go');
      const results = await Promise.all(children.map(item => item.done));
      assert(results.every(item => item.code === 0 && !item.output.includes('OVERLAP')), JSON.stringify(results));
      assert(results.some(item => item.output === 'OK'), JSON.stringify(results));
    } finally { children.forEach(item => { if (item.child.exitCode === null) item.child.kill(); }); }
    }
  });
  await check('실제 HTTP /status가 인증 후 세대 수·용량·유예·미추적 정보를 읽기만 함', async () => {
    const cache = fixture(), dir = path.join(cache, 'dongguk-rule-mcp', 'v2', 'public'); three(dir);
    const before = fs.readdirSync(folder(dir)).sort(), meta = fs.readFileSync(metaFile(dir));
    const net = require('node:net'), reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, [path.join(__dirname, '../src/index.js'), '--http', '--host', '127.0.0.1', '--port', String(port), '--token', 'retention-test'],
      { env: { ...process.env, XDG_CACHE_HOME: cache, DONGGUK_MCP_SEMANTIC: '0', DONGGUK_MCP_NO_CACHE: '0',
        DONGGUK_MCP_TOKEN_FILE: '', DONGGUK_MCP_WARM_RULES: '', DONGGUK_MCP_INDEX_REFRESH_HOURS: '0', DONGGUK_RULE_COOKIE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', bytes => errors += bytes);
    const exited = new Promise(resolve => child.on('exit', resolve));
    try {
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        try { ready = (await fetch(`${base}/health`)).ok; } catch {}
        if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(ready, errors);
      assert.equal((await fetch(`${base}/status`)).status, 401);
      const response = await fetch(`${base}/status`, { headers: { Authorization: 'Bearer retention-test' } });
      assert.equal(response.status, 200);
      const info = (await response.json()).semanticSearch.storage;
      assert.equal(info.generationCount, 3); assert.equal(info.totalBytes, 24);
      assert.equal(info.protectedGenerations, 2); assert.equal(info.graceExpiredCandidates, 1);
      assert.equal(info.untrackedGenerations, 0); assert.equal(info.graceMs, GRACE_MS);
      assert.equal(info.lastCleanupScope, 'process'); assert.equal(info.lastCleanup, null);
      assert.deepEqual(fs.readdirSync(folder(dir)).sort(), before); assert.deepEqual(fs.readFileSync(metaFile(dir)), meta);
    } finally { child.kill(); await exited; }
  });
  console.log(`\n벡터 세대 보존·정리 ${passed}개 검사 통과`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));

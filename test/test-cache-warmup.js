'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDiskCache } = require('../src/cache');
const { parseWarmRules, runWarmupCycle, startWarmup } = require('../src/warmup');
const { withProfile, withPublicWarmup, refreshAhead, requestCookie } = require('../src/runtime-context');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-cache-warmup-'));
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log('PASS ' + name); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function main() {
  let directory = path.join(root, 'public'), disabled = false, ahead = false, clock = Date.now();
  const cached = createDiskCache({ directory: () => directory, disabled: () => disabled, refreshAhead: () => ahead, now: () => clock });
  let calls = 0;
  const load = async () => ({ revision: ++calls });
  const get = fn => cached('history', '184', 600, fn || load);
  check('cold miss fetches and persists', (await get()).revision === 1);
  const filename = path.join(directory, 'history', '184.json');
  const timestamp = fs.statSync(filename).mtimeMs;
  check('fresh hit avoids source request', (await get()).revision === 1 && calls === 1);
  if (process.platform !== 'win32') check('persisted cache stays owner-only', (fs.statSync(filename).mode & 0o777) === 0o600);
  clock = timestamp + 479000; ahead = true;
  check('warmup does not refetch before 80 percent of TTL', (await get()).revision === 1 && calls === 1);

  clock = timestamp + 481000;
  const gate = deferred();
  const slowLoad = async () => { calls++; await gate.promise; return { revision: 2 }; };
  const refreshing = get(slowLoad);
  const joined = get(slowLoad);
  await Promise.resolve();
  check('parallel refreshes share one source operation', calls === 2);
  ahead = false;
  const served = await Promise.race([get(slowLoad), wait(50).then(() => null)]);
  check('foreground serves still-valid cache without awaiting warmup', served?.revision === 1);
  clock = timestamp + 601000;
  let expiredSettled = false;
  const expired = get(slowLoad).then(value => { expiredSettled = true; return value; });
  await wait(5);
  check('expired cache waits instead of returning stale evidence', !expiredSettled && calls === 2);
  gate.resolve();
  check('expiry and warmup converge on new revision', (await expired).revision === 2 && (await refreshing).revision === 2 && (await joined).revision === 2);

  clock = fs.statSync(filename).mtimeMs + 481000; ahead = true;
  let failures = 0;
  const fail = async () => { failures++; throw new Error('source unavailable'); };
  await assert.rejects(get(fail), /source unavailable/); passed++;
  ahead = false;
  check('failed refresh leaves valid evidence usable', (await get(fail)).revision === 2 && failures === 1);
  ahead = true;
  check('warmup retries are backed off while cache remains valid', (await get(fail)).revision === 2 && failures === 1);
  clock = fs.statSync(filename).mtimeMs + 601000; ahead = false;
  await assert.rejects(get(fail), /source unavailable/); passed++;
  check('expired evidence does not inherit background retry grace', failures === 2);
  check('failure releases in-flight slot for recovery', (await get(async () => ({ revision: 3 }))).revision === 3);

  clock = Date.now();
  fs.unlinkSync(filename);
  check('deleting disk cache invalidates immediately', (await get(async () => ({ revision: 4 }))).revision === 4);
  const untouched = fs.readFileSync(filename, 'utf8'); disabled = true;
  await get(async () => ({ revision: 5 }));
  check('cache bypass neither reads nor writes cached response', fs.readFileSync(filename, 'utf8') === untouched);
  disabled = false;

  const privateGate = deferred();
  directory = path.join(root, 'private');
  const privateLoad = get(async () => { await privateGate.promise; return { revision: 'private' }; });
  directory = path.join(root, 'public');
  check('public scope does not join a private fetch', (await get()).revision === 4);
  privateGate.resolve(); await privateLoad;
  check('in-flight write retains the captured cache directory', JSON.parse(fs.readFileSync(path.join(root, 'private/history/184.json'))).revision === 'private' && JSON.parse(fs.readFileSync(filename)).revision === 4);

  const previousCookie = process.env.DONGGUK_RULE_COOKIE;
  process.env.DONGGUK_RULE_COOKIE = 'test-cookie-not-a-real-credential';
  try {
    await withProfile('finance', async () => {
      check('ordinary finance context preserves its configured cookie', Boolean(requestCookie()) && !refreshAhead());
      await withPublicWarmup(async () => { await Promise.resolve(); check('warmup is always public and cookie-free after awaits', refreshAhead() && requestCookie() === ''); });
      check('warmup context does not leak into foreground', !refreshAhead() && Boolean(requestCookie()));
    });
  } finally { if (previousCookie === undefined) delete process.env.DONGGUK_RULE_COOKIE; else process.env.DONGGUK_RULE_COOKIE = previousCookie; }

  check('empty warmup config makes no work', parseWarmRules('').length === 0);
  check('configured names are trimmed and deduplicated', parseWarmRules('여비규정, 여비규정,위임전결규정').length === 2);
  assert.throws(() => parseWarmRules(Array.from({ length: 9 }, (_, i) => 'rule' + i).join(','))); passed++;
  assert.throws(() => parseWarmRules('a'.repeat(101))); passed++;
  let warmed = 0;
  const busy = await runWarmupCycle({ rules: ['a', 'b'], isBusy: () => true, warm: async () => { warmed++; } });
  check('busy server defers all new background lookups', busy.deferred === 2 && warmed === 0);
  const interrupted = await runWarmupCycle({ rules: ['a', 'b'], isBusy: () => warmed > 0, warm: async () => { warmed++; } });
  check('foreground arrival pauses the next warmup rule', interrupted.completed === 1 && interrupted.deferred === 1);
  const errors = await runWarmupCycle({ rules: ['a', 'b'], isBusy: () => false, warm: async name => { if (name === 'a') throw new Error('unavailable'); return { ok: false }; } });
  check('background failures are counted and contained', errors.failed === 2);
  let active = 0, peak = 0, started = 0;
  const scheduled = startWarmup({ rules: ['a'], initialDelayMs: 1, intervalMs: 1, isBusy: () => false, warm: async () => { started++; peak = Math.max(peak, ++active); await wait(10); active--; } });
  await wait(28); scheduled.stop(); await wait(20);
  const afterStop = started; await wait(15);
  check('timer cycles never overlap and stop schedules no more work', peak === 1 && started === afterStop && !scheduled.getStatus().running);
  console.log(`Cache/warmup regression: ${passed} passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));

'use strict';
const assert = require('node:assert/strict');
const current = require('../src/university-rules');
const baseline = require('./fixtures/ewha-title-main-8ca6659.json');
const { cases, run, hash } = require('./helpers/ewha-title-cases');

(async () => {
  assert.equal(baseline.commit, '8ca6659881529121957ac11bf08621c6052fc8a6');
  assert.equal(cases.length, baseline.rows.length);
  let passed = 0;
  for (const c of cases) {
    const expected = baseline.rows.find(x => x.id === c.id);
    assert(expected, c.id);
    const result = await run(current, c);
    // Hash the entire response and display, without removing coverage, status,
    // ranking or failures. The injected clock is identical to the main snapshot.
    assert.equal(hash(result.data), expected.responseSha256, `${c.id}: complete main response`);
    assert.equal(hash(result.formatted), expected.formattedSha256, `${c.id}: complete main display`);
    assert.deepEqual(result.calls, expected.calls, `${c.id}: exact main requests`);
    assert(!result.calls.some(x => x.endsWith('=1009')), `${c.id}: no fallback request`);
    passed++;
  }
  console.log(`Ewha title baseline regression: ${passed} passed / 0 failed`);
})().catch(e => { console.error(e); process.exitCode = 1; });

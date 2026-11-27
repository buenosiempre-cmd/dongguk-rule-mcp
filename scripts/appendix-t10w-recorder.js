'use strict';
// Observe the original scoreResponse result; do not alter questions, retrieval,
// scoring or return values. Run once per dataset to avoid overlapping IDs.
const fs = require('node:fs');
const path = require('node:path');
const benchmark = require(path.join(process.env.NL_WORKTREE, 'scripts/benchmark-natural-language.js'));
const score = benchmark.scoreResponse;
const rows = [];
benchmark.scoreResponse = (...args) => {
  const result = score(...args);
  rows.push(result);
  return result;
};
process.on('exit', code => {
  if (!code) fs.writeFileSync(process.env.APPENDIX_RECORD, JSON.stringify(rows));
});

'use strict';

// Public development draft; fixed MCP excerpts, no network or held-out material.
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const fixture = require('../test/fixtures/citation-evaluation-draft.json');
const { verifyRuleCitations } = require(path.resolve(process.argv[2] || path.join(__dirname, '../src/citations.js')));
const key = text => text.replace(/[\s·ㆍ‧•・]/g, '');
const deps = {
  searchRule: async name => ({ hits: fixture.rules.filter(rule => key(rule.title) === key(name)) }),
  resolveLatest: async id => fixture.rules.find(rule => rule.lawId === id),
  getRuleMarkdown: async id => fixture.rules.find(rule => rule.lawId === id)?.markdown,
};

(async () => {
  const rows = [];
  for (const item of fixture.cases) {
    const result = await verifyRuleCitations(item.input, deps);
    const actual = {
      citations: result.citations.map(({ ruleName, article, status }) => ({ ruleName, article, status })),
      summary: Object.fromEntries(Object.keys(item.expected.summary).map(key => [key, result.summary[key]])),
    };
    rows.push({ id: item.id, passed: isDeepStrictEqual(actual, item.expected), actual, expected: item.expected });
  }
  const failed = rows.filter(row => !row.passed).length;
  console.log(JSON.stringify({ purpose: fixture.purpose, total: rows.length, passed: rows.length - failed, failed, rows }, null, 2));
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });

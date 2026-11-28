'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const dir = path.join(__dirname, 'fixtures/law-tool-scoring');
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json')));
const sources = read('sources');
const norm = s => s.replace(/\s/g, '');
assert.equal(sources.length, 10);
assert.equal(new Set(sources.map(s => s.id)).size, 10);
for (const source of sources) {
  assert.match(source.sourceUrl, /^https:\/\/rule\.dongguk\.edu\//);
  assert.match(source.captureSha256, /^[a-f0-9]{64}$/);
  assert(source.markdown && source.enforcementDate && source.revisedAt);
}
for (const [name, tool] of [['upper-laws','get_rule_upper_laws'],['references','get_rule_references']]) {
  const suite = read(name);
  assert.equal(suite.status, 'draft');
  assert.equal(suite.cases.length, 20);
  assert.equal(new Set(suite.cases.map(c => c.id)).size, 20);
  for (const c of suite.cases) {
    const source = sources.find(s => s.id === c.source);
    assert(source, c.id);
    assert.equal(c.tool, tool);
    assert.equal(c.arguments.law_id, source.lawId);
    assert.equal(c.arguments.history_id, source.historyId);
    assert(Object.keys(c.expected).length && c.rationale && c.condition);
    for (const law of c.expectedLaws) {
      assert(norm(source.markdown).includes(norm(law.citedName)), `${c.id}: law absent from source`);
      for (const article of law.articles) assert(norm(source.markdown).includes(norm(article)), `${c.id}: article absent from source`);
    }
  }
}
const legal = read('legal-captures');
assert.equal(legal.provider, 'korean-law MCP');
assert(legal.records.some(r => r.args.mst === '291447' && r.args.efYd === '20261027'));
console.log('Law tool draft: 40 cases / 10 public source excerpts validated (not an accuracy score)');

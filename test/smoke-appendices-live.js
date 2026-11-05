'use strict';
// Focused live regression for the original HWP, not separate attachments.
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { extractAppendices } = require('../src/appendices.js');
const version = require('../package.json').version;
const client = new Client({ name: 'appendix-live-regression', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(__dirname, '../src/index.js')],
  env: { ...process.env, DONGGUK_MCP_PROFILE:'rules', DONGGUK_MCP_NO_CACHE:'1', DONGGUK_RULE_COOKIE:'', DONGGUK_FINANCE_PACK_PATH:'', DONGGUK_LEGAL_MCP_ENABLED:'0' },
  stderr: 'pipe',
});
async function main() {
  await client.connect(transport); transport.stderr?.resume();
  assert.equal(client.getServerVersion().version, version);
  const cases = [
    { query:'여비규정 별표를 보여줘', defaults:true, keys:['별표 1','별표 2','별표 3'] },
    { query:'여비규정 별표를 보여줘', keys:['별표 1','별표 2','별표 3'] },
    { query:'여비규정 별표1을 보여줘', keys:['별표 1'] },
    { query:'여비규정 국외 별표를 보여줘', keys:['별표 2','별표 3'] },
    { query:'여비규정 별표99를 보여줘', keys:[], missing:true },
  ];
  for (const item of cases) {
    const response = await client.callTool({ name:'lookup_dongguk_rule', arguments:{ query:item.query, ...(item.defaults ? {} : {max_sections:12,max_chars:30000}) } }, undefined, {timeout:60000});
    const result = response.structuredContent;
    assert.equal(result?.ok, true);
    const rule = result.data.rules[0];
    assert.equal(rule.lawId, 184);
    assert.equal(rule.warning, null);
    assert(rule.sourceType.includes('HWP'));
    const appendices = extractAppendices(rule.excerpt.text);
    assert.deepEqual(appendices.map(x => x.key), item.keys);
    if (item.missing) {
      assert.equal(rule.evidenceStatus, 'partial');
      assert(rule.incompleteReasons.includes('APPENDIX_NOT_FOUND'));
      assert.deepEqual(rule.excerpt.missingAppendices, ['별표99']);
    } else {
      assert(!rule.incompleteReasons.includes('NO_MATCHING_EXCERPT'));
      if (!item.defaults) assert.equal(rule.evidenceStatus, 'retrieved');
      const first = appendices.find(x => x.key === '별표 1');
      if (first) for (const mark of ['①','②','③','④','⑤','⑥']) assert(first.text.includes(mark));
    }
    console.log(JSON.stringify({ query:item.query, defaults:!!item.defaults, version, lawId:rule.lawId, historyId:rule.historyId, appendices:item.keys, status:rule.evidenceStatus, reasons:rule.incompleteReasons }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await client.close(); await transport.close(); });

'use strict';
// Exercise the shipped MCP process and production handlers, with disk cache off.
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const version = require('../package.json').version;
const keywordIndex = process.argv.indexOf('--keyword');
const keyword = keywordIndex < 0 ? '여비규정' : process.argv[keywordIndex + 1];
const client = new Client({ name: 'dongguk-live-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(__dirname, '../src/index.js')],
  env: { ...process.env, DONGGUK_MCP_PROFILE:'rules', DONGGUK_MCP_NO_CACHE: '1', DONGGUK_RULE_COOKIE: '', DONGGUK_FINANCE_PACK_PATH: '', DONGGUK_LEGAL_MCP_ENABLED: '0' },
  stderr: 'pipe',
});
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log(`PASS ${name}`); };
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.equal(response.structuredContent?.ok, true, `${name}: ${response.structuredContent?.error?.code || 'invalid response'}`);
  return response.structuredContent.data;
}
async function main() {
  assert.ok(keyword, '--keyword requires a value');
  await client.connect(transport); transport.stderr?.resume();
  check('MCP initialize version matches package', client.getServerVersion()?.version === version);
  const list = await client.listTools();
  check('10 tools available', list.tools.length === 10);
  const lookup = await call('lookup_dongguk_rule', { rule_keyword: keyword, include_history: true, max_chars: 2500 });
  const rule = lookup.rules[0];
  check('lookup returns parsed HWP (no fallback)', !rule.warning && rule.sourceType.includes('HWP') && rule.excerpt.text.trim().length > 0);
  const history = (await call('list_rule_history', { law_id: rule.lawId })).history;
  check('lookup history ID and revision date match live latest', history[0].historyId === rule.historyId && history[0].revisedAt === rule.revisedAt);
  const content = await call('get_rule_content', { law_id: rule.lawId, history_id: rule.historyId });
  check('HTML content is nonempty', content.contentMarkdown.trim().length > 0);
  const toc = await call('get_rule_toc', { law_id: rule.lawId, history_id: rule.historyId });
  check('TOC has headings', toc.headings.length > 0);
  const rejected = await client.callTool({ name: 'get_rule_toc', arguments: { law_id: rule.lawId, history_id: 9007199254740991 } });
  check('foreign history rejected through MCP', rejected.structuredContent?.error?.code === 'HISTORY_NOT_FOUND');
  if (history.length > 1) {
    const comparison = await call('compare_rule_versions', { law_id: rule.lawId, from_history_id: history[1].historyId });
    check('comparison uses latest and declares HTML scope', comparison.toHistoryId === rule.historyId && comparison.comparisonScope === 'html_articles');
  }
  const deep = await call('search_rule_deep', { query: keyword.replace(/규정$/, ''), top: 1, per_doc: 1 });
  const doc = deep.documents[0];
  const deepHistory = (await call('list_rule_history', { law_id: doc.lawId })).history;
  check('deep search uses live latest revision', !doc.error && doc.historyId === deepHistory[0].historyId && doc.revisedAt === deepHistory[0].revisedAt);
  console.log(JSON.stringify({ version, checks, cache: 'disabled', cookie: 'none', lawId: rule.lawId, historyId: rule.historyId, revisedAt: rule.revisedAt, sourceUrl: rule.sourceUrl }));
}
main().catch(error => { console.error(`FAIL live MCP smoke: ${error.message}`); process.exitCode = 1; })
  .finally(async () => { await client.close(); await transport.close(); });

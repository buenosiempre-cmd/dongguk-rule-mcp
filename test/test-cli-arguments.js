'use strict';

// Exercise the real entrypoint: malformed options must exit before any server
// starts, and diagnostics must never echo a supplied credential.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const entry = path.join(__dirname, '../src/index.js');
const version = require('../package.json').version;
let count = 0;
function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH || '', ...extraEnv } });
}
function check(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
function rejected(args, pattern, extraEnv = {}) {
  const result = run(args, extraEnv);
  assert.equal(result.status, 1, `must exit before starting a server: ${JSON.stringify(args.filter(x => !x.includes('SYNTHETIC')))}`);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes('SYNTHETIC_CLI_SECRET'));
}

check('missing token cannot turn the next flag into an administrator token', () => {
  rejected(['--http','--host','127.0.0.1','--profile','finance','--token','--port','38479'], /--token/);
});
check('explicit empty token never falls back to an environment token', () => {
  for (const value of ['', ' ', '--profile', '-h']) rejected(['--http','--token',value], /--token/, { DONGGUK_MCP_TOKEN: 'SYNTHETIC_CLI_SECRET' });
  rejected(['--http','--token'], /--token/, { DONGGUK_MCP_TOKEN: 'SYNTHETIC_CLI_SECRET' });
});
check('all valued options reject missing, empty, and next-flag values', () => {
  for (const name of ['--profile','--port','--host','--token-file','--print-config']) {
    for (const value of [undefined, '', '--doctor']) rejected(value === undefined ? [name] : [name, value], new RegExp(name));
  }
});
check('port must be a decimal integer between 1 and 65535', () => {
  for (const value of ['0','-1','65536','1.5','1e3','Infinity','abc']) rejected(['--port',value], /--port/);
  for (const value of ['1','65535']) assert.equal(run(['--port',value,'--version']).stdout.trim(), version);
});
check('host accepts bare IP/DNS names and rejects URLs, paths, whitespace, and malformed IPs', () => {
  for (const value of ['https://127.0.0.1','127.0.0.1:3845','host/path','white space','999.1.1.1','-host','host..local']) rejected(['--host',value], /--host/);
  for (const value of ['127.0.0.1','::1','0.0.0.0','localhost','cop.example.edu']) assert.equal(run(['--host',value,'--version']).stdout.trim(), version);
});
check('HTTP environment host and port are also validated before startup', () => {
  rejected(['--http'], /HTTP port/, { DONGGUK_MCP_PORT: '65536' });
  rejected(['--http'], /HTTP host/, { DONGGUK_MCP_HOST: 'http://localhost' });
});
check('unknown or duplicated options fail without exposing supplied values', () => {
  rejected(['--token=SYNTHETIC_CLI_SECRET'], /알 수 없는 옵션/);
  rejected(['--token','SYNTHETIC_CLI_SECRET','--token','other'], /한 번만/);
  rejected(['--profile','administrator'], /--profile/);
  rejected(['--doctor'], /profile/, { DONGGUK_MCP_PROFILE: 'administrator' });
});
check('offline doctor and JSON output remain usable', () => {
  const result = run(['--doctor','--json']);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.profile, 'rules');
  assert.equal(report.upstreamChecked, false);
});
check('client configuration and explicit finance profile remain usable', () => {
  for (const client of ['claude','cursor']) {
    const result = run(['--print-config',client,'--profile','finance']);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).mcpServers['dongguk-rule'].args.at(-1), 'finance');
  }
  const result = run(['--print-config','codex']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[mcp_servers\.dongguk-rule\]/);
});
console.log(`CLI argument regression: ${count} passed`);

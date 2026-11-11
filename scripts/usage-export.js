#!/usr/bin/env node
'use strict';
// Export new dongguk-rule-mcp usage log rows since the saved cursor.
//   usage-export.js [--limit N]  -> prints {"count":n,"rows":[...]} and records a pending cursor
//   usage-export.js --commit     -> advances the cursor to the last exported (pending) position
//   usage-export.js --status     -> shows cursor/pending and unread byte counts
// Only complete lines are exported. Running export again without --commit
// re-prints the same rows (safe retry). No credentials are involved.
const fs = require('fs');
const path = require('path');
const DIR = process.env.DONGGUK_MCP_USAGE_LOG_DIR || path.join(process.env.HOME, '.local/share/dongguk-rule-mcp/logs');
const CURSOR = path.join(DIR, '.export-cursor.json');
const PENDING = path.join(DIR, '.export-pending.json');
const args = process.argv.slice(2);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); fs.renameSync(tmp, f); };
const files = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR) : []).filter(n => /^usage-\d{4}-\d{2}\.jsonl$/.test(n)).sort();

if (args.includes('--commit')) {
  const pending = readJson(PENDING);
  if (!pending) { console.log(JSON.stringify({ committed: false, reason: 'no pending export' })); process.exit(0); }
  writeJson(CURSOR, pending.offsets);
  fs.unlinkSync(PENDING);
  console.log(JSON.stringify({ committed: true, rows: pending.count, offsets: pending.offsets }));
  process.exit(0);
}

const cursor = readJson(CURSOR) || {};
if (args.includes('--status')) {
  const unread = {};
  for (const n of files()) unread[n] = fs.statSync(path.join(DIR, n)).size - (cursor[n] || 0);
  console.log(JSON.stringify({ dir: DIR, cursor, pending: readJson(PENDING), unreadBytes: unread }));
  process.exit(0);
}

const li = args.indexOf('--limit');
const limit = li >= 0 ? Math.max(1, parseInt(args[li + 1], 10) || 100) : 100;
const rows = [];
const offsets = { ...cursor };
outer: for (const n of files()) {
  const file = path.join(DIR, n);
  let pos = cursor[n] || 0;
  const size = fs.statSync(file).size;
  if (pos >= size) continue;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - pos);
  fs.readSync(fd, buf, 0, buf.length, pos);
  fs.closeSync(fd);
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    if (rows.length >= limit) break outer;
    const line = buf.slice(start, i).toString('utf8').trim();
    start = i + 1;
    offsets[n] = pos + start;
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
}
const truncated = rows.length >= limit;
if (rows.length) writeJson(PENDING, { offsets, count: rows.length, at: new Date().toISOString() });
console.log(JSON.stringify({ count: rows.length, more: truncated, rows }));

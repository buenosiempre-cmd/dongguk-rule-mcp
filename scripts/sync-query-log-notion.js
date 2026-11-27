'use strict';
// Uploads the local question log (DONGGUK_MCP_QUERY_LOG_DIR/queries-YYYY-MM.jsonl)
// to a Notion database. Runs outside the MCP request path (cron/LaunchAgent).
// Token: NOTION_QUERY_LOG_TOKEN (env only, never printed). Database: NOTION_QUERY_LOG_DATABASE_ID or --database-id.
// Duplicate prevention: per-file byte offset in a 0600 state file, advanced after each created page.
const fs = require('node:fs');
const path = require('node:path');
const { pruneQueryLog, retentionDays, maskQuery } = require('../src/query-log');
const { validateQuestions } = require('./evaluate-natural-language');

const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';
const PROPS = Object.freeze({ question: '질문', at: '시각', tool: '도구', endpoint: '경로', result: '결과', count: '결과 건수', rule: '찾은 규정', duration: '소요시간(ms)', quality: '답 품질', memo: '메모', expected: '정답 규정', id: '로그 ID' });
const ENDPOINT_LABELS = { '/mcp/rules': '공개(/mcp/rules)', '/mcp': '회원(/mcp)' };

function parse(argv) {
  const o = { max: 500, dryRun: false, prune: false, pruneNotion: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error('MISSING_VALUE ' + a); return v; };
    if (a === '--dir') o.dir = next();
    else if (a === '--database-id') o.databaseId = next();
    else if (a === '--state') o.state = next();
    else if (a === '--max') { o.max = Number(next()); if (!Number.isInteger(o.max) || o.max < 1 || o.max > 10000) throw new Error('INVALID_MAX'); }
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--prune') o.prune = true;
    else if (a === '--prune-notion') o.pruneNotion = true;
    else if (a === '--export-wrong') o.exportWrong = next();
    else throw new Error('UNKNOWN_OPTION ' + a);
  }
  return o;
}

const text = (value, max = 2000) => [{ type: 'text', text: { content: String(value).slice(0, max) } }];
const select = value => value ? { select: { name: String(value).replace(/,/g, ' ').slice(0, 100) } } : { select: null };

function toProperties(entry) {
  return {
    [PROPS.question]: { title: text(entry.query, 300) },
    [PROPS.at]: { date: { start: entry.ts } },
    [PROPS.tool]: select(entry.tool),
    [PROPS.endpoint]: select(ENDPOINT_LABELS[entry.endpoint] || entry.endpoint),
    [PROPS.result]: select(entry.resultStatus || entry.status),
    [PROPS.count]: { number: Number.isFinite(entry.resultCount) ? entry.resultCount : null },
    [PROPS.rule]: { rich_text: entry.topRule ? text(entry.topRule, 200) : [] },
    [PROPS.duration]: { number: Number.isFinite(entry.durationMs) ? entry.durationMs : null },
    [PROPS.quality]: select('미검토'),
    [PROPS.id]: { rich_text: text(entry.id || '', 64) },
  };
}

// Re-mask on upload too, so rows written by older/other builds cannot carry raw numbers.
function sanitize(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.query !== 'string' || typeof entry.ts !== 'string') return null;
  return { ...entry, query: maskQuery(entry.query).text, topRule: typeof entry.topRule === 'string' ? maskQuery(entry.topRule, { maxChars: 100 }).text : null };
}

function notionClient({ token, fetchImpl, sleep }) {
  return async function request(method, url, body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetchImpl(API + url, { method, headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (res.status === 429 || res.status >= 500) { await sleep(Math.min(30, Number(res.headers?.get?.('retry-after')) || 2 ** attempt) * 1000); continue; }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`NOTION_${res.status}_${typeof json.code === 'string' ? json.code : 'error'}`);
      return json;
    }
    throw new Error('NOTION_RETRY_EXHAUSTED');
  };
}

async function readState(file) {
  try { const s = JSON.parse(await fs.promises.readFile(file, 'utf8')); return s && typeof s.files === 'object' ? s : { version: 1, files: {} }; }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, files: {} }; throw new Error('STATE_UNREADABLE'); }
}
async function writeState(file, state) {
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}

// Yields complete (newline-terminated) lines after `offset` with the byte offset after each.
async function pendingLines(file, offset) {
  const buf = await fs.promises.readFile(file);
  const start = offset > buf.length ? 0 : offset; // file rotated/replaced: restart
  const out = [];
  let pos = start;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    out.push({ line: buf.subarray(pos, nl).toString('utf8'), end: nl + 1 });
    pos = nl + 1;
  }
  return { lines: out, restarted: start !== offset };
}

async function sync({ dir, databaseId, statePath, max, dryRun, request, sleep, log }) {
  const state = await readState(statePath);
  let names = [];
  try { names = (await fs.promises.readdir(dir)).filter(n => /^queries-\d{4}-\d{2}\.jsonl$/.test(n)).sort(); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('LOG_DIR_UNREADABLE'); }
  const summary = { files: names.length, created: 0, skipped: 0, pending: 0 };
  for (const name of names) {
    const fileState = state.files[name] || { offset: 0 };
    const { lines } = await pendingLines(path.join(dir, name), fileState.offset || 0);
    for (const { line, end } of lines) {
      if (summary.created >= max) { summary.pending++; continue; }
      let entry; try { entry = sanitize(JSON.parse(line)); } catch { entry = null; }
      if (!entry) { summary.skipped++; }
      else if (dryRun) { summary.created++; if (summary.created <= 5) log(`  [미리보기] ${entry.ts} ${entry.tool} ${entry.query}`); continue; }
      else {
        await request('POST', '/pages', { parent: { database_id: databaseId }, properties: toProperties(entry) });
        summary.created++;
        await sleep(350); // Notion average limit is about 3 requests/second
      }
      state.files[name] = { offset: end };
      if (!dryRun) await writeState(statePath, { ...state, lastRunAt: new Date().toISOString() });
    }
  }
  return summary;
}

async function queryAll(request, databaseId, filter) {
  const rows = []; let cursor;
  do {
    const page = await request('POST', `/databases/${databaseId}/query`, { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    rows.push(...(page.results || [])); cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return rows;
}
const plain = prop => (prop?.title || prop?.rich_text || []).map(t => t.plain_text ?? t.text?.content ?? '').join('').trim();

// 답 품질=오답 rows → evaluator question set: [질문, [정답 규정…]|null, null].
async function exportWrong({ request, databaseId, out }) {
  const rows = await queryAll(request, databaseId, { property: PROPS.quality, select: { equals: '오답' } });
  const seen = new Set(), questions = [];
  for (const row of rows) {
    const q = plain(row.properties?.[PROPS.question]);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const titles = plain(row.properties?.[PROPS.expected]).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    questions.push([q, titles.length ? titles : null, null]);
  }
  if (questions.length) validateQuestions(questions);
  await fs.promises.writeFile(out, JSON.stringify(questions, null, 2) + '\n', { mode: 0o600 });
  return { exported: questions.length, unscored: questions.filter(q => q[1] === null).length };
}

async function pruneNotion({ request, databaseId, days, now, sleep }) {
  const before = new Date(now - days * 86400000).toISOString();
  const rows = await queryAll(request, databaseId, { property: PROPS.at, date: { before } });
  for (const row of rows) { await request('PATCH', `/pages/${row.id}`, { archived: true }); await sleep(350); }
  return { archived: rows.length, before };
}

async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.log, now = Date.now() } = {}) {
  const o = parse(argv);
  const dir = o.dir || env.DONGGUK_MCP_QUERY_LOG_DIR;
  if (!dir) throw new Error('DONGGUK_MCP_QUERY_LOG_DIR 또는 --dir가 필요합니다.');
  const databaseId = o.databaseId || env.NOTION_QUERY_LOG_DATABASE_ID;
  const days = retentionDays(env.DONGGUK_MCP_QUERY_LOG_RETENTION_DAYS);
  const statePath = o.state || env.DONGGUK_MCP_QUERY_LOG_SYNC_STATE || path.join(dir, 'notion-sync-state.json');
  const result = {};
  const needsNotion = !o.dryRun || o.exportWrong || o.pruneNotion;
  let request;
  if (needsNotion) {
    const token = (env.NOTION_QUERY_LOG_TOKEN || '').trim();
    if (!token) throw new Error('NOTION_QUERY_LOG_TOKEN 환경변수가 필요합니다.');
    if (!databaseId || !/^[0-9a-f-]{32,36}$/i.test(databaseId)) throw new Error('노션 데이터베이스 ID(NOTION_QUERY_LOG_DATABASE_ID 또는 --database-id)가 필요합니다.');
    request = notionClient({ token, fetchImpl, sleep });
  }
  if (o.exportWrong) result.export = await exportWrong({ request, databaseId, out: o.exportWrong });
  else result.sync = await sync({ dir, databaseId, statePath, max: o.max, dryRun: o.dryRun, request, sleep, log });
  if (o.prune) result.prunedFiles = await pruneQueryLog({ dir, days, now });
  if (o.pruneNotion) result.pruneNotion = await pruneNotion({ request, databaseId, days, now, sleep });
  log(JSON.stringify(result));
  return result;
}

if (require.main === module) main().catch(e => { console.error('질문 로그 동기화 실패: ' + String(e.message).replace(/(secret_|ntn_)[A-Za-z0-9]+/g, '[토큰]')); process.exitCode = 1; });
module.exports = { parse, toProperties, sanitize, sync, exportWrong, pruneNotion, main, PROPS };

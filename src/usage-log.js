'use strict';
// Adapted from agent/usage-log: opt-in, response-finish observation and asynchronous
// JSONL append. Unlike the old branch, no arguments, IPs, titles, headers or bodies
// are persisted. Only fixed-schema counters / allowlisted codes leave memory.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { SOURCES, safeCode } = require('./university-rules');
const keys = new Set(SOURCES.filter(s => s.key !== 'dongguk').map(s => s.key));
const statuses = new Set(['retrieved', 'partial', 'unavailable', 'no_match_in_scope', 'unsupported']);
const kst = ms => new Date(ms + 9 * 3600000).toISOString().replace('Z', '+09:00');
const code = value => safeCode({ code: value });
function summarizeComparison(data) {
  if (!Array.isArray(data?.columns)) return [];
  return data.columns.filter(c => keys.has(c?.university)).slice(0, 19).map(c => ({
    university: c.university, status: statuses.has(c.status) ? c.status : 'unavailable',
    codes: [...new Set([c.code, ...(Array.isArray(c.failures) ? c.failures.map(f => f?.code) : [])].filter(Boolean).map(code))],
  }));
}
function createUsageLog({ dir } = {}) {
  if (!dir) return null;
  let chain = Promise.resolve(), queued = 0;
  function track(req, res, endpoint, startedAt, body) {
    try {
      if (body?.method !== 'tools/call' || Array.isArray(body)) return;
      const tool = body.params?.name === 'compare_university_rules' ? 'compare_university_rules' : 'other';
      let chunks = [], size = 0, overflow = false, done = false;
      const keep = (chunk, encoding) => {
        if (overflow || chunk == null || typeof chunk === 'function') return;
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
        size += b.length;
        if (size > 8 * 1024 * 1024) { overflow = true; chunks = []; } else chunks.push(b);
      };
      const write = res.write, end = res.end;
      res.write = function(chunk, encoding, cb) { try { keep(chunk, encoding); } catch { overflow = true; chunks = []; } return write.call(this, chunk, encoding, cb); };
      res.end = function(chunk, encoding, cb) { try { keep(chunk, encoding); } catch { overflow = true; chunks = []; } return end.call(this, chunk, encoding, cb); };
      const finish = () => {
        if (done) return; done = true;
        if (queued >= 128) { chunks = []; return; }
        queued++;
        const ts = kst(startedAt), durationMs = Math.max(0, Date.now() - startedAt), httpStatus = res.statusCode;
        chain = chain.then(async () => {
          let message;
          if (!overflow) {
            const text = Buffer.concat(chunks).toString('utf8');
            const json = text.trimStart().startsWith('{') ? text : text.split('\n').filter(l => l.startsWith('data:')).at(-1)?.slice(5);
            try { message = JSON.parse(json); } catch {}
          }
          chunks = [];
          const result = message?.result, sc = result?.structuredContent;
          const entry = { schemaVersion: 1, ts, tool, durationMs, httpStatus,
            status: httpStatus >= 400 || message?.error || result?.isError || sc?.ok === false ? 'error' : message ? 'ok' : 'unobserved',
            capture: overflow ? 'oversize' : message ? 'parsed' : 'unparsed',
            universities: tool === 'compare_university_rules' ? summarizeComparison(sc?.data) : [] };
          await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
          await fs.promises.appendFile(path.join(dir, `usage-${ts.slice(0, 7)}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 });
        }).catch(() => {}).finally(() => { queued--; chunks = []; });
      };
      res.once('finish', finish); res.once('close', finish);
    } catch {} // Logging can never change an MCP response.
  }
  return { track, flush: () => chain };
}
async function aggregateUsage({ dir, since, until = Date.now() } = {}) {
  const start = since === undefined ? until - 7 * 86400000 : Date.parse(since);
  if (!Number.isFinite(start) || !Number.isFinite(until) || start > until) throw new Error('INVALID_USAGE_PERIOD');
  const result = { status: 'no_logs', since: new Date(start).toISOString(), until: new Date(until).toISOString(), calls: 0, malformedLines: 0, unobservedCalls: 0, universities: [] };
  if (!dir) return result;
  let files;
  try { files = (await fs.promises.readdir(dir)).filter(n => /^usage-\d{4}-\d{2}\.jsonl$/.test(n)).sort(); }
  catch (e) { if (e.code === 'ENOENT') return result; throw new Error('USAGE_LOG_READ_FAILED'); }
  const groups = new Map();
  for (const file of files) {
    const stream = fs.createReadStream(path.join(dir, file), { encoding: 'utf8' });
    try {
      for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
        let row; try { row = JSON.parse(line); } catch { result.malformedLines++; continue; }
        const at = Date.parse(row.ts);
        if (row.tool !== 'compare_university_rules' || !Number.isFinite(at) || at < start || at > until) continue;
        result.calls++; result.status = 'available';
        if (!Array.isArray(row.universities) || !row.universities.length) result.unobservedCalls++;
        for (const c of Array.isArray(row.universities) ? row.universities : []) {
          if (!keys.has(c?.university)) continue;
          const g = groups.get(c.university) || { university: c.university, calls: 0, failedCalls: 0, codes: {} };
          g.calls++;
          const codes = [...new Set((Array.isArray(c.codes) ? c.codes : []).map(code))];
          if (!codes.length && ['unavailable','no_match_in_scope','unsupported'].includes(c.status)) codes.push(c.status === 'no_match_in_scope' ? 'NO_MATCH_IN_SCOPE' : 'UNAVAILABLE');
          if (codes.length) g.failedCalls++;
          for (const c of codes) g.codes[c] = (g.codes[c] || 0) + 1;
          groups.set(c.university, g);
        }
      }
    } catch { throw new Error('USAGE_LOG_READ_FAILED'); }
    finally { stream.destroy(); }
  }
  result.universities = [...groups.values()].sort((a,b) => a.university.localeCompare(b.university));
  return result;
}
module.exports = { createUsageLog, summarizeComparison, aggregateUsage, kst };

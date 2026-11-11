'use strict';

// Opt-in usage log for tools/call requests (enabled only when a log directory
// is configured). One JSON line per call, appended asynchronously to
// <dir>/usage-YYYY-MM.jsonl. Logging failures are swallowed so they can never
// affect MCP responses. Credentials, headers and response bodies are not stored.
const fs = require('fs');
const path = require('path');
const net = require('net');

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_CHARS = 300;
const MAX_TITLES = 3;

function kstParts(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return {
    iso: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}+09:00`,
    month: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`,
  };
}

// Full client IP (not grouped). CF-Connecting-IP is trusted only from loopback peers.
function realClientIp(req, trustProxy = true) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:(?=\d+\.)/i, '') || 'unknown';
  const loop = peer === '::1' || (net.isIPv4(peer) && peer.startsWith('127.'));
  if (trustProxy && loop) {
    const h = req.headers['cf-connecting-ip'];
    const v = typeof h === 'string' ? h.trim() : '';
    if (net.isIP(v)) return v;
  }
  return peer;
}

function clip(value, n = MAX_QUERY_CHARS) {
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function queryText(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const key of ['query', 'keyword', 'rule_keyword', 'terms', 'text', 'grep', 'date']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() && !parts.includes(v.trim())) parts.push(v.trim());
  }
  for (const key of ['law_id', 'history_id', 'from_history_id', 'to_history_id', 'article', 'chapter']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') parts.push(`${key}=${args[key]}`);
  }
  return clip(parts.join(' | '));
}

// "여 비 규 정" -> "여비규정" (rule content headers space out short titles).
function tidyTitle(t) {
  const s = String(t || '').trim();
  return /^(\S\s)+\S$/.test(s) ? s.replace(/\s/g, '') : s;
}

const LIST_KEYS = ['rules', 'documents', 'results', 'candidates', 'matches', 'citations', 'articles', 'history', 'changes'];

function summarize(data) {
  const titles = [];
  const add = t => { const v = tidyTitle(t); if (v && !titles.includes(v) && titles.length < MAX_TITLES) titles.push(clip(v, 80)); };
  let count = null;
  if (!data || typeof data !== 'object') return { titles, count };
  if (data.title) add(data.title);
  for (const key of LIST_KEYS) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) if (item && typeof item === 'object' && (item.title || item.ruleTitle)) add(item.title || item.ruleTitle);
    if (count === null && ['rules', 'documents', 'results', 'candidates', 'matches', 'citations'].includes(key)) count = list.length;
  }
  if (Number.isFinite(data.counts?.returned)) count = data.counts.returned;
  if (count === null) {
    for (const key of LIST_KEYS) if (Array.isArray(data[key])) { count = data[key].length; break; }
  }
  if (count === null && data.title) count = 1;
  return { titles, count };
}

function createUsageLog({ dir, trustProxy = true } = {}) {
  if (!dir) return null;
  let chain = Promise.resolve();
  let ready = false;
  function append(entry) {
    let line;
    try { line = JSON.stringify(entry) + '\n'; } catch { return; }
    const file = path.join(dir, `usage-${kstParts(Date.now()).month}.jsonl`);
    chain = chain.then(async () => {
      if (!ready) { await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 }); ready = true; }
      await fs.promises.appendFile(file, line, { mode: 0o600 });
    }).catch(() => { ready = false; });
  }

  function base(req, endpoint, startedAt, body) {
    const params = body && body.params;
    const args = params && params.arguments;
    return {
      ts: kstParts(startedAt).iso,
      ip: realClientIp(req, trustProxy),
      endpoint,
      tool: params && typeof params.name === 'string' ? clip(params.name, 80) : '',
      query: queryText(args),
    };
  }

  function isToolCall(body) {
    return body && typeof body === 'object' && !Array.isArray(body) && body.method === 'tools/call';
  }

  // Wrap the response for a parsed tools/call body and log when it finishes.
  function track(req, res, endpoint, startedAt, body) {
    try {
      if (!isToolCall(body)) return;
      const entry = base(req, endpoint, startedAt, body);
      const chunks = []; let size = 0; let overflow = false;
      const keep = (chunk, encoding) => {
        if (overflow || chunk === undefined || chunk === null || typeof chunk === 'function') return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        size += buf.length;
        if (size > MAX_CAPTURE_BYTES) { overflow = true; chunks.length = 0; } else chunks.push(buf);
      };
      const write = res.write, end = res.end;
      res.write = function (chunk, encoding, cb) { try { keep(chunk, encoding); } catch {} return write.call(this, chunk, encoding, cb); };
      res.end = function (chunk, encoding, cb) { try { keep(chunk, encoding); } catch {} return end.call(this, chunk, encoding, cb); };
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        const durationMs = Date.now() - startedAt;
        const statusCode = res.statusCode;
        setImmediate(() => {
          try {
            let status = statusCode === 429 ? 'rate_limited' : statusCode >= 400 ? 'error' : 'ok';
            let titles = [], count = null;
            if (!overflow && chunks.length) {
              let text = Buffer.concat(chunks).toString('utf8');
              // SSE framing fallback: take the last data: line.
              if (!text.trimStart().startsWith('{')) {
                const lines = text.split('\n').filter(l => l.startsWith('data:'));
                text = lines.length ? lines[lines.length - 1].slice(5) : '';
              }
              let msg; try { msg = JSON.parse(text); } catch {}
              const sc = msg && msg.result && msg.result.structuredContent;
              if (msg && msg.error) status = 'error';
              if (sc) {
                if (sc.ok === false || msg.result.isError) status = 'error';
                if (sc.error && sc.error.code === 'SENSITIVE_INPUT') entry.query = '[민감정보 입력 - 기록 제외]';
                ({ titles, count } = summarize(sc.data));
              }
            }
            append({ ...entry, rules: titles, count, status, durationMs });
          } catch {}
        });
      };
      res.once('finish', finish);
      res.once('close', finish);
    } catch {}
  }

  // For rejected (429) requests the body is not processed; read a small copy
  // only to learn which tool was asked for.
  function trackRejected(req, res, endpoint, startedAt, status) {
    try {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size <= 65536) chunks.push(c); });
      req.once('end', () => setImmediate(() => {
        try {
          if (size > 65536) return;
          let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
          if (!isToolCall(body)) return;
          append({ ...base(req, endpoint, startedAt, body), rules: [], count: null, status, durationMs: Date.now() - startedAt });
        } catch {}
      }));
    } catch {}
  }

  return { track, trackRejected, flush: () => chain };
}

module.exports = { createUsageLog, summarize, queryText, realClientIp, kstParts };

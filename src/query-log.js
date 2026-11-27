'use strict';
// Opt-in question log (DONGGUK_MCP_QUERY_LOG_DIR). Records only the question
// string of allowlisted search/lookup tools after masking personal data, plus a
// fixed-schema result summary. Never stores other arguments, response bodies,
// IPs, headers, tokens or member identifiers. Never calls remote services: the
// Notion upload is a separate script (scripts/sync-query-log-notion.js).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { kst } = require('./usage-log');

const MAX_QUERY_CHARS = 200;
const MAX_RULE_CHARS = 100;
const MAX_INPUT_CHARS = 2000;
const DEFAULT_RETENTION_DAYS = 365;
// Tool → ordered argument names; the first nonempty string is the question.
// review_finance_case (draft text/facts), get_rule_content grep, verify_rule_citations
// text and every other tool are deliberately excluded.
const QUERY_FIELDS = Object.freeze({
  lookup_dongguk_rule: ['query', 'rule_keyword'],
  search_rule: ['keyword'],
  search_rule_deep: ['query'],
  applicable_rule: ['query', 'rule_keyword'],
  compare_university_rules: ['topic'],
  search_finance_handbook: ['query'],
  get_finance_context: ['query'],
  get_finance_evidence: ['query'],
});
const ENDPOINTS = new Set(['/mcp', '/mcp/rules']);

// Order matters: wider/more specific patterns first.
const MASKS = [
  ['url', /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi, '[URL]'],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[이메일]'],
  ['secret', /\b(?:bearer\s+)?(?=[A-Za-z0-9_\-]*[A-Za-z])(?=[A-Za-z0-9_\-]*\d)[A-Za-z0-9_\-]{24,}\b/gi, '[비밀값]'],
  ['rrn', /(?<!\d)\d{6}\s*[-–]?\s*[1-8]\d{6}(?!\d)/g, '[주민번호]'],
  ['card', /(?<!\d)\d{4}([-\s])\d{4}\1\d{4}\1\d{3,4}(?!\d)|(?<!\d)(?:3[47]\d{13}|[2-6]\d{15})(?!\d)/g, '[카드번호]'],
  ['phone', /(?<!\d)(?:\+?82[-.\s]?0?1[016789]|01[016789]|\+?82[-.\s]?0?(?:2|[3-6][1-5])|02|0[3-6][1-5]|070|050\d?)[-.\s)]?\d{3,4}[-.\s]?\d{4}(?!\d)|(?<!\d)1[568]\d\d[-.\s]?\d{4}(?!\d)/g, '[전화번호]'],
  ['bizno', /(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/g, '[사업자번호]'],
  ['account', /(?<!\d)\d{2,6}(?:[-\s]\d{2,8}){2,4}(?!\d)/g, m => m.replace(/\D/g, '').length >= 10 ? '[계좌번호]' : m],
  ['digits', /(?<![\d.,])\d{7,}(?![\d.,])/g, '[숫자]'],
];

function maskQuery(value, { maxChars = MAX_QUERY_CHARS } = {}) {
  if (typeof value !== 'string') return { text: '', masked: [], truncated: false };
  let text = value.slice(0, MAX_INPUT_CHARS).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const masked = [];
  for (const [type, re, replacement] of MASKS) {
    const next = text.replace(re, replacement);
    if (next !== text) masked.push(type);
    text = next;
  }
  const chars = [...text];
  const truncated = chars.length > maxChars || value.length > MAX_INPUT_CHARS;
  if (chars.length > maxChars) text = chars.slice(0, maxChars).join('') + '…';
  return { text, masked, truncated };
}

function extractQuestion(name, args) {
  const fields = QUERY_FIELDS[name];
  if (!fields || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  for (const field of fields) if (typeof args[field] === 'string' && args[field].trim()) return args[field];
  return null;
}

const resultCode = value => typeof value === 'string' && /^[A-Za-z_]{1,40}$/.test(value) ? value : null;
const ruleName = value => typeof value === 'string' && value.trim() ? maskQuery(value.replace(/\s+/g, ' '), { maxChars: MAX_RULE_CHARS }).text : null;

function summarizeResult(message, httpStatus) {
  const result = message?.result, sc = result?.structuredContent, data = sc?.data;
  if (!message) return { status: httpStatus >= 400 ? 'error' : 'unobserved', resultStatus: httpStatus >= 400 ? 'HTTP_' + httpStatus : null, resultCount: null, topRule: null };
  if (message.error || result?.isError || sc?.ok === false || httpStatus >= 400) {
    return { status: 'error', resultStatus: resultCode(sc?.error?.code) || (message.error ? 'RPC_ERROR' : 'ERROR'), resultCount: 0, topRule: null };
  }
  let resultCount = null, topRule = null;
  if (Array.isArray(data?.rules)) { resultCount = data.rules.length; topRule = ruleName(data.rules[0]?.title); }
  else if (Array.isArray(data?.documents)) { resultCount = data.documents.length; topRule = ruleName(data.documents[0]?.title); }
  else if (Array.isArray(data?.results)) { resultCount = data.results.length; topRule = ruleName(data.results[0]?.title); }
  else if (Array.isArray(data?.columns)) {
    const found = data.columns.filter(c => Array.isArray(c?.articles) && c.articles.length);
    resultCount = found.length; topRule = ruleName(found[0]?.articles?.[0]?.universityRule);
  } else if (data && typeof data.title === 'string') { resultCount = 1; topRule = ruleName(data.title); }
  const resultStatus = resultCode(data?.evidenceStatus) || resultCode(data?.status) || (resultCount === 0 ? 'no_results' : 'ok');
  return { status: 'ok', resultStatus, resultCount, topRule };
}

function retentionDays(value = process.env.DONGGUK_MCP_QUERY_LOG_RETENTION_DAYS) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEFAULT_RETENTION_DAYS;
}

function queryLogInfo(env = process.env) {
  const enabled = typeof env.DONGGUK_MCP_QUERY_LOG_DIR === 'string' && Boolean(env.DONGGUK_MCP_QUERY_LOG_DIR.trim());
  return {
    enabled,
    ...(enabled ? { retentionDays: retentionDays(env.DONGGUK_MCP_QUERY_LOG_RETENTION_DAYS), tools: Object.keys(QUERY_FIELDS), stored: ['시각', '도구', '경로', '질문(개인정보 가림, 최대 200자)', '결과 상태', '결과 건수', '첫 결과 규정명', '소요 시간'], notStored: ['다른 입력값', '답변 본문', 'IP', '헤더', '토큰', '회원 식별자'] } : {}),
    notice: enabled
      ? `이 서버는 검색 품질 개선을 위해 검색어(질문)를 개인정보를 가린 뒤 저장합니다. 보관 기간은 ${retentionDays(env.DONGGUK_MCP_QUERY_LOG_RETENTION_DAYS)}일이며 IP·계정·답변 본문은 저장하지 않습니다. 개인번호·연락처·계좌 등은 입력하지 마세요.`
      : '이 서버는 검색어(질문)를 저장하지 않습니다.',
  };
}

function createQueryLog({ dir, maxCaptureBytes = 8 * 1024 * 1024 } = {}) {
  if (!dir) return null;
  let chain = Promise.resolve(), queued = 0;
  function track(req, res, endpoint, startedAt, body) {
    try {
      if (!body || Array.isArray(body) || body.method !== 'tools/call') return;
      const tool = body.params?.name;
      const raw = extractQuestion(tool, body.params?.arguments);
      if (raw === null || !ENDPOINTS.has(endpoint)) return;
      const question = maskQuery(raw); // mask immediately; the raw string is not retained
      if (!question.text) return;
      let chunks = [], size = 0, overflow = false, done = false;
      const keep = (chunk, encoding) => {
        if (overflow || chunk == null || typeof chunk === 'function') return;
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
        size += b.length;
        if (size > maxCaptureBytes) { overflow = true; chunks = []; } else chunks.push(b);
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
          const entry = {
            schemaVersion: 1, id: crypto.randomUUID(), ts, tool, endpoint,
            query: question.text, queryMasked: question.masked, queryTruncated: question.truncated,
            ...summarizeResult(message, httpStatus), durationMs,
          };
          await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
          await fs.promises.appendFile(path.join(dir, `queries-${ts.slice(0, 7)}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 });
        }).catch(() => {}).finally(() => { queued--; chunks = []; });
      };
      res.once('finish', finish); res.once('close', finish);
    } catch {} // Logging can never change an MCP response.
  }
  return { track, flush: () => chain };
}

// Deletes local month files whose whole month is older than the retention window.
async function pruneQueryLog({ dir, days = retentionDays(), now = Date.now() } = {}) {
  if (!dir) return [];
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const cutoff = now - days * 86400000, removed = [];
  for (const name of names) {
    const m = /^queries-(\d{4})-(\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    const monthEndKst = Date.UTC(Number(m[1]), Number(m[2]), 1) - 9 * 3600000; // first instant of next month, KST
    if (monthEndKst <= cutoff) { await fs.promises.unlink(path.join(dir, name)); removed.push(name); }
  }
  return removed.sort();
}

module.exports = { createQueryLog, maskQuery, extractQuestion, summarizeResult, queryLogInfo, pruneQueryLog, retentionDays, QUERY_FIELDS, MAX_QUERY_CHARS };

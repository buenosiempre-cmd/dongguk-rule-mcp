'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const fetch = require('node-fetch');
const { SOURCES, createPublicClient, loadExternal, safeCode, titleMatchesTopic } = require('./university-rules');
const { listArticleBlocks } = require('./parsers');
const { extractPdfText } = require('./pdf-text');
const { kst } = require('./usage-log');
const UNIVERSITIES = SOURCES.filter(s => s.key !== 'dongguk');
// 여비 전담 규정 제목에 '여비' 대신 '출장'·'출장비'가 쓰인 대학(서강·가천·서울시립 등)을 놓치지 않는다.
const TRAVEL_TITLE_ALIASES = ['여비', '출장', '출장비'];
const TRAVEL_WATCH_SPEC = {
  searchTerms: ['여비', '출장'],
  titleHints: TRAVEL_TITLE_ALIASES,
  titleQueries: TRAVEL_TITLE_ALIASES,
  maxRules: 1,
  titleOnly: true,
};
const HASH_SCOPE = 'article-prefix-8192-v1';
const timeout = () => Object.assign(new Error('TOTAL_TIMEOUT'), { code: 'TOTAL_TIMEOUT' });
function aborted(promise, signal) {
  if (signal.aborted) return Promise.reject(timeout());
  return new Promise((resolve, reject) => {
    const stop = () => reject(timeout());
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
const date = value => typeof value === 'string' && /^\d{4}[-.]\d{2}[-.]\d{2}$/.test(value) ? value.replace(/\./g, '-') : null;
function fingerprint(rule) {
  const blocks = listArticleBlocks(rule.markdown).filter(b => b.content.replace(/^###[ \t]*제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?[ \t]*(?:[(（][^\n)）]*[)）])?/, '').trim());
  if (!blocks.length) return null;
  const prefix = blocks.map(b => b.content).join('\n').replace(/\s+/g, ' ').trim().slice(0, 8192);
  return { title: String(rule.title || '').slice(0, 200), lawId: String(rule.lawId ?? '').slice(0, 80),
    revisedAt: date(rule.revisedAt), effectiveAt: date(rule.effectiveAt),
    upcomingRevisionAt: date(rule.upcomingRevisionAt), hash: crypto.createHash('sha256').update(prefix).digest('hex'), hashScope: HASH_SCOPE };
}
function compareSnapshot(row, previous) {
  const old = previous?.key === row.key ? previous : null;
  const baseline = old?.success ? old.rules : old?.lastSuccess?.rules;
  const changes = [];
  if (row.success) {
    row.consecutiveFailures = 0;
    if (old && !old.success) changes.push('RECOVERED');
    for (const rule of row.rules) {
      const before = baseline?.find(r => r.lawId === rule.lawId && r.title === rule.title);
      if (!baseline?.length) changes.push('BASELINE_CREATED');
      else if (!before) changes.push('REPRESENTATIVE_CHANGED');
      else {
        if (before.revisedAt !== rule.revisedAt) changes.push('REVISION_DATE_CHANGED');
        if (before.hashScope === rule.hashScope && before.hash !== rule.hash) changes.push('BODY_HASH_CHANGED');
        if (before.hashScope !== rule.hashScope) changes.push('HASH_SCOPE_CHANGED');
      }
      if (rule.upcomingRevisionAt && rule.upcomingRevisionAt !== before?.upcomingRevisionAt) changes.push('UPCOMING_REVISION');
    }
    row.lastSuccess = { checkedAt: row.checkedAt, rules: row.rules };
  } else {
    row.consecutiveFailures = (Number.isSafeInteger(old?.consecutiveFailures) ? old.consecutiveFailures : 0) + 1;
    if (row.consecutiveFailures >= 2) changes.push('CONSECUTIVE_FAILURE');
    if (old?.lastSuccess) row.lastSuccess = old.lastSuccess;
    else if (old?.success) row.lastSuccess = { checkedAt: old.checkedAt, rules: old.rules };
  }
  for (const code of row.failureCodes) if (['UPSTREAM_FORMAT_CHANGED','PDF_REVISION_UNVERIFIED'].includes(code)) changes.push(code);
  if (row.rules.some(r => !titleMatchesTopic(r.title, row.topic || '여비', TRAVEL_TITLE_ALIASES))) changes.push('TOPIC_TITLE_NOT_MATCHED');
  row.changes = [...new Set(changes)];
  return row;
}
async function runWatch({ previous, totalTimeoutMs = 60000, universityTimeoutMs = 15000, concurrency = 5 } = {}, {
  loader = loadExternal, sources = UNIVERSITIES, now = Date.now,
  clientFactory = signal => createPublicClient({ fetchImpl: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.any([opts.signal, signal]) }) }),
} = {}) {
  if (!(totalTimeoutMs > 0 && totalTimeoutMs <= 60000 && universityTimeoutMs > 0 && universityTimeoutMs <= 15000 && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 5)) throw new Error('INVALID_WATCH_LIMITS');
  if (previous && previous.schemaVersion !== 1) throw new Error('INVALID_SNAPSHOT');
  const started = now(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
  let next = 0, pdfActive = 0;
  const rows = new Array(sources.length);
  // At most two PDF workers; wait within the existing school/total deadline.
  async function extractPdf(buffer, opts) {
    while (pdfActive >= 2) await aborted(new Promise(r => setTimeout(r, 20)), opts.signal);
    if (opts.signal.aborted) throw timeout();
    pdfActive++;
    try { return await extractPdfText(buffer, opts); } finally { pdfActive--; }
  }
  async function one(source) {
    const at = now(), local = new AbortController();
    const deadline = setTimeout(() => local.abort(), universityTimeoutMs);
    const signal = AbortSignal.any([controller.signal, local.signal]);
    let requests = 0, result, failure;
    try {
      if (signal.aborted) throw timeout();
      const underlying = clientFactory(signal);
      const client = { request: (...args) => { if (signal.aborted) throw timeout(); requests++; return underlying.request(...args); } };
      // 여비 사안 한 건, 대표 문서 하나. 동국대와 본문 우회 크롤은 하지 않는다.
      result = await aborted(loader(source, '여비', ['여비'], client, signal,
        { ...TRAVEL_WATCH_SPEC }, { extractPdf, maxRules: 1 }), signal);
    } catch (e) { failure = safeCode(e); }
    finally { clearTimeout(deadline); local.abort(); }
    const rules = (result?.rules || []).slice(0, 1).map(fingerprint).filter(Boolean);
    const failureCodes = [...new Set([failure, ...(result?.failures || []).map(f => safeCode(f))].filter(Boolean))];
    if (result?.coverage?.currentRevisionUnverified && !failureCodes.length) failureCodes.push('PDF_REVISION_UNVERIFIED');
    if (!rules.length && !failureCodes.length) failureCodes.push(result?.coverage?.publicOnly ? 'NOT_PUBLIC' : 'NO_MATCH_IN_SCOPE');
    const success = rules.length > 0 && failureCodes.length === 0;
    const row = { key: source.key, name: source.name, checkedAt: kst(at), topic: '여비', success,
      status: rules.length ? 'partial' : failureCodes.includes('NOT_PUBLIC') ? 'not_public' : failureCodes.includes('NO_MATCH_IN_SCOPE') ? 'no_match_in_scope' : 'unavailable',
      failureCodes, rules, durationMs: Math.max(0, now() - at), requests };
    return compareSnapshot(row, previous?.universities?.find(r => r.key === source.key));
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
      for (;;) { const index = next++; if (index >= sources.length) return; rows[index] = await one(sources[index]); }
    }));
  } finally { clearTimeout(timer); controller.abort(); }
  return { schemaVersion: 1, checkedAt: kst(started), durationMs: Math.max(0, now() - started),
    limits: { totalTimeoutMs, universityTimeoutMs, minIntervalMs: 500, concurrency, rulesPerUniversity: 1 },
    universities: rows };
}
async function readSnapshot(file) {
  if (!file) return undefined;
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.universities)) throw new Error();
    return data;
  } catch (e) { if (e.code === 'ENOENT') return undefined; throw new Error('INVALID_SNAPSHOT'); }
}
async function saveSnapshot(file, value) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
const cell = text => String(text ?? '미확인').replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '');
function formatWatch(report, format = 'markdown') {
  if (format === 'json') return JSON.stringify(report, null, 2);
  const slack = format === 'slack';
  const lines = [slack ? '*타대학 주간 스모크*' : '# 타대학 주간 스모크', '', `확인 시각(KST): ${report.checkedAt}`, '대표 여비 규정의 조문 앞부분만 점검합니다. 성공은 조회 성공이며 전문·개정 확정 판정이 아닙니다.', ''];
  if (!slack && report.universities?.length) lines.push('| 대학 | 성공/실패·상태 | 규정명 | 개정일 | 시행일 | 시행 예정 | SHA-256 | 실패 코드 | 소요(ms) | 변경/연속 실패 |', '|---|---|---|---|---|---|---|---|---:|---|');
  for (const r of report.universities || []) {
    const rule = r.rules[0] || {};
    const values = [r.name, `${r.success ? '성공' : '실패'} (${r.status})`, rule.title, rule.revisedAt, rule.effectiveAt, rule.upcomingRevisionAt, rule.hash, r.failureCodes.join(', ') || '없음', r.durationMs, `${r.changes.join(', ') || '변화 없음'} / ${r.consecutiveFailures}회`].map(cell);
    lines.push(slack ? `• ${values[0]}: ${values.slice(1).join(' · ')}` : `| ${values.join(' | ')} |`);
  }
  if (report.usage) {
    lines.push('', slack ? '*사용 로그 실패 집계*' : '## 사용 로그 실패 집계', `기간: ${report.usage.since} ~ ${report.usage.until}`);
    if (report.usage.status === 'no_logs') lines.push('로그 없음(기간 내 비교 로그 없음).');
    else {
      lines.push(`비교 호출 ${report.usage.calls}회, 대학 결과 미관측 ${report.usage.unobservedCalls}회, 손상 줄 ${report.usage.malformedLines}개`);
      for (const r of report.usage.universities) lines.push(`- ${cell(UNIVERSITIES.find(s => s.key === r.university)?.name)}: ${r.failedCalls}/${r.calls}회 실패, ${Object.entries(r.codes).map(([k,v]) => `${k}=${v}`).join(', ') || '실패 없음'}`);
    }
  }
  return lines.join('\n');
}
module.exports = { runWatch, fingerprint, compareSnapshot, readSnapshot, saveSnapshot, formatWatch, UNIVERSITIES, TRAVEL_WATCH_SPEC, TRAVEL_TITLE_ALIASES };

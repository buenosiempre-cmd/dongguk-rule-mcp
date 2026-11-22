'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { parseContent, listArticleBlocks } = require('./parsers');

// Endpoint settings and LawMaster pair parsing ported from kr-univ-rule-mcp,
// tools/probe/probe.js (e56044f), MIT; attribution in docs/THIRD_PARTY.md.
const SOURCES = Object.freeze([
  { key: 'dongguk', name: '동국대학교', origin: 'https://rule.dongguk.edu', ext: 'srv', mode: 'search' },
  { key: 'korea', name: '고려대학교', origin: 'https://policies.korea.ac.kr', ext: 'do', mode: 'recent_list' },
  { key: 'uos', name: '서울시립대학교', origin: 'http://rule.uos.ac.kr', ext: 'srv', mode: 'search' },
  { key: 'konkuk', name: '건국대학교', origin: 'https://rule.konkuk.ac.kr', ext: 'do', mode: 'recent_list' },
  { key: 'kookmin', name: '국민대학교', origin: 'https://rule.kookmin.ac.kr', ext: 'do', mode: 'recent_list' },
  { key: 'ssu', name: '숭실대학교', origin: 'http://rule.ssu.ac.kr', ext: 'do', mode: 'recent_list' },
].map(Object.freeze));
const TOPICS = {
  '여비': ['여비', '출장', '숙박'], '겸직': ['겸직', '겸업'],
  '연구비': ['연구비', '연구지원'], '등록금 반환': ['등록금', '반환', '환불'],
  '퇴직급여': ['퇴직', '퇴직금', '퇴직급여'],
};
const NOTICE = '주제어가 일치하는 조문 발췌를 나란히 제공합니다. 행 순서나 조문 번호는 대학 간 법적 대응·동등성을 뜻하지 않습니다. HTML만 조회하므로 HWP 별표·금액표는 누락될 수 있습니다. 개정일은 시행일이 아니며 적용 여부·시행일은 미확인입니다.';
const error = code => Object.assign(new Error(code), { code });

function validateArguments(a) {
  if (!a || typeof a.topic !== 'string' || !a.topic.trim() || a.topic.length > 100) return 'topic은 1~100자 주제어여야 합니다.';
  if (!Array.isArray(a.universities) || !a.universities.length || a.universities.length > 5 || a.universities.some(x => typeof x !== 'string' || !/^[a-z]{2,20}$/.test(x) || x === 'dongguk')) return 'universities에는 비교할 타대학 키를 1~5개 넣으세요. dongguk은 자동 포함됩니다.';
  if (a.max_articles !== undefined && (!Number.isInteger(a.max_articles) || a.max_articles < 1 || a.max_articles > 5)) return 'max_articles는 1~5 정수여야 합니다.';
  return null;
}

function parsePairs(html) {
  const $ = cheerio.load(html), pairs = [], seen = new Set();
  const add = (lawId, historyId, title) => {
    const key = `${lawId}_${historyId}`;
    if (seen.has(key) || !Number.isSafeInteger(+lawId) || !Number.isSafeInteger(+historyId) || +lawId < 1 || +historyId < 1) return;
    seen.add(key); pairs.push({ lawId: +lawId, historyId: +historyId, title: title || '' });
  };
  $('a, [onclick]').each(function () {
    const el = $(this), source = (el.attr('href') || '') + ' ' + (el.attr('onclick') || '');
    const m = /(?:fullPopupPost|lawSearchFullView\w*)\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/.exec(source)
      || /SEQ=(\d+)&(?:amp;)?SEQ_HISTORY=(\d+)/.exec(source);
    if (m) add(m[1], m[2], el.text().replace(/\s+/g, ' ').trim());
  });
  // Some sites write the list from script literals. Keep untitled entries so
  // the caller can explicitly report the bounded scan instead of a false zero.
  for (const m of html.matchAll(/fullPopupPost\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/g)) add(m[1], m[2], '');
  return pairs;
}

function parseUniversitySearch(html) {
  const $ = cheerio.load(html);
  const totalMatch = /([\d,]+)\s*건/.exec($('p.infoLeft').text());
  const hits = parsePairs(html);
  if (!totalMatch || (+totalMatch[1].replaceAll(',', '') > 0 && !hits.length)) throw error('UPSTREAM_FORMAT_CHANGED');
  return { total: Number(totalMatch[1].replaceAll(',', '')), hits };
}

function createPublicClient({ fetchImpl = fetch, now = Date.now, ttlMs = 600000, maxEntries = 64, timeoutMs = 8000, disabled = () => ['1','true','yes'].includes((process.env.DONGGUK_MCP_NO_CACHE || '').trim().toLowerCase()) } = {}) {
  const cache = new Map(), inflight = new Map();
  async function request(source, path, body, budgetMs = timeoutMs) {
    if (!SOURCES.includes(source) || source.key === 'dongguk' || !/^\/lmxsrv\/(law|search)\//.test(path)) throw error('SOURCE_NOT_ALLOWED');
    const key = source.key + ':' + path + ':' + (body || '');
    const hit = cache.get(key);
    if (!disabled() && hit && now() - hit.at < ttlMs) return hit.text;
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, budgetMs)));
      try {
        const res = await fetchImpl(source.origin + path, {
          method: body ? 'POST' : 'GET', body, redirect: 'manual',
          signal: controller.signal, size: 2 * 1024 * 1024,
          headers: { 'User-Agent': 'dongguk-rule-mcp university comparison', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        });
        if (res.status >= 300 && res.status < 400) throw error('REDIRECT_NOT_FOLLOWED');
        if ([401, 403].includes(res.status)) throw error('ACCESS_DENIED');
        if (!res.ok) throw error('UPSTREAM_UNAVAILABLE');
        const html = await res.text();
        if (/차단페이지|접근이 차단|비정상적인 접근|Access Denied|Web Application Firewall/i.test(html.slice(0, 4000))) throw error('ACCESS_DENIED');
        if (/type\s*=\s*["']password/i.test(html)) throw error('SESSION_REQUIRED');
        if (path.includes('lawNewList.') && !parsePairs(html).length) throw error('UPSTREAM_FORMAT_CHANGED');
        if (path.includes('lawSerach.')) parseUniversitySearch(html);
        if (path.includes('lawFullContent.')) {
          const parsed = parseContent(html);
          if (!parsed.title || !listArticleBlocks(parsed.markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
        }
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        if (!disabled()) cache.set(key, { at: now(), text: html });
        return html;
      } finally { clearTimeout(timer); }
    })();
    inflight.set(key, pending);
    try { return await pending; } finally { inflight.delete(key); }
  }
  return { request };
}

function sourceUrl(s, hit) {
  return `${s.origin}/lmxsrv/law/lawFullView.${s.ext}?SEQ=${hit.lawId}&SEQ_HISTORY=${hit.historyId}`;
}

async function loadExternal(source, topic, terms, client) {
  let hits, coverage;
  const deadline = Date.now() + 15000;
  const request = (path, body) => {
    if (Date.now() >= deadline) throw error('UPSTREAM_UNAVAILABLE');
    return client.request(source, path, body, deadline - Date.now());
  };
  if (source.mode === 'search') {
    const body = new URLSearchParams({ PAGE: '1', PAGE_SHOW: '5', LAWGROUP: '0', SEARCH_TYPE: 'CONTENTS', SEARCH_TEXT: topic }).toString();
    const result = parseUniversitySearch(await request(`/lmxsrv/search/lawSerach.${source.ext}`, body));
    hits = result.hits;
    coverage = { mode: 'full_text_search', totalCandidates: result.total, truncated: result.total > hits.length };
  } else {
    const pairs = parsePairs(await request(`/lmxsrv/law/lawNewList.${source.ext}`));
    if (!pairs.length) throw error('UPSTREAM_FORMAT_CHANGED');
    const named = pairs.filter(x => terms.some(t => x.title.includes(t)));
    hits = [...named, ...pairs.filter(x => !named.includes(x))].slice(0, 8);
    coverage = { mode: 'recent_list_only', totalCandidates: pairs.length, truncated: pairs.length > hits.length, complete: false };
  }
  const rules = [], failures = [];
  for (const hit of hits.slice(0, 8)) {
    try {
      const parsed = parseContent(await request(`/lmxsrv/law/lawFullContent.${source.ext}?SEQ=${hit.lawId}&SEQ_HISTORY=${hit.historyId}`));
      if (!parsed.title || !listArticleBlocks(parsed.markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
      rules.push({ ...hit, ...parsed, url: sourceUrl(source, hit), revisedAt: hit.revisedAt || null, effectiveAt: null });
    } catch (e) {
      failures.push({ lawId: hit.lawId, historyId: hit.historyId, code: safeCode(e) });
      if (['ACCESS_DENIED', 'SESSION_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'REDIRECT_NOT_FOLLOWED'].includes(safeCode(e))) break;
    }
  }
  return { rules, failures, coverage: { ...coverage, scannedRules: rules.length, attemptedRules: rules.length + failures.length } };
}

function safeCode(e) {
  return ['ACCESS_DENIED', 'SESSION_REQUIRED', 'REDIRECT_NOT_FOLLOWED', 'UPSTREAM_FORMAT_CHANGED', 'UPSTREAM_UNAVAILABLE'].includes(e?.code) ? e.code : 'UPSTREAM_UNAVAILABLE';
}

function selectArticles(rules, terms, limit) {
  const matches = [];
  for (const rule of rules) {
    for (const block of listArticleBlocks(rule.markdown)) {
      if (block.supplementary) continue;
      const matchedTerms = terms.filter(t => block.content.includes(t));
      if (!matchedTerms.length) continue;
      matches.push({ universityRule: rule.title, lawId: rule.lawId, historyId: rule.historyId,
        article: block.canonical, text: block.content.slice(0, 2000), textTruncated: block.content.length > 2000,
        matchedTerms, url: rule.url, revisedAt: rule.revisedAt || null, effectiveAt: null });
    }
  }
  matches.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length);
  return { articles: matches.slice(0, limit), matchingArticles: matches.length, articlesTruncated: matches.length > limit };
}

const publicClient = createPublicClient();
async function compareUniversityRules(a, { loadDongguk, client = publicClient, now = () => new Date() } = {}) {
  const invalid = validateArguments(a);
  if (invalid) throw Object.assign(new Error(invalid), { code: 'INVALID_ARGUMENT' });
  const topic = a.topic.trim(), terms = TOPICS[topic] || topic.split(/\s+/), columns = [];
  // Sequential schools bound upstream concurrency and preserve deterministic order.
  for (const key of ['dongguk', ...new Set(a.universities)]) {
    const source = SOURCES.find(x => x.key === key);
    if (!source) { columns.push({ university: key, status: 'unsupported', articles: [] }); continue; }
    try {
      const result = key === 'dongguk' ? await loadDongguk(topic, terms) : await loadExternal(source, topic, terms, client);
      const selected = selectArticles(result.rules, terms, a.max_articles || 3);
      const partial = result.coverage.complete === false || result.coverage.truncated || result.failures.length > 0 || selected.articlesTruncated || selected.articles.some(x => x.textTruncated);
      columns.push({ university: key, name: source.name, status: result.rules.length === 0 && result.failures.length ? 'unavailable' : selected.articles.length ? (partial ? 'partial' : 'retrieved') : 'no_match_in_scope', ...selected, coverage: result.coverage, failures: result.failures });
    } catch (e) { columns.push({ university: key, name: source.name, status: 'unavailable', code: safeCode(e), articles: [] }); }
  }
  return { topic, terms, checkedAt: now().toISOString(), status: columns.every(x => x.status === 'retrieved') ? 'retrieved' : 'partial', columns,
    alignment: 'topic_keyword_matches_not_legal_equivalence', notice: NOTICE, supportedUniversities: SOURCES.map(x => ({ key: x.key, name: x.name, scope: x.mode })) };
}

function formatComparison(data) {
  const esc = v => String(v ?? '미확인').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const lines = [`# 대학 규정 비교: ${data.topic}`, data.notice, `조회: ${data.checkedAt} / 상태: ${data.status}`, '',
    '| 항목 | ' + data.columns.map(c => esc(c.name || c.university)).join(' | ') + ' |',
    '|---|' + data.columns.map(() => '---|').join(''),
    '| 상태 | ' + data.columns.map(c => esc(c.status + (c.code ? ` (${c.code})` : ''))).join(' | ') + ' |'];
  for (let i = 0; i < Math.max(0, ...data.columns.map(c => c.articles.length)); i++) {
    lines.push(`| 발췌 ${i + 1} | ` + data.columns.map(c => {
      const a = c.articles[i];
      return a ? `${esc(a.universityRule)} ${esc(a.article)}<br>${esc(a.text)}${a.textTruncated ? ' [잘림]' : ''}<br>개정일 ${esc(a.revisedAt)} / 시행일 미확인<br>[원문](${a.url})` : '범위 내 발췌 없음';
    }).join(' | ') + ' |');
  }
  lines.push('', ...data.columns.map(c => `- ${c.name || c.university}: ${c.coverage ? JSON.stringify(c.coverage) : c.status}${c.failures?.length ? ` / 실패 ${c.failures.length}건` : ''}`));
  return lines.join('\n');
}

module.exports = { SOURCES, parsePairs, parseUniversitySearch, createPublicClient, validateArguments, selectArticles, compareUniversityRules, formatComparison, loadExternal };

'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { listArticleBlocks } = require('./parsers');
const { extractEnforcementDates } = require('./timeline');

// Endpoint settings and LawMaster pair parsing ported from kr-univ-rule-mcp,
// tools/probe/probe.js (e56044f), MIT; attribution in docs/THIRD_PARTY.md.
// 'tree' reads the public rule tree (lawTree) and falls back to the recent list
// when a site serves only a stub tree without a session (고려대, 2026-11 확인).
const SOURCES = Object.freeze([
  { key: 'dongguk', name: '동국대학교', origin: 'https://rule.dongguk.edu', ext: 'srv', mode: 'search' },
  { key: 'korea', name: '고려대학교', origin: 'https://policies.korea.ac.kr', ext: 'do', mode: 'tree' },
  { key: 'uos', name: '서울시립대학교', origin: 'http://rule.uos.ac.kr', ext: 'srv', mode: 'search' },
  { key: 'konkuk', name: '건국대학교', origin: 'https://rule.konkuk.ac.kr', ext: 'do', mode: 'tree' },
  { key: 'kookmin', name: '국민대학교', origin: 'https://rule.kookmin.ac.kr', ext: 'do', mode: 'search_do' },
  { key: 'ssu', name: '숭실대학교', origin: 'http://rule.ssu.ac.kr', ext: 'do', mode: 'search_do' },
].map(Object.freeze));
// terms: 조문 일치어(첫 항목이 대표어·검색어). titleHints: 규정 제목 우선순위용(조문 일치에는 쓰지 않음).
const TOPICS = {
  '여비': { terms: ['여비', '출장', '숙박'] }, '겸직': { terms: ['겸직', '겸업'] },
  '연구비': { terms: ['연구비', '연구지원'] }, '등록금 반환': { terms: ['등록금', '반환', '환불'] },
  '퇴직급여': { terms: ['퇴직', '퇴직금', '퇴직급여'] },
  '근로장학': { terms: ['근로장학', '근로보조금', '교내근로', '근로학생'], titleHints: ['장학'] },
  '장학금': { terms: ['장학금'], titleHints: ['장학'] },
};
const TOPIC_PREFIX = /^(교내|교외|학부|대학원|학사)/;
const MAX_RULES = 5, MIN_TREE_RULES = 20, TOTAL_TIMEOUT_MS = 60000;
const TREE_QUERY = 'LAWGROUP=1&SEQ_TARGET=0&MODE=srvlist&TREE_SEARCH_BOOL=y';
const NOTICE = '주제어가 일치하는 조문 발췌를 나란히 제공합니다. 행 순서나 조문 번호는 대학 간 법적 대응·동등성을 뜻하지 않습니다. HTML만 조회하므로 HWP 별표·금액표는 누락될 수 있습니다. 개정일은 시행일이 아닙니다. 시행일은 규정 목록의 시행일자 또는 마지막 부칙의 명시 시행일만 표시하며(조문별 시행일·경과조치는 미확인), 없으면 미확인입니다.';
const error = code => Object.assign(new Error(code), { code });
const compact = s => String(s ?? '').replace(/\s+/g, '');
const uniq = xs => [...new Set(xs.filter(Boolean))];

// "교내근로장학금" → 대표어 '근로장학'과 동의어(근로보조금 등). 등록되지 않은 주제는
// 기존처럼 띄어쓰기로 나누고, 한 단어면 접두어(교내·학부 등)·끝의 '금'을 뗀 형태도 함께 쓴다.
function expandTopic(topic) {
  const raw = String(topic).trim(), c = compact(raw), core = c.replace(TOPIC_PREFIX, '');
  const variants = uniq([c, core, c.replace(/금$/, ''), core.replace(/금$/, '')]);
  const key = Object.keys(TOPICS).find(k => variants.includes(compact(k)));
  if (key) {
    const { terms, titleHints } = TOPICS[key];
    return { terms: [...terms], searchTerms: terms.slice(0, 2), titleHints: titleHints || [...terms] };
  }
  if (/\s/.test(raw)) { const terms = raw.split(/\s+/); return { terms, searchTerms: [raw], titleHints: terms }; }
  const terms = uniq([c, core.length >= 2 ? core : null]);
  return { terms, searchTerms: [...terms].reverse(), titleHints: terms };
}

// 목록 제목에 섞인 스크립트(시행예정 표시·new 아이콘)를 지우고 시행일자를 뽑는다.
function cleanListTitle(text) {
  const s = String(text || '');
  const m = /chekFutureDate\(\s*['"](\d{4})(\d{2})(\d{2})['"]\s*\)/.exec(s);
  const title = s.replace(/if\s*\(\s*chekFutureDate\([^)]*\)\s*\)\s*\{[^}]*\}\s*;?/g, ' ')
    .replace(/newIcon\([^)]*\)\s*;?/g, ' ').replace(/\[시행예정\]/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, effectiveAt: m ? `${m[1]}-${m[2]}-${m[3]}` : null };
}

// 마지막 부칙 블록의 명시 시행일(본문 순서상 첫 날짜). '공포한 날부터' 등 날짜가 없으면 null.
function latestAddendaEffective(markdown) {
  const parts = String(markdown || '').split(/^##\s*부\s*칙.*$/m);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const re = /(\d{4})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})\s*일?\s*\.?\s*(?:부터|에)?\s*시행/;
  const m = re.exec(last);
  if (!m) return null;
  const found = extractEnforcementDates(m[0]);
  return found.length ? found[0].iso : null;
}

function ruleTitleScore(title, terms, hints) {
  const t = compact(String(title || '').split(/제\s*\d+\s*조/)[0]).replace(/^[\d-]+/, '');
  if (terms.some(x => t.includes(compact(x)))) return 2;
  return hints.some(x => t.includes(compact(x))) ? 1 : 0;
}

function validateArguments(a) {
  if (!a || typeof a.topic !== 'string' || !a.topic.trim() || a.topic.length > 100) return 'topic은 1~100자 주제어여야 합니다.';
  if (!Array.isArray(a.universities) || !a.universities.length || a.universities.length > 5 || a.universities.some(x => typeof x !== 'string' || !/^[a-z]{2,20}$/.test(x) || x === 'dongguk')) return 'universities에는 비교할 타대학 키를 1~5개 넣으세요. dongguk은 자동 포함됩니다.';
  if (a.max_articles !== undefined && (!Number.isInteger(a.max_articles) || a.max_articles < 1 || a.max_articles > 5)) return 'max_articles는 1~5 정수여야 합니다.';
  return null;
}

function parsePairs(html) {
  const $ = cheerio.load(html), pairs = [], seen = new Set();
  const add = (lawId, historyId, text) => {
    const key = `${lawId}_${historyId}`;
    if (seen.has(key) || !Number.isSafeInteger(+lawId) || !Number.isSafeInteger(+historyId) || +lawId < 1 || +historyId < 1) return;
    const { title, effectiveAt } = cleanListTitle(text);
    seen.add(key); pairs.push({ lawId: +lawId, historyId: +historyId, title, ...(effectiveAt ? { effectiveAt } : {}) });
  };
  $('a, [onclick]').each(function () {
    const el = $(this), source = (el.attr('href') || '') + ' ' + (el.attr('onclick') || '');
    const m = /(?:fullPopupPost|thisReadLaw|lawSearchFullView\w*)\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/.exec(source)
      || /SEQ=(\d+)&(?:amp;)?SEQ_HISTORY=(\d+)/.exec(source);
    if (m) add(m[1], m[2], el.text().replace(/\s+/g, ' ').trim());
  });
  // Some sites write the list from script literals. Keep untitled entries so
  // the caller can explicitly report the bounded scan instead of a false zero.
  for (const m of html.matchAll(/fullPopupPost\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/g)) add(m[1], m[2], '');
  return pairs;
}

function parseExternalContent(html) {
  const $ = cheerio.load(html);
  $('.doc_btn, caption, script, style').remove();
  const root = $('.fullbody').length ? $('.fullbody') : $('body');
  const title = root.find('.lawname').first().text().replace(/\s+/g, ' ').trim();
  const lines = [];
  root.find('div, span').each(function () {
    const classes = ($(this).attr('class') || '').split(/\s+/);
    const text = $(this).text().replace(/\s+/g, ' ').trim();
    if (!text || classes.includes('lawname')) return;
    if (classes.includes('addenda')) lines.push(`## ${text.replace(/^부\s*칙\s*/, '부칙 ')}`);
    else if (classes.includes('chapter')) lines.push(`## ${text}`);
    // 고려대·건국대는 조문 제목을 span.article2로 표시한다(2026-11 확인).
    else if ((classes.includes('article') || classes.includes('article2')) && /^제\s*\d+\s*조/.test(text)) lines.push(`### ${text}`);
    else if (['none','hang','ho','mok'].some(c => classes.includes(c))) lines.push(text);
  });
  return {title,markdown:lines.join('\n')};
}

// 공개 규정 트리(var zNodes = [...])의 말단 노드: id=SEQ, hseq=SEQ_HISTORY.
function parseTree(html) {
  const m = /var\s+zNodes\s*=\s*(\[[\s\S]*?\])\s*;/.exec(String(html || ''));
  if (!m) return [];
  let nodes;
  try { nodes = JSON.parse(m[1]); } catch { return []; }
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(x => x && String(x.folder) === '0' && Number.isSafeInteger(+x.id) && +x.id > 0 && Number.isSafeInteger(+x.hseq) && +x.hseq > 0)
    .map(x => ({ lawId: +x.id, historyId: +x.hseq, title: cleanListTitle(x.name).title }));
}

function parseUniversitySearch(html, modern = false) {
  const $ = cheerio.load(html);
  const totalMatch = modern ? /전체\s*:\s*([\d,]+)\s*건/.exec($('body').text()) : /([\d,]+)\s*건/.exec($('p.infoLeft').text());
  const hits = parsePairs(html);
  if (!totalMatch || (+totalMatch[1].replaceAll(',', '') > 0 && !hits.length)) throw error('UPSTREAM_FORMAT_CHANGED');
  return { total: Number(totalMatch[1].replaceAll(',', '')), hits };
}

function abortable(promise, signal, code = 'TOTAL_TIMEOUT') {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(error(code));
  return new Promise((resolve, reject) => {
    const stop = () => reject(error(code));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function createPublicClient({ fetchImpl = fetch, now = Date.now, ttlMs = 600000, maxEntries = 64, timeoutMs = 8000, minIntervalMs = 500, disabled = () => ['1','true','yes'].includes((process.env.DONGGUK_MCP_NO_CACHE || '').trim().toLowerCase()) } = {}) {
  const cache = new Map(), inflight = new Map(), nextRequest = new Map();
  async function request(source, path, body, budgetMs = timeoutMs, signal) {
    if (signal?.aborted) throw error('TOTAL_TIMEOUT');
    if (!SOURCES.includes(source) || source.key === 'dongguk' || !/^\/lmxsrv\/(law|search)\//.test(path)) throw error('SOURCE_NOT_ALLOWED');
    const key = source.key + ':' + path + ':' + (body || '');
    const hit = cache.get(key);
    if (!disabled() && hit && now() - hit.at < ttlMs) return hit.text;
    if (inflight.has(key)) return abortable(inflight.get(key), signal);
    const pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, budgetMs)));
      try {
        const slot = Math.max(Date.now(), nextRequest.get(source.key) || 0);
        nextRequest.set(source.key, slot + minIntervalMs);
        await abortable(new Promise(resolve => setTimeout(resolve, Math.max(0, slot - Date.now()))), controller.signal, 'UPSTREAM_UNAVAILABLE');
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
        if (path.includes('searchEngineTotal.')) parseUniversitySearch(html, true);
        if (path.includes('lawFullContent.')) {
          const parsed = parseExternalContent(html);
          if (!parsed.title || !listArticleBlocks(parsed.markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
        }
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        if (!disabled()) cache.set(key, { at: now(), text: html });
        return html;
      } finally { clearTimeout(timer); }
    })();
    inflight.set(key, pending);
    const cleanup = () => { if (inflight.get(key) === pending) inflight.delete(key); };
    pending.then(cleanup, cleanup);
    return abortable(pending, signal);
  }
  return { request };
}

function sourceUrl(s, hit) {
  return `${s.origin}/lmxsrv/law/lawFullView.${s.ext}?SEQ=${hit.lawId}&SEQ_HISTORY=${hit.historyId}`;
}

async function loadExternal(source, topic, terms, client, signal, spec = {}) {
  let hits, coverage;
  const searchTerms = uniq(spec.searchTerms || [topic]).slice(0, 2), hints = spec.titleHints || terms;
  const deadline = Date.now() + 15000;
  const request = (path, body) => {
    if (signal?.aborted) throw error('TOTAL_TIMEOUT');
    if (Date.now() >= deadline) throw error('UPSTREAM_UNAVAILABLE');
    return client.request(source, path, body, deadline - Date.now(), signal);
  };
  // 대표어로 먼저 찾고, 후보가 상한보다 적을 때만 다음 검색어(동의어)를 추가로 조회한다.
  const searchAll = async (run, mode) => {
    const merged = [], seen = new Set(), queries = [];
    let total = 0, pageCut = false;
    for (const q of searchTerms) {
      if (queries.length && merged.length >= MAX_RULES) break;
      const result = await run(q);
      queries.push(q); total += result.total; if (result.total > result.hits.length) pageCut = true;
      for (const h of result.hits) if (!seen.has(h.lawId)) { seen.add(h.lawId); merged.push(h); }
    }
    hits = merged;
    // totalCandidates는 검색어별 결과 수의 합(중복 포함). 잘림은 결과 페이지 미수신 또는 상한 초과로 판단.
    coverage = { mode, queries, totalCandidates: total, truncated: pageCut || merged.length > MAX_RULES };
  };
  const loadRecent = async () => {
    const pairs = parsePairs(await request(`/lmxsrv/law/lawNewList.${source.ext}`));
    if (!pairs.length) throw error('UPSTREAM_FORMAT_CHANGED');
    const named = pairs.filter(x => ruleTitleScore(x.title, terms, hints) > 0);
    // 최근 목록은 주제와 무관한 규정이 대부분이라, 제목 일치 규정 외에는 3개까지만 채워 읽는다.
    hits = [...named, ...pairs.filter(x => !named.includes(x))].slice(0, Math.max(3, Math.min(named.length, MAX_RULES)));
    coverage = { mode: 'recent_list_only', totalCandidates: pairs.length, truncated: pairs.length > hits.length, complete: false };
  };
  if (source.mode === 'search') {
    await searchAll(async q => parseUniversitySearch(await request(`/lmxsrv/search/lawSerach.${source.ext}`,
      new URLSearchParams({ PAGE: '1', PAGE_SHOW: '10', LAWGROUP: '0', SEARCH_TYPE: 'CONTENTS', SEARCH_TEXT: q }).toString())), 'full_text_search');
  } else if (source.mode === 'search_do') {
    await searchAll(async q => parseUniversitySearch(await request('/lmxsrv/search/searchEngineTotal.do',
      new URLSearchParams({ currentYN: '1', search_keyword: q, search_type: 'lawContents', search_page: '1' }).toString()), true), 'full_text_search_first_page');
  } else if (source.mode === 'tree') {
    let nodes = [];
    try { nodes = parseTree(await request(`/lmxsrv/law/lawTree.${source.ext}?${TREE_QUERY}`)); }
    catch (e) { if (['TOTAL_TIMEOUT'].includes(safeCode(e))) throw e; }
    if (nodes.length >= MIN_TREE_RULES) {
      // 제목만 대조하므로 제목에 주제어가 없는 규정 속 조문은 놓칠 수 있다(complete:false).
      hits = nodes.filter(x => ruleTitleScore(x.title, terms, hints) > 0);
      coverage = { mode: 'title_tree', totalCandidates: nodes.length, titleMatches: hits.length, truncated: hits.length > MAX_RULES, complete: false };
    } else await loadRecent();
  } else await loadRecent();
  const rules = [], failures = [];
  const query = compact(topic);
  const rank = hit => {
    const title = compact(hit.title.split(/제\s*\d+\s*조/)[0]).replace(/^[\d-]+/, '');
    return (title === query || title === query + '규정' ? 100 : title.includes(query) ? 30 : 0) + ruleTitleScore(hit.title, terms, hints) * 10;
  };
  hits.sort((a,b)=>rank(b)-rank(a));
  for (const hit of hits.slice(0, MAX_RULES)) {
    try {
      const parsed = parseExternalContent(await request(`/lmxsrv/law/lawFullContent.${source.ext}?SEQ=${hit.lawId}&SEQ_HISTORY=${hit.historyId}`));
      if (!parsed.title || !listArticleBlocks(parsed.markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
      const fromAddenda = hit.effectiveAt ? null : latestAddendaEffective(parsed.markdown);
      rules.push({ ...hit, ...parsed, url: sourceUrl(source, hit), revisedAt: hit.revisedAt || null,
        effectiveAt: hit.effectiveAt || fromAddenda || null, effectiveSource: hit.effectiveAt ? 'list' : fromAddenda ? 'addenda' : null });
    } catch (e) {
      failures.push({ lawId: hit.lawId, historyId: hit.historyId, code: safeCode(e) });
      if (['ACCESS_DENIED', 'SESSION_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'REDIRECT_NOT_FOLLOWED', 'TOTAL_TIMEOUT'].includes(safeCode(e))) break;
    }
  }
  return { rules, failures, coverage: { ...coverage, scannedRules: rules.length, attemptedRules: rules.length + failures.length } };
}

function safeCode(e) {
  if (/^HTTP (401|403):/.test(e?.message || '')) return 'ACCESS_DENIED';
  return ['ACCESS_DENIED', 'SESSION_REQUIRED', 'REDIRECT_NOT_FOLLOWED', 'UPSTREAM_FORMAT_CHANGED', 'UPSTREAM_UNAVAILABLE', 'TOTAL_TIMEOUT'].includes(e?.code) ? e.code : 'UPSTREAM_UNAVAILABLE';
}

function selectArticles(rules, terms, limit, hints = terms) {
  const matches = [];
  for (const rule of rules) {
    const ruleBonus = ruleTitleScore(rule.title, terms, hints) * 0.5;
    for (const block of listArticleBlocks(rule.markdown)) {
      if (block.supplementary) continue;
      const matchedTerms = terms.filter(t => block.content.includes(t));
      if (!matchedTerms.length) continue;
      // 조문 제목(첫 줄)에 주제어가 있으면 그 조문이 주제를 직접 다룬다고 보고 앞에 둔다.
      const heading = block.content.split('\n')[0];
      const score = matchedTerms.length + (matchedTerms.includes(terms[0]) ? 0.5 : 0) + (terms.some(t => heading.includes(t)) ? 2 : 0) + ruleBonus;
      matches.push({ universityRule: rule.title, lawId: rule.lawId, historyId: rule.historyId,
        article: block.canonical, text: block.content.slice(0, 2000), textTruncated: block.content.length > 2000,
        matchedTerms, url: rule.url, revisedAt: rule.revisedAt || null, effectiveAt: rule.effectiveAt || null,
        effectiveSource: rule.effectiveAt ? rule.effectiveSource || null : null, _score: score });
    }
  }
  matches.sort((a, b) => b._score - a._score);
  for (const m of matches) delete m._score;
  return { articles: matches.slice(0, limit), matchingArticles: matches.length, articlesTruncated: matches.length > limit };
}

const publicClient = createPublicClient();
async function compareUniversityRules(a, { loadDongguk, client = publicClient, now = () => new Date(), totalTimeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  const invalid = validateArguments(a);
  if (invalid) throw Object.assign(new Error(invalid), { code: 'INVALID_ARGUMENT' });
  const topic = a.topic.trim(), spec = expandTopic(topic), terms = spec.terms, columns = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
  try {
  // Sequential schools bound upstream concurrency and preserve deterministic order.
  for (const key of ['dongguk', ...new Set(a.universities)]) {
    const source = SOURCES.find(x => x.key === key);
    if (!source) { columns.push({ university: key, status: 'unsupported', articles: [] }); continue; }
    try {
      if (controller.signal.aborted) throw error('TOTAL_TIMEOUT');
      const result = await abortable(key === 'dongguk' ? loadDongguk(topic, terms, {signal:controller.signal, searchTerms:spec.searchTerms, titleHints:spec.titleHints}) : loadExternal(source, topic, terms, client, controller.signal, spec), controller.signal);
      const selected = selectArticles(result.rules, terms, a.max_articles || 3, spec.titleHints);
      const partial = result.coverage.complete === false || result.coverage.truncated || result.failures.length > 0 || selected.articlesTruncated || selected.articles.some(x => x.textTruncated);
      columns.push({ university: key, name: source.name, status: result.rules.length === 0 && result.failures.length ? 'unavailable' : selected.articles.length ? (partial ? 'partial' : 'retrieved') : 'no_match_in_scope', ...selected, coverage: result.coverage, failures: result.failures });
    } catch (e) { columns.push({ university: key, name: source.name, status: 'unavailable', code: safeCode(e), articles: [] }); }
  }
  return { topic, terms, searchTerms: spec.searchTerms, checkedAt: now().toISOString(), status: columns.every(x => x.status === 'retrieved') ? 'retrieved' : 'partial', columns,
    alignment: 'topic_keyword_matches_not_legal_equivalence', notice: NOTICE, supportedUniversities: SOURCES.map(x => ({ key: x.key, name: x.name, scope: x.mode })), limits:{totalTimeoutMs,externalRulesPerUniversity:MAX_RULES,minRequestIntervalMs:500} };
  } finally { clearTimeout(timer); }
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
      return a ? `${esc(a.universityRule)} ${esc(a.article)}<br>${esc(a.text.slice(0,240))}${a.text.length>240 ? ' …(본문 아래)' : ''}<br>개정일 ${esc(a.revisedAt)} / ${effectiveLabel(a)}<br>[원문](${a.url})` : '범위 내 발췌 없음';
    }).join(' | ') + ' |');
  }
  for (const c of data.columns) {
    if (!c.articles.length) continue;
    lines.push('', `## ${c.name || c.university} 조문 본문`);
    for (const a of c.articles) lines.push('', `### ${a.universityRule} ${a.article}`, a.text, a.textTruncated ? '[2,000자 제한으로 잘림]' : '', `[원문](${a.url})`);
  }
  lines.push('', ...data.columns.map(c => `- ${c.name || c.university}: ${c.coverage ? JSON.stringify(c.coverage) : c.status}${c.failures?.length ? ` / 실패 ${c.failures.length}건` : ''}`));
  return lines.join('\n');
}

function effectiveLabel(a) {
  if (!a.effectiveAt) return '시행일 미확인';
  return `시행일 ${a.effectiveAt} (${a.effectiveSource === 'list' ? '규정 목록 시행일자' : '마지막 부칙 명시 시행일'})`;
}

module.exports = { SOURCES, TOPICS, MAX_RULES, parsePairs, parseTree, parseUniversitySearch, parseExternalContent, createPublicClient, validateArguments, selectArticles, compareUniversityRules, formatComparison, loadExternal, safeCode, expandTopic, cleanListTitle, latestAddendaEffective, ruleTitleScore };

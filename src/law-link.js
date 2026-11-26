'use strict';

const crypto = require('node:crypto');
const { normalizeName } = require('./references.js');
const { legalServerState, legalSetupGuide } = require('./legal-client.js');

// Text of the national-law articles a rule cites, fetched from a Korean Law
// MCP server. The rule lookup never depends on it: when the law server is not
// configured, slow or down, the citations are still returned without text.
const MAX_LAW_ARTICLES = 3;
const MAX_TEXT_CHARS = 6000;
const CALL_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 35000;
const CACHE_SECONDS = 6 * 60 * 60;

// Law text is on whenever the law server is set up. The operator can switch it
// off for the public rules profile with DONGGUK_PUBLIC_LAW_LINK=0.
function lawLinkState(profile) {
  if (profile !== 'finance' && process.env.DONGGUK_PUBLIC_LAW_LINK === '0') return 'disabled_public';
  return legalServerState().state;
}
function lawLinkConfigured(profile) { return lawLinkState(profile) === 'ready'; }
// What to tell the reader when law text cannot be fetched: what is missing, what
// the operator can set, and that the rule-side result is unaffected.
function lawLinkGuide(profile) {
  const state = lawLinkState(profile);
  if (state === 'ready') return null;
  const guide = state === 'disabled_public'
    ? { state, env: ['DONGGUK_PUBLIC_LAW_LINK'], message: '서버 운영자가 이 공개 주소의 법령 연결을 꺼 두었습니다(DONGGUK_PUBLIC_LAW_LINK=0). 운영자가 이 값을 지우면 다시 켜집니다.' }
    : legalSetupGuide(state);
  return { ...guide, notice: `${guide.message} 규정 쪽 결과는 그대로입니다. 법령은 아래 법령명·조문으로 한국법령 MCP나 국가법령정보센터(law.go.kr)에서 확인하세요.` };
}

function planRequests(externalLaws) {
  const requests = [], skipped = [];
  for (const law of externalLaws || []) {
    if (!law.confirmedLawName) { skipped.push({ lawName: law.lawName, reason: 'LAW_NAME_UNCONFIRMED' }); continue; }
    if (!law.articles.length) { skipped.push({ lawName: law.lawName, reason: 'NO_ARTICLE_CITED' }); continue; }
    for (const article of law.articles) {
      if (requests.length < MAX_LAW_ARTICLES) requests.push({ law_name: law.lawName, article });
      else skipped.push({ lawName: law.lawName, article, reason: 'LIMIT' });
    }
  }
  return { requests, skipped };
}

function today() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); }

async function fetchCitedLaws(externalLaws, { profile, cached, queryLegalReferences }) {
  const { requests, skipped } = planRequests(externalLaws);
  const limits = { maxArticles: MAX_LAW_ARTICLES, maxTextChars: MAX_TEXT_CHARS, totalTimeoutMs: TOTAL_TIMEOUT_MS };
  if (!requests.length) return { status: 'not_required', laws: [], skipped, limits };
  const guide = lawLinkGuide(profile);
  if (guide) {
    const { notice, message, ...setup } = guide;
    return { status: 'not_configured', code: 'LAW_LINK_NOT_CONFIGURED', laws: [], skipped, limits, notice, setup };
  }
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const laws = [];
  for (const request of requests) {
    const entry = { lawName: request.law_name, article: request.article, status: 'unavailable' };
    laws.push(entry);
    const remaining = deadline - Date.now();
    if (remaining < 1000) { entry.code = 'LEGAL_TOTAL_TIMEOUT'; continue; }
    const key = crypto.createHash('md5').update([normalizeName(request.law_name), request.article, today()].join('|')).digest('hex');
    let result;
    try {
      result = await cached('law-link', key, CACHE_SECONDS, async () => {
        const summary = await queryLegalReferences([request], {
          timeoutMs: Math.min(CALL_TIMEOUT_MS, remaining), totalTimeoutMs: Math.min(TOTAL_TIMEOUT_MS, remaining),
          maxRequests: 1, maxTextChars: MAX_TEXT_CHARS,
        });
        const found = summary.results[0] || { status: 'unavailable', code: summary.code || 'LEGAL_LOOKUP_FAILED', articles: [] };
        // Only a retrieved body is worth caching; failures are retried next time.
        if (!found.articles?.[0]?.bodyRetrieved) throw Object.assign(new Error('law text unavailable'), { lawResult: found });
        return found;
      });
    } catch (error) {
      result = error.lawResult || { status: 'unavailable', code: 'LEGAL_LOOKUP_FAILED', articles: [] };
    }
    const article = result.articles?.[0];
    entry.status = article?.bodyRetrieved ? (article.truncated ? 'partial' : 'retrieved') : 'unavailable';
    if (article?.bodyRetrieved) {
      // The version was resolved from the current-law listing, so the provider's
      // generic "may not be current" notice for dated lookups does not apply.
      entry.text = article.text.replace(/^.*특정 시행일자\(efYd=\d+\) 버전 조회.*\n?/m, '');
      entry.truncated = Boolean(article.truncated);
      entry.source = article.source ? {
        provider: article.source.provider, lawName: article.source.lawName, lawId: article.source.lawId, mst: article.source.mst,
        effectiveAt: article.source.effectiveAt, url: article.source.url, retrievedAt: article.source.retrievedAt,
      } : null;
    }
    const code = article?.code || (entry.status === 'unavailable' ? result.code : null);
    if (code) entry.code = code;
  }
  const retrieved = laws.filter(x => x.status !== 'unavailable').length;
  const complete = laws.every(x => x.status === 'retrieved') && !skipped.some(x => x.reason === 'LIMIT');
  return { status: complete ? 'retrieved' : retrieved ? 'partial' : 'unavailable', laws, skipped, limits };
}

function formatCitedLaws(lawTexts) {
  if (!lawTexts || lawTexts.status === 'not_required') return '';
  const lines = ['', '### 인용 법령 원문 (한국법령 MCP)'];
  if (lawTexts.notice) lines.push('', lawTexts.notice);
  for (const law of lawTexts.laws) {
    lines.push('', `#### ${law.lawName} ${law.article}`);
    if (law.status === 'unavailable') { lines.push(`법령 원문을 가져오지 못했습니다(${law.code || 'LEGAL_LOOKUP_FAILED'}). 한국법령 MCP나 국가법령정보센터에서 직접 확인하세요.`); continue; }
    if (law.source) lines.push(`- 시행일 ${law.source.effectiveAt} · MST ${law.source.mst} · ${law.source.url}`);
    lines.push('', law.text.trim());
    if (law.truncated) lines.push('', `(본문이 길어 ${lawTexts.limits.maxTextChars}자까지만 표시했습니다.)`);
  }
  const limited = lawTexts.skipped.filter(x => x.reason === 'LIMIT');
  if (limited.length) lines.push('', `한 번에 ${lawTexts.limits.maxArticles}개 조문까지 가져옵니다. 생략: ${limited.map(x => `${x.lawName} ${x.article}`).join(', ')}`);
  const noArticle = lawTexts.skipped.filter(x => x.reason === 'NO_ARTICLE_CITED');
  if (noArticle.length) lines.push('', `조문을 특정하지 않은 인용은 원문을 가져오지 않았습니다: ${noArticle.map(x => x.lawName).join(', ')}`);
  if (lawTexts.laws.length) lines.push('', '법령 원문은 현행 기준입니다. 규정 제정·개정 당시의 조문과 다를 수 있고, 부칙·경과조치와 사건 적용 여부는 따로 확인해야 합니다.');
  return lines.join('\n') + '\n';
}

module.exports = { lawLinkConfigured, lawLinkState, lawLinkGuide, planRequests, fetchCitedLaws, formatCitedLaws, MAX_LAW_ARTICLES };

'use strict';

const crypto = require('node:crypto');
const { normalizeName } = require('./references.js');
const { parseDateLoose } = require('./timeline.js');
const { formatComparison } = require('./upper-law-comparison.js');

// National laws a rule rests on: the laws it cites by name, checked against the
// current-law listing, plus topic candidates for rules that cite none. Every
// signal is a point to review. None of them states that a rule conflicts with
// a law or that a law applies to a case.
const MAX_LAWS = 12;
const MAX_ARTICLES = 8;
const MAX_TEXT_CHARS = 3000;
const CALL_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 40000;
const CACHE_SECONDS = 6 * 60 * 60;

// Law names only, each confirmed in the current-law listing on 2026-11-22.
// A topic match is a starting point for the reader, never a stated legal basis.
const TOPIC_CANDIDATES = [
  { topic: '재무·회계', pattern: /재무|회계|예산|결산|자금/, laws: ['사립학교법', '사학기관 재무ㆍ회계 규칙', '사학기관 재무ㆍ회계 규칙에 대한 특례규칙'] },
  { topic: '등록금', pattern: /등록금|수업료/, laws: ['고등교육법', '대학 등록금에 관한 규칙'] },
  { topic: '여비·출장', pattern: /여비|출장/, laws: ['소득세법', '소득세법 시행령', '공무원 여비 규정'] },
  { topic: '퇴직급여', pattern: /퇴직/, laws: ['근로자퇴직급여 보장법', '사립학교교직원 연금법'] },
  { topic: '보수·수당', pattern: /보수|급여|수당|봉급/, laws: ['근로기준법', '소득세법'] },
  { topic: '복무·근로조건', pattern: /취업규칙|복무|휴가|근로/, laws: ['근로기준법'] },
  { topic: '교원 인사', pattern: /교원|교수|강사|겸직/, laws: ['사립학교법', '고등교육법', '교육공무원법'] },
  { topic: '연구비·산학협력', pattern: /연구비|산학협력(?!단\s*취업규칙)|연구개발/, laws: ['산업교육진흥 및 산학연협력촉진에 관한 법률', '국가연구개발혁신법'] },
  { topic: '계약·구매', pattern: /계약|구매|입찰|조달/, laws: ['국가를 당사자로 하는 계약에 관한 법률'] },
  { topic: '개인정보', pattern: /개인정보/, laws: ['개인정보 보호법'] },
];

function topicCandidates(title) {
  const found = new Map();
  for (const entry of TOPIC_CANDIDATES) {
    if (!entry.pattern.test(String(title || ''))) continue;
    for (const lawName of entry.laws) {
      const key = normalizeName(lawName);
      if (!found.has(key)) found.set(key, { lawName, topics: [] });
      found.get(key).topics.push(entry.topic);
    }
  }
  return [...found.values()];
}

// Latest revision note inside a rule article, e.g. "(2018.11.12. 개정)".
function latestAnnotatedDate(content) {
  let latest = null;
  for (const m of String(content || '').matchAll(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?[^)\]>\n]{0,12}(?:개정|신설|제정|이동)/g)) {
    const parsed = parseDateLoose(`${m[1]}-${m[2]}-${m[3]}`);
    if (parsed && (!latest || parsed.ts > latest.ts)) latest = parsed;
  }
  return latest?.iso || null;
}

// references: outgoing items from extractReferences with sourceLocation and the citing block's text.
function planLaws(references, { title, includeCandidates = true, maxLaws = MAX_LAWS, offset = 0 } = {}) {
  const laws = new Map();
  for (const item of references) {
    if (item.scope !== 'external_law' && !item.externalCandidate) continue;
    const name = item.target.lawName || item.target.name;
    const key = JSON.stringify([normalizeName(name), normalizeName(item.nameCandidate)]);
    const law = laws.get(key) || { lawName: name, relation: 'cited', nameStatus: item.scope === 'external_law' ? 'law_name' : 'candidate_name', nameGuessed: true, articles: [], citedBy: [], ...(item.nameCandidate ? { nameCandidate: item.nameCandidate } : {}) };
    if (!item.nameExtended) law.nameGuessed = false;
    if (item.article && !law.articles.includes(item.article)) law.articles.push(item.article);
    law.citedBy.push({
      ...(item.sourceLocation?.blockId ? { ruleBlockId: item.sourceLocation.blockId } : {}),
      ruleArticle: item.sourceLocation?.article || null, lawArticle: item.article || null, ...(item.paragraph ? { paragraph: item.paragraph } : {}),
      citationText: item.citationText, resolutionStatus: item.resolutionStatus, ruleArticleAnnotatedAt: item.ruleArticleAnnotatedAt || null,
    });
    laws.set(key, law);
  }
  const cited = [...laws.values()];
  const candidates = includeCandidates
    ? topicCandidates(title).filter(x => !cited.some(law => normalizeName(law.lawName) === normalizeName(x.lawName))).map(x => ({ lawName: x.lawName, relation: 'topic_candidate', nameStatus: 'law_name', nameGuessed: false, topics: x.topics, articles: [], citedBy: [] }))
    : [];
  const all = [...cited, ...candidates];
  // Laws past max_laws are not dropped: page.nextOffset continues from there.
  const start = Math.min(Math.max(0, offset || 0), all.length);
  const end = start + maxLaws;
  return {
    laws: all.slice(start, end), omitted: all.slice(end).map(x => ({ lawName: x.lawName, relation: x.relation })),
    page: { offset: start, returned: Math.max(0, Math.min(end, all.length) - start), total: all.length, nextOffset: end < all.length ? end : null },
  };
}

const later = (a, b) => Boolean(a && b && a > b);

function signalsFor(law, { ruleRevisedAt }) {
  const signals = [];
  const add = (code, level, message) => signals.push({ code, level, message });
  const id = law.identity;
  if (!id || id.status === 'not_checked') return signals;
  if (id.status === 'unavailable') { add('LAW_LOOKUP_FAILED', 'unknown', `법령 서버에서 확인하지 못했습니다(${id.code || 'LEGAL_LOOKUP_FAILED'}).`); return signals; }
  if (id.status === 'not_found') {
    add(law.nameStatus === 'candidate_name' ? 'NAME_NOT_A_CURRENT_LAW' : 'LAW_NOT_FOUND', law.nameStatus === 'candidate_name' ? 'info' : 'review',
      law.nameStatus === 'candidate_name'
        ? '현행 법령 목록에 같은 이름이 없습니다. 행정규칙·다른 기관 규정이거나 교내 규정의 옛 이름일 수 있습니다.'
        : `현행 법령 목록에 같은 이름이 없습니다. 폐지·제명 변경·표기 오류를 확인하세요.${id.similar?.length ? ` 비슷한 이름: ${id.similar.join(', ')}` : ''}`);
    return signals;
  }
  if (id.status === 'renamed') add('LAW_RENAMED', 'review', `규정이 옛 법령명 「${id.renamedFrom}」을 인용합니다. 현행 제명은 「${id.name}」입니다. 제명이 바뀌면서 조문 번호가 달라졌을 수 있습니다.`);
  if (id.notYetEffective) add('LAW_NOT_YET_EFFECTIVE', 'check', `목록의 현행본 시행일(${id.effectiveAt})이 오늘 이후입니다.`);
  for (const pending of id.pendingAmendments || []) add('PENDING_AMENDMENT', 'check', `${pending.kind} 시행예정: ${pending.effectiveAt} 시행(${pending.promulgatedAt} 공포).`);
  if (law.relation === 'cited' && later(id.effectiveAt, ruleRevisedAt)) add('LAW_EFFECTIVE_AFTER_RULE', 'info', `법령 현행본 시행일(${id.effectiveAt})이 규정 개정일(${ruleRevisedAt})보다 늦습니다. 규정 개정 뒤 법령이 바뀌었습니다.`);
  for (const article of law.articles) {
    if (article.versionCheck === 'unverified') add('ARTICLE_VERSION_UNVERIFIED', 'unknown',
      `${article.article} 본문 시행일 미확인: 목록 ${id.effectiveAt || '미확인'}, 응답 ${article.source?.bodyEffectiveAt || '미확인'}. 현행 조문 본문으로 제시하지 않습니다.`);
    if (article.status === 'missing') add('ARTICLE_MISSING', 'review', `${article.article}가 현행 「${id.name}」에 없습니다.`);
    if (article.status === 'deleted') add('ARTICLE_DELETED', 'review', `${article.article}는 현행 「${id.name}」에서 삭제된 조문입니다.`);
    if (article.status === 'found') {
      const basis = article.ruleArticleAnnotatedAt || ruleRevisedAt;
      if (later(article.lastAmendedAt, basis)) add('ARTICLE_AMENDED_AFTER_RULE', 'check',
        `${article.article}의 최근 개정 표시(${article.lastAmendedAt} 공포)가 ${article.ruleArticleAnnotatedAt ? '인용한 규정 조문의 개정 표시일' : '규정 개정일'}(${basis})보다 늦습니다.`);
      if (id.status === 'renamed') add('ARTICLE_NUMBER_UNVERIFIED', 'review', `${article.article}는 현행 「${id.name}」의 같은 번호 조문입니다. 옛 법령에서 인용한 조문과 같은 내용인지 확인하세요.`);
    }
  }
  return signals;
}

function today() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); }

async function buildUpperLaws({ references, title, ruleRevisedAt, includeCandidates, includeText, maxLaws, lawOffset = 0, configured, setupGuide, cached, inspectLaws }) {
  const plan = planLaws(references, { title, includeCandidates, maxLaws, offset: lawOffset });
  const limits = { maxLaws: maxLaws || MAX_LAWS, maxArticles: MAX_ARTICLES, maxTextChars: MAX_TEXT_CHARS, totalTimeoutMs: TOTAL_TIMEOUT_MS };
  const revised = parseDateLoose(ruleRevisedAt)?.iso || null;
  const laws = plan.laws.map(law => ({ ...law, identity: { status: 'not_checked' }, articles: law.articles.map(article => ({ article, status: 'not_checked' })) }));
  let lookup = { status: laws.length ? 'not_configured' : 'not_required' };
  if (laws.length && configured) {
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    let budget = MAX_ARTICLES;
    for (const law of laws) {
      const articles = law.articles.map(x => x.article).slice(0, Math.max(0, budget));
      budget -= articles.length;
      const remaining = deadline - Date.now();
      if (remaining < 1000) { law.identity = { status: 'unavailable', code: 'LEGAL_TOTAL_TIMEOUT' }; continue; }
      // Do not reuse pre-validation entries; leave the old cache files untouched.
      const key = crypto.createHash('md5').update(['effective-date-v2', normalizeName(law.lawName), law.nameGuessed ? 'guess' : 'name', articles.join(','), law.nameCandidate || '', today()].join('|')).digest('hex');
      let found;
      try {
        found = await cached('upper-law', key, CACHE_SECONDS, async () => {
          const result = await inspectLaws([{ name: law.lawName, articles, suffixMatch: law.nameGuessed, ...(law.nameCandidate ? { nameCandidate: law.nameCandidate } : {}) }], {
            timeoutMs: Math.min(CALL_TIMEOUT_MS, remaining), totalTimeoutMs: Math.min(TOTAL_TIMEOUT_MS, remaining), maxLaws: 1, maxArticles: MAX_ARTICLES, maxTextChars: MAX_TEXT_CHARS,
          });
          const entry = result.laws[0];
          // Failures are retried on the next call instead of being cached.
          if (!entry || entry.identity.status === 'unavailable' || entry.articles.some(x => x.status === 'unavailable')) throw Object.assign(new Error('law lookup incomplete'), { partial: entry });
          return entry;
        });
      } catch (error) { found = error.partial || { identity: { status: 'unavailable', code: 'LEGAL_LOOKUP_FAILED' }, articles: [] }; }
      law.identity = found.identity;
      law.articles = law.articles.map(article => {
        const checked = found.articles.find(x => x.article === article.article);
        if (!checked) return { ...article, code: 'ARTICLE_LIMIT' };
        const { text, ...facts } = checked;
        const annotated = law.citedBy.filter(x => x.lawArticle === article.article).map(x => x.ruleArticleAnnotatedAt).filter(Boolean).sort().pop() || null;
        return { ...facts, ruleArticleAnnotatedAt: annotated, ...(includeText && text ? { text } : {}) };
      });
    }
    const checked = laws.filter(x => ['current', 'renamed', 'not_found'].includes(x.identity.status)).length;
    const articlesOpen = laws.some(x => x.articles.some(a => ['unavailable', 'not_checked'].includes(a.status)) && x.identity.status !== 'not_found');
    lookup = { status: checked === laws.length && !articlesOpen ? 'retrieved' : checked ? 'partial' : 'unavailable' };
  } else if (laws.length) {
    lookup.code = 'LAW_LINK_NOT_CONFIGURED';
    lookup.notice = setupGuide?.notice || '이 서버에는 법령 연결 정보가 없어 법령의 현행 여부·조문을 확인하지 못했습니다. 규정 쪽 결과는 그대로입니다. 아래 법령명·조문으로 한국법령 MCP나 국가법령정보센터(law.go.kr)에서 확인하세요.';
    if (setupGuide) { const { notice, message, ...setup } = setupGuide; lookup.setup = setup; }
  }
  for (const law of laws) law.signals = signalsFor(law, { ruleRevisedAt: revised });
  const counts = {
    cited: laws.filter(x => x.relation === 'cited').length,
    topicCandidates: laws.filter(x => x.relation === 'topic_candidate').length,
    review: laws.reduce((sum, x) => sum + x.signals.filter(s => s.level === 'review').length, 0),
    check: laws.reduce((sum, x) => sum + x.signals.filter(s => s.level === 'check').length, 0),
    omitted: plan.omitted.length,
  };
  return { lookup, laws, omitted: plan.omitted, page: plan.page, counts, limits, ruleRevisedAt: revised };
}

const RELATION = { cited: '규정이 인용', topic_candidate: '주제 후보(인용 없음)' };
const IDENTITY = { current: '현행', renamed: '제명 변경', not_found: '목록에 없음', unavailable: '확인 실패', not_checked: '미확인' };
const ARTICLE = { found: '있음', deleted: '삭제됨', missing: '없음', unavailable: '확인 실패', not_checked: '미확인' };
const LEVEL = { review: '검토 필요', check: '확인', info: '참고', unknown: '미확인' };
const CAVEAT = '점검 신호는 규정을 다시 볼 지점입니다. 법령과 규정의 충돌이나 적용 여부를 판정한 것이 아닙니다. 조문 개정 표시는 공포일 기준이고, 시행일·부칙·경과조치는 법령 원문에서 확인해야 합니다. 주제 후보는 규정 제목으로 고른 목록이며 근거 법령으로 확정된 것이 아닙니다.';

function formatUpperLaws(result, { title, selectorLabel }) {
  const cell = value => String(value ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
  const lines = [`## ${title} ${selectorLabel ? `${selectorLabel} ` : ''}상위법령 관계`, `- 규정 개정일: ${result.ruleRevisedAt || '미상'}`,
    `- 법령 ${result.laws.length}건 (규정이 인용 ${result.counts.cited}, 주제 후보 ${result.counts.topicCandidates}) / 검토 필요 ${result.counts.review}건, 확인 ${result.counts.check}건`,
    `- 법령 조회 상태: ${result.lookup.status}${result.lookup.code ? ` (${result.lookup.code})` : ''}`];
  if (result.lookup.notice) lines.push('', result.lookup.notice);
  if (!result.laws.length) lines.push('', '이 규정이 이름을 적어 인용한 국가 법령과 제목으로 고른 주제 후보가 없습니다.');
  else {
    lines.push('', '| 법령 | 관계 | 현행 여부 | 종류 | 현행본 시행일 | 인용 조문(현행 상태) | 규정 내 위치 |', '|---|---|---|---|---|---|---|');
    for (const law of result.laws) {
      const id = law.identity;
      const name = id.name && normalizeName(id.name) !== normalizeName(law.lawName) ? `${law.lawName} → ${id.name}` : (id.name || law.lawName);
      const articles = law.articles.map(a => `${a.article}${a.title ? `(${a.title})` : ''} ${ARTICLE[a.status]}`).join(', ') || '-';
      const where = [...new Set(law.citedBy.map(x => x.ruleArticle).filter(Boolean))].slice(0, 6).join(', ') || (law.topics ? law.topics.join(', ') : '-');
      lines.push(`| ${cell(name)} | ${RELATION[law.relation]} | ${IDENTITY[id.status]} | ${cell(id.kind || '-')} | ${id.effectiveAt || '-'} | ${cell(articles)} | ${cell(where)} |`);
    }
    const flagged = result.laws.filter(law => law.signals.length);
    if (flagged.length) {
      lines.push('', '### 점검 신호');
      for (const law of flagged) for (const signal of law.signals) lines.push(`- [${LEVEL[signal.level]}] ${law.lawName}: ${signal.message}`);
    }

  }
  if (result.page?.offset) lines.push('', `법령 ${result.page.total}건 중 ${result.page.offset + 1}~${result.page.offset + result.page.returned}번째를 확인했습니다.`);
  if (result.omitted.length) lines.push('', `한 번에 ${result.limits.maxLaws}개 법령까지 확인합니다. 남은 법령 ${result.omitted.length}건: ${result.omitted.map(x => x.lawName).join(', ')}${result.page?.nextOffset != null ? ` — law_offset=${result.page.nextOffset}로 이어서 확인하세요.` : ''}`);
  if (result.laws.some(law => law.articles.some(a => a.code === 'ARTICLE_LIMIT'))) lines.push('', `조문 확인은 한 번에 ${result.limits.maxArticles}개까지입니다. article을 지정해 나누어 조회하세요.`);
  if (result.comparison) lines.push('', formatComparison(result.comparison, result.laws));
  lines.push('', CAVEAT);
  return lines.join('\n');
}

module.exports = { TOPIC_CANDIDATES, topicCandidates, latestAnnotatedDate, planLaws, signalsFor, buildUpperLaws, formatUpperLaws, CAVEAT, MAX_LAWS, MAX_ARTICLES };

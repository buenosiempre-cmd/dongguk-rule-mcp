'use strict';

// Explicit citations inside rule text: other Dongguk rules and national laws.
// An extracted citation shows that the text names a source. It does not show
// that the source applies to a given case.
const QUOTED = /[「『]([^」』\n]{2,60})[」』]/g;
const NOT_A_RULE = /^(?:별표|별지|서식|별첨|붙임|부록)/;
const ARTICLE_AFTER = /^\s*(?:\([^)\n]{0,60}\)\s*)?(?:에서\s*|의\s*)?제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/;
const UNQUOTED_LAW = /([가-힣A-Za-z0-9·ㆍ]{2,30}(?:법률|법)(?:\s?시행령|\s?시행규칙)?)\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g;
const ANY_ARTICLE = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g;
const LAW_SUFFIX = /(?:법|법률|시행령|시행규칙)$/;
const EXTERNAL_CANDIDATE_SUFFIX = /(?:규칙|규정|고시|훈령|예규|기준|지침|조례)$/;
// "동법", "같은 법" refer back to an earlier name; words such as 방법 are not laws.
const LAW_STOP = /^(?:동법|이법|본법|같은법|해당법|관련법|관계법|방법|기법|용법|요법|수법|문법|편법|위법|적법|불법|합법)(?:시행령|시행규칙)?$/;

function normalizeName(value) {
  return String(value || '').replace(/[\s·ㆍ‧•・.]/g, '');
}

function articleLabel(number, subNumber) {
  return number ? `제${Number(number)}조${subNumber ? `의${Number(subNumber)}` : ''}` : null;
}

function contextOf(text, start, end) {
  const from = Math.max(0, start - 30), to = Math.min(text.length, end + 40);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

function createResolver(catalog, self = {}) {
  const byName = new Map();
  for (const rule of catalog || []) {
    const key = normalizeName(rule.title);
    // Two rules with the same normalized title cannot be told apart by name.
    byName.set(key, byName.has(key) ? null : rule);
  }
  const selfName = normalizeName(self.title);
  const titles = [...byName.keys()].sort((a, b) => b.length - a.length);

  function classify(name, quoted) {
    const key = normalizeName(name);
    if (selfName && key === selfName) return { scope: 'same_rule', target: { lawId: self.lawId || null, title: self.title }, resolutionStatus: 'exact_title' };
    if (byName.has(key)) {
      const rule = byName.get(key);
      if (!rule) return { scope: 'unresolved', target: { name }, resolutionStatus: 'ambiguous_title' };
      return { scope: 'dongguk_rule', target: { lawId: rule.lawId, title: rule.title }, resolutionStatus: 'exact_title' };
    }
    if (LAW_SUFFIX.test(key)) return { scope: 'external_law', target: { lawName: name.trim() }, resolutionStatus: quoted ? 'quoted_name' : 'name_heuristic' };
    return {
      scope: 'unresolved', target: { name: name.trim() },
      resolutionStatus: 'not_in_current_catalog',
      ...(quoted && EXTERNAL_CANDIDATE_SUFFIX.test(key) ? { externalCandidate: true } : {}),
    };
  }

  // Longest current rule title that ends right before an unquoted "제N조".
  function titleEndingAt(prefix) {
    const tail = normalizeName(prefix.slice(-60));
    return titles.find(title => title.length >= 3 && tail.endsWith(title)) || null;
  }

  return { classify, titleEndingAt, ruleByKey: key => byName.get(key) };
}

function extractReferences(text, resolver) {
  const source = String(text || '');
  const found = [];
  const taken = [];
  const overlaps = (start, end) => taken.some(([a, b]) => start < b && end > a);
  const push = (start, end, name, article, quoted, forced) => {
    const resolved = forced || resolver.classify(name, quoted);
    found.push({
      citationText: contextOf(source, start, end),
      name: name.trim(), article, position: start,
      ...resolved,
      target: { ...resolved.target, ...(article ? { article } : {}) },
    });
    taken.push([start, end]);
  };

  let match;
  QUOTED.lastIndex = 0;
  while ((match = QUOTED.exec(source)) !== null) {
    const name = match[1].trim();
    if (NOT_A_RULE.test(name)) continue;
    const after = ARTICLE_AFTER.exec(source.slice(match.index + match[0].length, match.index + match[0].length + 90));
    const end = match.index + match[0].length + (after ? after[0].length : 0);
    push(match.index, end, name, after ? articleLabel(after[1], after[2]) : null, true);
  }

  UNQUOTED_LAW.lastIndex = 0;
  while ((match = UNQUOTED_LAW.exec(source)) !== null) {
    const end = match.index + match[0].length;
    if (overlaps(match.index, end) || LAW_STOP.test(normalizeName(match[1]))) continue;
    push(match.index, end, match[1], articleLabel(match[2], match[3]), false);
  }

  ANY_ARTICLE.lastIndex = 0;
  while ((match = ANY_ARTICLE.exec(source)) !== null) {
    const end = match.index + match[0].length;
    if (overlaps(match.index, end)) continue;
    const title = resolver.titleEndingAt(source.slice(Math.max(0, match.index - 80), match.index));
    if (!title) continue;
    const rule = resolver.ruleByKey(title);
    if (!rule) continue;
    const resolved = resolver.classify(rule.title, false);
    push(match.index, end, rule.title, articleLabel(match[1], match[2]), false, { ...resolved, resolutionStatus: 'name_heuristic' });
  }

  const seen = new Set();
  return found.sort((a, b) => a.position - b.position).filter(item => {
    const key = [item.scope, normalizeName(item.name), item.article || ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ position, ...item }) => item);
}

// Law names with the articles cited, ready to pass to a national-law lookup.
function summarizeExternalLaws(references) {
  const laws = new Map();
  for (const item of references) {
    if (item.scope !== 'external_law' && !item.externalCandidate) continue;
    const name = item.target.lawName || item.target.name;
    // 「사학기관 재무회계 규칙」 and 「사학기관 재무ㆍ회계 규칙」 are one law.
    const key = normalizeName(name);
    const entry = laws.get(key) || { lawName: name, articles: [], citations: 0, confirmedLawName: item.scope === 'external_law' };
    entry.citations++;
    if (item.article && !entry.articles.includes(item.article)) entry.articles.push(item.article);
    laws.set(key, entry);
  }
  return [...laws.values()];
}

module.exports = { normalizeName, createResolver, extractReferences, summarizeExternalLaws };

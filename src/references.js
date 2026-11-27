'use strict';

// Explicit citations inside rule text: other Dongguk rules and national laws.
// An extracted citation shows that the text names a source. It does not show
// that the source applies to a given case.
const QUOTED = /[「『]([^」』\n]{2,60})[」』]/g;
const NOT_A_RULE = /^(?:별표|별지|서식|별첨|붙임|부록)/;
const ARTICLE_AFTER = /^\s*(?:\([^)\n]{0,60}\)\s*)?(?:에서\s*|의\s*)?(?=제\s*\d+\s*조)/;
// One cited article: 제N조(의M)(제K항)(제L호). 항 is kept; 호·목 are consumed only.
const ARTICLE_ITEM = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?:\s*제\s*(\d+)\s*항)?(?:\s*제\s*\d+\s*호(?:\s*[가-하]목)?)?/;
// "제29조, 제31조 및 제32조의2" lists belong to the law named before them.
const ARTICLE_SEPARATOR = /^\s*(?:,|ㆍ|·|및|또는|내지|부터|와|과)\s*(?=제\s*\d+\s*조)/;
const UNQUOTED_LAW = /([가-힣A-Za-z0-9·ㆍ]{0,30}(?:법률|법))((?:\s?시행령|\s?시행규칙)?)\s*(?=(?:\(\s*이하[^)\n]{1,60}\)\s*)?제\s*\d+\s*조)/g;
const ANAPHORA = /(?:동\s?법|같은\s?법)((?:\s?시행령|\s?시행규칙)?)\s*(?=제\s*\d+\s*조)/g;
const ABBREVIATION = /^\s*\(\s*이하\s*["“”'‘’]\s*([^"“”'‘’\n]{1,20}?)\s*["“”'‘’]\s*(?:이)?라\s*(?:한다|함)\.?\s*\)/;
const ANY_ARTICLE = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g;
const LAW_SUFFIX = /(?:법|법률|시행령|시행규칙)$/;
const EXTERNAL_CANDIDATE_SUFFIX = /(?:규칙|규정|고시|훈령|예규|기준|지침|조례)$/;
// "동법", "같은 법" refer back to an earlier name; words such as 방법 are not laws.
const LAW_STOP = /^(?:동법|이법|본법|같은법|해당법|관련법|관계법|방법|기법|용법|요법|수법|문법|편법|위법|적법|불법|합법)(?:시행령|시행규칙)?$/;
// "평가방법 제5조", "처리기법 제2조": compound nouns that end in 법 but name no law.
const NOT_A_LAW_TAIL = /(?:방법|기법|요법|수법|문법|용법|편법|위법|적법|불법|합법|해법|화법|작법|비법|어법)$/;
// Unquoted names written with spaces: only the last word reaches the pattern above.
const GENERIC_LAW_TAIL = /^(?:보장법|특별법|특례법|기본법|촉진법|지원법|진흥법|육성법|관리법|보호법|연금법|조치법)$/;
const NAME_WORD = /^[가-힣A-Za-z0-9·ㆍ]+$/;
const NAME_BOUNDARY = /^(?:이|그|본|및|또는|다만|또한|경우|때)$|(?:따라|따른|의하여|의한|의거|하여|하며|하고|한다|에는|에서는|으로서|로서|이나|거나)$/;
const MAX_NAME_WORDS = 8;

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

// Articles listed right after a name: [{ article, paragraph }] and the text length consumed.
function readArticles(tail) {
  const articles = [];
  let consumed = 0;
  for (;;) {
    const item = ARTICLE_ITEM.exec(tail.slice(consumed));
    if (!item) break;
    articles.push({ article: articleLabel(item[1], item[2]), paragraph: item[3] ? `제${Number(item[3])}항` : null });
    consumed += item[0].length;
    const separator = ARTICLE_SEPARATOR.exec(tail.slice(consumed));
    if (!separator) break;
    consumed += separator[0].length;
  }
  return { articles, consumed };
}

// "근로자퇴직급여 보장법", "국가를 당사자로 하는 계약에 관한 법률": the words before
// the last one are part of the name. The result is a best guess; a caller that can
// reach a law server should confirm it against the official name.
function extendLawName(source, start, base, acrossAnd = false) {
  const words = source.slice(Math.max(0, start - 90), start).split('\n').pop().split(/[ \t]+/).filter(Boolean);
  // Nothing precedes on this line, or the base is glued to the previous character.
  if (!words.length || !/[ \t]$/.test(source.slice(0, start))) return { name: base, start };
  const previous = words[words.length - 1];
  const bare = base === '법률' || base === '법';
  const wide = bare || /(?:관한|위한|대한)$/.test(previous);
  if (!wide && !GENERIC_LAW_TAIL.test(base)) return { name: base, start };
  const taken = [];
  for (let i = words.length - 1; i >= 0 && taken.length < (wide ? MAX_NAME_WORDS : 1); i--) {
    // Only a conjunction inside a bounded '…에 관한 법률' candidate may be
    // crossed. Ordinary sentence conjunctions remain boundaries, as do another
    // law's name on the left. The widened candidate still needs official matching.
    const internalAnd = acrossAnd && words[i] === '및' && base === '법률' &&
      taken.some(word => /^(?:관한|위한|대한)$/.test(word)) && taken.length + 1 < MAX_NAME_WORDS &&
      i > 0 && NAME_WORD.test(words[i - 1]) && !NAME_BOUNDARY.test(words[i - 1]) && !LAW_SUFFIX.test(words[i - 1]);
    if (!NAME_WORD.test(words[i]) || (NAME_BOUNDARY.test(words[i]) && !internalAnd)) break;
    taken.unshift(words[i]);
  }
  if (!taken.length) return { name: bare ? null : base, start };
  const prefix = taken.join(' ');
  const from = source.lastIndexOf(taken[0], start - 1 - (prefix.length - taken[0].length));
  return { name: `${prefix} ${base}`, start: from >= 0 ? from : start, extended: true };
}

function extractReferences(text, resolver) {
  const source = String(text || '');
  const found = [];
  const taken = [];
  const abbreviations = [];
  const overlaps = (start, end) => taken.some(([a, b]) => start < b && end > a);
  const push = (start, end, name, articles, quoted, forced) => {
    const resolved = forced || resolver.classify(name, quoted);
    const list = articles.length ? articles : [{ article: null, paragraph: null }];
    for (const { article, paragraph } of list) {
      found.push({
        citationText: contextOf(source, start, end),
        name: name.trim(), article, ...(paragraph ? { paragraph } : {}), position: start,
        ...resolved,
        target: { ...resolved.target, ...(article ? { article } : {}) },
      });
    }
    taken.push([start, end]);
    return resolved;
  };
  // Articles that follow position `at`, after an optional "(이하 …)" or "의".
  const articlesAfter = at => {
    const tail = source.slice(at, at + 200);
    const lead = ARTICLE_AFTER.exec(tail);
    if (!lead) return { articles: [], end: at };
    const { articles, consumed } = readArticles(tail.slice(lead[0].length));
    return { articles, end: at + lead[0].length + consumed };
  };

  let match;
  QUOTED.lastIndex = 0;
  while ((match = QUOTED.exec(source)) !== null) {
    const name = match[1].trim();
    if (NOT_A_RULE.test(name)) continue;
    const after = match.index + match[0].length;
    const { articles, end } = articlesAfter(after);
    const resolved = push(match.index, end, name, articles, true);
    const abbreviation = ABBREVIATION.exec(source.slice(after, after + 60));
    if (abbreviation && (resolved.scope === 'external_law' || resolved.externalCandidate)) abbreviations.push({ short: abbreviation[1].trim(), name, resolved, definedAt: after });
  }

  UNQUOTED_LAW.lastIndex = 0;
  while ((match = UNQUOTED_LAW.exec(source)) !== null) {
    const { articles, end } = articlesAfter(match.index + match[0].length);
    if (!articles.length || overlaps(match.index, end)) continue;
    const key = normalizeName(match[1]);
    if (LAW_STOP.test(key + normalizeName(match[2])) || NOT_A_LAW_TAIL.test(key)) continue;
    // "같은 법 제13조" is a back-reference handled below, not a law named "같은 법".
    if ((match[1] === '법' || match[1] === '법률') && /(?:같은|동|이|본|해당|관련|관계)[ \t]*$/.test(source.slice(Math.max(0, match.index - 6), match.index))) continue;
    const extended = extendLawName(source, match.index, match[1]);
    if (!extended.name || overlaps(extended.start, end)) continue;
    const suffix = match[2] ? ` ${match[2].trim()}` : '';
    const name = `${extended.name}${suffix}`;
    // Keep the established boundary in the extracted name. Crossing '및' only
    // supplies a candidate; a law provider must confirm its full official name.
    const wider = extendLawName(source, match.index, match[1], true);
    const nameCandidate = wider.name && wider.name !== extended.name && !overlaps(wider.start, end)
      ? `${wider.name}${suffix}` : null;
    push(extended.start, end, name, articles, false, extended.extended
      ? { scope: 'external_law', target: { lawName: name }, resolutionStatus: 'name_heuristic', nameExtended: true,
        ...(nameCandidate ? { nameCandidate } : {}) } : undefined);
  }

  // "동법 제4조", "같은 법 시행령 제5조": the nearest law named earlier in this text.
  ANAPHORA.lastIndex = 0;
  while ((match = ANAPHORA.exec(source)) !== null) {
    const { articles, end } = articlesAfter(match.index + match[0].length);
    if (!articles.length || overlaps(match.index, end)) continue;
    // The nearest law before this point, whichever pass found it.
    const antecedent = found.filter(item => item.position < match.index && item.scope === 'external_law').sort((x, y) => x.position - y.position).pop();
    if (!antecedent) continue;
    const base = antecedent.name.replace(/\s?(?:시행령|시행규칙)$/, '');
    const suffix = match[1].trim();
    const name = suffix ? `${base} ${suffix}` : base;
    const candidateBase = antecedent.nameCandidate?.replace(/\s?(?:시행령|시행규칙)$/, '');
    push(match.index, end, name, articles, false, { scope: 'external_law', target: { lawName: name }, resolutionStatus: 'anaphora',
      ...(antecedent.nameExtended ? { nameExtended: true } : {}),
      ...(candidateBase ? { nameCandidate: suffix ? `${candidateBase} ${suffix}` : candidateBase } : {}),
    });
  }

  // 「…법 시행령」(이하 "시행령"이라 한다) … 시행령 제30조
  for (const { short, name, resolved, definedAt } of abbreviations) {
    if (short.length < 2) continue;
    const pattern = new RegExp(`${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?=제\\s*\\d+\\s*조)`, 'g');
    while ((match = pattern.exec(source)) !== null) {
      const { articles, end } = articlesAfter(match.index + match[0].length);
      // A short name means the law only after its definition.
      if (match.index < definedAt || !articles.length || overlaps(match.index, end)) continue;
      push(match.index, end, name, articles, false, { ...resolved, resolutionStatus: 'defined_abbreviation' });
    }
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
    push(match.index, end, rule.title, [{ article: articleLabel(match[1], match[2]), paragraph: null }], false, { ...resolved, resolutionStatus: 'name_heuristic' });
  }

  const seen = new Set();
  return found.sort((a, b) => a.position - b.position).filter(item => {
    const key = [item.scope, normalizeName(item.name), normalizeName(item.nameCandidate), item.article || '', item.paragraph || ''].join('|');
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
    const key = JSON.stringify([normalizeName(name), normalizeName(item.nameCandidate)]);
    const entry = laws.get(key) || { lawName: name, articles: [], citations: 0, confirmedLawName: item.scope === 'external_law', nameGuessed: true, ...(item.nameCandidate ? { nameCandidate: item.nameCandidate } : {}) };
    entry.citations++;
    // A name written without 낫표 and widened to earlier words is a guess until a law server confirms it.
    if (!item.nameExtended) entry.nameGuessed = false;
    if (item.article && !entry.articles.includes(item.article)) entry.articles.push(item.article);
    laws.set(key, entry);
  }
  return [...laws.values()].map(({ nameGuessed, ...law }) => (nameGuessed ? { ...law, nameGuessed } : law));
}

module.exports = { normalizeName, createResolver, extractReferences, summarizeExternalLaws };

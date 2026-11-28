'use strict';

// verify_rule_citations 핵심 모듈.
// korean-law-mcp v4.9에서 실사용 제보로 확인된 함정을 반영:
//  1) 「규정명」 낫표 표기에서 추출 실패 금지 — 낫표 내부만 캡처
//  2) 가운뎃점 표기 차이(·ㆍ‧•・)로 같은 규정이 불일치로 떨어지지 않게 정규화
//  3) "같은 규정 제N조" 조응은 승계하되, 빈 줄로 문단이 바뀌면 승계하지 않음
//  4) 검색 0건은 ✗(환각)이 아니라 ⚠(규정명 확인 필요) — 검증 미가동 ≠ 통과
//  5) 유사 규정만 검색되면(포함관계 없음) 무관 규정을 근거로 판정하지 않음

const { normalizeMiddots } = require('./aliases.js');
const { scanDatedAddenda, preserveDatedAddendum } = require('./citation-dates.js');
const { DETAIL_START_SOURCE, collectDetailRange } = require('./citation-scope.js');
const { listArticleBlocks, normalizeArticleSelector, supplementarySelector } = require('./parsers.js');
const { searchVariants, selectRuleCandidate } = require('./lookup.js');

const NAME_SUFFIX = '(?:시행세칙|규정|규칙|세칙|학칙|정관|지침|내규|요령|헌장)';
const STANDALONE_NAMES = new Set(['학칙', '정관', '헌장']);
const DEMONSTRATIVES = ['같은', '해당', '당해', '아래', '우리', '이', '그', '본', '동', '위'];
const NAME_CHAR = '[가-힣A-Za-z0-9·ㆍ‧•・]';
const LAW_SUFFIX = /(?:법률|법|시행령|시행규칙)$/;
const ORDINARY_LAW_WORD = /^(?:사법|동법|같은법)$|(?:방법|기법|문법|용법|요법|수법|편법|해법|화법|어법|위법|적법|불법|합법)$/;
const NAME_BOUNDARY = /^(?:같은|해당|당해|우리|이|그|본|동|위|아래|및|또는|다만|또한|관련|관계|경우|때)$|(?:따라|따른|의하여|의한|의거|하여|하며|하고|한다|에는|에서는|으로서|로서|이나|거나)$/;

// Preserve the name before an article independently of classifying its source.
// Spaced generic tails need their preceding words; stop at prose/another citation.
function extendCitationName(source, start, tail) {
  const words = [...source.slice(0, start).matchAll(/\S+/g)];
  const generic = /^(?:법|법률|시행령|시행규칙|규칙|규정|정관|보장법|특별법|특례법|기본법|촉진법|지원법|진흥법|육성법|관리법|보호법|연금법|조치법)$/;
  if (!generic.test(tail) && !/(?:관한|위한|대한)$/.test(words.at(-1)?.[0] || '')) return { name: tail, start };
  let from = start;
  for (let i = words.length - 1, count = 0; i >= 0 && count < 8; i--, count++) {
    const word = words[i][0];
    if (!/^[가-힣A-Za-z0-9·ㆍ‧•・]+$/.test(word) || NAME_BOUNDARY.test(word)
      || /제\d+(?:조|항|호)/.test(word) || !/^[ \t]+$/.test(source.slice(words[i].index + word.length, from))) break;
    // A preceding named source is a boundary, except the base of its decree.
    if (new RegExp(`${NAME_SUFFIX}$`).test(word) || (LAW_SUFFIX.test(word) && !(count === 0 && /^시행/.test(tail)))) break;
    from = words[i].index;
  }
  return { name: source.slice(from, start) + tail, start: from };
}

// Scan the full citation before deciding which part this verifier supports.
// Unbounded digits plus numeric boundaries prevent matching only a number prefix.
const ADDENDUM_PREFIX_SOURCE = String.raw`부\s*칙\s*(?:[(（<〈\[](?:(?!제\s*\d+\s*조)[^)）>〉\]「」\n]){0,100}[)）>〉\]]?\s*|\d{4}[\d\s.\-/년월일]*(?:(?:개정|제정|신설)\s*)?)?(?:(?:의|중)\s*)?`;
// The article parser only reads the supported prefix. A separate lexical pass
// collects detail candidates before any existence/summary decision is made.
const ARTICLE_RE = new RegExp(
  String.raw`(${ADDENDUM_PREFIX_SOURCE})?제\s*(\d+)(?!\d)\s*조(?:\s*의\s*(\d+)(?!\d))?` +
  String.raw`(?:\s*\(([^)\n]{1,40})\))?(?:\s*제\s*(\d+)(?!\d)\s*항)?()` +
  String.raw`|(?<![가-힣A-Za-z0-9])(${DETAIL_START_SOURCE}|제\s*\d+\s*항)`,
  'g'
);

function supportedNumber(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function citationRange(segment, start, text) {
  return { start: segment.offset + start, end: segment.offset + start + text.length, text };
}

function nkey(value) {
  return normalizeMiddots(value).replace(/\s+/g, '').toLowerCase();
}

// "제15조(2025.1.1. 개정)", "제7조(신설 2024.9.1.)", "제3조(삭제)" 같은
// 개정 주석 괄호는 조문 제목이 아니다 — 제목 대조(CONTENT_MISMATCH)에서 제외.
// '개정절차', '시행세칙'처럼 해당 단어로 시작하는 실제 제목은 다음 글자가
// 공백/숫자/괄호류가 아니므로 계속 제목으로 취급된다.
function isAnnotationParen(value) {
  const t = String(value || '').trim();
  if (!t) return false;
  if (/^\d{4}\s*[.\-/년]/.test(t)) return true; // 연도로 시작 (2025.1.1. 개정 등)
  return /^(전부\s*개정|전문\s*개정|일부\s*개정|본조\s*신설|개정|신설|삭제)([\s\d<〈(.].*)?$/.test(t);
}

function overlaps(spans, start, end) {
  return spans.some(s => start < s.end && end > s.start);
}

// 한 문단(segment) 안에서 규정명 멘션 수집: 낫표 → 조응 → 무낫표 순
function scanMentions(segment) {
  const mentions = [];
  const spans = [];
  let m;

  // 1) 「규정명」 — 내부만 캡처하므로 닫는 낫표 잔존 문제 없음
  const bracket = /「\s*([^「」\n]{1,40}?)\s*」/g;
  while ((m = bracket.exec(segment)) !== null) {
    const name = m[1].trim();
    if (!name) continue;
    mentions.push({ start: m.index, end: bracket.lastIndex, name, kind: 'bracket' });
    spans.push({ start: m.index, end: bracket.lastIndex });
  }

  // 2) 조응 표현: "같은 규정", "본 규칙", "같은 학칙 시행세칙" …
  const anaph = new RegExp(
    `(?<![가-힣])(${DEMONSTRATIVES.join('|')})\\s*(규정|규칙|학칙|정관|지침|내규|세칙|법률|법)` +
    `(\\s*(?:의\\s*)?(?:시행세칙|시행령|시행규칙))?(?![가-힣])`, 'g'
  );
  while ((m = anaph.exec(segment)) !== null) {
    if (overlaps(spans, m.index, anaph.lastIndex)) continue;
    mentions.push({
      start: m.index, end: anaph.lastIndex,
      kind: 'anaphora',
      raw: m[0].trim(),
      suffixWord: m[2],
      enforcement: !!m[3],
      lawEnforcement: m[3]?.trim().replace(/^의\s*/, ''),
    });
    spans.push({ start: m.index, end: anaph.lastIndex });
  }

  // 3) New explicit source immediately before an article. Never let an
  // unrecognized national-law name silently inherit the earlier rule owner.
  const named = new RegExp(`(?<![가-힣A-Za-z0-9「·ㆍ‧•・])(${NAME_CHAR}{0,40}(?:시행규칙|시행령|법률|법|${NAME_SUFFIX}))(?=\\s*(?:의\\s*)?제\\s*\\d+\\s*조)`, 'g');
  while ((m = named.exec(segment)) !== null) {
    if (overlaps(spans, m.index, named.lastIndex) || ORDINARY_LAW_WORD.test(m[1])) continue;
    const extended = extendCitationName(segment, m.index, m[1]);
    if (overlaps(spans, extended.start, named.lastIndex)) continue;
    const spaced = extended.start < m.index;
    if (!spaced && !LAW_SUFFIX.test(m[1])) continue; // established rule-name pass below
    mentions.push({ start: extended.start, end: named.lastIndex, name: extended.name,
      kind: 'named-source', exactName: true });
    spans.push({ start: extended.start, end: named.lastIndex });
  }

  // 4) 무낫표: 접미사로 끝나는 명칭 토큰
  const bare = new RegExp(
    `(?<![가-힣A-Za-z0-9「·ㆍ‧•・])(${NAME_CHAR}{0,24}${NAME_SUFFIX})(?![가-힣A-Za-z0-9」])`, 'g'
  );
  while ((m = bare.exec(segment)) !== null) {
    if (overlaps(spans, m.index, bare.lastIndex)) continue;
    const name = m[1];
    const suffixMatch = new RegExp(`${NAME_SUFFIX}$`).exec(name);
    const base = name.slice(0, name.length - suffixMatch[0].length);
    if (!base && !STANDALONE_NAMES.has(name)) continue;          // '규정' 단독 등 배제
    if (DEMONSTRATIVES.includes(base)) continue;                  // '이규정' 등 붙여쓴 지시어 배제
    mentions.push({ start: m.index, end: bare.lastIndex, name, kind: 'bare' });
    spans.push({ start: m.index, end: bare.lastIndex });
  }

  mentions.sort((a, b) => a.start - b.start);
  return mentions;
}

// 조응 해소: 같은 문단 안의 직전 확정 규정명만 승계 (문단 경계에서 리셋)
function resolveMentionNames(mentions) {
  let lastConcrete = null;
  let lastMention = null;
  for (const mention of mentions) {
    if (mention.kind !== 'anaphora') {
      mention.resolved = mention.name;
      lastConcrete = mention.name;
      lastMention = mention;
      continue;
    }
    if (/^(?:법|법률)$/.test(mention.suffixWord)) {
      // '같은 법' after an internal rule is not evidence that both are one source.
      mention.resolved = lastConcrete && LAW_SUFFIX.test(nkey(lastConcrete)) ? lastConcrete : mention.raw;
      mention.sourceUnverified = !lastConcrete || !LAW_SUFFIX.test(nkey(lastConcrete)) || !!lastMention?.sourceUnverified;
      if (!mention.sourceUnverified && mention.lawEnforcement) {
        mention.resolved = `${lastConcrete.replace(/\s*(?:시행령|시행규칙)$/, '')} ${mention.lawEnforcement}`;
      }
      mention.exactName = true;
      lastConcrete = mention.resolved;
      lastMention = mention;
      continue;
    }
    if (!lastConcrete) {
      mention.resolved = null; // 선행 규정명 없음 → 규정명 불명확
      continue;
    }
    mention.resolved = mention.enforcement
      ? `${lastConcrete} 시행세칙`.replace(/시행세칙\s*시행세칙$/, '시행세칙')
      : lastConcrete;
    mention.exactName = lastMention?.exactName;
    mention.sourceUnverified = lastMention?.sourceUnverified;
  }
  return mentions;
}

// 텍스트에서 인용을 추출한다.
// 반환: { citations, floating, mentions }
//  - citations: 규정명이 확정된 인용(조문 유무 포함)
//  - floating : 같은 문단에 선행 규정명이 없는 제N조 인용 (문서 자체 조항일 수 있음)
function extractRuleCitations(text) {
  const source = String(text || '');
  const segments = [];
  let offset = 0;
  for (const separator of source.matchAll(/\n\s*\n/g)) {
    segments.push({ text: source.slice(offset, separator.index), offset });
    offset = separator.index + separator[0].length;
  }
  segments.push({ text: source.slice(offset), offset });

  const citations = [];
  const floating = [];
  const seen = new Set();
  const mentionsAll = [];

  for (const segment of segments) {
    const mentions = resolveMentionNames(scanMentions(segment.text));
    mentionsAll.push(...mentions.map(x => ({ ...x, offset: segment.offset })));
    const bound = new Set();

    const datedAddenda = scanDatedAddenda(segment.text);
    let previousArticleEnd = 0;
    ARTICLE_RE.lastIndex = 0;
    let m;
    let previousArticle = null;
    while ((m = ARTICLE_RE.exec(segment.text)) !== null) {
      if (overlaps(mentions, m.index, ARTICLE_RE.lastIndex)) continue;
      const standaloneParagraph = m[7] && /^제\s*\d+\s*항$/.test(m[7]);
      if (standaloneParagraph && /^(?:목|구)/.test(segment.text.slice(ARTICLE_RE.lastIndex))) continue;
      const standaloneDetail = m[7] && !standaloneParagraph;
      const scope = collectDetailRange(segment.text, standaloneDetail ? m.index : ARTICLE_RE.lastIndex,
        { standalone: !!standaloneDetail });
      if (standaloneDetail && !scope) continue; // a noun, not a detail candidate
      if (scope) {
        const end = scope.end;
        if (!standaloneDetail) m[6] = segment.text.slice(ARTICLE_RE.lastIndex, end);
        m[0] = segment.text.slice(m.index, end);
        ARTICLE_RE.lastIndex = end;
      }
      const connectionUnverified = !!m[2] && preserveDatedAddendum(m, segment.text, datedAddenda, mentions, previousArticleEnd);
      if (m[2]) previousArticleEnd = ARTICLE_RE.lastIndex;
      const owner = [...mentions].reverse().find(x => x.end <= m.index);
      const paragraph = m[7] && /^제\s*(\d+)\s*항$/.exec(m[7]);
      const bridge = previousArticle ? segment.text.slice(previousArticle.end, m.index) : '';
      const inherited = paragraph && previousArticle && owner === previousArticle.owner
        && /^\s*(?:(?:및|또는|,|·)\s*)?(?:같은\s*조\s*)?$/.test(bridge)
        ? previousArticle : null;
      const supplementary = inherited ? inherited.article.supplementary : !!m[1];
      const number = inherited ? inherited.article.number : (m[2] ? Number(m[2]) : null);
      const subNumber = inherited ? inherited.article.subNumber : (m[3] ? Number(m[3]) : null);
      const rawParen = m[4] ? m[4].trim() : null;
      const citedTitle = rawParen && !isAnnotationParen(rawParen) ? rawParen : null;
      const hangToken = paragraph ? paragraph[1] : m[5];
      const hang = hangToken ? Number(hangToken) : null;
      const originalRange = citationRange(segment, m.index, m[0]);
      const unsupportedReasons = [];
      if (paragraph && !inherited) unsupportedReasons.push('UNBOUND_PARAGRAPH');
      else if (m[7] && !paragraph) unsupportedReasons.push('UNSUPPORTED_DETAIL');
      if (m[2] && (!supportedNumber(number, 999) || (m[3] && !supportedNumber(subNumber, 99)))) {
        unsupportedReasons.push('UNSUPPORTED_ARTICLE_NUMBER');
      }
      const selectorText = m[2] ? `${(m[1] || '').replace(/(?:의|중)\s*$/, '')}제${m[2]}조${m[3] ? `의${m[3]}` : ''}` : null;
      const selector = selectorText && !m.dateSyntaxUnverified ? normalizeArticleSelector(selectorText) : null;
      const selectorUnverified = inherited ? inherited.selectorUnverified : connectionUnverified || (!!m[1] && !selector);
      const originalSelector = m[2] ? `${m.sourcePrefix ?? (m[1] || '')}제${m[2]}조${m[3] ? `의${m[3]}` : ''}`.trim() : null;
      const canonical = inherited ? inherited.article.canonical : (selector?.label || originalSelector);
      const article = inherited ? { ...inherited.article } : m[2]
        ? { number, subNumber, supplementary, supplementaryDate: selector?.supplementaryDate || null, canonical }
        : null;
      let parsedText = unsupportedReasons.length || selectorUnverified ? '' : m[0].slice(0, m[6] ? -m[6].length : undefined);
      if (hangToken && !supportedNumber(hang, 50)) {
        unsupportedReasons.push('UNSUPPORTED_PARAGRAPH_NUMBER');
        parsedText = parsedText.replace(/\s*제\s*\d+\s*항$/, '');
      }
      if (m[6]) unsupportedReasons.push(/^\s*의\s*\d/.test(m[6]) ? 'UNSUPPORTED_SELECTOR_SUFFIX' : 'UNSUPPORTED_DETAIL');
      const parsedRange = parsedText ? citationRange(segment, m.index, parsedText) : null;
      const raw = m[0].replace(/\s+/g, ' ').trim();

      if (!owner || !owner.resolved) {
        previousArticle = null;
        floating.push({
          raw, canonical, originalRange, parsedRange, unsupportedReasons,
          reason: owner && !owner.resolved
            ? `조응(${owner.raw}) 선행 규정명 없음`
            : '같은 문단에 규정명 없음',
        });
        continue;
      }
      owner.boundCount = (owner.boundCount || 0) + 1;
      bound.add(owner);
      previousArticle = article && !unsupportedReasons.length
        ? { article, selectorUnverified, owner, end: ARTICLE_RE.lastIndex }
        : null;
      const key = [nkey(owner.resolved), canonical, hang || 0, citedTitle || '', selectorUnverified, unsupportedReasons.length ? raw : ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({
        raw: `${owner.kind === 'anaphora' ? owner.raw : owner.resolved} ${inherited ? `${canonical} ` : ''}${raw}`,
        originalRange, parsedRange, unsupportedReasons,
        ruleName: owner.resolved,
        exactName: !!owner.exactName,
        sourceUnverified: !!owner.sourceUnverified,
        anaphora: owner.kind === 'anaphora',
        article, selectorUnverified, inheritedArticle: !!inherited,
        hang, citedTitle,
      });
    }

    // 조문 없이 낫표로만 인용된 규정 → 규정 실존 검증 대상
    for (const mention of mentions) {
      if (mention.kind !== 'bracket' || mention.boundCount) continue;
      const key = ['RULE_ONLY', nkey(mention.name)].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({
        raw: segment.text.slice(mention.start, mention.end),
        originalRange: citationRange(segment, mention.start, segment.text.slice(mention.start, mention.end)),
        parsedRange: citationRange(segment, mention.start, segment.text.slice(mention.start, mention.end)),
        unsupportedReasons: [],
        ruleName: mention.name,
        anaphora: false,
        article: null,
        hang: null,
        citedTitle: null,
      });
    }
  }

  return { citations, floating, mentions: mentionsAll };
}

// ── 제목 유사도 (LexDiff citation-content-matcher 경량 이식) ──
function normTitle(value) {
  return normalizeMiddots(value).replace(/[\s,.\-()·]/g, '').toLowerCase();
}
function bigrams(value) {
  const set = new Set();
  for (let i = 0; i < value.length - 1; i++) set.add(value.slice(i, i + 2));
  return set;
}
function titleMatches(cited, actual) {
  const a = normTitle(cited), b = normTitle(actual);
  if (!a || !b) return true;                       // 대조 불가 시 불일치 판정하지 않음
  if (a.includes(b) || b.includes(a)) return true; // 공통 substring
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return a === b;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter) >= 0.4; // 문자 bigram Jaccard
}

// 조문 블록에서 최대 항 번호(①~⑳) 탐지 — 0이면 항 표기 없음
function maxHangOf(content) {
  return Math.max(0, ...paragraphNumbersOf(content));
}

function paragraphNumbersOf(content) {
  const numbers = new Set();
  const re = /(?:^|\n)[ \t]*([①-⑳㉑-㉟㊱-㊿])/g;
  for (const match of String(content || '').matchAll(re)) {
    const code = match[1].codePointAt(0);
    numbers.add(code <= 0x2473 ? code - 0x245f : code <= 0x325f ? code - 0x3251 + 21 : code - 0x32b1 + 36);
  }
  return [...numbers].sort((a, b) => a - b);
}

// 규정명 1건 해석: 검색 → 관련성 가드 → 최신본 본문 → 조문 인덱스
async function resolveRule(name, deps, citation = {}) {
  if (citation.sourceUnverified) return { status: 'sourceunverified' };
  const hits = [];
  let successfulSearches = 0;
  let failedSearches = 0;
  let selection = null;
  for (const variant of searchVariants(name)) {
    let result = null;
    try { result = await deps.searchRule(variant); } catch (e) { failedSearches++; continue; }
    if (!result || !Array.isArray(result.hits)) { failedSearches++; continue; }
    successfulSearches++;
    hits.push(...result.hits);
  }
  selection = selectRuleCandidate(hits, name);
  if (failedSearches) return { status: 'searcherror', candidates: selection.candidates };
  if (citation.exactName) {
    const exact = hits.filter(hit => nkey(hit.title) === nkey(name));
    if (!exact.length) return { status: 'externalcandidate' };
    selection = selectRuleCandidate(exact, name);
  }
  if (!hits.length) return { status: successfulSearches ? 'miss' : 'searcherror' };
  if (!selection || selection.status !== 'unique') return { status: 'weak', candidates: selection?.candidates || [] };

  const best = selection.hit;
  let latest;
  try { latest = await deps.resolveLatest(best.lawId); } catch (e) { return { status: 'latestunavailable', hit: best }; }
  const historyId = typeof latest === 'object' ? latest?.historyId : latest;
  if (!Number.isSafeInteger(historyId) || historyId <= 0) return { status: 'latestunavailable', hit: best };
  // Never attach an old search-result date to a newly resolved history ID.
  const revisedAt = typeof latest === 'object' ? (latest.revisedAt || '') : (historyId === best.historyId ? best.revisedAt || '' : '');
  const hit = { ...best, historyId, revisedAt };
  let markdown;
  try { markdown = await deps.getRuleMarkdown(best.lawId, historyId); } catch (e) { return { status: 'nocontent', hit }; }
  if (!markdown) return { status: 'nocontent', hit };

  const blocks = listArticleBlocks(markdown);
  const main = blocks.filter(b => !b.supplementary);
  const range = main.length
    ? { min: Math.min(...main.map(b => b.number)), max: Math.max(...main.map(b => b.number)) }
    : null;
  return { status: 'ok', hit, blocks, range };
}

function headingTitleOf(block) {
  const match = /제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[(（]([^)）\n]*)[)）]/.exec(block.heading || '');
  return match ? match[1].trim() : '';
}

// 인용 1건 판정
function judgeCitation(citation, rec) {
  if (rec?.status === 'sourceunverified') {
    return { status: 'CITATION_SOURCE_UNVERIFIED', symbol: '⚠', note: '법 조응의 선행 법령을 특정할 수 없음 — 앞 교내 규정의 조문으로 판정하지 않음. 법령명 확인 필요' };
  }
  if (rec?.status === 'externalcandidate') {
    return { status: 'EXTERNAL_LAW', symbol: '⚠', note: '국가 법령으로 보임 — 교내 규정의 정확한 명칭과 일치하지 않아 조문은 미검증. 국가 법령 여부·정식 명칭은 한국법령 MCP로 확인하세요' };
  }
  if (citation.unsupportedReasons?.length) {
    const note = citation.unsupportedReasons.includes('UNBOUND_PARAGRAPH')
      ? '항 인용의 앞 조문을 특정할 수 없음 — 조문 번호와 함께 적어 확인 필요'
      : '별표·서식·호·목·중첩 접미부 또는 지원 범위 밖 번호는 미검증 — 해당 원문 확인 필요';
    return { status: 'UNSUPPORTED_CITATION', symbol: '⚠', note };
  }
  if (citation.selectorUnverified) {
    return { status: 'ARTICLE_SELECTOR_UNVERIFIED', symbol: '⚠', note: '부칙 날짜·조문 선택자를 해석할 수 없음 — 원문 위치 확인 필요' };
  }
  if (!rec || rec.status === 'skipped') {
    return { status: 'RULE_SKIPPED', symbol: '⚠', note: '규정 수 상한 초과로 이번 호출에서는 검증 생략' };
  }
  if (rec.status === 'miss') {
    // 「사립학교법」 제29조 is a national-law citation, not a misspelled rule name.
    if (/(?:법|법률|시행령|시행규칙)$/.test(String(citation.ruleName || '').replace(/\s+/g, ''))) {
      return { status: 'EXTERNAL_LAW', symbol: '⚠', note: '국가 법령으로 보임 — 교내 규정집 검증 대상 아님. 한국법령 MCP로 조문을 확인하세요' };
    }
    return { status: 'RULE_SEARCH_MISS', symbol: '⚠', note: '규정 검색 0건 — 규정명 표기 확인 필요 (미존재 단정 아님)' };
  }
  if (rec.status === 'searcherror') {
    return { status: 'RULE_SEARCH_UNAVAILABLE', symbol: '⚠', note: '일부 또는 전체 규정 검색 요청 실패 — 후보 수집을 완료할 수 없어 규정 동일성은 미검증' };
  }
  if (rec.status === 'latestunavailable') {
    return { status: 'RULE_LATEST_UNAVAILABLE', symbol: '⚠', note: '최신 연혁 확인 실패 — 과거 검색결과로 인용을 판정하지 않음' };
  }
  if (rec.status === 'weak') {
    const names = rec.candidates.map(c => c.title).filter(Boolean).join(', ');
    return { status: 'RULE_AMBIGUOUS', symbol: '⚠', note: `규정 하나를 확정할 수 없음 — 공식 규정명·캠퍼스 확인 필요. 후보: ${names || '없음'}` };
  }
  if (rec.status === 'nocontent') {
    return { status: 'RULE_CONTENT_UNAVAILABLE', symbol: '⚠', note: '규정은 검색되나 본문 조회 실패 — 재시도 필요' };
  }
  if (!citation.article) {
    return { status: 'RULE_EXISTS', symbol: '✓', note: `규정 실존 — ${rec.hit.title} (LAW_ID ${rec.hit.lawId})` };
  }

  const { number, subNumber, supplementary, supplementaryDate, canonical } = citation.article;
  if (!rec.blocks.length) {
    return { status: 'RULE_CONTENT_UNAVAILABLE', symbol: '⚠', note: '조문 구조를 확인할 수 없어 미존재 판정 불가 — 공식 원문 확인 필요' };
  }
  const datedBlocks = supplementaryDate
    ? rec.blocks.filter(b => normalizeArticleSelector(supplementarySelector(b))?.supplementaryDate === supplementaryDate)
    : null;
  let matches = rec.blocks.filter(b => b.number === number && b.subNumber === subNumber);
  matches = supplementary
    ? matches.filter(b => b.supplementary)
    : (matches.some(b => !b.supplementary) ? matches.filter(b => !b.supplementary) : []);
  if (supplementaryDate) {
    matches = matches.filter(b => normalizeArticleSelector(supplementarySelector(b))?.supplementaryDate === supplementaryDate);
  }
  const block = matches[0];

  if (matches.length > 1) {
    return { status: 'ARTICLE_AMBIGUOUS', symbol: '⚠', note: `${canonical}가 ${matches.length}개 존재 — 부칙의 개정일·원문 위치를 특정한 뒤 확인 필요` };
  }

  if (!block) {
    if (supplementaryDate && !datedBlocks.length && rec.blocks.some(b => b.supplementary && !supplementarySelector(b))) {
      return { status: 'ARTICLE_SELECTOR_UNVERIFIED', symbol: '⚠', note: `${canonical} — 원문에 개정일을 확인할 수 없는 부칙이 있어 날짜·조문 실존은 미검증. 부칙 머리와 원문 위치 확인 필요` };
    }
    const rangeNote = supplementaryDate
      ? (datedBlocks.length
        ? `개정일 ${supplementaryDate}의 부칙은 있으나 해당 조문 없음`
        : `개정일 ${supplementaryDate}의 부칙 조문 블록을 확인하지 못함 — 날짜·원문 확인 필요`)
      : supplementary ? '부칙에 해당 조문 없음'
      : (rec.range ? `본칙 존재 범위: 제${rec.range.min}조~제${rec.range.max}조` : '조문 헤더를 찾을 수 없음');
    return { status: 'NOT_FOUND', symbol: '✗', note: `${canonical} 없음 (${rangeNote})` };
  }

  const actualTitle = headingTitleOf(block);
  if (citation.citedTitle && !actualTitle) {
    return { status: 'TITLE_UNVERIFIED', symbol: '⚠', note: `${canonical} 실존하나 원문 제목을 추출할 수 없어 인용 제목은 미검증` };
  }
  if (citation.citedTitle && actualTitle && !titleMatches(citation.citedTitle, actualTitle)) {
    return {
      status: 'CONTENT_MISMATCH', symbol: '⚠', actualTitle,
      note: `${canonical} 실존하나 제목 불일치 — 인용 (${citation.citedTitle}) vs 실제 (${actualTitle})`,
    };
  }
  if (citation.citedTitle && normTitle(citation.citedTitle) !== normTitle(actualTitle)) {
    return {
      status: 'TITLE_SIMILAR', symbol: '⚠', actualTitle,
      note: `${canonical} 실존하나 인용 제목은 유사 표기 — 인용 (${citation.citedTitle}) vs 실제 (${actualTitle}); 의미 일치 확인 필요`,
    };
  }
  if (citation.hang) {
    const paragraphNumbers = paragraphNumbersOf(block.content);
    const maxHang = Math.max(0, ...paragraphNumbers);
    if (maxHang === 0) {
      return {
        status: 'HANG_UNVERIFIED', symbol: '⚠', actualTitle,
        note: `${canonical}${actualTitle ? `(${actualTitle})` : ''} 실존 — 항 표기 없어 제${citation.hang}항은 미검증`,
      };
    }
    if (!paragraphNumbers.includes(citation.hang)) {
      return {
        status: 'HANG_NOT_FOUND', symbol: '✗', actualTitle,
        note: `${canonical} 실존, 제${citation.hang}항 표기 없음 (최대 제${maxHang}항; 확인된 항: ${paragraphNumbers.join(', ')})`,
      };
    }
    return {
      status: 'EXISTS', symbol: '✓', actualTitle,
      note: `${canonical}${actualTitle ? `(${actualTitle})` : ''} 제${citation.hang}항 실존`,
    };
  }
  return { status: 'EXISTS', symbol: '✓', actualTitle, note: `${canonical}${actualTitle ? `(${actualTitle})` : ''} 실존` };
}

// 메인: 텍스트 전체 검증
// deps: { searchRule(query)→{hits}, getRuleMarkdown(lawId,historyId)→markdown, resolveLatest(lawId)→historyId }
async function verifyRuleCitations(text, deps, options = {}) {
  const maxCitations = options.maxCitations || 40;
  const maxRules = options.maxRules || 8;
  const extracted = extractRuleCitations(text);
  const citations = extracted.citations.slice(0, maxCitations);
  const truncatedCitations = extracted.citations.length - citations.length;

  const uniqueKeys = [...new Set(citations.map(c => nkey(c.ruleName)))];
  const activeKeys = uniqueKeys.slice(0, maxRules);
  const skippedRules = uniqueKeys.length - activeKeys.length;

  const ruleCache = new Map();
  for (const key of activeKeys) {
    const displayName = citations.find(c => nkey(c.ruleName) === key).ruleName;
    const sameName = citations.filter(c => nkey(c.ruleName) === key);
    ruleCache.set(key, await resolveRule(displayName, deps, {
      exactName: sameName.some(c => c.exactName),
      sourceUnverified: sameName.every(c => c.sourceUnverified),
    }));
  }

  const results = citations.map(citation => {
    const key = nkey(citation.ruleName);
    const rec = ruleCache.has(key) ? ruleCache.get(key) : { status: 'skipped' };
    const verdict = judgeCitation(citation, rec);
    return {
      raw: citation.raw,
      originalRange: citation.originalRange,
      parsedRange: citation.parsedRange,
      unsupportedReasons: citation.unsupportedReasons,
      ruleName: citation.ruleName,
      article: citation.article ? citation.article.canonical : null,
      hang: citation.hang,
      inheritedArticle: !!citation.inheritedArticle,
      citedTitle: citation.citedTitle,
      actualTitle: verdict.actualTitle || null,
      status: verdict.status,
      symbol: verdict.symbol,
      note: verdict.note,
      rule: rec.status === 'ok' || rec.status === 'nocontent'
        ? { lawId: rec.hit.lawId, historyId: rec.hit.historyId, title: rec.hit.title, revisedAt: rec.hit.revisedAt || '' }
        : null,
    };
  });

  // exists는 '조문 실존' 기준 집계 — 제목·항의 확인이 필요한 인용도
  // exists와 needsReview 양쪽에 계수되므로 세 항목 합이 total을 넘을 수 있다.
  // (HANG_NOT_FOUND는 인용된 항 자체가 없으므로 notFound에만 계수)
  const ARTICLE_EXISTS = new Set(['EXISTS', 'RULE_EXISTS', 'CONTENT_MISMATCH', 'TITLE_SIMILAR', 'TITLE_UNVERIFIED', 'HANG_UNVERIFIED']);
  const summary = {
    verified: results.filter(r => ['EXISTS', 'RULE_EXISTS'].includes(r.status) && !r.unsupportedReasons.length).length,
    exists: results.filter(r => ARTICLE_EXISTS.has(r.status)).length,
    notFound: results.filter(r => r.symbol === '✗').length,
    needsReview: results.filter(r => r.symbol === '⚠').length,
    total: results.length,
    floating: extracted.floating.length,
  };

  const rules = [...ruleCache.entries()].map(([key, rec]) => ({
    key,
    status: rec.status,
    ...(rec.hit ? { lawId: rec.hit.lawId, historyId: rec.hit.historyId, title: rec.hit.title, revisedAt: rec.hit.revisedAt || '' } : {}),
    ...(rec.candidates ? { candidates: rec.candidates.map(c => ({ lawId: c.lawId, title: c.title })) } : {}),
  }));

  // ── 사람용 보고서 ──
  const mismatchCount = results.filter(r => r.status === 'CONTENT_MISMATCH').length;
  let out = `# 규정 인용 검증 — 총 ${summary.total}건: 조문 실존 ${summary.exists}` +
    `${mismatchCount ? ` (제목 불일치 ${mismatchCount} 포함)` : ''}` +
    ` · ✗ 미존재 ${summary.notFound} · ⚠ 확인필요 ${summary.needsReview}\n\n`;
  for (const r of results) {
    out += `${r.symbol} ${r.raw} — ${r.note}\n`;
  }
  if (extracted.floating.length) {
    const shown = extracted.floating.slice(0, 5);
    out += `\n규정명 미상 조문 인용 ${extracted.floating.length}건 (문서 자체 조항이거나 문단 밖 규정 지칭일 수 있음):\n`;
    shown.forEach(f => { out += `  ⚠ ${f.raw} — ${f.reason}\n`; });
    if (extracted.floating.length > shown.length) out += `  …외 ${extracted.floating.length - shown.length}건\n`;
  }
  if (truncatedCitations > 0) out += `\n(인용 상한 ${maxCitations}건 초과 — ${truncatedCitations}건 미검증)\n`;
  if (skippedRules > 0) out += `(규정 상한 ${maxRules}건 초과 — ${skippedRules}개 규정 검증 생략)\n`;
  out += `\n> 검증 기준: 각 규정의 최신 개정본. ⚠(확인필요)는 통과가 아닙니다 — 검증 미가동을 통과로 읽지 마세요.`;

  return {
    text: out,
    summary,
    citations: results,
    floating: extracted.floating,
    rules,
    truncated: { citations: truncatedCitations, rules: skippedRules },
  };
}

module.exports = {
  isAnnotationParen,
  extractRuleCitations,
  verifyRuleCitations,
  titleMatches,
  maxHangOf,
  paragraphNumbersOf,
  judgeCitation,
  resolveRule,
};

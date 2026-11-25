'use strict';

const { expandAliases, middotVariants, normalizeMiddots } = require('./aliases.js');
const { appendixHeading, extractAppendices, isBodyBoundary } = require('./appendices.js');

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function normalizeText(value) {
  return normalizeMiddots(value).replace(/\s+/g, '').toLowerCase();
}

// Preserve an explicitly quoted official title, including its spaces. For
// unquoted questions, only recognize one named rule; multiple names remain a
// search question so the caller cannot silently choose the first regulation.
function ruleNameFromQuery(value) {
  const query = String(value || '').trim();
  const suffix = '(?:시행세칙|규정|규칙|세칙|학칙|정관|지침|내규|요령|헌장)';
  const titlePattern = new RegExp(`^[가-힣A-Za-z0-9·ㆍ‧•・()（） \\t]{0,120}${suffix}$`);
  const named = name => ['학칙', '정관', '헌장'].includes(name) || !new RegExp(`^${suffix}$`).test(name);
  const quotes = [...query.matchAll(/「([^「」\n]+)」|『([^『』\n]+)』|“([^“”\n]+)”|‘([^‘’\n]+)’|"([^"\n]+)"|'([^'\n]+)'/g)];
  const quoted = quotes
    .map(match => match.slice(1).find(Boolean).trim())
    .filter(name => titlePattern.test(name) && named(name));
  let unquoted = query;
  for (const match of quotes.slice().reverse()) {
    unquoted = unquoted.slice(0, match.index) + ' '.repeat(match[0].length) + unquoted.slice(match.index + match[0].length);
  }
  const bare = new RegExp(`(?<![가-힣A-Za-z0-9·ㆍ‧•・])([가-힣A-Za-z0-9·ㆍ‧•・]{0,80}${suffix}(?:[ \\t]+시행세칙)?)`, 'g');
  const names = [...quoted, ...[...unquoted.matchAll(bare)].map(match => match[1]).filter(named)];
  return new Set(names.map(normalizeText)).size === 1 ? names[0] : '';
}

// The longest current rule title written out in a question, spaces ignored.
// Returns null when no title (or two unrelated titles) appears, so the caller
// never picks one rule for a question that names several.
function titleInQuery(query, catalog) {
  const text = normalizeText(query);
  const hits = [];
  for (const rule of catalog || []) {
    const title = normalizeText(rule.title);
    if (title.length >= 4 && text.includes(title)) hits.push({ rule, title });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.title.length - a.title.length);
  const longest = hits[0].title;
  if (hits.some(hit => !longest.includes(hit.title))) return null;
  const same = hits.filter(hit => hit.title === longest).map(hit => hit.rule);
  return { title: same[0].title, rules: same };
}

// The question without the rule's own name, for ranking articles inside that rule.
function withoutRuleName(query, name) {
  const source = String(query || '');
  const key = normalizeMiddots(String(name || '')).replace(/\s+/g, '');
  if (!key) return source.trim();
  const pattern = [...key].map(char => char === 'ㆍ' ? '[·ㆍ‧•・]' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t]*');
  return source.replace(new RegExp(`[「『“‘"']?${pattern}[」』”’"']?(?:의|에서|에|은|는)?`, 'g'), ' ').replace(/\s+/g, ' ').trim();
}

function searchVariants(value) {
  const input = String(value || '').trim().replace(/\s+/g, ' ');
  if (!input) return [];
  const variants = [];
  const push = v => { const t = String(v || '').trim(); if (t && !variants.includes(t)) variants.push(t); };
  // 원 입력 → 별칭 확장 순으로, 각 후보에 가운뎃점 표기 변형·압축·'규정' 접미 축약을 적용
  for (const candidate of [input, ...expandAliases(input)]) {
    for (const dotted of middotVariants(candidate)) {
      push(dotted);
      const compact = dotted.replace(/\s+/g, '');
      push(compact);
      if (compact.endsWith('규정') && compact.length > 2) push(compact.slice(0, -2));
    }
  }
  return variants;
}

function rankRuleHits(hits, keyword) {
  const needle = normalizeText(keyword);
  const aliases = new Set(expandAliases(keyword).map(normalizeText));
  return (Array.isArray(hits) ? hits : [])
    .map((hit, index) => {
      const title = normalizeText(hit.title);
      let score = 0;
      if (needle && title === needle) score += 100;
      else if (title && aliases.has(title)) score += 95;
      else if (needle && title.includes(needle)) score += 80;
      else if (title && needle.includes(title)) score += 60;
      if (title.endsWith('규정')) score += 5;
      if (hit.revisedAt) score += 1;
      return { hit, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(x => x.hit);
}

// A title search is not an identity lookup. Distinct LAW_IDs can share a title
// (including campus-specific rules), so never resolve such results by row order.
function selectRuleCandidate(hits, keyword) {
  const ranked = rankRuleHits(hits, keyword).filter(hit => normalizeText(hit.title));
  const byId = new Map();
  for (const hit of ranked) if (!byId.has(String(hit.lawId))) byId.set(String(hit.lawId), hit);
  const unique = [...byId.values()];
  const names = new Set([keyword, ...expandAliases(keyword)].map(normalizeText).filter(Boolean));
  const exact = unique.filter(hit => names.has(normalizeText(hit.title)));
  if (exact.length === 1) return { status: 'unique', hit: exact[0], candidates: exact, matchType: 'exact' };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact, matchType: 'exact' };
  const related = unique.filter(hit => [...names].some(name => {
    const title = normalizeText(hit.title);
    return title.includes(name) || name.includes(title);
  }));
  return {
    status: related.length ? 'ambiguous' : 'unrelated',
    candidates: related.length ? related : unique.slice(0, 5),
    matchType: related.length ? 'partial' : 'none',
  };
}

function normalizeAppendixLabels(value) {
  return String(value || '').replace(/(\d+)[ \t]*호[ \t]*의[ \t]*(\d+)/g, '$1의$2호')
    .replace(/별[ \t]*표(?:[ \t]*(?:제[ \t]*)?(\d+(?:[ \t]*(?:의|-)[ \t]*\d+)?)(?:[ \t]*호)?)?/g,
    (_, number) => '별표' + (number || '').replace(/\s/g, ''));
}

function appendixSelectors(value) {
  return [...normalizeAppendixLabels(value).matchAll(/별표(?:\d+(?:(?:의|-)\d+)?)?/g)].map(match => match[0]);
}

function termTokens(rawTerms) {
  const source = normalizeAppendixLabels(Array.isArray(rawTerms) ? rawTerms.join(' ') : rawTerms);
  const base = source
    .split(/[\s,;|/·]+/)
    .map(x => x.trim().toLowerCase())
    .filter(x => x.length >= 2);
  // Natural-language particles ("별표를", "별표의") must not hide the
  // appendix selector. Numbered selectors remain distinct: 1 != 10 != 1의2.
  const expanded = [
    ...appendixSelectors(source),
    ...[...source.matchAll(/제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?/g)].map(match => match[0].replace(/[ \t]/g, '')),
  ];
  for (const token of base) {
    expanded.push(token);
    if (token.length >= 4 && token.endsWith('운임')) expanded.push(token.slice(0, -2));
    if (token.length >= 3 && token.endsWith('비')) expanded.push(token.slice(0, -1));
  }
  return [...new Set(expanded.filter(x => x.length >= 2))];
}

function countOccurrences(text, token) {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(token, pos)) !== -1) {
    count++;
    pos += token.length;
  }
  return count;
}

function scoreBlock(block, tokens, context = '') {
  const isTable = /^\|.+\|/m.test(block);
  const appendix = appendixHeading(block.split('\n', 1)[0]);
  const requested = tokens.filter(token => /^별표\d+(?:(?:의|-)\d+)?$/.test(token));
  const appendixKey = appendix && normalizeAppendixLabels(appendix.key);
  if (appendixKey?.startsWith('별표') && requested.length && !requested.includes(appendixKey)) return null;
  const text = normalizeAppendixLabels(`${isTable && !appendix ? context : ''}\n${block}`).toLowerCase();
  const selectors = appendixSelectors(text);
  const matched = tokens.filter(token => /^별표\d+(?:(?:의|-)\d+)?$/.test(token)
    ? selectors.includes(token) : text.includes(token));
  if (!matched.length) return null;
  let score = matched.length * 12;
  score += matched.reduce((sum, token) => sum + Math.min(countOccurrences(text, token), 4), 0);
  if (isTable) score += 18;
  if (/[0-9][0-9,]*(?:원|%|등급)/.test(block)) score += 8;
  if (/별\s*표|별표/.test(block)) score += 6;
  if (/^제\s*\d+\s*조/m.test(block)) score += 3;
  // Words in the article title mark what the article is about.
  const title = /^(?:#{1,6}[ \t]*)?(?:\*\*)?제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?[ \t]*[(（]([^)）\n]{1,40})[)）]/.exec(block);
  if (title) score += matched.filter(token => title[1].toLowerCase().includes(token)).length * 10;
  if (appendixKey && (tokens.includes('별표') || requested.includes(appendixKey))) score += 100;
  // An exact article heading outranks mentions in other articles, including
  // revision notes such as "제62조에서 제60조로 이동".
  const heading = /^(?:#{1,6}[ \t]*)?(?:\*\*)?(제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?)(?=[ \t(（.:*]|$)/.exec(block);
  if (heading && tokens.includes(heading[1].replace(/[ \t]/g, ''))) score += 100;
  const wantsDomestic = tokens.includes('국내');
  const wantsForeign = tokens.includes('국외');
  // Notes can refer to a different travel scope. The appendix's own title
  // (before its table) determines scope, and an exact-label boost must not
  // cancel a scope exclusion.
  if (appendix) {
    const title = block.split(/^\|/m, 1)[0];
    if (wantsDomestic && !wantsForeign && /국외/.test(title) && !/국내/.test(title)) return null;
    if (wantsForeign && !wantsDomestic && /국내/.test(title) && !/국외/.test(title)) return null;
  }
  if (wantsDomestic && /국외/.test(text) && !/국내/.test(text)) score -= 100;
  if (wantsForeign && /국내/.test(text) && !/국외/.test(text)) score -= 100;
  if (score <= 0) return null;
  return { score, matched };
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.lastIndexOf('\n', maxChars);
  const end = cut > maxChars * 0.7 ? cut : maxChars;
  return {
    text: `${text.slice(0, end).trimEnd()}\n\n...(결과 길이 제한으로 일부 생략)`,
    truncated: true,
  };
}

function extractRelevantBlocks(markdown, rawTerms, options = {}) {
  const maxBlocks = clampNumber(options.maxBlocks, 6, 1, 12);
  const maxChars = clampNumber(options.maxChars, 12000, 1000, 30000);
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const blocks = [];
  const appendBlocks = text => blocks.push(...text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean));
  let cursor = 0;
  // A table's following notes can span many HWP paragraphs. Rank and return
  // the entire appendix, stopping at the next appendix or body boundary.
  const appendices = extractAppendices(source).filter(item => item.key.startsWith('별표'));
  for (const appendix of appendices) {
    appendBlocks(lines.slice(cursor, appendix.start).join('\n'));
    blocks.push(appendix.text);
    cursor = appendix.start + appendix.text.split('\n').length;
  }
  appendBlocks(lines.slice(cursor).join('\n'));
  const tokens = termTokens(rawTerms);
  const appendixKeys = appendices.map(item => normalizeAppendixLabels(item.key));
  const missingAppendices = [...new Set(tokens.filter(token => /^별표(?:\d+(?:(?:의|-)\d+)?)?$/.test(token)))]
    .filter(selector => selector === '별표' ? !appendices.length : !appendixKeys.includes(selector));

  if (!blocks.length) {
    return { text: '', matchedTerms: [], blockCount: 0, truncated: false, omittedBlockCount: 0, blocksTruncated: false, charactersTruncated: false, missingAppendices };
  }

  if (!tokens.length) {
    const selected = blocks.slice(0, Math.min(maxBlocks, blocks.length)).join('\n\n');
    const clipped = truncateText(selected, maxChars);
    const omittedBlockCount = Math.max(0, blocks.length - maxBlocks);
    return {
      ...clipped,
      text: clipped.text + (omittedBlockCount ? `\n\n...(블록 수 제한으로 원문 블록 ${omittedBlockCount}개 생략)` : ''),
      truncated: clipped.truncated || omittedBlockCount > 0,
      charactersTruncated: clipped.truncated,
      blocksTruncated: omittedBlockCount > 0,
      omittedBlockCount,
      matchedTerms: [],
      blockCount: Math.min(maxBlocks, blocks.length),
      missingAppendices,
    };
  }

  const scored = blocks
    .map((block, index) => {
      const context = index > 0 ? blocks[index - 1] : '';
      const result = scoreBlock(block, tokens, context);
      return result ? { block, index, ...result } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!scored.length) {
    return { text: '', matchedTerms: [], blockCount: 0, truncated: false, omittedBlockCount: 0, blocksTruncated: false, charactersTruncated: false, missingAppendices };
  }

  // HWP paragraphs are separate Markdown blocks. A matching heading or one
  // matching paragraph must retain the rest of that article, including its
  // exceptions. Context does not consume another ranked match; maxChars still
  // bounds the response and reports any clipping.
  let articleContext = null;
  const articleContexts = blocks.map((block, index) => {
    const firstLine = block.split('\n', 1)[0];
    const boundary = isBodyBoundary(firstLine);
    if (appendixHeading(firstLine) || (boundary && boundary !== 'article')) articleContext = null;
    else if (boundary === 'article') articleContext = [];
    if (articleContext) articleContext.push(index);
    return articleContext;
  });
  const selectedIndexes = new Set(scored.slice(0, maxBlocks).map(x => x.index));
  for (const item of scored.slice(0, maxBlocks)) {
    for (const index of articleContexts[item.index] || []) selectedIndexes.add(index);
    if (/^\|.+\|/m.test(item.block) && !appendixHeading(item.block.split('\n', 1)[0])) {
      if (item.index > 0) selectedIndexes.add(item.index - 1);
      if (item.index + 1 < blocks.length) {
        const next = blocks[item.index + 1];
        const firstLine = next.split('\n', 1)[0];
        if (!appendixHeading(firstLine) && !isBodyBoundary(firstLine)) {
          selectedIndexes.add(item.index + 1);
        }
      }
    }
  }

  // Document order by default. A question answered from a long rule reads
  // best-matching article first, so the length limit cuts the weaker ones.
  const rankOf = new Map();
  if (options.order === 'relevance') {
    scored.slice(0, maxBlocks).forEach((item, rank) => {
      for (const index of [item.index, ...(articleContexts[item.index] || [])]) if (!rankOf.has(index)) rankOf.set(index, rank);
    });
  }
  const rank = index => rankOf.has(index) ? rankOf.get(index) : maxBlocks;
  const orderedIndexes = [...selectedIndexes].sort((a, b) => rank(a) - rank(b) || a - b);
  const selected = orderedIndexes.map(index => blocks[index]).join('\n\n');
  const matchedTerms = [...new Set(
    scored.slice(0, maxBlocks).flatMap(x => x.matched)
  )];
  const clipped = truncateText(selected, maxChars);
  // Table context can recover a lower-ranked matching block. Only count
  // genuinely omitted matches, not every item below the score cutoff.
  const omittedBlockCount = scored.filter(item => !selectedIndexes.has(item.index)).length;
  return {
    ...clipped,
    text: clipped.text + (omittedBlockCount ? `\n\n...(블록 수 제한으로 관련 블록 ${omittedBlockCount}개 생략)` : ''),
    truncated: clipped.truncated || omittedBlockCount > 0,
    charactersTruncated: clipped.truncated,
    blocksTruncated: omittedBlockCount > 0,
    omittedBlockCount,
    matchedTerms,
    blockCount: orderedIndexes.length,
    missingAppendices,
  };
}

// Content words of a natural-language question for keyword search. The
// upstream full-text search ANDs every word, so one absent word ("상한",
// "자격은?") makes the whole question return nothing.
const QUESTION_STOPWORDS = new Set([
  '알려줘', '알려주세요', '알려', '주세요', '무엇', '뭐야', '뭔가요', '어떻게', '어떤', '있나요', '있는지',
  '되나요', '하나요', '인가요', '경우', '관련', '대한', '대해', '대해서', '관한', '내용', '규정', '기준은', '방법',
  '동국대', '동국대학교', '우리', '학교', '얼마', '얼마야', '얼마인가요', '가능', '가능한가요', '여부',
  // Question words and verb remnants carry no rule vocabulary; left in, their
  // rarity outweighs the nouns ("받아" once outranked "일비").
  '누가', '누구', '누구에게', '언제', '어디', '어디서', '무슨', '몇', '얼마나', '필요', '필요한', '있어', '있는', '없는',
  '있나', '없나', '있을', '없을', '받아', '받나', '받는', '받을', '하려면', '하면', '해야', '하는', '하나', '되는', '됩니까',
  '싶어', '싶은', '궁금', '궁금해', '어느', '무엇인가요', '뭐가', '뭘', '이런', '그런', '어떠한',
]);
const PARTICLE_SUFFIX = /(?:에서는|에서|으로|에게|까지|부터|이란|란|은|는|이|가|을|를|의|에|로|과|와|도|만)$/;
// "겸직하려면" → 겸직, "전결해" → 전결: the noun before a 하다/되다/받다 ending.
const VERB_ENDING = /(?:하려면|하려고|하려는|하고자|하면서|하면|하여야|해야|하여|해서|해도|하는지|하는|하기|하나요|합니까|합니다|했는데|한다면|할까요|할지|하고|해요|해|되나요|되는지|되려면|되면|되는|받으려면|받아야|받으면|받는|받을|받아)$/;
// Nouns that end in 해; not "noun + 해".
const NOUN_ENDING_HAE = /(?:피해|손해|재해|이해|방해|침해|상해|견해|화해|양해|오해|저해|유해|무해)$/;
// Two-syllable nouns before the subject particle 가 (교수가 → 교수). Other
// three-syllable words ending in 가 (전문가, 낙찰가) are nouns themselves.
const SUBJECTS_BEFORE_GA = new Set(['교수', '강사', '조교', '부서', '학교', '이사', '감사', '회계', '근로자']);

function contentToken(raw) {
  let token = String(raw || '').trim();
  if (!token || /^제?\d+조?$/.test(token)) return null;
  const verbStem = NOUN_ENDING_HAE.test(token) ? token : token.replace(VERB_ENDING, '');
  if (verbStem !== token) {
    // A bare verb ("받아", "해야") leaves nothing to search for.
    if (verbStem.length < 2) return null;
    token = verbStem;
  } else {
    const stripped = token.replace(PARTICLE_SUFFIX, '');
    // "년까지", "곳에서": a counter or pronoun before a long particle is not a search word.
    if (stripped.length < 2 && token.length - stripped.length >= 2) return null;
    if (stripped.length >= 2 && (!(token.length === 3 && token.endsWith('가')) || SUBJECTS_BEFORE_GA.has(stripped))) token = stripped;
  }
  if (token.length < 2 || QUESTION_STOPWORDS.has(token)) return null;
  return token;
}

function queryContentTokens(value, maxTokens = 4) {
  const tokens = [];
  for (const raw of String(value || '').split(/[\s,;|/·?!.()（）"'「」]+/)) {
    const token = contentToken(raw);
    if (token && !tokens.includes(token)) tokens.push(token);
  }
  // Prefer the most specific words while preserving the question order.
  const kept = new Set([...tokens].sort((a, b) => b.length - a.length).slice(0, maxTokens));
  return tokens.filter(token => kept.has(token));
}

// Everyday words for what the rules call something else. Each entry lists the
// rule vocabulary to try alongside the question word; only forms that occur in
// the indexed rules are used, so an entry cannot invent a match.
const RULE_VOCABULARY = new Map(Object.entries({
  해외출장: ['국외출장', '국외여비', '국외 출장', '국외'], 해외여비: ['국외여비', '국외'], 해외: ['국외'],
  국내출장: ['국내출장', '국내여비', '국내 출장', '출장'], 출장비: ['여비', '출장'], 출장: ['여비'],
  퇴직금: ['퇴직급여', '퇴직급여금'], 퇴직급여: ['퇴직금'],
  경조사비: ['경조금', '경조사'], 경조비: ['경조금', '경조사'], 조의금: ['경조금', '경조사'], 축의금: ['경조금', '경조사'],
  강사료: ['강의료'], 특강료: ['강의료', '특강'], 강의료: ['강사료'],
  환불: ['반환'], 반환: ['환불'],
  중복수혜: ['이중수혜'], 이중수혜: ['중복수혜'],
  안식년: ['연구년'], 사외이사: ['겸직'], 겸임: ['겸직'],
  월급: ['보수', '급여'], 봉급: ['보수', '급여'], 임금: ['보수', '급여'], 연봉: ['보수'],
  야근: ['시간외근무', '초과근무'], 초과근무: ['시간외근무'], 시간외수당: ['시간외근무'],
  연차: ['연차휴가', '휴가'], 출산휴가: ['출산전후휴가'],
  교수: ['교원'], 학부생: ['학생'], 대학원생: ['대학원'],
  퍼센트: ['100분의', '비율'], 한도: ['상한', '범위'], 상한: ['한도'], 계산: ['산정'],
  카드: ['법인카드'], 클린카드: ['법인카드'],
}));

// Search concepts of a question: each content word with the rule vocabulary
// that may stand for it, plus adjacent words joined the way rules write them
// ("이중 수혜" → 이중수혜, "예산 전용" → 예산전용).
function queryConcepts(value, maxConcepts = 6) {
  const ordered = [];
  for (const raw of String(value || '').split(/[\s,;|/·?!.()（）"'「」]+/)) {
    const token = contentToken(raw);
    if (token && !ordered.includes(token)) ordered.push(token);
  }
  const kept = new Set([...ordered].sort((a, b) => b.length - a.length).slice(0, maxConcepts));
  const tokens = ordered.filter(token => kept.has(token));
  const concepts = tokens.map(term => ({ term, alternatives: [term, ...(RULE_VOCABULARY.get(term) || [])] }));
  for (let i = 0; i + 1 < tokens.length; i++) {
    const joined = tokens[i] + tokens[i + 1];
    const concept = { term: joined, alternatives: [joined, ...(RULE_VOCABULARY.get(joined) || [])], joinedFrom: [tokens[i], tokens[i + 1]] };
    concepts.push(concept);
  }
  return { tokens, concepts };
}

// Campus and affiliate editions of one rule ("WISE캠퍼스 구매규정", "산학협력단
// 위임전결규정") share a family with the unprefixed rule.
const EDITION_PREFIX = /^(?:WISE캠퍼스\s*산학협력단|WISE캠퍼스|의학계열|산학협력단)\s*/;
function ruleFamily(title) {
  const text = String(title || '').trim();
  const prefix = (text.match(EDITION_PREFIX) || [''])[0].trim();
  return { family: text.replace(EDITION_PREFIX, '').replace(/\s+/g, ''), edition: prefix || null };
}

module.exports = {
  clampNumber,
  normalizeText,
  ruleNameFromQuery,
  titleInQuery,
  withoutRuleName,
  searchVariants,
  rankRuleHits,
  selectRuleCandidate,
  termTokens,
  extractRelevantBlocks,
  queryContentTokens,
  queryConcepts,
  ruleFamily,
  appendixSelectors,
};

'use strict';

const { expandAliases, middotVariants, normalizeMiddots, businessTerms, knownTerm, compoundParts, phraseConcepts, questionScope } = require('./aliases.js');
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

function articleSelectors(value) {
  return [...String(value || '').matchAll(/제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?/g)]
    .map(match => match[0].replace(/[ \t]/g, ''));
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
    ...articleSelectors(source),
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

  let outsideBody = false;
  // Each priority article is taken once, from the main body, in the order given.
  const priorityOrder = (options.priorityArticles || []).slice(0, maxBlocks);
  const priorityAssigned = new Set();
  const scored = blocks
    .map((block, index) => {
      // Supplementary provisions restart article numbering. Once their boundary
      // (or an attachment) is reached, the same number is not a main article.
      if (block.split('\n').some(line => isBodyBoundary(line) === 'supplementary' || appendixHeading(line))) outsideBody = true;
      const context = index > 0 ? blocks[index - 1] : '';
      const heading = /^(?:#{1,6}[ \t]*)?(?:\*\*)?(제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?)[ \t]*[(（]([^)）]+)[)）]/.exec(block);
      const article = heading?.[1].replace(/[ \t]/g, '');
      const genericHeading = heading && /^(?:목적|정의|용어의정의)$/.test(heading[2].replace(/\s/g, ''));
      const priority = !outsideBody && !genericHeading && priorityOrder.includes(article) && !priorityAssigned.has(article);
      const result = scoreBlock(block, tokens, context) || (priority ? { score: 0, matched: [] } : null);
      if (priority) priorityAssigned.add(article);
      return result ? { block, index, ...result, priority: !!priority, priorityRank: priority ? priorityOrder.indexOf(article) : Infinity } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.priorityRank - b.priorityRank || b.score - a.score || a.index - b.index);

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
  // A priority article and its paragraphs consume one slot, never one slot
  // per paragraph. Fill remaining slots using the original keyword ranking.
  const priorityIndexes = new Set();
  for (const item of scored.filter(item => item.priority).slice(0, maxBlocks)) {
    for (const index of articleContexts[item.index] || []) if (index !== item.index) priorityIndexes.add(index);
  }
  const selectedMatches = scored.filter(item => !priorityIndexes.has(item.index)).slice(0, maxBlocks);
  // Preserve previously selected annex evidence when a new priority article
  // would displace it. Replace a lower-ranked ordinary match, within the limit;
  // when priority articles fill every slot, the last of them gives way once.
  if (scored[0]?.priority) {
    const originalMatches = scored.filter(item => item.matched.length)
      .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, maxBlocks);
    const isAnnex = item => !!appendixHeading(item.block.split('\n', 1)[0]);
    let priorityGaveWay = false;
    for (const annex of originalMatches.filter(isAnnex)) {
      if (selectedMatches.includes(annex)) continue;
      let replaceAt = selectedMatches.findLastIndex(item => !item.priority && !isAnnex(item));
      if (replaceAt < 0 && !priorityGaveWay && !selectedMatches.some(item => !item.priority)) {
        replaceAt = selectedMatches.findLastIndex((item, at) => at > 0 && item.priority);
        priorityGaveWay = replaceAt >= 0;
      }
      if (replaceAt >= 0) selectedMatches[replaceAt] = annex;
    }
    selectedMatches.sort((a, b) => a.priorityRank - b.priorityRank || b.score - a.score || a.index - b.index);
  }
  const selectedIndexes = new Set(selectedMatches.map(x => x.index));
  for (const item of selectedMatches) {
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
    selectedMatches.forEach((item, rank) => {
      for (const index of [item.index, ...(articleContexts[item.index] || [])]) if (!rankOf.has(index)) rankOf.set(index, rank);
    });
  }
  const rank = index => rankOf.has(index) ? rankOf.get(index) : maxBlocks;
  const orderedIndexes = [...selectedIndexes].sort((a, b) => rank(a) - rank(b) || a - b);
  const selected = orderedIndexes.map(index => blocks[index]).join('\n\n');
  const matchedTerms = [...new Set(
    selectedMatches.flatMap(x => x.matched)
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
  '누가', '누구', '누구에게', '언제', '언제까지', '언제부터', '어디', '어디서', '무슨', '몇', '며칠', '몇일', '얼마나', '필요', '필요한', '있어', '있는', '없는',
  '있나', '없나', '있을', '없을', '받아', '받나', '받는', '받을', '하려면', '하면', '해야', '하는', '하나', '되는', '됩니까',
  '싶어', '싶은', '궁금', '궁금해', '어느', '무엇인가요', '뭐가', '뭘', '이런', '그런', '어떠한',
  // Everyday verbs and adverbs around the topic words ("출장 가서", "먼저 발주", "다른 걸로").
  '가는', '가서', '가면', '가도', '타고', '나면', '나와', '나오나', '걸리면',
  '누구한테', '누구한테서', '어디에', '어디로', '뭐해', '해도',
  '있어야', '없으면', '들어', '받기', '받으면', '받아도', '되나', '되면', '돼요', '싶은데',
  '전에', '후에', '먼저', '나중에', '대신', '다른', '걸로', '자기', '사람', '하루', '관련된', '때도', '그냥', '혹시', '아니면',
  '원래', '말고', '받은', '남는', '거야', '건가요', '때문에', '다시', '것들', '무슨', '일을',
]);
// Two particles together come first ("센터에는", "직원에게도"), so the noun is left whole.
const PARTICLE_SUFFIX = /(?:에서는|에서도|에게는|에게도|한테는|한테도|으로는|으로도|까지는|부터는|에는|에도|에서|으로|에게|한테|까지|부터|이란|란|은|는|이|가|을|를|의|에|로|과|와|도|만)$/;
// "겸직하려면" → 겸직, "전결해" → 전결: the noun before a 하다/되다/받다 ending.
const VERB_ENDING = /(?:하다가|받다가|하다|한다|했다|했어요|했어|하려면|하려고|하려는|하고자|하면서|하면|하여야|해야|하여|해서|해도|하는지|하는|하기|하나요|합니까|합니다|했는데|한다면|할까요|할지|하고|해요|해|할|되나요|되는지|되려면|되면|되는|받으려면|받아야|받으면|받는|받을|받아)$/;
// Nouns that end in 해; not "noun + 해".
// Nouns that end in 할; not "noun + 할" (역할, 분할).
const NOUN_ENDING_HAL = /(?:역할|분할|관할)$/;
const NOUN_ENDING_HAE = /(?:피해|손해|재해|이해|방해|침해|상해|견해|화해|양해|오해|저해|유해|무해)$/;
// Nouns that end in 도; not "noun + 도" (회계연도, 한도, 제도).
const NOUN_ENDING_DO = /(?:연도|년도|제도|한도|용도|양도|빈도|정도|지도|태도|속도|온도|강도|난이도)$/;
// Two-syllable nouns before the subject particle 가 (교수가 → 교수). Other
// three-syllable words ending in 가 (전문가, 낙찰가) are nouns themselves.
const SUBJECTS_BEFORE_GA = new Set(['교수', '강사', '조교', '부서', '학교', '이사', '감사', '회계', '근로자']);

// One-syllable nouns that carry the topic of a question ("책 연체", "상 받을 때").
const ONE_SYLLABLE_NOUNS = new Set(['책', '상', '돈', '술']);
// A counter with its particle ("시부터야", "년이", "명까지") is not a topic word.
const COUNTER_REMNANT = /^(?:시|분|일|년|월|주|번|회|명|개|살|점|원|배)(?:부터|까지|동안|이나|씩|마다|이내|안에)?(?:이|야|이야|이에요|예요|인가요|이죠|인지)?$/;
function contentToken(raw) {
  let token = String(raw || '').trim();
  if (!token || /^제?\d+조?$/.test(token)) return null;
  const bare = token.replace(/(?:은|는|이|을|를|도)$/, '');
  if (ONE_SYLLABLE_NOUNS.has(bare) && token.length <= 2) return bare;
  if (knownTerm(token)) return token;
  // "며칠이야", "몇 년이에요": the copula is not part of the word.
  token = token.replace(/(?:이에요|이예요|예요|이야|인가요|인가|이죠|인지|입니까|이니)$/, '');
  if (knownTerm(token)) return token;
  const verbStem = NOUN_ENDING_HAE.test(token) || NOUN_ENDING_HAL.test(token) ? token : token.replace(VERB_ENDING, '');
  if (verbStem !== token) {
    // A bare verb ("받아", "해야") leaves nothing to search for.
    if (verbStem.length < 2) return null;
    token = verbStem;
  } else {
    const stripped = NOUN_ENDING_DO.test(token) ? token : token.replace(PARTICLE_SUFFIX, '');
    // "년까지", "곳에서": a counter or pronoun before a long particle is not a search word.
    if (stripped.length < 2 && token.length - stripped.length >= 2) return null;
    if (stripped.length >= 2 && (!(token.length === 3 && token.endsWith('가')) || SUBJECTS_BEFORE_GA.has(stripped))) token = stripped;
  }
  if (token.length < 2 || QUESTION_STOPWORDS.has(token) || COUNTER_REMNANT.test(token)) return null;
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


// Search concepts of a question: each content word with the rule vocabulary
// that may stand for it, plus adjacent words joined the way rules write them
// ("이중 수혜" → 이중수혜, "예산 전용" → 예산전용).
function queryConcepts(value, maxConcepts = 6) {
  const ordered = [], written = new Map();
  for (const raw of String(value || '').split(/[\s,;|/·?!.()（）"'「」]+/)) {
    const token = contentToken(raw);
    // One syllable was read as a particle ("출산휴가" → 출산휴). The index decides later
    // whether the word as written is the real one.
    if (token && raw.length === token.length + 1 && raw.startsWith(token)) written.set(token, raw);
    // "월급날" asks about two things, 보수 and its 지급일; each is its own concept.
    for (const part of token ? compoundParts(token) : []) if (!ordered.includes(part)) ordered.push(part);
  }
  const kept = new Set([...ordered].sort((a, b) => b.length - a.length).slice(0, maxConcepts));
  const tokens = ordered.filter(token => kept.has(token));
  const concepts = tokens.map(term => ({ term, alternatives: businessTerms(term), ...(written.has(term) ? { written: written.get(term) } : {}) }));
  // "없을 때" → 부재: a phrase adds the rule word as a concept of its own, not joined with its neighbours.
  for (const term of phraseConcepts(value)) if (!tokens.includes(term)) concepts.push({ term, alternatives: businessTerms(term) });
  for (let i = 0; i + 1 < tokens.length; i++) {
    const joined = tokens[i] + tokens[i + 1];
    const concept = { term: joined, alternatives: businessTerms(joined, { verbs: false }), joinedFrom: [tokens[i], tokens[i + 1]] };
    concepts.push(concept);
  }
  return { tokens, concepts };
}

// Rule vocabulary the caller supplies next to the question ("분실, 변상, 계약 해지").
// One phrase per comma; the words are nouns as written, so no particle or verb
// ending is stripped. Words that carry no rule vocabulary are dropped.
const MAX_KEYWORDS = 8;
const KEYWORD_STOPWORDS = new Set(['규정', '규칙', '동국대', '동국대학교', '학교', '관련', '내용', '여부', '경우', '대한', '관한']);
function parseKeywords(value) {
  let source = normalizeMiddots(Array.isArray(value) ? value.join(',') : String(value || ''));
  const separator = /[,，、;；|/\nㆍ]+/;
  // Three or more words with no separator at all are a list written with spaces, not one phrase.
  if (!separator.test(source) && source.trim().split(/\s+/).length >= 3) source = source.trim().split(/\s+/).join(',');
  const phrases = [], seen = new Set();
  for (const part of source.split(separator)) {
    const words = part.replace(/[^가-힣A-Za-z0-9\s]/g, ' ').split(/\s+/)
      // Article and appendix numbers ("제10조", "별표1") are excerpt selectors, not vocabulary.
      .filter(word => word.length >= 2 && !KEYWORD_STOPWORDS.has(word) && !/^(?:\d+|제?\d+조(?:의\d+)?|별표\d*)$/.test(word));
    const key = words.join(' ');
    if (!words.length || seen.has(key)) continue;
    seen.add(key);
    phrases.push(words);
  }
  return phrases.slice(0, MAX_KEYWORDS);
}

// Keyword phrases as search concepts: each word with the rule vocabulary that
// may stand for it, and the words of one phrase joined the way rules may write
// them ("계약 해지" → 계약해지).
function keywordConcepts(phrases) {
  const concepts = [], terms = new Set();
  const add = concept => { if (!terms.has(concept.term)) { terms.add(concept.term); concepts.push(concept); } };
  (phrases || []).forEach((words, phrase) => {
    for (const term of words) add({ term, alternatives: businessTerms(term), keyword: true, phrase });
    for (let i = 0; i + 1 < words.length; i++) {
      const joined = words[i] + words[i + 1];
      add({ term: joined, alternatives: businessTerms(joined, { verbs: false }), joinedFrom: [words[i], words[i + 1]], keyword: true, phrase });
    }
  });
  return concepts;
}

// Campus and affiliate editions of one rule ("WISE캠퍼스 구매규정", "산학협력단
// 위임전결규정") share a family with the unprefixed rule.
const EDITION_PREFIX = /^(?:WISE캠퍼스\s*산학협력단|WISE캠퍼스|의학계열|산학협력단)\s*/;
function ruleFamily(title) {
  const text = String(title || '').trim();
  const prefix = (text.match(EDITION_PREFIX) || [''])[0].trim();
  return { family: text.replace(EDITION_PREFIX, '').replace(/\s+/g, ''), edition: prefix || null };
}

// Scope words select editions, not applicability. Conflicting campus inputs
// or multiple institutions remain ambiguous; an absent scope is not "general".
function requestedRuleScope(query, campus = 'all') {
  const text = String(query || '').replace(/\s+/g, '');
  const campuses = new Set(campus === 'all' ? [] : [campus]);
  const namedScope = questionScope(text);
  if (namedScope.wise) campuses.add('wise');
  if (/서울캠퍼스/.test(text)) campuses.add('seoul');
  const institutions = [namedScope.industry && '산학협력단', namedScope.medical && '의학계열'].filter(Boolean);
  return { campuses: [...campuses], institutions, specified: campuses.size > 0 || institutions.length > 0,
    ambiguous: campuses.size > 1 || institutions.length > 1 };
}

function selectRuleEditions(members, scope) {
  const matches = member => {
    const edition = member.edition || '';
    const campus = edition.startsWith('WISE캠퍼스') ? 'wise' : 'seoul';
    return (!scope.campuses.length || scope.campuses.includes(campus))
      && (!scope.institutions.length || scope.institutions.some(name => edition.includes(name)));
  };
  const matching = scope.specified ? members.filter(matches) : [];
  // Collapse only when a specified scope identifies one edition. Otherwise
  // keep each plausible edition's own score and body in the candidate list.
  const selected = matching.length ? matching : members;
  return selected.map(member => ({
    ...member,
    scopeMatch: scope.specified ? matches(member) : null,
    scopeAmbiguous: scope.ambiguous || selected.length > 1,
    editions: members.filter(other => other !== member).map(other => ({
      lawId: other.lawId, title: other.title, edition: other.edition, topArticle: other.topArticle,
    })),
  }));
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
  parseKeywords,
  keywordConcepts,
  MAX_KEYWORDS,
  ruleFamily,
  appendixSelectors,
  articleSelectors,
  requestedRuleScope,
  selectRuleEditions,
};

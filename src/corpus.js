'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listArticleBlocks, CONTENT_PARSER_VERSION } = require('./parsers.js');
const { businessTerms, verbNoun, containsTerm, generalRuleWeight, headingCueStrength, asksIntent, questionSubject, subjectWeight } = require('./aliases.js');
const { queryConcepts, keywordConcepts, ruleFamily } = require('./lookup.js');

// Local full-text index of every current rule. It only narrows candidates:
// callers re-check each hit against the current catalog before using its text.
const CORPUS_VERSION = 1;
const CORPUS_FILE = `corpus-v${CORPUS_VERSION}.json`;

function blocksOf(markdown) {
  const articles = listArticleBlocks(markdown).map(block => ({
    article: block.canonical,
    supplementary: block.supplementary,
    supplementaryHeading: block.supplementaryHeading || null,
    content: block.content,
  }));
  if (articles.length) return articles;
  const text = String(markdown || '').trim();
  // Short 내규 without 조 headings are indexed as one block.
  return text ? [{ article: null, supplementary: false, supplementaryHeading: null, content: text }] : [];
}

async function buildCorpus({ catalog, loadContent, previous = null, onProgress = () => {}, now = () => new Date() }) {
  if (previous?.catalogTotal && catalog.length < previous.catalogTotal * 0.8) {
    throw new Error(`규정 목록이 이전 색인(${previous.catalogTotal}건)보다 크게 줄었습니다(${catalog.length}건). 원문 사이트 응답을 확인하세요.`);
  }
  // Matching history IDs do not make bodies from an older parser complete.
  const reusableRules = previous?.contentVersion === CONTENT_PARSER_VERSION ? previous.rules || [] : [];
  const reusable = new Map(reusableRules.map(rule => [`${rule.lawId}_${rule.historyId}`, rule]));
  const rules = [], failed = [];
  let reused = 0;
  for (let i = 0; i < catalog.length; i++) {
    const entry = catalog[i];
    const kept = reusable.get(`${entry.lawId}_${entry.historyId}`);
    if (kept) {
      rules.push({ ...kept, title: entry.title, code: entry.code, revisedAt: entry.revisedAt });
      reused++;
    } else {
      try {
        const content = await loadContent(entry.lawId, entry.historyId);
        const blocks = blocksOf(content?.markdown);
        if (!blocks.length) failed.push({ lawId: entry.lawId, title: entry.title, code: 'CONTENT_UNAVAILABLE' });
        else rules.push({ ...entry, blocks });
      } catch (error) {
        failed.push({ lawId: entry.lawId, title: entry.title, code: 'FETCH_FAILED' });
      }
    }
    onProgress({ done: i + 1, total: catalog.length, failed: failed.length, reused });
  }
  return { version: CORPUS_VERSION, contentVersion: CONTENT_PARSER_VERSION, builtAt: now().toISOString(), catalogTotal: catalog.length, reused, rules, failed };
}

function corpusPath(directory) { return path.join(directory, 'corpus', CORPUS_FILE); }

function saveCorpus(directory, corpus) {
  const filename = corpusPath(directory);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(corpus), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return filename;
}

const loaded = new Map();
function loadCorpus(directory, { allowStaleParser = false } = {}) {
  const filename = corpusPath(directory);
  let stat;
  try { stat = fs.statSync(filename); } catch { return null; }
  const memo = loaded.get(filename);
  const usable = corpus => allowStaleParser || corpus.contentVersion === CONTENT_PARSER_VERSION ? corpus : null;
  if (memo && memo.mtimeMs === stat.mtimeMs) return usable(memo.corpus);
  try {
    const corpus = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (corpus?.version !== CORPUS_VERSION || !Array.isArray(corpus.rules)) return null;
    loaded.set(filename, { mtimeMs: stat.mtimeMs, corpus });
    return usable(corpus);
  } catch { return null; }
}

function corpusCoverage(corpus) {
  return {
    indexedAt: corpus.builtAt,
    indexedRules: corpus.rules.length,
    totalRules: corpus.catalogTotal,
    failedRules: corpus.failed.length,
    complete: corpus.failed.length === 0 && corpus.rules.length === corpus.catalogTotal,
  };
}

// Blocks that contain the most query words, rarer words weighing more.
function matchBlocks(blocks, tokens, weights) {
  let best = 0;
  const scored = [];
  for (const block of blocks) {
    const matched = tokens.filter(token => block.content.includes(token));
    if (!matched.length) continue;
    const score = matched.reduce((sum, token) => sum + (weights.get(token) || 1), 0);
    best = Math.max(best, score);
    scored.push({ block, matched, score });
  }
  return { best, scored: scored.sort((a, b) => b.score - a.score) };
}

// Rules write 근로장학금 where a question says 교내근로장학금, and 출장 where it
// says 국내출장. A word that no rule contains is replaced by its longest
// shorter form that some rule does contain. For four or more syllables the
// head noun is at the end, so leading syllables (교내·국내) are dropped first;
// a three-syllable word such as 특강료 or 강사료 keeps its first two syllables
// (특강, 강사) because its last two (강료, 사료) are fragments of other words.
// Forms shorter than two syllables or found in most rules are not used.
const VERB_REMNANT = /(?:면|고|서|는|야|어|아|이|요|니|게|던|든|도|만|지|해|돼|네|죠|까|나|라)$/;
function rewriteMissingToken(token, documentFrequency, total) {
  if (token.length < 3) return null;
  const candidates = [];
  if (token.length === 3) candidates.push(token.slice(0, 2), token.slice(1));
  else {
    for (let drop = 1; token.length - drop >= 2; drop++) candidates.push(token.slice(drop));
    for (let cut = token.length - 1; cut >= 2; cut--) candidates.push(token.slice(0, cut));
    candidates.sort((a, b) => b.length - a.length);
  }
  for (const form of candidates) {
    // Two syllables left of an inflected verb ("늦어지면" → 지면, "올리고" → 리고) are not a word.
    if (form.length === 2 && VERB_REMNANT.test(form)) continue;
    const df = documentFrequency(form);
    if (df && df <= total * 0.5) return form;
  }
  return null;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Concepts of the question as the rules spell them. A question word keeps its
// rule vocabulary ("해외출장" also tries 국외출장·국외); a word no rule contains
// is replaced by vocabulary that exists, then by a shorter form.
function planConcepts(query, documentFrequency, total) {
  const { tokens: original, concepts: planned } = queryConcepts(query, 6);
  const rewrittenTerms = {}, concepts = [], missingTerms = [];
  for (const concept of planned) {
    let forms = concept.alternatives.filter(form => documentFrequency(form));
    if (concept.joinedFrom) {
      // "이중 수혜" joined as 이중수혜 counts only when rules write it that way.
      if (forms.length) concepts.push({ term: concept.term, forms, joined: true });
      continue;
    }
    // "출산휴가", "평가": the last syllable belongs to the word when the rules almost
    // always write the stem with it.
    if (concept.written && documentFrequency(concept.written) >= documentFrequency(concept.term) * 0.8 && documentFrequency(concept.written)) {
      // The dictionary may know the word either way ("동시에" → 동시 → 이중수혜).
      const vocabulary = businessTerms(concept.term).filter(form => form !== concept.term);
      concept.term = concept.written;
      forms = [...new Set([...businessTerms(concept.written), ...vocabulary])].filter(form => documentFrequency(form));
    }
    const term = concept.term;
    // "절차가": a noun plus the subject particle when the bare noun is far more common.
    if (term.length === 3 && term.endsWith('가')) {
      const stem = term.slice(0, 2), stemFrequency = documentFrequency(stem);
      if (stemFrequency && documentFrequency(term) < stemFrequency * 0.05) {
        rewrittenTerms[term] = stem;
        concept.term = stem;
        forms = businessTerms(stem).filter(form => documentFrequency(form));
      }
    }
    if (!forms.length) {
      const shorter = rewriteMissingToken(term, documentFrequency, total);
      if (shorter) { rewrittenTerms[term] = shorter; forms = [shorter]; }
    } else if (!documentFrequency(term) && !rewrittenTerms[term]) rewrittenTerms[term] = forms[0];
    if (forms.length) concepts.push({ term: concept.term, forms, joined: false });
    else missingTerms.push(term);
  }
  return { original, concepts, rewrittenTerms, missingTerms };
}

// A keyword written as one word that the rules write as two ("휴학사유" → 휴학 + 사유).
// Both parts must occur in some rule; the pair with the rarest words is used.
function splitCompound(term, documentFrequency, total) {
  let best = null;
  for (let cut = 2; cut <= term.length - 2; cut++) {
    const parts = [term.slice(0, cut), term.slice(cut)];
    if (!parts.every(part => documentFrequency(part))) continue;
    const rarity = parts.reduce((sum, part) => sum + Math.log(1 + total / documentFrequency(part)), 0);
    if (!best || rarity > best.rarity) best = { parts, rarity };
  }
  return best?.parts || null;
}

// Caller-supplied keywords as the rules spell them. A keyword keeps the rule
// vocabulary the dictionary knows for it; one that no rule contains is tried
// as two shorter words and then by a shorter form. Keywords that still match
// nothing are reported, never guessed.
function planKeywordConcepts(phrases, documentFrequency, total) {
  const concepts = [], missingTerms = [], rewrittenTerms = {}, terms = new Set();
  const push = concept => { if (!terms.has(concept.term)) { terms.add(concept.term); concepts.push(concept); } };
  const existing = term => businessTerms(term).filter(form => documentFrequency(form));
  for (const concept of keywordConcepts(phrases)) {
    const base = { keyword: true, phrase: concept.phrase };
    let forms = concept.alternatives.filter(form => documentFrequency(form));
    if (concept.joinedFrom) {
      if (forms.length) push({ ...base, term: concept.term, forms, joined: true });
      continue;
    }
    if (!forms.length) {
      const parts = splitCompound(concept.term, documentFrequency, total);
      if (parts) {
        rewrittenTerms[concept.term] = parts.join(' ');
        for (const part of parts) push({ ...base, term: part, forms: existing(part), joined: false });
        continue;
      }
      const shorter = rewriteMissingToken(concept.term, documentFrequency, total);
      if (shorter) { rewrittenTerms[concept.term] = shorter; forms = [shorter]; }
    } else if (!documentFrequency(concept.term)) rewrittenTerms[concept.term] = forms[0];
    if (forms.length) push({ ...base, term: concept.term, forms, joined: false });
    else missingTerms.push(concept.term);
  }
  return { concepts, missingTerms, rewrittenTerms };
}

// How central a rule is in the rule book: rules that many other rules cite by
// name (「학칙」, 「교원인사규정」) and rules with many articles are the general
// ones people usually mean. A mild preference, computed once per index.
// 1 for a short rule nobody cites; 학칙 (cited by 46 rules, 70 articles) gets about 1.35, the cap.
const standings = new WeakMap();
function ruleStanding(corpus) {
  if (standings.has(corpus)) return standings.get(corpus);
  const compact = text => String(text || '').replace(/\s+/g, '');
  const citedBy = new Map();
  for (const rule of corpus.rules) {
    const names = new Set();
    for (const block of rule.blocks) for (const match of block.content.matchAll(/「([^「」\n]{2,60})」/g)) names.add(compact(match[1]));
    names.delete(compact(rule.title));
    for (const name of names) citedBy.set(name, (citedBy.get(name) || 0) + 1);
  }
  const result = new Map();
  for (const rule of corpus.rules) {
    const cited = citedBy.get(compact(rule.title)) || 0;
    const articles = rule.blocks.filter(block => block.article && !block.supplementary).length;
    result.set(rule.lawId, Math.min(1.35, 1 + 0.05 * Math.log2(1 + cited) + 0.04 * Math.log2(Math.max(1, articles / 10))));
  }
  standings.set(corpus, result);
  return result;
}
// Words in the rule's title are what every article is about, so inside the
// rule they tell articles apart far less than the other question words do.
const TITLE_WORD_SHARE = 0.3;

// With caller keywords, the question's own words still count, at this share of
// their weight: they add the context a short keyword list leaves out
// ("노트북" next to 분실·변상) without outvoting the keywords.
const QUESTION_SHARE_WITH_KEYWORDS = 0.35;
// A keyword in an article heading names what the article is about.
const KEYWORD_HEADING_SHARE = 1;
// A whole keyword phrase in one heading ("사적 사용" in 제16조(학교재산 등의 사적 사용·수익 금지)).
const KEYWORD_PHRASE_HEADING_SHARE = 1;
// Keywords already say what is asked ("기간", "자격"), so the intent read from
// the question's wording weighs less beside them.
const INTENT_SHARE_WITH_KEYWORDS = 0.5;

const GENERIC_HEADING = /^(?:목적|정의|용어의정의|적용범위)$/;
const headingOf = content => /^[^\n]*?제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[(（]([^)）\n]{1,40})[)）]/.exec(content)?.[1] || null;
// An article that can be the answer: in the main body, and not the purpose or definition article.
const answerable = block => {
  const heading = headingOf(block.content)?.replace(/\s+/g, '');
  return !block.supplementary && !(heading && GENERIC_HEADING.test(heading));
};

// Semantic search (semantic.js) scores every article by closeness in meaning to
// the question. It supports the word index and never replaces it: alone it
// names the right rule less often than the words do. Two uses, both by rank
// (cosine values of different questions are not comparable):
// - a rule whose closest article is among the closest of all rules scores
//   higher, up to twice for the closest rule, fading to no change at this rank;
const SEMANTIC_RULE_REACH = 10;
const SEMANTIC_RULE_SHARE = 1;
// - each rule reports its closest article, which callers excerpt next to the
//   article the words chose. The word ranking of articles itself is unchanged;
//   reordering articles by meaning lost more answers than it found.
function arrangeSemantic(corpus, scores) {
  if (!scores?.size) return null;
  const closestArticle = new Map(), closeness = [];
  for (const rule of corpus.rules) {
    let best = null;
    for (const block of rule.blocks) if (scores.has(block) && answerable(block) && !(scores.get(best) >= scores.get(block))) best = block;
    if (!best) continue;
    closestArticle.set(rule.lawId, best);
    closeness.push([rule.lawId, scores.get(best)]);
  }
  const ruleRank = new Map(closeness.sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([lawId], i) => [lawId, i + 1]));
  return { closestArticle, ruleRank };
}

function searchCorpus(corpus, query, { top = 3, perDoc = 5, keywords = null, semantic = null } = {}) {
  const sem = arrangeSemantic(corpus, semantic);
  const total = corpus.rules.length || 1;
  const frequencies = new Map();
  const documentFrequency = term => {
    if (!frequencies.has(term)) frequencies.set(term, corpus.rules.filter(rule => rule.title.includes(term) || rule.blocks.some(block => block.content.includes(term))).length);
    return frequencies.get(term);
  };
  const planned = planConcepts(query, documentFrequency, total);
  const { original } = planned;
  let { concepts, rewrittenTerms, missingTerms } = planned;
  // Keywords lead only when some rule contains them; otherwise the question alone is searched, as without keywords.
  const keyed = keywords?.length ? planKeywordConcepts(keywords, documentFrequency, total) : null;
  const keywordMode = !!keyed?.concepts.length;
  const keywordReport = keyed ? {
    keywords: { used: keyed.concepts.filter(concept => !concept.joined).map(concept => concept.term), missing: keyed.missingTerms, rewritten: keyed.rewrittenTerms },
  } : {};
  if (!original.length && !keywordMode) return { tokens: original, hits: [], ...keywordReport };
  if (keywordMode) {
    const keywordForms = new Set(keyed.concepts.flatMap(concept => concept.forms));
    const fromQuestion = concepts.filter(concept => !concept.forms.some(form => keywordForms.has(form)));
    concepts = [...keyed.concepts, ...fromQuestion.map(concept => ({ ...concept, share: QUESTION_SHARE_WITH_KEYWORDS }))];
    missingTerms = [...keyed.missingTerms, ...missingTerms];
    rewrittenTerms = { ...rewrittenTerms, ...keyed.rewrittenTerms };
  }
  const weight = form => Math.log(1 + total / documentFrequency(form));
  // A rule-vocabulary form stands in for the question word, so it never counts
  // for more than that word itself would ("식사" → 금품등 must not outweigh a
  // rule that says 식사). A word no rule contains lends its full weight.
  // A verb stands for its rule noun ("낳으면" → 출산): the noun is then the word asked, and the
  // other words of its group (육아, 양육) count for no more than it does.
  for (const concept of concepts) {
    const noun = documentFrequency(concept.term) ? null : verbNoun(concept.term);
    const asked = noun && documentFrequency(noun) ? noun : concept.term;
    const own = documentFrequency(asked) ? weight(asked) : Infinity;
    const share = concept.share || 1;
    concept.weights = new Map(concept.forms.map(form => [form, (form === asked ? weight(form) : Math.min(weight(form), own) * 0.9) * share]));
  }
  const formWeight = (concept, forms) => Math.max(0, ...forms.map(form => concept.weights.get(form)));
  const words = concepts.filter(concept => !concept.joined);
  const intent = asksIntent(query);
  // Adjacent question words that also sit together in an article ("예산의 전용").
  // Keywords pair only inside one phrase ("계약 해지"), never across commas or with question words.
  const adjacent = [];
  for (let i = 0; i + 1 < words.length; i++) {
    if (!!words[i].keyword !== !!words[i + 1].keyword || (words[i].keyword && words[i].phrase !== words[i + 1].phrase)) continue;
    const [a, b] = [words[i].forms[0], words[i + 1].forms[0]];
    adjacent.push({ pattern: new RegExp(`${escapeRegExp(a)}[^\\n]{0,3}${escapeRegExp(b)}`), bonus: (weight(a) + weight(b)) * 0.5 * (words[i].share || 1) });
  }
  // A concept scores by the rarest of its forms that the text contains.
  const scoreText = text => {
    let score = 0; const matched = [], matchedConcepts = [], contributions = new Map();
    for (const concept of concepts) {
      const found = concept.forms.filter(form => containsTerm(text, form));
      if (!found.length) continue;
      // A joined pair repeats its two words, so it adds half of its own weight.
      const gained = formWeight(concept, found) * (concept.joined ? 0.5 : 1);
      score += gained;
      contributions.set(concept, gained);
      for (const form of found) if (!matched.includes(form)) matched.push(form);
      matchedConcepts.push(concept.term);
    }
    return { score, matched, matchedConcepts, contributions };
  };
  // Keyword phrases of two or more words, for headings that carry the whole phrase.
  const phrases = new Map();
  for (const word of words) if (word.keyword) phrases.set(word.phrase, [...(phrases.get(word.phrase) || []), word]);
  const multiwordPhrases = [...phrases.values()].filter(group => group.length >= 2);
  const searchForms = [...new Set(words.flatMap(word => word.forms))];
  const standing = ruleStanding(corpus);
  // Who the question is about, read from the question and the keywords together.
  const subject = questionSubject(query, keywordMode ? keywords.map(phrase => phrase.join(' ')).join(' ') : '');
  const generalFamilies = new Set(corpus.rules.filter(r => !ruleFamily(r.title).edition).map(r => ruleFamily(r.title).family));
  const hits = [];
  for (const rule of corpus.rules) {
    const scored = [];
    for (const block of rule.blocks) {
      const result = scoreText(block.content);
      if (!result.matched.length) continue;
      for (const pair of adjacent) if (pair.pattern.test(block.content)) result.score += pair.bonus;
      // An article titled with a question word ("제31조(휴학)") is about that word, not a passing
      // mention; a heading that is exactly the word ("제4조(회계연도)") even more so.
      const heading = headingOf(block.content);
      if (heading) {
        const compactHeading = heading.replace(/\s+/g, '');
        result.score += words.reduce((sum, word) => {
          const inHeading = word.forms.filter(form => compactHeading.includes(form));
          if (!inHeading.length) return sum;
          const share = inHeading.includes(compactHeading) ? 1 : word.keyword ? KEYWORD_HEADING_SHARE : 0.5;
          return sum + formWeight(word, inHeading) * share;
        }, 0);
        for (const group of multiwordPhrases) {
          const inHeading = group.map(word => word.forms.filter(form => compactHeading.includes(form)));
          if (inHeading.every(forms => forms.length)) result.score += group.reduce((sum, word, i) => sum + formWeight(word, inHeading[i]), 0) * KEYWORD_PHRASE_HEADING_SHARE;
        }
      }
      scored.push({ block, ...result });
    }
    scored.sort((a, b) => b.score - a.score);
    const title = scoreText(rule.title);
    if (!scored.length && !title.matched.length) continue;
    // Which article to show first. The rule is already chosen by its words; the
    // question's intent ("언제", "얼마", "어떤 제재") then prefers the article whose
    // heading answers it, and purpose or definition articles come last.
    const articleOrder = scored.map(item => {
      let words = 0, titleWords = 0;
      for (const [concept, gained] of item.contributions) {
        words += gained;
        if (title.contributions.has(concept)) titleWords += gained;
      }
      // Heading and adjacency bonuses of an article that matched title words only are title words too.
      const bonuses = item.score - words;
      const titleOnly = titleWords === words;
      return { ...item, rank: item.score - (titleWords + (titleOnly ? bonuses : 0)) * (1 - TITLE_WORD_SHARE) };
    });
    if (intent) {
      const fullBonus = Math.max(...words.map(word => formWeight(word, word.forms)), 1) * (keywordMode ? INTENT_SHARE_WITH_KEYWORDS : 1);
      const seen = new Set(scored.map(item => item.block));
      for (const block of rule.blocks) {
        if (block.supplementary) continue;
        const strength = headingCueStrength(query, headingOf(block.content));
        if (!strength) continue;
        const bonus = fullBonus * strength;
        const known = articleOrder.find(item => item.block === block);
        if (known) known.rank += bonus;
        // An article that answers the intent without repeating the topic word
        // ("제10조(감사의 종류와 시기)" in 내부감사규정) is a candidate when the rule's title carries the topic.
        else if (!seen.has(block) && title.matched.length) articleOrder.push({ block, score: 0, matched: [], matchedConcepts: [], contributions: new Map(), rank: bonus * 0.9 });
      }
    }
    const usable = item => answerable(item.block);
    for (const item of articleOrder) {
      const heading = headingOf(item.block.content)?.replace(/\s+/g, '');
      if (heading && GENERIC_HEADING.test(heading)) item.rank -= 1000;
      if (item.block.supplementary) item.rank -= 2000;
    }
    articleOrder.sort((a, b) => b.rank - a.rank);
    const matchedTerms = [...new Set([...title.matched, ...scored.flatMap(item => item.matched)])];
    const matchedConcepts = [...new Set([...title.matchedConcepts, ...scored.flatMap(item => item.matchedConcepts)])].filter(term => words.some(word => word.term === term));
    const mostMatched = Math.max(0, ...scored.map(item => item.matched.length));
    const wordScore = ((scored[0]?.score || 0) + title.score * 1.5 + matchedTerms.length * 0.01)
      * generalRuleWeight(rule.title, query, generalFamilies.has(ruleFamily(rule.title).family), { code: rule.code, forms: searchForms })
      * (standing.get(rule.lawId) || 1) * subjectWeight(rule.title, subject);
    const semanticRuleRank = sem?.ruleRank.get(rule.lawId) || null;
    const closeness = semanticRuleRank && semanticRuleRank <= SEMANTIC_RULE_REACH ? 1 - (semanticRuleRank - 1) / SEMANTIC_RULE_REACH : 0;
    hits.push({
      lawId: rule.lawId, historyId: rule.historyId, title: rule.title, code: rule.code, revisedAt: rule.revisedAt,
      score: wordScore * (1 + SEMANTIC_RULE_SHARE * closeness),
      // The score from words alone. Callers judge how clearly one rule leads by this, not by the semantic lift.
      wordScore, semanticRuleRank, semanticArticle: sem?.closestArticle.get(rule.lawId)?.article || null,
      matchedTerms, matchedConcepts, ...ruleFamily(rule.title),
      // Concepts that only the rule's title carries say nothing about its articles.
      articleConcepts: [...new Set(scored.flatMap(item => item.matchedConcepts))].filter(term => words.some(word => word.term === term)),
      // The article that holds the most question words, before the intent reading reorders them.
      wordArticle: scored.find(usable)?.block.article || null,
      // Articles containing as many of the query words as the best article does.
      matchCount: scored.filter(item => item.matched.length === mostMatched).length,
      articles: articleOrder.slice(0, perDoc).map(item => ({
        article: item.block.article, supplementary: item.block.supplementary,
        supplementaryHeading: item.block.supplementaryHeading, content: item.block.content, matchedTerms: item.matched,
      })),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.lawId - b.lawId);
  const tokens = words.map(word => word.forms[0]);
  return {
    tokens: [...tokens, ...missingTerms], missingTerms, rewrittenTerms, semantic: !!sem,
    // Every form searched, for callers that re-read or excerpt the matched rules.
    searchTerms: [...new Set(concepts.flatMap(concept => concept.forms))],
    ...keywordReport, keywordMode,
    hits: hits.slice(0, top),
  };
}

module.exports = { CORPUS_VERSION, blocksOf, buildCorpus, saveCorpus, loadCorpus, corpusPath, corpusCoverage, matchBlocks, searchCorpus, rewriteMissingToken };

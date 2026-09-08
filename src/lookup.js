'use strict';

const { expandAliases, middotVariants, normalizeMiddots } = require('./aliases.js');

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function normalizeText(value) {
  return normalizeMiddots(value).replace(/\s+/g, '').toLowerCase();
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

function termTokens(rawTerms) {
  const source = Array.isArray(rawTerms) ? rawTerms.join(' ') : String(rawTerms || '');
  const base = source
    .split(/[\s,;|/·]+/)
    .map(x => x.trim().toLowerCase())
    .filter(x => x.length >= 2);
  const expanded = [];
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
  const text = `${isTable ? context : ''}\n${block}`.toLowerCase();
  const matched = tokens.filter(token => text.includes(token));
  if (!matched.length) return null;
  let score = matched.length * 12;
  score += matched.reduce((sum, token) => sum + Math.min(countOccurrences(text, token), 4), 0);
  if (isTable) score += 18;
  if (/[0-9][0-9,]*(?:원|%|등급)/.test(block)) score += 8;
  if (/별\s*표|별표/.test(block)) score += 6;
  if (/^제\s*\d+\s*조/m.test(block)) score += 3;
  const wantsDomestic = tokens.includes('국내');
  const wantsForeign = tokens.includes('국외');
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
  const blocks = String(markdown || '')
    .split(/\n\s*\n/)
    .map(x => x.trim())
    .filter(Boolean);
  const tokens = termTokens(rawTerms);

  if (!blocks.length) {
    return { text: '', matchedTerms: [], blockCount: 0, truncated: false };
  }

  if (!tokens.length) {
    const selected = blocks.slice(0, Math.min(maxBlocks, blocks.length)).join('\n\n');
    return {
      ...truncateText(selected, maxChars),
      matchedTerms: [],
      blockCount: Math.min(maxBlocks, blocks.length),
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
    return { text: '', matchedTerms: [], blockCount: 0, truncated: false };
  }

  const selectedIndexes = new Set(scored.slice(0, maxBlocks).map(x => x.index));
  for (const item of scored.slice(0, maxBlocks)) {
    if (/^\|.+\|/m.test(item.block)) {
      if (item.index > 0) selectedIndexes.add(item.index - 1);
      if (item.index + 1 < blocks.length) {
        const next = blocks[item.index + 1];
        if (!/^(?:<\s*별\s*표|부\s*칙|제\s*\d+\s*조|\*\*제\s*\d+\s*장)/.test(next)) {
          selectedIndexes.add(item.index + 1);
        }
      }
    }
  }

  const orderedIndexes = [...selectedIndexes].sort((a, b) => a - b);
  const selected = orderedIndexes.map(index => blocks[index]).join('\n\n');
  const matchedTerms = [...new Set(
    scored.slice(0, maxBlocks).flatMap(x => x.matched)
  )];
  return {
    ...truncateText(selected, maxChars),
    matchedTerms,
    blockCount: orderedIndexes.length,
  };
}

module.exports = {
  clampNumber,
  normalizeText,
  searchVariants,
  rankRuleHits,
  selectRuleCandidate,
  termTokens,
  extractRelevantBlocks,
};

'use strict';

// Lex dates and addendum markers separately. Binding never depends on a date
// decoration being supported by the article parser.
const DATE_RE = /(?<!\d)\d{4}\s*[.\-/년][\d\s.\-/년월일]*/g;
const ARTICLE_START = /제\s*\d+\s*조/;
const OPEN = { '(': ')', '（': '）', '<': '>', '〈': '〉', '[': ']' };
const CLOSE = new Set(Object.values(OPEN));

function bracketSpans(text) {
  const stack = [], spans = [];
  for (let i = 0; i < text.length; i++) {
    if (OPEN[text[i]]) stack.push(i);
    else if (CLOSE.has(text[i]) && stack.length) {
      const start = stack.pop();
      if (!ARTICLE_START.test(text.slice(start, i + 1))) spans.push({ start, end: i + 1 });
    }
  }
  return spans;
}

function balanced(text) {
  const stack = [];
  for (const ch of text) {
    if (OPEN[ch]) stack.push(OPEN[ch]);
    else if (CLOSE.has(ch) && stack.pop() !== ch) return false;
  }
  return stack.length === 0;
}

function scanDatedAddenda(text) {
  const dates = [...text.matchAll(DATE_RE)].map(m => ({ start: m.index,
    end: m.index + m[0].trimEnd().length, raw: m[0].trimEnd() }));
  const brackets = bracketSpans(text);
  const tokens = [];
  for (const marker of text.matchAll(/부\s*칙/g)) {
    const markerEnd = marker.index + marker[0].length;
    const nearby = dates.filter(date => {
      const gap = date.end <= marker.index ? text.slice(date.end, marker.index)
        : date.start >= markerEnd ? text.slice(markerEnd, date.start) : null;
      return gap !== null && !/[.!?。！？「」]/.test(gap)
        && !ARTICLE_START.test(gap) && !/부\s*칙/.test(gap);
    });
    if (!nearby.length) continue;
    let start = Math.min(marker.index, ...nearby.map(d => d.start));
    let end = Math.max(markerEnd, ...nearby.map(d => d.end));
    // Keep complete wrappers, including '(date) 부칙' and '(date 부칙)'.
    for (const b of brackets) {
      if (b.start < end && b.end > start) {
        start = Math.min(start, b.start); end = Math.max(end, b.end);
      }
    }
    const before = /(?:(?:개정|시행|제정|신설)\s*)?[(（<〈\[]?\s*$/.exec(text.slice(0, start));
    if (before && before[0].trim()) start = before.index + before[0].search(/\S/);
    const after = /^(?:\s*(?:개정|시행|제정|신설|자|[)）>〉\]]))*/.exec(text.slice(end));
    if (after[0].trim()) end += after[0].trimEnd().length;
    const raw = text.slice(start, end);
    const date = nearby[0];
    // Interpret only the supported revision-date grammar. Unknown decorations
    // (including an effective-date qualifier) remain in the token and require review.
    const residue = raw.replace(date.raw, '').replace(/부\s*칙/, '')
      .replace(/개정|제정|신설|자/g, '').replace(/[\s()（）<>〈〉\[\]]/g, '');
    tokens.push({ start, end, raw, text: `부칙(${date.raw}) `,
      syntaxUnverified: nearby.length !== 1 || !balanced(raw) || !!residue });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

function preserveDatedAddendum(match, text, tokens, mentions, after) {
  const articleStart = match.index + (match[1]?.length || 0);
  const token = [...tokens].reverse().find(t => t.start >= after && t.end <= articleStart
    && (!match[1] || t.start <= match.index && t.end >= match.index));
  if (!token) return false;
  const gap = text.slice(token.end, articleStart);
  if (/[.!?。！？]/.test(gap) || mentions.some(m => m.start < articleStart && m.end > token.start)) return false;
  match[0] = text.slice(token.start, match.index + match[0].length);
  match[1] = token.text;
  match.index = token.start;
  return token.syntaxUnverified || !/^\s*(?:(?:의|중)\s*)?$/.test(gap);
}

module.exports = { scanDatedAddenda, preserveDatedAddendum };

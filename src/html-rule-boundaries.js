'use strict';
const { isAppendixHeading } = require('./cau-pdf');

// Korean case particles can be followed by auxiliary particles (에서+만,
// 까지+는, 만+을). Test the whole particle token rather than each spelling.
const PARTICLE = /^(?:으로부터|에게서|에서|에게|한테|으로|부터|까지|처럼|대로|에|의|을|를|은|는|이|가|과|와|로|만|도|중)(?:은|는|만|도|을|를|의|에)*(?=\s|$)/;
const DEMONSTRATIVE = /^이\s+(?:규정|지침|조|항|경우|때|기준|세칙|학칙|규칙|내규|규약|요령|법)(?:은|는|이|가|에|의|을|를|\s|$)/;
function isReferenceTail(value) {
  const text = String(value || '').trimStart();
  if (DEMONSTRATIVE.test(text)) return false;
  return PARTICLE.test(text) || /^(?:에따|에의|을준용|를준용|참조|참고|따라|따른|규정에)/.test(text);
}
function titleEnd(text) {
  if (!/^[（(]/.test(text)) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if ('(（'.includes(text[i])) depth++;
    if (')）'.includes(text[i]) && --depth === 0) return i;
  }
  return -1;
}
// Called only at an HTML line/structural boundary. A rejected ambiguous header
// is quarantined by the caller, never attached to the preceding article.
function classifyArticleStart(line, nextLine = '') {
  const start = /^제\s*\d+\s*조(?:\s*의\s*\d+)?/.exec(line);
  if (!start) return 'body';
  const rest = line.slice(start[0].length).trimStart();
  const end = titleEnd(rest);
  if (end >= 0) {
    const suffix = rest.slice(end + 1).trimStart();
    if (isReferenceTail(suffix || nextLine)) return 'reference';
    // A standalone title, numbered paragraph, or complete prose body belongs
    // to this article even when HTML has no space after </strong> or ')'.
    if (!suffix || /^[①-⑳]/.test(suffix) || /^삭제(?:\s|$)/.test(suffix) || /[.!。]$/.test(suffix) || /[가-힣]{2,}(?:은|는|이|가|을|를|에)(?:\s|$)/.test(suffix)) return 'heading';
    return 'unknown';
  }
  if (isReferenceTail(rest) || /^(?:의(?:개정)?규정|제\d+항)/.test(rest)) return 'reference';
  // Plain titles are short standalone labels, not arbitrary prose after a number.
  if (/^\s+/.test(line.slice(start[0].length)) && /^[가-힣A-Za-z0-9·ㆍ ]{1,30}$/.test(rest)
      && !/(?:한다|한다는|따른|정한|경우|규정은|규정에)$/.test(rest)) return 'heading';
  if (!rest || /^삭제(?:\s|$)/.test(rest)) return 'heading';
  return 'unknown';
}
function isHtmlAppendixHeading(line, nextLine = '') {
  if (!isAppendixHeading(line)) return false;
  // A bare label can continue as prose across p/br boundaries.
  if (isReferenceTail(nextLine)) return false;
  return true;
}
module.exports = { classifyArticleStart, isHtmlAppendixHeading };

'use strict';

// Candidate recognition has no particle/end-suffix whitelist. Once a detail
// selector starts, its complete attached word belongs to the candidate even
// when the verifier cannot interpret the remainder.
const ITEM = String.raw`(?:제\s*)?\d+\s*호`;
const MOK = String.raw`(?:["'“‘\[(（<〈]\s*)?[가나다라마바사아자차카타파하](?:\s*["'”’\])）>〉])?\s*목`;
const APPENDIX = String.raw`(?:별\s*표|별\s*지(?:\s*서\s*식|(?=\s*(?:제\s*)?\d+))|서\s*식(?=\s*(?:제\s*)?\d))`;
const DETAIL_START_SOURCE = String.raw`(?:${APPENDIX}|${ITEM}|${MOK})`;
const START = new RegExp(`^(?:${DETAIL_START_SOURCE})`);

function readDetail(text, start, { suffix = false, paragraph = false } = {}) {
  const rest = text.slice(start);
  let kind = 'UNSUPPORTED_DETAIL';
  let match = START.exec(rest);
  if (!match && suffix) {
    match = /^의\s*\d+/.exec(rest);
    if (match) kind = 'UNSUPPORTED_SELECTOR_SUFFIX';
  }
  if (!match && paragraph) match = /^제\s*\d+\s*항/.exec(rest);
  if (!match) return null;
  let end = start + match[0].length;
  const next = text.slice(end);
  // These are lexical noun/unit continuations, not citation selectors.
  // They are excluded before candidate collection, not used as successful
  // interpretations of an already collected citation.
  if (/호$/.test(match[0]) && /^(?:실|봉|선|기|점|수|칭)/.test(next)) return null;
  if (/목$/.test(match[0]) && /^(?:적|재|록|차)/.test(next)) return null;
  if (/표$/.test(match[0]) && /^시/.test(next)) return null;
  if (/식$/.test(match[0]) && /^지/.test(next)) return null;
  if (kind === 'UNSUPPORTED_SELECTOR_SUFFIX' && /^(?:가지|개|명|건|회|배|호(?:실|봉|선|기|점|수|칭)|항(?:목|구))/.test(next)) return null;
  // Retain a numbered annex's full designation, including spaced form labels.
  if (/^(?:별\s*표|별\s*지|서\s*식)/.test(match[0])) {
    const number = /^\s*(?:제\s*)?\d+(?:\s*호)?(?:\s*의\s*\d+)?/.exec(next);
    if (number) end += number[0].length;
    const form = /^\s*서\s*식/.exec(text.slice(end));
    if (form) end += form[0].length;
  }
  // Opaque continuation: unknown particles/words/nested numbers cannot make
  // this candidate disappear and expose a verified parent article instead.
  const attached = /^[가-힣A-Za-z0-9]+/.exec(text.slice(end));
  if (attached) end += attached[0].length;
  return { start, end, kind };
}

function collectDetailRange(text, start, { standalone = false } = {}) {
  // Bare N호 is a detail only when attached to an article/paragraph, not
  // an independent room, agenda or other ordinary phrase in the paragraph.
  if (standalone && /^\s*\d+\s*호/.test(text.slice(start))) return null;
  let end = start, first = true;
  const tokens = [];
  while (true) {
    const space = /^\s*/.exec(text.slice(end))[0].length;
    const token = readDetail(text, end + space, {
      suffix: !standalone || !first, paragraph: !first,
    });
    if (!token) break;
    tokens.push(token); end = token.end; first = false;
  }
  return tokens.length ? { start, end, tokens } : null;
}

module.exports = { DETAIL_START_SOURCE, collectDetailRange };

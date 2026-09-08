'use strict';

const fs = require('fs');

// 가운뎃점 계열 5종 흡수 (korean-law-mcp v4.9 교훈: 공식 표기 ㆍ(U+318D) vs 실무 표기 ·(U+00B7))
const MIDDOT_CLASS = '[·ㆍ‧•・]';
const MIDDOT_RE = new RegExp(MIDDOT_CLASS);
const MIDDOT_RE_G = new RegExp(MIDDOT_CLASS, 'g');

// 기본 별칭 — 대학 실무 통용 축약만 최소 수록. 확장은 외부 JSON(DONGGUK_RULE_ALIASES) 권장.
const BUILTIN_ALIASES = {
  '전결규정': ['위임전결규정'],
  '전결규칙': ['위임전결규정'],
  '취규': ['취업규칙'],
};

let externalCache;
function loadExternalAliases() {
  if (externalCache !== undefined) return externalCache;
  externalCache = {};
  const file = (process.env.DONGGUK_RULE_ALIASES || '').trim();
  if (!file) return externalCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [alias, target] of Object.entries(parsed)) {
        const list = (Array.isArray(target) ? target : [target])
          .map(x => String(x || '').trim())
          .filter(Boolean);
        if (alias.trim() && list.length) externalCache[alias.trim()] = list;
      }
    }
  } catch (e) {
    // 별칭 파일 오류는 치명적이지 않음 — stderr로만 알림 (stdout 오염 금지)
    console.error(`[dongguk-rule-mcp] 별칭 파일 로드 실패(${file}): ${e.message}`);
  }
  return externalCache;
}

function aliasTable() {
  return { ...BUILTIN_ALIASES, ...loadExternalAliases() };
}

// 테스트에서 env 변경 후 재로딩용
function resetAliasCacheForTest() { externalCache = undefined; }

function normalizeMiddots(value) {
  return String(value || '').replace(MIDDOT_RE_G, 'ㆍ');
}

// 검색용 표기 변형: 가운뎃점이 있으면 ㆍ/· 두 형태를 모두 생성 (사이트 표기 불일치 대비)
function middotVariants(value) {
  const text = String(value || '');
  if (!MIDDOT_RE.test(text)) return [text];
  return [...new Set([
    text,
    text.replace(MIDDOT_RE_G, 'ㆍ'),
    text.replace(MIDDOT_RE_G, '·'),
  ])];
}

function aliasKey(value) {
  return normalizeMiddots(value).replace(/\s+/g, '');
}

function phrasePattern(value) {
  return [...aliasKey(value)].map(char => char === 'ㆍ'
    ? MIDDOT_CLASS
    : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t]*');
}

// 별칭 확장 — 정확 일치와 결합형 모두 지원 (korean-law v4.0.4 방식)
// 예: "전결규정" → "위임전결규정", "전결규정 제5조" → "위임전결규정 제5조"
function expandAliases(query) {
  const input = String(query || '').trim();
  if (!input) return [];
  const table = aliasTable();
  const out = [];
  const push = v => { const t = String(v || '').trim(); if (t && t !== input && !out.includes(t)) out.push(t); };
  const compact = aliasKey(input);
  // Protect full official names before expanding embedded shorthand. A query
  // may contain both an official name and a separate shorthand occurrence.
  const officialSpans = [];
  for (const target of new Set(Object.values(table).flat())) {
    const pattern = phrasePattern(target);
    if (!pattern) continue;
    for (const match of input.matchAll(new RegExp(pattern, 'g'))) {
      officialSpans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  for (const [alias, targets] of Object.entries(table)) {
    if (compact === aliasKey(alias)) {
      targets.forEach(push);
    } else {
      const pattern = phrasePattern(alias);
      if (!pattern) continue;
      for (const target of targets) {
        push(input.replace(new RegExp(pattern, 'g'), (match, offset) => {
          if (officialSpans.some(span => offset < span.end && offset + match.length > span.start)) return match;
          // A suffix inside another rule name is not an independently named alias.
          if (offset > 0 && /[가-힣A-Za-z0-9]/.test(input[offset - 1])) return match;
          return target;
        }));
      }
    }
  }
  return out;
}

module.exports = {
  BUILTIN_ALIASES,
  aliasTable,
  resetAliasCacheForTest,
  normalizeMiddots,
  middotVariants,
  expandAliases,
};

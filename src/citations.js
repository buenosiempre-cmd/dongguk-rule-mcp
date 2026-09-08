'use strict';

// verify_rule_citations 핵심 모듈.
// korean-law-mcp v4.9에서 실사용 제보로 확인된 함정을 반영:
//  1) 「규정명」 낫표 표기에서 추출 실패 금지 — 낫표 내부만 캡처
//  2) 가운뎃점 표기 차이(·ㆍ‧•・)로 같은 규정이 불일치로 떨어지지 않게 정규화
//  3) "같은 규정 제N조" 조응은 승계하되, 빈 줄로 문단이 바뀌면 승계하지 않음
//  4) 검색 0건은 ✗(환각)이 아니라 ⚠(규정명 확인 필요) — 검증 미가동 ≠ 통과
//  5) 유사 규정만 검색되면(포함관계 없음) 무관 규정을 근거로 판정하지 않음

const { normalizeMiddots } = require('./aliases.js');
const { listArticleBlocks } = require('./parsers.js');
const { searchVariants, selectRuleCandidate } = require('./lookup.js');

const NAME_SUFFIX = '(?:시행세칙|규정|규칙|세칙|학칙|정관|지침|내규|요령|헌장)';
const STANDALONE_NAMES = new Set(['학칙', '정관', '헌장']);
const DEMONSTRATIVES = ['같은', '해당', '당해', '아래', '우리', '이', '그', '본', '동', '위'];
const NAME_CHAR = '[가-힣A-Za-z0-9·ㆍ‧•・]';

// 제N조(의M)(제목)(제P항) — "제15조제1항", "제10조의2 (겸직)" 등 허용
const ARTICLE_RE = new RegExp(
  '(부\\s*칙\\s*)?제\\s*(\\d{1,3})\\s*조(?:\\s*의\\s*(\\d{1,2}))?' +
  '(?:\\s*\\(([^)\\n]{1,40})\\))?' +
  '(?:\\s*제\\s*(\\d{1,2})\\s*항)?',
  'g'
);

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
    `(?<![가-힣])(${DEMONSTRATIVES.join('|')})\\s*(규정|규칙|학칙|정관|지침|내규|세칙)` +
    `(\\s*(?:의\\s*)?시행세칙)?(?![가-힣])`, 'g'
  );
  while ((m = anaph.exec(segment)) !== null) {
    if (overlaps(spans, m.index, anaph.lastIndex)) continue;
    mentions.push({
      start: m.index, end: anaph.lastIndex,
      kind: 'anaphora',
      raw: m[0].trim(),
      suffixWord: m[2],
      enforcement: !!m[3],
    });
    spans.push({ start: m.index, end: anaph.lastIndex });
  }

  // 3) 무낫표: 접미사로 끝나는 명칭 토큰
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
  for (const mention of mentions) {
    if (mention.kind !== 'anaphora') {
      mention.resolved = mention.name;
      lastConcrete = mention.name;
      continue;
    }
    if (!lastConcrete) {
      mention.resolved = null; // 선행 규정명 없음 → 규정명 불명확
      continue;
    }
    mention.resolved = mention.enforcement
      ? `${lastConcrete} 시행세칙`.replace(/시행세칙\s*시행세칙$/, '시행세칙')
      : lastConcrete;
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
  for (const part of source.split(/\n\s*\n/)) {
    segments.push({ text: part, offset });
    offset += part.length + 2; // 대략적 오프셋(보고용)
  }

  const citations = [];
  const floating = [];
  const seen = new Set();
  const mentionsAll = [];

  for (const segment of segments) {
    const mentions = resolveMentionNames(scanMentions(segment.text));
    mentionsAll.push(...mentions.map(x => ({ ...x, offset: segment.offset })));
    const bound = new Set();

    ARTICLE_RE.lastIndex = 0;
    let m;
    while ((m = ARTICLE_RE.exec(segment.text)) !== null) {
      const supplementary = !!m[1];
      const number = parseInt(m[2], 10);
      const subNumber = m[3] ? parseInt(m[3], 10) : null;
      const rawParen = m[4] ? m[4].trim() : null;
      const citedTitle = rawParen && !isAnnotationParen(rawParen) ? rawParen : null;
      const hang = m[5] ? parseInt(m[5], 10) : null;
      if (!number) continue;
      const canonical = `${supplementary ? '부칙 ' : ''}제${number}조${subNumber ? `의${subNumber}` : ''}`;
      const raw = m[0].replace(/\s+/g, ' ').trim();

      // 같은 문단에서 이 조문 앞에 있는 가장 가까운 멘션에 결속
      const owner = [...mentions].reverse().find(x => x.end <= m.index);
      if (!owner || !owner.resolved) {
        floating.push({
          raw, canonical,
          reason: owner && !owner.resolved
            ? `조응(${owner.raw}) 선행 규정명 없음`
            : '같은 문단에 규정명 없음',
        });
        continue;
      }
      owner.boundCount = (owner.boundCount || 0) + 1;
      bound.add(owner);

      const key = [nkey(owner.resolved), canonical, hang || 0, citedTitle || ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({
        raw: `${owner.kind === 'anaphora' ? owner.raw : owner.resolved} ${raw}`,
        ruleName: owner.resolved,
        anaphora: owner.kind === 'anaphora',
        article: { number, subNumber, supplementary, canonical },
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
        raw: `「${mention.name}」`,
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
async function resolveRule(name, deps) {
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
  if (!rec || rec.status === 'skipped') {
    return { status: 'RULE_SKIPPED', symbol: '⚠', note: '규정 수 상한 초과로 이번 호출에서는 검증 생략' };
  }
  if (rec.status === 'miss') {
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

  const { number, subNumber, supplementary, canonical } = citation.article;
  if (!rec.blocks.length) {
    return { status: 'RULE_CONTENT_UNAVAILABLE', symbol: '⚠', note: '조문 구조를 확인할 수 없어 미존재 판정 불가 — 공식 원문 확인 필요' };
  }
  let matches = rec.blocks.filter(b => b.number === number && b.subNumber === subNumber);
  matches = supplementary
    ? matches.filter(b => b.supplementary)
    : (matches.some(b => !b.supplementary) ? matches.filter(b => !b.supplementary) : []);
  const block = matches[0];

  if (matches.length > 1) {
    return { status: 'ARTICLE_AMBIGUOUS', symbol: '⚠', note: `${canonical}가 ${matches.length}개 존재 — 부칙의 개정일·원문 위치를 특정한 뒤 확인 필요` };
  }

  if (!block) {
    const rangeNote = supplementary
      ? '부칙에 해당 조문 없음'
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
    ruleCache.set(key, await resolveRule(displayName, deps));
  }

  const results = citations.map(citation => {
    const key = nkey(citation.ruleName);
    const rec = ruleCache.has(key) ? ruleCache.get(key) : { status: 'skipped' };
    const verdict = judgeCitation(citation, rec);
    return {
      raw: citation.raw,
      ruleName: citation.ruleName,
      article: citation.article ? citation.article.canonical : null,
      hang: citation.hang,
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
    verified: results.filter(r => r.symbol === '✓').length,
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

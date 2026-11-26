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



const RULE_VOCABULARY = Object.freeze({
  해외출장: ['국외출장', '국외여비', '국외 출장', '국외'], 해외여비: ['국외여비', '국외'], 해외: ['국외'],
  국내출장: ['국내출장', '국내여비', '국내 출장', '출장'], 출장비: ['여비', '출장'], 여비: ['출장비'], 출장: ['여비'],
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
  법카: ['법인카드'], 법인카드: ['법카'], 지급일: ['지급기일'], 매달: ['매월'],
  선물: ['금품등', '금품'], 자가용: ['자동차운임', '운임'], 교통비: ['운임', '교통비'],
  불용처리: ['불용결정', '불용품', '불용'],
  고장: ['훼손'], 성적장학금: ['장학', '성적'],
  동시: ['이중수혜', '중복수혜'], 자주: ['주기'],
  나눠서: ['분할납부', '분할'], 나누어: ['분할납부', '분할'],
  잃어버리: ['분실'], 분실: ['도난'],
  산단: ['산학협력단'],
});
// Shared business vocabulary only; no question-to-rule IDs or answer mappings.
function businessTerms(term) {
  // Normalize common inflected verbs before looking up the business noun.
  const stem = /^잃어버(?:리|렸|린|려)/.test(term) ? '잃어버리'
    : /^고장(?:난|나|났)/.test(term) ? '고장'
    : /^출장(?:가|갈|갔)/.test(term) ? '출장' : term;
  return [...new Set([term, stem, ...(Object.hasOwn(RULE_VOCABULARY, stem) ? RULE_VOCABULARY[stem] : [])])];
}
// Comparison topics are rule names; do not expand general article vocabulary there.
function comparisonTerms(term) {
  return ['강사료','강의료','출장비','여비','법카','법인카드','클린카드'].includes(term)
    ? businessTerms(term) : [term];
}
function questionScope(query) {
  const text=String(query || '').replace(/\s+/g,'');
  return {
    wise: /WISE|경주|와이즈/i.test(text),
    industry: /산학협력단|산단/.test(text),
    medical: /의학|의대|의전원|병원/.test(text),
    graduate: /대학원|원생|석사|박사|논문|학위청구|의전원/.test(text),
  };
}
function generalRuleWeight(title, query, hasGeneralEdition = false) {
  const t=String(title).replace(/\s+/g,''), q=String(query).replace(/\s+/g,'');
  if(q.includes(t))return 1;
  const scope=questionScope(query);
  let weight=1;
  // A campus-only subject must remain discoverable when no general edition exists.
  if(hasGeneralEdition){
    if(/WISE|경주캠퍼스/i.test(t)&&!scope.wise)weight*=0.65;
    if(/산학협력단/.test(t)&&!scope.industry)weight*=0.65;
    if(/의학계열|의학전문/.test(t)&&!scope.medical)weight*=0.75;
  }
  if(/대학원/.test(t)&&!scope.graduate)weight*=0.60;
  // Prefer broad rules modestly, without enumerating benchmark answer titles.
  if(/(?:학칙|규정)$/.test(t)&&!/(?:시행세칙|내규|연구소|센터|위원회|심의회|대학원|회칙)/.test(t))weight*=1.15;
  const unit=t.match(/^(.+?(?:연구소|센터|위원회|심의회|학생회))/)?.[1];
  if(unit&&!q.includes(unit))weight*=0.75;
  return weight;
}

module.exports = {
  RULE_VOCABULARY, businessTerms, comparisonTerms, questionScope, generalRuleWeight,
  BUILTIN_ALIASES,
  aliasTable,
  resetAliasCacheForTest,
  normalizeMiddots,
  middotVariants,
  expandAliases,
};

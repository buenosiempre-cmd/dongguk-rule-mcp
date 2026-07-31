'use strict';

// 개정일 기준 시점 판단. rule.dongguk.edu 연혁은 '개정일'만 제공하므로
// 실제 시행일(부칙)과 다를 수 있음 — 도구 출력에 항상 아래 주의문을 동봉한다.
const TIMELINE_CAVEAT =
  '⚠ 판단 기준은 연혁의 개정일입니다. 각 개정본의 실제 시행일은 부칙에 따라 개정일과 다를 수 있으니, ' +
  '소급적용·경과조치가 걸린 사안은 해당 개정본 부칙을 함께 확인하세요.';

// 'YYYY-MM-DD' | 'YYYY.MM.DD' | 'YYYY/MM/DD' | 'YYYYMMDD' | 'YYYY년 M월 D일' 허용
function parseDateLoose(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const m =
    /^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?\s*\.?$/.exec(text) ||
    /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ts = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  // 2월 30일 같은 존재하지 않는 날짜 방어
  const roundTrip = new Date(ts);
  if (roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() + 1 !== mo || roundTrip.getUTCDate() !== d) return null;
  return { iso, ts };
}

// entries: parseHistory 결과 [{historyId, revisedAt}]
// 반환: { targetIso, entry, next, latest, laterCount, isLatest, undatedCount } 또는 { error }
function resolveHistoryAtDate(entries, dateInput) {
  const target = parseDateLoose(dateInput);
  if (!target) return { error: 'INVALID_DATE' };

  const dated = [];
  let undatedCount = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const parsed = parseDateLoose(e && e.revisedAt);
    if (parsed) dated.push({ historyId: e.historyId, revisedAt: e.revisedAt, _ts: parsed.ts, _iso: parsed.iso });
    else undatedCount++;
  }
  if (!dated.length) return { error: 'NO_DATED_HISTORY', targetIso: target.iso, undatedCount };

  dated.sort((a, b) => b._ts - a._ts); // 최신순
  const applicable = dated.filter(e => e._ts <= target.ts);
  if (!applicable.length) {
    return {
      error: 'BEFORE_FIRST',
      targetIso: target.iso,
      earliest: dated[dated.length - 1],
      undatedCount,
    };
  }
  const entry = applicable[0];                       // 기준일 이전(포함) 마지막 개정본 = 적용본
  const laterOnes = dated.filter(e => e._ts > target.ts); // 최신순 정렬 유지
  const next = laterOnes.length ? laterOnes[laterOnes.length - 1] : null; // 기준일 이후 '첫' 개정
  return {
    targetIso: target.iso,
    entry,
    previous: applicable[1] || null, // 적용본 직전 개정본 — 부칙 시행일이 기준일 이후일 때 대안 후보
    next,
    latest: dated[0],
    laterCount: laterOnes.length,
    isLatest: entry.historyId === dated[0].historyId,
    undatedCount,
  };
}

// 본문(주로 부칙)에서 명시 시행일 문장을 추출 — 'YYYY년 M월 D일부터 시행' 계열만.
// '공포한 날부터 시행'처럼 날짜가 없는 문구는 추출하지 않는다. 오름차순 정렬 반환.
function extractEnforcementDates(markdown) {
  const source = String(markdown || '');
  const re = /(\d{4})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})\s*일?\s*\.?\s*부터\s*시행/g;
  const found = new Map();
  let m;
  while ((m = re.exec(source)) !== null) {
    const parsed = parseDateLoose(`${m[1]}-${m[2]}-${m[3]}`);
    if (parsed && !found.has(parsed.iso)) {
      found.set(parsed.iso, { iso: parsed.iso, ts: parsed.ts, raw: m[0].replace(/\s+/g, ' ') });
    }
  }
  return [...found.values()].sort((a, b) => a.ts - b.ts);
}

module.exports = { TIMELINE_CAVEAT, parseDateLoose, resolveHistoryAtDate, extractEnforcementDates };

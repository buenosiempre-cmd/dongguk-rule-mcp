'use strict';

// The official title search with a blank keyword returns every current rule in
// one response (515 rules, verified 2026-11-11). Each row carries the latest
// HISTORY_ID and revision date, so revision checks need no per-rule request.
const CATALOG_PAGE_SIZE = 2000;
const MIN_CATALOG_RULES = 100;

function validateCatalog(result) {
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  const total = Number(result?.total) || 0;
  // A short or truncated list must never be read as "these rules were abolished".
  if (hits.length < MIN_CATALOG_RULES || hits.length < total) {
    throw new Error(`규정 목록 응답 형식이 예상과 다릅니다(목록 ${hits.length}건, 원문 집계 ${total}건).`);
  }
  return hits.map(hit => ({
    lawId: hit.lawId, historyId: hit.historyId, title: hit.title, code: hit.code || '', revisedAt: hit.revisedAt || '',
  }));
}

function isoDate(value) {
  const match = /(\d{4})\s*[.\-/년]?\s*(\d{1,2})\s*[.\-/월]?\s*(\d{1,2})/.exec(String(value || ''));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

// previous: { [lawId]: historyId } returned as nextSnapshot by an earlier call.
function checkRuleUpdates({ catalog, lawIds = [], previous = {}, since = null, limit = 50 }) {
  const byId = new Map(catalog.map(rule => [rule.lawId, rule]));
  const ids = [...new Set(lawIds)];
  const results = ids.map(lawId => {
    const rule = byId.get(lawId);
    const previousHistoryId = Number(previous[lawId]) || null;
    if (!rule) {
      return { lawId, title: null, previousHistoryId, currentHistoryId: null, revisedAt: null, status: 'unknown', errorCode: 'NOT_IN_CURRENT_CATALOG' };
    }
    const status = !previousHistoryId ? 'first_seen' : previousHistoryId === rule.historyId ? 'unchanged' : 'changed';
    return { lawId, title: rule.title, code: rule.code, previousHistoryId, currentHistoryId: rule.historyId, revisedAt: rule.revisedAt, status };
  });

  // A failed item keeps its earlier snapshot value instead of being dropped.
  const nextSnapshot = {};
  for (const item of results) {
    const value = item.currentHistoryId || item.previousHistoryId;
    if (value) nextSnapshot[item.lawId] = value;
  }

  let recent = null;
  if (since) {
    const all = catalog
      .map(rule => ({ ...rule, revisedDate: isoDate(rule.revisedAt) }))
      .filter(rule => rule.revisedDate && rule.revisedDate >= since)
      .sort((a, b) => b.revisedDate.localeCompare(a.revisedDate) || a.lawId - b.lawId);
    recent = {
      since,
      total: all.length,
      truncated: all.length > limit,
      rules: all.slice(0, limit).map(({ revisedDate, ...rule }) => ({ ...rule, revisedDate })),
      undatedRules: catalog.filter(rule => !isoDate(rule.revisedAt)).length,
    };
  }

  return {
    results,
    nextSnapshot,
    recent,
    coverage: {
      requested: ids.length,
      checked: results.filter(item => item.status !== 'unknown').length,
      failed: results.filter(item => item.status === 'unknown').length,
      catalogRules: catalog.length,
    },
  };
}

function formatRuleUpdates(data) {
  const label = { changed: '개정됨', unchanged: '변동 없음', first_seen: '첫 확인', unknown: '확인 불가' };
  const lines = ['## 규정 개정 여부 점검', `- 확인 시각: ${data.checkedAt}`, `- 현행 규정 목록: ${data.coverage.catalogRules}건`];
  if (data.results.length) {
    lines.push('', '| 규정 | LAW_ID | 상태 | 이전 HISTORY_ID | 현재 HISTORY_ID | 개정일 |', '|---|---|---|---|---|---|');
    for (const item of data.results) {
      lines.push(`| ${item.title || '(현행 목록에 없음)'} | ${item.lawId} | ${label[item.status]} | ${item.previousHistoryId || '-'} | ${item.currentHistoryId || '-'} | ${item.revisedAt || '-'} |`);
    }
    const changed = data.results.filter(item => item.status === 'changed');
    if (changed.length) {
      lines.push('', '개정된 규정의 변경 내용은 `compare_rule_versions`로 확인하세요:');
      for (const item of changed) lines.push(`- ${item.title}: law_id=${item.lawId}, from_history_id=${item.previousHistoryId}, to_history_id=${item.currentHistoryId}`);
    }
    if (data.coverage.failed) lines.push('', '현행 목록에 없는 LAW_ID는 폐지·통합되었거나 번호가 잘못되었을 수 있습니다. 이전 스냅샷 값은 유지했습니다.');
  }
  if (data.recent) {
    lines.push('', `### ${data.recent.since} 이후 개정된 규정 (${data.recent.total}건${data.recent.truncated ? `, 상위 ${data.recent.rules.length}건 표시` : ''})`);
    if (data.recent.rules.length) {
      lines.push('', '| 개정일 | 규정 | LAW_ID | HISTORY_ID |', '|---|---|---|---|');
      for (const rule of data.recent.rules) lines.push(`| ${rule.revisedAt} | ${rule.title} | ${rule.lawId} | ${rule.historyId} |`);
    } else lines.push('', '해당 기간에 개정일이 있는 규정이 없습니다.');
  }
  lines.push('', '`변동 없음`은 최신 HISTORY_ID가 같다는 뜻입니다. 시행일·경과조치·업무 적용 여부는 부칙과 적용범위에서 확인하세요.');
  return lines.join('\n');
}

module.exports = { CATALOG_PAGE_SIZE, validateCatalog, isoDate, checkRuleUpdates, formatRuleUpdates };

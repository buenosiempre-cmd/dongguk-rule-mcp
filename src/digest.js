'use strict';

// Digest of rules revised since a date, with the articles that changed.
// `call(name, args)` runs one MCP tool and returns its structured content.
const FULLVIEW_URL = 'https://rule.dongguk.edu/lmxsrv/law/lawFullView.srv';
const MAX_DETAILED_RULES = 15;
const MAX_ARTICLES_SHOWN = 8;

function sinceDate(days, now = new Date()) {
  const today = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function summarizeChanges(changes) {
  const groups = { changed: [], added: [], removed: [] };
  for (const change of changes || []) if (groups[change.status]) groups[change.status].push(change.key);
  return groups;
}

async function buildDigest(call, { since, maxDetailedRules = MAX_DETAILED_RULES } = {}) {
  const updates = await call('check_rule_updates', { since, limit: 50 });
  if (!updates?.ok) throw Object.assign(new Error('규정 목록을 확인하지 못했습니다.'), { code: updates?.error?.code || 'CATALOG_UNAVAILABLE' });
  const recent = updates.data.recent;
  const rules = [];
  for (const [index, rule] of recent.rules.entries()) {
    const entry = {
      lawId: rule.lawId, historyId: rule.historyId, title: rule.title, revisedAt: rule.revisedAt,
      url: `${FULLVIEW_URL}?SEQ=${rule.lawId}&SEQ_HISTORY=${rule.historyId}`,
      previousHistoryId: null, previousRevisedAt: null, changes: null, detail: 'not_compared',
    };
    rules.push(entry);
    if (index >= maxDetailedRules) { entry.detail = 'limit'; continue; }
    try {
      const history = await call('list_rule_history', { law_id: rule.lawId });
      const versions = history?.data?.history || [];
      const position = versions.findIndex(version => version.historyId === rule.historyId);
      const previous = position >= 0 ? versions[position + 1] : null;
      if (!previous) { entry.detail = position === versions.length - 1 && versions.length === 1 ? 'new_rule' : 'no_previous_version'; continue; }
      entry.previousHistoryId = previous.historyId;
      entry.previousRevisedAt = previous.revisedAt || null;
      const compared = await call('compare_rule_versions', {
        law_id: rule.lawId, from_history_id: previous.historyId, to_history_id: rule.historyId, include_appendices: false, max_changes: 50,
      });
      if (!compared?.ok) { entry.detail = 'compare_failed'; continue; }
      entry.changes = summarizeChanges(compared.data.changes);
      entry.counts = compared.data.counts;
      entry.detail = compared.data.changesTruncated ? 'compared_truncated' : 'compared';
    } catch { entry.detail = 'compare_failed'; }
  }
  return {
    since, checkedAt: updates.data.checkedAt, catalogRules: updates.data.coverage.catalogRules,
    total: recent.total, truncated: recent.truncated, undatedRules: recent.undatedRules, rules,
  };
}

function changeText(entry) {
  if (entry.detail === 'new_rule') return '신규 제정(이전 개정본 없음)';
  if (!entry.changes) return '변경 조문은 확인하지 못했습니다';
  const part = (label, keys) => keys.length
    ? `${label} ${keys.slice(0, MAX_ARTICLES_SHOWN).join(', ')}${keys.length > MAX_ARTICLES_SHOWN ? ` 외 ${keys.length - MAX_ARTICLES_SHOWN}개` : ''}` : '';
  // Every revision adds its own 부칙; listing it would hide the articles that matter.
  const body = keys => keys.filter(key => !/^부칙/.test(key));
  const parts = [part('변경', body(entry.changes.changed)), part('신설', body(entry.changes.added)), part('삭제', body(entry.changes.removed))].filter(Boolean);
  return parts.length ? parts.join(' / ') : '본칙 조문 변경 없음(별표·서식·부칙만 바뀌었을 수 있음)';
}

const NOTE = '공식 규정 사이트의 개정일 기준이며 시행일과 다를 수 있습니다. 변경 조문은 본문 비교 결과이고 별표·서식은 포함하지 않습니다.';

function formatDigest(digest, format = 'markdown') {
  const slack = format === 'slack';
  const bold = text => slack ? `*${text}*` : `**${text}**`;
  const link = (text, url) => slack ? `<${url}|${text.replace(/[<>|]/g, ' ')}>` : `[${text}](${url})`;
  const lines = [bold(`동국대 규정 개정 알림 (${digest.since} 이후)`)];
  if (!digest.rules.length) lines.push('', '이 기간에 개정된 규정이 없습니다.');
  else {
    lines.push('', `개정된 규정 ${digest.total}건${digest.truncated ? ` (최근 ${digest.rules.length}건 표시)` : ''}`, '');
    for (const entry of digest.rules) lines.push(`• ${link(entry.title, entry.url)} — 개정 ${entry.revisedAt} · ${changeText(entry)}`);
  }
  lines.push('', slack ? `_${NOTE}_` : NOTE);
  return lines.join('\n');
}

module.exports = { sinceDate, summarizeChanges, buildDigest, formatDigest, changeText, MAX_DETAILED_RULES };

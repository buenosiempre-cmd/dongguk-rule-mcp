'use strict';

// Keep source identity and partial failures visible in clients that hide
// structuredContent. Never convert a missing body into a legal conclusion.
function formatLegalEvidence(legal) {
  if (!legal || ['not_requested', 'not_required'].includes(legal.status)) return '';
  const parts = ['## 법령 근거', `조회상태: ${legal.status || '확인 필요'}${legal.code ? ` (${legal.code})` : ''}`];
  if (legal.baseDate) parts.push(`요청 기준일: ${legal.baseDate}`);
  if (legal.scope) parts.push(legal.scope);
  const results = Array.isArray(legal.results) ? legal.results : [];
  if (!results.length) parts.push('법령 본문을 확보하지 못했습니다. 교내 규정 조회만으로 법령 검토가 완료된 것은 아닙니다.');
  for (const result of results) {
    parts.push(`### ${result.request?.law_name || result.law?.name || '법령명 확인 필요'} ${[result.request?.article, result.request?.annex].filter(Boolean).join(' · ')}\n조회상태: ${result.status || '확인 필요'}${result.code ? ` (${result.code})` : ''}`);
    const targets = [...(result.articles || []), ...(result.annexes || [])];
    if (!targets.length) parts.push('요청한 법령 본문을 확보하지 못했습니다.');
    for (const target of targets) {
      const source = target.source || {};
      parts.push([
        `${target.selector || '본문'}: ${target.status || '확인 필요'}${target.code ? ` (${target.code})` : ''}`,
        `법령 ID / MST: ${source.lawId || result.law?.lawId || '미확인'} / ${source.mst || '미확인'}`,
        `시행일: ${source.effectiveAt || '미확인'} / 요청 기준일: ${source.baseDate || legal.baseDate || '미확인'}`,
        target.dateStatus ? `시점 확인: ${target.dateStatus}` : '',
        source.retrievedAt ? `조회일: ${source.retrievedAt}` : '',
        target.referenceOnly ? '참고용: 요청한 기준일의 적용 근거로 확정하지 마세요.' : '',
        target.truncated ? '본문 일부 잘림: 전체 원문을 확인하세요.' : '',
        source.url ? `원문: ${source.url}` : '',
        target.text || '본문을 확보하지 못했습니다.',
      ].filter(Boolean).join('\n'));
    }
  }
  return parts.join('\n\n');
}

module.exports = { formatLegalEvidence };

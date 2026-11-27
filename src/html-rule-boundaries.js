'use strict';
const { isAppendixHeading } = require('./cau-pdf');

const BOUNDARY_NOTICE = '조문 경계 확인 필요: 번호 순서·부속 표제만으로 조문과 참조를 확정할 수 없어 기존 파싱 결과를 유지했습니다. 조문 번호·본문 귀속·별표 여부는 원문에서 확인하세요.';

// Inspection only. A sequence such as 1,9,3 admits both 1,9 and 1,3 as
// ordered chains. It cannot justify rewriting the document or dropping text.
// Keep the main parser's result; do not guess from particles/demonstratives.
function inspectArticleStructure(markdown) {
  const reasons = new Set();
  let previous = null, supplementary = false;
  for (const line of String(markdown || '').split('\n')) {
    if (/^##\s+부\s*칙/.test(line)) supplementary = true;
    if (isAppendixHeading(line.trim())) reasons.add('appendix_boundary');
    if (supplementary) continue;
    const m = /^###\s+제\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?=[(（\s]|$)/.exec(line);
    if (!m) continue;
    const current = { number: Number(m[1]), branch: Number(m[2] || 0) };
    if (!previous) {
      if (current.number !== 1 || current.branch !== 0) reasons.add('partial_number_sequence');
    } else {
      const nextArticle = current.number === previous.number + 1 && current.branch === 0;
      const nextBranch = current.number === previous.number && (
        current.branch === previous.branch + 1 || (previous.branch === 0 && current.branch === 2));
      if (!nextArticle && !nextBranch) reasons.add('nonconsecutive_number_sequence');
    }
    previous = current;
  }
  return { required: reasons.size > 0, reasons: [...reasons], ...(reasons.size ? { notice: BOUNDARY_NOTICE } : {}) };
}

module.exports = { inspectArticleStructure, BOUNDARY_NOTICE };

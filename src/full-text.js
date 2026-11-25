'use strict';

const { createHash } = require('node:crypto');
const { success, failure } = require('./protocol');
const DEFAULT_MAX_CHARS = 30000;
const MAX_CHARS = 60000;
const SOURCE_URL = 'https://rule.dongguk.edu/lmxsrv/law/lawFullView.srv';
const invalid = message => failure('INVALID_ARGUMENT', message);
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function decode(cursor) {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1000}$/.test(cursor)) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value?.v !== 1 || !Number.isSafeInteger(value.lawId) || value.lawId < 1 ||
        !Number.isSafeInteger(value.historyId) || value.historyId < 1 ||
        !Number.isSafeInteger(value.offset) || value.offset < 1 ||
        !['hwp', 'html'].includes(value.sourceType) || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
    return value;
  } catch { return null; }
}

// Dependencies retain the server's profile-isolated cache and history validation.
async function getRuleFullText(args, { resolve, loadOriginal, loadHtml }) {
  const lawId = Number(args.law_id);
  if (!Number.isSafeInteger(lawId) || lawId < 1) return invalid('law_id는 양의 정수여야 합니다.');
  const maxChars = args.max_chars === undefined ? DEFAULT_MAX_CHARS : args.max_chars;
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > MAX_CHARS) return invalid(`max_chars는 1000~${MAX_CHARS} 범위 정수여야 합니다.`);
  const cursor = args.cursor === undefined ? null : decode(args.cursor);
  if (args.cursor !== undefined && !cursor) return invalid('유효하지 않은 cursor입니다. 첫 페이지부터 다시 조회하세요.');
  if (cursor && (cursor.lawId !== lawId || (args.history_id !== undefined && Number(args.history_id) !== cursor.historyId))) {
    return invalid('cursor의 LAW_ID·HISTORY_ID와 요청이 다릅니다.');
  }
  const resolved = await resolve(lawId, cursor?.historyId ?? args.history_id);
  const historyId = resolved.historyId;
  let original = null, markdown, sourceType = 'hwp';
  const sourceReasons = [];
  // A continuation keeps the source of its first page, even if HWP recovers later.
  try {
    if (cursor?.sourceType === 'html') throw new Error('HTML continuation');
    original = await loadOriginal(lawId, historyId);
    if (typeof original?.markdown !== 'string' || !original.markdown.trim()) throw new Error('Empty HWP text');
    markdown = original.markdown;
  } catch {
    const html = await loadHtml(lawId, historyId);
    markdown = html?.markdown;
    original = null;
    sourceType = 'html';
    sourceReasons.push('HWP_FALLBACK');
  }
  if (typeof markdown !== 'string' || !markdown.trim()) return failure('CONTENT_UNAVAILABLE', 'HWP와 HTML에서 규정 본문을 확보하지 못했습니다.');
  const coverage = original?.structure?.coverage || null;
  if (sourceType === 'hwp') {
    if (!coverage || coverage.rawAudit !== 'checked') sourceReasons.push('HWP_COVERAGE_UNVERIFIED');
    if (coverage && (coverage.status !== 'covered' || coverage.diagnosticsTotal > 0 || coverage.diagnostics?.length > 0)) sourceReasons.push('HWP_STRUCTURE_PARTIAL');
    // The HWP parser renders pictures as hashes, not their text or original pixels.
    if (coverage?.counts?.images > 0 || original.structure?.images?.length > 0 || /\[그림(?: SHA-256|:)/.test(markdown)) sourceReasons.push('IMAGE_TEXT_UNAVAILABLE');
  }
  const sha256 = hash(markdown);
  if (cursor && (cursor.sha256 !== sha256 || cursor.sourceType !== sourceType)) {
    return failure('FULL_TEXT_CHANGED', '이어받기 중 원문 또는 추출 출처가 바뀌었습니다. 기존 페이지와 합치지 말고 cursor 없이 다시 조회하세요.');
  }
  const start = cursor?.offset || 0;
  if (start >= markdown.length || (start > 0 && /[\uD800-\uDBFF]/.test(markdown[start - 1]) && /[\uDC00-\uDFFF]/.test(markdown[start]))) return invalid('cursor의 시작 위치가 유효하지 않습니다.');
  let end = Math.min(start + maxChars, markdown.length);
  // Do not split an astral character between two responses (offsets are UTF-16).
  if (end < markdown.length && /[\uD800-\uDBFF]/.test(markdown[end - 1]) && /[\uDC00-\uDFFF]/.test(markdown[end])) end--;
  const hasMore = end < markdown.length;
  const paginated = start > 0 || hasMore;
  const nextCursor = hasMore ? encode({ v: 1, lawId, historyId, sourceType, sha256, offset: end }) : null;
  const nextArguments = nextCursor ? { law_id: lawId, history_id: historyId, max_chars: maxChars, cursor: nextCursor } : null;
  const incompleteReasons = [...sourceReasons, ...(paginated ? ['FULL_TEXT_PAGINATED'] : [])];
  const sourceUrl = `${SOURCE_URL}?SEQ=${lawId}&SEQ_HISTORY=${historyId}`;
  const data = {
    lawId, historyId, revisedAt: resolved.revisedAt || '',
    sourceType: sourceType === 'hwp' ? '원문 HWP(별표 포함)' : 'HTML 본문',
    sourceUrl, returnedAt: new Date().toISOString(),
    evidenceStatus: incompleteReasons.length ? 'partial' : 'retrieved', incompleteReasons,
    sourceEvidenceStatus: sourceReasons.length ? 'partial' : 'retrieved',
    originalCoverage: coverage,
    applicability: 'requires_enforcement_review',
    contentMarkdown: markdown.slice(start, end),
    textCoverage: {
      status: paginated ? 'partial' : 'complete', unit: 'utf16',
      offset: start, endOffset: end, returnedChars: end - start, totalChars: markdown.length,
      truncated: hasMore, hasMore, sha256, nextCursor, nextArguments,
    },
  };
  const notice = [
    `LAW_ID ${lawId} / HISTORY_ID ${historyId} / 개정일 ${data.revisedAt || '미확인'}`,
    `출처: ${data.sourceType} — ${sourceUrl}`,
    `근거 상태: ${data.evidenceStatus}${incompleteReasons.length ? ` (${incompleteReasons.join(', ')})` : ''}`,
    `전문 전달 범위: ${start}~${end}/${markdown.length} UTF-16 코드 단위 (끝 위치 제외)`,
    '추출된 텍스트 전문입니다. OCR·원본 화면 배치·법적 적용성은 보증하지 않습니다. 표·줄 중간에서 페이지가 나뉠 수 있습니다.',
    ...(sourceType === 'html' ? ['HWP를 확보하지 못해 HTML 본문을 반환합니다. 별표·서식이 빠질 수 있습니다.'] : []),
    ...(coverage?.diagnostics?.length ? [`원문 추출 진단: ${[...new Set(coverage.diagnostics.map(d => d.code))].join(', ')} (상세: originalCoverage.diagnostics)`] : []),
    ...(sourceReasons.includes('IMAGE_TEXT_UNAVAILABLE') ? ['그림은 해시·표지만 반환하며 그림 속 문구는 원문에서 확인해야 합니다.'] : []),
    ...(hasMore ? [`잘림 있음. get_rule_full_text에 다음 인수를 그대로 전달하세요:\n${JSON.stringify(nextArguments)}`] : [start ? '마지막 페이지입니다. 앞 페이지들과 contentMarkdown을 순서대로 이어 붙이세요.' : '추출된 전문을 한 번에 반환했습니다.']),
    ...(paginated ? ['모든 페이지의 contentMarkdown만 이어 붙이면 추출 전문이 됩니다. sourceEvidenceStatus가 partial이면 이어받기를 마쳐도 원문 누락 한계는 남습니다.'] : []),
  ];
  return success(`${notice.join('\n')}\n\n${data.contentMarkdown}`, data);
}

module.exports = { getRuleFullText, DEFAULT_MAX_CHARS, MAX_CHARS };

'use strict';

const fs = require('fs');
const REVIEW_STATUS = 'manual_reference_unverified_current_ui';
const MAX_BYTES = 4 * 1024 * 1024;
const EVIDENCE_TYPES = ['세금계산서', '법인카드', '현금영수증'];
const REQUIRED = [
  ['purpose', '지출 목적'], ['payment_route', '지급 경로'],
  ['payment_status', '지급 상태'], ['evidence_type', '증빙 종류'],
  ['evidence_status', '증빙 접수 또는 사용내역 확인 상태'], ['campus', '캠퍼스'],
];
const UNKNOWN = /^(?:미상|모름|unknown|미확인|확인필요)$/i;
const BASE_NOTES = [
  '외부 매뉴얼의 참고 후보입니다. 현재 nDRIMS 화면과 실제 처리 결과는 검증하지 않았습니다.',
  '증빙 내역 연결과 파일 첨부를 구분합니다. 이 자료만으로 별도 첨부의 필요 여부·종류를 확정하지 않습니다.',
];
const plainObject = v => v && typeof v === 'object' && !Array.isArray(v);
const boundedText = (v, max = 500) => typeof v === 'string' && v.length > 0 && v.length <= max;

function validatePracticePack(pack) {
  if (!plainObject(pack) || pack.schema_version !== 1 || !boundedText(pack.version, 80) ||
      !Array.isArray(pack.sources) || !pack.sources.length || pack.sources.length > 32 ||
      !Array.isArray(pack.entries) || !pack.entries.length || pack.entries.length > 100) {
    throw new Error('PRACTICE_PACK_INVALID');
  }
  const sources = new Map();
  for (const source of pack.sources) {
    if (!plainObject(source) || !boundedText(source.id, 80) || sources.has(source.id) ||
        !boundedText(source.title) || !boundedText(source.source_url, 2000) ||
        !/^https:\/\//.test(source.source_url) ||
        !/^[a-f0-9]{64}$/.test(source.source_sha256 || '') ||
        !/^[a-f0-9]{64}$/.test(source.markdown_sha256 || '') ||
        !Number.isInteger(source.line_count) || source.line_count < 1) {
      throw new Error('PRACTICE_PACK_INVALID');
    }
    sources.set(source.id, source);
  }
  const ids = new Set();
  const types = new Set();
  for (const entry of pack.entries) {
    if (!plainObject(entry) || !boundedText(entry.id, 80) || ids.has(entry.id) ||
        !EVIDENCE_TYPES.includes(entry.evidence_type) || types.has(entry.evidence_type) ||
        !boundedText(entry.tab, 80) || entry.review_status !== REVIEW_STATUS ||
        !Array.isArray(entry.steps) || !entry.steps.length || entry.steps.length > 12) {
      throw new Error('PRACTICE_PACK_INVALID');
    }
    ids.add(entry.id); types.add(entry.evidence_type);
    for (const step of entry.steps) {
      const ref = step && step.reference;
      const source = ref && sources.get(ref.source_id);
      if (!plainObject(step) || !boundedText(step.kind, 80) || !source ||
          !Number.isInteger(ref.line_start) || !Number.isInteger(ref.line_end) ||
          ref.line_start < 1 || ref.line_end < ref.line_start || ref.line_end > source.line_count ||
          ref.line_basis !== 'markdown' || !boundedText(ref.excerpt, 8000)) {
        throw new Error('PRACTICE_PACK_INVALID');
      }
    }
  }
  return pack;
}

function loadPracticePack(file = process.env.DONGGUK_PRACTICE_PACK_PATH) {
  if (!file) return null;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('PRACTICE_PACK_INVALID');
  return validatePracticePack(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function selectPractice(facts = {}, suppliedPack) {
  const result = (status, missing = [], notes = []) => ({
    status, candidates: [], missing_facts: missing, source_notes: [...BASE_NOTES, ...notes],
  });
  if (!plainObject(facts) || Object.keys(facts).length > 40 ||
      Object.values(facts).some(v => v != null && (typeof v !== 'string' || v.length > 200))) {
    return result('invalid_facts');
  }
  let pack;
  try {
    pack = suppliedPack === undefined ? loadPracticePack() : suppliedPack;
    if (pack) validatePracticePack(pack);
  } catch (_) { return result('invalid_pack'); }
  if (!pack) return result('not_configured');

  const value = key => (facts[key] || '').trim();
  const missing = REQUIRED.filter(([key]) => !value(key) || UNKNOWN.test(value(key)))
    .map(([key, label]) => ({ key, label }));
  const isMissing = key => missing.some(x => x.key === key);
  const disallowed = /환입|환불|취소|자산|개인|e\s*나라도움|이나라도움|국고보조|국고사업|선급|선입금|사후정산|대체결의/i;
  const mismatch = Object.values(facts).some(v => disallowed.test(v)) ||
    (!isMissing('purpose') && value('purpose') !== '일반비용') ||
    (!isMissing('payment_route') && value('payment_route') !== '학교직접지급') ||
    (!isMissing('payment_status') && !['미지급', '지급전'].includes(value('payment_status'))) ||
    (!isMissing('campus') && !['서울', 'seoul'].includes(value('campus').toLowerCase())) ||
    (!isMissing('evidence_type') && !EVIDENCE_TYPES.includes(value('evidence_type')));
  if (mismatch) return result('out_of_scope', missing, ['일반 비용·학교 직접 지급·지급 전·서울 조건을 벗어나므로 이 절차를 적용하지 않았습니다.']);
  if (!isMissing('evidence_status') && !['접수확인', '접수완료', '확인완료', '사용내역확인'].includes(value('evidence_status'))) {
    missing.push({ key: 'evidence_status', label: '증빙 접수 또는 사용내역 확인 상태' });
  }

  const entries = pack.entries.filter(entry => isMissing('evidence_type') || entry.evidence_type === value('evidence_type'));
  const sources = new Map(pack.sources.map(source => [source.id, source]));
  const candidates = entries.map(entry => ({
    id: entry.id, evidence_type: entry.evidence_type, tab: entry.tab,
    review_status: REVIEW_STATUS, applicability: 'not_determined',
    match_status: missing.length ? 'conditional_reference' : 'conditions_match_requires_review',
    external_action_state: 'none',
    steps: entry.steps.map(step => ({
      kind: step.kind,
      reference: { ...step.reference, ...sources.get(step.reference.source_id), source_role: 'manual_reference' },
    })),
    attachments: { status: 'requires_review', source_basis: 'not_established_in_selected_manuals',
      note: '탭에서 증빙 내역을 연결한 사실과 파일 첨부 여부를 별도로 확인합니다.' },
  }));
  return {
    status: candidates.length ? (missing.length ? 'needs_input' : 'review_required') : 'no_match',
    candidates, missing_facts: missing, source_notes: [...BASE_NOTES],
  };
}

module.exports = { selectPractice, loadPracticePack, validatePracticePack, REVIEW_STATUS };

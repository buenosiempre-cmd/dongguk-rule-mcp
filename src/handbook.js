'use strict';

const fs = require('node:fs');

const SCHEMA_VERSION = 1;
const MAX_PACK_BYTES = 16 * 1024 * 1024;
const MAX_EXCERPT_CHARS = 1500;
const MAX_TOTAL_EXCERPT_CHARS = 5000;
const NOTICE = '표시된 판본의 해설 참고자료입니다. 현행 법령·동국대학교 규정 및 적용 회계를 별도로 확인하세요. 추출된 표로 분개나 금액을 확정하지 마세요.';
const normalize = value => value.normalize('NFC').toLowerCase().replace(/[\s·ㆍ･・.,:;()[\]{}「」『』<>/\\_-]+/g, '');
const validString = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateHandbookPack(pack) {
  const fail = () => { throw new Error('INVALID_HANDBOOK_PACK'); };
  if (!isObject(pack) || pack.schema_version !== SCHEMA_VERSION || pack.source_kind !== 'official_handbook' ||
      pack.legal_status !== 'interpretive_reference' || !validString(pack.id, 100) || !validString(pack.title, 200) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(pack.edition || '') || !validString(pack.publisher, 100) ||
      !validString(pack.original_url, 2000) || !/^\d{4}-\d{2}-\d{2}$/.test(pack.source_checked_at || '') ||
      !Number.isFinite(Date.parse(pack.source_checked_at)) || new Date(pack.source_checked_at).toISOString().slice(0, 10) !== pack.source_checked_at ||
      pack.freshness_status !== 'edition_identified_current_law_not_verified' || !isObject(pack.source_file) || !isObject(pack.extraction)) fail();
  let url;
  try { url = new URL(pack.original_url); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      !(url.hostname === 'kasfo.or.kr' || url.hostname.endsWith('.kasfo.or.kr'))) fail();
  const source = pack.source_file;
  if (!validString(source.name, 200) || /[\\/\x00-\x1f]/.test(source.name) || !source.name.endsWith('.md') ||
      !/^[a-f0-9]{64}$/.test(source.sha256 || '') || !Number.isSafeInteger(source.line_count) ||
      source.line_count < 1 || source.line_count > 500000 || source.format !== 'markdown' ||
      pack.extraction.method !== 'existing_markdown' || pack.extraction.pages_verified !== false ||
      pack.extraction.table_structure_verified !== false || pack.extraction.quality !== 'partial' ||
      !Array.isArray(pack.sections) || !pack.sections.length || pack.sections.length > 20000) fail();
  const ids = new Set();
  let total = 0;
  let previousEnd = 0;
  for (const section of pack.sections) {
    if (!isObject(section) || !validString(section.id, 100) || ids.has(section.id) ||
        !validString(section.heading, 300) || !validString(section.text, 4500) ||
        !['account_section', 'explanation', 'toc', 'appendix'].includes(section.kind) ||
        !Array.isArray(section.hierarchy) || section.hierarchy.length > 8 || section.hierarchy.some(x => !validString(x, 300)) ||
        !Number.isSafeInteger(section.start_line) || !Number.isSafeInteger(section.end_line) ||
        section.start_line <= previousEnd || section.end_line < section.start_line || section.end_line > source.line_count ||
        section.text.split('\n').length !== section.end_line - section.start_line + 1 ||
        !isObject(section.extraction_quality) || !['text_only', 'partial'].includes(section.extraction_quality.status) ||
        !Array.isArray(section.extraction_quality.warnings) || section.extraction_quality.warnings.length > 10 ||
        section.extraction_quality.warnings.some(x => !validString(x, 100))) fail();
    ids.add(section.id);
    previousEnd = section.end_line;
    total += section.text.length;
    if (total > 5000000) fail();
    // A supplied pack cannot promote visibly fragmented journal entries to clean text.
    if (detectExtractionQuality(section.text).status === 'partial' && section.extraction_quality.status !== 'partial') fail();
  }
  return pack;
}

function detectExtractionQuality(text) {
  const warnings = ['PDF_PAGE_MAPPING_UNVERIFIED', 'CURRENT_LAW_NOT_VERIFIED'];
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  const journal = /차\s*변|대\s*변|\(차\)|\(대\)/.test(text);
  const table = /\|.*\|/.test(text) || /[○×◯]/.test(text) ||
    lines.filter(x => /^[\d,]+(?:\.\d+)?(?:\s*원)?$/.test(x)).length >= 2 ||
    (/적용\s*회계/.test(text) && /학교\s*회계|법인\s*회계/.test(text));
  if (journal) warnings.push('JOURNAL_ENTRY_LAYOUT_UNVERIFIED');
  if (table) warnings.push('TABLE_STRUCTURE_UNVERIFIED');
  if (text.includes('\ufffd')) warnings.push('REPLACEMENT_CHARACTER_PRESENT');
  return { status: journal || table || text.includes('\ufffd') ? 'partial' : 'text_only', warnings };
}

function loadHandbookPack(file = process.env.DONGGUK_HANDBOOK_PACK_PATH) {
  if (!file) return null;
  if (typeof file !== 'string' || file.length > 4096) throw new Error('INVALID_HANDBOOK_PACK');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_PACK_BYTES || stat.size === 0) throw new Error('INVALID_HANDBOOK_PACK');
  return validateHandbookPack(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function queryTerms(query) {
  const stop = new Set(['알려줘', '알려주세요', '설명', '해설', '해설서', '뭐야', '무엇', '무엇인가요', '어떻게', '무슨', '어느', '대한', '관련', '계정', '계정과목', '회계', '처리', '회계처리', '궁금해', '찾아줘', '확인', '기준', '분개', '금액']);
  return [...new Set(query.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}·ㆍ･]+/u)
    .map(x => x.replace(/(?:인가요|인가|은요|는요|으로|에서|이란|란|에는|는|은|을|를|의|이|가)$/u, ''))
    .map(normalize).filter(x => x.length >= 2 && !stop.has(x)))].slice(0, 20);
}

function excerptFor(section, terms, maxChars) {
  const lines = section.text.split('\n');
  let match = lines.findIndex(line => terms.some(term => normalize(line).includes(term)));
  if (match < 0) {
    // Account names can themselves be wrapped across lines in extracted PDF text.
    const normalizedLines = lines.map(normalize);
    const joined = normalizedLines.join('');
    const offsets = terms.map(term => joined.indexOf(term)).filter(index => index >= 0);
    if (offsets.length) {
      const target = Math.min(...offsets);
      let offset = 0;
      match = normalizedLines.findIndex(line => { offset += line.length; return offset > target; });
    }
  }
  if (match < 0) match = 0;
  let start = Math.max(0, match - 2);
  while (start < match && !lines[start].trim()) start++;
  let end = start, length = 0;
  while (end < lines.length && length + lines[end].length + (end > start ? 1 : 0) <= maxChars) {
    length += lines[end].length + (end > start ? 1 : 0);
    end++;
  }
  if (end === start) {
    // Never cut a source line and then label the fragment as its complete line.
    return null;
  }
  while (end > start && !lines[end - 1].trim()) end--;
  if (end <= start) return null;
  return { text: lines.slice(start, end).join('\n'), start_line: section.start_line + start,
    end_line: section.start_line + end - 1, truncated: start > 0 || end < lines.length };
}

function searchHandbook(query, options = {}) {
  if (!isObject(options) || typeof query !== 'string' || !query.trim() || query.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(query) ||
      (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 5))) {
    return { status: 'invalid_argument', error: 'INVALID_ARGUMENT', message: '질문은 1~200자, limit은 1~5의 정수로 입력하세요.', results: [] };
  }
  let pack;
  try { pack = options.pack === undefined ? loadHandbookPack() : validateHandbookPack(options.pack); }
  catch { return { status: 'invalid_pack', error: 'HANDBOOK_PACK_INVALID', message: '해설서 팩을 읽거나 검증할 수 없습니다. 운영자가 파일 형식과 접근권한을 확인해야 합니다.', results: [] }; }
  if (!pack) return { status: 'not_configured', error: 'HANDBOOK_PACK_NOT_CONFIGURED', message: '외부 해설서 팩이 연결되지 않았습니다.', results: [] };
  const terms = queryTerms(query);
  const source = { id: pack.id, title: pack.title, publisher: pack.publisher, source_kind: pack.source_kind,
    edition: pack.edition, original_url: pack.original_url, legal_status: pack.legal_status,
    source_checked_at: pack.source_checked_at, freshness_status: pack.freshness_status,
    extraction: { method: pack.extraction.method, quality: pack.extraction.quality,
      pages_verified: pack.extraction.pages_verified, table_structure_verified: pack.extraction.table_structure_verified } };
  const ranked = terms.length ? pack.sections.filter(s => s.kind !== 'toc' &&
    normalize(s.text.split('\n').slice(1).join('\n')).length >= 12).map(section => {
    const title = normalize(section.heading);
    const body = normalize(section.text);
    const matches = terms.filter(t => body.includes(t) || title.includes(t));
    const titleMatches = terms.filter(t => title.includes(t)).length;
    const score = matches.length / terms.length * 30 + titleMatches * 18 +
      (titleMatches && section.kind === 'account_section' ? 24 : 0) +
      (terms.some(t => title === t) ? 30 : 0) +
      (section.extraction_quality.status === 'text_only' ? 4 : 0) - (section.kind === 'appendix' ? 20 : 0);
    return { section, score, matches };
  }).filter(x => x.matches.length && (terms.length < 3 || x.matches.length >= Math.ceil(terms.length / 2)))
    .sort((a, b) => b.score - a.score || a.section.start_line - b.section.start_line) : [];
  const results = [];
  let remaining = MAX_TOTAL_EXCERPT_CHARS;
  const selectedHeadings = new Set();
  for (const { section, score, matches } of ranked) {
    if (results.length >= (options.limit || 3) || remaining < 100) break;
    const key = section.hierarchy.join('>') + '>' + section.heading;
    if (selectedHeadings.has(key)) continue;
    const excerpt = excerptFor(section, terms, Math.min(MAX_EXCERPT_CHARS, remaining));
    if (!excerpt) continue;
    const excerptQuality = detectExtractionQuality(excerpt.text);
    const warnings = [...new Set([...section.extraction_quality.warnings, ...excerptQuality.warnings])];
    results.push({ id: section.id, heading: section.heading, hierarchy: section.hierarchy, section_kind: section.kind,
      score, matched_terms: matches, excerpt: excerpt.text, excerpt_truncated: excerpt.truncated,
      locator: { type: 'markdown_lines', file: pack.source_file.name, start_line: excerpt.start_line,
        end_line: excerpt.end_line, source_sha256: pack.source_file.sha256 },
      source_kind: pack.source_kind, edition: pack.edition, original_url: pack.original_url,
      extraction_quality: { status: section.extraction_quality.status === 'partial' || excerptQuality.status === 'partial' ? 'partial' : 'text_only', warnings },
      usable_for_definitive_journal_entries: false, usable_for_definitive_amounts: false });
    selectedHeadings.add(key);
    remaining -= excerpt.text.length;
  }
  return { status: results.length ? 'ok' : 'no_match', query, source, results, notice: NOTICE,
    applicability: 'not_determined', review_state: 'required' };
}

module.exports = { SCHEMA_VERSION, MAX_PACK_BYTES, MAX_EXCERPT_CHARS, MAX_TOTAL_EXCERPT_CHARS,
  normalize, detectExtractionQuality, validateHandbookPack, loadHandbookPack, searchHandbook };

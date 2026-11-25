'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-full-text-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = 'fixture-private-cookie';
process.env.DONGGUK_MCP_NO_CACHE = '0';
let fetches = 0;
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
require.cache[fetchPath].exports = async () => { fetches++; return { ok: true, buffer: async () => Buffer.alloc(0) }; };
const { createServer } = require('../src/index');
const { buildOriginalEvidence } = require('../src/hwp-evidence');
const p = (text, controls = []) => ({ text, runs: [], controls });
const parsed = buildOriginalEvidence({ sections: [{ paragraphs: [
  p('시험규정'), p('제1조(목적)'), p('전문 조회 기준'), p('제2조의2(범위)'), p('가지조문 고유내용'),
  p('부칙 (2026.1.1.)'), p('제1조(시행일)'), p('2026년 1월 1일부터 시행한다.'),
  p('<별표 1> 지급표'), p('', [{ kind: 'table', rowCount: 1, colCount: 2, cells: [
    { row: 0, col: 0, rowSpan: 1, colSpan: 2, paragraphs: [p('별표 금액 123원')] },
  ] }]), p('① 표 아래 주석'), p('[별지 제1호 서식] 신청서'), p('마지막 서식 내용'),
] }], binData: new Map(), docInfo: { binData: [] } });
// Represents a successful raw-audited parse; raw HWP parsing is covered by test-hwp-evidence.
parsed.structure.coverage = { ...parsed.structure.coverage, status: 'covered', rawAudit: 'checked', diagnostics: [], diagnosticsTotal: 0 };
function seed(category, key, value, scope = 'public') {
  const scopeDir = scope === 'private' ? 'private-' + crypto.createHash('sha256').update(process.env.DONGGUK_RULE_COOKIE).digest('hex').slice(0, 12) : scope;
  const dir = path.join(root, 'dongguk-rule-mcp', 'v2', scopeDir, category);
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(value));
}
function rule(id, original, html = 'HTML 본문', scope = 'public') {
  seed('history', String(id), [{ historyId: id * 10, revisedAt: '2026.01.01' }, { historyId: id * 10 - 1, revisedAt: '2025.01.01' }], scope);
  if (original) seed('original-structure-v2', `${id}_${id * 10}`, original, scope);
  seed('content-v3', `${id}_${id * 10}`, { markdown: html }, scope);
}
const full = parsed.markdown;
rule(1, parsed);
seed('original-structure-v2', '1_9', { ...parsed, markdown: '과거 조문\n<별표 1> 과거 금액표' });
const longText = '가'.repeat(999) + '😀' + '\n제10조의2(가지조문)\n' + '나'.repeat(1500) + '\n<별표 1>\n| 항목 | 금액 |\n|---|---|\n' + '다'.repeat(1300) + '\n마지막 주석';
rule(2, { ...parsed, markdown: longText });
rule(3, null, 'HTML 대체 본문'.repeat(400));
rule(4, { markdown: '구조 없는 예전 캐시' });
rule(5, { ...parsed, structure: { coverage: { status: 'partial', rawAudit: 'checked', diagnostics: [{ code: 'UNSUPPORTED_CONTROL', message: '미지원 객체' }], diagnosticsTotal: 1 } } });
rule(6, { ...parsed, markdown: full + '\n[그림 SHA-256: abc]', structure: { coverage: { ...parsed.structure.coverage, counts: { images: 1 } } } });
rule(7, { markdown: '   ' }, '빈 HWP 뒤 HTML');
rule(8, null, '');
rule(9, { ...parsed, markdown: '공개 전문' });
rule(9, { ...parsed, markdown: '내부 캐시 전문' }, '', 'private');
rule(10, { ...parsed, markdown: longText });
rule(11, { ...parsed, markdown: longText });
rule(12, { ...parsed, structure: { coverage: { status: 'covered', rawAudit: 'not_supplied' } } });

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`); }
async function connect(profile) {
  const server = createServer({ profile });
  const client = new Client({ name: 'full-text-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  return { server, client };
}
async function main() {
  const { server, client } = await connect('rules');
  const call = async args => client.callTool({ name: 'get_rule_full_text', arguments: args });
  const data = async args => (await call(args)).structuredContent.data;
  try {
    const tools = (await client.listTools()).tools;
    const tool = tools.find(t => t.name === 'get_rule_full_text');
    check('공개 도구 등록·입력 계약', () => { assert.equal(tools.length, 15); assert.equal(tool.annotations.readOnlyHint, true); assert.deepEqual(tool.inputSchema.required, ['law_id']); });
    const info = (await client.callTool({ name: 'get_service_info', arguments: {} })).structuredContent.data;
    check('서비스 정보와 도구 목록 일치', () => { assert.equal(info.toolCount, tools.length); assert.equal(info.fullText.tool, tool.name); assert.equal(info.fullText.defaultMaxChars, tool.inputSchema.properties.max_chars.default); assert.equal(info.fullText.maxChars, tool.inputSchema.properties.max_chars.maximum); });
    const first = await call({ law_id: 1 }); const d = first.structuredContent.data;
    check('HWP 전문은 원문 순서·주석·서식까지 동일', () => { assert.equal(d.contentMarkdown, full); assert.match(full, /제2조의2/); assert.match(full, /별표 금액 123원/); assert.match(full, /표 아래 주석/); assert.match(full, /마지막 서식 내용/); assert(full.indexOf('부칙') < full.indexOf('<별표 1>')); });
    check('표의 병합 구조 유지', () => assert.match(d.contentMarkdown, /\| 1 \| 1 \| 1 \| 2 \| 별표 금액 123원 \|/));
    check('한 페이지 전체 반환과 근거 상태', () => { assert.equal(d.evidenceStatus, 'retrieved'); assert.equal(d.sourceEvidenceStatus, 'retrieved'); assert.deepEqual(d.incompleteReasons, []); assert.equal(d.textCoverage.status, 'complete'); assert.equal(d.textCoverage.truncated, false); assert.equal(d.textCoverage.nextArguments, null); assert.equal(d.textCoverage.totalChars, full.length); });
    check('출처·개정일·조회시점·추출문 해시', () => { assert.equal(d.historyId, 10); assert.equal(d.revisedAt, '2026.01.01'); assert(d.sourceUrl.endsWith('SEQ=1&SEQ_HISTORY=10')); assert(Number.isFinite(Date.parse(d.returnedAt))); assert.equal(d.textCoverage.sha256, crypto.createHash('sha256').update(full).digest('hex')); assert.equal(d.applicability, 'requires_enforcement_review'); });
    check('Markdown에서도 상태와 전문 확인', () => { assert.match(first.content[0].text, /근거 상태: retrieved/); assert(first.content[0].text.endsWith(full)); });
    const historic = await data({ law_id: 1, history_id: 9 });
    check('지정한 과거 개정본 전문', () => { assert.equal(historic.historyId, 9); assert.match(historic.contentMarkdown, /과거 금액표/); });
    const foreign = (await call({ law_id: 1, history_id: 20 })).structuredContent;
    check('다른 규정의 HISTORY_ID 거절', () => assert.equal(foreign.error.code, 'HISTORY_NOT_FOUND'));
    let page = await data({ law_id: 2, max_chars: 1000 });
    const initialCursor = page.textCoverage.nextCursor;
    check('첫 페이지 잘림·partial·이어받기 안내', () => { assert.equal(page.contentMarkdown.length, 999); assert.equal(page.evidenceStatus, 'partial'); assert.deepEqual(page.incompleteReasons, ['FULL_TEXT_PAGINATED']); assert.equal(page.sourceEvidenceStatus, 'retrieved'); assert.equal(page.textCoverage.truncated, true); assert.equal(page.textCoverage.nextArguments.history_id, 20); });
    // A new latest revision must not move a continuation off its pinned revision.
    seed('history', '2', [{ historyId: 21, revisedAt: '2026.02.01' }, { historyId: 20, revisedAt: '2026.01.01' }]);
    const pieces = [page.contentMarkdown]; let pages = 1;
    while (page.textCoverage.nextArguments) {
      const next = page.textCoverage.nextArguments;
      const previousEnd = page.textCoverage.endOffset;
      page = await data(next); pages++;
      assert.equal(page.historyId, 20); assert.equal(page.textCoverage.offset, previousEnd);
      assert(page.contentMarkdown.length <= 1000); pieces.push(page.contentMarkdown);
      assert(pages < 10);
    }
    check('이어받기 전체 결합: 누락·중복·유니코드 손상 없음', () => { assert.equal(pieces.join(''), longText); assert.equal(pages, 4); assert(pieces[1].startsWith('😀')); });
    check('마지막 페이지도 단독으로 전문 완료를 주장하지 않음', () => { assert.equal(page.evidenceStatus, 'partial'); assert.equal(page.textCoverage.status, 'partial'); assert.equal(page.textCoverage.truncated, false); assert.equal(page.textCoverage.hasMore, false); assert.equal(page.textCoverage.nextCursor, null); assert.equal(page.textCoverage.endOffset, longText.length); });
    const cursorOnly = await data({ law_id: 2, cursor: initialCursor });
    check('history_id 생략해도 cursor 개정본 유지·페이지 크기 변경 허용', () => { assert.equal(cursorOnly.historyId, 20); assert.equal(cursorOnly.contentMarkdown, longText.slice(999)); });
    for (const args of [{ law_id: 1, cursor: initialCursor }, { law_id: 2, history_id: 21, cursor: initialCursor }]) {
      const r = (await call(args)).structuredContent;
      check('cursor와 규정·개정본 불일치 거절', () => assert.equal(r.error.code, 'INVALID_ARGUMENT'));
    }
    let fallback = await data({ law_id: 3, max_chars: 1000 });
    check('HWP 다운로드 실패 시 HTML 대체와 부분 사유', () => { assert.equal(fallback.sourceType, 'HTML 본문'); assert.equal(fallback.sourceEvidenceStatus, 'partial'); assert(fallback.incompleteReasons.includes('HWP_FALLBACK')); assert.equal(fallback.originalCoverage, null); });
    seed('original-structure-v2', '3_30', parsed);
    const htmlRest = await data({ ...fallback.textCoverage.nextArguments, max_chars: 60000 });
    check('HWP 복구 후에도 HTML 이어받기는 같은 출처 유지', () => { assert.equal(htmlRest.sourceType, 'HTML 본문'); assert.equal(fallback.contentMarkdown + htmlRest.contentMarkdown, 'HTML 대체 본문'.repeat(400)); assert.equal(htmlRest.sourceEvidenceStatus, 'partial'); });
    const legacy = await data({ law_id: 4 });
    check('구조 없는 캐시도 부분 조회', () => { assert.equal(legacy.evidenceStatus, 'partial'); assert(legacy.incompleteReasons.includes('HWP_COVERAGE_UNVERIFIED')); });
    const unsupportedResponse = await call({ law_id: 5 });
    const unsupported = unsupportedResponse.structuredContent.data;
    check('추출 진단은 원형으로 전달', () => { assert(unsupported.incompleteReasons.includes('HWP_STRUCTURE_PARTIAL')); assert.equal(unsupported.originalCoverage.diagnostics[0].code, 'UNSUPPORTED_CONTROL'); assert.match(unsupportedResponse.content[0].text, /UNSUPPORTED_CONTROL/); });
    const picture = await call({ law_id: 6 });
    check('그림을 해시만 읽었으면 전문 근거는 partial', () => { assert(picture.structuredContent.data.incompleteReasons.includes('IMAGE_TEXT_UNAVAILABLE')); assert.match(picture.content[0].text, /그림 속 문구는 원문/); });
    const empty = await data({ law_id: 7 });
    check('빈 HWP도 HTML 대체', () => { assert.equal(empty.contentMarkdown, '빈 HWP 뒤 HTML'); assert.deepEqual(empty.incompleteReasons, ['HWP_FALLBACK']); });
    const unavailable = (await call({ law_id: 8 })).structuredContent;
    check('HWP·HTML 모두 비면 성공 아님', () => assert.equal(unavailable.error.code, 'CONTENT_UNAVAILABLE'));
    const unchecked = await data({ law_id: 12 });
    check('raw audit 미실시를 완전한 근거로 올리지 않음', () => assert(unchecked.incompleteReasons.includes('HWP_COVERAGE_UNVERIFIED')));
    const changed = await data({ law_id: 10, max_chars: 1000 });
    seed('original-structure-v2', '10_100', { ...parsed, markdown: longText + '수정' });
    const stale = (await call(changed.textCoverage.nextArguments)).structuredContent;
    check('페이지 사이 추출문 변경 감지', () => assert.equal(stale.error.code, 'FULL_TEXT_CHANGED'));
    const switched = await data({ law_id: 11, max_chars: 1000 });
    seed('original-structure-v2', '11_110', { markdown: '' });
    const switchResult = (await call(switched.textCoverage.nextArguments)).structuredContent;
    check('HWP 이어받기 중 HTML로 바뀌면 결합 금지', () => assert.equal(switchResult.error.code, 'FULL_TEXT_CHANGED'));
    for (const args of [{}, { law_id: 0 }, { law_id: 1.5 }, { law_id: 1, history_id: -1 },
      ...[0, 999, 60001, 1000.5, '1000', null].map(max_chars => ({ law_id: 1, max_chars })),
      ...['', 'abc', {}, Buffer.from('{}').toString('base64url')].map(cursor => ({ law_id: 1, cursor }))]) {
      const before = fetches; const invalid = (await call(args)).structuredContent;
      check('잘못된 입력은 조회 전에 거절 ' + JSON.stringify(args), () => { assert.equal(invalid.error.code, 'INVALID_ARGUMENT'); assert.equal(fetches, before); });
    }
    for (const offset of [longText.length, 1000]) {
      const value = JSON.parse(Buffer.from(initialCursor, 'base64url').toString()); value.offset = offset;
      const bad = (await call({ law_id: 2, cursor: Buffer.from(JSON.stringify(value)).toString('base64url') })).structuredContent;
      check('범위 밖·서로게이트 중간 cursor 거절', () => assert.equal(bad.error.code, 'INVALID_ARGUMENT'));
    }
    const pub = await data({ law_id: 9 });
    const finance = await connect('finance');
    try {
      const privateResult = (await finance.client.callTool({ name: 'get_rule_full_text', arguments: { law_id: 9 } })).structuredContent.data;
      const financeInfo = (await finance.client.callTool({ name: 'get_service_info', arguments: {} })).structuredContent.data;
      check('공개·내부 캐시 경계 유지', () => { assert.equal(pub.contentMarkdown, '공개 전문'); assert.equal(privateResult.contentMarkdown, '내부 캐시 전문'); });
      check('finance 도구 수 일치', () => assert.equal(financeInfo.toolCount, 19));
    } finally { await finance.client.close(); await finance.server.close(); }
  } finally { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  console.log(`\n📊 규정 전문 조회 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

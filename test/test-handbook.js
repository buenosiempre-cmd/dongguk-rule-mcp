'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { buildHandbookPack, resolveNormalizedPath } = require('../scripts/build-handbook-pack.js');
const { searchHandbook, loadHandbookPack, validateHandbookPack, MAX_EXCERPT_CHARS, MAX_TOTAL_EXCERPT_CHARS } = require('../src/handbook.js');

let passed = 0;
function check(name, fn) { fn(); passed++; process.stdout.write(`  ✅ ${name}\n`); }
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/handbook-synthetic.md'), 'utf8');
const pack = buildHandbookPack(fixture, { source_name: 'handbook-synthetic.md', source_checked_at: '2026-09-08' });
const clone = value => JSON.parse(JSON.stringify(value));
const mutate = callback => { const p = clone(pack); callback(p); return p; };

check('합성 원문 팩은 공식해설 자료형과 판본을 구분', () => {
  assert.equal(pack.source_kind, 'official_handbook');
  assert.equal(pack.legal_status, 'interpretive_reference');
  assert.equal(pack.edition, '2023-12');
});
check('계정 제목은 목차와 부록의 반복 단어보다 우선', () => {
  const r = searchHandbook('교육훈련비', { pack });
  assert.equal(r.status, 'ok'); assert.equal(r.results[0].heading, '교육훈련비');
  assert.equal(r.results[0].section_kind, 'account_section');
  assert(r.results.every(x => x.section_kind !== 'toc'));
});
check('짧은 한국어 조사 및 질문 표현 지원', () => assert.equal(searchHandbook('보험료는 뭐야?', { pack }).results[0].heading, '보험료'));
check('NFD 검색어도 같은 계정에 도달', () => assert.equal(searchHandbook('소모품비'.normalize('NFD'), { pack }).results[0].heading, '소모품비'));
check('모든 결과에 원문과 정확히 일치하는 줄 근거 제공', () => {
  const lines = fixture.split('\n');
  for (const result of searchHandbook('소모품비', { pack, limit: 5 }).results) {
    assert.equal(result.excerpt, lines.slice(result.locator.start_line - 1, result.locator.end_line).join('\n'));
    assert.equal(result.locator.type, 'markdown_lines');
    assert.equal(result.locator.source_sha256, pack.source_file.sha256);
    assert.equal(result.edition, pack.edition); assert.equal(result.original_url, pack.original_url);
    assert.equal(result.source_kind, 'official_handbook');
  }
});
check('분리된 분개표는 부분 품질이며 확정 분개·금액에 사용 불가', () => {
  const r = searchHandbook('분리된 금액', { pack }).results[0];
  assert.equal(r.extraction_quality.status, 'partial');
  assert(r.extraction_quality.warnings.includes('JOURNAL_ENTRY_LAYOUT_UNVERIFIED'));
  assert.equal(r.usable_for_definitive_journal_entries, false);
  assert.equal(r.usable_for_definitive_amounts, false);
  assert(r.excerpt.includes('10,000 대변) 예금\n\n10,000\n20,000'));
});
check('본문 설명도 현행법 검증 또는 PDF 페이지 검증으로 오인하지 않음', () => {
  const r = searchHandbook('교육훈련비', { pack });
  assert.equal(r.source.extraction.pages_verified, false);
  assert.equal(r.applicability, 'not_determined');
  assert(r.results[0].extraction_quality.warnings.includes('CURRENT_LAW_NOT_VERIFIED'));
});
check('검색 일치가 없으면 무관한 목차로 대체하지 않음', () => assert.equal(searchHandbook('존재하지않는계정', { pack }).status, 'no_match'));
check('일반적 업무 단어만 있는 질문은 무관한 첫 계정으로 선택하지 않음', () => assert.equal(searchHandbook('회계 처리 설명', { pack }).status, 'no_match'));
for (const query of ['', ' '.repeat(4), null, {}, '가'.repeat(201), '\u0000']) {
  check(`입력 검증 ${JSON.stringify(query)?.slice(0, 30)}`, () => assert.equal(searchHandbook(query, { pack }).status, 'invalid_argument'));
}
for (const limit of [0, 6, 1.2, '3', null]) {
  check(`limit 검증 ${JSON.stringify(limit)}`, () => assert.equal(searchHandbook('보험료', { pack, limit }).status, 'invalid_argument'));
}
check('잘못된 옵션 객체는 예외 대신 명시적 입력 실패', () => assert.equal(searchHandbook('보험료', null).status, 'invalid_argument'));
for (const [name, callback] of [
  ['schema', p => { p.schema_version = 2; }],
  ['source kind', p => { p.source_kind = 'law'; }],
  ['edition', p => { p.edition = ''; }],
  ['source URL', p => { p.original_url = 'https://evil.example/a'; }],
  ['URL credentials', p => { p.original_url = 'https://user:secret@support.kasfo.or.kr/a'; }],
  ['invalid source date', p => { p.source_checked_at = '2026-02-31'; }],
  ['line mismatch', p => { p.sections[0].end_line++; }],
  ['duplicate section', p => { p.sections.push(p.sections[0]); }],
  ['path leakage', p => { p.source_file.name = '/private/secret.md'; }],
  ['hash', p => { p.source_file.sha256 = 'bad'; }],
  ['PDF verification promotion', p => { p.extraction.pages_verified = true; }],
  ['freshness promotion', p => { p.freshness_status = 'current_law_verified'; }],
  ['table quality promotion', p => { p.sections.find(x => x.text.includes('차변)')).extraction_quality.status = 'text_only'; }],
  ['section too large', p => { p.sections[0].text = 'a'.repeat(4501); }],
]) {
  check(`팩 검증 ${name}`, () => assert.equal(searchHandbook('보험료', { pack: mutate(callback) }).status, 'invalid_pack'));
}
check('팩의 알 수 없는 추출 메타데이터를 응답으로 전달하지 않음', () => {
  const p = mutate(x => { x.extraction.local_secret_path = '/private/unrelated-data'; });
  assert(!JSON.stringify(searchHandbook('보험료', { pack: p })).includes('/private/unrelated-data'));
});
check('발췌는 개별·전체 상한과 실제 줄 범위를 준수', () => {
  const text = '# 합성\n' + Array.from({ length: 8 }, (_, i) => `가. 테스트계정${i}\n\n` + ('테스트계정 설명이다.\n\n'.repeat(150))).join('\n');
  const large = buildHandbookPack(text, { source_name: 'synthetic-large.md' });
  const r = searchHandbook('테스트계정', { pack: large, limit: 5 });
  assert(r.results.length >= 3 && r.results.length <= 5);
  assert(r.results.every(x => x.excerpt.length <= MAX_EXCERPT_CHARS));
  assert(r.results.reduce((sum, x) => sum + x.excerpt.length, 0) <= MAX_TOTAL_EXCERPT_CHARS);
  assert(r.results.some(x => x.excerpt_truncated));
  const lines = text.split('\n');
  for (const x of r.results) assert.equal(x.excerpt, lines.slice(x.locator.start_line - 1, x.locator.end_line).join('\n'));
});
check('긴 단일 줄은 잘라 놓고 전체 줄 인용으로 표시하지 않음', () => {
  const p = buildHandbookPack('# 합성\n가. 긴계정\n' + '긴계정'.repeat(800), { source_name: 'long-line.md' });
  assert(searchHandbook('긴계정', { pack: p }).results.every(x => x.excerpt.length <= MAX_EXCERPT_CHARS));
});
check('줄바꿈된 종결어미 다.를 계정 제목으로 오인하지 않음', () => {
  const text = '# 합성\n가. 소모품비\n\n소모품비는 사무용품의 비용을 기록하는 계정과목이\n\n다. 이러한 소모품비의 예로는 복사용지 등이 있다.\n\n나. 보험료\n\n보험료의 합성 설명이다.';
  const p = buildHandbookPack(text, { source_name: 'wrapped.md' });
  const r = searchHandbook('소모품비', { pack: p });
  assert.equal(p.sections.filter(x => x.kind === 'account_section').length, 2);
  assert(r.results[0].excerpt.includes('다. 이러한 소모품비'));
});
check('설명이 없는 제목만으로 조회 성공을 만들지 않음', () => {
  const p = buildHandbookPack('# 합성\n## 관리운영비\n가. 소모품비\n소모품비 설명이 충분히 있는 합성 문장입니다.', { source_name: 'headings.md' });
  assert.equal(searchHandbook('관리운영비', { pack: p }).status, 'no_match');
});
check('여러 줄로 끊긴 검색어의 발췌가 실제 검색어 위치에 도달', () => {
  const text = '# 합성\n1. 관리비용\n' + '무관한 문장입니다.\n'.repeat(200) + '\n교육\n훈련비의 계정 설명이다.\n원문 위치를 검증한다.';
  const p = buildHandbookPack(text, { source_name: 'wrapped-term.md' });
  const r = searchHandbook('교육훈련비', { pack: p });
  assert.equal(r.status, 'ok');
  assert(r.results[0].excerpt.includes('교육\n훈련비'));
});

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'handbook-synthetic-'));
const previous = process.env.DONGGUK_HANDBOOK_PACK_PATH;
try {
  check('팩 미연결은 검색 성공으로 표시하지 않음', () => {
    delete process.env.DONGGUK_HANDBOOK_PACK_PATH;
    assert.equal(searchHandbook('보험료').status, 'not_configured');
  });
  check('환경변수 경로에서 외부 팩 로드', () => {
    const file = path.join(temporary, 'pack.json'); fs.writeFileSync(file, JSON.stringify(pack));
    process.env.DONGGUK_HANDBOOK_PACK_PATH = file;
    assert.equal(loadHandbookPack().edition, '2023-12');
    assert.equal(searchHandbook('보험료').results[0].heading, '보험료');
  });
  check('파일 오류 응답에 로컬 경로·파일 내용이 노출되지 않음', () => {
    process.env.DONGGUK_HANDBOOK_PACK_PATH = path.join(temporary, 'secret-location.json');
    const r = searchHandbook('보험료');
    assert.equal(r.status, 'invalid_pack'); assert(!JSON.stringify(r).includes(temporary));
  });
  check('NFC로 요청한 경로에서 NFD 파일을 발견', () => {
    const filename = '합성원문.md';
    fs.writeFileSync(path.join(temporary, filename.normalize('NFD')), fixture);
    assert.equal(fs.readFileSync(resolveNormalizedPath(path.join(temporary, filename)), 'utf8'), fixture);
  });
  check('CLI는 비공개 외부 경로에만 빌드하고 파일 권한을 제한', () => {
    const input = path.join(temporary, '합성원문.md');
    const output = path.join(temporary, 'private-pack.json');
    const r = spawnSync(process.execPath, [path.join(__dirname, '../scripts/build-handbook-pack.js'), '--source', input, '--output', output], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(validateHandbookPack(JSON.parse(fs.readFileSync(output, 'utf8'))).edition, '2023-12');
  });
  check('CLI는 저장소 내부에 원문 팩 생성을 차단', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '../scripts/build-handbook-pack.js'), '--source', path.join(temporary, '합성원문.md'), '--output', path.join(__dirname, 'must-not-exist.json')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert(!fs.existsSync(path.join(__dirname, 'must-not-exist.json')));
  });
} finally {
  if (previous === undefined) delete process.env.DONGGUK_HANDBOOK_PACK_PATH;
  else process.env.DONGGUK_HANDBOOK_PACK_PATH = previous;
  fs.rmSync(temporary, { recursive: true, force: true });
}
process.stdout.write(`📊 해설서 합성 검증: ${passed}개 통과\n`);

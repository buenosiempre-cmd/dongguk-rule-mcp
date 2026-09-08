'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { selectPractice, loadPracticePack, REVIEW_STATUS } = require('../src/practice.js');
const { buildPracticePack } = require('../scripts/build-practice-pack.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dgu-practice-test-'));
const oldEnv = process.env.DONGGUK_PRACTICE_PACK_PATH;
let checks = 0;
function check(name, fn) { fn(); checks++; process.stdout.write(`ok ${checks} - ${name}\n`); }
const metadata = title => ['---', `title: "${title}"`, 'source_url: https://example.com/synthetic-manual',
  `source_sha256: ${'a'.repeat(64)}`, 'reparsed_at: 2026-01-01', '---'];
const evidenceText = [...metadata('Synthetic evidence'), '## 지출증빙 처리 절차',
  '가상 자료: 접수 상태를 확인한다.', '## 증빙 유형별 처리 방법',
  '### (세금)계산서', '1. `가상세금` 탭을 선택한다.', '2. 가상 내역 중 항목을 선택한다.',
  '#### 제외할 선입금 예외', '이 문장은 기본 후보에 포함하면 안 된다.',
  '### 법인카드', '1. `가상카드` 탭을 선택한다.', '2. 가상 카드 내역 중 항목을 선택한다.',
  '### 현금영수증', '1. `가상영수증` 탭을 선택한다.', '2. 가상 영수증 내역 중 항목을 선택한다.', ''].join('\n');
const voucherText = [...metadata('Synthetic voucher'), '## 결의서 유형 구분',
  '| 유형 | 가상 조건 |', '| 지출 | 일반 비용 |', '## 항목별 처리',
  '### (세금)계산서', '가상 접수된 항목을 선택한다.',
  '### 법인카드', '가상 사용내역을 선택한다.',
  '### 영수증', '가상 접수된 영수증을 선택한다.', ''].join('\n');
const evidence = path.join(temp, 'evidence.md');
const voucher = path.join(temp, 'voucher.md');
fs.writeFileSync(evidence, evidenceText); fs.writeFileSync(voucher, voucherText);
const facts = { purpose: '일반비용', payment_route: '학교직접지급', payment_status: '지급전',
  evidence_type: '세금계산서', evidence_status: '접수확인', campus: '서울' };

try {
  const pack = buildPracticePack(evidence, voucher);
  check('builder records exact Markdown bytes and line references', () => {
    assert.equal(pack.sources[0].markdown_sha256, crypto.createHash('sha256').update(evidenceText).digest('hex'));
    for (const entry of pack.entries) for (const step of entry.steps) {
      const text = step.reference.source_id === 'evidence-processing' ? evidenceText : voucherText;
      assert.equal(step.reference.excerpt, text.split('\n').slice(step.reference.line_start - 1, step.reference.line_end).join('\n'));
    }
    assert.equal(pack.sources[0].source_hash_status, 'frontmatter_record_only');
    assert(!JSON.stringify(pack.entries).includes('이 문장은 기본 후보에 포함하면 안 된다.'));
  });
  check('matched facts produce a reference requiring review, never execution', () => {
    const r = selectPractice(facts, pack);
    assert.equal(r.status, 'review_required'); assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].tab, '가상세금');
    assert.equal(r.candidates[0].review_status, REVIEW_STATUS);
    assert.equal(r.candidates[0].applicability, 'not_determined');
    assert.equal(r.candidates[0].external_action_state, 'none');
    assert.equal(r.candidates[0].attachments.source_basis, 'not_established_in_selected_manuals');
    assert(r.candidates[0].steps.every(s => s.reference.source_url.startsWith('https://example.com/')));
  });
  check('each supported evidence kind selects its own tab', () => {
    const tabs = ['가상세금', '가상카드', '가상영수증'];
    ['세금계산서', '법인카드', '현금영수증'].forEach((type, i) => {
      assert.equal(selectPractice({ ...facts, evidence_type: type, campus: 'seoul' }, pack).candidates[0].tab, tabs[i]);
    });
    assert.equal(selectPractice({ ...facts, payment_status: '미지급' }, pack).status, 'review_required');
  });
  check('missing facts retain conditional references and list what is missing', () => {
    const r = selectPractice({ purpose: '일반비용', evidence_type: '법인카드' }, pack);
    assert.equal(r.status, 'needs_input'); assert.equal(r.candidates.length, 1);
    assert(r.missing_facts.some(f => f.key === 'payment_route'));
    assert.equal(r.candidates[0].match_status, 'conditional_reference');
    assert.equal(selectPractice({}, pack).candidates.length, 3);
    assert.equal(selectPractice({ ...facts, campus: undefined }, pack).status, 'needs_input');
    assert.equal(selectPractice({ ...facts, evidence_status: '미접수' }, pack).status, 'needs_input');
  });
  check('exceptions, prior payment and other campuses never receive generic candidates', () => {
    const variants = [
      { purpose: '환입' }, { purpose: '자산취득' }, { payment_route: '개인지급' },
      { funding: 'e나라도움' }, { payment_status: '지급완료' }, { campus: 'WISE' },
      { evidence_type: '간이영수증' }, { purpose: '선입금 정산' },
    ];
    for (const variant of variants) {
      const r = selectPractice({ ...facts, ...variant }, pack);
      assert.equal(r.status, 'out_of_scope'); assert.deepEqual(r.candidates, []);
    }
  });
  check('invalid facts and untrusted pack metadata fail without content leakage', () => {
    assert.equal(selectPractice([], pack).status, 'invalid_facts');
    assert.equal(selectPractice({ purpose: 1 }, pack).status, 'invalid_facts');
    const bad = JSON.parse(JSON.stringify(pack)); bad.entries[0].steps[0].reference.line_end = 999999;
    assert.equal(selectPractice(facts, bad).status, 'invalid_pack');
    bad.entries[0].steps[0].reference.excerpt = 'SYNTHETIC_SECRET_SHOULD_NOT_LEAK';
    assert(!JSON.stringify(selectPractice(facts, bad)).includes('SYNTHETIC_SECRET_SHOULD_NOT_LEAK'));
    const unsafe = JSON.parse(JSON.stringify(pack)); unsafe.sources[0].source_url = 'javascript:alert(1)';
    assert.equal(selectPractice(facts, unsafe).status, 'invalid_pack');
  });
  check('external pack loader handles absent, malformed, oversized and valid files', () => {
    delete process.env.DONGGUK_PRACTICE_PACK_PATH;
    assert.equal(selectPractice(facts).status, 'not_configured');
    const file = path.join(temp, 'pack.json'); process.env.DONGGUK_PRACTICE_PACK_PATH = file;
    fs.writeFileSync(file, 'SYNTHETIC_SECRET_SHOULD_NOT_LEAK');
    assert.equal(selectPractice(facts).status, 'invalid_pack');
    fs.writeFileSync(file, ' '.repeat(4 * 1024 * 1024 + 1));
    assert.equal(selectPractice(facts).status, 'invalid_pack');
    fs.writeFileSync(file, JSON.stringify(pack));
    assert.equal(loadPracticePack().entries.length, 3);
    assert.equal(selectPractice(facts).status, 'review_required');
  });
  check('CLI creates a protected external file and refuses repository output', () => {
    const script = path.resolve(__dirname, '../scripts/build-practice-pack.js');
    const out = path.join(temp, 'built.json');
    const args = [script, '--evidence-file', evidence, '--voucher-file', voucher, '--out', out];
    const summary = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
    assert.equal(summary.candidates, 3); assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.equal(summary.review_status, REVIEW_STATUS);
    const repeated = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(repeated.status, 0);
    const repoOut = path.resolve(__dirname, '../practice-test-must-not-exist.json');
    assert(!fs.existsSync(repoOut));
    const denied = spawnSync(process.execPath, [...args.slice(0, -1), repoOut], { encoding: 'utf8' });
    assert.notEqual(denied.status, 0); assert(!fs.existsSync(repoOut));
    assert(denied.stderr.includes('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY'));
  });
  process.stdout.write(`practice: ${checks} checks passed\n`);
} finally {
  if (oldEnv === undefined) delete process.env.DONGGUK_PRACTICE_PACK_PATH;
  else process.env.DONGGUK_PRACTICE_PACK_PATH = oldEnv;
  fs.rmSync(temp, { recursive: true, force: true });
}

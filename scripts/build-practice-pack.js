#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validatePracticePack, REVIEW_STATUS } = require('../src/practice.js');

function readManual(file, id) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const frontmatterEnd = lines.indexOf('---', 1);
  if (lines[0] !== '---' || frontmatterEnd < 1) throw new Error('MANUAL_METADATA_REQUIRED');
  const metadata = {};
  for (const line of lines.slice(1, frontmatterEnd)) {
    const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (match) metadata[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return { lines, source: {
    id, title: metadata.title, source_url: metadata.source_url,
    source_sha256: metadata.source_sha256,
    source_hash_status: 'frontmatter_record_only',
    markdown_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    line_count: lines.length, reparsed_at: metadata.reparsed_at || null,
    review_status: REVIEW_STATUS,
  } };
}

function section(manual, heading) {
  const start = manual.lines.findIndex(line => /^#{2,4}\s/.test(line) && line.replace(/^#+\s*/, '').trim() === heading);
  if (start < 0) throw new Error('MANUAL_SECTION_NOT_FOUND');
  let end = start + 1;
  while (end < manual.lines.length && !/^#{1,6}\s/.test(manual.lines[end])) end++;
  return { start, end };
}

function reference(manual, start, end) {
  return { source_id: manual.source.id, line_basis: 'markdown',
    line_start: start + 1, line_end: end,
    excerpt: manual.lines.slice(start, end).join('\n') };
}

function matchingLine(manual, range, pattern) {
  for (let i = range.start; i < range.end; i++) {
    if (pattern.test(manual.lines[i])) return reference(manual, i, i + 1);
  }
  throw new Error('MANUAL_STEP_NOT_FOUND');
}

function buildPracticePack(evidenceFile, voucherFile) {
  const evidence = readManual(evidenceFile, 'evidence-processing');
  const voucher = readManual(voucherFile, 'expense-voucher');
  const receipt = section(evidence, '지출증빙 처리 절차');
  const voucherKinds = section(voucher, '결의서 유형 구분');
  const receiptRef = reference(evidence, receipt.start, receipt.end);
  const kindsRef = reference(voucher, voucherKinds.start, Math.min(voucherKinds.start + 7, voucherKinds.end));
  const types = [
    ['tax-invoice', '세금계산서', '(세금)계산서', '(세금)계산서'],
    ['corporate-card', '법인카드', '법인카드', '법인카드'],
    ['cash-receipt', '현금영수증', '현금영수증', '영수증'],
  ];
  const entries = types.map(([id, type, evidenceHeading, voucherHeading]) => {
    const range = section(evidence, evidenceHeading);
    const voucherRange = section(voucher, voucherHeading);
    const tabRef = matchingLine(evidence, range, /탭.*선택/);
    const tab = /`([^`]+)`\s*탭/.exec(tabRef.excerpt)?.[1];
    if (!tab) throw new Error('MANUAL_TAB_NOT_FOUND');
    return { id, evidence_type: type, tab, review_status: REVIEW_STATUS, steps: [
      { kind: 'check_voucher_scope', reference: kindsRef },
      { kind: 'confirm_receipt_or_usage_record', reference: receiptRef },
      { kind: 'select_evidence_tab', reference: tabRef },
      { kind: 'link_matching_record', reference: matchingLine(evidence, range, /내역.*(?:항목|선택)/) },
      { kind: 'voucher_record_reference', reference: matchingLine(voucher, voucherRange, /내역|접수된/) },
    ] };
  });
  return validatePracticePack({ schema_version: 1, version: 'practice-reference-1',
    built_at: new Date().toISOString(), review_status: REVIEW_STATUS,
    sources: [evidence.source, voucher.source], entries });
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--evidence-file', '--voucher-file', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) {
      throw new Error('INVALID_ARGUMENT');
    }
    options[args[i]] = args[i + 1];
  }
  if (!options['--evidence-file'] || !options['--voucher-file'] || !options['--out']) throw new Error('INVALID_ARGUMENT');
  const output = path.resolve(options['--out']);
  const repoRoot = path.resolve(__dirname, '..');
  const parent = fs.realpathSync(path.dirname(output));
  const resolvedOutput = path.join(parent, path.basename(output));
  if (resolvedOutput === repoRoot || resolvedOutput.startsWith(repoRoot + path.sep)) throw new Error('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  const pack = buildPracticePack(options['--evidence-file'], options['--voucher-file']);
  fs.writeFileSync(resolvedOutput, JSON.stringify(pack, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: 'written', sources: pack.sources.length,
    candidates: pack.entries.length, review_status: REVIEW_STATUS }) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'PRACTICE_PACK_BUILD_FAILED';
    process.stderr.write(code + '\n'); process.exitCode = 1;
  }
}
module.exports = { buildPracticePack, readManual, main };

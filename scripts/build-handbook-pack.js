#!/usr/bin/env node
'use strict';

// Build a private runtime artifact. Never place the source or resulting JSON in this repository.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalize, detectExtractionQuality, validateHandbookPack } = require('../src/handbook.js');
const ORIGINAL_URL = 'https://support.kasfo.or.kr/menu/u02/05_01.asp?SM=02&VA_Page=1&sBrdID=29316';

function resolveNormalizedPath(input) {
  const absolute = path.resolve(input);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    const matches = fs.readdirSync(current).filter(name => name.normalize('NFC') === component.normalize('NFC'));
    if (matches.length !== 1) throw new Error('경로가 없거나 Unicode 정규화 후 여러 파일이 일치합니다. 정확한 경로를 확인하세요.');
    current = path.join(current, matches[0]);
  }
  return current;
}

function headingOf(line) {
  const markdown = line.match(/^(#{1,6})\s+(.{1,180})$/);
  if (markdown) return { title: markdown[2].trim(), level: markdown[1].length, account: false };
  const account = line.match(/^\s*[가-힣]\.\s+(.{2,35})$/);
  // PDF-to-text wrapping can leave "계정과목이\n다. 이러한 ..." at a line start.
  // Sentences and continuation connectives are not Korean alphabetical headings.
  if (account && !/[,!?。]|\.$/.test(account[1]) &&
      !/^(?:이러한|따라서|그러므로|그러나|또한|다만|이를|이에|이와|이때|즉\s|일반적으로|그\s|해당\s|다음\s|이\s)/.test(account[1])) {
    return { title: account[1].trim(), level: 6, account: true };
  }
  const numbered = line.match(/^\s*\d{1,2}[.)]\s+(.{2,70})$/);
  if (numbered && !/[.!?。]$/.test(numbered[1]) && !/\d{1,3}(?:,\d{3})+/.test(numbered[1])) return { title: numbered[1].trim(), level: 5, account: false };
  const example = line.match(/^\s*\[사례[^\]]*\]\s*(.{0,100})$/);
  if (example) return { title: line.trim(), level: 7, account: false };
  return null;
}

function buildHandbookPack(markdown, metadata = {}) {
  if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > 4 * 1024 * 1024 || markdown.includes('\u0000')) throw new Error('원문은 4 MiB 이하 UTF-8 Markdown이어야 합니다.');
  const sourceLines = markdown.replace(/\r\n/g, '\n').split('\n');
  if (sourceLines.some(line => line.length > 4500)) throw new Error('4500자를 넘는 원문 줄은 위치를 보존하여 먼저 검토해야 합니다.');
  const tocStart = sourceLines.findIndex(line => /^목\s*차$/.test(line.trim()));
  const repeated = new Map();
  let bodyStart = -1;
  for (let i = 0; i < sourceLines.length; i++) {
    const heading = sourceLines[i].match(/^#{1,3}\s+(.+)$/);
    if (!heading) continue;
    const key = normalize(heading[1]);
    if (tocStart >= 0 && i > tocStart && repeated.has(key) && repeated.get(key) > tocStart) { bodyStart = i; break; }
    repeated.set(key, i);
  }
  const sections = [];
  let hierarchy = [];
  let active = { title: metadata.title || '해설서', kind: 'explanation', start: 0, hierarchy: [] };
  function emit(end) {
    let start = active.start;
    while (start <= end && !sourceLines[start].trim()) start++;
    while (end >= start && !sourceLines[end].trim()) end--;
    while (start <= end) {
      let stop = start, size = 0;
      while (stop <= end && size + sourceLines[stop].length + (stop > start ? 1 : 0) <= 4200) {
        size += sourceLines[stop].length + (stop > start ? 1 : 0); stop++;
      }
      if (stop === start) stop++;
      // Prefer complete paragraphs, while retaining every source line in its original order.
      if (stop <= end) {
        for (let j = stop - 1; j > start + 6; j--) if (!sourceLines[j].trim()) { stop = j + 1; break; }
      }
      let trimmedStop = stop;
      while (trimmedStop > start && !sourceLines[trimmedStop - 1].trim()) trimmedStop--;
      if (trimmedStop > start) {
        const text = sourceLines.slice(start, trimmedStop).join('\n');
        const toc = tocStart >= 0 && start >= tocStart && bodyStart >= 0 && start < bodyStart;
        sections.push({ id: `lines-${start + 1}-${trimmedStop}`, heading: active.title,
          hierarchy: active.hierarchy, kind: toc ? 'toc' : active.kind,
          start_line: start + 1, end_line: trimmedStop, text, extraction_quality: detectExtractionQuality(text) });
      }
      start = stop;
      while (start <= end && !sourceLines[start].trim()) start++;
    }
  }
  for (let i = 0; i < sourceLines.length; i++) {
    const h = headingOf(sourceLines[i]);
    if (!h) continue;
    emit(i - 1);
    if (i === bodyStart) hierarchy = [];
    hierarchy = hierarchy.filter(item => item.level < h.level);
    const context = hierarchy.map(item => item.title);
    const appendix = context.some(title => /부록|부속명세서|계정과목\s*명세표|세무/.test(title));
    active = { title: h.title, start: i, hierarchy: context,
      kind: h.account ? 'account_section' : appendix ? 'appendix' : 'explanation' };
    hierarchy.push(h);
  }
  emit(sourceLines.length - 1);
  const pack = {
    schema_version: 1, id: 'kasfo-handbook-2023-12', title: '사학기관 재무회계 규칙에 대한 특례규칙 해설서',
    source_kind: 'official_handbook', legal_status: 'interpretive_reference', publisher: '한국사학진흥재단',
    edition: '2023-12', original_url: ORIGINAL_URL, source_checked_at: metadata.source_checked_at || new Date().toISOString().slice(0, 10),
    freshness_status: 'edition_identified_current_law_not_verified',
    source_file: { name: (metadata.source_name || 'handbook.md').normalize('NFC'), format: 'markdown',
      sha256: crypto.createHash('sha256').update(markdown).digest('hex'), line_count: sourceLines.length },
    extraction: { method: 'existing_markdown', quality: 'partial', pages_verified: false, table_structure_verified: false },
    sections,
  };
  return validateHandbookPack(pack);
}

function main(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['--source', '--vault', '--output'].includes(arg) || !argv[i + 1] || argv[i + 1].startsWith('--') || opts[arg]) throw new Error('사용법: node scripts/build-handbook-pack.js (--source 원문.md | --vault 볼트경로) --output 저장소밖/pack.json');
    opts[arg] = argv[++i];
  }
  if ((!opts['--source'] && !opts['--vault']) || (opts['--source'] && opts['--vault']) || !opts['--output']) throw new Error('--source 또는 --vault 중 하나와 --output이 필요합니다.');
  const input = resolveNormalizedPath(opts['--source'] || path.join(opts['--vault'], '04. 매뉴얼', '사학기관_특례규칙_해설서.md'));
  if (path.extname(input).toLowerCase() !== '.md' || !fs.statSync(input).isFile() || fs.statSync(input).size > 4 * 1024 * 1024) throw new Error('지원하는 크기의 Markdown 원문이 아닙니다.');
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(opts['--output']))), path.basename(opts['--output']));
  const repo = fs.realpathSync(path.join(__dirname, '..'));
  const relative = path.relative(repo, output);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('해설서 팩은 공개 저장소 밖에만 생성할 수 있습니다.');
  const text = fs.readFileSync(input, 'utf8');
  if (!/source_published:\s*2023-12/.test(text.slice(0, 4000)) || !/특례규칙[\s_]*해설서/.test(text.slice(0, 4000))) throw new Error('2023.12 특례규칙 해설서 원문 메타데이터를 확인할 수 없습니다.');
  const pack = buildHandbookPack(text, { source_name: path.basename(input) });
  fs.writeFileSync(output, `${JSON.stringify(pack)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: 'built', output, edition: pack.edition, sections: pack.sections.length,
    source_lines: pack.source_file.line_count, extraction_quality: 'partial', pages_verified: false }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { buildHandbookPack, resolveNormalizedPath, headingOf, main };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { appendixHeading, isBodyBoundary } = require('./appendices');
const run = promisify(execFile);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, output: 16 * 1024 * 1024, chunks: 20000, chars: 4000000, timeoutMs: 30000 });

// Offline, optional CLI adapter. Never installs packages or downloads OCR models.
// Failure returns no new evidence; callers keep their existing HWP/HTML result.
async function parseAppendixFile(file, { command = 'kordoc', timeoutMs = LIMITS.timeoutMs, execute = run } = {}) {
  try {
    if (!/\.(hwp|hwpx|pdf)$/i.test(file)) return { status: 'unsupported', chunks: [] };
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs) throw new Error('limit');
    const input = path.resolve(file), stat = fs.statSync(input);
    if (!stat.isFile() || stat.size > LIMITS.bytes) throw new Error('limit');
    const bytes = fs.readFileSync(input);
    const { stdout } = await execute(command, [input, '--format', 'chunks', '--table-format', 'gfm', '--no-images', '--silent'],
      { timeout: timeoutMs, maxBuffer: LIMITS.output, killSignal: 'SIGKILL', windowsHide: true });
    const chunks = JSON.parse(stdout);
    if (!validChunks(chunks)) throw new Error('schema');
    return { status: 'parsed', sha256: hash(bytes), chunks };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'unavailable' : 'failed', chunks: [],
      reason: error.code === 'ENOENT' ? 'KORDOC_OR_INPUT_MISSING' : 'KORDOC_PARSE_FAILED' };
  }
}

function validChunks(chunks) {
  return Array.isArray(chunks) && chunks.length <= LIMITS.chunks &&
    chunks.reduce((n, c) => n + (typeof c?.text === 'string' ? c.text.length : LIMITS.chars + 1), 0) <= LIMITS.chars &&
    new Set(chunks.map(c => c?.id)).size === chunks.length && chunks.every(c => c &&
      typeof c.id === 'string' && /^(text|heading|table)$/.test(c.type) && typeof c.text === 'string' &&
      Array.isArray(c.blockRange) && c.blockRange.length === 2 && c.blockRange.every(n => Number.isSafeInteger(n) && n >= 0) &&
      c.blockRange[1] >= c.blockRange[0] && (c.page === undefined || Number.isSafeInteger(c.page) && c.page > 0));
}

function validSource(source) {
  if (!source || ![source.lawId, source.historyId].every(n => Number.isSafeInteger(n) && n > 0) ||
      typeof source.title !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) return false;
  try { return new URL(source.url).origin === 'https://rule.dongguk.edu'; } catch { return false; }
}

// Kordoc breadcrumbs are not reliable appendix boundaries (a heading may be
// inside a text chunk). Scan the ordered text, retaining the original anchors.
function collectAppendices(chunks, source) {
  if (!validChunks(chunks) || !validSource(source)) throw new TypeError('Invalid appendix input');
  const groups = []; let current = null;
  for (const chunk of chunks) {
    if (chunk.type === 'table') {
      if (current) current.parts.push({ ...chunk });
      continue;
    }
    let pending = [];
    const flush = () => {
      if (current && pending.some(line => line.trim())) current.parts.push({ ...chunk, text: pending.join('\n').trim() });
      pending = [];
    };
    for (const line of chunk.text.split('\n')) {
      const heading = appendixHeading(line);
      if (heading) {
        flush(); current = { key: heading.key, heading: heading.heading, source: { ...source }, parts: [], warnings: [] };
        groups.push(current);
      } else if (current && isBodyBoundary(line)) {
        if (/별지|서식/.test(current.key)) current.warnings.push('AMBIGUOUS_FORM_BOUNDARY');
        else { flush(); current = null; }
        pending.push(line);
      } else pending.push(line);
    }
    flush();
  }
  const counts = new Map();
  groups.forEach(g => counts.set(g.key, (counts.get(g.key) || 0) + 1));
  return groups.map(g => ({ ...g, warnings: [...new Set([...g.warnings,
    ...(g.parts.some(p => p.type === 'table' && !gfmRows(p.text)) ? ['UNSUPPORTED_TABLE_LAYOUT'] : []),
    ...(counts.get(g.key) > 1 ? ['DUPLICATE_APPENDIX_KEY'] : [])])] }));
}

function gfmRows(text) {
  const lines = text.split('\n').filter(line => /^\s*\|/.test(line));
  const cells = line => line.trim().slice(1, -1).split(/(?<!\\)\|/).map(s => s.trim());
  if (lines.length < 3 || !cells(lines[1]).every(s => /^:?-{3,}:?$/.test(s))) return null;
  if (lines.slice(2).some(line => cells(line).every(s => /^:?-{3,}:?$/.test(s)))) return null;
  const rows = [cells(lines[0]), ...lines.slice(2).map(cells)];
  if (rows.some(row => row.length !== rows[0].length)) return null;
  return { lines: [lines[0], ...lines.slice(2)], separator: lines[1], rows };
}

// Whole rows, repeated header and unit context, never arbitrary character cuts.
// Ditto marks remain literal: resolving them would be a separate interpretation.
function appendixPassages(groups) {
  const passages = [];
  for (const group of groups) {
    if (group.warnings.length) continue;
    const { source } = group;
    const prefix = `${source.title}\n${group.heading}`;
    const nodeId = `ap:${source.lawId}:${source.historyId}:${source.sha256.slice(0, 16)}:${group.key}`;
    const preamble = []; let tablesSeen = 0;
    for (const [partIndex, part] of group.parts.entries()) {
      const common = { lawId: source.lawId, historyId: source.historyId, appendix: group.key, appendixId: nodeId,
        source: { ...source }, chunkId: part.id, blockRange: part.blockRange, page: part.page,
        // Full appendix evidence is kept separately; passage text is for retrieval.
        partIndex };
      if (part.type !== 'table') {
        if (!tablesSeen) preamble.push(part.text);
        passages.push({ ...common, id: `${nodeId}:${partIndex}:text`, type: 'note', text: `${prefix}\n${part.text}` });
        continue;
      }
      tablesSeen++;
      const table = gfmRows(part.text);
      if (!table) continue;
      let headerCount = 1;
      while (headerCount < Math.min(4, table.rows.length - 1) && table.rows[headerCount][0] &&
        table.rows[headerCount][0] === table.rows[0][0]) headerCount++;
      const header = [table.lines[0], table.separator, ...table.lines.slice(1, headerCount)].join('\n');
      for (let row = headerCount; row < table.rows.length; row++) {
        passages.push({ ...common, id: `${nodeId}:${partIndex}:row:${row + 1}`, type: 'table-row', row: row + 1,
          text: [prefix, ...preamble, header, table.lines[row]].join('\n'),
          rowText: table.lines[row], tableRows: table.rows.length, tableColumns: table.rows[0].length });
      }
    }
  }
  return passages;
}

// Sidecar graph: no inferred hierarchy and no cross-rule appendix-number links.
// Only explicit, unqualified references in a matching revision are connected.
function buildAppendixGraph(groups, corpus) {
  const nodes = [], edges = [];
  for (const group of groups) {
    const passages = appendixPassages([group]);
    if (!passages.length) continue;
    const id = passages[0].appendixId, s = group.source;
    nodes.push({ id, kind: 'appendix', lawId: s.lawId, historyId: s.historyId, appendix: group.key,
      source: s, text: [group.heading, ...group.parts.map(p => p.text)].join('\n\n') });
    for (const passage of passages) {
      nodes.push({ ...passage, kind: 'appendix-chunk' });
      edges.push({ from: id, to: passage.id, type: 'contains' });
    }
    const rule = corpus?.rules?.find(r => r.lawId === s.lawId && r.historyId === s.historyId);
    for (const [blockIndex, block] of (rule?.blocks || []).entries()) {
      if (block.supplementary) continue;
      for (const sentence of block.content.split(/(?<=[.!?。])\s+/)) {
        // Conservatively leave named/external references to the main rule graph.
        if (/[「『].*[」』]|(?:규정|세칙|법률|시행령|시행규칙)의?\s*\[?별/.test(sentence)) continue;
        const references = sentence.matchAll(/(별\s*표|별\s*지(?:\s*서\s*식)?|서\s*식)\s*(?:제\s*)?(\d+(?:\s*(?:의|-)\s*\d+)?)(?:\s*호)?/g);
        if ([...references].some(m => `${m[1].replace(/\s/g, '')} ${m[2].replace(/\s/g, '')}` === group.key)) {
          const from = `a:${s.lawId}:${blockIndex}`;
          if (!nodes.some(n => n.id === from)) nodes.push({ id: from, kind: 'article', lawId: s.lawId, historyId: s.historyId, blockIndex, article: block.article });
          if (!edges.some(e => e.from === from && e.to === id)) edges.push({ from, to: id, type: 'appendix', evidence: sentence });
        }
      }
    }
  }
  return { version: 1, nodes, edges };
}

module.exports = { LIMITS, parseAppendixFile, validChunks, collectAppendices, appendixPassages, buildAppendixGraph, gfmRows };

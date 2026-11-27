'use strict';

// Explicit offline experiment command, never called by the production server.
// Manifest: {file, source:{lawId,historyId,title,url}, corpus?}. file is relative
// to the manifest; corpus must be the exact current revision for graph edges.
const fs = require('node:fs');
const path = require('node:path');
const { parseAppendixFile, collectAppendices } = require('../src/appendix-kordoc');
const { buildAppendixIndex, saveAppendixIndex } = require('../src/appendix-index');
const { createEmbedder } = require('../src/semantic');

async function main() {
  const [manifestFile, output] = process.argv.slice(2);
  if (!manifestFile || !output || fs.existsSync(output)) throw new Error('manifest.json과 새 출력 경로를 지정하세요.');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const result = await parseAppendixFile(path.resolve(path.dirname(manifestFile), manifest.file));
  if (result.status !== 'parsed') { console.log(JSON.stringify({ ...result, fallback: 'existing_source_unchanged' })); return; }
  const groups = collectAppendices(result.chunks, { ...manifest.source, sha256: result.sha256 });
  if (!groups.length) { console.log(JSON.stringify({ status: 'no_appendices', fallback: 'existing_source_unchanged' })); return; }
  let embedder;
  try { embedder = await createEmbedder({ directory: path.dirname(output), download: false }); }
  catch { console.log(JSON.stringify({ status: 'semantic_unavailable', fallback: 'existing_source_unchanged' })); return; }
  const index = await buildAppendixIndex({ groups, corpus: manifest.corpus, embedder });
  if (!index) { console.log(JSON.stringify({ status: 'no_indexable_appendices', fallback: 'existing_source_unchanged',
    warnings: groups.flatMap(g => g.warnings.map(code => ({ appendix: g.key, code }))) })); return; }
  saveAppendixIndex(output, index);
  console.log(JSON.stringify({ status: 'built', file: output, passages: index.passages.length, nodes: index.graph.nodes.length,
    edges: index.graph.edges.length, warnings: groups.flatMap(g => g.warnings.map(code => ({ appendix: g.key, code }))) }));
}
main().catch(() => { console.error('별표 실험 색인 빌드 실패. 기존 색인은 변경하지 않았습니다.'); process.exitCode = 1; });

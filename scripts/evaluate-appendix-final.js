'use strict';
// Exact t10w harness, isolated cache for every condition and branch.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { EXPECTED, hash, verifyHandoff } = require('./appendix-final-input');
const { loadOpenQuestions } = require('./appendix-open-questions');
const root = path.resolve(__dirname, '..');
const reference = require('../experiments/appendix/results/t10w-reference-manifest.json');
const baselineHead = dir => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4) throw new Error('HANDOFF_REFERENCE_BASELINE_NEW_OUTPUT_REQUIRED');
  const [handoff, source, baseline, output] = args.map(x => path.resolve(x));
  if (fs.existsSync(output) || output.startsWith(handoff + path.sep) || output.startsWith(source + path.sep)) throw new Error('NEW_ISOLATED_OUTPUT_REQUIRED');
  if (baselineHead(baseline) !== EXPECTED.commit) throw new Error('BASELINE_COMMIT_MISMATCH');
  const identity = verifyHandoff(handoff);
  const wide = ['train', 'dev', ...Array.from({ length: 8 }, (_, i) => 'probe' + (i + 1))];
  const datasets = { public251: wide, probe9: ['probe9'], dev_open: ['dev_open'] };
  const files = ['harness-d1.js', ...[...wide, 'probe9'].map(s => `sets/${s}.json`), 'gen/kw-all-sonnet.json', 'gen/kw-all-haiku.json'];
  fs.mkdirSync(output, { recursive: true });
  const inputs = {};
  for (const file of files) {
    if (hash(path.join(source, file)) !== reference.sha256[file]) throw new Error('REFERENCE_INPUT_CHANGED: ' + file);
    const to = path.join(output, file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(source, file), to);
    inputs[file] = hash(to);
  }
  const open = loadOpenQuestions();
  // Exact approved bytes remain in the fixture. The query-only projection is
  // necessary because t10w's harness otherwise passes author args by default.
  const openFile = path.join(output, 'sets/dev_open.json');
  fs.writeFileSync(openFile, JSON.stringify(open.questions.map(({ args, ...q }) => q)));
  inputs['dev_open.original'] = open.sha256; inputs['dev_open.query-only'] = hash(openFile);
  const runs = [];
  for (const dataset of Object.keys(datasets)) for (const semantic of ['off', 'on']) {
    for (const keywords of dataset === 'public251' ? ['query', 'sonnet', 'haiku'] : ['query']) {
      for (const [branch, worktree] of [['baseline', baseline], ['appendix', root]]) runs.push({ dataset, semantic, keywords, branch, worktree });
    }
  }
  const corpus = JSON.parse(fs.readFileSync(path.join(identity.public, 'corpus/corpus-v1.json')));
  const idSets = Object.fromEntries(Object.entries(datasets).map(([name, sets]) => [name, Object.fromEntries(sets.flatMap(set =>
    JSON.parse(fs.readFileSync(path.join(output, 'sets', set + '.json'))).map(q => [q.id, set + ':' + q.id])))]));
  for (const run of runs) {
    const tag = [run.dataset, run.semantic, run.keywords, run.branch].join('-');
    const cache = path.join(output, 'cache-' + tag), pub = path.join(cache, 'dongguk-rule-mcp/v2/public');
    fs.cpSync(identity.public, pub, { recursive: true });
    fs.mkdirSync(path.join(pub, 'catalog'));
    fs.writeFileSync(path.join(pub, 'catalog/all.json'), JSON.stringify(corpus.rules.map(({ blocks, ...rule }) => rule)));
    const log = fs.openSync(path.join(output, tag + '.log'), 'wx');
    const env = { ...process.env, NL_WORKTREE: run.worktree, NL_CACHE: path.relative(output, cache), NL_OFFLINE: '1',
      NL_SAVE: path.join(output, tag + '.json'), APPENDIX_RECORD: path.join(output, tag + '.rows.json'),
      DONGGUK_MCP_SEMANTIC: run.semantic === 'on' ? '1' : '0', DONGGUK_MCP_SEMANTIC_TIMEOUT_MS: '120000' };
    delete env.NL_KW;
    if (run.keywords !== 'query') env.NL_KW = path.join(output, 'gen', `kw-all-${run.keywords}.json`);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--require', path.join(__dirname, 'appendix-t10w-recorder.js'), path.join(output, 'harness-d1.js'), datasets[run.dataset].join(',')], { env, stdio: ['ignore', log, log] });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('HARNESS_FAILED: ' + tag + ' ' + code)));
      });
    } finally { fs.closeSync(log); }
    const rows = JSON.parse(fs.readFileSync(env.APPENDIX_RECORD));
    run.file = tag + '.rows.json'; run.sha256 = hash(env.APPENDIX_RECORD);
    run.total = rows.length; run.strict = rows.filter(r => r.bodyIncluded).length; run.top3 = rows.filter(r => r.top3).length;
    run.wrong = rows.filter(r => !r.bodyIncluded).map(r => idSets[run.dataset][r.id]);
    run.errors = rows.filter(r => r.error).map(r => ({ id: idSets[run.dataset][r.id], error: r.error }));
    if (run.total !== Object.keys(idSets[run.dataset]).length) throw new Error('QUESTION_COUNT_MISMATCH');
    for (const e of JSON.parse(fs.readFileSync(path.join(handoff, 'manifest.json'))).entries) if (hash(path.join(pub, e.path)) !== e.sha256) throw new Error('COPIED_INPUT_CHANGED: ' + e.path);
    console.log(JSON.stringify({ tag, total: run.total, strict: run.strict, top3: run.top3, wrong: run.wrong, errors: run.errors }));
  }
  const comparisons = runs.filter(r => r.branch === 'baseline').map(before => {
    const after = runs.find(r => r.branch === 'appendix' && r.dataset === before.dataset && r.semantic === before.semantic && r.keywords === before.keywords);
    const left = JSON.parse(fs.readFileSync(path.join(output, before.file))), right = JSON.parse(fs.readFileSync(path.join(output, after.file)));
    const key = idSets[before.dataset];
    return { dataset: before.dataset, semantic: before.semantic, keywords: before.keywords,
      newWrong: after.wrong.filter(id => !before.wrong.includes(id)), fixed: before.wrong.filter(id => !after.wrong.includes(id)),
      responseDifferences: right.filter((r, i) => JSON.stringify(r.rules) !== JSON.stringify(left[i].rules)).map(r => key[r.id]) };
  });
  verifyHandoff(handoff);
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ identity, harnessSha256: inputs['harness-d1.js'],
    experimentCommit: baselineHead(root), baselineCommit: EXPECTED.commit, inputs, trainingOrTuning: false,
    sourceUnchanged: true, network: 'NL_OFFLINE=1; no live requests', cachePolicy: '733 byte-identical files per run; catalog/history derived from fixed corpus; no prior search cache', runs, comparisons }, null, 2) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

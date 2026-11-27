'use strict';

// The D1 offline replay engine is reused without changing its scoring or server
// code. It may write history/search caches only in the new private copies below.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadOpenQuestions } = require('./appendix-open-questions');
const { measure, summarize, comparison, validatedCaches } = require('./d1-baseline');
const root = path.resolve(__dirname, '..');
const suffix = 'dongguk-rule-mcp/v2/public';
const baseCommit = '907b998a095ffbe7c490fdb961dc90b090ddbf5e';
const corpusHash = '59c2e11fe66e57af1ad2e88d732b12e42233ec1446e9a9d43784754e464dcb15';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function identities(cache) {
  const folder = path.join(cache, suffix), corpus = path.join(folder, 'corpus/corpus-v1.json'), meta = path.join(folder, 'semantic/semantic-v1.json');
  const description = JSON.parse(fs.readFileSync(meta));
  if (hash(corpus) !== corpusHash || description.textVersion !== 3 || description.vectorHash !== 'c76feb89f199072fecf644f59f1c880519595276b8ec3af54f7a539388da2f7e') throw new Error('D1_INPUT_MISMATCH');
  const vector = path.join(folder, 'semantic', description.vectorFile);
  if (hash(vector) !== description.vectorHash) throw new Error('D1_VECTOR_MISMATCH');
  return { corpusSha256: corpusHash, textVersion: 3, vectorFile: description.vectorFile,
    sourceHashes: Object.fromEntries([corpus, meta, vector].map(file => [file, hash(file)])) };
}

async function main() {
  if (process.argv.length !== 6) throw new Error('SNAPSHOT_REPO_HTML_NEW_OUTPUT_REQUIRED');
  const [snapshotRoot, baselineRepo, htmlDir, output] = process.argv.slice(2).map(arg => path.resolve(arg));
  if (!snapshotRoot || !baselineRepo || !htmlDir || !output || fs.existsSync(output)) throw new Error('SNAPSHOT_REPO_HTML_NEW_OUTPUT_REQUIRED');
  if (output.startsWith(snapshotRoot + path.sep)) throw new Error('OUTPUT_INSIDE_SOURCE_SNAPSHOT');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baselineRepo, encoding: 'utf8' }).trim() !== baseCommit) throw new Error('BASELINE_COMMIT_MISMATCH');
  const source = identities(snapshotRoot), approved = loadOpenQuestions();
  fs.mkdirSync(output, { recursive: true });
  const beforeCache = path.join(output, 'baseline-cache'), afterCache = path.join(output, 'appendix-cache');
  fs.cpSync(snapshotRoot, beforeCache, { recursive: true });
  fs.cpSync(snapshotRoot, afterCache, { recursive: true });
  validatedCaches(beforeCache, afterCache);
  const options = { snapshotCache: beforeCache, htmlDir, timeout: 60000, useArgs: false };
  const tags = new Map(approved.questions.map(q => [q.id, q.tags]));
  const originalSetting = process.env.DONGGUK_MCP_SEMANTIC;
  try {
    for (const mode of ['off', 'on']) {
      process.env.DONGGUK_MCP_SEMANTIC = mode === 'on' ? '1' : '0';
      const before = await measure('D1-' + mode, beforeCache, baselineRepo, approved.questions, options);
      const after = await measure('appendix-' + mode, afterCache, root, approved.questions, options);
      const byTag = Object.fromEntries(['S', 'C', 'D'].map(tag => {
        const left = before.results.filter(row => tags.get(row.id).includes(tag));
        const right = after.results.filter(row => tags.get(row.id).includes(tag));
        return [tag, { before: summarize(left), after: summarize(right), diff: comparison(left, right) }];
      }));
      for (const [file, expected] of Object.entries(source.sourceHashes)) if (hash(file) !== expected) throw new Error('READONLY_SOURCE_CHANGED');
      const report = { baselineCommit: baseCommit, experimentCommit: after.gitHead, ...source,
        sourceUnchanged: true, questionFile: approved.file, questionSha256: approved.sha256,
        mode, argsMode: 'query-only; question args ignored', trainingOrTuning: false, tagGroupsOverlap: true,
        before, after, diff: comparison(before.results, after.results), byTag,
        responseDifferences: after.results.filter((row, i) => JSON.stringify(row.rules) !== JSON.stringify(before.results[i].rules)).map(row => row.id) };
      fs.writeFileSync(path.join(output, `public-${mode}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ mode, before: before.summary.strict, after: after.summary.strict,
        newWrong: report.diff.strict.newWrong, responseDifferences: report.responseDifferences }));
    }
  } finally {
    if (originalSetting === undefined) delete process.env.DONGGUK_MCP_SEMANTIC;
    else process.env.DONGGUK_MCP_SEMANTIC = originalSetting;
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

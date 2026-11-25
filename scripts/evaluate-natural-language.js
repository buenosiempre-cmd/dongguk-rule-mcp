'use strict';
// Opt-in live evaluation through the shipped MCP server. No network on import.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const DEFAULT_QUESTIONS = path.join(__dirname, '../test/fixtures/natural-language-questions.json');
const normalize = value => String(value || '').replace(/\s+/g, '').toLowerCase();

function validateQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('Questions must be a nonempty array');
  for (const row of questions) {
    if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string' || !row[0].trim()
      || !(row[1] === null || (Array.isArray(row[1]) && row[1].length && row[1].every(t => typeof t === 'string' && t.trim())))
      || !(row[2] === null || (typeof row[2] === 'string' && row[2].trim()))
      || (row[1] === null && row[2] !== null)) throw new Error('Invalid question row: expected [query, titles|null, excerptKeyword|null]');
  }
  return questions;
}

function scoreResponse([query, expectedTitles, expectedExcerpt], response) {
  const sc = response?.structuredContent;
  const rules = Array.isArray(sc?.data?.rules) ? sc.data.rules.slice(0, 3) : [];
  const error = sc?.ok === true && rules.length ? null : sc?.error?.code || 'INVALID_RESPONSE';
  const matches = rule => expectedTitles?.some(title => normalize(rule.title).includes(normalize(title)));
  const rank = rules.findIndex(matches);
  const scored = expectedTitles !== null;
  const top1 = scored ? !error && rank === 0 : null;
  const top3 = scored ? !error && rank >= 0 : null;
  const excerptMatch = scored && expectedExcerpt !== null
    ? !error && rules.some(rule => matches(rule) && normalize(rule.excerpt?.text).includes(normalize(expectedExcerpt))) : null;
  return {
    query, expectedTitles, expectedExcerpt, scored, error,
    rank: scored && !error && rank >= 0 ? rank + 1 : null, top1, top3, excerptMatch,
    passed: scored ? top3 && excerptMatch !== false : null,
    searchMode: sc?.data?.search?.mode || null,
    identityStatus: sc?.data?.search?.identityStatus || null,
    rules: rules.map(rule => ({
      lawId: rule.lawId, historyId: rule.historyId, title: rule.title, revisedAt: rule.revisedAt,
      sourceUrl: rule.sourceUrl, sourceType: rule.sourceType, evidenceStatus: rule.evidenceStatus,
      incompleteReasons: rule.incompleteReasons, excerpt: rule.excerpt?.text || '',
    })),
  };
}

async function evaluate(questions, call, onResult = () => {}) {
  validateQuestions(questions);
  const results = [];
  for (const question of questions) {
    const started = Date.now();
    let response;
    try { response = await call(question[0]); }
    catch { response = { structuredContent: { ok: false, error: { code: 'CALL_FAILED' } } }; }
    const result = { ...scoreResponse(question, response), elapsedMs: Date.now() - started };
    results.push(result);
    onResult(result, results.length);
  }
  const scored = results.filter(r => r.scored);
  return {
    total: results.length, scored: scored.length, unscored: results.length - scored.length,
    top1: scored.filter(r => r.top1).length, top3: scored.filter(r => r.top3).length,
    excerptEvaluated: scored.filter(r => r.excerptMatch !== null).length,
    excerptMatched: scored.filter(r => r.excerptMatch === true).length,
    passed: scored.filter(r => r.passed).length, failed: scored.filter(r => !r.passed).length,
    errors: results.filter(r => r.error).length, results,
  };
}

function parseArgs(args) {
  const options = { questions: DEFAULT_QUESTIONS, output: null, timeout: 60000 };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help') return { help: true };
    if (!['--questions', '--output', '--timeout'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid option: ${name}`);
    options[name.slice(2)] = args[++i];
  }
  options.timeout = Number(options.timeout);
  if (!Number.isSafeInteger(options.timeout) || options.timeout < 1) throw new Error('--timeout must be a positive integer (milliseconds)');
  return options;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: npm run evaluate:natural-language -- [--questions FILE] [--output NEW_FILE] [--timeout MS]\nRequires a local index built with node src/index.js --build-index. Calls the MCP server with normal public caches; this is not a cache-free benchmark. Exit 0: all scored rows pass and no call errors; 1: mismatch/error.');
    return;
  }
  const questions = validateQuestions(JSON.parse(fs.readFileSync(options.questions, 'utf8')));
  if (options.output && fs.existsSync(options.output)) throw new Error('Output already exists; choose a new file');
  const client = new Client({ name: 'natural-language-evaluation', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(__dirname, '../src/index.js')],
    env: { ...process.env, DONGGUK_MCP_PROFILE: 'rules', DONGGUK_RULE_COOKIE: '', DONGGUK_MCP_NO_CACHE: '0', DONGGUK_LEGAL_MCP_ENABLED: '0', DONGGUK_FINANCE_PACK_PATH: '' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    transport.stderr?.resume();
    const info = await client.callTool({ name: 'get_service_info', arguments: {} });
    const index = info.structuredContent?.data?.fullTextIndex;
    if (!index?.available) throw new Error('Local index unavailable; run node src/index.js --build-index first');
    const startedAt = new Date().toISOString();
    const evaluation = await evaluate(questions,
      query => client.callTool({ name: 'lookup_dongguk_rule', arguments: { query } }, undefined, { timeout: options.timeout }),
      (result, number) => console.error(`[${number}/${questions.length}] ${result.error || (result.scored ? (result.passed ? 'PASS' : 'FAIL') : 'UNSCORED')} ${result.query}`));
    const report = {
      startedAt, completedAt: new Date().toISOString(), serverVersion: client.getServerVersion()?.version,
      questionsFile: path.resolve(options.questions), index, cache: 'normal public cache (not forced fresh)',
      method: 'Returned rules only, first three; whitespace-insensitive title substring and excerpt keyword checks. Null titles are unscored. Pass requires top3 and, when specified, keyword in a matching rule excerpt. This measures retrieval, not legal correctness or applicability.',
      ...evaluation,
    };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (options.output) fs.writeFileSync(options.output, json, { flag: 'wx' });
    process.stdout.write(json);
    if (report.failed || report.errors) process.exitCode = 1;
  } finally {
    await client.close();
    await transport.close();
  }
}

if (require.main === module) main().catch(error => { console.error(`Evaluation failed: ${error.message}`); process.exitCode = 1; });
module.exports = { validateQuestions, scoreResponse, evaluate, parseArgs };

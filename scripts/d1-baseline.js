'use strict';

// D1 regression comparison: only the explicitly approved public train/dev files.
// Each side uses a fresh, network-disabled MCP process and its own cache root.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const benchmark = require('./benchmark-natural-language');

const DEFAULT_REPO = path.resolve(__dirname, '..');
const DATASET_DIR = path.join(os.homedir(), 'herdr-work/rule_mcp_upgrade/자연어평가셋_20261126');
const CACHE_SUFFIX = 'dongguk-rule-mcp/v2/public';
const NETWORK_MARKER = 'D1_OFFLINE_NETWORK_BLOCKED';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function parseArgs(args) {
  const options = { beforeRepo: DEFAULT_REPO, afterRepo: DEFAULT_REPO, timeout: 60000, useArgs: false };
  const keys = { '--before-cache': 'beforeCache', '--after-cache': 'afterCache', '--before-repo': 'beforeRepo', '--after-repo': 'afterRepo', '--html-dir': 'htmlDir', '--output': 'output', '--timeout': 'timeout' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    if (args[i] === '--with-question-args') { options.useArgs = true; continue; }
    const key = keys[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_OPTIONS');
    options[key] = args[++i];
  }
  options.timeout = Number(options.timeout);
  if (!options.beforeCache || !options.afterCache || !options.output || !Number.isSafeInteger(options.timeout) || options.timeout < 1) throw new Error('MISSING_OPTIONS');
  return options;
}

function loadQuestions() {
  const questions = [], files = [];
  for (const split of ['train', 'dev']) {
    const filename = path.join(DATASET_DIR, `${split}.json`);
    const bytes = fs.readFileSync(filename);
    const rows = benchmark.validateQuestions(JSON.parse(bytes));
    if (rows.some(Array.isArray)) throw new Error('OBJECT_QUESTIONS_REQUIRED');
    files.push({ split, filename, sha256: sha(bytes), count: rows.length });
    questions.push(...rows.map(row => ({ ...row, split })));
  }
  if (new Set(questions.map(row => row.id)).size !== questions.length) throw new Error('DUPLICATE_QUESTION_IDS');
  return { questions, files };
}

function validatedCaches(beforeRoot, afterRoot) {
  const roots = [beforeRoot, afterRoot].map(root => fs.realpathSync(path.resolve(root)));
  const publicDirs = roots.map(root => fs.realpathSync(path.join(root, CACHE_SUFFIX)));
  const original = fs.realpathSync(path.join(os.homedir(), '.cache', CACHE_SUFFIX));
  if (publicDirs[0] === publicDirs[1] || publicDirs.includes(original)) throw new Error('ISOLATED_CACHES_REQUIRED');
  for (const publicDir of publicDirs) {
    const corpus = fs.realpathSync(path.join(publicDir, 'corpus/corpus-v1.json'));
    if (!corpus.startsWith(publicDir + path.sep)) throw new Error('CACHE_SYMLINK_OUTSIDE_ISOLATION');
  }
  return roots;
}

function sourceIdentity(repo) {
  const sourceDir = path.join(repo, 'src');
  const hashes = Object.fromEntries(fs.readdirSync(sourceDir).filter(name => name.endsWith('.js')).sort()
    .map(name => [name, sha(fs.readFileSync(path.join(sourceDir, name)))]));
  return { repository: repo, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sourceHashes: hashes };
}

function strictResult(result, question) {
  return { ...result, split: question.split, strict: !result.error && result.matched.some(match => match.rank <= 3) };
}

function summarize(results) {
  const base = benchmark.statistics(results);
  const strictHits = results.filter(row => row.strict).length;
  return { ...base, strict: { hits: results.filter(row => row.strict).length, total: results.length,
    rate: results.length ? strictHits / results.length : null },
    articleGivenTop3: { hits: strictHits, total: base.top3.hits, rate: base.top3.hits ? strictHits / base.top3.hits : null } };
}

function comparison(before, after) {
  const byId = new Map(before.map(row => [row.id, row]));
  if (before.length !== after.length || after.some(row => !byId.has(row.id))) throw new Error('QUESTION_SET_MISMATCH');
  const metrics = ['strict', 'top3', 'bodyIncluded'];
  return Object.fromEntries(metrics.map(metric => [metric, {
    newWrong: after.filter(row => byId.get(row.id)[metric] && !row[metric]).map(row => ({ id: row.id, split: row.split, query: row.query,
      before: { matched: byId.get(row.id).matched, ruleIds: byId.get(row.id).rules.map(rule => rule.lawId) },
      after: { matched: row.matched, ruleIds: row.rules.map(rule => rule.lawId), error: row.error } })),
    fixed: after.filter(row => !byId.get(row.id)[metric] && row[metric]).map(row => ({ id: row.id, split: row.split })),
  } ]));
}

async function measure(label, cacheRoot, repo, questions, options) {
  // Freeze the approved snapshot's cache freshness without touching source cache bytes.
  const now = new Date();
  for (const category of ['catalog', 'history']) {
    const folder = path.join(cacheRoot, CACHE_SUFFIX, category);
    if (fs.existsSync(folder)) for (const file of fs.readdirSync(folder).filter(name => name.endsWith('.json'))) fs.utimesSync(path.join(folder, file), now, now);
  }
  const indexPath = path.join(cacheRoot, CACHE_SUFFIX, 'corpus/corpus-v1.json');
  const beforeHash = sha(fs.readFileSync(indexPath));
  const source = sourceIdentity(repo);
  let blockedNetworkAttempts = 0, snapshotReplays = 0, stderrTail = '';
  const snapshotFailures = {};
  const client = new Client({ name: 'd1-offline-baseline', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [__filename, '--serve-offline', path.join(repo, 'src/index.js')],
    env: { ...process.env, NODE_PATH: path.join(DEFAULT_REPO, 'node_modules'), XDG_CACHE_HOME: cacheRoot, DONGGUK_MCP_PROFILE: 'rules', DONGGUK_RULE_COOKIE: '',
      D1_SNAPSHOT_CACHE: options.snapshotCache, D1_HTML_DIR: options.htmlDir,
      DONGGUK_MCP_NO_CACHE: '0', DONGGUK_LEGAL_MCP_ENABLED: '0', DONGGUK_FINANCE_PACK_PATH: '' }, stderr: 'pipe' });
  try {
    const collectStderr = bytes => {
      const text = stderrTail + bytes.toString('utf8');
      const lines = text.split('\n'); stderrTail = lines.pop();
      blockedNetworkAttempts += lines.filter(line => line === NETWORK_MARKER).length;
      snapshotReplays += lines.filter(line => line === 'D1_SNAPSHOT_REPLAY').length;
      for (const line of lines) if (/^D1_SNAPSHOT_FAILURE [A-Z_]+$/.test(line)) {
        const code = line.slice('D1_SNAPSHOT_FAILURE '.length); snapshotFailures[code] = (snapshotFailures[code] || 0) + 1;
      }
    };
    let stderrAttached = false;
    if (transport.stderr) { transport.stderr.on('data', collectStderr); stderrAttached = true; }
    await client.connect(transport);
    if (!stderrAttached) transport.stderr?.on('data', collectStderr);
    const info = await client.callTool({ name: 'get_service_info', arguments: {} }, undefined, { timeout: options.timeout });
    const index = info.structuredContent?.data?.fullTextIndex;
    if (!index?.available) throw new Error('INDEX_UNAVAILABLE');
    const evaluation = await benchmark.evaluate(questions, (_query, args) => client.callTool({ name: 'lookup_dongguk_rule', arguments: args }, undefined, { timeout: options.timeout }),
      (row, n) => console.error(`${label} ${n}/${questions.length} ${row.id}: ${row.error || (row.matched.some(match => match.rank <= 3) ? 'STRICT_HIT' : 'MISS')}`),
      undefined, { useArgs: options.useArgs });
    const results = evaluation.results.map((row, i) => strictResult(row, questions[i]));
    if (sha(fs.readFileSync(indexPath)) !== beforeHash) throw new Error('INDEX_CHANGED_DURING_MEASUREMENT');
    if (JSON.stringify(sourceIdentity(repo).sourceHashes) !== JSON.stringify(source.sourceHashes)) throw new Error('SOURCE_CHANGED_DURING_MEASUREMENT');
    return { ...source, cacheRoot, indexSha256: beforeHash, index, blockedNetworkAttempts, snapshotReplays, snapshotFailures,
      semanticRuntimeConfigured: !!process.env.DONGGUK_MCP_SEMANTIC_RUNTIME,
      semanticUsedQuestions: results.filter(row => row.search?.semantic === true).length,
      summary: summarize(results), splits: Object.fromEntries(['train', 'dev'].map(split => [split, summarize(results.filter(row => row.split === split))])), results };
  } finally { await client.close(); await transport.close(); }
}

function serveOffline(entry) {
  function blocked(target) {
    process.stderr.write(NETWORK_MARKER + '\n');
    if (process.env.D1_OFFLINE_TRACE === '1' && target?.hostname === 'rule.dongguk.edu') {
      const pathname = String(target.path || '').split('?')[0];
      if (/^\/[a-zA-Z0-9/._-]*$/.test(pathname)) process.stderr.write(`D1_OFFLINE_PATH ${pathname}\n`);
    }
    throw Object.assign(new Error(NETWORK_MARKER), { code: NETWORK_MARKER });
  }
  for (const name of ['node:http', 'node:https']) {
    const module = require(name); module.request = blocked; module.get = blocked;
  }
  const net = require('node:net'); net.connect = blocked; net.createConnection = blocked;
  net.Socket.prototype.connect = blocked;
  require('node:tls').connect = blocked;
  globalThis.fetch = async () => blocked();
  require('node:module').syncBuiltinESMExports();
  if (process.env.D1_SNAPSHOT_CACHE) installSnapshotAdapter(entry);
  // index.js starts its CLI only as the main module; run it as that module after installing guards.
  process.argv = [process.execPath, entry];
  require('node:module').runMain(entry);
}

function installSnapshotAdapter(entry) {
  const publicDir = path.join(process.env.D1_SNAPSHOT_CACHE, CACHE_SUFFIX);
  const catalog = JSON.parse(fs.readFileSync(path.join(publicDir, 'catalog/all.json'), 'utf8'));
  const approved = new Map(catalog.map(rule => [`${rule.lawId}_${rule.historyId}`, rule]));
  const escape = text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const compact = text => String(text || '').replace(/\s+/g, '');
  const fetchPath = require('node:module').createRequire(entry).resolve('node-fetch');
  const fail = code => { process.stderr.write(`D1_SNAPSHOT_FAILURE ${code}\n`); throw Object.assign(new Error(code), { code }); };
  require(fetchPath);
  require.cache[fetchPath].exports = async (url, request = {}) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== 'https://rule.dongguk.edu') return fail('OFFLINE_UNSUPPORTED_ORIGIN');
    let html;
    if (parsed.pathname === '/lmxsrv/search/lawSerach.srv') {
      const params = new URLSearchParams(request.body);
      if (params.get('SEARCH_TYPE') !== 'LAWNAME' || !['0', null].includes(params.get('LAWGROUP'))) return fail('OFFLINE_UNSUPPORTED_SEARCH');
      const query = compact(params.get('SEARCH_TEXT'));
      const hits = catalog.filter(rule => compact(rule.title).includes(query));
      const page = Math.max(1, Number(params.get('PAGE')) || 1), size = Math.max(1, Number(params.get('PAGE_SHOW')) || 10);
      const rows = hits.slice((page - 1) * size, page * size).map(rule => `<tr><td class="tbody_txt"><a href="javascript:lawSearchFullViewSrv('${rule.lawId}','${rule.historyId}')"></a><span onclick="showSearchText(${escape(JSON.stringify(rule.code || ''))})"></span><span onclick="showSearchText(${escape(JSON.stringify(rule.title))})"></span></td><td class="tbody_c"><span onclick="showDate('${String(rule.revisedAt || '').replace(/\D/g, '')}')"></span></td></tr>`);
      html = `<p class="infoLeft"><span>${hits.length}</span>건</p><table><tbody class="tbody">${rows.join('')}</tbody></table>`;
    } else if (parsed.pathname === '/lmxsrv/law/lawFullContent.srv') {
      const lawId = parsed.searchParams.get('SEQ'), historyId = parsed.searchParams.get('SEQ_HISTORY');
      const key = `${lawId}_${historyId}`;
      if (!approved.has(key)) return fail('OFFLINE_UNPINNED_CONTENT');
      const file = path.join(process.env.D1_HTML_DIR, `${key}.html`);
      if (!fs.existsSync(file)) return fail('OFFLINE_HTML_MISSING');
      html = fs.readFileSync(file, 'utf8');
    } else if (parsed.pathname === '/lmxsrv/law/lawFullView.srv') {
      const params = new URLSearchParams(request.body);
      const lawId = Number(params.get('SEQ') || parsed.searchParams.get('SEQ'));
      const rule = catalog.find(item => item.lawId === lawId);
      if (!rule) return fail('OFFLINE_UNPINNED_HISTORY');
      html = `<select id="histroySeq"><option value="${rule.historyId}" onclick="showDate('${String(rule.revisedAt || '').replace(/\D/g, '')}')"></option></select>`;
    } else {
      // HWP downloads and unsupported endpoints are never fabricated.
      process.stderr.write(NETWORK_MARKER + '\n');
      if (process.env.D1_OFFLINE_TRACE === '1' && /^\/[a-zA-Z0-9/._-]*$/.test(parsed.pathname)) process.stderr.write(`D1_OFFLINE_PATH ${parsed.pathname}\n`);
      return fail('OFFLINE_CACHE_MISS');
    }
    process.stderr.write('D1_SNAPSHOT_REPLAY\n');
    return { ok: true, status: 200, text: async () => html };
  };
}

async function main(args = process.argv.slice(2)) {
  if (args[0] === '--serve-offline') { serveOffline(args[1]); return; }
  const options = parseArgs(args);
  if (options.help) {
    console.log('node scripts/d1-baseline.js --before-cache BEFORE_XDG_ROOT --after-cache AFTER_XDG_ROOT --output NEW.json [--before-repo REPO --after-repo REPO] [--html-dir DIR] [--timeout MS] [--with-question-args]\n공개 train/dev만 사용합니다. 캐시 루트 아래 dongguk-rule-mcp/v2/public/corpus/corpus-v1.json이 필요합니다. 원본 ~/.cache는 거부하며 네트워크는 차단합니다. 동일 before catalog snapshot으로 LAWNAME 제목 포함 검색을 재현하며, content fallback은 고정된 lawId/historyId HTML만 읽습니다. HWP 누락은 실패 유지합니다. HTML 기본 경로는 BEFORE_XDG_ROOT/../html입니다. 기본 query만, --with-question-args는 문항 자체 args만 사용합니다. strict=정답 규정 상위3의 본문에 정답 조문 표제 포함, top3=정답 규정 포함, bodyIncluded=반환 전체 규정의 정답 조문 표제 포함. NEW.json은 덮어쓰지 않습니다. 지연은 첫 질의를 포함한 단일 실행이며 실제 서비스 지연이 아닙니다.');
    return;
  }
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error('OUTPUT_EXISTS');
  const [beforeCache, afterCache] = validatedCaches(options.beforeCache, options.afterCache);
  options.snapshotCache = beforeCache;
  options.htmlDir = path.resolve(options.htmlDir || path.join(beforeCache, '../html'));
  const catalogPath = path.join(beforeCache, CACHE_SUFFIX, 'catalog/all.json');
  const catalogSha256 = sha(fs.readFileSync(catalogPath));
  if (catalogSha256 !== sha(fs.readFileSync(path.join(afterCache, CACHE_SUFFIX, 'catalog/all.json')))) throw new Error('CATALOG_SNAPSHOT_MISMATCH');
  const { questions, files } = loadQuestions();
  const startedAt = new Date().toISOString();
  const before = await measure('before', beforeCache, path.resolve(options.beforeRepo), questions, options);
  const after = await measure('after', afterCache, path.resolve(options.afterRepo), questions, options);
  const report = { startedAt, completedAt: new Date().toISOString(), questionFiles: files,
    mode: options.useArgs ? 'query+문항 자체 args' : 'query만', network: 'blocked',
    snapshotAdapter: { catalogSha256, search: 'LAWNAME 제목 포함 비교, 같은 고정 catalog', content: '동일 lawId/historyId 수집 HTML만 사용', history: '누락 연혁은 catalog의 알려진 고정 연혁 1개만 재현. 과거 기준일 평가 미지원. before/after는 측정 전용 캐시이며 일반 조회용으로 사용하지 않는다.', hwp: '캐시 이외 실패 유지' },
    definitions: { strict: '상위 3개 정답 규정 본문에 정답 조문/별표 표제 포함', top3: '상위 3개 반환 규정에 정답 규정 포함', bodyIncluded: '반환 전체 정답 규정 본문에 정답 조문/별표 표제 포함', articleGivenTop3: 'strict 정답 수 / 규정 top3 정답 수',
      limitation: '표제 존재를 채점하며 조문 내용의 법적 정확성이나 발췌 완전성을 판정하지 않는다. 원본 구조 캐시에서 발췌한 경우 HTML 전문 색인 변경은 후보 순위에만 드러날 수 있다. 첫 질의를 포함한 1회 실행 지연이다.' },
    before, after, diff: comparison(before.results, after.results) };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, before: before.summary, after: after.summary,
    newWrong: Object.fromEntries(Object.entries(report.diff).map(([metric, value]) => [metric, value.newWrong.map(row => row.id)])),
    blockedNetworkAttempts: { before: before.blockedNetworkAttempts, after: after.blockedNetworkAttempts } }));
}

if (require.main === module) main().catch(error => { console.error(`D1 baseline failed: ${/^[A-Z_]+$/.test(error.message) ? error.message : 'CHECK_INPUT_OR_ISOLATED_CACHE'}`); process.exitCode = 1; });
module.exports = { parseArgs, loadQuestions, strictResult, summarize, comparison, validatedCaches, main };

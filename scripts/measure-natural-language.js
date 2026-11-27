'use strict';
// Offline measurement of natural-language lookups, for comparing ranking methods on the same
// questions. It runs the real lookup tool in this process against a private copy of a rule
// cache (full-text index, cached rule bodies and, optionally, article vectors). The title
// search of the source site is answered from the index, and with --offline nothing else
// reaches the network. Never imported by the server.
//
//   node scripts/measure-natural-language.js --cache <dir> --questions a.json,b.json \
//     [--ranking legacy|hybrid|rrf] [--keywords keywords.json] [--out report.json] [--compare earlier.json] [--online]
//
// <dir> is used as XDG_CACHE_HOME and must hold dongguk-rule-mcp/v2/public/corpus/corpus-v1.json.
// The run refreshes file times in it so cached bodies are not refetched: give it a copy, not a
// cache a server is using. Questions are benchmark rows ({id, q, gt: [{lawId, articles}]}).
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(args) {
  const options = { questions: [], ranking: null, keywords: null, cache: null, out: null, compare: null, offline: true };
  for (let i = 0; i < args.length; i++) {
    const name = args[i], value = () => { if (i + 1 >= args.length) throw new Error(`MISSING_VALUE ${name}`); return args[++i]; };
    if (name === '--cache') options.cache = value();
    else if (name === '--questions') options.questions.push(...value().split(',').filter(Boolean));
    else if (name === '--ranking') options.ranking = value();
    else if (name === '--keywords') options.keywords = value();
    else if (name === '--out') options.out = value();
    else if (name === '--compare') options.compare = value();
    else if (name === '--online') options.offline = false;
    else throw new Error(`UNKNOWN_OPTION ${name}`);
  }
  if (!options.cache || !options.questions.length) throw new Error('USAGE --cache <dir> --questions <file[,file]>');
  return options;
}

const share = (count, total) => total ? Math.round(count / total * 1000) / 10 : null;
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

// rows: [{ id, set, answered, ruleInTop3, ruleFirst, rulesShown, ms }]
// - answered:   an expected article is in the body of one of the rules shown (the strict score)
// - ruleInTop3: an expected rule is among the first three rules shown
// The two stages are reported apart: `ruleInTop3` is the choice of rules, and
// `articleGivenRule` is the choice of articles once the rule was right.
function summarize(rows) {
  const group = list => {
    const withRule = list.filter(row => row.ruleInTop3), single = list.filter(row => row.rulesShown === 1);
    const times = list.map(row => row.ms).filter(Number.isFinite).sort((a, b) => a - b);
    return {
      questions: list.length,
      answered: list.filter(row => row.answered).length, answeredShare: share(list.filter(row => row.answered).length, list.length),
      ruleInTop3: withRule.length, ruleInTop3Share: share(withRule.length, list.length),
      articleGivenRule: withRule.filter(row => row.answered).length, articleGivenRuleShare: share(withRule.filter(row => row.answered).length, withRule.length),
      singleRule: single.length, singleRuleShare: share(single.length, list.length),
      singleRuleRight: single.filter(row => row.ruleFirst).length, singleRuleAnswered: single.filter(row => row.answered).length,
      medianMs: times.length ? Math.round(percentile(times, 0.5)) : null, p95Ms: times.length ? Math.round(percentile(times, 0.95)) : null,
    };
  };
  const sets = {};
  for (const row of rows) (sets[row.set] = sets[row.set] || []).push(row);
  return { total: group(rows), sets: Object.fromEntries(Object.entries(sets).map(([name, list]) => [name, group(list)])) };
}

// Questions whose strict score or rule choice changed between two reports.
function compareReports(before, after) {
  const earlier = new Map(before.rows.map(row => [row.id, row]));
  const changed = { newlyWrong: [], newlyRight: [], ruleLost: [], ruleFound: [], missing: [] };
  for (const row of after.rows) {
    const old = earlier.get(row.id);
    if (!old) { changed.missing.push(row.id); continue; }
    if (old.answered && !row.answered) changed.newlyWrong.push(row.id);
    if (!old.answered && row.answered) changed.newlyRight.push(row.id);
    if (old.ruleInTop3 && !row.ruleInTop3) changed.ruleLost.push(row.id);
    if (!old.ruleInTop3 && row.ruleInTop3) changed.ruleFound.push(row.id);
  }
  return changed;
}

function formatSummary(report) {
  const line = (name, g) => `| ${name} | ${g.questions} | ${g.answered} (${g.answeredShare}%) | ${g.ruleInTop3} (${g.ruleInTop3Share}%) | ${g.articleGivenRule}/${g.ruleInTop3} (${g.articleGivenRuleShare}%) | ${g.singleRule} (맞는 규정 ${g.singleRuleRight}, 정답 조문 ${g.singleRuleAnswered}) | ${g.medianMs} / ${g.p95Ms} |`;
  return [
    `순위 방식: ${report.ranking} · 핵심어: ${report.keywords ? '있음' : '없음'} · 의미검색: ${report.semantic ? '사용' : '미사용'} · RSS ${report.rssMb}MB`,
    '', '| 세트 | 문항 | 정답 조문 포함(엄격) | 정답 규정 상위 3 | 규정이 맞을 때 조문 포함 | 한 규정만 보여 줌 | 지연 중앙값 / p95 (ms) |', '|---|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(report.summary.sets).map(([name, g]) => line(name, g)), line('합계', report.summary.total),
  ].join('\n');
}

// The lookup tool of this checkout, with the source site's title search answered from the index.
async function connect({ cache, offline }) {
  const root = path.resolve(cache), publicDir = path.join(root, 'dongguk-rule-mcp/v2/public');
  const corpus = JSON.parse(fs.readFileSync(path.join(publicDir, 'corpus/corpus-v1.json'), 'utf8'));
  // Revision lists and the catalog are marked fresh, so the lookup reads cached bodies of the indexed revisions.
  fs.mkdirSync(path.join(publicDir, 'history'), { recursive: true });
  const future = new Date(Date.now() + 86400e3);
  for (const rule of corpus.rules) {
    const file = path.join(publicDir, 'history', `${rule.lawId}.json`);
    fs.writeFileSync(file, JSON.stringify([{ historyId: rule.historyId, revisedAt: rule.revisedAt }]));
    fs.utimesSync(file, future, future);
  }
  const catalogDir = path.join(publicDir, 'catalog');
  if (fs.existsSync(catalogDir)) for (const file of fs.readdirSync(catalogDir)) fs.utimesSync(path.join(catalogDir, file), future, future);
  Object.assign(process.env, { XDG_CACHE_HOME: root, DONGGUK_RULE_COOKIE: '', DONGGUK_MCP_NO_CACHE: '0', DONGGUK_MCP_PROFILE: 'rules', DONGGUK_LEGAL_MCP_ENABLED: '0' });
  // Waits of half a second or less (request spacing) are skipped; the clock moves forward instead.
  const realTimeout = global.setTimeout, realNow = Date.now;
  let skipped = 0;
  Date.now = () => realNow() + skipped;
  global.setTimeout = (fn, ms, ...rest) => { if (ms > 0 && ms <= 500) { skipped += ms; ms = 0; } return realTimeout(fn, ms, ...rest); };
  const fetchPath = require.resolve('node-fetch');
  const realFetch = require(fetchPath);
  const row = rule => `<tr><td class="tbody_txt"><a href="javascript:lawSearchFullViewSrv('${rule.lawId}','${rule.historyId}');"><span onclick='showSearchText("${rule.code}")'></span><span onclick='showSearchText("${rule.title}")'></span></a></td></tr>`;
  const state = { liveFetches: 0 };
  require.cache[fetchPath].exports = async (url, options) => {
    if (String(url).includes('/lmxsrv/search/')) {
      const form = new URLSearchParams(options.body), text = (form.get('SEARCH_TEXT') || '').trim();
      let hits = [];
      if (form.get('SEARCH_TYPE') === 'LAWNAME' && text) hits = corpus.rules.filter(rule => rule.title.replace(/\s/g, '').includes(text.replace(/\s/g, ''))).slice(0, Number(form.get('PAGE_SHOW')) || 10);
      else if (!text) hits = corpus.rules;
      return { ok: true, status: 200, text: async () => `<p class="infoLeft"><span>${hits.length}</span>건</p><table><tbody class="tbody">${hits.map(row).join('')}</tbody></table>` };
    }
    if (offline || !String(url).startsWith('https://rule.dongguk.edu/')) throw new Error('offline');
    await new Promise(resolve => realTimeout(resolve, 350));
    state.liveFetches++;
    return realFetch(url, options);
  };
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer } = require('../src/index.js');
  const server = createServer({ profile: 'rules' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'measure-natural-language', version: '1' });
  await client.connect(clientSide);
  return { client, state };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.ranking) process.env.DONGGUK_MCP_RANKING = options.ranking;
  const { scoreResponse, validateQuestions } = require('./benchmark-natural-language.js');
  const { rankingMethod } = require('../src/fusion.js');
  const keywords = options.keywords ? JSON.parse(fs.readFileSync(options.keywords, 'utf8')) : null;
  const { client, state } = await connect(options);
  const rows = [];
  let semantic = false;
  for (const file of options.questions) {
    const set = path.basename(file).replace(/\.json$/, '');
    const questions = validateQuestions(JSON.parse(fs.readFileSync(file, 'utf8')));
    for (const [index, question] of questions.entries()) {
      const given = keywords ? keywords[question.id] : question.args;
      const extra = typeof given === 'string' ? (given ? { keywords: given } : {}) : (given || {});
      const started = performance.now();
      const response = await client.callTool({ name: 'lookup_dongguk_rule', arguments: { query: question.q, ...extra } });
      const ms = performance.now() - started;
      const score = scoreResponse(question, response, index);
      semantic = semantic || !!score.search?.semantic;
      rows.push({ id: score.id, set, answered: !!score.bodyIncluded, ruleInTop3: !!score.top3, ruleFirst: !!score.top1, rulesShown: score.rules.length, ms: Math.round(ms * 10) / 10,
        shown: score.rules.map(rule => rule.lawId), ...(score.error ? { error: score.error } : {}) });
    }
  }
  const report = { ranking: rankingMethod(), keywords: !!keywords, semantic, offline: options.offline, liveFetches: state.liveFetches,
    rssMb: Math.round(process.memoryUsage().rss / 1048576), summary: summarize(rows), rows };
  console.log(formatSummary(report));
  if (options.compare) {
    const changed = compareReports(JSON.parse(fs.readFileSync(options.compare, 'utf8')), report);
    report.comparedWith = { file: options.compare, ...changed };
    const list = ids => ids.length ? ids.join(', ') : '없음';
    console.log(`\n비교(${path.basename(options.compare)}): 새로 틀림 ${list(changed.newlyWrong)} / 새로 맞음 ${list(changed.newlyRight)} / 정답 규정이 상위 3에서 빠짐 ${list(changed.ruleLost)} / 새로 들어옴 ${list(changed.ruleFound)}`);
  }
  if (options.out) fs.writeFileSync(options.out, JSON.stringify(report));
  return report;
}

if (require.main === module) main().then(() => process.exit(0), error => { console.error(error.message || error); process.exit(1); });
module.exports = { parseArgs, summarize, compareReports, formatSummary, percentile, main };

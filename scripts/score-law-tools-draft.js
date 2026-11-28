#!/usr/bin/env node
'use strict';
// Offline development draft. Separate processes/caches keep fault cases isolated.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), fixture = path.join(root, 'test/fixtures/law-tool-scoring');
const read = name => JSON.parse(fs.readFileSync(path.join(fixture, name + '.json')));
const cases = [...read('upper-laws').cases, ...read('references').cases];
if (!process.argv.includes('--case')) {
  const output = process.argv[2];
  if (!output) throw Error('Usage: node scripts/score-law-tools-draft.js <new-output-directory>');
  fs.mkdirSync(output); // Never overwrite or remove prior evidence.
  const results = [];
  for (const item of cases) {
    const p = spawnSync(process.execPath, [__filename, '--case', item.id, path.resolve(output)], { encoding: 'utf8' });
    if (p.status !== 0) throw Error(`${item.id}: ${p.stderr || p.stdout}`);
    const result = JSON.parse(p.stdout);
    results.push(result);
    console.log(`${item.id} ${result.failures.length ? 'FAIL: ' + result.failures.join('; ') : 'PASS'}`);
  }
  const summary = { base: read('upper-laws').baseCommit, cases: results.length, passed: results.filter(r => !r.failures.length).length, results };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  process.exitCode = summary.passed === summary.cases ? 0 : 1;
} else {
  runCase(cases.find(c => c.id === process.argv[3]), process.argv[4]).catch(e => { console.error(e); process.exitCode = 1; });
}

async function runCase(item, output) {
  const cache = path.join(output, item.id);
  Object.assign(process.env, { XDG_CACHE_HOME: cache, DONGGUK_MCP_NO_CACHE: '0', DONGGUK_RULE_COOKIE: '', DONGGUK_MCP_SEMANTIC: 'off', DONGGUK_LEGAL_MCP_URL: 'http://127.0.0.1:9/mcp', DONGGUK_LEGAL_MCP_ENABLED: '1', DONGGUK_PUBLIC_LAW_LINK: item.condition === 'disabled' || item.condition === 'incoming_fixture' ? '0' : '1' });
  for (const key of ['LAW_OC', 'DONGGUK_LEGAL_MCP_BEARER_TOKEN', 'DONGGUK_LEGAL_MCP_API_KEY']) delete process.env[key];
  const fetchPath = require.resolve('node-fetch'); require(fetchPath);
  require.cache[fetchPath].exports = async () => { throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN'); };
  const sources = read('sources'), legalCaptures = read('legal-captures');
  const publicDir = path.join(cache, 'dongguk-rule-mcp/v2/public');
  const seed = (category, key, value) => { const dir = path.join(publicDir, category); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(value)); };
  const catalog = [...new Map(sources.map(s => [s.lawId, {lawId:s.lawId, historyId:s.historyId, title:s.title.replace(/\s+/g,''), revisedAt:s.revisedAt}])).values()];
  const content = new Map();
  for (const s of sources) content.set(s.lawId, (content.get(s.lawId) || '') + '\n' + s.markdown);
  for (const s of catalog) { seed('history', s.lawId, [{historyId:s.historyId, revisedAt:s.revisedAt}]); seed('content-v4', `${s.lawId}_${s.historyId}`, {title:s.title, markdown:content.get(s.lawId)}); }
  seed('catalog', 'all', catalog);
  if (item.condition === 'incoming_fixture') {
    const {buildCorpus, saveCorpus} = require('../src/corpus');
    const subset = catalog.filter(c => [127,184].includes(c.lawId));
    saveCorpus(publicDir, await buildCorpus({catalog:subset, loadContent:async lawId=>({markdown:content.get(lawId)})}));
  }
  const text = value => ({content:[{type:'text',text:value}]});
  const calls = [], unrecorded = [];
  const client = {callTool:async req=>{
    calls.push(req);
    if (item.condition === 'provider_down') throw Error('SYNTHETIC_PROVIDER_DOWN');
    if (req.name === 'get_law_text') {
      if (item.condition === 'future_body') return legalCaptures.futureBody;
      if (item.condition === 'title_only') return text('법령명: 산업안전보건법\n시행일: 20261027\n제25조(안전보건관리규정의 작성)');
      if (item.condition === 'missing_body') return text('[NOT_FOUND] 조문 내용이 없습니다.');
    }
    const a = req.arguments;
    const record = legalCaptures.records.find(r => r.name === req.name && (req.name === 'search_law' ? r.args.query === a.query : String(r.args.mst) === String(a.mst) && String(r.args.efYd) === String(a.efYd) && r.args.jo === a.jo));
    if (!record) { unrecorded.push(req); throw Error('UNRECORDED_LEGAL_CALL:' + req.name + ':' + JSON.stringify(a)); }
    return record.response;
  }};
  const legal = require('../src/legal-client');
  for (const name of ['inspectLaws', 'queryLegalReferences']) { const original = legal[name]; legal[name] = (req, opts) => original(req, {...opts, client, now:new Date('2026-11-28T00:00:00Z')}); }
  const {Client} = require('@modelcontextprotocol/sdk/client/index.js'), {InMemoryTransport} = require('@modelcontextprotocol/sdk/inMemory.js');
  const server = require('../src/index').createServer({profile:'rules'}), mcp = new Client({name:'public-law-tool-draft',version:'1'}), [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await mcp.connect(b);
  const response = await mcp.callTool({name:item.tool,arguments:item.arguments});
  const sc = response.structuredContent, data = sc.data || {}, failures = unrecorded.map(req=>'unrecorded fixture call: '+JSON.stringify(req));
  const at = (obj, key) => key.split('.').reduce((v,k)=>v?.[k],obj);
  for (const [key, expected] of Object.entries(item.expected)) {
    const actual = key.startsWith('error.') ? at(sc,key) : at(data,key);
    if (expected === 'absent' ? actual !== undefined : actual !== expected) failures.push(`${key}=${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  }
  if (!item.expected['error.code']) {
    const normalize = s => String(s || '').replace(/\s/g,'');
    const found = item.tool === 'get_rule_upper_laws' ? data.laws || [] : data.externalLaws || [];
    for (const law of item.expectedLaws) {
      const match = found.find(l => normalize(l.lawName) === normalize(law.citedName) || (l.nameGuessed && normalize(l.nameCandidate).endsWith(normalize(law.citedName))));
      if (item.id === 'U20') continue; // The omitted set is scored separately below.
      if (!match) { failures.push('missing law: ' + law.citedName); continue; }
      for (const article of law.articles) if (!(match.articles || []).some(a => (typeof a === 'string' ? a : a.article) === article)) failures.push('missing article: ' + law.citedName + ' ' + article);
    }
    if (!item.expectedLaws.length && found.length) failures.push('unexpected national law');
    for (const x of item.expectedInternal || []) if (!(data.references || []).some(r => r.scope === 'dongguk_rule' && r.target.lawId === x.lawId && r.article === x.article)) failures.push('missing internal citation');
    for (const x of item.expectedIncoming || []) if (!(data.references || []).some(r => r.direction === 'incoming' && r.sourceLocation.lawId === x.lawId && r.sourceLocation.article === x.article && r.target.lawId === x.targetLawId)) failures.push('missing incoming citation');
    if (item.id === 'U20' && !data.omitted?.length) failures.push('missing omitted laws');
    if (item.id === 'U17' && !data.laws?.some(l=>l.identity.status==='renamed' && ['LAW_RENAMED','ARTICLE_NUMBER_UNVERIFIED'].every(code=>l.signals.some(s=>s.code===code)))) failures.push('missing rename warnings');
    if (['future_body','title_only','missing_body','provider_down'].includes(item.condition)) {
      if ((data.laws || []).some(l=>(l.articles || []).some(a=>a.text)) || (data.lawTexts?.laws || []).some(l=>l.text)) failures.push('unverified body returned');
    }
  }
  fs.writeFileSync(path.join(output, item.id + '.json'), JSON.stringify({item,calls,response},null,2));
  await mcp.close(); await server.close(); await legal.closeLegalClient();
  console.log(JSON.stringify({id:item.id, failures}));
}

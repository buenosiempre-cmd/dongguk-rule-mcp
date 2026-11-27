'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createHttpServer } = require('../src/http-server');
const { createQueryLog, maskQuery, extractQuestion, summarizeResult, queryLogInfo, pruneQueryLog } = require('../src/query-log');
const sync = require('../scripts/sync-query-log-notion');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ✅ ' + name); }
const result = { content: [{ type: 'text', text: 'PRIVATE_BODY' }], structuredContent: { ok: true, tool: 'search_rule', data: { rules: [{ title: '여비규정', lawId: 184, excerpt: { text: 'PRIVATE_BODY' } }, { title: '보수규정' }], evidenceStatus: 'retrieved' } } };
function factory() { const s = new Server({ name: 'q', version: '1' }, { capabilities: { tools: {} } }); s.setRequestHandler(CallToolRequestSchema, async () => result); return s; }
async function call(server, endpoint, name, args) {
  return fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer PRIVATE_HEADER_TOKEN' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
}
const wait = () => new Promise(r => setImmediate(r));
async function lines(dir) { const names = (await fs.readdir(dir)).filter(n => n.startsWith('queries-')); return names.length ? (await fs.readFile(path.join(dir, names[0]), 'utf8')).trim().split('\n').map(JSON.parse) : []; }
function fakeNotion(rows = []) {
  const calls = []; let fail429 = 1;
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, method: init.method, body, auth: init.headers.Authorization });
    const respond = (status, json, headers = {}) => ({ status, ok: status < 400, json: async () => json, headers: { get: k => headers[k.toLowerCase()] } });
    if (url.endsWith('/pages') && fail429-- > 0) return respond(429, {}, { 'retry-after': '1' });
    if (url.endsWith('/pages')) return respond(200, { id: 'p' + calls.length });
    if (url.includes('/query')) return respond(200, { results: rows, has_more: false });
    if (init.method === 'PATCH') return respond(200, {});
    return respond(404, { code: 'object_not_found' });
  };
  return { calls, fetchImpl };
}

async function test() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-log-test-'));
  try {
    await check('개인정보 마스킹: 주민번호·전화·이메일·카드·계좌·사업자·긴 숫자·URL·비밀값', () => {
      const cases = [
        ['홍길동 900101-1234567 휴가', '홍길동 [주민번호] 휴가'],
        ['9001011234567', '[주민번호]'],
        ['연락처 010-1234-5678, 02-2260-3114, +82 10 1234 5678, 1588-1234', '연락처 [전화번호], [전화번호], [전화번호], [전화번호]'],
        ['hong.gd@dgu.ac.kr 로 보내', '[이메일] 로 보내'],
        ['카드 1234-5678-9012-3456 / 4111111111111111', '카드 [카드번호] / [카드번호]'],
        ['계좌 110-123-456789 입금', '계좌 [계좌번호] 입금'],
        ['사업자 123-45-67890', '사업자 [사업자번호]'],
        ['학번 2023123456 확인', '학번 [숫자] 확인'],
        ['https://hooks.slack.com/services/T0/B0/abc 와 ghp_abcdefghijklmnopqrstuvwx1234', '[URL] 와 [비밀값]'],
      ];
      for (const [input, expected] of cases) assert.equal(maskQuery(input).text, expected, input);
    });
    await check('규정 질문의 날짜·조문·금액은 유지, 길이 상한과 제어문자 정리', () => {
      for (const s of ['2024-01-01 기준 여비규정 제10조의2 별표1', '숙박비 1,000,000원 300,000원 2026년', '연가 일수 5년차']) assert.equal(maskQuery(s).text, s);
      const long = maskQuery('가'.repeat(500)); assert.equal([...long.text].length, 201); assert.equal(long.truncated, true);
      assert.equal(maskQuery('여비\n\t규정\u0000').text, '여비 규정');
      assert.deepEqual(maskQuery('010-1234-5678').masked, ['phone']);
    });
    await check('허용 도구의 질의 인자만 추출, 초안·기타 도구 제외', () => {
      assert.equal(extractQuestion('lookup_dongguk_rule', { query: '숙박비', terms: 'X' }), '숙박비');
      assert.equal(extractQuestion('lookup_dongguk_rule', { rule_keyword: '여비규정' }), '여비규정');
      assert.equal(extractQuestion('search_rule', { keyword: '보수' }), '보수');
      assert.equal(extractQuestion('compare_university_rules', { topic: '여비', universities: ['korea'] }), '여비');
      assert.equal(extractQuestion('review_finance_case', { query: '사안', text: '기안문' }), null);
      assert.equal(extractQuestion('get_rule_content', { grep: 'x' }), null);
      assert.equal(extractQuestion('verify_rule_citations', { text: 'x' }), null);
      assert.equal(extractQuestion('search_rule', null), null);
    });
    await check('결과 요약: 건수·첫 규정명·오류 코드만', () => {
      assert.deepEqual(summarizeResult({ result: result }, 200), { status: 'ok', resultStatus: 'retrieved', resultCount: 2, topRule: '여비규정' });
      assert.deepEqual(summarizeResult({ result: { structuredContent: { ok: false, error: { code: 'NOT_FOUND', message: 'PRIVATE' } } } }, 200), { status: 'error', resultStatus: 'NOT_FOUND', resultCount: 0, topRule: null });
      assert.equal(summarizeResult({ result: { structuredContent: { ok: true, data: { documents: [] } } } }, 200).resultStatus, 'no_results');
      const cmp = summarizeResult({ result: { structuredContent: { ok: true, data: { status: 'partial', columns: [{ articles: [] }, { articles: [{ universityRule: '여비규정' }] }] } } } }, 200);
      assert.equal(cmp.resultCount, 1); assert.equal(cmp.topRule, '여비규정');
      assert.equal(summarizeResult({ result: { structuredContent: { ok: false, error: { code: 'bad code; drop' } } } }, 200).resultStatus, 'ERROR');
      assert.equal(summarizeResult(undefined, 502).resultStatus, 'HTTP_502');
    });
    await check('무설정 비활성·서비스 정보 고지', () => {
      assert.equal(createQueryLog({}), null);
      assert.equal(queryLogInfo({}).enabled, false);
      const info = queryLogInfo({ DONGGUK_MCP_QUERY_LOG_DIR: '/x', DONGGUK_MCP_QUERY_LOG_RETENTION_DAYS: '90' });
      assert.equal(info.enabled, true); assert.equal(info.retentionDays, 90); assert.match(info.notice, /개인정보를 가린 뒤 저장/);
      assert.equal(queryLogInfo({ DONGGUK_MCP_QUERY_LOG_DIR: '/x', DONGGUK_MCP_QUERY_LOG_RETENTION_DAYS: 'abc' }).retentionDays, 365);
    });
    const logDir = path.join(dir, 'logs');
    await check('실제 HTTP: 응답 그대로, 질문만 마스킹 저장(0600)·경로 구분·비밀값 미저장', async () => {
      const server = createHttpServer({ createServer: factory, endpointFactories: { '/mcp': factory, '/mcp/rules': factory }, host: '127.0.0.1', queryLogDir: logDir });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      try {
        let res = await call(server, '/mcp/rules', 'lookup_dongguk_rule', { query: '출장 숙박비 010-9999-8888', terms: 'PRIVATE_TERMS', campus: 'seoul', token: 'PRIVATE_TOKEN' });
        assert.equal(res.status, 200); assert.deepEqual((await res.json()).result, result);
        res = await call(server, '/mcp', 'search_rule', { keyword: '보수' }); await res.json();
        res = await call(server, '/mcp', 'review_finance_case', { query: 'PRIVATE_CASE', text: 'PRIVATE_DRAFT' }); await res.json();
        res = await call(server, '/mcp/rules', 'get_service_info', {}); await res.json();
        await wait(); await server.flushQueryLog();
      } finally { await server.shutdown(); }
      const file = (await fs.readdir(logDir))[0]; assert.match(file, /^queries-\d{4}-\d{2}\.jsonl$/);
      const raw = await fs.readFile(path.join(logDir, file), 'utf8');
      assert.doesNotMatch(raw, /PRIVATE_|9999|8888|Authorization|Bearer|127\.0\.0\.1|seoul/);
      const rows = raw.trim().split('\n').map(JSON.parse);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].query, '출장 숙박비 [전화번호]'); assert.equal(rows[0].endpoint, '/mcp/rules'); assert.equal(rows[0].tool, 'lookup_dongguk_rule');
      assert.equal(rows[0].resultCount, 2); assert.equal(rows[0].topRule, '여비규정'); assert.match(rows[0].ts, /\+09:00$/); assert.ok(rows[0].id);
      assert.deepEqual(Object.keys(rows[0]).sort(), ['durationMs', 'endpoint', 'id', 'query', 'queryMasked', 'queryTruncated', 'resultCount', 'resultStatus', 'schemaVersion', 'status', 'tool', 'topRule', 'ts']);
      assert.equal(rows[1].endpoint, '/mcp'); assert.equal(rows[1].query, '보수');
      assert.equal((await fs.stat(path.join(logDir, file))).mode & 0o777, 0o600);
    });
    await check('로그 쓰기 실패가 응답을 바꾸지 않음·finish/close 중복 방지', async () => {
      const bad = path.join(dir, 'not-a-dir'); await fs.writeFile(bad, 'x');
      const server = createHttpServer({ createServer: factory, host: '127.0.0.1', queryLogDir: bad });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      try { const res = await call(server, '/mcp', 'search_rule', { keyword: '보수' }); assert.equal(res.status, 200); assert.deepEqual((await res.json()).result, result); await wait(); await server.flushQueryLog(); }
      finally { await server.shutdown(); }
      const sub = path.join(dir, 'dup'), log = createQueryLog({ dir: sub }); const res = new EventEmitter(); res.statusCode = 200; res.write = () => true; res.end = () => {};
      log.track({}, res, '/mcp/rules', Date.now(), { method: 'tools/call', params: { name: 'search_rule', arguments: { keyword: '여비' } } });
      res.end(JSON.stringify({ result })); res.emit('finish'); res.emit('close'); await log.flush();
      assert.equal((await lines(sub)).length, 1);
    });
    await check('노션 동기화: 속성 매핑·429 재시도·오프셋으로 중복 방지·미완성 줄 보류', async () => {
      const { calls, fetchImpl } = fakeNotion();
      const file = path.join(logDir, (await fs.readdir(logDir)).find(n => n.startsWith('queries-')));
      await fs.appendFile(file, 'malformed\n{"partial":');
      const env = { DONGGUK_MCP_QUERY_LOG_DIR: logDir, NOTION_QUERY_LOG_TOKEN: 'secret_TESTTOKEN', NOTION_QUERY_LOG_DATABASE_ID: '0123456789abcdef0123456789abcdef' };
      const out = []; const run = () => sync.main({ argv: [], env, fetchImpl, sleep: async () => {}, log: m => out.push(m) });
      let r = await run();
      assert.equal(r.sync.created, 2); assert.equal(r.sync.skipped, 1);
      const pages = calls.filter(c => c.url.endsWith('/pages'));
      assert.equal(pages.length, 3); // one 429 retry
      const props = pages[2].body.properties;
      assert.equal(props['질문'].title[0].text.content, '보수'); assert.equal(props['경로'].select.name, '회원(/mcp)');
      assert.equal(props['답 품질'].select.name, '미검토'); assert.equal(props['결과 건수'].number, 2);
      assert.equal(pages[0].body.parent.database_id, env.NOTION_QUERY_LOG_DATABASE_ID);
      assert(!out.join('\n').includes('TESTTOKEN'));
      const statePath = path.join(logDir, 'notion-sync-state.json');
      assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
      r = await run(); assert.equal(r.sync.created, 0);
      await fs.appendFile(file, '}\n'); r = await run(); assert.equal(r.sync.skipped, 1); assert.equal(r.sync.created, 0);
      assert.equal(calls.filter(c => c.url.endsWith('/pages')).length, 3);
    });
    await check('업로드 직전 재마스킹·dry-run은 토큰 없이 상태 미변경·필수 설정 검증', async () => {
      assert.equal(sync.sanitize({ ts: 'x', query: '연락 010-1234-5678' }).query, '연락 [전화번호]');
      const sub = path.join(dir, 'dry'); await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, 'queries-2026-11.jsonl'), JSON.stringify({ ts: '2026-11-26T10:00:00+09:00', tool: 'search_rule', query: '여비', endpoint: '/mcp/rules' }) + '\n');
      const out = []; const r = await sync.main({ argv: ['--dry-run', '--dir', sub], env: {}, log: m => out.push(m) });
      assert.equal(r.sync.created, 1); await assert.rejects(fs.stat(path.join(sub, 'notion-sync-state.json')));
      await assert.rejects(sync.main({ argv: ['--dir', sub], env: {}, log: () => {} }), /NOTION_QUERY_LOG_TOKEN/);
      await assert.rejects(sync.main({ argv: ['--dir', sub], env: { NOTION_QUERY_LOG_TOKEN: 't' }, log: () => {} }), /데이터베이스 ID/);
      assert.throws(() => sync.parse(['--bogus']), /UNKNOWN_OPTION/);
    });
    await check('오답 → 정답률 질문 세트 내보내기·보관기간 정리', async () => {
      const rows = [
        { id: 'a', properties: { '질문': { title: [{ plain_text: '결혼 휴가 며칠' }] }, '정답 규정': { rich_text: [{ plain_text: '취업규칙, 직원복무규정' }] } } },
        { id: 'b', properties: { '질문': { title: [{ plain_text: '결혼 휴가 며칠' }] }, '정답 규정': { rich_text: [] } } },
        { id: 'c', properties: { '질문': { title: [{ plain_text: '모르는 질문' }] }, '정답 규정': { rich_text: [] } } },
      ];
      const { calls, fetchImpl } = fakeNotion(rows);
      const out = path.join(dir, 'wrong.json');
      const env = { NOTION_QUERY_LOG_TOKEN: 't', NOTION_QUERY_LOG_DATABASE_ID: '0123456789abcdef0123456789abcdef' };
      const r = await sync.main({ argv: ['--dir', dir, '--export-wrong', out], env, fetchImpl, sleep: async () => {}, log: () => {} });
      assert.deepEqual(r.export, { exported: 2, unscored: 1 });
      assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), [['결혼 휴가 며칠', ['취업규칙', '직원복무규정'], null], ['모르는 질문', null, null]]);
      assert.deepEqual(calls[0].body.filter, { property: '답 품질', select: { equals: '오답' } });
      const sub = path.join(dir, 'prune'); await fs.mkdir(sub);
      for (const n of ['queries-2025-10.jsonl', 'queries-2025-11.jsonl', 'queries-2026-11.jsonl', 'other.txt']) await fs.writeFile(path.join(sub, n), '');
      const removed = await pruneQueryLog({ dir: sub, days: 365, now: Date.parse('2026-11-26T00:00:00+09:00') });
      assert.deepEqual(removed, ['queries-2025-10.jsonl']);
      const p = await sync.pruneNotion({ request: async (m, u, b) => (calls.push({ m, u, b }), m === 'POST' ? { results: [{ id: 'old' }] } : {}), databaseId: 'd', days: 365, now: Date.parse('2026-11-26T00:00:00Z'), sleep: async () => {} });
      assert.equal(p.archived, 1); assert.deepEqual(calls.at(-1), { m: 'PATCH', u: '/pages/old', b: { archived: true } });
    });
    console.log(`📊 질문 로그 검증: ${passed}개 통과`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
test().catch(e => { console.error(e); process.exitCode = 1; });

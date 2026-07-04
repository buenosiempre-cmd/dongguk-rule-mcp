// HTTP 모드 검증 (Streamable HTTP, stateless) — 네트워크 불필요 (localhost만 사용)
const { spawn } = require('child_process');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'src', 'index.js');
const PORT = 38472;
const PORT2 = 38473;
const TOKEN = 'test-secret-123';
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail='') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

async function waitReady(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function rpc(base, payload, extraHeaders = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...extraHeaders },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🌐 HTTP 모드 검증 (Streamable HTTP, stateless)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 서버 A: 토큰 인증 켜고 기동
  const procA = spawn('node', [INDEX, '--http', '--port', String(PORT), '--token', TOKEN],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const readyA = await waitReady(BASE);

  console.log('\n[0] 기동');
  check('HTTP 서버 기동 (--http --token)', readyA);
  if (!readyA) { procA.kill(); summary(); process.exit(1); }

  console.log('\n[1] /health (무인증)');
  const h = await (await fetch(`${BASE}/health`)).json();
  check('status ok', h.status === 'ok');
  check('버전 0.4.0', h.version === '0.4.0', `(got ${h.version})`);
  check('transport 표기', h.transport === 'streamable-http');

  console.log('\n[2] Bearer 인증');
  const noAuth = await rpc(BASE, { jsonrpc:'2.0', id:1, method:'tools/list' });
  check('토큰 없음 → 401', noAuth.status === 401, `(got ${noAuth.status})`);
  const badAuth = await rpc(BASE, { jsonrpc:'2.0', id:1, method:'tools/list' }, { 'Authorization': 'Bearer wrong' });
  check('틀린 토큰 → 401', badAuth.status === 401, `(got ${badAuth.status})`);

  const AUTH = { 'Authorization': `Bearer ${TOKEN}` };

  console.log('\n[3] initialize');
  const init = await rpc(BASE, {
    jsonrpc:'2.0', id:1, method:'initialize',
    params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'http-test', version:'1.0' } }
  }, AUTH);
  check('200 응답', init.status === 200, `(got ${init.status})`);
  check('serverInfo 이름', init.body?.result?.serverInfo?.name === 'dongguk-rule-mcp');
  check('serverInfo 버전 0.4.0', init.body?.result?.serverInfo?.version === '0.4.0',
    `(got ${init.body?.result?.serverInfo?.version})`);

  console.log('\n[4] stateless 핵심 — 독립 요청으로 tools/list');
  const list = await rpc(BASE, { jsonrpc:'2.0', id:2, method:'tools/list', params:{} }, AUTH);
  check('initialize 없이 새 요청 처리', list.status === 200, `(got ${list.status})`);
  const tools = list.body?.result?.tools || [];
  check('도구 5개', tools.length === 5, `(got ${tools.length})`);
  check('search_rule 포함', tools.some(t => t.name === 'search_rule'));

  console.log('\n[5] tools/call — 입력 검증 (네트워크 불필요)');
  const call1 = await rpc(BASE, {
    jsonrpc:'2.0', id:3, method:'tools/call',
    params:{ name:'get_rule_content', arguments:{ law_id:'abc' } }
  }, AUTH);
  const txt1 = call1.body?.result?.content?.[0]?.text || '';
  check('law_id 검증 메시지', txt1.includes('양의 정수'), `(got: ${txt1.slice(0,40)})`);
  const call2 = await rpc(BASE, {
    jsonrpc:'2.0', id:4, method:'tools/call',
    params:{ name:'search_rule', arguments:{ keyword:'   ' } }
  }, AUTH);
  const txt2 = call2.body?.result?.content?.[0]?.text || '';
  check('keyword 검증 메시지', txt2.includes('검색어'), `(got: ${txt2.slice(0,40)})`);

  console.log('\n[6] 프로토콜 경계');
  const get = await fetch(`${BASE}/mcp`, { headers: AUTH });
  check('GET /mcp → 405', get.status === 405, `(got ${get.status})`);
  const nf = await fetch(`${BASE}/nope`);
  check('알 수 없는 경로 → 404', nf.status === 404, `(got ${nf.status})`);
  const bad = await fetch(`${BASE}/mcp`, { method:'POST', headers:{ ...MCP_HEADERS, ...AUTH }, body:'{broken' });
  check('잘못된 JSON → 400', bad.status === 400, `(got ${bad.status})`);

  procA.kill();

  // 서버 B: 토큰 없이 기동 → 무인증 접근 허용 확인
  console.log('\n[7] 무토큰 모드 (기본)');
  const procB = spawn('node', [INDEX, '--http', '--port', String(PORT2)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const readyB = await waitReady(`http://127.0.0.1:${PORT2}`);
  check('무토큰 기동', readyB);
  if (readyB) {
    const openList = await rpc(`http://127.0.0.1:${PORT2}`, { jsonrpc:'2.0', id:1, method:'tools/list', params:{} });
    check('무인증 tools/list 허용', openList.status === 200 && (openList.body?.result?.tools||[]).length === 5,
      `(status ${openList.status})`);
  } else { fail++; }
  procB.kill();

  summary();
  process.exit(fail > 0 ? 1 : 0);
}

function summary() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 HTTP 검증: ${pass}개 통과 / ${fail}개 실패`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

setTimeout(() => { console.log('⏱️ 타임아웃'); process.exit(1); }, 30000);
main().catch(e => { console.error('💥', e.message); process.exit(1); });

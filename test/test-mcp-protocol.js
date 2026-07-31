// MCP JSON-RPC 프로토콜 검증 — 네트워크 불필요 (어디서든 동일 결과)
const { spawn } = require('child_process');
const path = require('path');

const proc = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], { stdio: ['pipe','pipe','pipe'] });

let buffer = '';
let pass = 0, fail = 0;
const impureLines = [];   // stdout에 섞인 비JSON 라인 (MCP 오염 감지)
function check(name, cond, detail='') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

proc.stdout.on('data', (data) => {
  buffer += data.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try { handleResponse(JSON.parse(line)); }
    catch (e) { impureLines.push(line.slice(0, 60)); }
  }
});

function handleResponse(msg) {
  if (msg.id === 1) {
    check('initialize 응답', !!(msg.result && msg.result.serverInfo));
    check('서버 이름', msg.result?.serverInfo?.name === 'dongguk-rule-mcp', `(got "${msg.result?.serverInfo?.name}")`);
    check('서버 버전 0.5.1', msg.result?.serverInfo?.version === '0.5.1', `(got "${msg.result?.serverInfo?.version}")`);
    send({ jsonrpc:'2.0', id:2, method:'tools/list', params:{} });
  }

  if (msg.id === 2) {
    const tools = msg.result?.tools || [];
    check('도구 6개 등록', tools.length === 6, `(got ${tools.length})`);
    const names = tools.map(t => t.name);
    ['lookup_dongguk_rule','search_rule','get_rule_content','get_rule_toc','list_rule_history','search_rule_deep']
      .forEach(n => check(`${n} 존재`, names.includes(n)));
    const lt = tools.find(t => t.name === 'lookup_dongguk_rule');
    check('lookup_dongguk_rule query 호환 파라미터', 'query' in (lt?.inputSchema?.properties || {}));
    check('lookup_dongguk_rule rule_keyword 선택 파라미터', 'rule_keyword' in (lt?.inputSchema?.properties || {}));
    check('lookup_dongguk_rule terms 파라미터', 'terms' in (lt?.inputSchema?.properties || {}));
    check('lookup_dongguk_rule 읽기 전용', lt?.annotations?.readOnlyHint === true);
    const st = tools.find(t => t.name === 'search_rule');
    check('search_rule 필수 keyword', st?.inputSchema?.required?.includes('keyword'));
    check('search_rule campus 파라미터', 'campus' in (st?.inputSchema?.properties || {}));
    const ct = tools.find(t => t.name === 'get_rule_content');
    check('get_rule_content article 필터', 'article' in (ct?.inputSchema?.properties || {}));
    check('get_rule_content grep 필터', 'grep' in (ct?.inputSchema?.properties || {}));
    // [네트워크 중립] 빈 keyword → 검증 메시지가 즉시 반환 (HTTP 요청 없음)
    send({ jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'search_rule', arguments:{ keyword:'' } } });
  }

  if (msg.id === 3) {
    const txt = msg.result?.content?.[0]?.text || '';
    check('빈 keyword → 즉시 응답', txt.length > 0);
    check('빈 keyword → 친절한 안내', txt.includes('검색어'), `(got: ${txt.slice(0,40)})`);
    check('빈 keyword → isError 아님 (검증 안내)', !msg.result?.isError);
    // arguments 자체 누락 → TypeError 없이 처리되는지
    send({ jsonrpc:'2.0', id:4, method:'tools/call', params:{ name:'get_rule_content' } });
  }

  if (msg.id === 4) {
    const txt = msg.result?.content?.[0]?.text || '';
    check('arguments 누락 → 크래시 없음', txt.length > 0);
    check('arguments 누락 → law_id 안내', txt.includes('law_id'), `(got: ${txt.slice(0,40)})`);
    setTimeout(() => {
      console.log('\n[순수성] stdout에는 JSON-RPC만 존재해야 함');
      check('stdout 순수성 (비JSON 라인 0개)', impureLines.length === 0,
        `(오염 ${impureLines.length}개: ${impureLines[0] || ''})`);
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📊 MCP 프로토콜 검증: ${pass}개 통과 / ${fail}개 실패`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      proc.kill();
      process.exit(fail > 0 ? 1 : 0);
    }, 300);
  }
}

function send(msg) { proc.stdin.write(JSON.stringify(msg) + '\n'); }

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔌 MCP 프로토콜 검증 (네트워크 불필요)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
setTimeout(() => {
  send({ jsonrpc:'2.0', id:1, method:'initialize',
    params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'test',version:'1.0'} } });
}, 300);

setTimeout(() => { console.log('\n⏱️ 타임아웃'); proc.kill(); process.exit(1); }, 12000);

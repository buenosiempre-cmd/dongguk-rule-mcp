// 엣지케이스 검증 — 입력 검증, CLI 플래그 (네트워크 불필요)
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'src', 'index.js');
let pass = 0, fail = 0;
function check(name, cond, detail='') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧪 엣지케이스 검증 (입력 검증·CLI)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// [A] --version 플래그
console.log('\n[A] CLI 플래그');
try {
  const v = execFileSync('node', [INDEX, '--version'], { encoding:'utf-8' }).trim();
  check('--version 출력', /^\d+\.\d+\.\d+$/.test(v), `(got "${v}")`);
  check('버전 = 0.4.0', v === '0.4.0', `(got "${v}")`);
} catch (e) { check('--version 실행', false, `(${e.message})`); fail++; }

// [B] MCP 도구 입력 검증 (JSON-RPC로 실제 호출)
const proc = spawn('node', [INDEX], { stdio:['pipe','pipe','pipe'] });
let buffer = '';
const cases = [
  // [id, 도구, 인자, 기대문구, 설명]
  [10, 'search_rule', { keyword:'   ' }, '검색어', '공백 keyword → 안내'],
  [11, 'get_rule_content', { law_id:'abc' }, '양의 정수', 'law_id 문자열 → 안내'],
  [12, 'get_rule_content', { law_id:-5 }, '양의 정수', 'law_id 음수 → 안내'],
  [13, 'get_rule_toc', { law_id:0 }, '양의 정수', 'law_id 0 → 안내'],
  [14, 'list_rule_history', {}, 'law_id', 'law_id 누락 → 안내'],
  [15, 'search_rule_deep', { query:'' }, '검색어', '빈 query → 안내'],
  [16, 'no_such_tool', {}, '알 수 없는 도구', '존재하지 않는 도구'],
  [17, 'get_rule_content', { law_id:491, article:'x' }, '양의 정수', 'article 비숫자 → 안내'],
];
let done = 0;

proc.stdout.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) {
      console.log('\n[B] 입력 검증 (8케이스)');
      cases.forEach(([id, name, args]) => {
        proc.stdin.write(JSON.stringify({ jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments:args } }) + '\n');
      });
      return;
    }
    const c = cases.find(x => x[0] === msg.id);
    if (c) {
      const txt = msg.result?.content?.[0]?.text || '';
      check(c[4], txt.includes(c[3]), `(got: ${txt.slice(0,50)})`);
      done++;
      if (done === cases.length) finish();
    }
  }
});

function finish() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 엣지케이스: ${pass}개 통과 / ${fail}개 실패`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  proc.kill();
  process.exit(fail > 0 ? 1 : 0);
}

setTimeout(() => {
  proc.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize',
    params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'edge',version:'1.0'} } }) + '\n');
}, 300);

setTimeout(() => { console.log(`\n⏱️ 타임아웃 (완료 ${done}/${cases.length})`); proc.kill(); process.exit(1); }, 12000);

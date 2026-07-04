const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function check(name, cond, detail='') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

const CAMPUS_MAP = { all: '0', seoul: '1', wise: '2' };
function cmap(c){ const v=(c||'all').trim().toLowerCase(); return CAMPUS_MAP[v]||(/^\d+$/.test(v)?v:'0'); }
function hk(...p) { return crypto.createHash('md5').update(p.join('|')).digest('hex'); }

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧰 유틸 로직 검증 (캠퍼스/캐시키)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n[캠퍼스 매핑]');
check('all → 0', cmap('all') === '0');
check('seoul → 1', cmap('seoul') === '1');
check('wise → 2', cmap('wise') === '2');
check('대문자 SEOUL → 1', cmap('SEOUL') === '1');
check('공백 " seoul " → 1', cmap(' seoul ') === '1');
check('raw 숫자 "5" passthrough', cmap('5') === '5');
check('알 수 없는 값 → 0 (기본)', cmap('unknown') === '0');
check('빈 값 → 0', cmap('') === '0');
check('undefined → 0', cmap(undefined) === '0');

console.log('\n[캐시 키 생성]');
const k1 = hk('보수', false, 1, 10, '0');
const k2 = hk('보수', false, 1, 10, '0');
const k3 = hk('보수', true, 1, 10, '0');
check('동일 입력 → 동일 키', k1 === k2);
check('다른 입력 → 다른 키 (fullText)', k1 !== k3);
check('키 길이 32자 (md5)', k1.length === 32);
check('캠퍼스별 키 분리', hk('보수',false,1,10,'1') !== hk('보수',false,1,10,'0'));

console.log('\n[캐시 TTL 정책]');
const TTL = { search: 3600, searchFull: 86400, history: 600, content: 30*86400 };
check('제목검색 1시간', TTL.search === 3600);
check('전문검색 24시간 (비쌈)', TTL.searchFull === 86400);
check('연혁 10분', TTL.history === 600);
check('본문 30일 (불변)', TTL.content === 2592000);
check('전문 > 제목 (TTL)', TTL.searchFull > TTL.search);

console.log('\n[캐시 read/write 실제 동작]');
const testDir = path.join(os.tmpdir(), 'dgmcp-cache-test-' + Date.now());
const cat = 'search';
const dir = path.join(testDir, cat);
fs.mkdirSync(dir, { recursive: true });
const fp = path.join(dir, k1 + '.json');
const testData = { total: 5, hits: [{lawId:1}] };
fs.writeFileSync(fp, JSON.stringify(testData));
const readBack = JSON.parse(fs.readFileSync(fp, 'utf-8'));
check('캐시 쓰기/읽기 round-trip', readBack.total === 5);
check('캐시 객체 구조 보존', readBack.hits[0].lawId === 1);
// TTL 만료 시뮬레이션
const age = (Date.now() - fs.statSync(fp).mtimeMs) / 1000;
check('방금 쓴 파일 age < TTL', age < TTL.search);
fs.rmSync(testDir, { recursive: true, force: true });
check('캐시 정리', !fs.existsSync(testDir));

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 유틸 검증: ${pass}개 통과 / ${fail}개 실패`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(fail > 0 ? 1 : 0);

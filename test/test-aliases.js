const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeMiddots,
  middotVariants,
  expandAliases,
  resetAliasCacheForTest,
} = require('../src/aliases.js');
const { searchVariants } = require('../src/lookup.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔤 별칭 사전·표기 정규화 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n[1] 가운뎃점 5종 흡수');
check('· ㆍ ‧ • ・ → ㆍ 통일', normalizeMiddots('a·bㆍc‧d•e・f') === 'aㆍbㆍcㆍdㆍeㆍf');
const dotted = middotVariants('산학협력단·연구비규정');
check('가운뎃점 변형 2종 생성', dotted.includes('산학협력단ㆍ연구비규정') && dotted.includes('산학협력단·연구비규정'));
check('가운뎃점 없으면 원문 그대로 1종', middotVariants('보수규정').length === 1);

console.log('\n[2] 내장 별칭 확장');
check('정확 일치: 전결규정→위임전결규정', expandAliases('전결규정').includes('위임전결규정'));
check('결합형: 전결규정 제5조', expandAliases('전결규정 제5조').includes('위임전결규정 제5조'));
check('취규→취업규칙', expandAliases('취규').includes('취업규칙'));
check('별칭 없는 입력은 빈 배열', expandAliases('보수규정').length === 0);
check('빈 입력 방어', expandAliases('').length === 0 && expandAliases(null).length === 0);
check('공식명 중복 확장 금지', expandAliases('위임전결규정').length === 0);
check('공식명과 조문 결합형도 보존', expandAliases('위임전결규정 제5조').length === 0);
check('공식명 내부 띄어쓰기 변형도 보존', expandAliases('위임 전결규정 제5조').length === 0);
check('별칭 내부 띄어쓰기 결합형 확장', expandAliases('전결 규정 제5조').includes('위임전결규정 제5조'));
const mixed = expandAliases('위임전결규정과 전결규정 제5조');
check('공식명과 별칭 혼용 시 별칭만 확장', mixed.includes('위임전결규정과 위임전결규정 제5조') && mixed.every(x => !x.includes('위임위임')));
check('다른 규정명에 포함된 접미사는 별칭으로 오인하지 않음', expandAliases('위원회전결규정').length === 0);

console.log('\n[3] 외부 별칭 파일 (DONGGUK_RULE_ALIASES)');
const tmp = path.join(os.tmpdir(), `dgu-aliases-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify({ '연구비규정': ['산학협력단ㆍ연구비규정'], '빈값': '' }), 'utf-8');
process.env.DONGGUK_RULE_ALIASES = tmp;
resetAliasCacheForTest();
check('외부 별칭 로드', expandAliases('연구비규정').includes('산학협력단ㆍ연구비규정'));
check('빈 값 항목은 무시', expandAliases('빈값').length === 0);
check('내장 별칭 유지', expandAliases('전결규정').includes('위임전결규정'));
check('외부 공식명은 가운뎃점 변형도 중복확장하지 않음', expandAliases('산학협력단·연구비규정 제3조').length === 0);
check('외부 공식명과 별칭 혼용도 해당 별칭만 확장', expandAliases('산학협력단·연구비규정 및 연구비규정').includes('산학협력단·연구비규정 및 산학협력단ㆍ연구비규정'));
process.env.DONGGUK_RULE_ALIASES = tmp + '.missing';
resetAliasCacheForTest();
check('파일 오류 시 내장만으로 동작', expandAliases('전결규정').includes('위임전결규정'));
delete process.env.DONGGUK_RULE_ALIASES;
resetAliasCacheForTest();
try { fs.unlinkSync(tmp); } catch (e) {}

console.log('\n[4] searchVariants 통합');
const sv = searchVariants('전결규정');
check('원 입력이 첫 후보', sv[0] === '전결규정');
check('별칭 후보 포함', sv.includes('위임전결규정'));
check('별칭에도 규정 접미 축약 적용', sv.includes('위임전결'));
check('기존 동작 유지: 보수 규정', searchVariants('보수 규정').includes('보수규정') && searchVariants('보수 규정').includes('보수'));
const svDot = searchVariants('산학협력단·연구비 규정');
check('가운뎃점 양표기 검색 변형', svDot.includes('산학협력단ㆍ연구비규정') && svDot.includes('산학협력단·연구비규정'));
check('공식명 검색 변형에 중복 위임 접두어 없음', searchVariants('위임전결규정').every(x => !x.includes('위임위임')));

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 별칭·정규화: ${pass}개 통과 / ${fail}개 실패`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(fail > 0 ? 1 : 0);

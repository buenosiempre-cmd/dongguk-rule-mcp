const { parseDateLoose, resolveHistoryAtDate, extractEnforcementDates, TIMELINE_CAVEAT } = require('../src/timeline.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🕰 시점 판단(applicable_rule) 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n[1] 날짜 파싱');
check('YYYY-MM-DD', parseDateLoose('2024-03-15')?.iso === '2024-03-15');
check('YYYY.M.D', parseDateLoose('2024.3.5')?.iso === '2024-03-05');
check('YYYYMMDD', parseDateLoose('20240315')?.iso === '2024-03-15');
check('YYYY년 M월 D일', parseDateLoose('2024년 3월 15일')?.iso === '2024-03-15');
check('말미 마침표 허용', parseDateLoose('2025.04.29.')?.iso === '2025-04-29');
check('13월 거부', parseDateLoose('2024-13-01') === null);
check('2월 30일 거부', parseDateLoose('2024-02-30') === null);
check('빈 값 거부', parseDateLoose('') === null && parseDateLoose(null) === null);

// 연혁은 일부러 뒤섞어 정렬 의존성 검증
const HISTORY = [
  { historyId: 200, revisedAt: '2023.05.01' },
  { historyId: 300, revisedAt: '2025.04.29' },
  { historyId: 100, revisedAt: '2020.01.10' },
];

console.log('\n[2] 기준일 → 적용 개정본 특정');
const mid = resolveHistoryAtDate(HISTORY, '2024-03-15');
check('사이 시점: 직전 개정본 선택', mid.entry.historyId === 200, JSON.stringify(mid.entry));
check('이후 첫 개정 = next', mid.next.historyId === 300);
check('현행 아님 판정', mid.isLatest === false && mid.laterCount === 1);
check('latest 동봉', mid.latest.historyId === 300);

const exact = resolveHistoryAtDate(HISTORY, '2023.05.01');
check('개정일 당일은 그 개정본 적용', exact.entry.historyId === 200);

const now = resolveHistoryAtDate(HISTORY, '2026-01-01');
check('최신 이후 시점 = 현행', now.entry.historyId === 300 && now.isLatest === true && now.next === null);

const before = resolveHistoryAtDate(HISTORY, '2019-01-01');
check('최초 이전 시점 = BEFORE_FIRST', before.error === 'BEFORE_FIRST' && before.earliest.historyId === 100);

check('잘못된 날짜 = INVALID_DATE', resolveHistoryAtDate(HISTORY, '2024/99/99').error === 'INVALID_DATE');

console.log('\n[3] 결측 연혁 방어');
const mixed = resolveHistoryAtDate([...HISTORY, { historyId: 999, revisedAt: '' }], '2024-03-15');
check('개정일 미상 연혁은 제외·집계', mixed.entry.historyId === 200 && mixed.undatedCount === 1);
check('전부 미상이면 NO_DATED_HISTORY', resolveHistoryAtDate([{ historyId: 1, revisedAt: '' }], '2024-01-01').error === 'NO_DATED_HISTORY');
check('빈 연혁 방어', resolveHistoryAtDate([], '2024-01-01').error === 'NO_DATED_HISTORY');

console.log('\n[4] 한계 고지');
check('개정일≠시행일 주의문 존재', /시행일/.test(TIMELINE_CAVEAT) && /부칙/.test(TIMELINE_CAVEAT));

console.log('\n[5] 부칙 명시 시행일 추출');
const ENF_MD = [
  '### 제1조(목적) 이 규정은 …',
  '부 칙',
  '이 규정은 2023년 5월 1일부터 시행한다.',
  '부 칙',
  '① 이 규정은 2025. 4. 29.부터 시행한다.',
  '② (경과조치) 시행 당시 종전 규정에 따른다.',
  '부 칙',
  '이 규정은 공포한 날부터 시행한다.',
].join('\n');
const enf = extractEnforcementDates(ENF_MD);
check('명시 시행일 2건 추출·오름차순', enf.length === 2 && enf[0].iso === '2023-05-01' && enf[1].iso === '2025-04-29',
  JSON.stringify(enf.map(x => x.iso)));
check('무일자(공포한 날) 문구 미추출', enf.every(x => !/공포/.test(x.raw)));
check('동일 시행일 중복 제거', extractEnforcementDates(`${ENF_MD}\n이 규정은 2025년 4월 29일부터 시행한다.`).length === 2);
check('시행 문구 없으면 빈 배열', extractEnforcementDates('시행 문구가 없는 본문').length === 0);

console.log('\n[6] 직전 개정본(previous) 동봉');
check('사이 시점의 직전 개정본', mid.previous.historyId === 100, JSON.stringify(mid.previous));
check('현행 시점의 직전 개정본', now.previous.historyId === 200);
check('최초 개정본 적용 시 previous 없음', resolveHistoryAtDate(HISTORY, '2020-06-01').previous === null);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 시점 판단: ${pass}개 통과 / ${fail}개 실패`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(fail > 0 ? 1 : 0);

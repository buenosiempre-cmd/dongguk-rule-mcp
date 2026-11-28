'use strict';
// General rules behind natural-language lookup: everyday wording → rule
// vocabulary, which body a rule governs, and which article answers the
// question's intent. Synthetic rules only; no benchmark question or answer.
const assert = require('node:assert/strict');
const { buildCorpus, searchCorpus } = require('../src/corpus.js');
const { queryConcepts } = require('../src/lookup.js');
const {
  businessTerms, verbNoun, containsTerm, compoundParts, phraseConcepts, comparisonTerms, headingCueStrength,
  ruleScopeClass, ruleSubject, generalRuleWeight,
} = require('../src/aliases.js');

let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`  ✅ ${name}`); }
const article = (number, heading, body) => `### 제${number}조(${heading})\n${body}`;
const filler = count => Array.from({ length: count }, (_, i) => article(30 + i, `기타 ${i + 1}`, '세부 사항은 따로 정한다.'));

const RULES = [
  [10, '재무회계규정', '3-7-1', [
    article(4, '회계연도', '본교의 회계연도는 3월 1일부터 다음 연도 2월 말일까지로 한다.'),
    article(13, '준예산', '회계년도 개시 전까지 예산이 확정되지 아니한 경우에는 전년도 예산에 준하여 집행한다.'),
  ]],
  [11, '총대의원회 회칙(학생자치기구)', '9-0-1', [
    article(25, '회계연도', '본회의 회계연도는 1월 1일부터 12월 31일까지로 한다.'),
    article(26, '결산', '회계연도가 끝나면 결산을 보고한다.'),
  ]],
  [12, '임원 및 교직원 행동강령', '1-0-6', [
    article(17, '금품등의 수수 금지', '교직원은 직무와 관련하여 금품등을 받거나 요구해서는 아니 된다.'),
  ]],
  [13, '기숙사생수칙', '6-6-6', [
    article(6, '식사절차', '기숙사 식사 시간은 관장이 정하며 식사는 식당에서 한다.'),
  ]],
  [14, '명예퇴직수당지급규정', '3-7-8', [
    article(1, '목적', '이 규정은 교직원의 명예퇴직수당 지급에 필요한 사항을 정한다.'),
    article(3, '지급대상', '명예퇴직 수당을 지급받을 수 있는 사람은 20년 이상 근속한 사람으로 한다.'),
    article(4, '지급액', '수당의 지급액은 별표에 따라 산정한 금액으로 한다.'),
  ]],
  [15, '내부감사규정', '3-1-9', [
    article(1, '목적', '이 규정은 내부감사에 필요한 사항을 정한다.'),
    article(10, '감사의 종류와 시기', '정기감사는 감사계획에 따라 연 1회 실시한다.'),
  ]],
  [16, '북한학연구소규정', '7-5-1', [article(8, '조교', '연구소에 조교를 둘 수 있으며 조교의 임기는 1년으로 한다.')]],
  [17, '조교임용규정', '3-3-23', [article(8, '임용기간', '조교의 임기는 1년으로 하며 재임용할 수 있다.')]],
  [18, '취업규칙', '3-3-14', [
    article(42, '경조휴가', '본인이 결혼하는 경우 경조휴가 7일을 준다.'),
    article(43, '출산전후휴가', '임신 중인 여성 직원에게 출산전후휴가 90일을 준다. 출산휴가 기간은 유급으로 한다.'),
    article(35, '연가', '직원의 연가는 재직기간에 따라 15일에서 25일까지로 한다.'),
    article(39, '휴가시기의 변경', '업무에 지장이 있으면 휴가를 주는 시기를 바꿀 수 있다.'),
    article(120, '육아휴직', '자녀의 양육을 위하여 육아휴직을 신청하면 허용한다.'),
  ]],
  [19, '도서관운영규정', '6-9-1', [
    article(27, '반납·연체', '대출한 도서를 연체한 사람은 연체 일수만큼 대출이 정지된다.'),
    article(29, '자료변상', '도서를 분실하거나 훼손한 사람은 같은 자료로 변상해야 한다.'),
  ]],
  // The same article in a long rule other rules cite, and in a short rule nobody cites.
  [20, '가나규정', '3-1-1', [article(5, '위탁교육', '직원의 위탁교육 경비는 본교가 부담한다.'), ...filler(40)]],
  [21, '다라규정', '3-1-2', [article(5, '위탁교육', '직원의 위탁교육 경비는 본교가 부담한다.')]],
  [22, '마바규정', '3-1-3', [article(2, '준용', '이 규정에서 정하지 않은 사항은 「가나규정」을 준용한다.')]],
  [23, '사아규정', '3-1-4', [article(2, '준용', '이 규정에서 정하지 않은 사항은 「가나규정」에 따른다.')]],
  [24, '물품관리규정', '3-7-2', [
    article(7, '사용관리', '부서의 장은 물품을 사용·관리한다.'),
    article(16, '손·망실 처리', '사용자가 비품을 망실하였을 때에는 같은 비품으로 변상하게 해야 한다.'),
    article(11, '반출입', '물품은 허가 없이 본교 시설 바깥으로 반출해서는 안 된다.'),
  ]],
  [25, '구매규정', '3-7-15', [
    article(5, '구매 방법', '구매계약은 결재권자의 승인을 받은 후에 발주해야 한다.'),
    article(29, '계약의 해제 및 해지', '계약상대자가 정당한 이유 없이 계약 이행을 착수하지 아니할 경우에는 계약을 해제 또는 해지할 수 있다.'),
  ]],
  [26, '한시계약직 임용에 관한 내규', '3-3-30', [article(15, '계약의 해지', '계약직 직원이 근무성적이 불량한 경우 계약을 해지할 수 있다.')]],
  [27, '예산운용규정', '3-7-3', [
    article(18, '예산의 목적외 사용금지', '예산이 정한 목적 외에 사용할 수 없다.'),
    article(19, '예산의 전용', '항간에 예산의 과부족이 있을 때에는 상호 전용할 수 있다.'),
  ]],
  [28, '학사시행세칙', '2-1-2', [
    article(66, '일반휴학', '일반휴학은 1회에 2학기까지 할 수 있다.'),
    article(68, '임신·출산 및 육아휴학', '임신·출산 또는 만 8세 이하 자녀의 양육을 위한 휴학은 4학기까지 할 수 있다.'),
  ]],
  [29, '시설대관규정', '3-7-17', [
    article(4, '대관의 대상', '강당과 회의실은 대관할 수 있다.'),
    article(21, '대관료', '강당과 회의실의 대관료는 시설별 산정기준에 따라 이용자가 납부한다.'),
    article(24, '교육과정의 수료', '대관 시설 안전교육을 마친 사람에게 수료증을 준다.'),
  ]],
  [30, '복무규정', '3-3-2', [
    article(5, '성실 의무', '직원은 맡은 일을 성실히 해야 한다.'),
    article(20, '징계의 종류', '직원의 징계는 파면, 해임, 정직, 감봉, 견책으로 구분한다.'),
  ]],
  [31, '조달내규', '3-7-20', [
    article(7, '수의계약', '추정가격이 정한 금액 이하이면 수의계약으로 할 수 있다.'),
    article(9, '경쟁입찰', '경쟁입찰은 공고한 뒤 낙찰자를 정한다.'),
  ]],
  [32, '복지내규', '3-3-40', [article(3, '축하금', '직원이 임신하거나 출산한 때에는 축하금을 지급한다.')]],
];

async function main() {
  // ── 업무 용어 사전 ──
  check('보수 묶음: 월급·봉급·임금이 같은 규정 용어로', ['월급', '봉급', '임금'].every(word => businessTerms(word).includes('보수')));
  check('금품 묶음: 선물·식사·접대·대접·상품권', ['선물', '식사', '접대', '대접', '상품권'].every(word => businessTerms(word).includes('금품등')));
  check('기증 묶음과 구매 묶음', ['기증', '기부'].every(word => businessTerms(word).includes('수증')) && ['발주', '주문'].every(word => businessTerms(word).includes('구매')));
  check('회계연도·회계년도 표기를 함께 검색', businessTerms('회계연도').includes('회계년도') && businessTerms('회계년도').includes('회계연도'));
  check('동사 어간: 말투가 달라도 같은 규정 용어', ['잃어버렸는데', '잃어버리면'].every(word => businessTerms(word).includes('분실'))
    && ['물어내야', '물어줘야'].every(word => businessTerms(word).includes('변상')) && ['팔아도', '팔면'].every(word => businessTerms(word).includes('매각')));
  check('어간은 낱말 앞머리로만 읽음: 아파서는 질병, 아파트는 그대로', businessTerms('아파서').includes('질병') && !businessTerms('아파트').includes('질병'));
  check('끝말 바꿔 쓰기: 심사비·심사료·심사수당, 시정요구·시정요청', businessTerms('심사비').includes('심사수당') && businessTerms('심사비').includes('심사료') && businessTerms('시정요구').includes('시정요청'));
  check('두 가지를 묻는 합성어는 나눠서 검색', compoundParts('월급날').join() === '월급,지급일' && compoundParts('여비').join() === '여비');
  check('여러 낱말로 된 표현', phraseConcepts('팀장이 없을 때 전결은 누가 해').includes('부재') && phraseConcepts('강의 시간 못 채운 교수').includes('미달') && !phraseConcepts('전결은 누가 해').length);
  check('손상·분실 유형: 여러 말투가 같은 규정 용어로', ['망가뜨리면', '부숴먹으면', '깨뜨려서', '파손'].every(word => businessTerms(word).includes('훼손'))
    && ['잃어버리면', '분실'].every(word => businessTerms(word).includes('망실')) && ['노트북', '모니터', '장비'].every(word => businessTerms(word).includes('비품')));
  check('계약 유형: 해약·파기·끊다 → 해제·해지, 업체 → 계약상대자', ['해약', '파기', '끊을', '끊어도'].every(word => businessTerms(word).includes('해지'))
    && businessTerms('납품업체').includes('계약상대자') && phraseConcepts('업체가 일을 안 하면 계약 취소해도 돼?').includes('해약'));
  check('예산 유형: 다른 데 쓰다·돌려쓰다·유용 → 목적 외', ['예산을 다른 데 써도 돼', '사업비를 딴 용도로', '원래 목적 말고', '남는 돈 돌려써도 되나'].every(question => phraseConcepts(question).includes('목적외'))
    && businessTerms('목적외').includes('목적 외') && businessTerms('유용').includes('전용') && !phraseConcepts('예산 편성 절차').length);
  check('출산·육아 유형: 아이·자녀·키우다·양육', ['아이', '자녀', '키우느라', '키워야', '양육'].every(word => businessTerms(word).includes('육아')) && !businessTerms('키').includes('육아'));
  check('청탁 유형: 부탁·압력·외압·로비', ['부탁', '압력', '외압', '로비'].every(word => businessTerms(word).includes('청탁')));
  check('끝말 바꿔 쓰기: 겸임교수·겸임교원, 근로장학생·근로장학금', businessTerms('겸임교수').includes('겸임교원') && businessTerms('근로장학생').includes('근로장학금'));
  check('다른 낱말 속에 든 검색어는 일치로 보지 않음', !containsTerm('한시계약직 임용에 관한 내규', '계약') && containsTerm('구매계약은 계약직 담당자가', '계약')
    && !containsTerm('하자 보수 보증금', '보수') && containsTerm('보수의 지급일', '보수') && containsTerm('물품관리규정', '물품'));
  check('연차휴가는 연차와 휴가로 나눠 검색(규정은 연가·연차유급휴가로 씀)', compoundParts('연차휴가').join() === '연차,휴가' && businessTerms('연차').includes('연가'));
  check('벌을 받다 → 징계, 벌점·벌칙·벌금은 아님', ['규정 어기면 무슨 벌을 받아', '지각하면 벌 받아?', '어떤 벌을 주나요'].every(question => phraseConcepts(question).includes('징계'))
    && ['벌점은 어떻게 매겨', '벌칙 조항이 있어?', '돈 벌면 세금 내?', '벌금은 얼마야'].every(question => !phraseConcepts(question).includes('징계')));
  check('경쟁·입찰 없이 맺는 계약 → 수의계약', ['입찰 없이 계약해도 돼', '경쟁에 부치지 않고 계약', '입찰 안 하고 바로 살 수 있어'].every(question => phraseConcepts(question).includes('수의계약'))
    && ['경쟁입찰 낙찰자는 어떻게 정해', '입찰 공고 기간', '입찰에 한 곳만 들어오면'].every(question => !phraseConcepts(question).includes('수의계약')));
  check('밖으로 빌려주다·가지고 나가다 → 반출, 밖에서 빌려 오는 것은 아님', ['비품을 학교 밖으로 가지고 나가도 돼', '장비를 외부에 빌려줘도 되나'].every(question => phraseConcepts(question).includes('반출'))
    && ['외부에서 빌려온 장비', '외부로 공문 보내기', '외부 강사 초청'].every(question => !phraseConcepts(question).includes('반출')));
  check('돈을 벌다 → 수익, 돌려받다·벌금은 아님', ['기술이전으로 돈을 벌면', '사업으로 번 돈', '돈 버는 사업'].every(question => phraseConcepts(question).includes('수익'))
    && ['낸 돈을 되돌려 받으려면', '벌금은 얼마야'].every(question => !phraseConcepts(question).includes('수익')));
  check('동사가 가리키는 규정 명사: 사전이 규정 용어로 올린 낱말만', verbNoun('낳으면') === '출산' && verbNoun('기증받은') === '기증'
    && [verbNoun('잃어버리면'), verbNoun('고장나면'), verbNoun('출산'), verbNoun('가나다')].every(value => value === null));
  check('사전에 없는 낱말·객체 원형 키는 그대로', ['constructor', 'toString', '__proto__', '가나다'].every(word => businessTerms(word).length === 1));
  check('타대학 비교에는 규정 이름 동의어만', comparisonTerms('강사료').includes('강의료') && comparisonTerms('월급').length === 1 && comparisonTerms('식사').length === 1);
  check('사전은 규정 번호나 조문 번호를 담지 않음', [...require('../src/aliases.js').RULE_VOCABULARY.values()].flat().every(term => !/\d+조|^\d+$|LAW_ID/.test(term)));

  // ── 질문에서 낱말 뽑기 ──
  const terms = question => queryConcepts(question).concepts.filter(concept => !concept.joinedFrom).map(concept => concept.term);
  check('조사처럼 보이는 끝 글자가 낱말의 일부인 경우', terms('새 회계연도 시작 전에 예산 확정').includes('회계연도'));
  check('세는 말·서술어 끝은 낱말이 아님', !terms('근무시간은 몇 시부터야').some(term => /시부터|부터야/.test(term)) && !terms('임기는 몇 년이에요').some(term => /년이/.test(term)));
  check('한 글자 주제어 책·상', terms('책 연체하면 어떻게 돼').includes('책') && terms('외부 상 받을 때').includes('상'));
  check('질문어는 검색어가 아님', ['며칠', '언제까지', '누구한테'].every(word => !terms(`출장 정산 ${word} 해`).includes(word)));

  // ── 규정의 적용 범위 ──
  check('규정 제목에서 기관·주제 이름', ruleSubject('금장생활관규정') === '금장생활관' && ruleSubject('등록금심의위원회규정') === '등록금심의위원회' && ruleSubject('감사시행세칙(학생자치기구)') === '감사');
  check('규정집 편제로 범위 구분', ruleScopeClass('구매규정', '3-7-15') === 'general' && ruleScopeClass('북한학연구소규정', '7-5-1') === 'unit'
    && ruleScopeClass('등록금심의위원회규정', '4-0-24') === 'unit' && ruleScopeClass('감사시행세칙(학생자치기구)', '9-0-1') === 'self_governing');
  check('분류 코드가 없으면 제목으로 구분', ruleScopeClass('디지털인문학연구소 규정', '') === 'unit' && ruleScopeClass('여비규정', '') === 'general');
  check('학생자치기구 규정은 일반 질문에서 낮춤', generalRuleWeight('감사시행세칙(학생자치기구)', '감사에서 시정 요구 받으면', false, { code: '9-0-1' }) < 1);
  check('자치기구를 직접 말하면 낮추지 않음', ['총학생회 감사는 어떻게 해', '학생자치기구 감사', '동아리 감사'].every(question => generalRuleWeight('감사시행세칙(학생자치기구)', question, false, { code: '9-0-1' }) === 1));
  check('기관 한정 규정은 그 기관을 말하지 않으면 낮춤', generalRuleWeight('북한학연구소규정', '조교 임기', false, { code: '7-5-1', forms: ['조교', '임기'] }) < 1
    && generalRuleWeight('등록금심의위원회규정', '등록금 반환 기준', false, { code: '4-0-24', forms: ['등록금', '반환'] }) < 1);
  check('기관을 직접 말하면 낮추지 않음', generalRuleWeight('북한학연구소규정', '북한학연구소 조교 임기', false, { code: '7-5-1' }) === 1
    && generalRuleWeight('기숙사생수칙', '기숙사 식사 시간', false, { code: '6-6-6', forms: ['기숙사', '식사'] }) === 1
    && generalRuleWeight('금장생활관규정', '기숙사 퇴관', false, { code: '6-6-4', forms: ['기숙사', '생활관', '퇴관'] }) === 1);
  check('산학협력단 편은 산단을 말하면 낮추지 않음', generalRuleWeight('창업보육센터 관리 운영 내규', '산단 입주 절차', false, { code: '8-0-5' }) === 1
    && generalRuleWeight('창업보육센터 관리 운영 내규', '입주 절차', false, { code: '8-0-5' }) < 1);
  check('학교 전체에 적용되는 본규정은 낮추지 않음', generalRuleWeight('구매규정', '물품 구매 절차', false, { code: '3-7-15' }) >= 1 && generalRuleWeight('학칙', '휴학', false, { code: '2-1-1' }) >= 1);

  // ── 질문 의도와 조문 제목 ──
  check('언제 → 기일·지급일', headingCueStrength('강의료는 언제 들어와요', '지급기일') === 1 && headingCueStrength('월급날이 며칠이야', '지급일') === 1);
  check('얼마 → 지급액이 지급으로 끝나는 제목보다 직접적', headingCueStrength('수당 얼마 받아', '지급액') > headingCueStrength('수당 얼마 받아', '수당지급') && headingCueStrength('수당 얼마 받아', '지급대상') === 0);
  check('~하면 어떻게 돼 → 조치', headingCueStrength('책임시간 못 채우면 어떻게 돼', '책임시간 미달교원 조치') > 0);
  check('어떤 것들이 있어 → 종류, 주제어 징계만으로는 제재 의도가 아님', headingCueStrength('직원 징계는 어떤 것들이 있어', '징계의 종류') === 1 && headingCueStrength('직원 징계는 어떤 것들이 있어', '징계절차') === 0);
  check('무슨 일을 해 → 임무·직무, 몇 명 → 정원', headingCueStrength('조교는 무슨 일을 해', '임무') === 1 && headingCueStrength('조교는 몇 명까지 둘 수 있어', '정원') === 1);
  check('얼마 → 요금 이름으로 된 제목(…료·요금)', ['대관료', '공간사용료', '수수료', '응시료', '강사료', '보관료', '기술이전료', '입학금과 수업료', '이용요금'].every(heading => headingCueStrength('강당 빌리면 얼마 내', heading) === 1));
  check('료로 끝나도 요금이 아닌 제목은 아님', ['교육과정의 수료', '조기수료', '회계자료', '전처리 시료', '임기의 만료', '사업의 종료', '실습 재료', '진료', '동료 평가의 완료'].every(heading => headingCueStrength('강당 빌리면 얼마 내', heading) === 0));
  check('벌을 받다 → 징계·제재 제목, 벌점은 아님', headingCueStrength('규정 어기면 무슨 벌을 받아', '징계의 종류') === 1 && headingCueStrength('벌점은 어떻게 매겨', '징계의 종류') === 0);
  check('의도를 묻지 않으면 0', headingCueStrength('출장 숙박비', '지급기일') === 0 && headingCueStrength('언제 들어와요', '목적') === 0);

  // ── 색인 검색 ──
  const catalog = RULES.map(([lawId, title, code]) => ({ lawId, historyId: lawId * 10, title, code, revisedAt: '2026.03.01' }));
  const bodies = new Map(RULES.map(([lawId, , , articles]) => [lawId, articles.join('\n\n')]));
  const corpus = await buildCorpus({ catalog, loadContent: async lawId => ({ markdown: bodies.get(lawId) }) });
  const first = question => searchCorpus(corpus, question, { top: 5 }).hits[0];
  const order = question => searchCorpus(corpus, question, { top: 10 }).hits.map(hit => hit.lawId);

  check('일반 질문은 학교 규정이 자치기구 회칙보다 앞', first('우리 학교 회계연도는 언제부터 언제까지야')?.lawId === 10);
  check('자치기구를 말하면 그 회칙이 앞', first('총대의원회 회계연도는 언제부터야')?.lawId === 11);
  check('조문 제목이 질문 낱말 그대로이면 그 조문', first('회계연도 기간')?.articles[0].article === '제4조');
  check('일상어로 물어도 규정 용어 조문을 찾음', first('직무 관련자한테 식사 대접 받아도 돼')?.lawId === 12);
  check('사전의 다른 말은 원래 낱말보다 무겁지 않음', first('기숙사 식사 시간')?.lawId === 13);
  const allowance = first('명예퇴직하면 수당 얼마 받아');
  check('얼마를 물으면 지급액 조문을 먼저', allowance?.lawId === 14 && allowance.articles[0].article === '제4조');
  check('의도가 없으면 목적 조문을 뒤로 하고 낱말이 많은 조문을 먼저', first('명예퇴직 수당 근속')?.articles[0].article === '제3조');
  const audit = first('내부감사는 얼마나 자주 해');
  check('주제 낱말이 제목에만 있어도 의도에 맞는 조문', audit?.lawId === 15 && audit.articles[0].article === '제10조');
  check('기관 한정 규정보다 본규정이 앞', order('조교 임기는 몇 년이야').indexOf(17) < order('조교 임기는 몇 년이야').indexOf(16));
  check('기관을 말하면 그 규정이 앞', first('북한학연구소 조교 임기')?.lawId === 16);
  const birth = searchCorpus(corpus, '아기 낳으면 출산휴가 며칠이야', { top: 3 });
  check('출산휴가를 출산휴로 줄이지 않음', birth.hits[0]?.lawId === 18 && birth.hits[0].articles[0].article === '제43조' && birth.searchTerms.includes('출산휴가') && !birth.searchTerms.includes('출산휴'));
  const book = first('책 잃어버리면 물어내야 돼');
  check('동사로 물어도 분실·변상 조문', book?.lawId === 19 && book.articles[0].article === '제29조');
  check('한 낱말 질문도 색인에서 찾음', first('연체하면 어떻게 돼')?.lawId === 19);
  check('다른 규정이 인용하고 조문이 많은 규정이 같은 내용이면 앞', order('직원 위탁교육 경비').indexOf(20) < order('직원 위탁교육 경비').indexOf(21));
  const damage = first('사무실 노트북 망가뜨리면 물어내야 하나요');
  check('손상·변상을 구어로 물어도 물품 본규정의 조문', damage?.lawId === 24 && damage.articles[0].article === '제16조');
  for (const question of ['업체가 계약 안 지키면 계약 끊을 수 있어?', '납품업체가 약속을 어기면 해약할 수 있나요']) {
    const hit = first(question);
    check(`계약 해제·해지는 계약직 규정이 아니라 구매 규정: ${question}`, hit?.lawId === 25 && hit.articles[0].article === '제29조');
  }
  const budget = first('예산을 원래 목적 말고 다른 데 써도 돼?');
  check('다른 데 쓰다 → 목적 외 사용 조문', budget?.lawId === 27 && budget.articles[0].article === '제18조');
  const leave = first('아이 키우느라 휴학할 수 있어?');
  check('아이 키우느라 → 육아휴학 조문', leave?.lawId === 28 && leave.articles[0].article === '제68조');
  const annual = searchCorpus(corpus, '직원 연차휴가 일수', { top: 3 });
  check('연차휴가 → 연가 조문도 찾음(휴가로만 줄이면 연가 조문이 빠짐)', annual.hits[0]?.lawId === 18 && annual.hits[0].articles.some(item => item.article === '제35조') && annual.searchTerms.includes('연가') && !annual.rewrittenTerms.연차휴가);
  const childbirth = first('낳으면 쉴 수 있어?');
  check('낳다 → 출산이 먼저: 같은 묶음의 육아가 더 드문 낱말이어도 출산 조문이 앞', childbirth?.lawId === 18 && childbirth.articles[0].article === '제43조'
    && childbirth.articles.findIndex(item => item.article === '제120조') > 0);
  const rental = first('회의실 빌리면 얼마야');
  check('얼마를 물으면 요금 조문이 대상 조문보다 앞, 수료 조문은 아님', rental?.lawId === 29 && rental.articles[0].article === '제21조');
  const penalty = first('일을 게을리하면 무슨 벌을 받아');
  check('벌을 받다 → 징계 조문', penalty?.lawId === 30 && penalty.articles[0].article === '제20조');
  const negotiated = first('입찰 없이 계약해도 되는 금액');
  check('입찰 없이 계약 → 수의계약 조문, 경쟁입찰 조문이 아님', negotiated?.lawId === 31 && negotiated.articles[0].article === '제7조');
  check('경쟁입찰을 물으면 수의계약으로 바꾸지 않음', first('경쟁입찰 낙찰자는 어떻게 정해')?.articles[0].article === '제9조');
  const takeout = first('학교 장비를 외부에 빌려줘도 돼');
  check('밖으로 빌려주다 → 반출 조문', takeout?.lawId === 24 && takeout.articles[0].article === '제11조');
  check('영어 낱말·기호가 든 질문도 예외 없이 처리', ['constructor 규정', 'toString 여비', '??? !!!'].every(question => Array.isArray(searchCorpus(corpus, question).hits)));

  console.log(`📊 자연어 일반 규칙 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

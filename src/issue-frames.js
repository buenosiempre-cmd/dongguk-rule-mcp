'use strict';

const { createResolver, extractReferences, summarizeExternalLaws, normalizeName } = require('./references');

// 사안 프레임(issue frame): 규정명과 위계가 다른 대학 사이에서 "같은 사안"을 가려내는 기준.
// 한 사안은 주체(subjects) × 행위(terms) × 규율 요소(slots)로 정의하고, 상위 법령(upperLaws)을
// 공통 좌표로 삼는다. 같은 단어가 다른 뜻으로 쓰인 조문(교내 겸무의 "겸직" 등)은 exclude로 뺀다.
// 모든 판정은 문자열 대조이다. 법적 동등성·적용 여부를 뜻하지 않는다.
//
//  terms      조문 일치어. 첫 항목이 대표어·검색어.
//  searchTerms 전문검색에 쓸 검색어(생략하면 terms 앞 두 개).
//  titleHints 규정 제목 우선순위용 단서(조문 일치에는 쓰지 않음).
//  subjects   적용 주체 후보. 조문·규정명에서 확인되면 함께 표시한다.
//  exclude    title: 규정명에 있으면 다른 사안의 규정. article: 조문에 있으면 다른 사안의 조문.
//  context    조문 본문에 하나는 있어야 사안으로 본다. 없으면 "언급만"으로 뺀다(빈 배열이면 검사 안 함).
//  slots      규율 요소. patterns 중 하나가 조문의 어느 줄과 맞으면 그 요소를 다룬다고 본다.
//  upperLaws  이 사안을 위임·규율하는 국가 법령. 조문이 인용한 법령과 대조해 inFrame을 붙인다.
const FRAMES = [
  {
    id: 'external_concurrent_office', topic: '겸직', label: '교직원의 외부기관 겸직',
    terms: ['겸직', '겸업'], titleHints: ['겸직', '겸업', '복무', '행동강령', '창업'],
    subjects: ['교원', '교직원', '직원', '교수', '연구원'],
    exclude: {
      title: ['JA교원', '겸임교원', '겸무', '교내겸직', '내부겸직', '대학원', '학사운영'],
      article: ['겸직학과', '겸직발령', '겸직철회', '학과에 겸직', '소속변경', '겸임교원'],
    },
    context: ['외부', '영리', '기업', '기관', '사외이사', '창업', '허가', '겸업', '직무관련자', '벤처', '임직원', '보수', '방송'],
    upperLaws: [
      { lawName: '교육공무원법', articles: ['제19조'] },
      { lawName: '사립학교법', articles: ['제55조'] },
      { lawName: '국가공무원법', articles: ['제64조'] },
      { lawName: '국가공무원 복무규정', articles: ['제25조', '제26조'] },
      { lawName: '산업교육진흥 및 산학연협력촉진에 관한 법률', articles: ['제36조의7'] },
      { lawName: '벤처기업육성에 관한 특별조치법', articles: ['제16조의2'] },
    ],
    slots: [
      { key: 'permission', label: '허가권자·절차', patterns: [/허가/, /승인/, /신청/] },
      { key: 'scope', label: '허가 대상 기관·직위', patterns: [/영리/, /비영리/, /기업/, /사외이사/, /임직원/, /대표자/, /기술지주/, /벤처/, /공공기관/, /위원회\s*위원/] },
      { key: 'hours', label: '시간 한도', patterns: [/시간\s*(?:이내|이하|을\s*초과)/, /주당/, /주\s*\d+\s*시간/] },
      { key: 'period', label: '기간·연장', patterns: [/겸직\s*기간/, /기간은/, /연장/, /\d+\s*년\s*(?:이내|을\s*넘)/] },
      { key: 'compensation', label: '보수·급여 처리', patterns: [/보수/, /급여/, /수당/, /지분/] },
      { key: 'prohibition', label: '금지·제한 사유', patterns: [/금지/, /제한/, /하여서는\s*아니/, /할\s*수\s*없다/, /지장/] },
      { key: 'reporting', label: '보고·심사', patterns: [/보고/, /제출/, /심의/, /심사/] },
      { key: 'sanction', label: '해제·위반 시 효과', patterns: [/해제/, /취소/, /징계/, /휴직/] },
    ],
  },
  {
    id: 'business_travel_expenses', topic: '여비', label: '교직원 출장 여비 지급',
    terms: ['여비', '출장', '숙박'], titleHints: ['여비', '출장'],
    subjects: ['교직원', '교원', '직원', '임원'],
    exclude: { title: ['학생', '수학여행', '현장학습'], article: [] },
    context: ['출장', '여비', '일비', '숙박', '식비', '교통', '운임', '항공'],
    upperLaws: [
      { lawName: '공무원 여비 규정', articles: [] },
      { lawName: '소득세법', articles: ['제12조'] },
      { lawName: '소득세법 시행령', articles: ['제12조'] },
    ],
    slots: [
      { key: 'eligibility', label: '지급 대상·등급 구분', patterns: [/지급\s*대상/, /구분/, /등급/, /직급/] },
      { key: 'per_diem', label: '일비', patterns: [/일비/] },
      { key: 'lodging', label: '숙박비', patterns: [/숙박/] },
      { key: 'meals', label: '식비', patterns: [/식비/] },
      { key: 'transport', label: '운임·교통비', patterns: [/운임/, /교통비/, /항공/, /철도/, /자가용|자가\s*차량|개인\s*차량/] },
      { key: 'overseas', label: '국외 출장', patterns: [/국외/, /해외/] },
      { key: 'approval', label: '출장 명령·승인', patterns: [/출장\s*명령/, /승인/, /허가/, /결재/] },
      { key: 'settlement', label: '정산·증빙', patterns: [/정산/, /증빙/, /영수증/, /실비/] },
      { key: 'reduction', label: '감액·미지급', patterns: [/감액/, /지급하지\s*아니/, /공제/, /지급하지\s*않/] },
    ],
  },
  {
    id: 'research_fund_management', topic: '연구비', label: '연구비 관리·집행',
    terms: ['연구비', '연구지원'], titleHints: ['연구비', '연구', '산학협력'],
    subjects: ['연구책임자', '교원', '연구원', '참여연구원'],
    exclude: { title: [], article: [] },
    context: ['연구', '과제', '연구비', '집행', '정산'],
    upperLaws: [
      { lawName: '국가연구개발혁신법', articles: [] },
      { lawName: '산업교육진흥 및 산학연협력촉진에 관한 법률', articles: [] },
    ],
    slots: [
      { key: 'overhead', label: '간접비', patterns: [/간접비/, /간접\s*경비/] },
      { key: 'personnel', label: '인건비·참여율', patterns: [/인건비/, /참여연구원/, /참여율/] },
      { key: 'execution', label: '집행 기준', patterns: [/집행/, /사용\s*(?:기준|용도|범위)/] },
      { key: 'settlement', label: '정산·반납', patterns: [/정산/, /반납/, /잔액/] },
      { key: 'incentive', label: '성과·인센티브', patterns: [/인센티브/, /장려금/, /성과/, /지원금/] },
      { key: 'sanction', label: '제재·환수', patterns: [/제재/, /환수/, /징계/, /참여\s*제한/] },
      { key: 'committee', label: '심의 기구', patterns: [/위원회/, /심의/] },
    ],
  },
  {
    id: 'tuition_refund', topic: '등록금 반환', label: '등록금 반환',
    terms: ['등록금', '반환', '환불'], titleHints: ['등록금', '납입', '환불'],
    subjects: ['학생', '신입생', '재학생', '휴학생'],
    exclude: { title: ['장학'], article: [] },
    context: ['반환', '환불', '등록금', '휴학', '자퇴', '제적', '입학 포기', '입학포기'],
    upperLaws: [
      { lawName: '고등교육법', articles: ['제11조'] },
      { lawName: '대학 등록금에 관한 규칙', articles: ['제6조'] },
    ],
    slots: [
      { key: 'grounds', label: '반환 사유', patterns: [/휴학/, /자퇴/, /제적/, /입학\s*포기/, /미등록/, /사망/, /입영/] },
      { key: 'ratio', label: '반환 비율·기산', patterns: [/\d+\s*분의\s*\d+/, /\d+\s*\/\s*\d+/, /%/, /전액/, /반액/, /개월/, /이내|경과/] },
      { key: 'timing', label: '반환 시기', patterns: [/일\s*이내/, /지급\s*시기/, /즉시/, /환급/] },
      { key: 'components', label: '입학금·수업료 구분', patterns: [/입학금/, /수업료/, /기성회/, /학생회비/] },
      { key: 'procedure', label: '신청 절차', patterns: [/신청/, /제출/, /승인/] },
    ],
  },
  {
    id: 'retirement_benefit', topic: '퇴직급여', label: '교직원 퇴직급여',
    terms: ['퇴직', '퇴직금', '퇴직급여'], titleHints: ['퇴직', '급여', '보수'],
    subjects: ['교직원', '직원', '교원', '근로자'],
    exclude: { title: ['연금법'], article: [] },
    context: ['퇴직', '근속', '연금', '적립', '급여'],
    upperLaws: [
      { lawName: '근로자퇴직급여 보장법', articles: [] },
      { lawName: '사립학교교직원 연금법', articles: [] },
    ],
    slots: [
      { key: 'eligibility', label: '지급 대상', patterns: [/대상/, /적용/, /1년\s*(?:이상|미만)/] },
      { key: 'calculation', label: '산정 방식', patterns: [/산정/, /평균\s*임금/, /근속/, /계산/] },
      { key: 'timing', label: '지급 시기', patterns: [/일\s*이내/, /지급\s*시기/, /지급한다/] },
      { key: 'plan_type', label: '제도 유형', patterns: [/확정\s*급여/, /확정\s*기여/, /DB/, /DC/, /퇴직\s*연금/] },
      { key: 'interim', label: '중간 정산', patterns: [/중간\s*정산/, /중도/] },
      { key: 'reduction', label: '감액·제한', patterns: [/감액/, /제한/, /징계/] },
    ],
  },
  {
    id: 'work_study', topic: '근로장학', label: '교내 근로장학',
    terms: ['근로장학', '근로보조금', '교내근로', '근로학생'], titleHints: ['장학'],
    subjects: ['학생', '재학생', '대학원생'],
    exclude: { title: [], article: [] },
    context: ['근로', '장학'],
    upperLaws: [],
    slots: [
      { key: 'eligibility', label: '신청 자격', patterns: [/자격/, /성적/, /학점/, /평점/, /소득/] },
      { key: 'hours', label: '근로 시간', patterns: [/시간/] },
      { key: 'rate', label: '단가·금액', patterns: [/단가/, /시간당/, /금액/, /원\b/, /지급액/] },
      { key: 'selection', label: '선발', patterns: [/선발/, /신청/, /모집/] },
      { key: 'management', label: '관리·평가', patterns: [/관리/, /평가/, /근무/, /출근/] },
      { key: 'payment', label: '지급', patterns: [/지급/] },
    ],
  },
  {
    id: 'scholarship', topic: '장학금', label: '장학금 지급',
    terms: ['장학금'], titleHints: ['장학'],
    subjects: ['학생', '재학생', '신입생', '대학원생'],
    exclude: { title: [], article: [] },
    context: ['장학'],
    upperLaws: [{ lawName: '고등교육법', articles: [] }, { lawName: '한국장학재단 설립 등에 관한 법률', articles: [] }],
    slots: [
      { key: 'kinds', label: '종류', patterns: [/종류/, /구분/] },
      { key: 'eligibility', label: '자격', patterns: [/자격/, /성적/, /학점/, /평점/] },
      { key: 'selection', label: '선발·심사', patterns: [/선발/, /심사/, /위원회/] },
      { key: 'amount', label: '금액', patterns: [/금액/, /지급액/, /전액|반액/, /%/] },
      { key: 'duplication', label: '중복 수혜', patterns: [/중복/, /이중/] },
      { key: 'revocation', label: '취소·환수', patterns: [/취소/, /환수/, /지급\s*중지/] },
    ],
  },
].map(frame => Object.freeze({ ...frame, searchTerms: frame.searchTerms || frame.terms.slice(0, 2) }));

const compact = s => String(s ?? '').replace(/\s+/g, '');
const resolver = createResolver([]);

// 주제어 변형(접두어·끝 '금' 제거 등)으로 등록된 프레임을 찾는다. 없으면 null.
function resolveFrame(variants) {
  const keys = (Array.isArray(variants) ? variants : [variants]).map(compact).filter(Boolean);
  return FRAMES.find(f => keys.includes(compact(f.topic))) || null;
}

// 조문이 인용한 국가 법령. 프레임의 상위 법령과 같으면 inFrame: true.
// 교내 규정명(「교원창업규정」 등)은 법령이 아니므로, 법령 접미(법·시행령·규칙)로 확인된 이름이나
// 프레임의 근거 법령과 같은 이름만 남긴다.
function citedLaws(text, frame) {
  const laws = summarizeExternalLaws(extractReferences(text, resolver));
  const keys = new Set((frame?.upperLaws || []).map(l => normalizeName(l.lawName)));
  return laws.map(l => ({ lawName: l.lawName, articles: l.articles, inFrame: keys.has(normalizeName(l.lawName)), confirmed: !!l.confirmedLawName }))
    .filter(l => l.confirmed || l.inFrame).map(({ confirmed, ...l }) => l);
}

// 한 조문을 프레임에 비춰 본다. excluded가 있으면 비교에서 뺀다.
//  other_issue_rule   규정명이 다른 사안(JA교원 운영규정 등)
//  other_issue_article 조문이 다른 사안(겸직학과 발령 등 교내 겸무)
//  mention_only       주제어는 있지만 사안 맥락이 없거나 규율 요소를 하나도 정하지 않음
function analyzeArticle(block, rule, frame) {
  const body = String(block.content || ''), heading = body.split('\n')[0];
  const c = compact(body), ct = compact(rule.title);
  if (frame.exclude.title.some(t => ct.includes(compact(t)))) return { excluded: 'other_issue_rule' };
  if (frame.exclude.article.some(t => c.includes(compact(t)))) return { excluded: 'other_issue_article' };
  const headingMatch = frame.terms.some(t => heading.includes(t));
  const titleMatch = frame.terms.some(t => rule.title.includes(t));
  const inContext = !frame.context.length || frame.context.some(t => body.includes(t));
  const [headLine, ...bodyLines] = body.split('\n').map(l => l.replace(/^###\s*/, '').trim()).filter(Boolean);
  // 조문 제목이나 규정명에 사안어가 없으면, 사안어가 든 줄만 규율 요소의 근거로 삼는다(다른 사안의 항·호 배제).
  const eligible = headingMatch || titleMatch ? bodyLines : bodyLines.filter(l => frame.terms.some(t => l.includes(t)));
  const slots = [];
  for (const slot of frame.slots) {
    const inHeading = slot.patterns.some(p => p.test(headLine || ''));
    const line = eligible.find(l => slot.patterns.some(p => p.test(l))) || (inHeading && (headingMatch || titleMatch) ? headLine : null);
    if (line) slots.push({ key: slot.key, label: slot.label, evidence: line.slice(0, 200), inHeading });
  }
  if (!headingMatch && (!inContext || !slots.length)) return { excluded: 'mention_only' };
  // '교직원'이 맞으면 그 안의 '직원'은 따로 세지 않는다.
  const found = frame.subjects.filter(s => body.includes(s) || rule.title.includes(s));
  const subjects = found.filter(s => !found.some(o => o !== s && o.includes(s)));
  return { excluded: null, slots, headingMatch, subjects, anchorLaws: citedLaws(body, frame) };
}

// 대학 열마다 주규정·보조규정을 가른다. 제목에 사안어가 있는 규정이 주규정이고, 없으면 그 열에서
// 규율 요소를 가장 많이(3개 이상) 다루는 규정(동수면 모두)을 주규정으로 본다.
function assignRoles(rules, titleScore) {
  const titled = rules.filter(r => titleScore(r) >= 2);
  if (titled.length) return rules.map(r => ({ ...r, role: titled.includes(r) ? 'primary' : 'secondary' }));
  const top = Math.max(0, ...rules.map(r => r.slots.length));
  return rules.map(r => ({ ...r, role: top >= 3 && r.slots.length === top ? 'primary' : 'secondary' }));
}

// 규율 요소 × 대학 표. 칸은 found / not_found_in_scope / unavailable / unsupported.
function buildSlotMatrix(frame, columns) {
  const slots = frame.slots.map(slot => ({
    key: slot.key, label: slot.label,
    cells: Object.fromEntries(columns.map(col => {
      if (['unavailable', 'unsupported'].includes(col.status)) return [col.university, { status: col.status }];
      const cell = col.slotCells?.[slot.key];
      return [col.university, cell ? { status: 'found', ...cell } : { status: 'not_found_in_scope' }];
    })),
  }));
  const anchorLaws = Object.fromEntries(columns.map(col => [col.university, col.anchorLaws || []]));
  return { slots, anchorLaws };
}

function frameSummary(frame) {
  return { id: frame.id, topic: frame.topic, label: frame.label, subjects: frame.subjects, terms: frame.terms,
    slots: frame.slots.map(s => ({ key: s.key, label: s.label })), upperLaws: frame.upperLaws,
    excluded: { title: frame.exclude.title, article: frame.exclude.article } };
}

const DROP_LABELS = { other_issue_rule: '다른 사안의 규정', other_issue_article: '다른 사안의 조문', mention_only: '언급만' };

module.exports = { FRAMES, resolveFrame, analyzeArticle, assignRoles, buildSlotMatrix, frameSummary, citedLaws, DROP_LABELS };

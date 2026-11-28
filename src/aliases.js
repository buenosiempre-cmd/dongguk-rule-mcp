'use strict';

const fs = require('fs');
const { data: ontologyData } = require('./ontology');

// 가운뎃점 계열 5종 흡수 (korean-law-mcp v4.9 교훈: 공식 표기 ㆍ(U+318D) vs 실무 표기 ·(U+00B7))
const MIDDOT_CLASS = '[·ㆍ‧•・]';
const MIDDOT_RE = new RegExp(MIDDOT_CLASS);
const MIDDOT_RE_G = new RegExp(MIDDOT_CLASS, 'g');

// 기본 별칭 — 대학 실무 통용 축약만 최소 수록. 확장은 외부 JSON(DONGGUK_RULE_ALIASES) 권장.
const BUILTIN_ALIASES = {
  '전결규정': ['위임전결규정'],
  '전결규칙': ['위임전결규정'],
  '취규': ['취업규칙'],
};

let externalCache;
function loadExternalAliases() {
  if (externalCache !== undefined) return externalCache;
  externalCache = {};
  const file = (process.env.DONGGUK_RULE_ALIASES || '').trim();
  if (!file) return externalCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [alias, target] of Object.entries(parsed)) {
        const list = (Array.isArray(target) ? target : [target])
          .map(x => String(x || '').trim())
          .filter(Boolean);
        if (alias.trim() && list.length) externalCache[alias.trim()] = list;
      }
    }
  } catch (e) {
    // 별칭 파일 오류는 치명적이지 않음 — stderr로만 알림 (stdout 오염 금지)
    console.error(`[dongguk-rule-mcp] 별칭 파일 로드 실패(${file}): ${e.message}`);
  }
  return externalCache;
}

function aliasTable() {
  return { ...BUILTIN_ALIASES, ...loadExternalAliases() };
}

// 테스트에서 env 변경 후 재로딩용
function resetAliasCacheForTest() { externalCache = undefined; }

function normalizeMiddots(value) {
  return String(value || '').replace(MIDDOT_RE_G, 'ㆍ');
}

// 검색용 표기 변형: 가운뎃점이 있으면 ㆍ/· 두 형태를 모두 생성 (사이트 표기 불일치 대비)
function middotVariants(value) {
  const text = String(value || '');
  if (!MIDDOT_RE.test(text)) return [text];
  return [...new Set([
    text,
    text.replace(MIDDOT_RE_G, 'ㆍ'),
    text.replace(MIDDOT_RE_G, '·'),
  ])];
}

function aliasKey(value) {
  return normalizeMiddots(value).replace(/\s+/g, '');
}

function phrasePattern(value) {
  return [...aliasKey(value)].map(char => char === 'ㆍ'
    ? MIDDOT_CLASS
    : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t]*');
}

// 별칭 확장 — 정확 일치와 결합형 모두 지원 (korean-law v4.0.4 방식)
// 예: "전결규정" → "위임전결규정", "전결규정 제5조" → "위임전결규정 제5조"
function expandAliases(query) {
  const input = String(query || '').trim();
  if (!input) return [];
  const table = aliasTable();
  const out = [];
  const push = v => { const t = String(v || '').trim(); if (t && t !== input && !out.includes(t)) out.push(t); };
  const compact = aliasKey(input);
  // Protect full official names before expanding embedded shorthand. A query
  // may contain both an official name and a separate shorthand occurrence.
  const officialSpans = [];
  for (const target of new Set(Object.values(table).flat())) {
    const pattern = phrasePattern(target);
    if (!pattern) continue;
    for (const match of input.matchAll(new RegExp(pattern, 'g'))) {
      officialSpans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  for (const [alias, targets] of Object.entries(table)) {
    if (compact === aliasKey(alias)) {
      targets.forEach(push);
    } else {
      const pattern = phrasePattern(alias);
      if (!pattern) continue;
      for (const target of targets) {
        push(input.replace(new RegExp(pattern, 'g'), (match, offset) => {
          if (officialSpans.some(span => offset < span.end && offset + match.length > span.start)) return match;
          // A suffix inside another rule name is not an independently named alias.
          if (offset > 0 && /[가-힣A-Za-z0-9]/.test(input[offset - 1])) return match;
          return target;
        }));
      }
    }
  }
  return out;
}


// ── 업무 용어 사전 ──────────────────────────────────────────────
// Everyday wording → the words rules use. A group lists several ways people
// say one concept and the rule vocabulary that stands for it. A form is used
// only when some indexed rule contains it, so an entry cannot invent a match.
// Entries are business concepts, never a question-to-rule or question-to-
// article mapping.
const CONCEPT_GROUPS = ontologyData.concepts.map(({everyday, rule}) => [everyday, rule]);

const RULE_VOCABULARY = new Map();
for (const [everyday, ruleTerms] of CONCEPT_GROUPS) {
  for (const word of everyday) {
    const known = RULE_VOCABULARY.get(word) || [];
    RULE_VOCABULARY.set(word, [...new Set([...known, ...ruleTerms.filter(term => term !== word)])]);
  }
}
// Everyday compounds that ask about two things at once. Each part is searched
// as its own concept instead of one word standing for both.
const COMPOUND_WORDS = new Map([
  ['월급날', ['월급', '지급일']], ['급여일', ['급여', '지급일']], ['급여날', ['급여', '지급일']], ['봉급날', ['봉급', '지급일']],
]);
function compoundParts(term) { return COMPOUND_WORDS.get(term) || [term]; }
// Everyday phrases of several words that a rule says in one ("없을 때" → 부재).
// The rule word is searched as an extra concept of the question.
const PHRASE_CONCEPTS = [
  [/없을\s*때|자리에\s*없|자리를?\s*비우|부재\s*중/, '부재'],
  [/못\s*채우|못\s*채운|안\s*채우|다\s*못\s*하/, '미달'],
  [/다시\s*(?:입학|들어오)/, '재입학'], [/다시\s*(?:수강|듣)/, '재수강'], [/다시\s*(?:임용|계약|뽑)/, '재임용'],
  [/안\s*내면|못\s*내면|밀리면/, '미납'],
  [/안\s*지키|지키지\s*않/, '위반'],
  [/안\s*(?:해도|써도|찍어도|내도|받아도)\s*(?:돼|되)/, '생략'],
  [/새로\s*만들|새로\s*생기/, '제정'],
  // 벌다 by its endings ("돈 벌면", "돈을 벌어도", "돈 버는"); 벌써·벌금·벌점 are other words.
  [/번\s*돈|벌어들인|돈을?\s*(?:벌(?:면|어|었|고|려|게|기|지|다|던|든|거나|더라도|\s+수|\s+때|(?=[\s?.!]|$))|버는)/, '수익'],
  [/(?:다른|딴)\s*(?:데|곳|용도|목적)|목적\s*(?:외|말고|이외|밖)|돌려\s*(?:써|쓰|쓸)/, '목적외'],
  [/계약\s*(?:을\s*)?(?:취소|깨|끊|파기)|계약\s*안\s*지키/, '해약'],
  [/자동으로\s*(?:퇴직|면직|그만)|저절로\s*(?:퇴직|면직)/, '당연퇴직'],
  [/다른\s*(?:대학|학교)(?:에서|\s*다니다)|옮겨\s*(?:오|올|와)/, '편입'],
  [/다시\s*(?:학교|다니|등록)|학교로?\s*돌아/, '복학'],
  [/예산.{0,8}(?:짜|세우|잡)/, '편성'],
  [/(?:공문|문서|서류|우편).{0,8}받/, '접수'],
  [/계약.{0,6}(?:몇\s*년|기간|단위)/, '계약기간'],
  [/(?:몇\s*살|몇\s*세|나이).{0,12}(?:일할|일하|근무|재직|퇴직)|(?:일할|일하|근무|재직).{0,12}(?:몇\s*살|몇\s*세|나이)/, '정년'],
  [/(?:하던|맡은|담당).{0,6}(?:일|업무).{0,10}(?:넘겨|넘기|물려)|업무.{0,4}(?:넘겨|넘기)/, '인계'],
  // 수업연한: the student is the one who studies ("학생은 몇 년 다닐 수 있어?", even beside "교수에게"), or the whole
  // question is about school with no worker in it ("학교 몇 년 다녀야 졸업해?"). "학생 상담하는 교수는 몇 년" is not.
  [/(?:학생|학부생|대학원생|재학생|신입생|학부|대학원|학사과정|학위과정)(?:은|는|이|가|도|에서)?\s*(?:최대\s*|최장\s*)?몇\s*년.{0,8}(?:다녀|다니|다닐)|^(?=.*(?:학생|학부|대학원|학위|졸업|학사과정|재학|입학))(?!.*(?:직원|교원|교수|강사|근무|회사|재직|근속|승진))(?=.*(?:몇\s*년.{0,8}(?:다녀|다니|다닐)|(?:다녀|다니|다닐).{0,8}몇\s*년))/, '수업연한'],
  // The third member: false for the pattern used while the names dictionary is off, true for its
  // replacement while it is on.
  [/(?:못\s*뽑|뽑을\s*수\s*없|(?:임용|채용|선발)될\s*수\s*없|될\s*수\s*없는\s*사람)/, '결격사유', false],
  [/(?:못\s*뽑|뽑을\s*수\s*없|뽑힐\s*수\s*없|(?:임용|채용|선발)될\s*수\s*없|될\s*수\s*없는\s*사람)/, '결격사유', true],
  // 열람 needs a record to look at; a person's own 개인정보 is one (정보주체의 열람청구).
  [/(?:자료|기록|문서|서류|장부|성적|개인정보).{0,20}(?:보여\s*(?:달라|줘|줄)|볼\s*수|열람)/, '열람'],
  [/개인\s*(?:용무|용도|적으로|일로|볼일)|사적으로|집에\s*가져/, '사적'],
  [/(?:한\s*곳|한\s*군데|하나|한\s*명).{0,3}(?:만|밖에).{0,10}(?:들어오|참여|응찰|입찰)/, '재입찰'],
  [/(?:서류|계약서|영수증|증빙).{0,6}없이/, '생략'],
  // A contract made without bidding is 수의계약. "경쟁 없이" alone also describes promotion,
  // hiring or admission, so it counts only beside a purchase or contract word; 계약직, 임용계약
  // and 재계약 are about employment, not purchasing.
  [/입찰(?:을|에)?\s*(?:없이|안\s*(?:붙|부치|거치|하)|(?:붙이|부치|거치|하)지\s*않)|^(?=.*(?:(?<!임용|근로|고용|채용|재)계약(?!직|기간|교수|교원)|구매|구입|발주|납품|업체|견적|용역)).*경쟁(?:을|에)?\s*(?:없이|안\s*(?:붙|부치|거치|하)|(?:붙이|부치|거치|하)지\s*않)/, '수의계약'],
];
function phraseConcepts(query) {
  const text = String(query || '');
  const labels = labelsEnabled();
  return PHRASE_CONCEPTS.filter(([pattern, , only]) => (only === undefined || only === labels) && pattern.test(text)).map(([, term]) => term);
}
// Verbs people use where a rule has a noun ("잃어버렸는데" → 분실, "물어내야" → 변상).
// The pattern reads the start of the word, so every ending of the verb is covered.
const VERB_STEMS = [
  [/^잃어버/, '잃어버리'], [/^고장(?:난|나|났)/, '고장'], [/^출장(?:가|갈|갔|간)/, '출장'],
  [/^(?:기증|기부|증정)(?:받|한|하|된|되)/, '기증'], [/^(?:발주|주문|구입)(?:해|한|하|할|했)/, '발주'],
  [/^물어(?:내|주|줘|줄)/, '물어내'], [/^빌(?:리|려|릴|린)/, '빌리'], [/^돌려(?:받|주|줘|줄)/, '돌려받'],
  [/^끊(?:기|겨|긴|길)/, '끊기'], [/^끊(?:을|어|으|고|는)/, '끊'],
  [/^망가(?:뜨리|뜨려|뜨린|트리|트려|지|졌)/, '망가뜨리'], [/^부(?:수|숴|쉈|순|술)/, '부수'], [/^깨(?:뜨리|뜨려|뜨린|트리|졌)/, '깨뜨리'],
  [/^끝(?:나|났|난|날)/, '끝나'], [/^쓰(?:려|고|면|는|던)|^써(?:도|서|야)?$|^쓸$|^쓴$/, '쓰'],
  [/^적(?:어|을|는|으)/, '적'], [/^키(?:우|워|울|운)/, '키우'], [/^맺(?:어|으|을|는|은)/, '맺'], [/^책임(?:져|지|질|진)/, '책임지'], [/^아(?:끼|껴|낄|낀)/, '아끼'], [/^미(?:루|뤄|룰|룬)/, '미루'], [/^옮(?:기|겨|길|긴)/, '옮기'],
  [/^바(?:꾸|꿔|꿀|꾼)/, '바꾸'], [/^늦(?:어|으|게|은|을)/, '늦'], [/^빠(?:지|져|질|진)/, '빠지'],
  [/^그만(?:두|둬|둘|둔)/, '그만두'], [/^다(?:치|쳐|쳤|칠)/, '다치'], [/^뽑(?:아|을|는|으|힌|히)/, '뽑'],
  [/^깎(?:이|아|여|을|는)/, '깎'], [/^내(?:야|면|는)$/, '내야'], [/^낳(?:으|아|은|을|는)/, '출산'],
  [/^팔(?:아|면|고|려|지|았)/, '팔'], [/^쓸모없/, '쓸모없'], [/^버(?:리|려|릴|린)/, '버리'],
  [/^아(?:파(?:서|요|도|야)?$|프(?:면|다|고|니|지)|픈|플)/, '아프'], [/^나가/, '나가'], [/^들어가/, '들어가'], [/^쉬(?:는|고|려|면|어|었)|^쉴/, '쉬'],
  [/^보(?:내|낼|낸)/, '보내'], [/^찍(?:어|으|는|을|고)/, '찍'], [/^걷(?:어|으|는|을|고)/, '걷'], [/^짜(?:야|는|면|고)?$/, '짜'],
  [/^넘(?:으|는|어|게|겨|긴|길|을)/, '넘'], [/^모자라/, '모자라'], [/^겹(?:치|쳐|칠|친)/, '겹치'],
  [/^잘못/, '잘못'], [/^틀(?:리|려|릴|린)/, '틀리'], [/^속(?:이|여|일|인)/, '속이'], [/^어(?:기|겨|길|긴)/, '어기'],
  [/^죽(?:으|었|은|을)/, '죽'], [/^일(?:하|해|할|한)/, '일하'], [/^가르(?:치|쳐|칠|친)/, '가르치'],
  [/^알(?:려야|리|릴|린)/, '알리'], [/^만(?:들|든)/, '만들'], [/^없(?:애|앨|앤)/, '없애'], [/^고(?:치|쳐|칠|친)/, '고치'],
  [/^차(?:리|려|릴|린)/, '차리'], [/^넘겨(?:주|줘|줄|준)/, '넘겨주'], [/^걷어(?:가|갈|간)/, '걷어가'], [/^없어(?:지|져|질|진)/, '없어지'],
  [/^줄(?:이|여|일|인)/, '줄이'], [/^늘(?:리|려|릴|린)/, '늘리'], [/^떨어(?:지|져|질|진)/, '떨어지'], [/^커닝|^컨닝/, '커닝'],
];
// Endings that rules and people swap for the same thing (심사비·심사료·심사수당).
const SUFFIX_VARIANTS = [['비', '료', '수당'], ['연도', '년도'], ['요구', '요청'], ['교수', '교원'], ['장학생', '장학금']];
function suffixVariants(term) {
  const variants = [];
  for (const group of SUFFIX_VARIANTS) {
    const suffix = group.find(ending => term.endsWith(ending) && term.length - ending.length >= 2);
    if (suffix) for (const other of group) if (other !== suffix) variants.push(term.slice(0, -suffix.length) + other);
  }
  return variants;
}
// Longer words that contain a search word but mean something else. A rule that
// only has the longer word does not match ("계약" is not 계약직, "보수" is not 하자보수).
const OTHER_WORDS = new Map([
  ['계약', /계약직/g], ['보수', /하자\s*보수|유지\s*보수|보수\s*공사|개보수/g], ['교수', /교수학습|교수법|교수시간/g],
]);
function containsTerm(text, term) {
  if (!text.includes(term)) return false;
  const other = OTHER_WORDS.get(term);
  return other ? text.replace(other, '').includes(term) : true;
}
// Everyday names of people, bodies and things that rules call something else (미화원 → 미화직,
// 한의대 → 한의과대학, 킥보드 → 개인형 이동장치). Kept apart from the concept groups above: each
// entry names a class of the ontology, the everyday name is one the rule book hardly uses, and
// every rule term occurs in the rule book.
// The names, and the word handling that came with them (two particles on one noun, "뭐 하는 곳",
// "뽑힐 수 없는"), are used only when DONGGUK_MCP_LABELS is on. Off, every function here and in
// lookup.js returns what it returned before they were added.
const LABELS_ON = new Set(['1', 'on', 'true', 'yes']);
const labelsEnabled = (value = process.env.DONGGUK_MCP_LABELS) => LABELS_ON.has(String(value || '').trim().toLowerCase());
const LABEL_VOCABULARY = new Map();
for (const { everyday, rule } of ontologyData.labels || []) {
  for (const word of everyday) LABEL_VOCABULARY.set(word, [...new Set([...(LABEL_VOCABULARY.get(word) || []), ...rule.filter(term => term !== word)])]);
}
const ruleTermsOf = word => [...(RULE_VOCABULARY.get(word) || []), ...(labelsEnabled() && LABEL_VOCABULARY.get(word) || [])];
// The question word, its stem, and the rule vocabulary that may stand for it.
function businessTerms(term, { verbs = true } = {}) {
  const stem = (verbs && VERB_STEMS.find(([pattern]) => pattern.test(term))?.[1]) || term;
  return [...new Set([term, stem, ...ruleTermsOf(stem), ...suffixVariants(stem)])];
}
// The rule noun a verb stands for ("낳으면" → 출산), when the dictionary lists that noun among the
// rule words of its own group. Null for other words.
function verbNoun(term) {
  const stem = VERB_STEMS.find(([pattern]) => pattern.test(term))?.[1];
  return stem && stem !== term && CONCEPT_GROUPS.some(([everyday, rule]) => everyday.includes(stem) && rule.includes(stem)) ? stem : null;
}
// A word the dictionary knows as written ("출산휴가", "회계연도") keeps its last syllable.
const knownTerm = term => RULE_VOCABULARY.has(term) || (labelsEnabled() && LABEL_VOCABULARY.has(term)) || COMPOUND_WORDS.has(term);
// Comparison topics are rule names; only name-level synonyms are expanded there.
const RULE_NAME_SYNONYMS = new Set(['강사료', '강의료', '출장비', '여비', '법카', '법인카드', '클린카드']);
function comparisonTerms(term) {
  return RULE_NAME_SYNONYMS.has(term) ? [...new Set([term, ...(RULE_VOCABULARY.get(term) || [])])] : [term];
}

// ── 질문 의도와 조문 제목 ──────────────────────────────────────
// What a question asks for and the words article headings use for it. Used
// only to choose an article inside a rule that was already selected by its
// content words; it never changes which rule is chosen.
// `headings` run from the most direct answer to looser ones.
// Article headings named after a fee (대관료, 공간사용료, 수수료). Listed by the word before 료: other
// words end the same way (수료·만료·자료·시료·진료), and telling them apart by the syllable before
// 료 misreads real fees (응시료 ends like 시료, 강사료 like 사료, 보관료 like 관료).
const FEE_HEADING = /(?:사용|이용|대관|임대|대여|수업|수강|강의|강사|강연|응시|전형|심사|자문|평가|게재|원고|출연|수수|이전|관람|입장|연체|보관|보험|주차|검사|분석|측정|감정|인증|열람|복사|발급)료$|요금/;
const QUESTION_INTENTS = [
  { ask: /언제|며칠|몇\s*일|날짜|기한|마감|월급날|급여일/, headings: [/기일|지급일|기한/, /시기|일자/] },
  { ask: /자주|몇\s*번|몇\s*회|횟수|주기/, headings: [/횟수|주기|시기/] },
  { ask: /몇\s*(?:년|학기|개월|달)|얼마\s*동안|언제까지|기간/, headings: [/기간|연한|연수|임기/] },
  // "지급" only where the heading ends with it (일비 등의 지급), not 지급대상·지급일.
  { ask: /얼마(?!나\s*자주)|금액|액수|몇\s*원|단가/, headings: [/지급액|금액|액$|단가|요율/, /산정|기준$/, /지급$/], also: FEE_HEADING },
  { ask: /몇\s*점|점수|커트라인/, headings: [/심사|평가/, /기준/] },
  // The topic word 징계 alone is not this intent: "징계는 어떤 것들이 있어" asks for kinds.
  { ask: /제재|처벌|불이익|벌칙|어떤\s*조치|벌을?\s*(?:받|주|줘|줄)|(?:어떤|무슨)\s*벌(?![가-힣])/, headings: [/제재|조치|징계|벌칙|처분/] },
  // "~하면 어떻게 돼?" asks what follows.
  { ask: /면\s*어떻게\s*(?:돼|되|됨)|는\s*어떻게\s*(?:돼|되)/, headings: [/조치|제재|처리|효과|불이익/] },
  { ask: /종류|유형|구분|어떤\s*(?:게|것|것들)이?\s*있|뭐가\s*있|무엇이\s*있/, headings: [/종류|구분|유형/] },
  { ask: /무슨\s*일|하는\s*일|어떤\s*일|역할이|업무가/, headings: [/임무|직무|업무|역할|기능/], labels: false },
  { ask: /무슨\s*일|하는\s*일|어떤\s*일|역할이|업무가|(?:뭐|뭘|무엇을)\s*하는/, headings: [/임무|직무|업무|역할|기능|직능/], labels: true },
  { ask: /몇\s*명|인원|정원/, headings: [/정원|인원/, /구성/] },
  { ask: /자격|조건|요건|대상/, headings: [/자격|요건|대상/] },
  // "몇 살까지" asks for the age itself (정년), not when the retirement takes effect (정년퇴직).
  { ask: /몇\s*살|몇\s*세|나이|연령/, headings: [/^정년$|연령|나이/, /정년/] },
  { ask: /반론|반박|해명|소명|변론|입장을?\s*(?:말|밝)|억울/, headings: [/이의제기|변론|소명|의견진술/, /이의/] },
  { ask: /절차|순서|어떻게\s*(?:해|하|신청|처리|등록)/, headings: [/절차|방법|신청|신고/] },
];
// An intent marked `labels` stands in for its unmarked twin while the names dictionary is on.
const questionIntents = () => { const labels = labelsEnabled(); return QUESTION_INTENTS.filter(intent => intent.labels === undefined || intent.labels === labels); };
const CUE_STEP = 0.2;
// How well an article heading answers what the question asks: 1 for a direct
// answer, less for looser headings, 0 when the question states no such intent.
// `feeNames: false` leaves the fee-name headings out, as before they were added.
function headingCueStrength(query, heading, { feeNames = true } = {}) {
  const text = String(query || ''), title = String(heading || '').replace(/\s+/g, '');
  let best = 0;
  for (const intent of questionIntents()) {
    if (!intent.ask.test(text)) continue;
    // `also` answers as directly as the first headings.
    const level = feeNames && intent.also?.test(title) ? 0 : intent.headings.findIndex(pattern => pattern.test(title));
    if (level >= 0) best = Math.max(best, 1 - level * CUE_STEP);
  }
  return best;
}
const asksIntent = query => questionIntents().some(intent => intent.ask.test(String(query || '')));

// ── 규정의 적용 범위 ────────────────────────────────────────────
const SCOPE_PATTERNS = ontologyData.scopes.filter(x => x.legacy !== false).map(x => [x.id,new RegExp(x.ask,x.flags)]);
function questionScope(query) {
  const text = String(query || '').replace(/\s+/g, '');
  return Object.fromEntries(SCOPE_PATTERNS.map(([key,pattern]) => [key,pattern.test(text)]));
}
// ── 질문의 주체 ────────────────────────────────────────────────
// Who the question is about, when it names exactly one of 직원·교원·학생·강사·조교.
// 교직원 covers both staff and faculty and names no class; 조교수 is a professor, not an assistant.
const SUBJECT_CLASSES = ontologyData.subjects.map(x => [x.id,new RegExp(x.ask),new RegExp(x.title)]);
const SUBJECT_COVERED_BY = Object.fromEntries(ontologyData.subjects.map(x => [x.id,ontologyData.subjects.filter(parent => parent.covers.includes(x.id)).map(parent => parent.id)]));
const withoutMixedSubjects = text => String(text || '').replace(new RegExp(ontologyData.mixedSubjectPattern,'g'), ' ');
function questionSubject(text, fallback = '') {
  const plain = withoutMixedSubjects(text);
  const named = SUBJECT_CLASSES.filter(([, ask]) => ask.test(plain)).map(([name]) => name);
  return named.length === 1 ? named[0] : named.length === 0 && fallback ? questionSubject(fallback) : null;
}
// A rule whose title names another class and not the asked one (전임교원 인사규정 for a 직원 question)
// counts for less. Titles that name no class, or both, are left alone.
const SUBJECT_MISMATCH_WEIGHT = 0.75;
function subjectWeight(title, subject) {
  if (!subject) return 1;
  const plain = withoutMixedSubjects(title);
  const inTitle = SUBJECT_CLASSES.filter(([, , pattern]) => pattern.test(plain)).map(([name]) => name);
  const accepted = [subject, ...(SUBJECT_COVERED_BY[subject] || [])];
  return inTitle.length && !inTitle.some(name => accepted.includes(name)) ? SUBJECT_MISMATCH_WEIGHT : 1;
}

const compactText = value => String(value || '').replace(/\s+/g, '');
const EDITION_PREFIX = /^(?:WISE캠퍼스산학협력단|WISE캠퍼스|의학계열|산학협력단|동국대학교)/;
const TITLE_TAIL = /(?:에관한|의)?(?:설치·운영|설치및운영|관리운영|관리및운영|운영|관리)?(?:에관한)?(?:규정|내규|시행세칙|운영세칙|세칙|회칙|규약|수칙|지침)$/;
// "금장생활관규정" → 금장생활관, "등록금심의위원회규정" → 등록금심의위원회.
function ruleSubject(title) {
  return compactText(title).replace(/\(학생자치기구\)/, '').replace(EDITION_PREFIX, '').replace(TITLE_TAIL, '');
}
// The rule book files rules by part: 1 법인, 2 학칙, 3 행정 일반 apply across
// the university; 4 위원회, 5·6 부속기관, 7 연구소, 8 산학협력단, 9 자치기구
// 등 govern one body. Titles decide when the code is missing.
const UNIT_PARTS = new Set(ontologyData.scopeClasses.unitParts);
const UNIT_TITLE = new RegExp(ontologyData.scopeClasses.unitTitle);
const SELF_GOVERNING_TITLE = new RegExp(ontologyData.scopeClasses.selfGoverningTitle);
function ruleScopeClass(title, code) {
  const text = compactText(title);
  if (SELF_GOVERNING_TITLE.test(text)) return 'self_governing';
  const part = /^(\d+)-/.exec(String(code || ''))?.[1];
  if (UNIT_PARTS.has(part) || UNIT_TITLE.test(ruleSubject(title))) return 'unit';
  return 'general';
}
// A question names a body when it contains the rule's subject, or a word of
// three or more syllables from it ("기숙사" for 기숙사생수칙). For a committee,
// institute or centre the topic word alone is not enough: "등록금 반환" does not
// name 등록금심의위원회, "등록금 심의위원회" does.
const BODY_SUFFIX = /(?:위원회|심의회|연구소|연구원|연구센터|센터|사업단|교육원|학술원)$/;
function namesRuleSubject(title, query, forms = []) {
  const subject = ruleSubject(title), text = compactText(query);
  if (!subject) return false;
  if (text.includes(subject)) return true;
  const body = BODY_SUFFIX.exec(subject)?.[0];
  if (body) return text.includes(body) && forms.some(form => form.length >= 2 && subject.slice(0, -body.length).includes(form));
  return forms.some(form => form.length >= 3 ? subject.includes(form) : subject === form);
}
// How much a rule's score counts for a question that does not say which body
// or campus it is about. 1 leaves the score as it is.
function generalRuleWeight(title, query, hasGeneralEdition = false, { code = '', forms = [] } = {}) {
  const text = compactText(title), question = compactText(query);
  if (question.includes(text)) return 1;
  const scope = questionScope(query);
  let weight = 1;
  // A campus-only subject must remain discoverable when no general edition exists.
  if (hasGeneralEdition) {
    if (/WISE|경주캠퍼스/i.test(text) && !scope.wise) weight *= 0.65;
    if (/산학협력단/.test(text) && !scope.industry) weight *= 0.65;
    if (/의학계열|의학전문/.test(text) && !scope.medical) weight *= 0.75;
  }
  if (/대학원/.test(text) && !scope.graduate) weight *= 0.6;
  const scopeClass = ruleScopeClass(title, code);
  if (scopeClass === 'self_governing') {
    if (!scope.selfGoverning) weight *= 0.7;
  } else if (scopeClass === 'unit') {
    const part8 = /^8-/.test(String(code || ''));
    if (!(part8 && scope.industry) && !namesRuleSubject(title, query, forms)) weight *= 0.8;
  } else if (/(?:학칙|규정|규칙)$/.test(text) && !/시행세칙|내규|대학원/.test(text)) {
    // University-wide main rules get a modest preference over their sub-rules.
    weight *= 1.15;
  }
  return weight;
}

module.exports = {
  labelsEnabled,
  RULE_VOCABULARY, CONCEPT_GROUPS, questionSubject, subjectWeight, businessTerms, verbNoun, knownTerm, containsTerm, compoundParts, phraseConcepts, comparisonTerms, headingCueStrength, asksIntent, questionScope, ruleScopeClass, ruleSubject, generalRuleWeight,
  BUILTIN_ALIASES,
  aliasTable,
  resetAliasCacheForTest,
  normalizeMiddots,
  middotVariants,
  expandAliases,
};

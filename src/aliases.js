'use strict';

const fs = require('fs');

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
const CONCEPT_GROUPS = [
  // 출장·여비
  [['해외출장', '외국출장'], ['국외출장', '국외여비', '국외 출장', '국외']],
  [['해외여비'], ['국외여비', '국외']],
  [['해외', '외국', '미국', '일본', '중국', '유럽', '동남아'], ['국외']],
  [['국내출장'], ['국내출장', '국내여비', '국내 출장', '출장']],
  [['출장비'], ['여비', '출장']], [['여비'], ['출장비']], [['출장'], ['여비']],
  [['밥값', '식대', '식사비', '끼니'], ['식비']],
  [['방값', '호텔비', '숙소비', '숙박료'], ['숙박비']],
  [['비행기', '비행기표', '항공권', '항공료', '항공편'], ['항공운임', '항공']],
  [['자가용', '자차', '내차', '승용차'], ['자동차운임', '운임']],
  [['교통비', '차비', '기차표', 'KTX'], ['운임']],
  // 보수·수당·복지
  [['월급', '봉급', '임금', '급료', '페이'], ['보수', '급여']],
  [['연봉'], ['보수']],
  [['지급일', '지급날', '입금일'], ['지급기일', '지급일']],
  [['야근', '초과근무', '시간외수당', '잔업'], ['시간외근무', '초과근무']],
  [['보너스', '상여', '인센티브'], ['상여금', '성과급']],
  [['퇴직금'], ['퇴직급여', '퇴직급여금']], [['퇴직급여'], ['퇴직금']],
  [['경조사비', '경조비', '조의금', '축의금', '부조금'], ['경조금', '경조사']],
  [['결혼', '장례', '부고', '조사'], ['경조휴가', '경조사']],
  [['강사료'], ['강의료']], [['강의료'], ['강사료']], [['특강료'], ['강의료', '특강']],
  [['학자금', '자녀학비'], ['학비보조', '학비감면', '자녀']],
  // 금품·이해충돌·윤리
  [['선물', '상품권', '식사', '밥', '접대', '대접', '향응', '사례금', '촌지', '뇌물', '답례품'], ['금품등', '금품', '향응']],
  [['투잡', '부업', '겸업'], ['겸직', '영리업무']],
  [['사외이사', '겸임'], ['겸직']],
  [['외부강의', '강연', '자문료'], ['외부강의', '외부강의등']],
  [['표절', '대필', '조작'], ['표절', '위조', '변조', '연구부정행위']],
  [['갑질', '괴롭힘', '성추행'], ['성희롱', '성폭력', '인권침해', '괴롭힘']],
  [['내부고발', '고발', '제보'], ['제보', '신고', '공익신고']],
  [['이의신청', '이의제기', '항의', '불복'], ['이의', '이의신청', '이의제기']],
  [['처벌', '제재', '벌칙', '불이익'], ['징계', '제재', '처분']],
  // 물품·기증·구매·시설
  [['물건', '집기', '기물'], ['물품', '비품']],
  [['기증', '기부', '증정', '기탁'], ['수증', '기증']],
  [['불용처리', '폐기처분'], ['불용결정', '불용품', '불용']],
  [['고장'], ['훼손']],
  [['발주', '주문', '구입', '조달'], ['구매', '발주']],
  [['분실', '잃어버리'], ['분실', '도난']],
  [['변상', '물어내', '배상'], ['변상', '배상']],
  [['대여', '빌리', '렌트'], ['대여', '대출', '대관', '차입']],
  [['돈', '자금', '비용'], ['자금', '경비', '비용']],
  [['매각', '팔', '처분'], ['매각', '처분']],
  [['쓸모없', '못쓰게'], ['불용', '불용품']],
  [['버리', '폐기'], ['폐기', '불용']],
  [['실험실', '랩실'], ['연구실', '실험실']],
  [['해킹', '랜섬웨어', '바이러스', '악성코드'], ['침해사고', '정보보호']],
  [['CCTV', '씨씨티비', '감시카메라'], ['영상정보처리기기']],
  [['강의실', '회의실', '장소'], ['대관', '시설']],
  [['검사', '납품확인'], ['검수']],
  [['도장', '인감', '직인', '관인'], ['직인', '관인', '인장']],
  [['찍', '날인'], ['날인', '서명']],
  [['공문', '품의'], ['기안', '문서']],
  [['보내', '발송', '송부'], ['발송', '송부']],
  [['서류', '필요서류', '준비물'], ['구비서류', '제출서류']],
  [['공지', '안내문'], ['공고', '공지']],
  [['열람', '조회'], ['열람', '공개']],
  [['보관기간', '보존연한'], ['보존기간']],
  [['포스터', '현수막', '대자보', '전단'], ['게시물', '홍보물']],
  [['비번', '패스워드'], ['비밀번호']],
  // 회계·예산
  [['회계연도', '회계년도', '예산연도', '사업연도'], ['회계연도', '회계년도']],
  [['추경'], ['추가경정예산', '추가경정']],
  [['짜', '편성', '세우'], ['편성', '수립']],
  [['걷', '징수'], ['징수', '납부']],
  [['넘', '초과', '오버'], ['초과']],
  [['모자라', '부족'], ['부족', '미달']],
  [['겹치', '중복'], ['중복', '이중']],
  [['잘못', '틀리', '실수', '오류'], ['오류', '정정', '착오', '과오']],
  [['속이', '거짓', '가짜'], ['허위', '거짓', '부정한']],
  [['어기', '위반'], ['위반']],
  [['환불', '돌려받'], ['반환', '환불']], [['반환'], ['환불']],
  [['나눠서', '나누어', '분납', '할부'], ['분할납부', '분할']],
  [['납부', '내야'], ['납부', '납입']],
  [['감면', '면제', '할인', '깎'], ['감면', '면제', '감액']],
  [['법카', '클린카드', '학교카드'], ['법인카드']], [['카드'], ['법인카드']], [['법인카드'], ['법카']],
  [['영수증'], ['증빙', '증빙서류']],
  [['선금', '가불'], ['선급금', '선금']],
  [['업추비', '판공비', '회식비'], ['업무추진비', '회의비']],
  [['발전기금', '후원금'], ['발전기금', '기부금']],
  [['오버헤드'], ['간접비']],
  // 인사·복무
  [['교수'], ['교원']], [['진급'], ['승진']],
  [['시간강사'], ['강사']],
  [['안식년'], ['연구년']],
  [['연차', '월차', '반차'], ['연가', '연차휴가', '연차유급휴가', '휴가']],
  [['출산휴가'], ['출산전후휴가']],
  [['출산', '임신', '아기', '애기'], ['출산', '임신', '육아']],
  [['출근', '퇴근', '출퇴근', '업무시간'], ['근무시간', '근로시간']],
  [['인사이동', '부서이동', '발령', '순환근무'], ['전보', '전직']],
  [['입사', '공채'], ['채용', '임용']], [['뽑'], ['채용', '선발', '임용']],
  [['퇴사', '사직', '사표'], ['퇴직', '사직', '면직']],
  [['그만두', '포기'], ['포기', '사직', '퇴직', '자퇴']],
  [['알바', '아르바이트', '파트타임'], ['시간제', '아르바이트', '근로']],
  [['창업', '차리', '스타트업'], ['창업']],
  [['회수', '걷어가', '환수'], ['회수', '환수']],
  [['미달'], ['미달', '부족']],
  [['미납'], ['미납', '체납', '연체']],
  [['생략'], ['생략', '면제']],
  [['제정'], ['제정', '신설']],
  [['보관'], ['관리', '보존', '보관']],
  [['수익', '수입', '이익'], ['수익', '수입', '보상금']],
  [['해고'], ['면직', '해임', '파면']],
  [['은퇴'], ['정년']],
  [['인사평가', '인사고과', '근평', '고과', '성과평가'], ['근무성적평가', '인사평가', '업적평가', '평가']],
  [['점심시간', '쉬는시간', '휴식시간'], ['휴게시간', '휴게']],
  [['쉬', '휴식'], ['휴가', '휴직', '휴게']],
  [['아프', '질병', '병'], ['질병', '병가', '유고결석']],
  [['예비군', '민방위'], ['공가', '예비군']],
  [['쉬는날', '빨간날'], ['휴일', '공휴일']],
  [['사망', '죽', '돌아가'], ['사망', '유족']],
  [['일하', '근무'], ['근무', '복무']],
  [['가르치'], ['강의', '수업', '책임시간']],
  [['조건', '자격요건', '스펙'], ['자격', '요건']],
  [['허락', '컨펌'], ['허가', '승인']],
  [['대우', '혜택'], ['처우', '예우']],
  [['연수', '훈련'], ['교육훈련', '연수']],
  [['팀장', '부서장', '처장', '학과장'], ['부서장', '보직']],
  [['알리', '통지'], ['보고', '통보', '신고', '통지']],
  [['만들', '신설'], ['설치', '설립', '제정']],
  [['없애', '폐지'], ['폐지', '해산']],
  [['고치', '수정'], ['수정', '개정', '정정']],
  [['줄이', '단축'], ['단축', '감축']],
  [['늘리', '연장'], ['연장', '증원']],
  [['떨어지', '탈락', '불합격'], ['불합격', '탈락']],
  [['부재', '공석', '대행'], ['부재', '대리', '직무대행']],
  [['다치', '부상', '산재'], ['재해', '부상', '안전사고']],
  // 학사·장학·학생
  [['학부생'], ['학생']], [['대학원생'], ['대학원']],
  [['학비', '수업료'], ['등록금', '수업료']],
  [['중복수혜'], ['이중수혜']], [['이중수혜'], ['중복수혜']],
  [['성적장학금'], ['장학', '성적']],
  [['중단', '끊기', '정지'], ['중지', '중단', '정지']],
  [['기숙사', '생활관', '긱사'], ['기숙사', '생활관']],
  [['나가', '퇴실'], ['퇴사', '퇴관', '퇴거']],
  [['들어가', '입주', '입실'], ['입사', '입주']],
  [['재시험', '추가시험'], ['재시험', '추가시험']],
  [['선거', '투표'], ['선출', '선거']],
  [['박탈', '철회'], ['취소', '박탈', '철회']],
  [['학고'], ['학사경고']],
  [['복수전공', '이중전공', '복전'], ['다전공', '복수전공']],
  [['전공변경'], ['전과']],
  [['드랍', '수강취소', '수강철회'], ['수강과목의 취소', '수강취소']],
  [['계절학기'], ['계절수업', '계절학기']],
  [['휴강', '결강'], ['휴강', '결강', '보강']],
  [['폐강', '없어지'], ['폐강']],
  [['결석', '빠지', '출결'], ['결석', '출석']],
  [['커닝', '컨닝'], ['부정행위']],
  [['교환학생'], ['교환학생', '국외수학', '학점교류']],
  [['인턴'], ['현장실습']],
  [['졸업유예', '졸업연기'], ['졸업유예', '수료']],
  [['입대', '군대'], ['병역', '군복무']],
  [['책'], ['도서', '자료']],
  [['상'], ['포상', '표창']],
  [['연체', '지연', '늦'], ['연체', '지체', '지연']],
  [['연기', '미루'], ['연기', '연장', '유예']],
  [['변경', '바꾸'], ['변경']],
  [['이동', '옮기'], ['이동', '변경', '전보', '전과']],
  // 수량 표현
  [['퍼센트'], ['100분의', '비율']], [['한도'], ['상한', '범위']], [['상한'], ['한도']], [['계산'], ['산정']],
  [['매달'], ['매월']], [['자주'], ['주기']], [['종류', '유형'], ['구분', '종류']],
  [['동시'], ['이중수혜', '중복수혜']],
  [['산단'], ['산학협력단']],
];
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
  [/번\s*돈|벌어들인/, '수익'],
];
function phraseConcepts(query) {
  const text = String(query || '');
  return PHRASE_CONCEPTS.filter(([pattern]) => pattern.test(text)).map(([, term]) => term);
}
// Verbs people use where a rule has a noun ("잃어버렸는데" → 분실, "물어내야" → 변상).
// The pattern reads the start of the word, so every ending of the verb is covered.
const VERB_STEMS = [
  [/^잃어버/, '잃어버리'], [/^고장(?:난|나|났)/, '고장'], [/^출장(?:가|갈|갔|간)/, '출장'],
  [/^(?:기증|기부|증정)(?:받|한|하|된|되)/, '기증'], [/^(?:발주|주문|구입)(?:해|한|하|할|했)/, '발주'],
  [/^물어(?:내|주|줘|줄)/, '물어내'], [/^빌(?:리|려|릴|린)/, '빌리'], [/^돌려(?:받|주|줘|줄)/, '돌려받'],
  [/^끊(?:기|겨|긴|길)/, '끊기'], [/^미(?:루|뤄|룰|룬)/, '미루'], [/^옮(?:기|겨|길|긴)/, '옮기'],
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
  [/^차(?:리|려|릴|린)/, '차리'], [/^걷어(?:가|갈|간)/, '걷어가'], [/^없어(?:지|져|질|진)/, '없어지'],
  [/^줄(?:이|여|일|인)/, '줄이'], [/^늘(?:리|려|릴|린)/, '늘리'], [/^떨어(?:지|져|질|진)/, '떨어지'], [/^커닝|^컨닝/, '커닝'],
];
// Endings that rules and people swap for the same thing (심사비·심사료·심사수당).
const SUFFIX_VARIANTS = [['비', '료', '수당'], ['연도', '년도'], ['요구', '요청']];
function suffixVariants(term) {
  const variants = [];
  for (const group of SUFFIX_VARIANTS) {
    const suffix = group.find(ending => term.endsWith(ending) && term.length - ending.length >= 2);
    if (suffix) for (const other of group) if (other !== suffix) variants.push(term.slice(0, -suffix.length) + other);
  }
  return variants;
}
// The question word, its stem, and the rule vocabulary that may stand for it.
function businessTerms(term, { verbs = true } = {}) {
  const stem = (verbs && VERB_STEMS.find(([pattern]) => pattern.test(term))?.[1]) || term;
  return [...new Set([term, stem, ...(RULE_VOCABULARY.get(stem) || []), ...suffixVariants(stem)])];
}
// A word the dictionary knows as written ("출산휴가", "회계연도") keeps its last syllable.
const knownTerm = term => RULE_VOCABULARY.has(term) || COMPOUND_WORDS.has(term);
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
const QUESTION_INTENTS = [
  { ask: /언제|며칠|몇\s*일|날짜|기한|마감|월급날|급여일/, headings: [/기일|지급일|기한/, /시기|일자/] },
  { ask: /자주|몇\s*번|몇\s*회|횟수|주기/, headings: [/횟수|주기|시기/] },
  { ask: /몇\s*(?:년|학기|개월|달)|얼마\s*동안|언제까지|기간/, headings: [/기간|연한|연수|임기/] },
  // "지급" only where the heading ends with it (일비 등의 지급), not 지급대상·지급일.
  { ask: /얼마(?!나\s*자주)|금액|액수|몇\s*원|단가/, headings: [/지급액|금액|액$|단가|요율/, /산정|기준$/, /지급$/] },
  { ask: /몇\s*점|점수|커트라인/, headings: [/심사|평가/, /기준/] },
  { ask: /제재|처벌|징계|불이익|벌칙/, headings: [/제재|조치|징계|벌칙|처분/] },
  // "~하면 어떻게 돼?" asks what follows.
  { ask: /면\s*어떻게\s*(?:돼|되|됨)|는\s*어떻게\s*(?:돼|되)/, headings: [/조치|제재|처리|효과|불이익/] },
  { ask: /종류|유형|구분/, headings: [/종류|구분|유형/] },
  { ask: /자격|조건|요건|대상/, headings: [/자격|요건|대상/] },
  { ask: /절차|순서|어떻게\s*(?:해|하|신청|처리|등록)/, headings: [/절차|방법|신청|신고/] },
];
const CUE_STEP = 0.2;
// How well an article heading answers what the question asks: 1 for a direct
// answer, less for looser headings, 0 when the question states no such intent.
function headingCueStrength(query, heading) {
  const text = String(query || ''), title = String(heading || '').replace(/\s+/g, '');
  let best = 0;
  for (const intent of QUESTION_INTENTS) {
    if (!intent.ask.test(text)) continue;
    const level = intent.headings.findIndex(pattern => pattern.test(title));
    if (level >= 0) best = Math.max(best, 1 - level * CUE_STEP);
  }
  return best;
}
const asksIntent = query => QUESTION_INTENTS.some(intent => intent.ask.test(String(query || '')));

// ── 규정의 적용 범위 ────────────────────────────────────────────
function questionScope(query) {
  const text = String(query || '').replace(/\s+/g, '');
  return {
    wise: /WISE|경주|와이즈/i.test(text),
    industry: /산학협력단|산단/.test(text),
    medical: /의학|의대|의전원|병원/.test(text),
    graduate: /대학원|원생|석사|박사|논문|학위청구|의전원/.test(text),
    selfGoverning: /학생회|자치기구|학생자치|대의원|동아리|노동조합|노조/.test(text),
  };
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
const UNIT_PARTS = new Set(['4', '5', '6', '7', '8', '9']);
const UNIT_TITLE = /연구소|연구센터|센터|위원회|심의회|사업단|학생회|학과/;
const SELF_GOVERNING_TITLE = /학생자치기구|총학생회|대의원회|동아리연합회|노동조합/;
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
  } else if (/(?:학칙|규정)$/.test(text) && !/시행세칙|내규|대학원/.test(text)) {
    // University-wide main rules get a modest preference over their sub-rules.
    weight *= 1.15;
  }
  return weight;
}

module.exports = {
  RULE_VOCABULARY, CONCEPT_GROUPS, businessTerms, knownTerm, compoundParts, phraseConcepts, comparisonTerms, headingCueStrength, asksIntent, questionScope, ruleScopeClass, ruleSubject, generalRuleWeight,
  BUILTIN_ALIASES,
  aliasTable,
  resetAliasCacheForTest,
  normalizeMiddots,
  middotVariants,
  expandAliases,
};

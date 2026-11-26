'use strict';
// lookup_dongguk_rule `keywords`: rule vocabulary supplied by the caller next to
// the question. Synthetic rules only; no benchmark question or answer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongguk-lookup-keywords-'));
process.env.XDG_CACHE_HOME = root;
process.env.DONGGUK_RULE_COOKIE = '';
process.env.DONGGUK_MCP_NO_CACHE = '0';
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
const searches = [];
// Title search is answered from the synthetic list; full-text search finds nothing.
let CATALOG = [];
const row = rule => `<tr><td class="tbody_txt"><a href="javascript:lawSearchFullViewSrv('${rule.lawId}','${rule.historyId}');"><span onclick='showSearchText("${rule.code}")'></span><span onclick='showSearchText("${rule.title}")'></span></a></td></tr>`;
require.cache[fetchPath].exports = async (url, options) => {
  assert(String(url).startsWith('https://rule.dongguk.edu/lmxsrv/search/'), `unexpected fetch ${url}`);
  const params = new URLSearchParams(options.body);
  const text = (params.get('SEARCH_TEXT') || '').trim();
  searches.push({ type: params.get('SEARCH_TYPE'), text });
  const hits = params.get('SEARCH_TYPE') === 'LAWNAME' && text
    ? CATALOG.filter(rule => rule.title.replace(/\s/g, '').includes(text.replace(/\s/g, ''))) : [];
  return { ok: true, status: 200, text: async () => `<p class="infoLeft"><span>${hits.length}</span>건</p><table><tbody class="tbody">${hits.map(row).join('')}</tbody></table>` };
};
const { createServer } = require('../src/index.js');
const { buildCorpus, saveCorpus, searchCorpus } = require('../src/corpus.js');
const { parseKeywords, keywordConcepts, extractRelevantBlocks, MAX_KEYWORDS } = require('../src/lookup.js');
const { questionSubject, subjectWeight, phraseConcepts } = require('../src/aliases.js');

const article = (number, heading, body) => `### 제${number}조(${heading})\n${body}`;
const RULES = [
  [1, '물품관리규정', '3-7-2', [
    article(1, '목적', '이 규정은 물품의 관리에 필요한 사항을 정한다.'),
    article(7, '사용관리', '부서의 장은 물품을 사용·관리한다.'),
    article(16, '손·망실 처리', '사용자가 비품을 망실하였을 때에는 같은 비품으로 변상하게 해야 한다.'),
    article(19, '불용품 매각', '불용품은 경쟁입찰로 매각한다.'),
  ]],
  [2, '도서관운영규정', '6-9-1', [
    article(27, '반납', '대출한 도서는 기한 안에 반납해야 한다.'),
    article(29, '자료변상', '도서를 분실하거나 훼손한 사람은 같은 자료로 변상해야 한다.'),
  ]],
  [3, '구매규정', '3-7-15', [
    article(5, '구매 방법', '구매는 결재권자의 승인을 받은 후에 발주해야 한다.'),
    article(24, '계약서의 작성', '계약을 체결할 때에는 계약서를 작성해야 한다.'),
    article(29, '계약의 해제 및 해지', '계약상대자가 정당한 이유 없이 이행에 착수하지 아니할 때에는 계약을 해제 또는 해지할 수 있다.'),
  ]],
  [4, '산학협력단 구매규정', '8-0-5', [
    article(5, '구매 방법', '구매는 산학협력단장의 승인을 받은 후에 발주해야 한다.'),
    article(29, '계약의 해제 및 해지', '계약상대자가 이행하지 아니할 때에는 산학협력단장이 계약을 해제 또는 해지할 수 있다.'),
  ]],
  [5, '산학협력단 직원인사규정', '8-0-9', [article(3, '임용', '산학협력단 직원은 단장이 임용한다.')]],
  [6, '취업규칙', '3-3-14', [
    article(59, '사무인계', '부서변경의 명을 받은 사람은 지체 없이 사무인계를 이행해야 한다.'),
    article(73, '정년', '직원의 정년은 만 60세로 한다.'),
    article(80, '퇴직의 구분', '퇴직은 정년퇴직, 당연퇴직, 의원면직으로 구분한다.'),
    article(83, '정년퇴직', '정년에 달한 사람은 정년퇴직 기준일에 퇴직한다. 정년퇴직 기준일은 정년 해당 월의 학기말로 한다.'),
  ]],
  [7, '전임교원 인사규정 시행세칙', '3-3-3', [
    article(63, '연구년 교원의 의무 및 준수사항', '연구년 교원은 연수 결과보고서를 제출할 의무가 있으며 준수사항을 지켜야 한다.'),
  ]],
  [8, '직원위탁연수에 관한 내규', '3-3-25', [
    article(8, '연수비의 지원', '연수비는 예산의 범위에서 지원한다.'),
    article(9, '의무', '연수자는 연수 후 연수기간에 상당하는 기간 이상을 본교에 재직해야 한다.'),
  ]],
  [9, '기숙사규정', '6-6-1', [
    article(6, '식사', '기숙사 식사 시간은 관장이 정한다.'),
    article(17, '제재', '수칙을 위반한 사생에게는 퇴사를 명할 수 있다.'),
  ]],
  [10, '학칙', '2-1-1', [
    article(21, '수업연한', '학사과정의 수업연한은 4년으로 한다.'),
    article(22, '재학연한', '학사과정의 재학연한은 제한을 두지 않는다. 수업연한을 초과하여 재학할 수 있다.'),
    article(55, '졸업', '수업연한 이상 등록하고 졸업학점을 취득한 사람에게 졸업을 인정한다.'),
  ]],
  [11, '시설 임대 내규', '3-1-30', [
    article(12, '임대계약의 해지', '임차인이 임대료를 내지 아니할 때에는 임대계약을 해지할 수 있다.'),
  ]],
];
CATALOG = RULES.map(([lawId, title, code]) => ({ lawId, historyId: lawId * 10, title, code, revisedAt: '2026.01.01' }));
const CONTENT = Object.fromEntries(RULES.map(([lawId, title, , articles]) => [`${lawId}_${lawId * 10}`, { title, markdown: articles.join('\n\n') }]));

const dir = path.join(root, 'dongguk-rule-mcp', 'v2', 'public');
function seed(category, key, data) {
  fs.mkdirSync(path.join(dir, category), { recursive: true });
  fs.writeFileSync(path.join(dir, category, `${key}.json`), JSON.stringify(data));
}
seed('catalog', 'all', CATALOG);
for (const [key, value] of Object.entries(CONTENT)) {
  seed('content-v3', key, value);
  seed('original-structure-v2', key, { markdown: value.markdown, structure: { coverage: { articles: 'complete' } } });
}
for (const rule of CATALOG) seed('history', String(rule.lawId), [{ historyId: rule.historyId, revisedAt: rule.revisedAt }]);

let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`  ✅ ${name}`); }
const headings = text => [...String(text || '').matchAll(/^#{0,6}\s*(제\d+조)\(/gm)].map(match => match[1]);

async function main() {
  const corpus = await buildCorpus({ catalog: CATALOG, loadContent: async (lawId, historyId) => CONTENT[`${lawId}_${historyId}`] });
  saveCorpus(dir, corpus);

  // ── 입력 해석 ──
  check('쉼표·가운뎃점·줄바꿈으로 나눈 핵심어, 한 핵심어 안의 띄어쓰기는 구(句)로 유지',
    JSON.stringify(parseKeywords('분실, 변상;계약 해지\n「휴학 사유」·망실')) === JSON.stringify([['분실'], ['변상'], ['계약', '해지'], ['휴학', '사유'], ['망실']]));
  check('쉼표 없이 띄어 쓴 목록은 낱말마다 따로, 두 낱말은 한 구로',
    JSON.stringify(parseKeywords('결재 단계 합의 전결')) === JSON.stringify([['결재'], ['단계'], ['합의'], ['전결']])
    && JSON.stringify(parseKeywords('계약 해지')) === JSON.stringify([['계약', '해지']]));
  check('"규정"·"동국대" 같은 말, 한 글자, 조문·별표 번호, 중복은 핵심어가 아님',
    JSON.stringify(parseKeywords('동국대 규정, 책, 제10조, 별표1, 12, 변상, 변상')) === JSON.stringify([['변상']]));
  check(`핵심어는 ${MAX_KEYWORDS}개까지, 배열 입력도 같은 방식`,
    parseKeywords(Array.from({ length: 12 }, (_, i) => `낱말${i}`).join(', ')).length === MAX_KEYWORDS
    && JSON.stringify(parseKeywords(['물품', '분실'])) === JSON.stringify([['물품'], ['분실']]) && parseKeywords('   ').length === 0 && parseKeywords(null).length === 0);
  check('핵심어 구는 낱말과 붙여 쓴 꼴을 함께 찾음', (() => {
    const concepts = keywordConcepts(parseKeywords('계약 해지'));
    return concepts.map(concept => concept.term).join() === '계약,해지,계약해지' && concepts.every(concept => concept.keyword) && concepts[2].joinedFrom.join() === '계약,해지';
  })());

  // ── 색인 검색 ──
  const vague = '그 업체랑은 이제 그만하고 싶은데 어떻게 해?';
  const keyed = searchCorpus(corpus, vague, { top: 3, perDoc: 3, keywords: parseKeywords('계약 해지, 계약상대자') });
  check('핵심어 우선(규정 고르기): 구어 질문만으로는 못 찾는 규정을 핵심어로 찾음',
    keyed.keywordMode === true && keyed.hits[0].lawId === 3 && searchCorpus(corpus, vague, { top: 3 }).hits[0]?.lawId !== 3);
  check('핵심어 우선(조문 고르기): 표제에 핵심어 구가 든 조문이 첫 조문', keyed.hits[0].articles[0].article === '제29조');
  const split = searchCorpus(corpus, '몇 년이야', { top: 3, perDoc: 2, keywords: parseKeywords('학사과정수업연한') });
  check('붙여 쓴 핵심어가 규정에 없으면 규정에 있는 두 낱말로 나눠 찾고 그 사실을 기록',
    split.hits[0].lawId === 10 && split.keywords.rewritten['학사과정수업연한'] === '학사과정 수업연한' && split.keywords.used.join() === '학사과정,수업연한');
  const dictionary = searchCorpus(corpus, '몇 살까지야', { top: 3, perDoc: 2, keywords: parseKeywords('직원, 연령') });
  check('핵심어에도 업무 용어 사전을 적용(연령 → 정년)', dictionary.hits[0].lawId === 6 && dictionary.hits[0].articles[0].article === '제73조');
  const nonsense = searchCorpus(corpus, '기숙사 식사 시간', { top: 3, keywords: parseKeywords('가나다라, 마바사아') });
  const plain = searchCorpus(corpus, '기숙사 식사 시간', { top: 3 });
  check('어느 규정에도 없는 핵심어: 질문만 검색한 결과와 순위·점수가 같고, 쓰지 못한 핵심어를 보고',
    nonsense.keywordMode === false && nonsense.keywords.used.length === 0 && nonsense.keywords.missing.join() === '가나다라,마바사아'
    && JSON.stringify(nonsense.hits.map(hit => [hit.lawId, hit.score])) === JSON.stringify(plain.hits.map(hit => [hit.lawId, hit.score])));
  check('핵심어 없는 검색 결과에는 핵심어 항목이 없음', plain.keywords === undefined && plain.keywordMode === false);

  check('출력 요청과 열람 대상, 학생과 직장 근속 문맥 구분',
    !phraseConcepts('휴학 기준 보여줘').includes('열람') && phraseConcepts('내 인사기록 볼 수 있어?').includes('열람')
    && !phraseConcepts('회사 몇 년 다녀야 장기근속수당 받아?').includes('수업연한') && !phraseConcepts('직원으로 몇 년 다니면 승진해?').includes('수업연한')
    && phraseConcepts('학교 몇 년 다녀야 졸업해?').includes('수업연한'));
  check('질문 주체 우선, 질문에 주체가 없을 때 핵심어 사용', questionSubject('직원 연수 의무', '교원 연수') === '직원' && questionSubject('연수 의무', '교원 연수') === '교원' && questionSubject('직원 교원 연수', '학생') === null);
  const conflictingSubject = searchCorpus(corpus, '직원 연수 의무', {top: 11, keywords: parseKeywords('교원, 연수')});
  check('상충 핵심어에도 직원 주체 가중치 유지', conflictingSubject.hits.find(hit => hit.lawId === 7).score < searchCorpus(corpus, '연수 의무', {top: 11, keywords: parseKeywords('교원, 연수')}).hits.find(hit => hit.lawId === 7).score);

  // ── 질문의 주체 ──
  check('질문의 주체는 직원·교원·학생·강사·조교 중 하나만 나올 때 읽음',
    questionSubject('직원이 위탁교육 받을 때') === '직원' && questionSubject('교수 정년') === '교원' && questionSubject('조교수 승진') === '교원' && questionSubject('조교 임기') === '조교'
    && questionSubject('교직원 수당') === null && questionSubject('교수가 학생에게') === null && questionSubject('출장 여비') === null && questionSubject('특강 강사료') === null);
  check('다른 주체만 이름에 든 규정은 감점, 주체가 없거나 같은 규정은 그대로',
    subjectWeight('전임교원 인사규정 시행세칙', '직원') < 1 && subjectWeight('직원위탁연수에 관한 내규', '직원') === 1 && subjectWeight('취업규칙', '직원') === 1 && subjectWeight('교직원 수당에 관한 규정', '직원') === 1 && subjectWeight('전임교원 인사규정 시행세칙', null) === 1
    && subjectWeight('강사 인사규정 시행세칙', '직원') < 1 && subjectWeight('교원인사규정', '강사') === 1 && subjectWeight('강사 인사규정 시행세칙', '교원') < 1 && subjectWeight('조교임용규정', '직원') < 1);
  const training = searchCorpus(corpus, '직원이 연수 받는 동안 지켜야 할 의무', { top: 3 });
  check('직원 질문: 이름에 교원만 든 규정보다 직원 규정이 먼저', training.hits[0].lawId === 8 && training.hits.findIndex(hit => hit.lawId === 7) > 0);

  // ── 발췌 ──
  const twoPriority = extractRelevantBlocks('### 제1조(가)\n물품\n\n### 제2조(나)\n물품 물품 물품\n\n### 제3조(다)\n다른 내용\n\n### 제4조(라)\n다른 내용', '물품', { maxBlocks: 2, order: 'relevance', priorityArticles: ['제4조', '제3조', '제1조'] });
  check('우선 조문은 준 순서대로 한 자리씩, 발췌 블록 수 한도 안에서만', headings(twoPriority.text).join() === '제4조,제3조');
  const withAnnex = extractRelevantBlocks('### 제1조(가)\n내용\n\n### 제2조(나)\n내용\n\n### 제3조(다)\n내용\n\n<별표 1> 물품 금액표\n\n| 물품 | 금액 |\n|---|---|\n| 비품 | 100원 |', '물품', { maxBlocks: 2, order: 'relevance', priorityArticles: ['제1조', '제2조', '제3조'] });
  check('우선 조문이 자리를 다 채워도 일치한 별표는 마지막 자리 하나를 받음', headings(withAnnex.text).join() === '제1조' && withAnnex.text.includes('<별표 1>'));

  const server = createServer({ profile: 'rules' });
  const client = new Client({ name: 'lookup-keywords', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = async args => { const r = await client.callTool({ name: 'lookup_dongguk_rule', arguments: args }); return { sc: r.structuredContent, text: r.content.find(c => c.type === 'text')?.text || '' }; };
  const ids = result => result.sc.data.rules.map(rule => rule.lawId);
  try {
    const tool = (await client.listTools()).tools.find(item => item.name === 'lookup_dongguk_rule');
    const properties = tool.inputSchema.properties;
    check('도구 설명: keywords 입력과 쓰는 요령, 길이 상한', properties.keywords.type === 'string' && properties.keywords.maxLength === 200 && /명사 2~6개/.test(properties.keywords.description) && /keywords/.test(tool.description) && /확신이 없으면 비워 두세요/.test(tool.description) && /query만으로도 찾습니다/.test(tool.description));
    check('도구 설명: rule_keyword는 규정명을 알 때만, terms는 조문·별표 번호를 알 때만',
      /정확한 이름을 알 때만/.test(properties.rule_keyword.description) && /keywords에 넣습니다/.test(properties.rule_keyword.description) && /조문·별표 번호를 알 때만/.test(properties.terms.description) && /rule_keyword는 규정의 정확한 이름을 알 때만/.test(tool.description));

    const questionOnly = await call({ query: vague });
    const withKeywords = await call({ query: vague, keywords: '계약 해지, 계약상대자' });
    check('핵심어를 주면 구어 질문보다 우선: 구매규정의 계약 해지 조문이 본문에',
      withKeywords.sc.ok === true && ids(withKeywords)[0] === 3 && headings(withKeywords.sc.data.rules[0].excerpt.text)[0] === '제29조'
      && !(questionOnly.sc.ok && ids(questionOnly)[0] === 3));
    check('적용한 핵심어를 응답에 기록', withKeywords.sc.data.query.keywords.join() === '계약 해지,계약상대자' && withKeywords.sc.data.search.keywords.applied === true
      && withKeywords.sc.data.search.keywords.used.includes('해지') && /핵심어\(keywords\): .*적용/.test(withKeywords.text));

    const dorm = await call({ query: '기숙사 식사 시간은 언제야' });
    const dormNonsense = await call({ query: '기숙사 식사 시간은 언제야', keywords: '가나다라, 마바사아' });
    check('엉뚱한 핵심어(어느 규정에도 없음): 질문만 넣은 결과와 규정·발췌가 같음',
      dormNonsense.sc.ok === true && JSON.stringify(dormNonsense.sc.data.rules.map(rule => [rule.lawId, rule.excerpt.text])) === JSON.stringify(dorm.sc.data.rules.map(rule => [rule.lawId, rule.excerpt.text]))
      && dormNonsense.sc.data.search.keywords.applied === false && /규정 본문에서 찾지 못해 질문만으로 조회/.test(dormNonsense.text));
    for (const empty of ['', '   ', ', ,']) {
      const result = await call({ query: '기숙사 식사 시간은 언제야', keywords: empty });
      check(`빈 핵심어 ${JSON.stringify(empty)}: 질문만 넣은 결과와 같고 핵심어 기록 없음`,
        JSON.stringify(result.sc.data.rules.map(rule => [rule.lawId, rule.excerpt.text])) === JSON.stringify(dorm.sc.data.rules.map(rule => [rule.lawId, rule.excerpt.text])) && result.sc.data.search.keywords === undefined);
    }
    const meal = await call({ query: '식사 시간은 누가 정해?' });
    const unrelated = await call({ query: '식사 시간은 누가 정해?', keywords: '계약 해지, 계약상대자' });
    check('질문과 동떨어진 핵심어(규정에는 있음): 질문만으로 고른 규정이 마지막 미리보기 자리에 남고 그 조문도 발췌에 있음',
      ids(meal)[0] === 9 && ids(unrelated).indexOf(9) === 2 && headings(unrelated.sc.data.rules[2].excerpt.text).includes('제6조')
      && unrelated.sc.data.search.keywords.questionRuleKept === 9 && unrelated.sc.data.rules[2].selectedBy === 'question' && /질문 문장으로 고른 규정/.test(unrelated.text));
    for (const limit of [undefined, 1, 2, 3]) {
      const result = await call({query: '식사 시간은 누가 정해?', keywords: '계약 해지, 계약상대자', ...(limit === undefined ? {} : {max_rules: limit})});
      const rules = result.sc.data.rules, kept = rules.find(rule => rule.lawId === 9);
      check(`질문 규정 보존과 반환 메타데이터: max_rules ${limit ?? '기본'}`, !!kept && headings(kept.excerpt.text).includes('제6조') && rules.length <= (limit === undefined || limit === 1 ? 3 : limit) && result.sc.data.search.keywords.questionRuleKept === 9);
    }
    const single = await call({query: '기숙사 식사 시간', keywords: '기숙사, 식사', max_rules: 1});
    check('max_rules 1 단일 반환에서는 실제 반환 결과에만 보존 표시', single.sc.data.rules.length === 1 && !single.sc.data.search.keywords.questionRuleKept);
    const anchoredRule = await call({ query: '기숙사 식사 시간은 언제야', keywords: '계약 해지, 계약상대자' });
    check('질문에 규정 이름의 낱말이 있으면 동떨어진 핵심어를 줘도 그 규정이 미리보기에 남음', ids(anchoredRule).includes(9));
    check('반환 규정 수 상한은 핵심어가 있어도 3개', ids(unrelated).length <= 3 && ids(withKeywords).length <= 3);

    const scoped = await call({ query: '산학협력단에서 그 업체랑 그만하려면 어떻게 해?', keywords: '계약 해지' });
    check('범위 유지: 질문의 기관(산학협력단)은 핵심어를 줘도 그대로 적용', ids(scoped)[0] === 4 && scoped.sc.data.rules.every(rule => (rule.edition || '').includes('산학협력단')));
    const keywordScope = await call({ query: vague, keywords: '계약 해지, 산학협력단' });
    check('범위는 질문에서만 읽음: 핵심어에 기관명이 있어도 일반 규정을 빼지 않음', ids(keywordScope).includes(3));
    const scopeOnly = scoped.sc.data.rules.find(rule => rule.lawId === 5);
    check('기관명만 맞는 규정은 주제가 맞는 규정 뒤에 두고 그 사실을 표시(삭제하지 않음)',
      !!scopeOnly && scopeOnly.scopeNameOnly === true && ids(scoped).indexOf(5) === ids(scoped).length - 1 && /기관·캠퍼스 이름만 일치/.test(scoped.text));

    const age = await call({ query: '직원은 언제까지 일할 수 있어?', keywords: '직원, 정년, 연령' });
    const ageRule = age.sc.data.rules.find(rule => rule.lawId === 6);
    check('표제가 핵심어와 같은 조문(정년)이 그 말을 일부로 가진 조문(정년퇴직)보다 먼저', !!ageRule && headings(ageRule.excerpt.text)[0] === '제73조');
    const training = await call({ query: '직원이 위탁교육 받는 동안 지켜야 할 게 뭐야?', keywords: '직원, 위탁교육, 의무' });
    check('주체와 제도 이름 맞추기: 직원 위탁연수 규정의 의무 조문이 연구년 교원의 의무보다 먼저',
      ids(training)[0] === 8 && headings(training.sc.data.rules[0].excerpt.text).includes('제9조'));

    const explicitTerms = await call({ query: vague, keywords: '계약 해지, 계약상대자', terms: '제24조' });
    check('terms는 그대로 발췌 조건: 핵심어로 규정을 고르고 terms의 조문을 발췌', ids(explicitTerms)[0] === 3 && headings(explicitTerms.sc.data.rules[0].excerpt.text).join() === '제24조' && explicitTerms.sc.data.query.terms === '제24조');
    const byId = await call({ law_id: 6, keywords: '정년, 연령' });
    check('law_id로 고른 규정에서도 핵심어로 조문을 고름', byId.sc.ok === true && ids(byId).join() === '6' && headings(byId.sc.data.rules[0].excerpt.text)[0] === '제73조' && byId.sc.data.search.identityStatus === 'explicit_id');
    const byIdQuestion = await call({law_id: 9, query: '식사 시간은 누가 정해?', keywords: '제재', max_sections: 2});
    check('law_id와 질문 및 핵심어: 핵심어와 질문 조문을 순서대로 보존', headings(byIdQuestion.sc.data.rules[0].excerpt.text).slice(0, 2).join() === '제17조,제6조');
    const named = await call({ query: '취업규칙에서 몇 살까지 일할 수 있는지', keywords: '정년, 연령' });
    check('질문에 규정명이 있으면 그 규정 안에서 핵심어로 조문을 고름', ids(named).join() === '6' && named.sc.data.search.identityStatus === 'exact_title' && headings(named.sc.data.rules[0].excerpt.text)[0] === '제73조');
    const namedOff = await call({ query: '취업규칙에서 몇 살까지 일할 수 있는지', keywords: '가나다라' });
    const namedPlain = await call({ query: '취업규칙에서 몇 살까지 일할 수 있는지' });
    check('이름으로 고른 규정에 없는 핵심어: 질문만 넣은 발췌와 같음', namedOff.sc.data.rules[0].excerpt.text === namedPlain.sc.data.rules[0].excerpt.text && namedOff.sc.data.search.keywords.applied === false);

    // ── rule_keyword 오용 ──
    searches.length = 0;
    const topic = await call({ query: vague, rule_keyword: '해지' });
    check('query와 함께 온 rule_keyword가 규정명이 아니면 후보 목록 대신 질문·핵심어 경로로 조회',
      topic.sc.ok === true && ids(topic)[0] === 3 && topic.sc.data.query.ruleKeywordUsedAsKeyword === '해지' && topic.sc.data.search.mode === '핵심어 색인' && /규정명과 일치하지 않아 핵심어로/.test(topic.text));
    check('그때 주제어를 원문 사이트 전문검색에 넣지 않음', !searches.some(item => item.type === 'CONTENTS'));
    const topicTerms = await call({ query: vague, rule_keyword: '계약', terms: '해지, 계약상대자' });
    check('주제어를 terms에 넣은 호출도 규정 고르기에 반영, terms는 발췌 조건으로 유지',
      ids(topicTerms)[0] === 3 && topicTerms.sc.data.query.terms === '해지, 계약상대자' && headings(topicTerms.sc.data.rules[0].excerpt.text).includes('제29조'));
    const exact = await call({ query: '계약을 끊을 수 있는 경우', rule_keyword: '구매규정' });
    check('rule_keyword가 규정명과 같으면 지금처럼 그 규정을 조회', ids(exact).join() === '3' && exact.sc.data.search.identityStatus === 'exact_title' && exact.sc.data.query.ruleKeywordUsedAsKeyword === undefined);
    const partial = await call({query: vague, rule_keyword: '취업'});
    check('유일한 부분 규정명은 규정명 경로로 조회', ids(partial).join() === '6' && partial.sc.data.query.ruleKeywordUsedAsKeyword === undefined && partial.sc.data.search.mode !== '핵심어 색인');
    const multiple = await call({query: vague, rule_keyword: '구매'});
    check('여러 제목의 부분명은 기존 색인 경로 유지', multiple.sc.data.query.ruleKeywordUsedAsKeyword === '구매' && multiple.sc.data.search.mode === '핵심어 색인');
    const alone = await call({ rule_keyword: '해지' });
    check('query 없이 rule_keyword만 보낸 호출은 기존 경로 그대로(핵심어로 돌리지 않음)', alone.sc.data?.query?.ruleKeywordUsedAsKeyword === undefined && alone.sc.data?.search?.keywords === undefined && !/규정명과 일치하지 않아/.test(alone.text));

    // ── 입력 검증 ──
    const tooLong = await call({ query: vague, keywords: '가'.repeat(201) });
    check('keywords 길이 상한 200자', tooLong.sc.ok === false && tooLong.sc.error.code === 'INVALID_ARGUMENT' && /200자/.test(tooLong.sc.error.message));
    check('keywords 200자는 허용', (await call({ query: vague, keywords: `계약 해지, ${'가'.repeat(193)}` })).sc.ok === true);
    for (const value of [123, { a: 1 }, ['계약', 7]]) {
      const result = await call({ query: vague, keywords: value });
      check(`keywords ${JSON.stringify(value)}: 문자열이 아니면 거절`, result.sc.ok === false && result.sc.error.code === 'INVALID_ARGUMENT');
    }
    const asArray = await call({ query: vague, keywords: ['계약 해지', '계약상대자'] });
    check('문자열 배열로 온 keywords는 쉼표 목록으로 처리', asArray.sc.ok === true && ids(asArray)[0] === 3);
    for (const [label, value] of [['전화번호', ['010', '1234', '5678'].join('-')], ['인증정보', 'password=synthetic-only'], ['배열 속 계정', ['계약', 'someone@example.com']]]) {
      const result = await call({ query: vague, keywords: value });
      check(`keywords 민감정보 검사 적용: ${label}`, result.sc.ok === false && result.sc.error.code === 'SENSITIVE_INPUT');
    }
  } finally {
    await client.close(); await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`📊 핵심어 조회 검증: ${passed}개 통과`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

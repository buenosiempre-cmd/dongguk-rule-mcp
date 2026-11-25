// 타대학 비교 어댑터(홍익·한양·성균관·세종·가천), 네트워크 없이 합성 응답으로 검증.
// 목록·본문·날짜는 모두 합성 자료이며 실제 규정이 아니다.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SOURCES, createPublicClient, loadExternal, expandTopic, compareUniversityRules, formatComparison } = require('../src/university-rules');
const { DOCUMENT_NOTICE, htmlLines, dropUnreadArticles, isAppendixLabel, parseHongikTree, parseSkkuRows, currentSkkuRules, parseSejongList } = require('../src/university-adapters');
const { listArticleBlocks } = require('../src/parsers');

const source = key => SOURCES.find(s => s.key === key);
const spec = expandTopic('여비');
const NOW = () => Date.parse('2026-11-25T03:00:00Z');
const PDF = fs.readFileSync(path.join(__dirname, 'fixtures/cau-pdf/unspaced-reference-control.pdf'));
const HWP = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
const PDF_TEXT = '여비 규정\n제1조(목적) 출장 여비를 정한다.\n제2조(일비) 출장 일비와 숙박비를 지급한다.\n부칙\n이 규정은 2026년 3월 1일부터 시행한다.';
const MIB = 1024 * 1024;

// fetch 대역: 호출 기록과 경로별 응답. 응답은 문자열(HTML·JSON) 또는 Buffer(문서).
function network(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), target = parsed.pathname + parsed.search;
    calls.push({ url, target, method: options.method, body: options.body, size: options.size, headers: options.headers, redirect: options.redirect });
    for (const [match, respond] of routes) {
      if (!(typeof match === 'string' ? target.includes(match) : match.test(target))) continue;
      const value = typeof respond === 'function' ? respond(target, options) : respond;
      if (value && value.status) return { ok: false, status: value.status };
      return Buffer.isBuffer(value) ? { ok: true, status: 200, buffer: async () => value } : { ok: true, status: 200, text: async () => value };
    }
    throw new Error('Unexpected fixture request: ' + target);
  };
  return { calls, client: createPublicClient({ minIntervalMs: 0, fetchImpl }) };
}
const load = (key, client, options = {}, topic = '여비') => loadExternal(source(key), topic, expandTopic(topic).terms, client, undefined, expandTopic(topic), { now: NOW, ...options });

// ── 합성 응답 ──
const hongikTree = () => {
  const leaves = Array.from({ length: 24 }, (_, i) => `<li><a href="#menu02" data-category-id="${200 + i}" data-has-child="false" class="has-child-category">${i + 1}) 합성 내규 ${i}</a></li>`).join('');
  const part = `<li><a href="#menu01" data-category-id="74" data-has-child="true" class="has-child-category">제3편 여비 행정</a><ul>
    <li><a href="#menu02" data-category-id="145">4) 여비 규정</a></li>
    <li><a href="#menu02" data-category-id="146" data-has-child="false">35-1) 출장 지원센터 규정</a></li>${leaves}</ul></li>`;
  return `<ul class="b-regulation-part mobile-hide">${part}</ul><ul class="b-regulation-part">${part}</ul><div class="b-content-box"></div>`;
};
const hongikRule = '<div class="b-file-box"><a href="?mode=download&amp;articleNo=604&amp;attachNo=1">파일</a></div><div class="b-content-box"><div class="b-con-box"><div class="fr-view"><p>여비 규정</p><p>제1조(목적)&nbsp;이 규정은 출장 여비를 정한다. &lt;개정&nbsp;2025.12.1.&gt;</p><p>제2조(일비)&nbsp;출장 일비와 숙박비는 별표2에 따라 지급한다.</p><p>부칙</p><p>(시행일)&nbsp;이 개정 규정은&nbsp;2025년&nbsp;12월&nbsp;1일부터 시행한다.</p></div></div></div>';

const hanyangSearch = JSON.stringify({ DS_SEARCH: [{ list: [
  { rowNo: 1, gyujeongCd: '138', gyujeongNm: '<span style="font-weight:bold;color:#ff0000">여비</span>지급 규정', gaejeongDt: '20180227', jejeongDt: '19850220', jugwanBuseoNm: '합성부서' },
  { rowNo: 2, gyujeongCd: '9;drop', gyujeongNm: '여비 주입 규정', gaejeongDt: '20200101' },
] }] });
const hanyangRow = (level, cd, parent, name, body, extra = {}) => ({ itemLevel: level, gyujeongCd: '138', itemNm: name, itemCd: cd, parentItemCd: parent, itemNaeyong: body, pyosiYn: '1', pyejiDt: null,
  insertMan: 'A011141', insertIp: '166.104.0.1', updateMan: 'A036680', ...extra });
const hanyangView = JSON.stringify({ DS_SMGHGJ02TTM01: [{ list: [
  hanyangRow(1, '000', '000', '여비지급 규정', null),
  hanyangRow(2, '001', '000', '본문', null),
  hanyangRow(3, '003', '001', '제1조(목적)', '<p><span style="font-family: 굴림;">이 규정은 출장 여비를 정한다.</span></p>\n'),
  hanyangRow(3, '018', '001', '제2조(여비의 종류)', '<p>여비는 교통비, 숙박비, 식비, 일비로 구분한다.</p>'),
  hanyangRow(3, '019', '001', '제3조(숨김)', '<p>표시하지 않는 출장 조문</p>', { pyosiYn: '0' }),
  hanyangRow(3, '020', '001', '제4조(폐지)', '<p>폐지된 출장 조문</p>', { pyejiDt: '20200101' }),
  hanyangRow(2, '002', '000', '부칙', null),
  hanyangRow(3, '012', '002', '부칙(2018.2.27. 공포)', '<p>(시행일) 이 규정은 2017년 12월 20일부터 시행한다.</p>'),
  hanyangRow(2, '013', '000', '별표', null),
  hanyangRow(3, '014', '013', '(별표 1)', '<p>출장 숙박비 별표고유금액 999원</p>'),
] }] });

const skkuPage = (rows, lastOffset = 0, empty = false) => `<table><thead><tr><th>번호</th><th>규정명</th><th>제·개정일</th><th>규정</th><th>별첨</th></tr></thead><tbody>${
  empty ? '<tr><td colspan="5">등록된 글이 없습니다.</td></tr>' : rows.map(([title, date, article, attach], i) => `<tr class=" "><td class=""> ${rows.length - i} </td><td class="left"><a href="?mode=view&amp;articleNo=${article}&amp;article.offset=0&amp;articleLimit=10"> ${title} </a></td><td> ${date} </td><td><a href="?mode=download&amp;articleNo=${article}&amp;attachNo=${attach}"><img alt="pdf다운로드"></a></td><td><a href="?mode=download&amp;articleNo=${article}&amp;attachNo=${attach + 1}"><img></a></td></tr>`).join('')
}</tbody></table><a href="?mode=list&amp;article.offset=${lastOffset}&amp;articleLimit=10">끝</a>`;

const sejongList = (padding = 0) => {
  const m = (id, label, hrefFirst) => `<tr><td> ${label}</td> <td> <div class="link-box center no-mg"> <ul> <li> <a class="btn type01 blank" ${hrefFirst ? `href="/app/board/regulations/pdf/${id}_M.do" data-category-id="999" data-provTy="M"` : `data-category-id="${id}" data-provTy="M" href="/app/board/regulations/pdf/${id}_M.do"`} target="_blank"><span>규정 보기</span></a></li></ul></div></td><td><a data-provTy="P" href="/app/board/regulations/pdf/${id}_P.do">대비표 보기</a></td></tr>`;
  const filler = Array.from({ length: 22 }, (_, i) => m(300 + i, `합성 내규 ${i}(2020. 3. 1. 시행)`, i % 2 === 0)).join('');
  return `<html><!--${'x'.repeat(padding)}--><table>${m(261, '여비 규정(2022. 12. 15. 시행)', true)}${m(262, '출장 행동강령(2022. 12. 21. 제정)', false)}${m(263, '출장 달력 오류 규정(2023. 2. 30. 시행)', false)}${filler}</table></html>`;
};

const gachonList = JSON.stringify([
  { clNm: '제4장 재무행정', regltnSeq: 191, sj: '출장비규정', fileNm: '[3405] 출장비규정.hwp' },
  { clNm: '제4장 재무행정', regltnSeq: 192, sj: '출장여비지급세칙', fileNm: '[3406] 출장여비지급세칙.pdf' },
  { clNm: '제4장 재무행정', regltnSeq: 193, sj: '출장 신청 내규', fileNm: '[3407] 출장.zip' },
  ...Array.from({ length: 20 }, (_, i) => ({ clNm: '제1장', regltnSeq: 500 + i, sj: `합성규정${i}`, fileNm: `x${i}.pdf` })),
]);
const HWP_BODY = '### 제1조(목적) 이 규정은 출장비를 정한다.\n### 제2조(숙박) 출장 숙박료를 지급한다.\n## 부칙\n이 규정은 2026년 5월 26일부터 시행한다.';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ✅ ' + name); }

async function main() {
  await check('등록: 다섯 대학의 허용 경로·문서 경로·응답 한도', async () => {
    assert.deepEqual(['hongik', 'hanyang', 'skku', 'sejong', 'gachon'].map(key => source(key)?.mode), Array(5).fill('adapter'));
    assert.equal(source('sejong').maxTextBytes, 6 * MIB);
    assert.deepEqual(['hongik', 'hanyang', 'skku', 'gachon'].map(key => source(key).maxTextBytes), Array(4).fill(undefined));
    assert.deepEqual([source('hongik').documentPath, source('hanyang').documentPath], [undefined, undefined]);
    assert.equal(source('hanyang').contentType, 'application/json+sua; charset=UTF-8');
  });

  await check('공개 클라이언트: 선언한 경로와 문서 경로만 통과', async () => {
    const { client, calls } = network([[/./, PDF]]);
    const denied = async (key, target, options) => assert.rejects(client.request(source(key), target, undefined, 1000, undefined, options), e => e.code === 'SOURCE_NOT_ALLOWED');
    await denied('hanyang', '/huas/iycy/ruleBook.do');
    await denied('skku', '/state/current/current_rulebook.do?mode=view&articleNo=1');
    await denied('hongik', '/kr/introduction/regulations-book.do', { binary: true });
    await denied('hanyang', '/huas/iycy/findGyujeongMView.do?strGyujeongCd=1', { binary: true });
    await denied('skku', '/state/current/current_rulebook.do?mode=download&articleNo=1&attachNo=2&next=/etc', { binary: true });
    await denied('sejong', '/app/board/regulations/pdf/161_P.do', { binary: true });
    await denied('gachon', '/regltn/kor/2/82/synapView', { binary: true });
    assert.equal(calls.length, 0);
    assert(Buffer.isBuffer(await client.request(source('skku'), '/state/current/current_rulebook.do?mode=download&articleNo=1&attachNo=2', undefined, 1000, undefined, { binary: true })));
    assert.deepEqual([calls.length, calls[0].redirect, calls[0].size], [1, 'manual', 8 * MIB]);
  });

  await check('공개 클라이언트: 한글 파일은 받겠다고 한 요청에만, 그 밖의 형식은 거절', async () => {
    const gachon = network([[/\/191\/download$/, HWP], [/\/193\/download$/, Buffer.from('PK\u0003\u0004 zip archive bytes')]]);
    assert(Buffer.isBuffer(await gachon.client.request(source('gachon'), '/regltn/kor/2/191/download', undefined, 1000, undefined, { binary: true, formats: ['pdf', 'hwp'] })));
    await assert.rejects(gachon.client.request(source('gachon'), '/regltn/kor/2/193/download', undefined, 1000, undefined, { binary: true, formats: ['pdf', 'hwp'] }), e => e.code === 'DOCUMENT_FORMAT_UNSUPPORTED');
    const skku = network([[/./, HWP]]);
    await assert.rejects(skku.client.request(source('skku'), '/state/current/current_rulebook.do?mode=download&articleNo=1&attachNo=2', undefined, 1000, undefined, { binary: true }), e => e.code === 'PDF_INVALID');
  });

  await check('홍익: 규정 트리의 말단만 후보, 조문 HTML과 부칙 시행일', async () => {
    const items = parseHongikTree(hongikTree());
    assert.equal(items.length, 26, '모바일용 중복 목록과 편 제목은 세지 않음');
    assert.deepEqual(items.slice(0, 2), [{ id: '145', title: '여비 규정' }, { id: '146', title: '출장 지원센터 규정' }]);
    const { client, calls } = network([['srCategoryId=145', hongikRule], ['srCategoryId=146', '<div class="b-content-box"><div class="fr-view"><p>조문이 없는 안내문</p></div></div>'], ['/kr/introduction/regulations-book.do', hongikTree()]]);
    const result = await load('hongik', client);
    assert.deepEqual(result.rules.map(r => [r.title, r.lawId, r.revisedAt, r.effectiveAt, r.effectiveSource]), [['여비 규정', 145, null, '2025-12-01', 'addenda']], '개정일은 머리말·부칙 표제에 날짜가 있을 때만');
    assert.deepEqual(listArticleBlocks(result.rules[0].markdown).map(b => b.canonical), ['제1조', '제2조']);
    assert.match(result.rules[0].url, /^https:\/\/www\.hongik\.ac\.kr\/kr\/introduction\/regulations-book\.do\?mode=list&srCategoryId=145&/);
    assert.deepEqual(result.failures, [{ lawId: 146, code: 'UPSTREAM_FORMAT_CHANGED' }]);
    assert.deepEqual([result.coverage.mode, result.coverage.totalCandidates, result.coverage.titleMatches, result.coverage.complete], ['html_catalog', 26, 2, false]);
    assert(calls.every(call => call.size === 2 * MIB && call.method === 'GET'));
    await assert.rejects(load('hongik', network([[/./, '<ul class="b-regulation-part"></ul>']]).client), e => e.code === 'UPSTREAM_FORMAT_CHANGED');
  });

  await check('한양: 규정명 검색과 조문 JSON, 관리 필드·별표·숨김 조문 제외', async () => {
    const { client, calls } = network([['findGyujeongSearch1HYU', hanyangSearch], ['findGyujeongMView', hanyangView]]);
    const result = await load('hanyang', client);
    assert.deepEqual(result.rules.map(r => [r.title, r.lawId, r.historyId, r.revisedAt, r.effectiveAt]), [['여비지급 규정', 138, 20180227, '2018.02.27', '2017-12-20']]);
    const markdown = result.rules[0].markdown;
    assert.deepEqual(listArticleBlocks(markdown).filter(b => !b.supplementary).map(b => b.canonical), ['제1조', '제2조']);
    assert.match(markdown, /### 제1조\(목적\)\n이 규정은 출장 여비를 정한다\.[\s\S]*## 부칙/);
    assert.doesNotMatch(JSON.stringify(result), /A011141|166\.104|A036680|별표고유금액|숨김|폐지된/);
    assert.equal(result.coverage.totalCandidates, 1, '형식이 다른 규정 코드는 후보에서 제외');
    const search = calls.find(call => call.target.includes('Search1HYU'));
    assert.deepEqual([search.method, search.body, search.headers['Content-Type']], ['POST', '{}', 'application/json+sua; charset=UTF-8']);
    assert.match(search.target, /searchStr=%25EC%2597%25AC%25EB%25B9%2584$/, '화면과 같은 이중 인코딩');
    assert(calls.filter(call => call.target.includes('MView')).every(call => call.target === '/huas/iycy/findGyujeongMView.do?strGyujeongCd=138&searchStr='));
    await assert.rejects(load('hanyang', network([[/./, '<html>점검</html>']]).client), e => e.code === 'UPSTREAM_FORMAT_CHANGED');
  });

  await check('성균관: 개정본 줄 중 오늘 이전 최신본, 시행 예정본은 따로 표시', async () => {
    const rows = parseSkkuRows(skkuPage([['여비 규정', '2027.03.01', 3, 30], ['여비 규정', '2026.03.01', 2, 20], ['여비규정', '2024.03.01', 1, 10], ['달력 오류 규정', '2026.02.30', 9, 90]]));
    assert.deepEqual([rows.rows.length, rows.newestFirst, rows.lastOffset], [3, true, 0]);
    assert.deepEqual(currentSkkuRules(rows.rows, '2026-11-25'), [{ title: '여비 규정', date: '2026-03-01', articleNo: '2', attachNo: '20', upcomingAt: '2027-03-01' }]);
    assert.deepEqual(currentSkkuRules(rows.rows, '2023-01-01'), [], '모든 줄이 미래면 현행본 없음');
    const { client, calls } = network([['mode=download', PDF], ['mode=list', skkuPage([['여비 규정', '2027.03.01', 3, 30], ['여비 규정', '2026.03.01', 2, 20], ['여비규정', '2024.03.01', 1, 10]])]]);
    const result = await load('skku', client);
    assert.deepEqual(result.rules.map(r => [r.title, r.lawId, r.historyId, r.revisedAt, r.upcomingRevisionAt, r.sourceType]), [['여비 규정', 2, 20260301, '2026.03.01', '2027-03-01', 'PDF 텍스트 레이어']]);
    assert.deepEqual(listArticleBlocks(result.rules[0].markdown).map(b => b.canonical), ['제1조', '제2조'], '실제 PDF 추출기와 조문 변환');
    assert.equal(result.rules[0].originalPdfUrl, 'https://www.skku.edu/state/current/current_rulebook.do?mode=download&articleNo=2&attachNo=20');
    assert.deepEqual([result.coverage.mode, result.coverage.channel, result.coverage.currentRevisionConfirmedByTitle, result.coverage.comparisonScope, result.coverage.appendicesCompared, result.coverage.complete], ['board_pdf', 'title', false, 'articles_only', false, false]);
    assert.equal(calls.filter(call => call.target.includes('mode=download')).length, 1);
    assert(calls.filter(call => call.target.includes('mode=list')).every(call => /srSearchKey=article_title&srSearchVal=[^&]+&articleLimit=10&article\.offset=0$/.test(call.target)));
  });

  await check('성균관: 본문 검색 후보는 규정명으로 현행본을 다시 확인', async () => {
    const title = encodeURIComponent('직원 복무규정');
    const routes = stale => [
      ['mode=download', PDF],
      [`srSearchKey=article_title&srSearchVal=${title}`, stale ? skkuPage([], 0, true) : skkuPage([['직원 복무규정', '2026.11.01', 11, 110], ['직원 복무규정', '2025.02.23', 10, 100], ['직원 복무규정 시행세칙', '2026.11.20', 12, 120]])],
      ['srSearchKey=article_text', skkuPage([['직원 복무규정', '2025.02.23', 10, 100]])],
      ['srSearchKey=article_title', skkuPage([], 0, true)],
    ];
    const fresh = network(routes(false));
    const result = await load('skku', fresh.client);
    assert.deepEqual(result.rules.map(r => [r.title, r.lawId, r.revisedAt]), [['직원 복무규정', 11, '2026.11.01']]);
    assert.deepEqual([result.coverage.channel, result.coverage.currentRevisionConfirmedByTitle], ['content', true]);
    assert.match(fresh.calls.find(call => call.target.includes('mode=download')).target, /articleNo=11&attachNo=110$/, '본문 검색에 나온 옛 개정본을 내려받지 않음');
    const unverified = await load('skku', network(routes(true)).client);
    assert.deepEqual([unverified.rules.length, unverified.failures], [0, [{ lawId: 10, code: 'PDF_REVISION_UNVERIFIED', stage: 'revision_confirmation', title: '직원 복무규정', reason: 'TITLE_NOT_FOUND' }]]);
    assert.deepEqual([unverified.coverage.currentRevisionConfirmedByTitle, unverified.coverage.currentRevisionUnverified], [false, 1], '확인하지 못했으면 확인 완료로 올리지 않음');
  });

  await check('성균관: 쪽 수 상한·정렬 미확인·형식 변경', async () => {
    const paged = network([['mode=download', PDF], ['mode=list', target => skkuPage([['여비 규정', /offset=10$/.test(target) ? '2020.03.01' : '2026.03.01', /offset=10$/.test(target) ? 5 : 6, 60]], 30)]]);
    const result = await load('skku', paged.client);
    assert.deepEqual([result.coverage.searchPagesTruncated, result.coverage.truncated, result.rules[0].lawId], [true, true, 6]);
    assert.deepEqual([...new Set(paged.calls.filter(call => call.target.includes('mode=list')).map(call => /offset=(\d+)$/.exec(call.target)[1]))], ['0', '10'], '검색어마다 최대 2쪽');
    const unordered = network([['mode=download', PDF], ['mode=list', skkuPage([['여비 규정', '2024.03.01', 1, 10], ['여비 규정', '2026.03.01', 2, 20]])]]);
    assert.equal((await load('skku', unordered.client)).coverage.currentRevisionConfirmedByTitle, true);
    await assert.rejects(load('skku', network([[/./, '<html><body>개편된 화면</body></html>']]).client), e => e.code === 'UPSTREAM_FORMAT_CHANGED');
    const broken = await load('skku', network([['mode=download', Buffer.from('%PDF-1.4 damaged')], ['mode=list', skkuPage([['여비 규정', '2026.03.01', 2, 20]])]]).client);
    assert.deepEqual(broken.failures, [{ lawId: 2, code: 'PDF_PARSE_FAILED' }]);
  });

  await check('세종: 큰 목록은 이 대학에만 허용하고 원문은 캐시하지 않음', async () => {
    const items = parseSejongList(sejongList());
    assert.equal(items.length, 25);
    assert.deepEqual(items.slice(0, 3), [
      { id: '261', title: '여비 규정', effectiveAt: '2022-12-15', revisedAt: null },
      { id: '262', title: '출장 행동강령', effectiveAt: null, revisedAt: '2022.12.21' },
      { id: '263', title: '출장 달력 오류 규정', effectiveAt: null, revisedAt: null },
    ], '문서 번호는 링크 주소의 것, 제정일은 시행일이 아님, 없는 날짜는 쓰지 않음');
    const big = sejongList(2.2 * MIB);
    const { client, calls } = network([['/app/board/regulations/pdf/', PDF], ['/kor/intro/regulation-overview.do', big]]);
    const first = await load('sejong', client, { extractPdf: async () => ({ text: PDF_TEXT, pages: 1 }) });
    assert.deepEqual(first.rules.map(r => [r.title, r.lawId, r.effectiveAt, r.effectiveSource, r.revisedAt]).slice(0, 2), [['여비 규정', 261, '2022-12-15', 'list', null], ['출장 행동강령', 262, null, null, '2022.12.21']]);
    assert.equal(first.rules[0].originalPdfUrl, 'https://www.sejong.ac.kr/app/board/regulations/pdf/261_M.do');
    assert.deepEqual([first.coverage.mode, first.coverage.totalCandidates, first.coverage.complete], ['catalog_pdf', 25, false]);
    assert.equal(calls.find(call => call.target === '/kor/intro/regulation-overview.do').size, 6 * MIB);
    await load('sejong', client, { extractPdf: async () => ({ text: PDF_TEXT, pages: 1 }) });
    assert.equal(calls.filter(call => call.target === '/kor/intro/regulation-overview.do').length, 1, '파싱한 목록을 재사용');
    await client.request(source('sejong'), '/kor/intro/regulation-overview.do', undefined, 1000);
    assert.equal(calls.filter(call => call.target === '/kor/intro/regulation-overview.do').length, 2, '2 MiB를 넘는 원문은 클라이언트 캐시에 없음');
    await load('sejong', client, { extractPdf: async () => ({ text: PDF_TEXT, pages: 1 }), now: () => NOW() + 600001 });
    assert.equal(calls.filter(call => call.target === '/kor/intro/regulation-overview.do').length, 3, '10분 뒤에는 목록을 다시 읽음');
    await assert.rejects(load('sejong', network([[/./, '<html>개편</html>']]).client), e => e.code === 'UPSTREAM_FORMAT_CHANGED');
  });

  await check('가천: PDF·한글 파일 첨부를 형식에 맞게 읽고 그 밖은 실패로 남김', async () => {
    const { client, calls } = network([[/\/191\/download$/, HWP], [/\/192\/download$/, PDF], [/\/193\/download$/, Buffer.from('PK\u0003\u0004 zip archive bytes')], ['/regltn/kor/2/5/listOperation', gachonList]]);
    const result = await load('gachon', client, { parseHwp: async buffer => { assert(buffer.equals(HWP)); return { bodyMarkdown: HWP_BODY, markdown: HWP_BODY + '\n[별지 제1호] 출장신청서' }; } });
    assert.deepEqual(result.rules.map(r => [r.title, r.lawId, r.sourceType, r.effectiveAt]), [['출장여비지급세칙', 192, 'PDF 텍스트 레이어', null], ['출장비규정', 191, '한글 파일 본문', null]], '별지를 뺀 한글 파일은 시행일 미확인');
    assert.deepEqual(result.failures, [{ lawId: 193, code: 'DOCUMENT_FORMAT_UNSUPPORTED' }]);
    assert.deepEqual([result.coverage.mode, result.coverage.totalCandidates, result.coverage.titleMatches], ['catalog_files', 23, 3]);
    const list = calls.find(call => call.target === '/regltn/kor/2/5/listOperation');
    assert.deepEqual([list.method, list.body, list.headers['Content-Type']], ['POST', 'srchColumn=sj&srchWrd=', 'application/x-www-form-urlencoded']);
    const whole = await load('gachon', network([[/\/191\/download$/, HWP], [/download$/, PDF], ['listOperation', gachonList]]).client, { parseHwp: async () => ({ bodyMarkdown: HWP_BODY, markdown: HWP_BODY }) });
    assert.equal(whole.rules.find(r => r.lawId === 191).effectiveAt, '2026-05-26');
    const failed = await load('gachon', network([[/\/191\/download$/, HWP], [/download$/, PDF], ['listOperation', gachonList]]).client, { parseHwp: async () => { throw new Error('parser detail must not leak'); } });
    assert.deepEqual(failed.failures[0], { lawId: 191, code: 'HWP_PARSE_FAILED' });
    const empty = await load('gachon', network([[/\/191\/download$/, HWP], [/download$/, PDF], ['listOperation', gachonList]]).client, { parseHwp: async () => ({ bodyMarkdown: '조문 없는 안내', markdown: '조문 없는 안내' }) });
    assert.deepEqual(empty.failures[0], { lawId: 191, code: 'HWP_NO_ARTICLES' });
    await assert.rejects(load('gachon', network([[/./, '{"error":true}']]).client), e => e.code === 'UPSTREAM_FORMAT_CHANGED');
  });

  await check('차단·로그인 화면은 실패 사유로 남기고 뒤 후보를 더 읽지 않음', async () => {
    const blocked = network([['srCategoryId=', { status: 403 }], ['/kr/introduction/regulations-book.do', hongikTree()]]);
    const result = await load('hongik', blocked.client);
    assert.deepEqual([result.rules.length, result.failures], [0, [{ lawId: 145, code: 'ACCESS_DENIED' }]]);
    assert.equal(blocked.calls.filter(call => call.target.includes('srCategoryId=')).length, 1);
    await assert.rejects(load('gachon', network([[/./, '<form><input type="password" name="pw"></form>']]).client), e => e.code === 'SESSION_REQUIRED');
  });

  // ── PR #37 레드팀 1차 검수의 반례(I1·I2·I3·R1). 라벨은 검수 증거의 것과 같다. ──
  const dongguk = async () => ({ rules: [], failures: [], coverage: { complete: true } });
  const compare = async (keys, routes) => {
    const net = network(routes);
    const result = await compareUniversityRules({ topic: '여비', universities: keys, max_articles: 5 }, { client: net.client, loadDongguk: dongguk,
      loadExternalImpl: (src, topic, terms, client, signal, spec2) => loadExternal(src, topic, terms, client, signal, spec2, { now: NOW }) });
    return { result, text: formatComparison(result), calls: net.calls, column: result.columns.find(c => c.university === keys[0]) };
  };
  const foundCells = (result, key) => (result.slotMatrix?.slots || []).filter(slot => slot.cells[key]?.status === 'found').map(slot => slot.key);
  const hongikPage = html => `<div class="b-content-box"><div class="fr-view">${html}</div></div>`;
  const hongikRoutes = html => [['srCategoryId=145', hongikPage(html)], ['srCategoryId=', hongikPage('<p>안내</p>')], ['regulations-book.do', hongikTree()]];
  const hySearch = JSON.stringify({ DS_SEARCH: [{ list: [{ gyujeongCd: '138', gyujeongNm: '여비 규정', gaejeongDt: '20260101' }] }] });
  const hyView = (section, body = '<p>출장 일비는 999원을 지급한다.</p>', extra = []) => JSON.stringify({ DS_SMGHGJ02TTM01: [{ list: [hanyangRow(2, '1', '0', section, null), hanyangRow(3, '2', '1', '제99조(출장 일비)', body), ...extra] }] });
  const hyRoutes = view => [['Search1HYU', hySearch], ['MView', view]];

  await check('I1 hongik-appendix-table: 별표 표의 조문형 문자열은 비교 조문이 아님', async () => {
    const annex = await compare(['hongik'], hongikRoutes('<p>제1조(목적) 출장 여비를 정한다.</p><p>[별표 1]</p><table><tr><td>제99조(일비)</td><td>출장 일비는 999원을 지급한다.</td></tr></table>'));
    assert.deepEqual(annex.column.articles.map(a => a.article), ['제1조']);
    assert.doesNotMatch(JSON.stringify(annex.result) + annex.text, /제99조|999원/);
    assert.deepEqual(foundCells(annex.result, 'hongik').includes('per_diem'), false);
    assert.deepEqual([annex.column.status, annex.column.coverage.appendicesCompared, annex.column.coverage.tablesCompared, annex.column.articles[0].effectiveAt], ['partial', false, false, null]);
    // 별표 앞의 부칙이 마지막 부칙이면 그 시행일을 쓰고, 별표 뒤에 부칙이 또 있으면 미확인으로 둔다.
    const before = await load('hongik', network(hongikRoutes('<p>제1조(목적) 출장 여비를 정한다.</p><p>부칙</p><p>이 규정은 2025년 12월 1일부터 시행한다.</p><p>[별표 1]</p><p>여비 지급 구분표</p>')).client);
    const after = await load('hongik', network(hongikRoutes('<p>제1조(목적) 출장 여비를 정한다.</p><p>부칙</p><p>이 규정은 2025년 12월 1일부터 시행한다.</p><p>[별표 1]</p><p>부칙</p><p>이 규정은 2026년 3월 1일부터 시행한다.</p>')).client);
    assert.deepEqual([before.rules[0].effectiveAt, after.rules[0].effectiveAt], ['2025-12-01', null]);
    assert.doesNotMatch(before.rules[0].markdown + after.rules[0].markdown, /구분표|2026년 3월/);
    // 괄호 종류가 달라도, 별표 표제 없이 본문에 낀 표여도 표 셀은 조문이 되지 않는다.
    const bracket = await compare(['hongik'], hongikRoutes('<p>제1조(목적) 출장 여비를 정한다.</p><p>〔별표 1〕</p><p>제99조(일비) 출장 일비는 999원을 지급한다.</p>'));
    assert.deepEqual(bracket.column.articles.map(a => a.article), ['제1조']);
    const inline = await load('hongik', network(hongikRoutes('<p>제1조(일비) 출장 일비는 다음 표와 같다.</p><table><tr><td>제99조(표)</td><td>999원</td></tr></table><p>제2조(정산) 출장 여비를 정산한다.</p>')).client);
    assert.deepEqual([listArticleBlocks(inline.rules[0].markdown).map(b => b.canonical), inline.rules[0].tablesOmitted], [['제1조', '제2조'], 1]);
    assert.doesNotMatch(inline.rules[0].markdown, /제99조|999원/);
  });

  await check('I1 대조군: 본문의 「별표에 따른다」 참조와 그 뒤 조문은 그대로', async () => {
    const body = await load('hongik', network(hongikRoutes('<p>제1조(지급) 출장 일비는 별표 1에 따라 지급한다.</p><p>제2조(정산)&nbsp;출장 여비는 [별표 2]에 따른 기준으로 정산한다.</p><p>제3조(준용) 출장 숙박비는 제9조(일비)에 따른다.</p><p>부칙</p><p>이 규정은 2025년 12월 1일부터 시행한다.</p>')).client);
    assert.deepEqual(listArticleBlocks(body.rules[0].markdown).filter(b => !b.supplementary).map(b => b.canonical), ['제1조', '제2조', '제3조'], '참조한 제9조는 새 조문이 아님');
    assert.match(body.rules[0].markdown, /별표 1에 따라 지급한다[\s\S]*\[별표 2\]에 따른 기준으로 정산한다[\s\S]*제9조\(일비\)에 따른다/);
    assert.deepEqual([body.rules[0].effectiveAt, body.failures], ['2025-12-01', [{ lawId: 146, code: 'UPSTREAM_FORMAT_CHANGED' }]]);
    assert.deepEqual([isAppendixLabel('별표'), isAppendixLabel('〔별표 1〕'), isAppendixLabel('[ 서 식 2 ]'), isAppendixLabel('（별지 제1호）'), isAppendixLabel('본문'), isAppendixLabel('부칙'), isAppendixLabel('제5조(별표의 적용)')], [true, true, true, true, false, false, false]);
  });

  await check('I1 hanyang-bracketed-appendix·plain-appendix-control: 괄호가 있어도 별표 묶음은 제외', async () => {
    for (const section of ['〔별표 1〕', '별표', '[별표 1]', '( 서식 )', '【부록】']) {
      const annex = await compare(['hanyang'], hyRoutes(hyView(section)));
      assert.deepEqual([annex.column.articles.length, annex.column.status, annex.column.failures], [0, 'unavailable', [{ lawId: 138, code: 'ARTICLE_TEXT_UNAVAILABLE' }]], section);
      assert.doesNotMatch(JSON.stringify(annex.result) + annex.text, /제99조|999원/, section);
      assert.deepEqual(foundCells(annex.result, 'hanyang'), [], section);
    }
    // 본문 묶음의 조문은 남고, 조문 본문 안의 독립 별표 표제 뒤와 표는 빠진다.
    const mixed = await load('hanyang', network(hyRoutes(hyView('본문', '<p>출장 일비는 별표 1에 따라 지급한다.</p><p>[별표 1]</p><p>별표고유금액 777원</p><table><tr><td>제98조(표)</td></tr></table>',
      [hanyangRow(3, '3', '1', '(별표 2)', '<p>제97조(별표 항목) 555원</p>')]))).client);
    assert.deepEqual(listArticleBlocks(mixed.rules[0].markdown).map(b => b.canonical), ['제99조']);
    assert.match(mixed.rules[0].markdown, /별표 1에 따라 지급한다/);
    assert.doesNotMatch(mixed.rules[0].markdown, /777원|555원|제98조|제97조/);
    assert.equal(mixed.rules[0].tablesOmitted, 1);
  });

  await check('I2 hanyang-image-only-article·hongik-image-only-article: 그림뿐인 본문은 제목만으로 찾음 처리하지 않음', async () => {
    const hanyang = await compare(['hanyang'], hyRoutes(hyView('본문', '<img src="/synthetic-rule-image.png">')));
    const hongik = await compare(['hongik'], hongikRoutes('<p>제1조(출장 일비)</p><img src="/synthetic-rule-image.png">'));
    for (const [key, article, run] of [['hanyang', '제99조(출장 일비)', hanyang], ['hongik', '제1조(출장 일비)', hongik]]) {
      assert.deepEqual([run.column.articles, run.column.status, foundCells(run.result, key)], [[], 'unavailable', []], key);
      assert.deepEqual(run.column.failures.filter(f => f.code === 'ARTICLE_TEXT_UNAVAILABLE').map(f => [f.article, f.reason]), [[article, 'image_only']], key);
      assert.match(run.text, new RegExp(`본문을 읽지 못해 비교에서 뺀 조문 1건 — ${article.replace(/[()]/g, '\\$&')}\\(본문이 그림뿐\\)[^\\n]*원문에서 확인하세요`), key);
    }
    // 읽은 조문과 그림뿐인 조문이 섞이면 읽은 조문만 비교하고 나머지는 조문별로 남긴다.
    const mixed = await load('hongik', network(hongikRoutes('<p>제1조(목적) 출장 여비를 정한다.</p><p>제2조(일비)</p><p><img src="/a.png"></p><p>제3조(숙박) 출장 숙박비 <img src="/b.png"> 를 지급한다.</p><p>제4조 삭제 &lt;2020.1.1.&gt;</p><p>제5조(빈 조문)</p>')).client);
    assert.deepEqual(listArticleBlocks(mixed.rules[0].markdown).map(b => b.canonical), ['제1조', '제3조', '제4조']);
    assert.deepEqual([mixed.rules[0].unreadArticles, mixed.rules[0].imagesOmitted], [[{ article: '제2조(일비)', reason: 'image_only' }, { article: '제5조(빈 조문)', reason: 'empty' }], 1]);
    assert.deepEqual(mixed.failures.filter(f => f.lawId === 145), [{ lawId: 145, code: 'ARTICLE_TEXT_UNAVAILABLE', article: '제2조(일비)', reason: 'image_only' }, { lawId: 145, code: 'ARTICLE_TEXT_UNAVAILABLE', article: '제5조(빈 조문)', reason: 'empty' }]);
    assert.doesNotMatch(mixed.rules[0].markdown, /그림/);
    assert.deepEqual(htmlLines('<p>가<br>나</p><table><tr><td>제9조(표)</td></tr></table><div>다 <img src="x"> 라</div>'), { lines: ['가', '나', '다', '[[그림]]', '라'], tables: 1 });
    assert.deepEqual(dropUnreadArticles('머리말\n### 제1조(목적) 본문\n### 제2조(그림)\n[[그림]]\n## 부칙\n시행한다.'), { markdown: '머리말\n### 제1조(목적) 본문\n## 부칙\n시행한다.', unread: [{ article: '제2조(그림)', reason: 'image_only' }], imagesOmitted: 0 });
  });

  await check('I3 skku-unordered-confirmation-with-unread-page: 재확인도 쪽·정렬을 검증', async () => {
    const exact = encodeURIComponent('직원 복무규정');
    const routes = (lastOffset, secondPage) => [
      ['mode=download', PDF],
      [`srSearchKey=article_title&srSearchVal=${exact}`, target => skkuPage(/offset=10$/.test(target) ? secondPage : [['직원 복무규정', '2023.01.01', 8, 80], ['직원 복무규정', '2024.01.01', 9, 90]], lastOffset)],
      ['srSearchKey=article_text', skkuPage([['직원 복무규정', '2024.01.01', 9, 90]])],
      ['srSearchKey=article_title', skkuPage([], 0, true)],
    ];
    const titleCalls = run => run.calls.filter(call => call.target.includes(`srSearchVal=${exact}`)).map(call => /offset=(\d+)$/.exec(call.target)[1]);
    const downloads = run => run.calls.filter(call => call.target.includes('mode=download')).map(call => /articleNo=(\d+)/.exec(call.target)[1]);
    // 레드팀 반례 그대로: 첫 쪽이 최신순이 아니고 다음 쪽(offset 10)에 최신본이 있다 → 다음 쪽까지 읽어 최신본을 고른다.
    const found = await compare(['skku'], routes(10, [['직원 복무규정', '2026.11.01', 11, 110]]));
    assert.deepEqual([titleCalls(found), downloads(found)], [['0', '10'], ['11']], '옛 개정본(9)을 내려받지 않음');
    assert.deepEqual([found.column.articles[0].revisedAt, found.column.coverage.currentRevisionConfirmedByTitle, found.column.coverage.searchPagesTruncated, found.column.failures], ['2026.11.01', true, false, []]);
    // 읽지 못한 쪽이 남으면 확인 완료로 올리지 않고, 미확인 사유와 잘림을 남긴 채 아무것도 내려받지 않는다.
    const unread = await compare(['skku'], routes(30, [['직원 복무규정', '2025.01.01', 10, 100]]));
    assert.deepEqual([titleCalls(unread), downloads(unread)], [['0', '10'], []]);
    assert.deepEqual(unread.column.failures, [{ lawId: 9, code: 'PDF_REVISION_UNVERIFIED', stage: 'revision_confirmation', title: '직원 복무규정', reason: 'CONFIRMATION_PAGES_UNREAD' }]);
    assert.deepEqual([unread.column.status, unread.column.articles.length, unread.column.coverage.currentRevisionConfirmedByTitle, unread.column.coverage.currentRevisionUnverified, unread.column.coverage.searchPagesTruncated, unread.column.coverage.confirmationPagesTruncated, unread.column.coverage.truncated],
      ['unavailable', 0, false, 1, true, true, true]);
    assert.match(unread.text, /현행 개정본을 확인하지 못해 조회하지 않은 규정 1건 — 직원 복무규정\(검색 결과가 조회 상한을 넘음\)/);
    // 최신순이 확인되는 첫 쪽에서는 한 쪽만 읽고 끝낸다(뒤 쪽은 더 오래된 개정본).
    const ordered = await compare(['skku'], [['mode=download', PDF], [`srSearchKey=article_title&srSearchVal=${exact}`, skkuPage([['직원 복무규정', '2026.11.01', 11, 110], ['직원 복무규정', '2024.01.01', 9, 90]], 30)], ['srSearchKey=article_text', skkuPage([['직원 복무규정', '2024.01.01', 9, 90]])], ['srSearchKey=article_title', skkuPage([], 0, true)]]);
    assert.deepEqual([titleCalls(ordered), downloads(ordered), ordered.column.coverage.currentRevisionConfirmedByTitle], [['0'], ['11'], true]);
  });

  await check('I3 잔여 skku-second-confirmation-page-malformed: 한 후보라도 재확인이 끝나지 않으면 확인 완료가 아님', async () => {
    const first = encodeURIComponent('직원 복무규정'), second = encodeURIComponent('교직원 복무규정'), third = encodeURIComponent('연구원 복무규정');
    const content = rows => [['srSearchKey=article_text', skkuPage(rows)], ['srSearchKey=article_title', skkuPage([], 0, true)]];
    const two = [['직원 복무규정', '2024.01.01', 9, 90], ['교직원 복무규정', '2024.01.01', 19, 190]];
    const firstOk = [`srSearchKey=article_title&srSearchVal=${first}`, skkuPage([['직원 복무규정', '2026.11.01', 11, 110]])];
    const downloads = run => run.calls.filter(call => call.target.includes('mode=download')).map(call => /articleNo=(\d+)/.exec(call.target)[1]);
    // 레드팀 반례 그대로: 첫 후보는 확인·추출 성공, 둘째 후보의 재확인 2쪽이 목록이 아니다.
    const malformed = await compare(['skku'], [['mode=download', PDF], firstOk,
      [`srSearchKey=article_title&srSearchVal=${second}`, target => /offset=10$/.test(target) ? '<html>changed format</html>' : skkuPage([['교직원 복무규정', '2023.01.01', 18, 180], ['교직원 복무규정', '2024.01.01', 19, 190]], 10)],
      ...content(two)]);
    assert.deepEqual([malformed.column.status, downloads(malformed), [...new Set(malformed.column.articles.map(a => a.universityRule))]], ['partial', ['11'], ['직원 복무규정']], '확인하지 못한 규정은 내려받지 않음');
    assert.deepEqual(malformed.column.failures, [{ lawId: 19, code: 'UPSTREAM_FORMAT_CHANGED', stage: 'revision_confirmation', title: '교직원 복무규정', reason: 'CONFIRMATION_REQUEST_FAILED' }], '원래 실패 코드와 재확인 미완료 사유를 함께 남김');
    assert.deepEqual([malformed.column.coverage.currentRevisionConfirmedByTitle, malformed.column.coverage.currentRevisionUnverified, malformed.column.coverage.attemptedRules, malformed.column.coverage.scannedRules], [false, 1, 2, 1]);
    assert.match(malformed.text, /현행 개정본을 확인하지 못해 조회하지 않은 규정 1건 — 교직원 복무규정\(재확인 요청 실패: UPSTREAM_FORMAT_CHANGED\)/);
    // 두 후보 모두 확인되면 완료다(대조군).
    const both = await compare(['skku'], [['mode=download', PDF], firstOk, [`srSearchKey=article_title&srSearchVal=${second}`, skkuPage([['교직원 복무규정', '2025.03.01', 20, 200]])], ...content(two)]);
    assert.deepEqual([both.column.coverage.currentRevisionConfirmedByTitle, both.column.coverage.currentRevisionUnverified, downloads(both), both.column.failures], [true, undefined, ['11', '20'], []]);
    // 확인은 됐지만 문서 추출이 실패한 것은 재확인 실패가 아니다: 확인 완료는 유지하고 단계를 구분해 남긴다.
    const extraction = await compare(['skku'], [[/mode=download&articleNo=20&/, Buffer.from('%PDF-1.4 damaged')], ['mode=download', PDF], firstOk,
      [`srSearchKey=article_title&srSearchVal=${second}`, skkuPage([['교직원 복무규정', '2025.03.01', 20, 200]])], ...content(two)]);
    assert.deepEqual(extraction.column.failures, [{ lawId: 20, code: 'PDF_PARSE_FAILED', stage: 'document', title: '교직원 복무규정' }]);
    assert.deepEqual([extraction.column.coverage.currentRevisionConfirmedByTitle, extraction.column.coverage.currentRevisionUnverified], [true, undefined]);
    assert.doesNotMatch(extraction.text, /현행 개정본을 확인하지 못해/);
    // 전송 실패로 조회가 중단되면, 실패한 후보와 시도하지 못한 후보 모두 미확인으로 센다.
    const three = [...two, ['연구원 복무규정', '2024.01.01', 29, 290]];
    const stopped = await compare(['skku'], [['mode=download', PDF], firstOk, [`srSearchKey=article_title&srSearchVal=${second}`, { status: 503 }],
      [`srSearchKey=article_title&srSearchVal=${third}`, skkuPage([['연구원 복무규정', '2026.01.01', 30, 300]])], ...content(three)]);
    assert.deepEqual(stopped.column.failures, [{ lawId: 19, code: 'UPSTREAM_UNAVAILABLE', stage: 'revision_confirmation', title: '교직원 복무규정', reason: 'CONFIRMATION_REQUEST_FAILED' }]);
    assert.deepEqual([stopped.column.coverage.currentRevisionConfirmedByTitle, stopped.column.coverage.currentRevisionUnverified, downloads(stopped)], [false, 2, ['11']]);
    assert(!stopped.calls.some(call => call.target.includes(`srSearchVal=${third}`)), '중단 뒤 후보는 요청하지 않음');
    assert.match(stopped.text, /조회가 중단되어 현행 개정본 확인을 시도하지 못한 규정 1건/);
    // 취소된 조회도 확인 완료가 아니다.
    const aborted = new AbortController();
    const cancelNet = network([['mode=download', PDF], firstOk, [`srSearchKey=article_title&srSearchVal=${second}`, () => { aborted.abort(); return skkuPage([['교직원 복무규정', '2025.03.01', 20, 200]]); }], ...content(three)]);
    const cancelled = await loadExternal(source('skku'), '여비', spec.terms, cancelNet.client, aborted.signal, spec, { now: NOW }).catch(e => ({ thrown: e.code }));
    if (!cancelled.thrown) assert.deepEqual([cancelled.coverage.currentRevisionConfirmedByTitle, cancelled.coverage.currentRevisionUnverified > 0], [false, true]);
    else assert.equal(cancelled.thrown, 'TOTAL_TIMEOUT');
    // 제목 검색으로 정해진 후보는 재확인 대상이 아니므로 단계 표시를 붙이지 않는다.
    const titleOnly = await load('skku', network([['mode=download', Buffer.from('%PDF-1.4 damaged')], ['mode=list', skkuPage([['여비 규정', '2026.03.01', 2, 20]])]]).client);
    assert.deepEqual([titleOnly.failures, titleOnly.coverage.currentRevisionConfirmedByTitle, titleOnly.coverage.currentRevisionUnverified], [[{ lawId: 2, code: 'PDF_PARSE_FAILED' }], false, undefined]);
  });

  await check('R1: 캐시 한도는 글자 수가 아니라 바이트 기준', async () => {
    const korean = '한'.repeat(800000);
    assert(korean.length < 2 * MIB && Buffer.byteLength(korean) > 2 * MIB);
    const multibyte = network([[/./, korean]]);
    for (let i = 0; i < 2; i++) await multibyte.client.request(source('sejong'), '/kor/intro/regulation-overview.do');
    assert.equal(multibyte.calls.length, 2, '2 MiB를 넘는 한글 응답은 캐시에 두지 않음');
    const small = network([[/./, '한'.repeat(600000)]]);
    for (let i = 0; i < 2; i++) await small.client.request(source('sejong'), '/kor/intro/regulation-overview.do');
    assert.equal(small.calls.length, 1, '2 MiB 이하 응답은 캐시에서 재사용');
  });

  await check('비교 결과: 열 상태·문서 안내·원문 링크·시행 예정 표시', async () => {
    const routes = [
      ['srCategoryId=145', hongikRule], ['srCategoryId=146', hongikRule], ['/kr/introduction/regulations-book.do', hongikTree()],
      ['findGyujeongSearch1HYU', hanyangSearch], ['findGyujeongMView', hanyangView],
      ['mode=download', PDF], ['mode=list', skkuPage([['여비 규정', '2027.03.01', 3, 30], ['여비 규정', '2026.03.01', 2, 20]])],
      [/\/191\/download$/, PDF], [/download$/, PDF], ['listOperation', gachonList],
    ];
    const data = await compareUniversityRules({ topic: '여비', universities: ['hongik', 'hanyang', 'skku', 'gachon', 'kaist'], max_articles: 2 }, { client: network(routes).client, loadDongguk: dongguk });
    const column = key => data.columns.find(c => c.university === key);
    assert.deepEqual(['hongik', 'hanyang', 'skku', 'gachon', 'kaist'].map(key => column(key).status), ['partial', 'partial', 'partial', 'partial', 'unsupported']);
    assert.deepEqual([column('hongik').name, column('hanyang').name, column('skku').name, column('gachon').name], ['홍익대학교', '한양대학교', '성균관대학교', '가천대학교']);
    assert(data.notice.includes(DOCUMENT_NOTICE));
    assert.deepEqual([column('skku').articles[0].originalPdfUrl, column('skku').articles[0].upcomingRevisionAt, column('skku').articles[0].sourceType], ['https://www.skku.edu/state/current/current_rulebook.do?mode=download&articleNo=2&attachNo=20', '2027-03-01', 'PDF 텍스트 레이어']);
    assert.equal(column('hongik').articles[0].originalPdfUrl, undefined);
    for (const key of ['hongik', 'hanyang', 'skku', 'sejong', 'gachon']) assert(data.supportedUniversities.some(x => x.key === key && x.scope === 'adapter'));
    const text = formatComparison(data);
    assert.match(text, /\[PDF 원문\]\(https:\/\/www\.skku\.edu\/state\/current\/current_rulebook\.do\?mode=download&articleNo=2&attachNo=20\)/);
    assert.match(text, /시행 예정 개정본이 있습니다\(2027-03-01\)/);
    const plain = await compareUniversityRules({ topic: '여비', universities: ['hongik', 'hanyang'] }, { client: network(routes).client, loadDongguk: dongguk });
    assert(!plain.notice.includes(DOCUMENT_NOTICE), 'HTML·JSON 대학만 고르면 문서 안내를 붙이지 않음');
  });

  console.log(`📊 타대학 어댑터(홍익·한양·성균관·세종·가천) 검증: ${passed}개 통과`);
}
main().catch(e => { console.error('❌', e); process.exit(1); });

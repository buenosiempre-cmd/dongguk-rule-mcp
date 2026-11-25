'use strict';
// 타대학 비교 어댑터(4단계): 홍익·한양은 공개 HTML/JSON 조문, 성균관·세종·가천은 공개 문서
// (PDF 텍스트 레이어, 가천은 한글 파일 포함)의 조문만 읽는다. 로그인·쿠키는 쓰지 않는다.
const cheerio = require('cheerio');
const { listArticleBlocks } = require('./parsers');
const { extractPdfText } = require('./pdf-text');
const { articleMarkdown, isAppendixHeading } = require('./cau-pdf');

const error = code => Object.assign(new Error(code), { code });
const compact = s => String(s ?? '').replace(/\s+/g, '');
const uniq = xs => [...new Set(xs.filter(Boolean))];
const stripTags = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
const STOP = ['ACCESS_DENIED', 'SESSION_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'REDIRECT_NOT_FOLLOWED', 'TOTAL_TIMEOUT', 'PDF_PARSE_BUSY'];
const DOCUMENT_NOTICE = '성균관·세종·가천은 공개 문서(PDF의 텍스트 레이어, 가천은 한글 파일 포함)에서 조문만 비교합니다. 표의 셀·병합·금액 대응과 별표·별지·서식·그림은 비교하지 않으며, 별표 이후를 제외한 경우 시행일도 미확인입니다. 관련 금액·조건은 연결된 원문 파일에서 확인하세요. PDF의 줄바꿈·읽기 순서가 원본 배치와 다를 수 있고 OCR은 수행하지 않습니다.';
const DOCUMENT_COVERAGE = { complete: false, comparisonScope: 'articles_only', appendicesCompared: false, notice: DOCUMENT_NOTICE };

const dotDate = (y, m, d) => `${y}.${String(+m).padStart(2, '0')}.${String(+d).padStart(2, '0')}`;
const isoDate = (y, m, d) => `${y}-${String(+m).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
const realDate = (y, m, d) => { const t = new Date(Date.UTC(+y, +m - 1, +d)); return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d; };
const todayKst = now => new Date(now()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

// PDF 본문 → 조문 markdown. 독립 별표 표제 뒤는 조문 비교에서 빠지므로, 그 뒤에 있을 수 있는
// 최신 부칙의 시행일을 앞쪽 날짜로 대신하지 않는다(tailExcluded면 시행일 미확인).
async function pdfArticles(buffer, signal, extractPdf) {
  const extracted = await extractPdf(buffer, { signal });
  const markdown = articleMarkdown(extracted.text);
  if (!listArticleBlocks(markdown).length) throw error('PDF_NO_ARTICLES');
  return { markdown, tailExcluded: extracted.text.split(/\r?\n/).some(line => isAppendixHeading(line.replace(/[\t ]+/g, ' ').trim())) };
}

// HTML 조각 → 줄 단위 텍스트. 표는 조문 비교 범위 밖이라 통째로 버린다(표 셀의 "제99조(…)" 같은
// 문자열이 조문으로 읽히지 않게). 그림은 표식 줄로 남겨, 글자 없이 그림뿐인 조문을 가려낸다.
const IMAGE_MARK = '[[그림]]';
function htmlLines(html) {
  const $ = cheerio.load(`<div id="rule-fragment">${html || ''}</div>`), root = $('#rule-fragment');
  const tables = root.find('table').length;
  root.find('table, script, style').remove();
  root.find('img').replaceWith(`<p>${IMAGE_MARK}</p>`);
  root.find('br').replaceWith('\n');
  root.find('p, div, li, tr, h1, h2, h3, h4, h5, h6').each((_, node) => { $(node).append('\n'); $(node).prepend('\n'); });
  const lines = root.text().replace(/ /g, ' ').split('\n').map(line => line.replace(/[\t ]+/g, ' ').trim()).filter(Boolean);
  return { lines, tables };
}
// "제N조(제목)" 뒤에 같은 줄 본문이 있는가. "제5조 삭제 <2020.1.1.>"처럼 제목 괄호가 없는 줄도 본문이다.
function headingHasBody(heading) {
  const start = /^제\s*\d+\s*조(?:\s*의\s*\d+)?\s*/.exec(heading);
  if (!start) return true;
  const rest = heading.slice(start[0].length);
  if (!'(（'.includes(rest[0] || ' ')) return rest.trim().length > 0;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if ('(（'.includes(rest[i])) depth++;
    if (')）'.includes(rest[i]) && --depth === 0) return rest.slice(i + 1).trim().length > 0;
  }
  return false;
}
// 제목만 있고 읽은 본문이 없는 조문(그림뿐이거나 비어 있음)은 비교 조문에서 빼고 따로 알린다.
// 제목만으로는 그 조문이 무엇을 정하는지 확인한 것이 아니다.
function dropUnreadArticles(markdown) {
  const lines = String(markdown).split('\n'), out = [], unread = [];
  let imagesOmitted = 0;
  for (let i = 0; i < lines.length;) {
    if (!lines[i].startsWith('### ')) { if (lines[i] === IMAGE_MARK) imagesOmitted++; else out.push(lines[i]); i++; continue; }
    let end = i + 1;
    while (end < lines.length && !/^#{2,3} /.test(lines[end])) end++;
    const body = lines.slice(i + 1, end), text = body.filter(line => line !== IMAGE_MARK), marks = body.length - text.length;
    const heading = lines[i].slice(4);
    if (!text.length && !headingHasBody(heading)) unread.push({ article: heading, reason: marks ? 'image_only' : 'empty' });
    else { out.push(lines[i], ...text); imagesOmitted += marks; }
    i = end;
  }
  return { markdown: out.join('\n'), unread, imagesOmitted };
}
const unreadFailures = (lawId, unread) => unread.map(item => ({ lawId, code: 'ARTICLE_TEXT_UNAVAILABLE', article: item.article, reason: item.reason }));
// 괄호·공백이 달라도 같은 부속 묶음 이름이다: "별표", "〔별표 1〕", "[ 서 식 2 ]".
const isAppendixLabel = text => /^(?:별표|별지|별첨|부록|붙임|서식)/.test(compact(text).replace(/^[\[(〔【<〈《（［]+/, ''));
const HTML_COVERAGE = { comparisonScope: 'articles_only', appendicesCompared: false, tablesCompared: false, complete: false };

// ── 홍익대: 규정집 페이지의 규정 트리(전체 제목) + 규정별 페이지의 .fr-view 조문 HTML ──
const HONGIK_PATH = '/kr/introduction/regulations-book.do';
function parseHongikTree(html) {
  const $ = cheerio.load(html), seen = new Set(), items = [];
  $('ul.b-regulation-part a[data-category-id]').each((_, node) => {
    const a = $(node), id = String(a.attr('data-category-id') || '');
    // 하위 분류가 있는 항목은 편·장 제목이다. 규정은 말단 항목뿐이다.
    if (!/^\d+$/.test(id) || a.attr('data-has-child') === 'true' || a.next('ul').length || seen.has(id)) return;
    const title = a.text().replace(/\s+/g, ' ').trim().replace(/^\d+(?:-\d+)?\)\s*/, '');
    if (!title) return;
    seen.add(id); items.push({ id, title });
  });
  return items;
}
async function loadHongik(source, topic, terms, client, signal, spec, { rankByTitle, maxRules, latestAddendaEffective, ruleRevisedAt, safeCode }) {
  const items = parseHongikTree(await client.request(source, HONGIK_PATH, undefined, 15000, signal));
  if (items.length < 20) throw error('UPSTREAM_FORMAT_CHANGED');
  const ranked = rankByTitle(items, topic, terms, spec.titleHints || terms), rules = [], failures = [];
  for (const hit of ranked.slice(0, maxRules)) {
    const path = `${HONGIK_PATH}?mode=list&srCategoryId=${hit.id}&srSearchKey=&srSearchVal=`, lawId = Number(hit.id);
    try {
      if (signal?.aborted) throw error('TOTAL_TIMEOUT');
      const { lines, tables } = htmlLines(cheerio.load(await client.request(source, path, undefined, 15000, signal))('.b-content-box .fr-view').html() || '');
      // 독립 별표 표제 뒤는 조문 비교에서 빠진다(본문 속 "별표1에 따라" 같은 참조는 표제가 아니다).
      // HTML은 전체 줄을 알고 있으므로, 잘라낸 뒤쪽에 부칙이 있을 때만 시행일을 미확인으로 둔다.
      const cut = lines.findIndex(line => isAppendixHeading(line));
      const tailExcluded = cut >= 0 && lines.slice(cut + 1).some(line => /^부\s*칙(?=[\s(（<\[]|$)/.test(line));
      const { markdown, unread, imagesOmitted } = dropUnreadArticles(articleMarkdown(lines.join('\n')));
      failures.push(...unreadFailures(lawId, unread));
      if (!listArticleBlocks(markdown).length) {
        // 읽은 조문이 없다: 그림뿐인 조문은 위에 조문별로 남겼고, 별표뿐이면 비교 범위에 조문이 없는 것이다.
        if (unread.length) continue;
        throw error(cut >= 0 || tables ? 'ARTICLE_TEXT_UNAVAILABLE' : 'UPSTREAM_FORMAT_CHANGED');
      }
      const effectiveAt = tailExcluded ? null : latestAddendaEffective(markdown);
      rules.push({ title: hit.title, lawId, historyId: 0, markdown, url: source.origin + path,
        revisedAt: ruleRevisedAt(markdown), effectiveAt: effectiveAt || null, effectiveSource: effectiveAt ? 'addenda' : null,
        ...(unread.length ? { unreadArticles: unread } : {}), ...(tables ? { tablesOmitted: tables } : {}), ...(imagesOmitted ? { imagesOmitted } : {}) });
    } catch (e) { const code = safeCode(e); failures.push({ lawId, code }); if (STOP.includes(code)) break; }
  }
  return { rules, failures, coverage: { mode: 'html_catalog', totalCandidates: items.length, titleMatches: ranked.length, truncated: ranked.length > maxRules, ...HTML_COVERAGE } };
}

// ── 한양대: 규정집 화면이 쓰는 공개 JSON(규정명 검색 → 조문 목록). 본문은 조문별 HTML 조각 ──
// 응답에는 등록자·IP 같은 관리 필드가 섞여 있다. 규정명·조문·날짜만 읽고 나머지는 버린다.
const HANYANG_SEARCH = '/huas/iycy/findGyujeongSearch1HYU.do?searchStr=';
const HANYANG_VIEW = '/huas/iycy/findGyujeongMView.do?strGyujeongCd=';
function hanyangRows(raw, key) {
  let rows;
  try { rows = JSON.parse(raw)?.[key]?.[0]?.list; } catch { throw error('UPSTREAM_FORMAT_CHANGED'); }
  if (!Array.isArray(rows)) throw error('UPSTREAM_FORMAT_CHANGED');
  return rows;
}
function hanyangMarkdown(rows) {
  const shown = rows.filter(r => r && r.pyosiYn === '1' && !r.pyejiDt);
  const sections = new Map(shown.filter(r => r.itemLevel === 2).map(r => [r.itemCd, stripTags(r.itemNm)]));
  const out = [];
  let current = null, tables = 0, tailExcluded = false;
  for (const row of shown.filter(r => r.itemLevel === 3)) {
    const section = sections.get(row.parentItemCd) || '', name = stripTags(row.itemNm);
    // 별표·서식 묶음과 그 항목은 조문 비교 범위 밖이다. 묶음 이름이 "〔별표 1〕"처럼 괄호로 싸여 있어도 같다.
    if (isAppendixLabel(section) || isAppendixLabel(name)) { tailExcluded = true; continue; }
    if (section !== current) { current = section; if (/^부\s*칙/.test(section)) out.push('## 부칙'); }
    const body = htmlLines(row.itemNaeyong), cut = body.lines.findIndex(line => isAppendixHeading(line));
    tables += body.tables;
    if (cut >= 0) tailExcluded = true;
    const text = cut >= 0 ? body.lines.slice(0, cut) : body.lines;
    if (/^제\s*\d+\s*조/.test(name)) out.push(`### ${name}`, ...text);
    else if (/^부\s*칙/.test(name)) out.push(`## ${name.replace(/^부\s*칙\s*/, '부칙 ')}`, ...text);
    else if (/^제\s*\d+\s*(?:장|절)/.test(name)) out.push(`## ${name}`, ...text);
    else out.push(name, ...text);
  }
  return { ...dropUnreadArticles(out.filter(Boolean).join('\n')), tables, tailExcluded };
}
async function loadHanyang(source, topic, terms, client, signal, spec, { rankByTitle, maxRules, latestAddendaEffective, safeCode }) {
  const hints = spec.titleHints || terms;
  const queries = uniq([...(spec.searchTerms || []), ...hints, ...terms]).slice(0, 4), byCode = new Map();
  let anyOk = false, firstError = null;
  for (const query of queries) {
    try {
      // 화면과 같은 이중 인코딩. 본문은 빈 JSON이다.
      const rows = hanyangRows(await client.request(source, HANYANG_SEARCH + encodeURIComponent(encodeURIComponent(query)), '{}', 15000, signal), 'DS_SEARCH');
      anyOk = true;
      for (const row of rows) {
        const code = String(row?.gyujeongCd ?? ''), title = stripTags(row?.gyujeongNm);
        if (/^\d{1,6}$/.test(code) && title && !byCode.has(code)) byCode.set(code, { code, title, revised: /^\d{8}$/.test(row.gaejeongDt || '') ? row.gaejeongDt : /^\d{8}$/.test(row.jejeongDt || '') ? row.jejeongDt : null });
      }
    } catch (e) { firstError = firstError || e; if (STOP.includes(safeCode(e))) throw e; }
  }
  if (!anyOk) throw firstError || error('UPSTREAM_FORMAT_CHANGED');
  const ranked = rankByTitle([...byCode.values()], topic, terms, hints), rules = [], failures = [];
  for (const hit of ranked.slice(0, maxRules)) {
    try {
      if (signal?.aborted) throw error('TOTAL_TIMEOUT');
      const rows = hanyangRows(await client.request(source, `${HANYANG_VIEW}${hit.code}&searchStr=`, '{}', 15000, signal), 'DS_SMGHGJ02TTM01');
      const { markdown, unread, imagesOmitted, tables, tailExcluded } = hanyangMarkdown(rows);
      failures.push(...unreadFailures(Number(hit.code), unread));
      if (!listArticleBlocks(markdown).length) {
        if (unread.length) continue;
        throw error(tailExcluded || tables ? 'ARTICLE_TEXT_UNAVAILABLE' : 'UPSTREAM_FORMAT_CHANGED');
      }
      const effectiveAt = latestAddendaEffective(markdown);
      rules.push({ title: hit.title, lawId: Number(hit.code), historyId: hit.revised ? Number(hit.revised) : 0, markdown,
        ...(unread.length ? { unreadArticles: unread } : {}), ...(tables ? { tablesOmitted: tables } : {}), ...(imagesOmitted ? { imagesOmitted } : {}),
        url: `${source.origin}/huas/iycy/ruleBook.do`, revisedAt: hit.revised ? dotDate(hit.revised.slice(0, 4), hit.revised.slice(4, 6), hit.revised.slice(6, 8)) : null,
        effectiveAt: effectiveAt || null, effectiveSource: effectiveAt ? 'addenda' : null });
    } catch (e) { const code = safeCode(e); failures.push({ lawId: Number(hit.code), code }); if (STOP.includes(code)) break; }
  }
  return { rules, failures, coverage: { mode: 'rest_json', queries, totalCandidates: byCode.size, titleMatches: ranked.length, truncated: ranked.length > maxRules, ...HTML_COVERAGE } };
}

// ── 성균관대: 규정집 게시판(개정본마다 한 줄) 제목 검색 → 규정 PDF. 검색 결과는 10건씩이다 ──
const SKKU_PATH = '/state/current/current_rulebook.do';
const SKKU_PAGES = 2;
function parseSkkuRows(html) {
  const $ = cheerio.load(html), rows = [];
  $('table tbody tr').each((_, tr) => {
    const cells = $(tr).children('td');
    if (cells.length < 4) return;
    const title = cells.eq(1).text().replace(/\s+/g, ' ').trim();
    const date = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(cells.eq(2).text().trim());
    const link = /[?&]mode=download&(?:amp;)?articleNo=(\d+)&(?:amp;)?attachNo=(\d+)/.exec(cells.eq(3).find('a').attr('href') || '');
    if (!title || !date || !realDate(date[1], date[2], date[3]) || !link) return;
    rows.push({ title, date: isoDate(date[1], date[2], date[3]), articleNo: link[1], attachNo: link[2] });
  });
  const offsets = [...html.matchAll(/article\.offset=(\d+)/g)].map(m => +m[1]);
  // 게시판은 제·개정일 내림차순으로 준다. 그 순서가 깨지면 첫 줄을 최신본으로 볼 수 없다.
  const newestFirst = rows.every((row, i) => i === 0 || rows[i - 1].date >= row.date);
  return { rows, lastOffset: offsets.length ? Math.max(...offsets) : 0, empty: /등록된 글이 없/.test(html), newestFirst };
}
// 같은 규정의 개정본 중 오늘 이전 가장 늦은 줄을 현행으로 본다. 시행 예정본은 따로 알린다.
function currentSkkuRules(rows, today) {
  const byTitle = new Map();
  for (const row of rows) {
    const key = compact(row.title), entry = byTitle.get(key) || { title: row.title, current: null, upcoming: null };
    if (row.date <= today) { if (!entry.current || row.date > entry.current.date) { entry.current = row; entry.title = row.title; } }
    else if (!entry.upcoming || row.date < entry.upcoming.date) entry.upcoming = row;
    byTitle.set(key, entry);
  }
  return [...byTitle.values()].filter(x => x.current).map(x => ({ ...x.current, title: x.title, upcomingAt: x.upcoming?.date || null }));
}
async function loadSkku(source, topic, terms, client, signal, spec, { rankByTitle, maxRules, latestAddendaEffective, safeCode, extractPdf = extractPdfText, now = Date.now }) {
  const hints = spec.titleHints || terms;
  const queries = uniq([...(spec.searchTerms || []), ...hints, ...terms]).slice(0, 3), rows = [];
  let anyOk = false, firstError = null, pagesTruncated = false, newestFirst = true;
  const search = async (key, query) => {
    const pageRows = [];
    for (let page = 0; page < SKKU_PAGES; page++) {
      const parsed = parseSkkuRows(await client.request(source, `${SKKU_PATH}?mode=list&srSearchKey=${key}&srSearchVal=${encodeURIComponent(query)}&articleLimit=10&article.offset=${page * 10}`, undefined, 15000, signal));
      if (!parsed.rows.length && !parsed.empty) throw error('UPSTREAM_FORMAT_CHANGED');
      // 쪽 안에서도, 앞쪽의 마지막 줄과 이 쪽의 첫 줄 사이에서도 최신순이어야 한다.
      const previous = page ? pageRows[pageRows.length - 1] : null;
      if (!parsed.newestFirst || (previous && parsed.rows[0] && previous.date < parsed.rows[0].date)) newestFirst = false;
      pageRows.push(...parsed.rows);
      rows.push(...parsed.rows.map(row => ({ ...row, channel: key })));
      if (parsed.lastOffset <= page * 10) return;
      if (page === SKKU_PAGES - 1) pagesTruncated = true;
    }
  };
  for (const query of queries) {
    try { await search('article_title', query); anyOk = true; }
    catch (e) { firstError = firstError || e; if (STOP.includes(safeCode(e))) throw e; }
  }
  if (!anyOk) throw firstError || error('UPSTREAM_FORMAT_CHANGED');
  let candidates = rankByTitle(currentSkkuRules(rows, todayKst(now)), topic, terms, hints), channel = 'title';
  if (!candidates.length) {
    // 제목에 주제어가 없는 사안(여비 → 직원 복무규정)은 본문 검색 한 번으로 후보를 찾는다.
    rows.length = 0; channel = 'content';
    await search('article_text', queries[0]);
    candidates = currentSkkuRules(rows, todayKst(now));
  }
  // 본문 검색은 그 단어가 든 개정본만 돌려주므로 최신본이 빠질 수 있다(2026-11-25 직원 복무규정에서 확인).
  // 본문 검색 후보와, 정렬 순서를 확인하지 못한 제목 검색 후보는 규정명으로 다시 찾아 현행본을 정한다.
  const confirmCurrent = channel === 'content' || !newestFirst;
  const today = todayKst(now), rules = [], failures = [];
  let confirmed = 0, confirmationTruncated = false;
  // 규정명 재검색도 같은 쪽 수 상한과 정렬 검증을 받는다. 최신순이면 처음 만난 오늘 이전 줄이 현행본이고,
  // 최신순이 아니면 모든 쪽을 읽었을 때만 가장 늦은 줄을 현행본으로 본다. 읽지 못한 쪽이 남으면 확인 불가다.
  const confirm = async title => {
    const seen = [];
    for (let page = 0; page < SKKU_PAGES; page++) {
      const parsed = parseSkkuRows(await client.request(source, `${SKKU_PATH}?mode=list&srSearchKey=article_title&srSearchVal=${encodeURIComponent(title)}&articleLimit=10&article.offset=${page * 10}`, undefined, 15000, signal));
      if (!parsed.rows.length && !parsed.empty) throw error('UPSTREAM_FORMAT_CHANGED');
      seen.push(...parsed.rows);
      const ordered = seen.every((row, i) => i === 0 || seen[i - 1].date >= row.date);
      const same = currentSkkuRules(seen.filter(row => compact(row.title) === compact(title)), today)[0];
      const more = parsed.lastOffset > page * 10;
      if (same && (ordered || !more)) return same;
      if (!more) throw Object.assign(error('PDF_REVISION_UNVERIFIED'), { reason: 'TITLE_NOT_FOUND' });
    }
    confirmationTruncated = true;
    throw Object.assign(error('PDF_REVISION_UNVERIFIED'), { reason: 'CONFIRMATION_PAGES_UNREAD' });
  };
  // 재확인이 필요한 후보는 조회 대상 전부다. 어떤 이유로든(확인 불가·형식 오류·전송 실패·취소·중단으로
  // 시도하지 못함) 재확인이 끝나지 않은 후보가 하나라도 있으면 확인 완료가 아니다.
  const selected = candidates.slice(0, maxRules), required = confirmCurrent ? selected.length : 0;
  for (let hit of selected) {
    // 재확인 단계의 실패와, 현행본을 확인한 뒤 문서를 읽다가 난 실패를 구분한다.
    let stage = confirmCurrent ? 'revision_confirmation' : 'document';
    const candidate = hit;
    try {
      if (signal?.aborted) throw error('TOTAL_TIMEOUT');
      if (confirmCurrent) { hit = await confirm(hit.title); confirmed++; stage = 'document'; }
      const path = `${SKKU_PATH}?mode=download&articleNo=${hit.articleNo}&attachNo=${hit.attachNo}`;
      const { markdown, tailExcluded } = await pdfArticles(await client.request(source, path, undefined, 20000, signal, { binary: true }), signal, extractPdf);
      const effectiveAt = tailExcluded ? null : latestAddendaEffective(markdown);
      rules.push({ title: hit.title, lawId: Number(hit.articleNo), historyId: Number(hit.date.replace(/-/g, '')), markdown,
        url: `${source.origin}${SKKU_PATH}?mode=view&articleNo=${hit.articleNo}`, originalPdfUrl: source.origin + path, sourceType: 'PDF 텍스트 레이어',
        revisedAt: hit.date.replace(/-/g, '.'), effectiveAt, effectiveSource: effectiveAt ? 'addenda' : null, ...(hit.upcomingAt ? { upcomingRevisionAt: hit.upcomingAt } : {}) });
    } catch (e) {
      const code = safeCode(e);
      // 원래 실패 코드는 그대로 두고, 재확인 단계였다면 미완료 사유를 함께 남긴다.
      failures.push({ lawId: Number(hit.articleNo), code, ...(confirmCurrent ? { stage, title: candidate.title } : {}),
        ...(stage === 'revision_confirmation' ? { reason: e?.reason || 'CONFIRMATION_REQUEST_FAILED' } : {}) });
      if (STOP.includes(code)) break;
    }
  }
  // 확인 완료는 재확인이 필요했던 후보를 모두 확인했을 때만이다. 실패 종류는 묻지 않는다.
  const unverified = required - confirmed;
  return { rules, failures, coverage: { mode: 'board_pdf', currentRevisionConfirmedByTitle: required > 0 && unverified === 0,
    ...(unverified ? { currentRevisionUnverified: unverified } : {}), channel, queries, totalCandidates: candidates.length, titleMatches: candidates.length,
    truncated: candidates.length > maxRules || pagesTruncated || confirmationTruncated, searchPagesTruncated: pagesTruncated || confirmationTruncated,
    ...(confirmationTruncated ? { confirmationPagesTruncated: true } : {}), textLayerOnly: true, ...DOCUMENT_COVERAGE } };
}

// ── 세종대: 규정집 한 페이지에 현행 규정 전체(제목과 시행일) + 규정별 PDF ──
// 목록 페이지가 약 5MB라 소스 설정(maxTextBytes)으로만 받고, 파싱한 목록을 10분 동안 재사용한다.
const SEJONG_LIST = '/kor/intro/regulation-overview.do';
const SEJONG_TTL_MS = 600000;
const sejongLists = new WeakMap();
function parseSejongList(html) {
  const items = [], seen = new Set();
  // 링크의 속성 순서는 행마다 다르다. 문서 번호는 링크 주소의 것이다(data-category-id와 다를 수 있다).
  const row = /<td>\s*([^<]{2,200}?)\s*<\/td>\s*<td>\s*<div[^>]*>\s*<ul>\s*<li>\s*<a\b[^>]*\bhref="\/app\/board\/regulations\/pdf\/(\d+)_M\.do"/g;
  for (const m of html.matchAll(row)) {
    if (seen.has(m[2])) continue;
    const label = m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    // "규정명(2026. 10. 29. 시행)": 시행일만 시행일로 쓴다. "제정"·"개정" 날짜는 시행일이 아니다.
    const dated = /^(.*?)\s*[(（]\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(시행|제정|개정)\s*[)）]$/.exec(label);
    const title = (dated ? dated[1] : label).trim();
    if (!title) continue;
    seen.add(m[2]);
    const valid = dated && realDate(dated[2], dated[3], dated[4]);
    items.push({ id: m[2], title, effectiveAt: valid && dated[5] === '시행' ? isoDate(dated[2], dated[3], dated[4]) : null,
      revisedAt: valid && dated[5] !== '시행' ? dotDate(dated[2], dated[3], dated[4]) : null });
  }
  return items;
}
async function loadSejong(source, topic, terms, client, signal, spec, { rankByTitle, maxRules, safeCode, extractPdf = extractPdfText, now = Date.now }) {
  let memo = sejongLists.get(client);
  if (!memo || now() - memo.at >= SEJONG_TTL_MS) {
    const items = parseSejongList(await client.request(source, SEJONG_LIST, undefined, 20000, signal));
    if (items.length < 20) throw error('UPSTREAM_FORMAT_CHANGED');
    memo = { at: now(), items }; sejongLists.set(client, memo);
  }
  const ranked = rankByTitle(memo.items, topic, terms, spec.titleHints || terms), rules = [], failures = [];
  for (const hit of ranked.slice(0, maxRules)) {
    const path = `/app/board/regulations/pdf/${hit.id}_M.do`;
    try {
      if (signal?.aborted) throw error('TOTAL_TIMEOUT');
      const { markdown } = await pdfArticles(await client.request(source, path, undefined, 20000, signal, { binary: true }), signal, extractPdf);
      // 목록에 적힌 시행일을 쓴다. 목록에 제정·개정 날짜만 있는 규정은 시행일 미확인이다.
      rules.push({ title: hit.title, lawId: Number(hit.id), historyId: hit.effectiveAt ? Number(hit.effectiveAt.replace(/-/g, '')) : 0, markdown,
        url: source.origin + SEJONG_LIST, originalPdfUrl: source.origin + path, sourceType: 'PDF 텍스트 레이어',
        revisedAt: hit.revisedAt, effectiveAt: hit.effectiveAt, effectiveSource: hit.effectiveAt ? 'list' : null });
    } catch (e) { const code = safeCode(e); failures.push({ lawId: Number(hit.id), code }); if (STOP.includes(code)) break; }
  }
  return { rules, failures, coverage: { mode: 'catalog_pdf', totalCandidates: memo.items.length, titleMatches: ranked.length, truncated: ranked.length > maxRules, textLayerOnly: true, ...DOCUMENT_COVERAGE } };
}

// ── 가천대: 규정집 위젯의 공개 JSON 목록(전체) + 규정별 첨부(PDF 또는 한글 파일) ──
const GACHON_LIST = '/regltn/kor/2/5/listOperation';
const isPdf = buffer => buffer.subarray(0, 5).toString('ascii') === '%PDF-';
const isHwp = buffer => buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
async function hwpArticles(buffer, parseHwp) {
  let parsed;
  try { parsed = await parseHwp(buffer); } catch { throw error('HWP_PARSE_FAILED'); }
  // bodyMarkdown은 별표·서식을 뺀 본문이다(조문 비교 범위).
  const markdown = [parsed?.bodyMarkdown, parsed?.markdown].find(text => text && listArticleBlocks(text).length);
  if (!markdown) throw error('HWP_NO_ARTICLES');
  return { markdown, tailExcluded: markdown !== parsed.markdown && parsed.markdown.length > markdown.length };
}
async function loadGachon(source, topic, terms, client, signal, spec, { rankByTitle, maxRules, latestAddendaEffective, ruleRevisedAt, safeCode, extractPdf = extractPdfText, parseHwp = buffer => require('./hwp-evidence.js').parseOriginalEvidence(buffer) }) {
  let list;
  try { list = JSON.parse(await client.request(source, GACHON_LIST, 'srchColumn=sj&srchWrd=', 15000, signal)); } catch (e) { if (e?.code) throw e; throw error('UPSTREAM_FORMAT_CHANGED'); }
  if (!Array.isArray(list) || list.length < 20 || list.some(x => !x || typeof x.sj !== 'string' || !Number.isInteger(x.regltnSeq))) throw error('UPSTREAM_FORMAT_CHANGED');
  const items = list.map(x => ({ seq: x.regltnSeq, title: x.sj.trim(), file: typeof x.fileNm === 'string' ? x.fileNm : '' }));
  const ranked = rankByTitle(items, topic, terms, spec.titleHints || terms), rules = [], failures = [];
  for (const hit of ranked.slice(0, maxRules)) {
    const path = `/regltn/kor/2/${hit.seq}/download`;
    try {
      if (signal?.aborted) throw error('TOTAL_TIMEOUT');
      const buffer = await client.request(source, path, undefined, 20000, signal, { binary: true, formats: ['pdf', 'hwp'] });
      const pdf = isPdf(buffer);
      if (!pdf && !isHwp(buffer)) throw error('DOCUMENT_FORMAT_UNSUPPORTED');
      const { markdown, tailExcluded } = pdf ? await pdfArticles(buffer, signal, extractPdf) : await hwpArticles(buffer, parseHwp);
      const effectiveAt = tailExcluded ? null : latestAddendaEffective(markdown);
      rules.push({ title: hit.title, lawId: hit.seq, historyId: 0, markdown, url: `${source.origin}/kor/796/subview.do`, originalPdfUrl: source.origin + path,
        sourceType: pdf ? 'PDF 텍스트 레이어' : '한글 파일 본문', revisedAt: ruleRevisedAt(markdown), effectiveAt, effectiveSource: effectiveAt ? 'addenda' : null });
    } catch (e) { const code = safeCode(e); failures.push({ lawId: hit.seq, code }); if (STOP.includes(code)) break; }
  }
  return { rules, failures, coverage: { mode: 'catalog_files', totalCandidates: items.length, titleMatches: ranked.length, truncated: ranked.length > maxRules, ...DOCUMENT_COVERAGE } };
}

const ADAPTERS = { hongik_html: loadHongik, hanyang_json: loadHanyang, skku_pdf: loadSkku, sejong_pdf: loadSejong, gachon_files: loadGachon };
const DOCUMENT_KEYS = Object.freeze(['skku', 'sejong', 'gachon']);
module.exports = { ADAPTERS, DOCUMENT_KEYS, DOCUMENT_NOTICE, htmlLines, dropUnreadArticles, isAppendixLabel, parseHongikTree, hanyangMarkdown, parseSkkuRows, currentSkkuRules, parseSejongList, isPdf, isHwp };

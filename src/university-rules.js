'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const tls = require('node:tls');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { listArticleBlocks } = require('./parsers');
const { comparisonTerms } = require('./aliases');
const { extractEnforcementDates } = require('./timeline');
const { loadCau, NOTICE: PDF_NOTICE } = require('./cau-pdf');
const { validatePdf, LIMITS: PDF_LIMITS } = require('./pdf-text');
const { ADAPTERS: MORE_ADAPTERS, DOCUMENT_KEYS, DOCUMENT_NOTICE, isPdf, isHwp } = require('./university-adapters');

// 일부 대학 서버(예: 서강대)는 중간 인증서를 빠뜨려 체인 검증에 실패한다. src/ca의
// 공개 중간 인증서를 기본 루트에 '추가'해 검증을 끄지 않고 해결한다(루트 교체 아님).
function extraCAs() {
  try { return fs.readdirSync(path.join(__dirname, 'ca')).filter(f => f.endsWith('.pem')).map(f => fs.readFileSync(path.join(__dirname, 'ca', f), 'utf8')); }
  catch { return []; }
}
const httpsAgent = new https.Agent({ ca: [...tls.rootCertificates, ...extraCAs()] });
const agentFor = parsedUrl => parsedUrl.protocol === 'https:' ? httpsAgent : undefined;

// Endpoint settings and LawMaster pair parsing ported from kr-univ-rule-mcp,
// tools/probe/probe.js (e56044f), MIT; attribution in docs/THIRD_PARTY.md.
// 'tree' reads the public rule tree (lawTree) and falls back to the recent list
// when a site serves only a stub tree without a session (고려대, 2026-11 확인).
const SOURCES = Object.freeze([
  { key: 'dongguk', name: '동국대학교', origin: 'https://rule.dongguk.edu', ext: 'srv', mode: 'search' },
  // 고려대는 로그인 없이 약 55개 규정만 공개한다(2026-11-24 확인: 다른 SEQ는 로그인으로 302).
  // 검색·전체 트리·부서별 목록은 세션이 필요하고, 분류별 목록(lawListManager)만 열려 있다.
  // folders는 공개 규정이 들어 있는 분류 번호(1~300 범위 조사 결과)이다.
  { key: 'korea', name: '고려대학교', origin: 'https://policies.korea.ac.kr', ext: 'do', mode: 'public_folders', folders: [2, 3, 4, 5, 6, 7, 11, 13] },
  { key: 'uos', name: '서울시립대학교', origin: 'http://rule.uos.ac.kr', ext: 'srv', mode: 'search' },
  { key: 'konkuk', name: '건국대학교', origin: 'https://rule.konkuk.ac.kr', ext: 'do', mode: 'tree' },
  { key: 'kookmin', name: '국민대학교', origin: 'https://rule.kookmin.ac.kr', ext: 'do', mode: 'search_do' },
  { key: 'ssu', name: '숭실대학교', origin: 'http://rule.ssu.ac.kr', ext: 'do', mode: 'search_do' },
  // 아래 4곳은 2026-11-24 공개 접근 확인. 경희·숙명은 전문검색, 광운·명지는 공개 규정트리.
  { key: 'khu', name: '경희대학교', origin: 'https://rule.khu.ac.kr', ext: 'do', mode: 'search_do' },
  { key: 'sookmyung', name: '숙명여자대학교', origin: 'https://rule.sookmyung.ac.kr', ext: 'do', mode: 'search_do' },
  { key: 'kw', name: '광운대학교', origin: 'https://rule.kw.ac.kr', ext: 'do', mode: 'tree' },
  { key: 'mju', name: '명지대학교', origin: 'https://law.mju.ac.kr', ext: 'do', mode: 'tree' },
  // LawMaster가 아닌 자체 시스템(2026-11-24 확인). 전용 어댑터로 조문을 읽는다.
  { key: 'sogang', name: '서강대학교', origin: 'https://www.sogang.ac.kr', mode: 'adapter', adapter: 'sogang_json', pathPrefixes: ['/api/api/v1/mainEn/rule/'] },
  { key: 'ewha', name: '이화여자대학교', origin: 'https://www.ewha.ac.kr', mode: 'adapter', adapter: 'ewha_html', pathPrefixes: ['/ewha/intro/rules.do'] },
  // 서울대(국립): 국가법령정보센터 DRF 학칙 채널. 운영자 OC 키(DONGGUK_LAWGO_OC) 필요.
  { key: 'snu', name: '서울대학교', origin: 'https://www.law.go.kr', mode: 'adapter', adapter: 'lawgo_school', institution: '서울대학교', pathPrefixes: ['/DRF/'] },
  { key: 'yonsei', name: '연세대학교', origin: 'https://rules.yonsei.ac.kr', mode: 'adapter', adapter: 'nextjs_rsc', pathPrefixes: ['/regulations'] },
  { key: 'cau', name: '중앙대학교', origin: 'https://www.cau.ac.kr', mode: 'adapter', adapter: 'cau_pdf', pathPrefixes: ['/ajax/FR_SVC/', '/cms/FR_CON/', '/ajaxFile/FR_SVC/'] },
  // 아래 5곳은 2026-11-25 공개 접근 확인(로그인·쿠키 없음). documentPath는 내려받을 수 있는 문서 경로,
  // maxTextBytes는 목록이 한 페이지에 전부 실리는 세종대(약 5MB)에만 둔 응답 한도다.
  { key: 'hongik', name: '홍익대학교', origin: 'https://www.hongik.ac.kr', mode: 'adapter', adapter: 'hongik_html', pathPrefixes: ['/kr/introduction/regulations-book.do'] },
  { key: 'hanyang', name: '한양대학교', origin: 'https://portal.hanyang.ac.kr', mode: 'adapter', adapter: 'hanyang_json', contentType: 'application/json+sua; charset=UTF-8',
    pathPrefixes: ['/huas/iycy/findGyujeongSearch1HYU.do?searchStr=', '/huas/iycy/findGyujeongMView.do?strGyujeongCd='] },
  { key: 'skku', name: '성균관대학교', origin: 'https://www.skku.edu', mode: 'adapter', adapter: 'skku_pdf',
    pathPrefixes: ['/state/current/current_rulebook.do?mode=list&', '/state/current/current_rulebook.do?mode=download&'],
    documentPath: /^\/state\/current\/current_rulebook\.do\?mode=download&articleNo=\d+&attachNo=\d+$/ },
  { key: 'sejong', name: '세종대학교', origin: 'https://www.sejong.ac.kr', mode: 'adapter', adapter: 'sejong_pdf', maxTextBytes: 6 * 1024 * 1024,
    pathPrefixes: ['/kor/intro/regulation-overview.do', '/app/board/regulations/pdf/'], documentPath: /^\/app\/board\/regulations\/pdf\/\d+_M\.do$/ },
  { key: 'gachon', name: '가천대학교', origin: 'https://www.gachon.ac.kr', mode: 'adapter', adapter: 'gachon_files',
    pathPrefixes: ['/regltn/kor/2/'], documentPath: /^\/regltn\/kor\/2\/\d+\/download$/ },
].map(Object.freeze));
const { FRAMES, resolveFrame, analyzeArticle, assignRoles, buildSlotMatrix, frameSummary, DROP_LABELS } = require('./issue-frames');
// 등록 주제는 사안 프레임(issue-frames.js)에서 온다. terms: 조문 일치어(첫 항목이 대표어·검색어).
// titleHints: 규정 제목 우선순위용(조문 일치에는 쓰지 않음).
const TOPICS = Object.freeze(Object.fromEntries(FRAMES.map(f => [f.topic, { terms: f.terms, titleHints: f.titleHints }])));
const TOPIC_PREFIX = /^(교내|교외|학부|대학원|학사)/;
const MAX_RULES = 5, MIN_TREE_RULES = 20, TOTAL_TIMEOUT_MS = 60000;
// Internal monitoring can request one representative; public comparison keeps five.
const ruleLimit = spec => Number.isInteger(spec.maxRules) && spec.maxRules >= 1 && spec.maxRules <= MAX_RULES ? spec.maxRules : MAX_RULES;
const TREE_QUERY = 'LAWGROUP=1&SEQ_TARGET=0&MODE=srvlist&TREE_SEARCH_BOOL=y';
const FOLDER_PAGE_SIZE = 10, MAX_FOLDER_PAGES = 10;
const PUBLIC_ONLY_NOTICE = '로그인 없이 공개된 규정만 목록에 나옵니다. 목록에 없는 규정은 비공개로 추정되며 조회할 수 없습니다.';
const NOTICE = '주제어가 일치하는 조문 발췌를 나란히 제공합니다. 행 순서나 조문 번호는 대학 간 법적 대응·동등성을 뜻하지 않습니다. HTML 또는 PDF 텍스트 레이어의 조문만 조회합니다. 표·별표·부록·서식의 구조와 금액 대응은 비교하지 않으므로 원문을 확인하세요. 개정일은 시행일이 아닙니다. 시행일은 규정 목록의 시행일자 또는 마지막 부칙의 명시 시행일만 표시하며(조문별 시행일·경과조치는 미확인), 없으면 미확인입니다.';
const FRAME_NOTICE = '등록된 사안 프레임으로 조문을 골랐습니다. 주체·행위·규율 요소의 문자열 대조이며, 같은 단어가 다른 뜻으로 쓰인 조문(교내 겸무 등)은 제외 건수로만 표시합니다. 규율 요소 표의 빈 칸은 조회 범위에서 찾지 못했다는 뜻이고 규정 부존재가 아닙니다. 주규정·보조규정 구분과 근거 법령 대조는 법적 동등성·적용 여부 판정이 아닙니다.';
const error = code => Object.assign(new Error(code), { code });
const compact = s => String(s ?? '').replace(/\s+/g, '');
const uniq = xs => [...new Set(xs.filter(Boolean))];

// "교내근로장학금" → 대표어 '근로장학'과 동의어(근로보조금 등)를 가진 사안 프레임. 띄어 쓴 주제
// ("교원 겸직")는 한 단어가 프레임과 맞으면 그 프레임을 쓰고 나머지 단어는 제목 단서로만 둔다.
// 등록되지 않은 주제는 기존처럼 띄어쓰기로 나누고, 한 단어면 접두어(교내·학부 등)·끝의 '금'을 뗀 형태도 함께 쓴다.
function topicVariants(word) {
  const c = compact(word), core = c.replace(TOPIC_PREFIX, '');
  return uniq([c, core, c.replace(/금$/, ''), core.replace(/금$/, '')]);
}
function expandTopic(topic) {
  const raw = String(topic).trim(), c = compact(raw), core = c.replace(TOPIC_PREFIX, '');
  const fromFrame = (frame, extraHints = []) => ({ terms: [...frame.terms], searchTerms: [...frame.searchTerms], titleHints: uniq([...frame.titleHints, ...extraHints]), frame });
  const synonyms = comparisonTerms(c);
  const whole = resolveFrame(synonyms.flatMap(topicVariants));
  if (whole) return fromFrame(whole);
  if (/\s/.test(raw)) {
    const words = raw.split(/\s+/);
    const matched = uniq(words.map(w => resolveFrame(topicVariants(w))));
    if (matched.length === 1) return fromFrame(matched[0], words.filter(w => !resolveFrame(topicVariants(w))));
    const terms=uniq(words.flatMap(comparisonTerms));
    return { terms, searchTerms: uniq([raw,...terms]), titleHints: terms, frame: null };
  }
  const terms = uniq([...synonyms, core.length >= 2 ? core : null]);
  return { terms, searchTerms: [...terms].reverse(), titleHints: terms, frame: null };
}

// 목록 제목에 섞인 스크립트(시행예정 표시·new 아이콘)를 지우고 시행일자를 뽑는다.
function cleanListTitle(text) {
  const s = String(text || '');
  const m = /chekFutureDate\(\s*['"](\d{4})(\d{2})(\d{2})['"]\s*\)/.exec(s);
  const title = s.replace(/if\s*\(\s*chekFutureDate\([^)]*\)\s*\)\s*\{[^}]*\}\s*;?/g, ' ')
    .replace(/newIcon\([^)]*\)\s*;?/g, ' ').replace(/\[시행예정\]/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, effectiveAt: m ? `${m[1]}-${m[2]}-${m[3]}` : null };
}

// 마지막 부칙에서 규정 전체의 단일 명시 시행일만 채택한다. 범위·날짜가 불명확하면 null.
function latestAddendaEffective(markdown) {
  const source = String(markdown || '');
  const heads = [...source.matchAll(/^#{0,3}\s*부\s*칙.*$/gm)];
  if (!heads.length) return null;
  // Keep inline commencement text, but remove an optional addendum date label.
  const last = source.slice(heads[heads.length - 1].index)
    .replace(/^#{0,3}\s*부\s*칙\s*(?:[（(<\[][^）)>\]\n]*[）)>\]])?/, '');
  const datePattern = /^(\d{4})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})\s*일?\s*\.?\s*(?:부터|에)?\s*(?:개정\s*)?$/;
  const generalSubject = /^(?:이|본)?(?:개정)?(?:규정|지침|규칙|세칙|내규|학칙|규약|요령|기준)(?:은|는)/;
  const provision = String.raw`제\d+조(?:의\d+)?(?:제\d+항)?(?:[（(][^（）()]+[）)])?`;
  const provisionSubject = new RegExp(`^${provision}(?:부터${provision}까지)?(?:(?:의(?:개정)?규정)?(?:은|는)|에따른수당은)`);
  const dates = new Set();
  let end = 0;
  for (const match of last.matchAll(/([\s\S]*?)시행(?:한다|함)?(?=[.。\s,"'”’]|$)/g)) {
    end = match.index + match[0].length;
    // Strip completed preceding sentences and structural labels, never arbitrary
    // text before a date. An unrecognised subject must not become a general date.
    const clause = match[1].replace(/^[\s\S]*(?:한다|함)[.。]/, '')
      .replace(/\s+/g, '').replace(/^[.。,]+/, '').replace(/^다만[,，]?/, '')
      .replace(/^#{1,3}/, '').replace(/^[①-⑳]/, '')
      .replace(/^(?:제\d+조)?[（(]시행일[）)]/, '');
    const scoped = provisionSubject.exec(clause);
    if (scoped) {
      if (!datePattern.test(clause.slice(scoped[0].length))) return null;
      continue;
    }
    const subject = generalSubject.exec(clause);
    const date = subject ? clause.slice(subject[0].length) : clause;
    // A bare date under an addendum/commencement heading is supported too.
    // Unknown or undated general clauses invalidate an earlier candidate.
    if (!datePattern.test(date)) return null;
    const found = extractEnforcementDates(date.replace(/개정$/, '') + '시행');
    if (found.length !== 1) return null;
    dates.add(found[0].iso);
  }
  // Do not ignore unsupported commencement endings after a supported clause.
  if (/시행/.test(last.slice(end))) return null;
  // Several general dates do not establish which revision is current.
  return dates.size === 1 ? [...dates][0] : null;
}

function ruleTitleScore(title, terms, hints) {
  const t = compact(String(title || '').split(/제\s*\d+\s*조/)[0]).replace(/^[\d-]+/, '');
  if (terms.some(x => t.includes(compact(x)))) return 2;
  return hints.some(x => t.includes(compact(x))) ? 1 : 0;
}

// 주제 전담에 가까운 짧은 제목(출장비규정, 출장비 지급 규정, 여비규정)을 올리고,
// 같은 단서가 있어도 산학협력단·연구과제 내규·세부지침은 그 다음으로 둔다.
function titleSpecificityBonus(title, topic, terms, hints) {
  const t = compact(String(title || '').split(/제\s*\d+\s*조/)[0]).replace(/^[\d-]+/, '');
  const stems = uniq([topic, ...terms, ...hints].map(x => compact(x)).filter(x => x.length >= 2));
  let bonus = 0;
  if (stems.some(s => t === s || t === s + '규정' || t === s + '지급규정' || t === `${s}지급에관한규정`)) bonus += 40;
  if (/(산학협력단|연구과제)/.test(t) && /(내규|세부지침|사용기준)/.test(t)) bonus -= 25;
  return bonus;
}

function titleMatchesTopic(title, topic, aliases = []) {
  const t = compact(title);
  return uniq([topic, ...aliases].map(x => compact(x)).filter(Boolean)).some(k => t.includes(k));
}

// LawMaster 밖 대학(서강 JSON content, 이화 view HTML 등)의 조문 HTML/텍스트를
// listArticleBlocks가 읽는 '### 제N조 … / ## 부칙 …' markdown으로 바꾼다.
// 블록 태그가 없고 조문이 &nbsp;로 이어지는 서강류도 조·부칙·장·절 경계에서 분리한다.
function htmlToArticleMarkdown(html) {
  let text = String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&middot;/gi, '·').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  text = text
    .replace(/\s*(제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[(（])/g, '\n$1')
    .replace(/\s*(제\s*\d+\s*(?:장|절)(?=[\s(（]))/g, '\n$1')
    .replace(/\s*(부\s*칙(?=[\s(（<\[]|$))/g, '\n$1');
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^제\s*\d+\s*조(?:\s*의\s*\d+)?(?=[(（\s]|$)/.test(line)) out.push('### ' + line);
    else if (/^부\s*칙(?=[\s(（<\[]|$)/.test(line)) out.push('## ' + line.replace(/^부\s*칙\s*/, '부칙 '));
    else if (/^제\s*\d+\s*(?:장|절)(?=[\s(（]|$)/.test(line)) out.push('## ' + line);
    else out.push(line);
  }
  return out.join('\n');
}

// 본문 머리말(제정·개정 날짜 나열)에서 가장 늦은 날짜(=최근 개정일)를 YYYY.MM.DD로.
function latestRevisionDate(text) {
  const dates = [...String(text || '').matchAll(/(\d{4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})/g)]
    .map(m => `${m[1]}.${String(+m[2]).padStart(2, '0')}.${String(+m[3]).padStart(2, '0')}`)
    .filter(d => d >= '1945.01.01' && d <= '2100.12.31');
  return dates.length ? dates.sort().pop() : null;
}

// 규정 개정일: 조문 앞 머리말과 부칙 헤딩에 적힌 날짜 중 가장 늦은 날짜.
function ruleRevisedAt(markdown) {
  const s = String(markdown || '');
  const header = s.split(/\n### 제\s*\d+\s*조/)[0];
  const addenda = (s.match(/^##\s*부\s*칙[^\n]*/gm) || []).join('\n');
  return latestRevisionDate(header + '\n' + addenda);
}

function rankByTitle(items, topic, terms, hints) {
  const query = compact(topic);
  const scored = items
    .map((it, i) => {
      const t = compact(it.title);
      const s = (t === query || t === query + '규정' ? 100 : t.includes(query) ? 30 : 0)
        + ruleTitleScore(it.title, terms, hints) * 10
        + titleSpecificityBonus(it.title, topic, terms, hints);
      return { it, i, s };
    })
    .filter(x => ruleTitleScore(x.it.title, terms, hints) > 0 || x.s >= 30);
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map(x => x.it);
}

// 서강대: 자체 REST JSON. searchRuleData가 매칭 규정의 content(조문 HTML)까지 돌려준다.
// 전체(pageSize=1000)는 3MB라 한도를 넘으므로 주제어를 title로 질의해 매칭분만 받는다.
async function loadSogang(source, topic, terms, client, signal, spec = {}) {
  const maxRules = ruleLimit(spec);
  const hints = spec.titleHints || terms;
  const queries = uniq([...(spec.searchTerms || []), ...hints, ...terms]).slice(0, 4);
  const byId = new Map();
  let anyOk = false, firstErr = null;
  for (const q of queries) {
    try {
      const raw = await client.request(source, `/api/api/v1/mainEn/rule/searchRuleData?pageNum=1&pageSize=50&title=${encodeURIComponent(q)}&content=&tab=1`, undefined, 15000, signal);
      const list = JSON.parse(raw)?.data?.list;
      if (!Array.isArray(list)) throw error('UPSTREAM_FORMAT_CHANGED');
      anyOk = true;
      for (const r of list) if (r && r.title && !byId.has(r.pkid)) byId.set(r.pkid, r);
    } catch (e) { firstErr = firstErr || e; if (['TOTAL_TIMEOUT'].includes(safeCode(e))) throw e; }
  }
  if (!anyOk) throw firstErr || error('UPSTREAM_FORMAT_CHANGED');
  const ranked = rankByTitle([...byId.values()], topic, terms, hints).slice(0, maxRules);
  const rules = [], failures = [];
  for (const hit of ranked) {
    const markdown = htmlToArticleMarkdown(hit.content || '');
    if (!listArticleBlocks(markdown).length) { failures.push({ lawId: hit.pkid, code: 'UPSTREAM_FORMAT_CHANGED' }); continue; }
    const effectiveAt = latestAddendaEffective(markdown);
    rules.push({ title: String(hit.title).trim(), lawId: hit.pkid, historyId: 0, markdown,
      url: `${source.origin}/ko/regulation/home`, revisedAt: ruleRevisedAt(markdown), effectiveAt: effectiveAt || null, effectiveSource: effectiveAt ? 'addenda' : null });
  }
  return { rules, failures, coverage: { mode: 'rest_json', queries, totalCandidates: byId.size, titleMatches: ranked.length, truncated: ranked.length > maxRules, complete: false } };
}

// 이화여대: 규정집 목록 HTML(view-rule 링크) + 규정별 view 페이지(.fr-view에 조문 전문).
async function loadEwha(source, topic, terms, client, signal, spec = {}) {
  const maxRules = ruleLimit(spec);
  const hints = spec.titleHints || terms;
  const listHtml = await client.request(source, '/ewha/intro/rules.do', undefined, 15000, signal);
  const $ = cheerio.load(listHtml);
  const seen = new Set(), items = [];
  $('a[href*="mode=view-rule"]').each(function () {
    const href = ($(this).attr('href') || '').replace(/&amp;/g, '&');
    const m = /srRuleCd1=(\d+)&srRuleCd2=(\d+)/.exec(href);
    const title = $(this).text().replace(/\s+/g, ' ').trim();
    if (!m || !title) return;
    const key = m[1] + '_' + m[2];
    if (seen.has(key)) return; seen.add(key);
    items.push({ cd1: m[1], cd2: m[2], title });
  });
  if (!items.length) throw error('UPSTREAM_FORMAT_CHANGED');
  const titleHits = rankByTitle(items, topic, terms, hints);
  // Bound discovery to two canonical undergraduate rules already in this catalog.
  // Do not broaden explicit graduate/institution topics or title-only monitoring.
  const academicTopic = !spec.titleOnly && /^(?:휴학|복학|재입학|전과|졸업|수료|학점|수강신청|제적|자퇴)$/.test(compact(topic));
  const academicHits = academicTopic ? items.filter(hit =>
    /^(?:이화여자대학교)?학칙(?:시행세칙)?$/.test(compact(hit.title)) && !titleHits.includes(hit))
    .sort((a, b) => compact(a.title).length - compact(b.title).length).slice(0, 2) : [];
  const fallback = academicHits.slice(0, Math.max(0, maxRules - titleHits.length));
  const ranked = [...titleHits.slice(0, maxRules), ...fallback];
  const rules = [], failures = [];
  for (const hit of ranked) {
    try {
      const html = await client.request(source, `/ewha/intro/rules.do?mode=view-rule&srRuleCd1=${hit.cd1}&srRuleCd2=${hit.cd2}`, undefined, 15000, signal);
      const body = cheerio.load(html)('.fr-view').html() || '';
      const markdown = htmlToArticleMarkdown(body);
      if (!listArticleBlocks(markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
      const effectiveAt = latestAddendaEffective(markdown);
      rules.push({ title: hit.title, lawId: Number(hit.cd2), historyId: 0, markdown,
        url: `${source.origin}/ewha/intro/rules.do?mode=view-rule&srRuleCd1=${hit.cd1}&srRuleCd2=${hit.cd2}`,
        revisedAt: ruleRevisedAt(markdown), effectiveAt: effectiveAt || null, effectiveSource: effectiveAt ? 'addenda' : null });
    } catch (e) {
      failures.push({ lawId: Number(hit.cd2), code: safeCode(e) });
      if (['ACCESS_DENIED', 'SESSION_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'REDIRECT_NOT_FOLLOWED', 'TOTAL_TIMEOUT'].includes(safeCode(e))) break;
    }
  }
  return { rules, failures, coverage: { mode: 'html_catalog', totalCandidates: items.length, titleMatches: titleHits.length,
    academicFallbackRules: fallback.length, academicFallbackTitles: fallback.map(hit => hit.title),
    discoveryScope: fallback.length ? 'titles_and_bounded_academic_rules' : 'titles_only',
    notice: fallback.length ? '목록 제목 후보와 학부 학칙·학칙시행세칙 최대 2개의 본문에서 주제어를 찾았습니다. 대학원·다른 기관 규정이나 전체 규정 전문을 검색한 결과는 아닙니다.' : '규정 목록의 제목으로 후보를 골랐습니다. 제목에 주제어가 없는 규정의 본문은 빠질 수 있습니다.',
    truncated: titleHits.length + academicHits.length > ranked.length, complete: false } };

}

// 서울대(국립): 국가법령정보센터 DRF 공개 API의 학칙 채널. 운영자가 law.go.kr에서
// 발급한 무료 OC 키(DONGGUK_LAWGO_OC)로 직접 조회한다(중간 서버 없음). 키가 없으면
// LAWGO_OC_NOT_CONFIGURED로 '미설정'을 알린다. 목록·본문 모두 type=HTML로 받아,
// 목록은 target=school&ID= 링크(규정명=링크 텍스트)로, 본문은 공통 변환기로 처리한다.
// DRF XML의 한 요소 값(CDATA·태그·엔티티 제거).
function xmlField(block, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block || '');
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}
const ymdDot = v => /^\d{8}$/.test(v) ? `${v.slice(0, 4)}.${v.slice(4, 6)}.${v.slice(6, 8)}` : (v || null);
const ymdIso = v => /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null;

async function loadLawgoSchool(source, topic, terms, client, signal, spec = {}) {
  const maxRules = ruleLimit(spec);
  const oc = String(process.env.DONGGUK_LAWGO_OC || source.oc || '').trim();
  if (!oc) throw error('LAWGO_OC_NOT_CONFIGURED');
  const hints = spec.titleHints || terms;
  const inst = source.institution || '서울대학교';
  const queries = uniq([...(spec.searchTerms || []), ...hints]).slice(0, 3);
  const byId = new Map();
  let anyOk = false, firstErr = null;
  for (const q of queries) {
    if (byId.size >= maxRules && anyOk) break;
    try {
      const xml = await client.request(source, `/DRF/lawSearch.do?OC=${encodeURIComponent(oc)}&target=school&type=XML&display=30&query=${encodeURIComponent(inst + ' ' + q)}`, undefined, 15000, signal);
      if (!/<AdmRulSearch/.test(xml)) throw error('UPSTREAM_FORMAT_CHANGED');
      anyOk = true;
      for (const m of xml.matchAll(/<admrul\b[\s\S]*?<\/admrul>/g)) {
        const block = m[0];
        const id = xmlField(block, '행정규칙일련번호');
        const title = xmlField(block, '행정규칙명');
        // 소관부처가 대상 대학이고 현행인 규정만. 타교 규정·연혁본 제외.
        if (!id || !title || !xmlField(block, '소관부처명').includes(inst) || xmlField(block, '현행연혁구분') !== '현행') continue;
        if (byId.has(id)) continue;
        byId.set(id, { id, title, promulgated: xmlField(block, '발령일자'), enforced: xmlField(block, '시행일자') });
      }
    } catch (e) { firstErr = firstErr || e; if (safeCode(e) === 'TOTAL_TIMEOUT') throw e; }
  }
  if (!anyOk) throw firstErr || error('UPSTREAM_FORMAT_CHANGED');
  const ranked = rankByTitle([...byId.values()], topic, terms, hints).slice(0, maxRules);
  const rules = [], failures = [];
  for (const hit of ranked) {
    try {
      const xml = await client.request(source, `/DRF/lawService.do?OC=${encodeURIComponent(oc)}&target=school&type=XML&ID=${hit.id}`, undefined, 15000, signal);
      if (!/<AdmRulService/.test(xml)) throw error('UPSTREAM_FORMAT_CHANGED');
      // 조문은 조문내용 요소별로 온다("제1장 총칙", "제1조(목적) …"). 공통 변환기로 ### 제N조화.
      const body = [...xml.matchAll(/<조문내용>([\s\S]*?)<\/조문내용>/g)]
        .map(a => a[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim())
        .filter(Boolean).join('\n');
      const markdown = htmlToArticleMarkdown(body);
      if (!listArticleBlocks(markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
      const nm = hit.title.replace(/\s+/g, '');
      const promul = xmlField(xml, '발령일자') || hit.promulgated, num = xmlField(xml, '발령번호');
      rules.push({ title: hit.title, lawId: Number(hit.id) || hit.id, historyId: 0, markdown,
        url: num && promul ? `${source.origin}/행정규칙/${encodeURIComponent(nm)}/(${num},${promul})` : `${source.origin}/행정규칙/${encodeURIComponent(nm)}`,
        revisedAt: ymdDot(hit.promulgated), effectiveAt: ymdIso(hit.enforced), effectiveSource: hit.enforced ? 'lawgo_list' : null });
    } catch (e) {
      failures.push({ lawId: Number(hit.id) || 0, code: safeCode(e) });
      if (['ACCESS_DENIED', 'SESSION_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'REDIRECT_NOT_FOLLOWED', 'TOTAL_TIMEOUT'].includes(safeCode(e))) break;
    }
  }
  return { rules, failures, coverage: { mode: 'lawgo_school', queries, totalCandidates: byId.size, titleMatches: ranked.length, truncated: ranked.length > maxRules, complete: false } };
}

// 연세대: Next.js(App Router) 규정집. 공개 API가 없어 페이지에 내장된 RSC flight
// 데이터(self.__next_f.push([1,"…"]))를 재조립해 규정 목록·본문을 읽는다. 로그인 불필요.
function flightBlob(html) {
  let b = '';
  for (const m of String(html || '').matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try { b += JSON.parse('"' + m[1] + '"'); } catch { /* skip malformed chunk */ }
  }
  return b;
}
async function loadYonsei(source, topic, terms, client, signal, spec = {}) {
  const maxRules = ruleLimit(spec);
  const hints = spec.titleHints || terms;
  const listHtml = await client.request(source, '/regulations', undefined, 15000, signal);
  const blob = flightBlob(listHtml);
  if (!blob.includes('revisionHistories')) throw error('UPSTREAM_FORMAT_CHANGED');
  const items = [];
  const seen = new Set();
  for (const m of blob.matchAll(/"id":"([0-9a-f-]{36})","name":"((?:[^"\\]|\\.)*?)","order":\d+,"organization":/g)) {
    const id = m[1];
    if (seen.has(id)) continue; seen.add(id);
    let name; try { name = JSON.parse('"' + m[2] + '"'); } catch { continue; }
    const tail = blob.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const dates = [...tail.matchAll(/"revision_date":"(\d{4}-\d{2}-\d{2})/g)].map(x => x[1]);
    const status = /"status":"([^"]*)"/.exec(tail)?.[1];
    if (status && status !== 'current') continue; // 현행만
    items.push({ id, title: name, revisedAt: dates.length ? dates.sort().pop().replace(/-/g, '.') : null });
  }
  if (!items.length) throw error('UPSTREAM_FORMAT_CHANGED');
  const ranked = rankByTitle(items, topic, terms, hints).slice(0, maxRules);
  const rules = [], failures = [];
  for (const hit of ranked) {
    try {
      const page = await client.request(source, `/regulations/${hit.id}`, undefined, 15000, signal);
      const b = flightBlob(page);
      const ref = /"html":"\$([0-9a-f]+)"/.exec(b);
      if (!ref) throw error('UPSTREAM_FORMAT_CHANGED');
      const row = new RegExp('(?:^|\\n)' + ref[1] + ':T([0-9a-f]+),').exec(b);
      if (!row) throw error('UPSTREAM_FORMAT_CHANGED');
      const ln = parseInt(row[1], 16), start = row.index + row[0].length;
      // T 길이는 바이트 수(UTF-8)라 문자열 인덱스가 아닌 버퍼로 정확히 자른다.
      const html = Buffer.from(b.slice(start), 'utf8').subarray(0, ln).toString('utf8');
      const markdown = htmlToArticleMarkdown(html);
      if (!listArticleBlocks(markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
      const effectiveAt = latestAddendaEffective(markdown);
      rules.push({ title: hit.title, lawId: hit.id, historyId: 0, markdown,
        url: `${source.origin}/regulations/${hit.id}`,
        revisedAt: hit.revisedAt, effectiveAt: effectiveAt || null, effectiveSource: effectiveAt ? 'addenda' : null });
    } catch (e) {
      failures.push({ lawId: hit.id, code: safeCode(e) });
      if (['ACCESS_DENIED', 'SESSION_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'REDIRECT_NOT_FOLLOWED', 'TOTAL_TIMEOUT'].includes(safeCode(e))) break;
    }
  }
  return { rules, failures, coverage: { mode: 'nextjs_rsc', totalCandidates: items.length, titleMatches: ranked.length, truncated: ranked.length > maxRules, complete: false } };
}

const ADAPTERS = { sogang_json: loadSogang, ewha_html: loadEwha, lawgo_school: loadLawgoSchool, nextjs_rsc: loadYonsei };

function validateArguments(a) {
  if (!a || typeof a.topic !== 'string' || !a.topic.trim() || a.topic.length > 100) return 'topic은 1~100자 주제어여야 합니다.';
  if (!Array.isArray(a.universities) || !a.universities.length || a.universities.length > 5 || a.universities.some(x => typeof x !== 'string' || !/^[a-z]{2,20}$/.test(x) || x === 'dongguk')) return 'universities에는 비교할 타대학 키를 1~5개 넣으세요. dongguk은 자동 포함됩니다.';
  if (a.max_articles !== undefined && (!Number.isInteger(a.max_articles) || a.max_articles < 1 || a.max_articles > 5)) return 'max_articles는 1~5 정수여야 합니다.';
  return null;
}

function parsePairs(html) {
  const $ = cheerio.load(html), pairs = [], seen = new Set();
  const add = (lawId, historyId, text) => {
    const key = `${lawId}_${historyId}`;
    if (seen.has(key) || !Number.isSafeInteger(+lawId) || !Number.isSafeInteger(+historyId) || +lawId < 1 || +historyId < 1) return;
    const { title, effectiveAt } = cleanListTitle(text);
    seen.add(key); pairs.push({ lawId: +lawId, historyId: +historyId, title, ...(effectiveAt ? { effectiveAt } : {}) });
  };
  $('a, [onclick]').each(function () {
    const el = $(this), source = (el.attr('href') || '') + ' ' + (el.attr('onclick') || '');
    const m = /(?:fullPopupPost|thisReadLaw|lawSearchFullView\w*)\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/.exec(source)
      || /SEQ=(\d+)&(?:amp;)?SEQ_HISTORY=(\d+)/.exec(source);
    if (m) add(m[1], m[2], el.text().replace(/\s+/g, ' ').trim());
  });
  // Some sites write the list from script literals. Keep untitled entries so
  // the caller can explicitly report the bounded scan instead of a false zero.
  for (const m of html.matchAll(/fullPopupPost\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/g)) add(m[1], m[2], '');
  return pairs;
}

function parseExternalContent(html) {
  const $ = cheerio.load(html);
  $('.doc_btn, caption, script, style').remove();
  const root = $('.fullbody').length ? $('.fullbody') : $('body');
  // 명지대 등은 제목·부칙을 lawname2·addenda2로 표시한다(2026-11 확인). 두 표기 모두 받는다.
  const title = root.find('.lawname, .lawname2').first().text().replace(/\s+/g, ' ').trim();
  const lines = [];
  root.find('div, span').each(function () {
    const classes = ($(this).attr('class') || '').split(/\s+/);
    const text = $(this).text().replace(/\s+/g, ' ').trim();
    if (!text || classes.includes('lawname') || classes.includes('lawname2')) return;
    if (classes.includes('addenda') || classes.includes('addenda2')) lines.push(`## ${text.replace(/^부\s*칙\s*/, '부칙 ')}`);
    else if (classes.includes('chapter')) lines.push(`## ${text}`);
    // 고려대·건국대·명지대는 조문 제목을 span.article2로 표시한다(2026-11 확인).
    else if ((classes.includes('article') || classes.includes('article2')) && /^제\s*\d+\s*조/.test(text)) lines.push(`### ${text}`);
    else if (['none','hang','ho','mok'].some(c => classes.includes(c))) lines.push(text);
  });
  return {title,markdown:lines.join('\n')};
}

// 공개 규정 트리(var zNodes = [...])의 말단 노드: id=SEQ, hseq=SEQ_HISTORY.
function parseTree(html) {
  const m = /var\s+zNodes\s*=\s*(\[[\s\S]*?\])\s*;/.exec(String(html || ''));
  if (!m) return [];
  let nodes;
  try { nodes = JSON.parse(m[1]); } catch { return []; }
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(x => x && String(x.folder) === '0' && Number.isSafeInteger(+x.id) && +x.id > 0 && Number.isSafeInteger(+x.hseq) && +x.hseq > 0)
    .map(x => ({ lawId: +x.id, historyId: +x.hseq, title: cleanListTitle(x.name).title }));
}

// 분류별 규정 목록(lawListManager) 한 페이지: "전체: N 건" 표시와 규정 링크. 페이지 크기는 10으로 고정이다.
function parseFolderListing(html) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const m = /전체\s*:\s*([\d,]+)\s*건/.exec(text);
  if (!m) throw error('UPSTREAM_FORMAT_CHANGED');
  const total = Number(m[1].replace(/,/g, ''));
  const pairs = parsePairs(html);
  if (total > 0 && !pairs.length) throw error('UPSTREAM_FORMAT_CHANGED');
  return { total, pairs };
}

function parseUniversitySearch(html, modern = false) {
  const $ = cheerio.load(html);
  const totalMatch = modern ? /전체\s*:\s*([\d,]+)\s*건/.exec($('body').text()) : /([\d,]+)\s*건/.exec($('p.infoLeft').text());
  const hits = parsePairs(html);
  if (!totalMatch || (+totalMatch[1].replaceAll(',', '') > 0 && !hits.length)) throw error('UPSTREAM_FORMAT_CHANGED');
  return { total: Number(totalMatch[1].replaceAll(',', '')), hits };
}

function abortable(promise, signal, code = 'TOTAL_TIMEOUT') {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(error(code));
  return new Promise((resolve, reject) => {
    const stop = () => reject(error(code));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function createPublicClient({ fetchImpl = fetch, now = Date.now, ttlMs = 600000, maxEntries = 64, timeoutMs = 8000, minIntervalMs = 500, disabled = () => ['1','true','yes'].includes((process.env.DONGGUK_MCP_NO_CACHE || '').trim().toLowerCase()) } = {}) {
  const cache = new Map(), inflight = new Map(), nextRequest = new Map();
  async function request(source, path, body, budgetMs = timeoutMs, signal, opts = {}) {
    if (signal?.aborted) throw error('TOTAL_TIMEOUT');
    const binary = opts.binary === true;
    // 소스별 허용 경로. LawMaster는 /lmxsrv/, 자체 시스템 대학은 pathPrefixes로 선언.
    const okPath = source.pathPrefixes ? source.pathPrefixes.some(p => path.startsWith(p)) : /^\/lmxsrv\/(law|search)\//.test(path);
    if (!SOURCES.includes(source) || source.key === 'dongguk' || !okPath) throw error('SOURCE_NOT_ALLOWED');
    const documentAllowed = source.key === 'cau' ? path.startsWith('/ajaxFile/FR_SVC/CampusRulePDFDownload2.do?') : source.documentPath?.test(path) === true;
    if (binary && !documentAllowed) throw error('SOURCE_NOT_ALLOWED');
    const textLimit = source.maxTextBytes || 2 * 1024 * 1024;
    const key = (binary ? 'pdf:' : '') + source.key + ':' + path + ':' + (body || '');
    const hit = cache.get(key);
    if (!disabled() && hit && now() - hit.at < ttlMs) return hit.text;
    if (inflight.has(key)) return abortable(inflight.get(key), signal);
    const pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, budgetMs)));
      try {
        const slot = Math.max(Date.now(), nextRequest.get(source.key) || 0);
        nextRequest.set(source.key, slot + minIntervalMs);
        await abortable(new Promise(resolve => setTimeout(resolve, Math.max(0, slot - Date.now()))), controller.signal, 'UPSTREAM_UNAVAILABLE');
        const res = await fetchImpl(source.origin + path, {
          method: body ? 'POST' : 'GET', body, redirect: 'manual',
          signal: controller.signal, size: binary ? PDF_LIMITS.maxBytes : textLimit, agent: agentFor,
          headers: { 'User-Agent': 'dongguk-rule-mcp university comparison', ...(body ? { 'Content-Type': source.contentType || 'application/x-www-form-urlencoded' } : {}) },
        });
        if (res.status >= 300 && res.status < 400) throw error('REDIRECT_NOT_FOLLOWED');
        if ([401, 403].includes(res.status)) throw error('ACCESS_DENIED');
        if (!res.ok) throw error('UPSTREAM_UNAVAILABLE');
        if (binary) {
          if (Number(res.headers?.get('content-length')) > PDF_LIMITS.maxBytes) { res.body?.destroy(); throw error('PDF_TOO_LARGE'); }
          let buffer;
          try { buffer = await res.buffer(); } catch (e) { if (e.type === 'max-size') throw error('PDF_TOO_LARGE'); throw e; }
          const prefix = buffer.subarray(0, 4000).toString('utf8');
          if (/차단페이지|접근이 차단|Access Denied|Web Application Firewall/i.test(prefix)) throw error('ACCESS_DENIED');
          if (/type\s*=\s*["']password/i.test(prefix)) throw error('SESSION_REQUIRED');
          // 한글 파일은 그 형식을 받겠다고 한 어댑터(가천)에만 넘긴다. 그 밖에는 PDF만 통과한다.
          if (opts.formats?.includes('hwp') && !isPdf(buffer)) { if (!isHwp(buffer)) throw error('DOCUMENT_FORMAT_UNSUPPORTED'); }
          else validatePdf(buffer);
          // Large PDF bytes are not retained in the shared text cache.
          return buffer;
        }
        const html = await res.text();
        if (/차단페이지|접근이 차단|비정상적인 접근|Access Denied|Web Application Firewall/i.test(html.slice(0, 4000))) throw error('ACCESS_DENIED');
        if (/type\s*=\s*["']password/i.test(html)) throw error('SESSION_REQUIRED');
        if (path.includes('lawNewList.') && !parsePairs(html).length) throw error('UPSTREAM_FORMAT_CHANGED');
        if (path.includes('lawSerach.')) parseUniversitySearch(html);
        if (path.includes('searchEngineTotal.')) parseUniversitySearch(html, true);
        if (path.includes('lawFullContent.')) {
          const parsed = parseExternalContent(html);
          if (!parsed.title || !listArticleBlocks(parsed.markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
        }
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        // 한도를 넓힌 큰 목록(세종)은 원문을 캐시에 두지 않는다. 어댑터가 파싱한 목록만 보관한다.
        if (!disabled() && Buffer.byteLength(html, 'utf8') <= 2 * 1024 * 1024) cache.set(key, { at: now(), text: html });
        return html;
      } finally { clearTimeout(timer); }
    })();
    inflight.set(key, pending);
    const cleanup = () => { if (inflight.get(key) === pending) inflight.delete(key); };
    pending.then(cleanup, cleanup);
    return abortable(pending, signal);
  }
  return { request };
}

function sourceUrl(s, hit) {
  return `${s.origin}/lmxsrv/law/lawFullView.${s.ext}?SEQ=${hit.lawId}&SEQ_HISTORY=${hit.historyId}`;
}

async function loadExternal(source, topic, terms, client, signal, spec = {}, pdfOptions = {}) {
  const maxRules = ruleLimit(spec);
  // 자체 시스템 대학은 전용 어댑터로 위임(LawMaster 경로 로직을 타지 않는다).
  if (source.adapter === 'cau_pdf') {
    const result = await loadCau(source, topic, terms, client, signal, spec, {rankByTitle,maxRules:maxRules,latestAddendaEffective,safeCode,...pdfOptions});
    return {...result,coverage:{...result.coverage,scannedRules:result.rules.length,attemptedRules:result.rules.length+result.failures.length}};
  }
  if (source.adapter && MORE_ADAPTERS[source.adapter]) {
    const result = await MORE_ADAPTERS[source.adapter](source, topic, terms, client, signal, spec, {rankByTitle,maxRules:maxRules,htmlToArticleMarkdown,latestAddendaEffective,ruleRevisedAt,safeCode,...pdfOptions});
    return {...result,coverage:{...result.coverage,scannedRules:result.rules.length,attemptedRules:result.rules.length+result.failures.length}};
  }
  if (source.adapter && ADAPTERS[source.adapter]) {
    const result = await ADAPTERS[source.adapter](source, topic, terms, client, signal, spec);
    return { ...result, coverage: { ...result.coverage, scannedRules: result.rules.length, attemptedRules: result.rules.length + result.failures.length } };
  }
  let hits, coverage;
  const searchTerms = uniq(spec.searchTerms || [topic]).slice(0, 2), hints = spec.titleHints || terms;
  const deadline = Date.now() + 15000;
  const request = (path, body) => {
    if (signal?.aborted) throw error('TOTAL_TIMEOUT');
    if (Date.now() >= deadline) throw error('UPSTREAM_UNAVAILABLE');
    return client.request(source, path, body, deadline - Date.now(), signal);
  };
  // 제목 채널: 「전임교원 겸직허가에 관한 규정」처럼 사안을 전담하는 규정이 본문 검색에서는 다른 규정의
  // 조문에 밀려 상위 5개 밖으로 빠질 수 있다(서울시립 2026-11-25 확인). 제목 검색(대표어·첫 제목 단서)을
  // 먼저 돌려 후보에 넣고 가장 먼저 읽는다. 제목 검색 실패는 본문 검색으로 이어간다.
  // 기본은 대표어·첫 제목 단서만 제목 검색한다. 감시처럼 별칭을 모두 쓰려면 spec.titleQueries로 넘긴다.
  const titleQueries = uniq(spec.titleQueries || [terms[0], hints[0]]).filter(q => q && q.length >= 2).slice(0, 4);
  const searchAll = async (run, mode, runTitle) => {
    const merged = [], seen = new Set(), queries = [];
    let total = 0, pageCut = false, titleMatches = 0;
    if (runTitle) for (const q of titleQueries) {
      try {
        const result = await runTitle(q);
        for (const h of result.hits) if (!seen.has(h.lawId)) { seen.add(h.lawId); merged.push({ ...h, matchedBy: 'title' }); titleMatches++; }
      } catch (e) { if (['TOTAL_TIMEOUT', 'ACCESS_DENIED', 'SESSION_REQUIRED', 'REDIRECT_NOT_FOLLOWED'].includes(safeCode(e))) throw e; }
    }
    for (const q of searchTerms) {
      if (queries.length && merged.length >= maxRules) break;
      const result = await run(q);
      queries.push(q); total += result.total; if (result.total > result.hits.length) pageCut = true;
      for (const h of result.hits) if (!seen.has(h.lawId)) { seen.add(h.lawId); merged.push(h); }
    }
    hits = merged;
    // totalCandidates는 검색어별 결과 수의 합(중복 포함). 잘림은 결과 페이지 미수신 또는 상한 초과로 판단.
    coverage = { mode, queries, ...(runTitle ? { titleQueries, titleMatches } : {}), totalCandidates: total + titleMatches, truncated: pageCut || merged.length > maxRules };
  };
  const loadRecent = async () => {
    const pairs = parsePairs(await request(`/lmxsrv/law/lawNewList.${source.ext}`));
    if (!pairs.length) throw error('UPSTREAM_FORMAT_CHANGED');
    const named = pairs.filter(x => ruleTitleScore(x.title, terms, hints) > 0);
    // 최근 목록은 주제와 무관한 규정이 대부분이라, 제목 일치 규정 외에는 3개까지만 채워 읽는다.
    hits = [...named, ...pairs.filter(x => !named.includes(x))].slice(0, Math.max(3, Math.min(named.length, maxRules)));
    coverage = { mode: 'recent_list_only', totalCandidates: pairs.length, truncated: pairs.length > hits.length, complete: false };
  };
  if (source.mode === 'search') {
    const srv = type => async q => parseUniversitySearch(await request(`/lmxsrv/search/lawSerach.${source.ext}`,
      new URLSearchParams({ PAGE: '1', PAGE_SHOW: '10', LAWGROUP: '0', SEARCH_TYPE: type, SEARCH_TEXT: q }).toString()));
    await searchAll(srv('CONTENTS'), 'full_text_search', srv('LAWNAME'));
  } else if (source.mode === 'search_do') {
    const dot = type => async q => parseUniversitySearch(await request('/lmxsrv/search/searchEngineTotal.do',
      new URLSearchParams({ currentYN: '1', search_keyword: q, search_type: type, search_page: '1' }).toString()), true);
    await searchAll(dot('lawContents'), 'full_text_search_first_page', dot('lawName'));
  } else if (source.mode === 'tree') {
    let nodes = [];
    try { nodes = parseTree(await request(`/lmxsrv/law/lawTree.${source.ext}?${TREE_QUERY}`)); }
    catch (e) { if (['TOTAL_TIMEOUT'].includes(safeCode(e))) throw e; }
    if (nodes.length >= MIN_TREE_RULES) {
      // 제목만 대조하므로 제목에 주제어가 없는 규정 속 조문은 놓칠 수 있다(complete:false).
      hits = nodes.filter(x => ruleTitleScore(x.title, terms, hints) > 0);
      coverage = { mode: 'title_tree', totalCandidates: nodes.length, titleMatches: hits.length, truncated: hits.length > maxRules, complete: false };
    } else await loadRecent();
  } else if (source.mode === 'public_folders') {
    // 공개 분류 목록을 모두 읽어 제목을 대조한다. 목록 형식이 바뀌면 최근 목록으로 대체한다.
    const listed = [], seen = new Set(), folders = [];
    let formatChanged = false;
    for (const folder of source.folders || []) {
      let page = 1, total = 0, got = 0;
      try {
        do {
          const body = new URLSearchParams({ SEQ: String(folder), PAGE: String(page), PAGE_SHOW: String(FOLDER_PAGE_SIZE), LAWGROUP: '1', SHOW_YN: 'Y' }).toString();
          const result = parseFolderListing(await request(`/lmxsrv/law/lawListManager.${source.ext}`, body));
          total = result.total;
          for (const p of result.pairs) if (!seen.has(p.lawId)) { seen.add(p.lawId); listed.push({ ...p, folder }); }
          got += result.pairs.length;
          page++;
        } while (got < total && page <= MAX_FOLDER_PAGES);
        folders.push({ folder, total });
      } catch (e) {
        if (safeCode(e) !== 'UPSTREAM_FORMAT_CHANGED') throw e;
        formatChanged = true; break;
      }
    }
    if (!formatChanged && listed.length) {
      hits = listed.filter(x => ruleTitleScore(x.title, terms, hints) > 0);
      coverage = { mode: 'public_folder_list', totalCandidates: listed.length, folders, titleMatches: hits.length, truncated: hits.length > maxRules, complete: false, publicOnly: true, notice: PUBLIC_ONLY_NOTICE };
    } else await loadRecent();
  } else await loadRecent();
  const rules = [], failures = [];
  const query = compact(topic);
  const rank = hit => {
    const title = compact(hit.title.split(/제\s*\d+\s*조/)[0]).replace(/^[\d-]+/, '');
    return (hit.matchedBy === 'title' ? 50 : 0) + (title === query || title === query + '규정' ? 100 : title.includes(query) ? 30 : 0) + ruleTitleScore(hit.title, terms, hints) * 10 + titleSpecificityBonus(hit.title, topic, terms, hints);
  };
  hits.sort((a,b)=>rank(b)-rank(a));
  for (const hit of hits.slice(0, maxRules)) {
    try {
      const parsed = parseExternalContent(await request(`/lmxsrv/law/lawFullContent.${source.ext}?SEQ=${hit.lawId}&SEQ_HISTORY=${hit.historyId}`));
      if (!parsed.title || !listArticleBlocks(parsed.markdown).length) throw error('UPSTREAM_FORMAT_CHANGED');
      const fromAddenda = hit.effectiveAt ? null : latestAddendaEffective(parsed.markdown);
      rules.push({ ...hit, ...parsed, url: sourceUrl(source, hit), revisedAt: hit.revisedAt || null,
        effectiveAt: hit.effectiveAt || fromAddenda || null, effectiveSource: hit.effectiveAt ? 'list' : fromAddenda ? 'addenda' : null });
    } catch (e) {
      failures.push({ lawId: hit.lawId, historyId: hit.historyId, code: safeCode(e) });
      if (['ACCESS_DENIED', 'SESSION_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'REDIRECT_NOT_FOLLOWED', 'TOTAL_TIMEOUT'].includes(safeCode(e))) break;
    }
  }
  return { rules, failures, coverage: { ...coverage, scannedRules: rules.length, attemptedRules: rules.length + failures.length } };
}

function safeCode(e) {
  if (/^HTTP (401|403):/.test(e?.message || '')) return 'ACCESS_DENIED';
  return ['ACCESS_DENIED', 'SESSION_REQUIRED', 'REDIRECT_NOT_FOLLOWED', 'UPSTREAM_FORMAT_CHANGED', 'UPSTREAM_UNAVAILABLE', 'TOTAL_TIMEOUT', 'LAWGO_OC_NOT_CONFIGURED','PDF_INVALID','PDF_TOO_LARGE','PDF_TOO_MANY_PAGES','PDF_NO_TEXT','PDF_TEXT_TOO_LARGE','PDF_PARSE_BUSY','PDF_PARSE_FAILED','PDF_PARSE_TIMEOUT','PDF_NO_ARTICLES','PDF_REVISION_UNVERIFIED','DOCUMENT_FORMAT_UNSUPPORTED','HWP_PARSE_FAILED','HWP_NO_ARTICLES','ARTICLE_TEXT_UNAVAILABLE'].includes(e?.code) ? e.code : 'UPSTREAM_UNAVAILABLE';
}

// frame이 있으면 사안 프레임으로 조문을 거른다: 다른 사안의 규정·조문과 언급만 있는 조문은 dropped에
// 사유별 건수로 남기고, 남은 조문에는 규율 요소(slots)·주체·인용 법령·규정 역할(주/보조)을 붙인다.
// slotCells는 규율 요소별 대표 조문(상위 limit 밖의 조문도 포함)으로, 비교표를 만들 때 쓴다.
function selectArticles(rules, terms, limit, hints = terms, frame = null) {
  const matches = [], dropped = {};
  const perRule = new Map();
  for (const rule of rules) {
    const titleScore = ruleTitleScore(rule.title, terms, hints), ruleBonus = titleScore * 0.5;
    const entry = { universityRule: rule.title, lawId: rule.lawId, historyId: rule.historyId, url: rule.url, slots: new Set(), titleScore };
    for (const block of listArticleBlocks(rule.markdown)) {
      if (block.supplementary) continue;
      const matchedTerms = terms.filter(t => block.content.includes(t));
      if (!matchedTerms.length) continue;
      // 조문 제목(첫 줄)에 주제어가 있으면 그 조문이 주제를 직접 다룬다고 보고 앞에 둔다.
      const heading = block.content.split('\n')[0];
      let score = matchedTerms.length + (matchedTerms.includes(terms[0]) ? 0.5 : 0) + (terms.some(t => heading.includes(t)) ? 2 : 0) + ruleBonus;
      const analysis = frame ? analyzeArticle(block, rule, frame) : null;
      if (analysis?.excluded) { dropped[analysis.excluded] = (dropped[analysis.excluded] || 0) + 1; continue; }
      if (analysis) { score += analysis.slots.length * 1.5; for (const s of analysis.slots) entry.slots.add(s.key); }
      if (!perRule.has(rule)) perRule.set(rule, entry);
      matches.push({ universityRule: rule.title, lawId: rule.lawId, historyId: rule.historyId,
        article: block.canonical, text: block.content.slice(0, 2000), textTruncated: block.content.length > 2000,
        ...(rule.originalPdfUrl ? {originalPdfUrl:rule.originalPdfUrl,sourceType:rule.sourceType} : {}),
        ...(rule.upcomingRevisionAt ? {upcomingRevisionAt:rule.upcomingRevisionAt} : {}),
        matchedTerms, url: rule.url, revisedAt: rule.revisedAt || null, effectiveAt: rule.effectiveAt || null,
        effectiveSource: rule.effectiveAt ? rule.effectiveSource || null : null,
        ...(analysis ? { slots: analysis.slots, subjects: analysis.subjects, anchorLaws: analysis.anchorLaws } : {}), _score: score });
    }
  }
  matches.sort((a, b) => b._score - a._score);
  const base = { articles: matches.slice(0, limit), matchingArticles: matches.length, articlesTruncated: matches.length > limit };
  if (!frame) { for (const m of matches) delete m._score; return base; }
  const roles = assignRoles([...perRule.values()].map(e => ({ ...e, slots: [...e.slots] })), e => e.titleScore);
  const roleOf = new Map(roles.map(r => [r.lawId, r.role]));
  const slotCells = {}, anchorLaws = new Map();
  for (const m of matches) {
    m.role = roleOf.get(m.lawId) || 'secondary';
    // 요소별 대표 조문: 주규정 > 조문 제목이 그 요소를 다루는 조문(제7조(겸직 기간) 등) > 점수 순.
    for (const s of m.slots) {
      const cur = slotCells[s.key], rank = (role, inHeading, score) => (role === 'primary' ? 1000 : 0) + (inHeading ? 100 : 0) + score;
      if (!cur || rank(m.role, s.inHeading, m._score) > cur._rank) {
        slotCells[s.key] = { universityRule: m.universityRule, article: m.article, role: m.role, evidence: s.evidence, url: m.url, effectiveAt: m.effectiveAt, _rank: rank(m.role, s.inHeading, m._score) };
      }
    }
    for (const law of m.anchorLaws) {
      const key = law.lawName.replace(/\s+/g, '');
      const cur = anchorLaws.get(key) || { lawName: law.lawName, articles: [], inFrame: law.inFrame, citedBy: [] };
      for (const art of law.articles) if (!cur.articles.includes(art)) cur.articles.push(art);
      const ref = `${m.universityRule} ${m.article}`;
      if (!cur.citedBy.includes(ref)) cur.citedBy.push(ref);
      anchorLaws.set(key, cur);
    }
  }
  for (const cell of Object.values(slotCells)) delete cell._rank;
  for (const m of matches) delete m._score;
  const droppedTotal = Object.values(dropped).reduce((a, b) => a + b, 0);
  return { ...base, rules: roles.map(({ titleScore, ...r }) => r), slotCells, anchorLaws: [...anchorLaws.values()],
    dropped: { count: droppedTotal, reasons: Object.fromEntries(Object.entries(dropped).map(([k, v]) => [k, { count: v, label: DROP_LABELS[k] || k }])) } };
}

// 타대학 비교는 기본으로 켜져 있다. 운영자가 DONGGUK_UNIVERSITY_COMPARISON_ENABLED=0으로만 끈다.
function comparisonEnabled() { return process.env.DONGGUK_UNIVERSITY_COMPARISON_ENABLED !== '0'; }
// 열 단위 실패 중 운영자 설정으로 풀리는 것은 무엇이 없고 어떻게 넣는지 함께 알린다. 키 값은 넣지 않는다.
const COLUMN_GUIDES = {
  LAWGO_OC_NOT_CONFIGURED: { env: ['DONGGUK_LAWGO_OC'], ocApplyUrl: 'https://open.law.go.kr',
    notice: '서울대 규정은 국가법령정보센터 Open API로 조회하는데, 이 서버에 인증키(OC)가 없어 서울대만 건너뛰었습니다. 다른 대학 결과는 그대로입니다. 서버 운영자가 https://open.law.go.kr 에서 OC를 신청해 환경변수 DONGGUK_LAWGO_OC에 넣으면 서울대도 조회됩니다.' },
};

const publicClient = createPublicClient();
async function compareUniversityRules(a, { loadDongguk, client = publicClient, now = () => new Date(), totalTimeoutMs = TOTAL_TIMEOUT_MS, loadExternalImpl = loadExternal } = {}) {
  const invalid = validateArguments(a);
  if (invalid) throw Object.assign(new Error(invalid), { code: 'INVALID_ARGUMENT' });
  const topic = a.topic.trim(), spec = expandTopic(topic), terms = spec.terms, columns = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
  try {
  // Sequential schools bound upstream concurrency and preserve deterministic order.
  for (const key of ['dongguk', ...new Set(a.universities)]) {
    const source = SOURCES.find(x => x.key === key);
    if (!source) { columns.push({ university: key, status: 'unsupported', articles: [] }); continue; }
    try {
      if (controller.signal.aborted) throw error('TOTAL_TIMEOUT');
      const result = await abortable(key === 'dongguk' ? loadDongguk(topic, terms, {signal:controller.signal, searchTerms:spec.searchTerms, titleHints:spec.titleHints}) : loadExternalImpl(source, topic, terms, client, controller.signal, spec), controller.signal);
      const selected = selectArticles(result.rules, terms, a.max_articles || 3, spec.titleHints, spec.frame);
      const partial = result.coverage.complete === false || result.coverage.truncated || result.failures.length > 0 || selected.articlesTruncated || selected.articles.some(x => x.textTruncated);
      columns.push({ university: key, name: source.name, status: result.rules.length === 0 && result.failures.length ? 'unavailable' : selected.articles.length ? (partial ? 'partial' : 'retrieved') : 'no_match_in_scope', ...selected, coverage: result.coverage, failures: result.failures });
    } catch (e) { const code = safeCode(e), guide = COLUMN_GUIDES[code]; columns.push({ university: key, name: source.name, status: 'unavailable', code, ...(guide ? { notice: guide.notice, setup: { env: guide.env, ocApplyUrl: guide.ocApplyUrl } } : {}), articles: [] }); }
  }
  const frame = spec.frame;
  const slotMatrix = frame ? buildSlotMatrix(frame, columns) : undefined;
  for (const c of columns) delete c.slotCells;
  return { topic, terms, searchTerms: spec.searchTerms, checkedAt: now().toISOString(), status: columns.every(x => x.status === 'retrieved') ? 'retrieved' : 'partial', columns,
    alignment: frame ? 'issue_frame_slots_not_legal_equivalence' : 'topic_keyword_matches_not_legal_equivalence',
    issueFrame: frame ? frameSummary(frame) : null, ...(slotMatrix ? { slotMatrix } : {}),
    notice: (frame ? `${NOTICE} ${FRAME_NOTICE}` : NOTICE) + (a.universities.includes('cau') ? ` ${PDF_NOTICE}` : '') + (a.universities.some(key => DOCUMENT_KEYS.includes(key)) ? ` ${DOCUMENT_NOTICE}` : ''), supportedTopics: FRAMES.map(f => f.topic),
    supportedUniversities: SOURCES.map(x => ({ key: x.key, name: x.name, scope: x.mode, ...(x.mode === 'public_folders' ? { publicOnly: true } : {}) })), limits:{totalTimeoutMs,externalRulesPerUniversity:MAX_RULES,minRequestIntervalMs:500} };
  } finally { clearTimeout(timer); }
}

function formatComparison(data) {
  const esc = v => String(v ?? '미확인').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const lines = [`# 대학 규정 비교: ${data.topic}`, data.notice, `조회: ${data.checkedAt} / 상태: ${data.status}`, '',
    '| 항목 | ' + data.columns.map(c => esc(c.name || c.university)).join(' | ') + ' |',
    '|---|' + data.columns.map(() => '---|').join(''),
    '| 상태 | ' + data.columns.map(c => esc(c.status + (c.code ? ` (${c.code})` : '') + (c.coverage?.publicOnly ? ' — 공개 규정만' : ''))).join(' | ') + ' |'];
  const roleTag = a => a.role ? (a.role === 'primary' ? '[주규정] ' : '[보조] ') : '';
  if (data.issueFrame) {
    lines.push('| 주규정 | ' + data.columns.map(c => {
      const primary = (c.rules || []).filter(r => r.role === 'primary');
      return primary.length ? esc(primary.map(r => r.universityRule).join(', ')) : c.articles.length ? '없음(보조규정만)' : '—';
    }).join(' | ') + ' |');
    lines.push('| 제외 조문 | ' + data.columns.map(c => c.dropped?.count ? esc(Object.values(c.dropped.reasons).map(r => `${r.label} ${r.count}`).join(', ')) : '0').join(' | ') + ' |');
  }
  for (let i = 0; i < Math.max(0, ...data.columns.map(c => c.articles.length)); i++) {
    lines.push(`| 발췌 ${i + 1} | ` + data.columns.map(c => {
      const a = c.articles[i];
      return a ? `${roleTag(a)}${esc(a.universityRule)} ${esc(a.article)}<br>${esc(a.text.slice(0,240))}${a.text.length>240 ? ' …(본문 아래)' : ''}<br>개정일 ${esc(a.revisedAt)} / ${effectiveLabel(a)}<br>[원문](${a.url})` : '범위 내 발췌 없음';
    }).join(' | ') + ' |');
  }
  if (data.issueFrame && data.slotMatrix) {
    const f = data.issueFrame;
    lines.push('', `## 사안 프레임: ${f.label}`, `주체 후보: ${f.subjects.join(', ')} / 사안어: ${f.terms.join(', ')}`,
      f.upperLaws.length ? `근거 법령 후보: ${f.upperLaws.map(l => l.lawName + (l.articles.length ? ` ${l.articles.join('·')}` : '')).join('; ')}` : '근거 법령 후보: 등록 없음',
      f.excluded.title.length || f.excluded.article.length ? `제외 기준: 규정명 ${f.excluded.title.join('·') || '없음'} / 조문 ${f.excluded.article.join('·') || '없음'}` : '',
      '', '### 규율 요소 대조', '| 규율 요소 | ' + data.columns.map(c => esc(c.name || c.university)).join(' | ') + ' |', '|---|' + data.columns.map(() => '---|').join(''));
    for (const slot of data.slotMatrix.slots) {
      lines.push(`| ${esc(slot.label)} | ` + data.columns.map(c => {
        const cell = slot.cells[c.university];
        if (!cell || cell.status === 'not_found_in_scope') return '범위 내 없음';
        if (cell.status !== 'found') return `조회 불가 (${cell.status})`;
        return `${cell.role === 'primary' ? '[주규정] ' : ''}${esc(cell.universityRule)} ${esc(cell.article)}<br>${esc(cell.evidence.slice(0, 160))}${cell.evidence.length > 160 ? '…' : ''}`;
      }).join(' | ') + ' |');
    }
    lines.push('| 인용 법령 | ' + data.columns.map(c => {
      const laws = data.slotMatrix.anchorLaws[c.university] || [];
      return laws.length ? esc(laws.map(l => `${l.inFrame ? '◎' : '○'} ${l.lawName}${l.articles.length ? ' ' + l.articles.join('·') : ''}`).join('<br>')) : '조문 내 인용 없음';
    }).join(' | ') + ' |', '◎ 프레임의 근거 법령과 일치, ○ 그 밖의 인용 법령. 인용의 존재와 적용 여부는 다릅니다.');
  }
  for (const c of data.columns) {
    if (!c.articles.length) continue;
    lines.push('', `## ${c.name || c.university} 조문 본문`);
    for (const a of c.articles) lines.push('', `### ${roleTag(a)}${a.universityRule} ${a.article}`, a.slots?.length ? `규율 요소: ${a.slots.map(s => s.label).join(', ')}` : '', a.text, a.textTruncated ? '[2,000자 제한으로 잘림]' : '', `[원문](${a.url})`, a.originalPdfUrl ? `[${a.sourceType === '한글 파일 본문' ? '원문 파일' : 'PDF 원문'}](${a.originalPdfUrl})` : '', a.upcomingRevisionAt ? `시행 예정 개정본이 있습니다(${a.upcomingRevisionAt}). 여기 보인 것은 그 이전 개정본입니다.` : '');
  }
  for (const c of data.columns) if (c.notice && c.status === 'unavailable') lines.push('', `- ${c.name || c.university}: ${c.notice}`);
  // 본문을 읽지 못한 조문과 현행본을 확인하지 못한 규정은 건수만이 아니라 무엇인지 적는다.
  for (const c of data.columns) {
    if (c.coverage?.discoveryScope && c.coverage.notice) lines.push('', `- ${c.name || c.university}: ${c.coverage.notice}`);
    const unread = (c.failures || []).filter(f => f.code === 'ARTICLE_TEXT_UNAVAILABLE' && f.article);
    if (unread.length) lines.push('', `- ${c.name || c.university}: 본문을 읽지 못해 비교에서 뺀 조문 ${unread.length}건 — ${unread.map(f => `${f.article}(${f.reason === 'image_only' ? '본문이 그림뿐' : '본문 없음'})`).join(', ')}. 제목만으로 내용을 확인한 것이 아니므로 원문에서 확인하세요.`);
    const stale = (c.failures || []).filter(f => f.stage === 'revision_confirmation');
    const why = f => f.reason === 'CONFIRMATION_PAGES_UNREAD' ? '검색 결과가 조회 상한을 넘음' : f.reason === 'TITLE_NOT_FOUND' ? '규정명 검색에서 찾지 못함' : `재확인 요청 실패: ${f.code}`;
    if (stale.length) lines.push('', `- ${c.name || c.university}: 현행 개정본을 확인하지 못해 조회하지 않은 규정 ${stale.length}건 — ${stale.map(f => `${f.title}(${why(f)})`).join(', ')}.`);
    if (c.coverage?.currentRevisionUnverified > stale.length) lines.push('', `- ${c.name || c.university}: 조회가 중단되어 현행 개정본 확인을 시도하지 못한 규정 ${c.coverage.currentRevisionUnverified - stale.length}건.`);
  }
  lines.push('', ...data.columns.map(c => `- ${c.name || c.university}: ${c.coverage ? JSON.stringify(c.coverage) : c.status}${c.failures?.length ? ` / 실패 ${c.failures.length}건` : ''}${c.dropped?.count ? ` / 프레임 제외 ${c.dropped.count}건` : ''}`));
  return lines.filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');
}

function effectiveLabel(a) {
  if (!a.effectiveAt) return '시행일 미확인';
  return `시행일 ${a.effectiveAt} (${a.effectiveSource === 'list' ? '규정 목록 시행일자' : '마지막 부칙 명시 시행일'})`;
}

module.exports = { comparisonEnabled, SOURCES, TOPICS, FRAMES, MAX_RULES, TOTAL_TIMEOUT_MS, PUBLIC_ONLY_NOTICE, FRAME_NOTICE, parsePairs, parseFolderListing, parseTree, parseUniversitySearch, parseExternalContent, createPublicClient, validateArguments, selectArticles, compareUniversityRules, formatComparison, loadExternal, safeCode, expandTopic, cleanListTitle, latestAddendaEffective, ruleTitleScore, titleSpecificityBonus, titleMatchesTopic, htmlToArticleMarkdown, latestRevisionDate };

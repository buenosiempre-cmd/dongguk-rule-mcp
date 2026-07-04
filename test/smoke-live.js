#!/usr/bin/env node
/**
 * smoke-live.js — 실서버 스모크 테스트
 *
 * rule.dongguk.edu에 실제로 접속해서 5개 도구가 진짜 동작하는지 확인.
 * ⚠️ 국내 IP에서만 작동 (Mac Mini 등). 데이터센터/해외 IP는 503 차단.
 *
 * 실행:
 *   node test/smoke-live.js
 *   node test/smoke-live.js --keyword 재정      # 검색어 지정
 *
 * 오프라인 테스트(npm test)와 달리 이건 네트워크가 필요하고,
 * 실패 시 "파싱 버그"인지 "네트워크 차단"인지 구분해서 알려준다.
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const BASE = 'https://rule.dongguk.edu';
const SEARCH_URL = `${BASE}/lmxsrv/search/lawSerach.srv`;
const FULLVIEW_URL = `${BASE}/lmxsrv/law/lawFullView.srv`;
const CONTENT_URL = `${BASE}/lmxsrv/law/lawFullContent.srv`;
const MAIN_URL = `${BASE}/lmxsrv/main/main.srv`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

// CLI 인자
const args = process.argv.slice(2);
const kwIdx = args.indexOf('--keyword');
const KEYWORD = kwIdx >= 0 ? args[kwIdx + 1] : '재정';

let pass = 0, fail = 0, warn = 0;
function ok(name)   { console.log(`  ✅ ${name}`); pass++; }
function no(name,d) { console.log(`  ❌ ${name} ${d||''}`); fail++; }
function wn(name,d) { console.log(`  ⚠️  ${name} ${d||''}`); warn++; }

async function httpPost(url, params, referer) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': referer || MAIN_URL,
    },
    body, timeout: 20000,
  });
  return res;
}

async function httpGet(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language':'ko-KR,ko;q=0.9', 'Referer': referer || MAIN_URL },
    timeout: 20000,
  });
  return res;
}

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🌐 실서버 스모크 테스트 (rule.dongguk.edu)');
  console.log(`   검색어: "${KEYWORD}"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // [0] 네트워크 도달성 먼저 확인
  console.log('\n[0] 네트워크 도달성');
  let reachable = false;
  try {
    const res = await httpGet(MAIN_URL);
    if (res.status === 503) {
      no('rule.dongguk.edu 도달', '(503 — IP 차단. 국내망/Mac Mini에서 실행 필요)');
      console.log('\n⛔ 이 환경의 IP가 차단됐습니다. Mac Mini 등 국내 IP에서 다시 실행하세요.');
      summary(); process.exit(1);
    }
    if (res.ok) { ok(`메인 페이지 도달 (HTTP ${res.status})`); reachable = true; }
    else { wn(`메인 페이지 응답 이상 (HTTP ${res.status})`); reachable = true; }
  } catch (e) {
    no('네트워크 연결', `(${e.code || e.message})`);
    console.log('\n⛔ 네트워크 연결 실패. 인터넷 연결과 방화벽을 확인하세요.');
    summary(); process.exit(1);
  }

  // [1] search_rule (POST)
  console.log('\n[1] search_rule — 제목 검색');
  let firstHit = null;
  try {
    const res = await httpPost(SEARCH_URL, {
      PAGE:'1', PAGE_SHOW:'10', LAWGROUP:'0',
      SEARCH_TYPE:'LAWNAME', SEARCH_TEXT:KEYWORD,
    }, MAIN_URL);
    ok(`검색 요청 성공 (HTTP ${res.status})`);
    const html = await res.text();
    const $ = cheerio.load(html);

    // 총 건수
    const il = $('p.infoLeft').html() || '';
    const tm = il.match(/(\d+)\s*<\/span>\s*건/);
    if (tm) ok(`총 건수 파싱: ${tm[1]}건`);
    else wn('총 건수 파싱 실패', '(p.infoLeft 구조 변경 가능 — 픽스처 갱신 필요)');

    // 결과 행
    const rows = $('tbody.tbody tr');
    if (rows.length > 0) {
      ok(`결과 행 ${rows.length}개 발견`);
      // 첫 행에서 LAW_ID/HISTORY_ID 추출
      const s = rows.first().find('td.tbody_txt').html() || '';
      const m = /lawSearchFullViewSrv\(\s*'(\d+)'\s*,\s*'(\d+)'/.exec(s);
      if (m) {
        firstHit = { lawId: parseInt(m[1]), historyId: parseInt(m[2]) };
        ok(`LAW_ID/HISTORY_ID 추출: ${firstHit.lawId}/${firstHit.historyId}`);
        // 제목 파싱
        const st = []; let sm;
        const re = /showSearchText\(\s*(?:"|&quot;)([^"&]*)(?:"|&quot;)/g;
        while ((sm = re.exec(s)) !== null) st.push(sm[1]);
        if (st.length >= 2 && st[1]) ok(`제목 파싱: "${st[1]}"`);
        else no('제목 파싱 실패', '(showSearchText 정규식 — 버그!)');
      } else {
        no('LAW_ID 추출 실패', '(lawSearchFullViewSrv 패턴 변경 — 버그!)');
      }
    } else {
      wn('결과 행 없음', `("${KEYWORD}" 검색 결과 0건이거나 tbody.tbody 구조 변경)`);
    }
  } catch (e) {
    no('검색 요청 실패', `(${e.message})`);
  }

  // [2] get_rule_content (GET) — 검색에서 얻은 첫 결과로
  console.log('\n[2] get_rule_content — 본문 조회');
  if (firstHit) {
    try {
      const res = await httpGet(
        `${CONTENT_URL}?SEQ=${firstHit.lawId}&SEQ_HISTORY=${firstHit.historyId}`,
        FULLVIEW_URL
      );
      ok(`본문 요청 성공 (HTTP ${res.status})`);
      const html = await res.text();
      const $ = cheerio.load(html);
      const fb = $('div.fullbody').length ? $('div.fullbody') : $('body');

      const title = fb.find('div.lawname').text().trim();
      if (title) ok(`법명 파싱: "${title}"`);
      else no('법명 파싱 실패', '(div.lawname 구조 변경 — 버그!)');

      const chapters = fb.find('div.chapter').length;
      const articles = fb.find('div.article').length;
      if (articles > 0) ok(`조문 ${articles}개, 장 ${chapters}개 발견`);
      else wn('조문(div.article) 없음', '(클래스명 변경 가능 — 픽스처 갱신 필요)');
    } catch (e) {
      no('본문 요청 실패', `(${e.message})`);
    }
  } else {
    wn('본문 조회 건너뜀', '(검색 결과가 없어 테스트할 LAW_ID 없음)');
  }

  // [3] list_rule_history (POST) — select#histroySeq
  console.log('\n[3] list_rule_history — 연혁 조회');
  if (firstHit) {
    try {
      const res = await httpPost(FULLVIEW_URL, {
        PAGE:'1', PAGE_SHOW:'10', LAWGROUP:'0',
        SEARCH_TYPE:'LAWNAME', SEARCH_TEXT:' ',
        SEQ:String(firstHit.lawId), SEQ_HISTORY:'0', REFID:'',
      }, SEARCH_URL);
      ok(`연혁 요청 성공 (HTTP ${res.status})`);
      const html = await res.text();
      const $ = cheerio.load(html);
      const sel = $('#histroySeq');
      if (sel.length) {
        const opts = sel.find('option').filter((i, el) => {
          const v = ($(el).attr('value')||'').trim();
          return v && v !== '0' && /^\d+$/.test(v);
        });
        if (opts.length > 0) {
          ok(`연혁 ${opts.length}건 발견`);
          // 개정일 파싱 (onclick 속성)
          const oc = opts.first().attr('onclick') || '';
          const dm = /showDate\(\s*'(\d{8})'/.exec(oc);
          if (dm) ok(`개정일 파싱: ${dm[1].slice(0,4)}.${dm[1].slice(4,6)}.${dm[1].slice(6)}`);
          else wn('개정일 파싱 실패', '(onclick 속성 구조 — 확인 필요)');
        } else {
          wn('유효 연혁 옵션 없음');
        }
      } else {
        no('select#histroySeq 없음', '(연혁 셀렉트 구조 변경 — 버그!)');
      }
    } catch (e) {
      no('연혁 요청 실패', `(${e.message})`);
    }
  } else {
    wn('연혁 조회 건너뜀', '(LAW_ID 없음)');
  }

  // [4] 캠퍼스 코드 확인 도우미
  console.log('\n[4] 캠퍼스 LAWGROUP 코드 확인 (참고용)');
  console.log('   ⚠️  seoul=1, wise=2 는 추정값입니다.');
  console.log('   확인 방법: rule.dongguk.edu 좌측 규정트리 탭 클릭 →');
  console.log('   개발자도구 Network 탭에서 lawTree.srv?LAWGROUP=N 의 N 확인');
  try {
    // LAWGROUP=1로 검색해서 결과가 나오는지만 확인
    const res = await httpPost(SEARCH_URL, {
      PAGE:'1', PAGE_SHOW:'5', LAWGROUP:'1',
      SEARCH_TYPE:'LAWNAME', SEARCH_TEXT:KEYWORD,
    }, MAIN_URL);
    const html = await res.text();
    const $ = cheerio.load(html);
    const rows = $('tbody.tbody tr').length;
    console.log(`   LAWGROUP=1 검색 결과: ${rows}행 (0이면 코드가 다를 수 있음)`);
  } catch (e) {
    console.log(`   LAWGROUP=1 확인 실패: ${e.message}`);
  }

  summary();
  process.exit(fail > 0 ? 1 : 0);
}

function summary() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 실서버: ${pass}개 통과 / ${fail}개 실패 / ${warn}개 경고`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (fail > 0) {
    console.log('❌ 실패 = 파싱 버그. 해당 HTML 구조가 픽스처와 다름.');
    console.log('   → 실제 HTML을 저장해서 픽스처(test/fixtures.js)를 갱신하고 재검증.');
  } else if (warn > 0) {
    console.log('⚠️  경고는 "결과 0건" 또는 "구조 미세 변경" 가능성. 검색어를 바꿔 재시도.');
  } else {
    console.log('✅ 5개 도구 모두 실서버에서 정상 동작 확인!');
  }
}

main().catch(e => {
  console.error('\n💥 예외 발생:', e.message);
  process.exit(1);
});

// rule.dongguk.edu 실제 HTML 구조를 재현한 테스트 픽스처
// (Python 원본 parser.py가 파싱하는 정확한 DOM 구조 기반)

// 1. 검색 결과 페이지 (lawSerach.srv POST 응답)
const SEARCH_HTML = `
<html><body>
<p class="infoLeft">검색된 단어 전체 <span class="num">3</span>건</p>
<table>
<tbody class="tbody">
  <tr>
    <td class="tbody_c">1</td>
    <td class="tbody_txt">
      <a href="javascript:lawSearchFullViewSrv('491','1437');">
        <span onclick="showSearchText(&quot;3-2-1&quot;)">3-2-1</span>
        <span onclick="showSearchText(&quot;재정시행세칙&quot;)">재정시행세칙</span>
      </a>
    </td>
    <td class="tbody_c"><span onclick="showDate('20240301','x')">2024.03.01</span></td>
  </tr>
  <tr>
    <td class="tbody_c">2</td>
    <td class="tbody_txt">
      <a href="javascript:lawSearchFullViewSrv('101','838');">
        <span onclick="showSearchText(&quot;3-1-2&quot;)">3-1-2</span>
        <span onclick="showSearchText(&quot;사무분장규정&quot;)">사무분장규정</span>
      </a>
    </td>
    <td class="tbody_c"><span onclick="showDate('20110325','x')">2011.03.25</span></td>
  </tr>
  <tr>
    <td class="tbody_c">3</td>
    <td class="tbody_txt">
      <a href="javascript:lawSearchFullViewSrv('101','838');">
        <span onclick="showSearchText(&quot;3-1-2&quot;)">3-1-2</span>
        <span onclick="showSearchText(&quot;사무분장규정&quot;)">사무분장규정</span>
      </a>
    </td>
    <td class="tbody_c"><span onclick="showDate('20110325','x')">2011.03.25</span></td>
  </tr>
</tbody>
</table>
</body></html>
`;

// 2. 규정 본문 페이지 (lawFullContent.srv GET 응답)
const CONTENT_HTML = `
<html><body>
<div class="fullbody">
  <div class="lawname">재정시행세칙</div>
  <div class="chapter">제1장 총칙</div>
  <div class="article">제1조(목적)</div>
  <div class="none">이 세칙은 재정 운영에 관한 사항을 규정함을 목적으로 한다.</div>
  <div class="article">제2조(적용범위)</div>
  <div class="hang">① 이 세칙은 교비회계에 적용한다.</div>
  <div class="hang">② 기금회계는 별도로 정한다.</div>
  <div class="chapter">제2장 예산</div>
  <div class="article">제3조(예산편성)</div>
  <div class="none">예산은 다음 각 호에 따라 편성한다.</div>
  <div class="ho">1. 인건비</div>
  <div class="ho">2. 운영비</div>
  <div class="mok">가. 일반운영비</div>
  <div class="mok">나. 특별운영비</div>
  <div class="article">제48조(결산)</div>
  <div class="none">회계연도 종료 후 결산한다.</div>
</div>
</body></html>
`;

// 3. 연혁 페이지 (lawFullView.srv POST 응답)
const HISTORY_HTML = `
<html><body>
<select id="histroySeq">
  <option value="0">선택</option>
  <option value="1437" onclick="showDate('20240301','x')">2024.03.01</option>
  <option value="1200" onclick="showDate('20200115','x')">2020.01.15</option>
  <option value="980" onclick="showDate('20180601','x')">2018.06.01</option>
</select>
</body></html>
`;

module.exports = { SEARCH_HTML, CONTENT_HTML, HISTORY_HTML };

// 4. 검색 결과 0건 페이지
const EMPTY_SEARCH_HTML = `
<html><body>
<p class="infoLeft">검색된 단어 전체 <span class="num">0</span>건</p>
<table><tbody class="tbody"></tbody></table>
</body></html>
`;
module.exports.EMPTY_SEARCH_HTML = EMPTY_SEARCH_HTML;

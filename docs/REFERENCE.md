# 운영·조회 참고

소개용 [README](../README.md)를 재구성하면서, 그 전에 README에 있던 문장 전체를 이 문서로 옮겼습니다. 응답 필드, 전문·상위법령 계약, 공용 서버 경로, 타대학 비교 범위가 포함됩니다. 첫 연결과 사용 장면은 README를, 구성원 안내는 [COP_GUIDE.md](COP_GUIDE.md), 서버 운영은 [OPERATIONS.md](OPERATIONS.md)를 보세요.

---

# 동국 규정 MCP

동국대학교 구성원이 AI에서 [공식 통합규정관리시스템](https://rule.dongguk.edu/)의 규정·조문·별표·개정 이력을 찾는 읽기 전용 MCP 서버입니다. **기본 `rules` 프로필은 공개 규정용**이며, 내부 재무지식 기능은 별도 `finance` 프로필로 선택합니다.

[구성원 시작 페이지](https://dgu.kr-univ-rules.com/guide) · [상세 사용 가이드](COP_GUIDE.md) · [운영 가이드](OPERATIONS.md) · [CoP 평가 가이드](EVALUATION.md) · [GitHub 릴리스](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/tag/v0.15.8)

**v0.12.0**은 HWP 원문을 우선해 조문을 비교하고, 표의 셀 좌표·병합 범위·값과 포함된 그림의 파일 내용을 함께 비교합니다. 문서마다 실제 추출 범위와 미지원 항목을 표시하며, HWP를 읽지 못해 HTML로 대체한 결과는 부분 비교로 남깁니다. [v0.12.0 변경 기록](RELEASE-v0.12.0.md)에서 범위를 확인하세요. 출장비·외부 강사료의 교내 규정·한국법령 공동 조회 기능은 유지합니다. [자동 법령 연계 안내](AUTO_LEGAL_INTEGRATION.md) · [v0.10.4 변경 기록](review-2026-10-27.md) · [이전 개선 기록](review-2026-10-07.md) · [빠른 사용과 운영 설정](PERFORMANCE.md)

개발판 **v0.14.0**은 규정이 인용한 국가 법령 조문의 원문을 함께 가져오는 `get_rule_references(include_law_text=true)`와, 최근 개정된 규정과 변경 조문을 정리해 Slack에 올리는 `npm run weekly-updates`를 추가했습니다.

**v0.15.8**은 타대학 대표 규정의 개정일·본문 지문·조회 실패를 직전 기록과 비교하는 `university-watch`와, 사용 중 비교 실패를 집계하는 선택적 사용 로그를 추가합니다. 캐시 10분은 유지하고 본문은 장기 저장하지 않습니다. 기본은 출력만 하며 실제 Slack 게시에는 `--post`가 필요합니다. [변경 기록](../CHANGELOG.md)

이전 v0.15.7은 타대학 비교에 홍익(`hongik`)·한양(`hanyang`)·성균관(`skku`)·세종(`sejong`)·가천(`gachon`)을 추가합니다. 공개된 목록·본문만 읽고 조문만 비교하며, 별표·표·그림 본문은 비교 근거로 올리지 않습니다. 한국외대와 상명대는 넣지 않았습니다. [변경 기록](../CHANGELOG.md)

이전 v0.15.6은 타대학 비교에 중앙대(`cau`) PDF 조문 어댑터를 더합니다. 목록 개정일과 PDF 경로를 대조해 첨부를 고르고, 비교 범위는 조문으로 유지하며 표·별표·부록·서식은 PDF 원문에서 확인하도록 안내합니다. [변경 기록](../CHANGELOG.md)

이전 v0.15.5는 `get_rule_upper_laws(include_text=true)`로 규정 조문 원문과 인용한 현행 국가 법령 조문 원문을 나란히 보여 줍니다. 잘림·미확보·생략은 부분 조회로 남기고, 충돌·적용 여부는 판정하지 않습니다. [변경 기록](../CHANGELOG.md)

이전 v0.15.4는 지정한 규정의 조문·부칙·별표·서식 전문을 HWP 우선으로 돌려주는 `get_rule_full_text`를 추가합니다. 긴 문서는 같은 개정본·출처·추출문 해시의 cursor로 이어 받고, 일부 전달·HTML 대체·추출 누락은 부분 조회로 남깁니다. 공개 도구는 15개입니다. [변경 기록](../CHANGELOG.md)

이전 v0.15.3은 자연어 질문의 어미·의문사를 정리하고 규정 용어로 검색을 넓힙니다. 모호한 후보는 최대 3개 규정의 미확정 발췌로 보여 주며, 명시한 발췌 조건·조문 선택자와 기관·캠퍼스 범위를 보존합니다. 반환 개수에 맞는 선택 상태와 별도 실조회 평가 스크립트도 포함합니다. [변경 기록](../CHANGELOG.md)

이전 v0.15.2는 근거 조회 상태가 실제보다 좋게 표시되던 문제를 고쳤습니다. 재무 근거 조회(`get_finance_evidence`, `review_finance_case`)는 하위 규정 조회가 일부 조회면 그대로 일부 조회로 표시하고, `get_rule_upper_laws`는 법령 본문이 잘리거나 오지 않은 경우를 `textCoverage`로 따로 알립니다. 새 기능은 없습니다. [변경 기록](../CHANGELOG.md)

이전 개발판 v0.15.1은 타대학 규정 비교를 크게 넓혔습니다. 같은 사안을 규정명이 아니라 주체·행위·규율 요소로 정의한 **사안 프레임**(겸직·여비·연구비·등록금 반환·퇴직급여·근로장학·장학금)으로 조문을 고르고 규율 요소 × 대학 대조표를 보여 주며, 규정 제목 검색을 먼저 돌려 전담 규정을 찾습니다. 비교 대상은 경희·숙명여대·광운·명지·서강·이화·서울대(OC 키 필요)·연세가 더해져 13곳이고, 고려대는 공개 규정 범위만 조회합니다. 규정명이 없는 자연어 질문이 30초 뒤 실패하던 `lookup_dongguk_rule`도 색인 우선 조회로 고쳤습니다. [변경 기록](../CHANGELOG.md)

이전 개발판 v0.15.0은 규정이 인용한 국가 법령을 현행 법령 목록과 대조하는 `get_rule_upper_laws`와, 동국대와 타대학 규정의 주제어 일치 조문을 나란히 보여 주는 `compare_university_rules`(운영자가 켤 때만 동작)를 추가했습니다. 띄어 쓴 규정명 인식과 법령 인용 추출도 고쳤습니다. [변경 기록](../CHANGELOG.md)

**v0.13.0**은 여러 규정의 개정 여부를 한 번에 점검하는 `check_rule_updates`, 규정이 인용한 교내 규정·국가 법령과 그 규정을 인용한 교내 규정을 찾는 `get_rule_references`, 전체 공개 규정의 전문 색인을 추가했습니다. 색인이 있으면 `search_rule_deep`이 공식 사이트 전문검색 대신 색인에서 후보를 찾고 현행 개정본과 대조합니다. [점검 기록](review-2026-11-11.md)

이전 개발판 v0.12.3은 부칙이 본칙과 섞여 `제1조`·`제2조` 조회와 인용 검증이 막히던 문제를 고치고, `부칙(2024.8.27.) 제1조`처럼 부칙 개정일로 조문을 고를 수 있게 했습니다. 규정명이 없는 질문과 원문에 없는 단어가 섞인 전문검색은 핵심어로 다시 찾습니다. [점검 기록](review-2026-11-09.md)

이전 개발판 v0.12.2는 “여비규정 별표를 보여줘” 같은 자연어 질문에서 별표를 놓치는 문제를 고치고, 표 아래 여러 문단의 주석을 함께 반환합니다. 별표 번호·가지번호를 구분하며, 원문에서 별표 본체를 찾지 못하면 미확인 상태를 표시합니다. [별표 조회 수정](appendix-query-2026-11-05.md)과 이전 [유지보수 및 새 기능 검토](review-2026-11-05.md)에 범위·검증을 정리했습니다. 아래 개인 설치 링크는 v0.15.8 패키지를 가리킵니다. 공용 서버 반영은 별도 배포 후 확인합니다.

## 시작하기

| 방법 | 준비 | 연결 |
|---|---|---|
| 공용 서버 | 원격 MCP 지원 앱. 인증 없이 주소만 입력 | `https://dgu.kr-univ-rules.com/mcp/rules` |
| 내 PC | Node.js 20.19 이상 20계열 또는 22.3 이상, 로컬 MCP 지원 앱 | 아래 GitHub 릴리스 설치, 공유 토큰 불필요 |

앱별 등록 방법(Claude Desktop, Claude Code, Cursor, Codex, ChatGPT)은 [README의 설치](../README.md#설치-주소-하나만-넣으면-됩니다)에 있습니다. 재무 도구가 더해진 `/mcp` 주소는 구성원 토큰이 필요하며, 토큰은 운영자(동국대 재무팀 담당자)에게 개별 요청합니다.

공용 주소는 공개 규정 조회 전용이며 접속한 곳(IP)마다 1분 60회·하루 1,000회까지 받습니다. 넘으면 HTTP 429와 재시도 시간을 돌려줍니다. 동국대학교의 공식 서비스가 아닌 개인 운영 도구입니다. 앱·요금제·기관 정책별 연결 가능 여부는 실제 환경에서 확인해야 합니다.

### 개인 설치

**npm 레지스트리는 현재 미발행**입니다. GitHub의 고정 버전 패키지로 설치합니다.

```bash
npm install -g https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/download/v0.15.8/dongguk-rule-mcp-0.15.8.tgz
dongguk-rule-mcp --version
dongguk-rule-mcp --doctor --json
```

[tgz를 내려받아](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/download/v0.15.8/dongguk-rule-mcp-0.15.8.tgz) `npm install -g ./dongguk-rule-mcp-0.15.8.tgz`로 설치해도 됩니다. 설치 권한이 제한된 기관 PC에서는 [직접 실행 방법](COP_GUIDE.md) 또는 공용 연결을 확인하세요.

사용할 앱의 설정 예시를 출력합니다. 아래 중 하나를 선택해 기존 MCP 설정에 추가한 뒤 앱을 완전히 종료하고 다시 실행합니다.

```bash
dongguk-rule-mcp --print-config codex
dongguk-rule-mcp --print-config claude
dongguk-rule-mcp --print-config cursor
```

업데이트 뒤에는 설치 파일의 `--version`, 공용 서버의 `/health`, 실제 앱 연결의 `get_service_info` 버전을 각각 확인합니다. Codex의 기존 연결이 구버전을 유지하면 앱을 완전히 종료한 뒤 다시 실행하고 같은 도구로 재확인합니다. Aside의 도구 목록 갱신과 확인 절차는 [운영 가이드](OPERATIONS.md#클라이언트와-기존-연결-갱신)를 따릅니다.

출력은 현재 Node와 설치 경로를 사용하며 앱 설정을 직접 변경하지 않습니다. 패키지를 이동·삭제한 경우 새 경로에서 설정을 다시 출력합니다. `--doctor --json`은 오프라인 설치 점검이고, `--doctor --json --live`는 대표 공개 규정 조회를 추가합니다. 설치 진단만으로 앱 연결·모든 원문·업무 적용이 검증되지는 않습니다.

### 첫 질문

> 동국 규정 MCP의 `get_service_info`로 버전과 도구를 확인해줘. 이어서 `lookup_dongguk_rule`로 출장 관련 규정을 찾아줘. 소속·캠퍼스는 [입력], 신분은 [입력], 업무 기준일은 [YYYY-MM-DD]야. 정확한 규정명·LAW_ID·HISTORY_ID·조문/별표·원문 링크를 보여주고, 적용범위·시행일·표의 행과 단위를 확인하기 전 금액이나 전결권자를 확정하지 마.

### 평소 빠르게 질문하기

연결 확인 후에는 `get_service_info`를 매번 부를 필요가 없습니다. 규정명과 핵심어를 포함해 바로 조회하고, 근거가 충분하면 같은 검색·본문·목차를 반복 조회하지 않습니다.

> 동국규정에서 여비규정의 국내 숙박비 기준을 찾아줘. 관련 조문·별표와 원문 링크를 먼저 보여주고 핵심만 짧게 정리해줘. 근거가 부족하거나 잘렸으면 그 부분만 추가 확인해줘.

`lookup_dongguk_rule` 한 번으로 검색·최신 개정본·원문 HWP·관련 별표를 함께 받습니다. 짧은 답변과 별개로 필요한 표의 행·단위·주석, 적용범위와 시행일은 확인해야 합니다. [앱 지침 예시와 캐시 사전 준비](PERFORMANCE.md)

급여·출장비·위임전결·과거 감사·기안문 인용에 바로 적용할 질문과 도구 입력 예시는 [업무 활용 가이드](WORKFLOWS.md)를 참고하세요.

## 공개 규정 도구 — 기본 15개

| 도구 | 용도 |
|---|---|
| `get_service_info` | 버전·프로필·도구 범위·이용 안내 확인 |
| `lookup_dongguk_rule` | 기본 조회: 자연어/규정명 검색 → 개정본 → HWP 조문·별표 발췌; `law_id` 직접 선택 지원 |
| `search_rule` | 제목·전문으로 규정 후보 목록 검색 |
| `get_rule_content` | 선택한 규정의 본문·조문·장·키워드 조회 |
| `get_rule_full_text` | LAW_ID(선택 HISTORY_ID)의 조문·부칙·별표·서식 텍스트 전문. HWP 우선, 긴 문서는 여러 번에 나누어 받으며 다음 부분은 `cursor` 인수로 이어받기 |
| `get_rule_toc` | 목차 조회 |
| `list_rule_history` | 개정 이력 조회 |
| `applicable_rule` | 기준일 이전 개정본 후보와 부칙의 명시 시행일 대조 |
| `compare_rule_versions` | HWP 조문 우선 비교와 별표·서식 텍스트, 표 셀·병합 범위, 그림 파일 내용 비교 |
| `verify_rule_citations` | 비식별 문장의 규정명·조문·제목·항 인용 실존 점검 |
| `search_rule_deep` | 여러 규정의 전문과 관련 조문 탐색. 전문 색인이 있으면 색인 사용(`mode`로 선택) |
| `check_rule_updates` | 여러 규정의 개정 여부 일괄 점검, 기준일 이후 개정된 규정 목록 |
| `get_rule_references` | 규정·조문이 인용한 교내 규정·국가 법령과 역방향 인용(색인 필요). `include_law_text=true`이면 인용된 법령 조문의 현행 원문까지 |
| `get_rule_upper_laws` | 규정·조문이 인용한 국가 법령을 현행 법령 목록과 대조: 현행 여부·시행일, 인용 조문의 존재·삭제, 옛 법령명, 규정 개정 뒤 법령 개정, 시행예정 개정을 점검 신호로 표시. `include_text=true`이면 규정 조문 원문과 현행 법령 조문 원문을 2열 대조 |
| `compare_university_rules` | 동국대와 타대학(최대 5개) 규정에서 주제어가 든 조문을 학교별로 나란히 표시. 기본 켜짐(운영자가 `DONGGUK_UNIVERSITY_COMPARISON_ENABLED=0`으로 끌 수 있음), 자세한 범위는 아래 "타대학 규정 비교" |

제목 검색·공식 사이트 전문검색의 기본 단일 조회에서 후보가 모호하면 `AMBIGUOUS_RULE`과 후보 목록을 반환합니다. 자연어 색인 조회에서는 아래와 같이 최대 3개 규정의 미확정 미리보기를 반환합니다. 제목·적용범위를 확인한 뒤 후보의 `LAW_ID`를 `lookup_dongguk_rule`의 `law_id`로 보내 선택합니다. 관련 없는 첫 검색 결과를 업무 근거로 확정하지 않습니다.

**캠퍼스 자동필터는 없습니다.** 공식 화면의 `LAWGROUP`은 캠퍼스 구분이 아닌 문서 종류입니다. 잘못된 `seoul=1 / wise=2` 매핑을 제거했습니다. `campus`는 업무 맥락으로 보존하고 전체 통합목록을 검색하며 `filterApplied:false`를 표시합니다. 서울·WISE·법인 등 소속과 교원·직원·학생 등 대상의 적용범위는 원문에서 확인해야 합니다. [공식 검색 화면](https://rule.dongguk.edu/lmxsrv/main/main.srv), [통합 규정목록](https://rule.dongguk.edu/lmxsrv/law/lawTree.srv) — 2026-09-08 확인.

## 근거의 범위와 한계

- **시점:** 최신 연혁은 최대 10분 캐시합니다. `applicable_rule`은 개정일을 바탕으로 후보를 찾으며 시행일·경과조치·소급 적용까지 최종 확정하지 않습니다.
- **원문 품질:** HWP 추출 실패·HTML 대체·빈 본문·발췌 잘림·검색어 미일치를 구분합니다. 비교 결과에는 문서별 추출 범위와 실제 미지원 객체·누락 진단을 남깁니다. 공식 API가 아닌 웹 원문 파싱이므로 사이트 변경의 영향을 받습니다.
- **개정 비교:** 양쪽 개정본의 HWP 조문을 우선 비교합니다. HWP를 읽을 수 없으면 HTML 조문으로 대체하고 부분 상태와 대체 사유를 표시합니다. 기본값인 `include_appendices:true`에서는 별표·서식 텍스트와 표의 셀 좌표·행/열 병합 범위·값, 포함된 그림 파일의 SHA-256 해시도 비교합니다. `include_appendices:false`는 별표·서식 비교를 생략하며 HWP 조문 우선 원칙은 유지합니다.
- **결과 해석:** 그림 파일의 동일·변경 판정은 OCR, 그림 속 문구의 의미 해석 또는 페이지 배치 비교를 뜻하지 않습니다. 실제 추출 누락·미지원 객체·식별 모호성은 부분 상태로 남기며 “변경 없음”으로 단정하지 않습니다. 시행일과 업무 적용성은 부칙·적용범위를 별도로 확인합니다.
- **전문 색인:** `dongguk-rule-mcp --build-index`로 만든 HTML 본문 색인은 후보를 찾는 데 사용하며, 별표 내용은 순위에 반영되지 않습니다. `search_rule_deep`은 색인 결과를 현행 목록의 최신 개정본과 대조하고, 개정된 규정은 다시 읽습니다. 색인이 없거나 8일을 넘기면 공식 사이트 검색으로 대체합니다. `lookup_dongguk_rule`은 오래된 색인도 후보 탐색에 사용하되 오래됨을 표시하고, 선택한 규정의 연혁·원문을 별도로 조회합니다(기존 캐시 정책 적용). 별표·금액표는 이 통합 조회의 원문 발췌로 확인합니다.
- **법령 원문 연계:** 법령 서버 주소(`DONGGUK_LEGAL_MCP_URL`)나 키(`LAW_OC`)가 있는 서버에서 기본으로 켜집니다. 없으면 오류 대신 `not_configured`와 설정 안내(`notice`, `setup`)를 돌려주고 규정 인용 결과는 그대로 반환합니다. 조문이 특정된 인용만, 한 번에 8개 조문까지 현행 원문을 가져옵니다. 법령 서버의 성공 응답은 캐시해 같은 법령을 여러 규정이 인용해도 다시 부르지 않습니다. 규정 제정·개정 당시의 조문과 다를 수 있습니다. 법령 서버가 응답하지 않으면 규정 인용 결과만 돌려줍니다.
- **상위법령 관계:** `get_rule_upper_laws`의 점검 신호는 규정을 다시 볼 지점이며, 법령과 규정의 충돌이나 적용 여부의 판정이 아닙니다. 법령은 조회 시점의 현행본과 대조합니다. 조문 개정 표시는 공포일 기준이고, 인용한 규정 조문에 개정 표시일이 없으면 규정 개정일과 비교합니다. 제명이 바뀐 법령은 같은 번호의 현행 조문을 보여 주되 같은 내용이라고 보지 않습니다. 법령을 인용하지 않은 규정에 붙는 주제 후보는 규정 제목으로 고른 목록입니다. 한 번에 법령 12개·조문 8개까지 확인하고(남은 법령은 `law_offset`에 `page.nextOffset`을 넣어 이어서 확인), 법령 서버 연결 정보가 없거나 운영자가 꺼 둔 서버에서도 확인할 법령명·조문과 설정 안내를 돌려주며, `include_text=true`이면 인용 규정 조문과 법령 본문 미확보 상태를 함께 보여 줍니다.
- **상위법령 본문 범위:** `get_rule_upper_laws`의 `lookup.status`는 법령·조문을 확인했는지, `textCoverage.status`는 `include_text=true`로 요청한 본문을 얼마나 받았는지를 따로 알립니다. 본문이 잘리면 `incompleteReasons`에 `LAW_TEXT_TRUNCATED`, 받지 못하면 `LAW_TEXT_UNAVAILABLE`이 들어가고 `evidenceStatus`는 `partial`입니다. 조문의 존재·삭제 여부는 `laws[].articles[].status`로 확인합니다.

  | `textCoverage.status` | 뜻 |
  |---|---|
  | `not_requested` | `include_text`를 요청하지 않았습니다. 실패나 불필요가 아닙니다. |
  | `not_required` | 돌려줄 본문 대상이 없습니다(인용 조문 없음, 본문 없이 삭제·없음이 확인된 조문, 목록에 없는 법령). 법령 확인이 필요 없다는 뜻이 아닙니다. |
  | `unavailable` | 본문 대상이 있는데 하나도 받지 못했습니다. 사유는 `textCoverage.missingArticles[].reason`(예: `LAW_LINK_NOT_CONFIGURED`, `LEGAL_BODY_ERROR`)입니다. |
  | `partial` | 일부 본문만 받았거나 받은 본문이 잘렸습니다. 못 받은 조문은 `missingArticles`, 잘린 조문은 `truncatedArticles`입니다. |
  | `complete` | 대상으로 센 본문을 모두 받았고 누락·잘림이 없습니다. 인용한 조문이 모두 존재한다거나 법령이 현행이라는 뜻이 아닙니다. |

- **인용 관계:** `get_rule_references`와 `get_rule_upper_laws`는 이름을 적은 인용을 찾습니다. "「사립학교법」 제29조, 제31조 및 제32조의2"처럼 나열한 조문, 같은 조문 안의 "동법"·"같은 법 시행령", "(이하 "시행령"이라 한다)"로 정의한 약칭을 앞의 법령에 연결합니다(`anaphora`, `defined_abbreviation`). 낫표 없이 띄어 쓴 법령명은 앞 단어까지 넓혀 추정하고 `name_heuristic`으로 표시하며, 법령 서버에서 정식 이름과 맞춰 본 뒤에만 확정합니다. "관계 법령"처럼 이름이 없는 인용과 다른 조문에 걸친 "동법"은 찾지 못합니다. 역방향 조회의 범위는 색인 범위와 같습니다.
- **인용:** 인용의 실존 확인과 해당 업무의 적용 적합성은 다릅니다. 검색 0건·확인 필요·부분 조회는 검증 통과가 아닙니다.
- **업무와 데이터:** 공개 `rules`는 로그인 쿠키와 내부 지식팩을 사용하지 않습니다. 개인별 급여·계좌·학생기록·인증정보를 입력하지 않습니다. 신고·지급·결재 또는 외부 발송을 수행하지 않습니다.

모든 도구는 읽기용 Markdown `content`와 기계용 `structuredContent`를 함께 반환합니다. v0.10.2부터 `structuredContent`를 표시하지 않는 클라이언트에서도 확인할 수 있도록 `get_service_info`의 `version`·`profile`·`toolCount`와 `lookup_dongguk_rule`의 `sourceType`·`evidenceStatus`·부분 조회 사유를 Markdown에도 표시합니다. 자동화에서는 `ok`, `data`, `error.code`와 개별 원문의 경고·부분 상태를 함께 확인합니다. 규정명·LAW_ID·HISTORY_ID·조문/별표 위치·기준일·조회일·원문 URL을 기록하면 근거를 다시 확인할 수 있습니다.

v0.10.1의 `lookup_dongguk_rule`은 응답과 규정별 `evidenceStatus`(`retrieved`/`partial`) 및 규정별 `incompleteReasons`를 반환합니다. HWP 대체·빈 발췌·글자 수 제한·미확정 후보는 부분 조회이며, `retrieved`도 발췌 확보만 뜻하고 적용성 판단은 아닙니다. `rule_keyword`와 `query`를 함께 보내도 질문으로 관련 부분을 찾습니다. 색인 경로를 포함해 명시한 `terms`가 발췌 조건으로 우선합니다. `terms`가 없으면 자연어 색인의 확장 검색어를 사용하되 질문의 조문·가지조문·별표 선택자도 보존합니다. 여러 단어로 된 질문은 현행 규정 목록에서 질문에 들어 있는 가장 긴 규정 제목을 찾아 그 규정을 고릅니다(`identityStatus:"catalog_title"`). "등록금에 관한 시행세칙 제7조 반환"처럼 띄어 쓴 제목도 낫표 없이 인식합니다. 규정 이름은 발췌 검색어에서 빼므로, 남은 단어가 본문에 없으면 `NO_MATCHING_EXCERPT`로 알립니다. 비정상 검색 페이지는 `NOT_FOUND` 대신 `UPSTREAM_FORMAT_CHANGED`로 반환하고 새 캐시에 저장하지 않습니다.

### 상위법령 조문 원문 대조 (개발 중)

`get_rule_upper_laws({"law_id": LAW_ID, "article": "제9조", "include_text": true})`로 인용이 나온 **규정 조문 원문과 인용한 현행 국가 법령 조문 원문**을 2열로 읽을 수 있습니다. `article`을 생략하면 규정 전체에서 인용을 찾고, 과거 규정은 `history_id`로 고릅니다. 과거 규정을 골라도 오른쪽 법령은 조회 시점의 현행본입니다. 과거 당시 법령의 대조나 충돌·적용 여부 판정이 아닙니다. 점검 신호·CAVEAT는 그대로 제공합니다.

규정 쪽은 인용 추출에 쓴 **HTML 조문 전체**이며 짧은 `citationText`만 보여 주지 않습니다. 별표·서식·그림을 포함한 규정 전문 조회는 `get_rule_full_text`를 사용하세요. 법령 쪽은 기존 korean-law 연동으로 확보한 본문을 재사용하며 새 API나 추가 법령 조회를 만들지 않습니다. `include_text:false`(기본)에서는 양쪽 본문과 대조 쌍을 반환하지 않습니다. 도구 수는 공개 15개·finance 19개 그대로입니다.

구조화 응답의 기존 `laws`, `textCoverage`, `evidenceStatus`, `incompleteReasons`에 `comparison`을 추가했습니다.

| 필드 | 의미 |
|---|---|
| `comparison.status` | 대조 본문의 전달 상태: `not_requested`(본문 요청 안 함), `not_required`(명시적 인용 없음), `complete`(대상 양쪽 본문을 모두 전달), `partial`(일부 전달·잘림·생략), `unavailable`(양쪽 본문을 함께 받은 쌍이 없음). 법령의 효력·적용성 판단이 아닙니다. |
| `comparison.ruleArticles[]` | 중복 없는 규정 조문. `id`, `article`, `supplementaryHeading`, `contentMarkdown`, 출처 `source`(LAW_ID·HISTORY_ID·개정일·URL·HTML 표시), `textCoverage`, 전문 재조회용 `fullTextRequest`를 포함합니다. |
| `comparison.pairs[]` | 인용별 연결. `ruleArticleId`로 규정 조문을, 0부터 시작하는 `lawIndex`·`lawArticleIndex`로 `laws[lawIndex].articles[lawArticleIndex]`를 찾습니다. `citationText`·인용 항 `paragraph`·해석 근거 `resolutionStatus`·쌍의 `status`·`lawTextStatus`를 보존합니다. 조문 번호가 없으면 `lawArticleIndex:null`, `lawTextStatus:not_specified`이며 임의 조문을 고르지 않습니다. |
| `comparison.omittedPairs` | 표시 한도 때문에 생략한 인용 수. `laws[].citedBy`에는 인용 목록을 유지합니다. |
| `laws[].citedBy[].ruleBlockId` | 대조 쌍과 같은 규정 본문 블록 식별자입니다. 요청 내 식별자이며 영구 ID가 아닙니다. |

규정 본문은 조문당 6,000·합계 24,000 UTF-16 코드 단위, 대조 인용은 24건까지입니다. 같은 조문은 합계 한도에서 한 번만 셉니다. 줄바꿈·표 구분자·기호는 구조화 원문에 보존하고, 표 표시에서는 줄바꿈과 기호를 이스케이프합니다. 여러 부칙의 같은 조 번호는 블록 ID와 부칙 제목으로 구분합니다. 법령은 기존대로 최대 12개(기본 8개)·인용 조문 8개·조문당 3,000자입니다.

- 규정 본문 잘림·미반환은 `RULE_TEXT_TRUNCATED`·`RULE_TEXT_UNAVAILABLE`, 대조 인용 생략은 `COMPARISON_LIMIT`입니다. `article`로 범위를 좁히거나 `ruleArticles[].fullTextRequest`의 고정 개정본 전문을 이어 받으세요.
- 법령 조문 미지정은 `LAW_ARTICLE_UNSPECIFIED`입니다. 법령 미확보·잘림은 기존 `LAW_TEXT_UNAVAILABLE`·`LAW_TEXT_TRUNCATED`이며 한국법령 MCP에서 해당 MST·조문을 확인합니다. 새 사유도 최상위 `incompleteReasons`에 전파되어 `evidenceStatus:partial`이 됩니다.
- 기존 `textCoverage`는 **법령 본문만**의 범위를 유지합니다. 따라서 법령 본문이 `complete`여도 규정 본문이 잘리면 대조는 `partial`입니다. 현행에 없는 법령·조문은 기존 `textCoverage:not_required`일 수 있지만 양쪽 원문 대조는 `unavailable`이며 부분 상태입니다. 삭제 표지 본문을 받았다면 받은 텍스트로 표시하고 `ARTICLE_DELETED` 점검 신호를 유지합니다.
- 주제 후보는 근거가 확인된 대조 쌍으로 만들지 않습니다. `comparison.status:complete`여도 법령명 미확정·목록 누락 등의 기존 사유가 있으면 전체 `evidenceStatus`는 `partial`일 수 있습니다.

### 규정 전문 조회 (개발 중)

규정 하나의 전문이 필요하면 `get_rule_full_text({"law_id": LAW_ID})`를 호출합니다. 과거 개정본은 `history_id`도 지정합니다. 생략하면 해당 규정의 최신 개정본을 고르고, 지정한 HISTORY_ID가 그 LAW_ID의 연혁에 있는지 확인합니다. 관련 부분만 고르는 `lookup_dongguk_rule`, HTML의 조·장을 고르는 `get_rule_content`와 달리, 이 도구는 검색어 필터 없이 HWP에서 추출한 조문·부칙·별표·서식을 원문 순서로 반환합니다. 표의 셀 좌표·행/열 병합 범위와 표 아래 주석도 보존합니다.

- 응답의 `contentMarkdown`이 전문 텍스트입니다. 기본 페이지 한도는 30,000, `max_chars`로 1,000~60,000 UTF-16 코드 단위까지 지정할 수 있습니다(설명·메타데이터 제외). 이모지 등의 서로게이트 쌍은 나누지 않지만 표·줄 중간에서 페이지가 끊길 수 있습니다.
- 여기서 `cursor`는 긴 전문의 다음 부분이 어디서 시작하는지 가리키는 입력 인수 이름입니다. 코드 편집기 Cursor 앱과는 관계가 없습니다. 일반 이용자는 신경 쓸 필요가 없고, AI 앱이 응답의 `nextArguments`를 그대로 다시 보내 이어받습니다.
- `textCoverage.hasMore: true`이면 `textCoverage.nextArguments`를 그대로 다음 `get_rule_full_text` 호출에 전달합니다. 첫 응답의 LAW_ID·HISTORY_ID·추출 출처·텍스트 SHA-256을 cursor가 고정하므로, 최신 개정본이 바뀌어도 이어받는 개정본은 바뀌지 않습니다. HTML로 시작했다면 이어받기도 HTML입니다. 원문 텍스트나 출처가 바뀌면 `FULL_TEXT_CHANGED` 오류를 반환하므로 첫 페이지부터 다시 받습니다. 다른 규정·개정본과 cursor를 섞으면 `INVALID_ARGUMENT`입니다.
- 마지막 페이지의 `nextArguments`와 `nextCursor`는 `null`입니다. 모든 페이지의 **`contentMarkdown`만 순서대로 구분자 없이** 합치세요. `offset`(포함)·`endOffset`(제외)·`totalChars`로 전달 범위를, `sha256`으로 결합한 UTF-8 텍스트의 해시를 확인할 수 있습니다. 이 해시는 다운로드한 HWP 파일의 해시가 아닙니다.
- 한 응답이 전문의 일부이면 첫·중간·마지막 페이지 모두 `evidenceStatus: partial`, `FULL_TEXT_PAGINATED`, `textCoverage.status: partial`입니다. `truncated`는 그 페이지 뒤에 남은 본문이 있는지 뜻하므로 마지막 페이지에서는 `false`입니다. 페이지 단위 전달 상태와 별도로 `sourceEvidenceStatus`가 추출 원문의 상태를 표시합니다.

| `incompleteReasons` | 의미와 후속 확인 |
|---|---|
| `FULL_TEXT_PAGINATED` | 전문의 일부 페이지입니다. 이전 페이지와 합치고, 다음 페이지가 있으면 이어받습니다. |
| `HWP_FALLBACK` | HWP 실패·빈 본문으로 HTML 대체. 별표·서식 누락 가능성이 있어 공식 원문을 확인합니다. |
| `HWP_COVERAGE_UNVERIFIED` | 구조 정보가 없거나 원시 HWP 대조가 확인되지 않은 캐시입니다. |
| `HWP_STRUCTURE_PARTIAL` | 추출 진단이 있습니다. `originalCoverage.diagnostics`에서 누락·미지원 객체 등 구체적 사유를 확인합니다. |
| `IMAGE_TEXT_UNAVAILABLE` | 그림은 해시·표지만 있고 OCR 문구는 없습니다. 그림 속 문구는 원문에서 확인합니다. |

이어받기를 마쳐도 `sourceEvidenceStatus: partial`인 원문의 누락 한계는 해소되지 않습니다. `retrieved`도 추출 텍스트 확보만 뜻하며, 원본 화면 배치나 시행일·업무 적용성 판단을 보증하지 않습니다. HWP·HTML 모두 본문을 확보하지 못하면 성공 대신 오류를 반환합니다. 출처 URL·개정일·조회 시점은 `sourceUrl`, `revisedAt`, `returnedAt`에 있습니다.

이 도구는 기존 HTML 전문 색인의 검색 순위를 바꾸지 않습니다. 자연어 검색에서 빠진 별표도 LAW_ID를 지정하면 직접 조회할 수 있습니다. 공용 서버 색인 갱신·법령 API·런처 설정은 이 기능 추가로 켜지거나 바뀌지 않습니다.

### 자연어 질문 조회 (v0.15.3)

규정명을 몰라도 `lookup_dongguk_rule({"query":"해외출장 갈 때 일비는 얼마 받아?"})`처럼 질문할 수 있습니다. 질문에 정확한 규정명이나 `law_id`가 있으면 그 선택을 우선하며, 이름이 없는 질문은 공개 전문 색인에서 후보를 찾습니다.

- **어미·의문사 제거:** `겸직하려면→겸직`, `전결해→전결`처럼 명사를 남기고 `어떻게`, `누가`, `받아` 등은 검색 핵심어에서 제외합니다. `피해`, `손해`처럼 `해`로 끝나는 명사는 보존합니다.
- **규정 용어 확장:** `해외출장→국외출장·국외`, `강사료→강의료`, `환불→반환` 등 등록된 표현 중 색인에 실제로 있는 말도 검색합니다. `이중 수혜`는 `이중수혜`도 찾고, 없는 복합어는 짧은 형태로 다시 찾습니다. 후보 검색에 쓴 표현은 `search.searchTerms`, 실제 발췌 조건은 `query.effectiveTerms`로 확인할 수 있습니다. 명시한 `terms`(예: `감액`, `제10조`)는 자동 확장으로 덮어쓰지 않습니다.
- **후보와 캠퍼스 판:** 조문 제목의 일치에 가점을 줍니다. 질문의 단어가 규정명에 있는 후보도 일정 점수 이상이면 상위 미리보기에 보존합니다(예: 전결 질문의 위임전결규정). 같은 규정의 WISE캠퍼스·의학계열·산학협력단 판을 비교할 때 질문에 명시한 기관·캠퍼스와 `campus` 입력을 먼저 존중합니다. 예를 들어 산학협력단을 물었으면 산학협력단판을 우선하며, WISE와 산학협력단을 함께 지정하면 해당 복합 판을 우선합니다. 범위를 지정하지 않았거나 여러 판이 맞거나 질문과 `campus`가 충돌하면 서로 다른 판을 별도 후보로 남깁니다. 각 판은 자기 점수를 유지하고, 다른 판의 제목·LAW_ID는 `rules[].editions`와 본문에도 표시합니다. 판 선택은 제목 접두어에 따른 후보 탐색이며 적용범위 확정이 아닙니다. 반환 한도 밖의 판은 다른 후보·다른 판 안내에서 확인하고 `law_id`로 조회하세요.
- **여러 후보 미리보기:** 1위가 뚜렷하면 단일 후보를, 비슷한 후보가 있으면 기본 `max_rules:1` 요청에도 최대 3개 규정의 발췌를 반환합니다. `search.selection`은 실제 반환 규정 수가 1개이면 `single_candidate`, 2개 이상이면 `multiple_candidates`입니다. `max_rules:2/3`을 명시한 경우도 같은 기준이며, 다중 미리보기는 규정당 최대 3개 관련 블록·6,000자로 제한됩니다. `identityStatus:"candidate_preview"`, `evidenceStatus:"partial"`, `RULE_IDENTITY_UNCONFIRMED`를 확인하고 적용범위를 검토한 뒤 `law_id`로 다시 조회하세요. 후보가 여러 개여도 조회 성공(`ok:true`)이 곧 적용 규정 확정을 뜻하지 않습니다.
- **발췌 순서:** 색인으로 찾은 자연어 질문은 관련도가 높은 조문부터 보여 줍니다. 글자 수 제한에서도 핵심 조문을 우선 보존하며, 일반 조회는 문서 순서를 유지합니다. 색인이 없거나 일치 후보가 없으면 공식 사이트 전문검색으로 대체하며, 이 경로의 모호한 후보는 `AMBIGUOUS_RULE`로 반환합니다.

### 자연어 조회 평가

```bash
npm ci
npm test                        # 오프라인 회귀 테스트만 실행
node src/index.js --build-index  # 별도 실행: 네트워크를 사용해 공개 색인 준비
npm run evaluate:natural-language -- --output /tmp/natural-language-evaluation.json
```

실조회 평가 스크립트는 [scripts/evaluate-natural-language.js](../scripts/evaluate-natural-language.js)이며 기본 `npm test`와 CI에 포함되지 않습니다. 실제 MCP 프로세스의 `lookup_dongguk_rule`을 순차 호출합니다. 공개 색인이 있어야 시작하고 정상 공개 캐시를 사용하므로, 매번 원문을 새로 받는 성능 실험은 아닙니다. 보고서에는 색인 시점·범위·오래됨 여부, 서버 버전, 문항별 소요 시간·규정 식별자·발췌·부분 조회 상태를 기록합니다.

[문항 파일](../test/fixtures/natural-language-questions.json)은 `[질문, 허용 규정명 배열 또는 null, 발췌 키워드 또는 null]` 형식으로 총 30문항입니다. 정답 규정이 있는 28문항을 채점하고, 정답 미지정 2문항도 조회하되 `unscored`로 분리합니다. 공백을 제거한 규정명의 부분 일치로 반환된 규정 상위 3개만 평가하며, 단순 후보 목록은 순위에 넣지 않습니다. `top1`·`top3`·`excerptMatched`를 따로 집계하고, 문항 통과는 **상위 3개 정답 규정 포함 + 해당 정답 규정 발췌의 키워드 일치**(키워드 지정 시)입니다. 이는 검색 회귀 평가이며 금액·절차의 법적 정답이나 적용성 판정은 아닙니다.

`--questions FILE`, `--timeout MS`(문항당 기본 60,000ms), `--output NEW_FILE`을 지원합니다. 결과 JSON은 표준 출력과 지정 파일에 저장하며 기존 파일을 덮어쓰지 않습니다. 채점 실패 또는 호출 오류(미채점 문항 포함)가 있으면 종료 코드 1, 모두 통과하면 0입니다. 개별 호출 실패 후에도 나머지 문항을 평가합니다. 평가 집계 자체는 합성 응답으로 오프라인 테스트합니다.

## 공용 서버와 선택 기능

HTTP는 stateless Streamable HTTP이며 MCP 경로는 POST 요청을 사용합니다.

| 경로 | 범위 |
|---|---|
| `/`, `/guide` | 인증정보를 포함하지 않는 구성원 안내 페이지 |
| `/mcp/rules` | 서버 프로필과 무관하게 공개 규정 15개 도구. 공용 서버에서는 인증 없이 열고 IP별 호출 제한 적용 |
| `/mcp` | 운영자가 지정한 프로필의 도구, 기존 연결 경로. 공용 서버에서는 토큰 필요 |
| `/health`, `/ready` | 프로세스·요청 수용 상태; 원문 조회 성공을 의미하지 않음 |
| `/status` | 관리용 인증이 필요한 집계 운영 상태 |

운영자가 개인 또는 그룹별 자격증명을 발급·회수하고 만료·허용 경로를 관리합니다. 등록 파일은 SHA-256 해시를 보관하며 `--token-file` 또는 `DONGGUK_MCP_TOKEN_FILE`로 지정합니다. 설정 예시와 발급 명령은 [운영 가이드](OPERATIONS.md)에 있습니다. 토큰 없이 여는 프로세스는 `rules` 프로필로만 띄우고, 재무 기능이 있는 경로에는 HTTPS와 인증을 사용합니다.

```bash
# 접근제한 운영 폴더의 토큰 등록 파일을 지정
dongguk-rule-mcp --http --profile rules --host 127.0.0.1 --port 3845 --token-file /secure/dongguk/tokens.json
```

공용 서버는 개인이 운영하는 장비 한 대에서 돌아가며 잠자기·전원·인터넷·터널·공식 원문 서버 상태에 따라 중단될 수 있습니다. 전교 동시 이용 규모·기관 SSO·모든 구성원의 앱 연결·현업 시간절감은 별도 검증 대상이며, 이 릴리스가 전원 계정 개통이나 가용성 SLA를 의미하지 않습니다.

`--profile finance` 또는 `DONGGUK_MCP_PROFILE=finance`를 선택하면 `get_finance_context`, `get_finance_evidence`, `search_finance_handbook`, `review_finance_case`가 추가되어 **19개 도구**가 됩니다. 내장 출장비·외부 강사료 공동 조회는 내부 자료팩 없이 사용할 수 있습니다. 그 외 기존 재무 업무 카드 조회는 검토한 비식별 지식팩을 `DONGGUK_FINANCE_PACK_PATH`로 별도 연결해야 합니다. 법령 연계와 로그인 쿠키도 선택 프로필의 운영 설정으로 관리합니다. 내부 자료는 공개 저장소·패키지에 포함하지 않습니다.

### 켜고 끄는 설정

> 이 절은 저장소의 현재 코드(v0.15.8 이후 미배포 변경) 기준입니다. 배포본 v0.15.8은 타대학 비교에 `DONGGUK_UNIVERSITY_COMPARISON_ENABLED=1`, 법령 연결에 `DONGGUK_LEGAL_MCP_ENABLED=1`·`DONGGUK_PUBLIC_LAW_LINK=1`과 주소(`DONGGUK_LEGAL_MCP_TRANSPORT=streamable-http`, `DONGGUK_LEGAL_MCP_URL`) 또는 `LAW_OC`를 넣어야 켜집니다. 바뀌는 내용은 [변경 기록](../CHANGELOG.md)의 미배포 항목에 있습니다.

모든 도구는 기본으로 켜져 있습니다. 환경변수는 운영자가 끄거나, 바깥 서비스의 연결 정보를 넣을 때만 씁니다. 실제 상태는 `get_service_info`의 `integrations`에서 확인합니다.

| 기능 | 기본 | 끄는 값 | 내용을 채우는 데 필요한 것 |
|---|---|---|---|
| 타대학 비교(`compare_university_rules`) | 켜짐 | `DONGGUK_UNIVERSITY_COMPARISON_ENABLED=0` | 없음. 서울대만 `DONGGUK_LAWGO_OC` |
| 법령 연결(`get_rule_references`의 `include_law_text`, `get_rule_upper_laws`) | 주소나 키가 있으면 켜짐 | `DONGGUK_LEGAL_MCP_ENABLED=0`(전체), `DONGGUK_PUBLIC_LAW_LINK=0`(공개 프로필만) | `DONGGUK_LEGAL_MCP_URL`(한국법령 MCP 주소) 또는 `LAW_OC`(법제처 Open API 인증키 + 서버에 설치된 `korean-law-mcp`) |

- 끄는 값은 문자 `0`뿐입니다. 값이 없거나 `0`이 아닌 값이면 켜진 것으로 봅니다.
- 법령 서버 주소·키가 없을 때는 오류가 아니라 `status: "not_configured"`, `code: "LAW_LINK_NOT_CONFIGURED"`와 함께 `notice`(사람이 읽는 안내), `setup.state`(`missing`·`invalid`·`disabled`·`disabled_public`), `setup.env`(넣을 환경변수 이름), `setup.ocApplyUrl`(OC 신청처)을 돌려줍니다. 규정 쪽 결과는 그대로입니다.
- 주소만 넣으면 `DONGGUK_LEGAL_MCP_TRANSPORT`를 생략해도 `streamable-http`로 연결합니다. 기본 법령 서버 주소는 코드에 없습니다.
- 법제처 Open API 인증키(OC)는 [open.law.go.kr](https://open.law.go.kr)에서 신청합니다. 키와 토큰은 접근제한 환경파일로만 주입하고 명령행·문서·저장소에 적지 않습니다.
- 공용 서버에는 타대학 비교, 법령 연결, 서울대용 인증키가 모두 들어 있어 꺼진 도구가 없습니다(2026-11-26 확인).

## 소스 실행과 검증

```bash
git clone --branch v0.12.0 https://github.com/buenosiempre-cmd/dongguk-rule-mcp.git
cd dongguk-rule-mcp
npm ci
npm test
npm run test:live
node src/index.js --doctor --json
npm pack --dry-run
```

| 명령 | 확인 범위 |
|---|---|
| `npm test` / `npm run test:offline` | 파서·입력·근거·MCP·HTTP·프로필 등 오프라인 회귀 |
| `npm run test:live` | 새 MCP 프로세스에서 공식 원문 조회·연혁·별표 등 대표 경로 |
| `npm run test:live:cop` | 학사·인사·회계 등 대표 업무 규정의 LAW_ID 직접조회·최신 연혁·본문 연결 확인 |
| `npm run doctor -- --json` | 설치와 도구 등록; `--live`로 대표 원문 조회 추가 |
| `npm run audit:deps` | 설치 의존성의 알려진 취약점 조회; CI에서도 실행 |
| `npm run benchmark` | 로컬 HTTP 부하 측정; 전교 운영 용량이나 원문 서버 SLA 검증은 아님 |
| `node src/index.js --build-index` | 전체 공개 규정의 전문 색인 생성·갱신(실측 약 5분, 바뀐 규정만 다시 읽음) |
| `npm run issue-token -- --help` | 운영자용 개인/그룹 자격증명 발급 도구 사용법 |

실원문 검사는 원문 서버에 접근 가능한 네트워크가 필요합니다. HTTP 오류만으로 특정 IP 차단을 단정하지 않습니다. 자동 검사와 현업 효과는 구분하고, 실제 앱·캠퍼스·직군별 평가는 [빈 평가 양식](../examples/cop-evaluation.csv)으로 기록합니다.

추가 설정: `DONGGUK_RULE_ALIASES`는 부서별 규정 별칭 JSON, `DONGGUK_MCP_NO_CACHE=1`은 디스크 캐시 비활성화입니다. 나머지 실행 옵션은 `dongguk-rule-mcp --help`와 [운영 가이드](OPERATIONS.md)를 확인하세요.

## 라이선스·기여

MIT. 원본 Python 구현: 서준호. Node.js MCP 포팅·운영 개선: 오승훈. [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)에서 영감을 받았습니다.

[GitHub Issues](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/issues)에 버전·비식별 재현 질문·오류코드를 남겨주세요. 개인 정보·인증값·내부 문서를 첨부하지 않습니다.

[Finance Desk 통합 기능과 외부 자료팩 설정](FINANCE_DESK.md)

## 타대학 규정 비교 (개발 중)

`compare_university_rules`는 동국대와 타대학의 같은 사안 조문을 학교별 열로 나란히 보여줍니다. 행 순서나 조문 번호는 법적 동등성을 뜻하지 않습니다.

**사안 프레임**: 규정명과 위계(규정·세칙·내규)는 대학마다 다르므로, 등록된 주제(겸직·여비·연구비·등록금 반환·퇴직급여·근로장학·장학금)는 사안을 **주체 × 행위 × 규율 요소**로 정의한 프레임(`src/issue-frames.js`)으로 조문을 고릅니다. 같은 단어가 다른 뜻으로 쓰인 조문(교내 겸무의 "겸직", 지도교수의 학과 겸직 등)은 제외어로 빼고 `columns[].dropped`에 사유별 건수만 남깁니다. 남은 조문에는 규율 요소(`slots`: 허가권자·기간·보수 등)와 주체, 조문이 인용한 국가 법령(`anchorLaws`, 프레임의 근거 법령과 같으면 `inFrame`)을 붙이고, 대학별로 주규정(`role: primary`, 제목에 사안어가 있거나 요소를 가장 많이 다루는 규정)과 보조규정을 가릅니다. `slotMatrix`는 규율 요소 × 대학 표로, 칸마다 `found`(규정·조문·근거 줄·URL·시행일)·`not_found_in_scope`·`unavailable`·`unsupported`를 구분합니다. 빈 칸은 조회 범위에서 찾지 못했다는 뜻이며 규정 부존재가 아닙니다. 모든 판정은 문자열 대조이고 법적 동등성·적용 여부가 아닙니다(`alignment: "issue_frame_slots_not_legal_equivalence"`). 미등록 주제는 주제어 일치 발췌만 제공합니다. 등록 프레임은 `get_service_info`의 `universityComparison.issueFrames`와 결과의 `supportedTopics`에 나옵니다.

```json
{"topic":"여비","universities":["korea","uos"],"max_articles":3}
```

- 동국대 자동 포함. 타대학 키: `korea`(고려), `uos`(서울시립), `konkuk`(건국), `kookmin`(국민), `ssu`(숭실), `khu`(경희), `sookmyung`(숙명여대), `kw`(광운), `mju`(명지), `sogang`(서강), `ewha`(이화), `snu`(서울대, OC 키 필요), `yonsei`(연세), `cau`(중앙), `hongik`(홍익), `hanyang`(한양), `skku`(성균관), `sejong`(세종), `gachon`(가천). 한 번에 최대 5개. 다른 영문 키는 `unsupported`.
- `columns`마다 조문 번호·본문·규정명·URL·개정일(동국만 확인, 타대학 미확인)·시행일(`effectiveAt`과 출처 `effectiveSource`: 규정 목록의 시행일자 `list` 또는 마지막 부칙의 명시 시행일 `addenda`, `null`은 미확인), `status`, `coverage`, 실패 내역 제공. 학교당 최대 5개 조문, 조문당 2,000자이며 잘림 표시.
- 주제어는 접두어(교내·교외·학부·대학원·학사)와 끝의 '금'을 떼고 등록된 동의어로 넓힙니다(교내근로장학금 → 근로장학·근로보조금·교내근로·근로학생). 동의어 검색은 후보가 부족할 때만 추가로 합니다(`coverage.queries`).
- 서울시립은 `.srv`, 국민·숭실·경희·숙명여대는 `.do` 검색을 씁니다. 먼저 규정 제목 검색(대표어와 첫 제목 단서, `coverage.titleQueries`·`titleMatches`)으로 사안을 전담하는 규정(「전임교원 겸직허가에 관한 규정」 등)을 찾아 가장 먼저 읽고(`matchedBy:"title"`), 그다음 전문검색 첫 페이지 후보를 더해 최대 5개 규정을 조회합니다. 제목 검색이 실패하면 전문검색만으로 이어갑니다. 건국·광운·명지는 공개 규정 트리 전체(각 430·255·267개)에서 제목을 대조합니다(`coverage.mode:"title_tree"`, 제목에 주제 단서가 없는 규정 속 조문은 놓칠 수 있어 `complete:false`). 명지는 본문 제목·부칙이 `lawname2`·`addenda2` 클래스라 함께 처리합니다. 고려는 로그인 없이 **약 55개 규정만 공개**하며(다른 규정은 로그인 화면으로 이동, 2026-11-24 확인) 검색·전체 트리·부서별 목록도 세션이 필요합니다. 공개 분류 목록(`lawListManager`, 8개 분류, 10건씩 페이지 넘김)을 모두 읽어 제목을 대조하고(`coverage.mode:"public_folder_list"`, `publicOnly:true`), 결과 표의 상태에 "공개 규정만"을 붙입니다. 목록에 없는 규정(예: 여비규정)은 비공개로 추정되며 조회할 수 없습니다. 목록 형식이 바뀌면 최근 개정 목록(`recent_list_only`)으로 대체합니다. 동국은 제목 검색 우선·미발견 시 전문검색 20행을 규정 단위로 합쳐 후보 최대 5개를 조회합니다.
- LawMaster가 아닌 대학은 전용 어댑터로 조문을 읽습니다. **서강**(`sogang`)은 자체 REST JSON(`coverage.mode:"rest_json"`)에서 주제어를 제목으로 질의해 매칭 규정의 `content`(조문 HTML)를 받고, **이화**(`ewha`)는 규정집 목록 HTML의 `view-rule` 링크를 따라 각 규정 `.fr-view`의 조문 전문을 읽습니다(`coverage.mode:"html_catalog"`). 두 대학의 조문·부칙 HTML은 공통 변환기(`htmlToArticleMarkdown`)로 `### 제N조`·`## 부칙` 형식으로 바꿔 동일 비교 파이프라인에 올립니다. 개정일은 머리말·부칙 헤딩의 날짜 중 가장 늦은 날, 시행일은 마지막 부칙의 명시일로 채웁니다. 서강대 서버가 중간 인증서를 빠뜨려 TLS 체인이 끊기므로, 공개 중간 인증서(`src/ca/`)를 기본 루트에 **추가**해 검증을 끄지 않고 해결합니다.
- **서울대**(`snu`, 국립)는 규정이 각 대학 사이트가 아니라 국가법령정보센터(law.go.kr)의 학칙 채널에 공개됩니다. DRF 공개 API(`target=school`)를 XML로 직접 호출하며(`coverage.mode:"lawgo_school"`), 운영자가 law.go.kr에서 발급한 무료 OC 키를 `DONGGUK_LAWGO_OC`로 넣어야 동작합니다(중간 서버 없음). 목록(`lawSearch`)의 `<admrul>`에서 소관부처=서울대·현행 규정만 골라 발령일자(개정일)·시행일자를 읽고, 본문(`lawService`)의 `<조문내용>` 요소를 조문 단위로 받습니다. OC 키가 없으면 해당 열이 `unavailable (LAWGO_OC_NOT_CONFIGURED)`로 표시됩니다. 인용 URL에는 OC 키를 넣지 않습니다. 사립대는 이 학칙 채널에 대부분 없습니다.
- **연세대**(`yonsei`)는 규정집이 Next.js(App Router) 앱이라 공개 REST API가 없습니다. 페이지에 내장된 RSC flight 데이터(`self.__next_f.push`)를 재조립해 목록(현행 682개 규정의 이름·개정일·UUID)과 본문(규정 페이지의 조문 HTML row)을 읽습니다(`coverage.mode:"nextjs_rsc"`, 로그인 불필요). 본문 HTML row의 길이는 바이트 기준이라 버퍼로 정확히 잘라 인접 데이터가 새지 않게 합니다. flight 스키마는 배포마다 바뀔 수 있어 필드명(`name`·`revisionHistories`·`html`) 기반으로 느슨하게 파싱합니다.
- **중앙대**(`cau`, A안)는 공개 JSON 목록과 상세 페이지에 연결된 PDF 텍스트 레이어에서 **조문만 비교**합니다. 목록 `MAX_DT`와 같은 규정의 PDF 경로 날짜가 일치하는 첨부가 하나일 때만 조회합니다. 첨부 순서로 최신본을 추측하지 않으며 불일치·복수 후보는 `PDF_REVISION_UNVERIFIED`입니다. `historyId`는 선택한 PDF 경로의 YYYYMMDD, `revisedAt`은 목록 개정일이며 시행일과 다릅니다.
- 중앙대는 `coverage.comparisonScope:"articles_only"`, `appendicesCompared:false`, `textLayerOnly:true`, `complete:false`로 범위를 표시합니다. 조회한 조문이 있어도 열 상태는 `partial`입니다. **표의 셀·병합·금액 대응, 별표·별지·부록·서식·그림은 비교하지 않습니다.** `〔별표〕`·`〔부록〕`·`[서식]` 등을 포함한 독립 부속 표제 이후는 조문 후보에서 제외하고, 그 뒤 최신 부칙이 있을 수 있어 이 경우 시행일도 미확인으로 남깁니다. 금액·조건은 `articles[].originalPdfUrl`과 Markdown의 PDF 원문 링크에서 확인하도록 안내합니다. 줄바꿈·읽기 순서는 원본 배치와 다를 수 있습니다. `별표 1에 따른…` 같은 본문 참조는 유지하며, 줄바꿈된 `제9조(일비)에 따른다`는 앞 조문의 인용 문장으로 보존합니다. OCR은 수행하지 않습니다.
- 중앙대 스캔본·빈 텍스트(`PDF_NO_TEXT`), 조문 미검출(`PDF_NO_ARTICLES`), 손상 파일(`PDF_PARSE_FAILED`), 개정본 미확인을 규정별 실패로 남깁니다. 일부 실패는 다른 후보 조회를 계속하고, 모두 실패하면 `unavailable`입니다. 규정 부존재나 비교 완료로 표시하지 않습니다.
- **홍익대**(`hongik`)는 규정집 페이지의 규정 트리(전체 제목)에서 제목을 대조하고 규정별 페이지의 `.fr-view` 조문 HTML을 읽습니다(`coverage.mode:"html_catalog"`). **한양대**(`hanyang`)는 규정집 화면이 쓰는 공개 JSON에서 규정명을 검색하고 조문별 본문을 읽습니다(`coverage.mode:"rest_json"`). 응답에 섞인 등록자·IP 같은 관리 필드는 읽지 않습니다. 한양의 개정일은 목록의 개정일, 시행일은 마지막 부칙의 명시일입니다.
- 홍익·한양도 **조문만 비교**합니다(`comparisonScope:"articles_only"`, `appendicesCompared:false`, `tablesCompared:false`). HTML의 표는 통째로 버리고(`tablesOmitted`), 독립 별표 표제(`[별표 1]`, `〔별표 1〕` 등) 뒤와 한양의 별표·서식 묶음(이름이 괄호로 싸여 있어도)은 조문 후보에서 뺍니다. 본문 속 `별표 1에 따라…` 같은 참조와 그 뒤 조문은 그대로 둡니다. 홍익은 잘라낸 뒤쪽에 부칙이 있을 때만 시행일을 미확인으로 둡니다.
- 조문 제목만 있고 읽은 본문이 없는 조문(본문이 그림뿐이거나 비어 있음)은 비교 조문과 규율 요소 표에 넣지 않습니다. 규정별 `unreadArticles`와 열의 `failures`(`ARTICLE_TEXT_UNAVAILABLE`, `article`, `reason: image_only|empty`)에 남기고, 표시문에 조문 이름과 함께 원문 확인을 안내합니다. 본문 안의 그림은 `imagesOmitted`로 셉니다.
- **성균관대**(`skku`)·**세종대**(`sejong`)·**가천대**(`gachon`)는 공개 문서에서 **조문만 비교**합니다(`comparisonScope:"articles_only"`, `appendicesCompared:false`, `complete:false`, 열 상태 `partial`). 표·별표·서식·그림은 비교하지 않으며 `articles[].originalPdfUrl`의 원문 파일에서 확인합니다. 독립 별표 표제 이후를 제외한 경우 시행일은 미확인입니다.
  - 성균관대는 규정집 게시판을 제목으로 검색합니다(`coverage.mode:"board_pdf"`, 10건씩 최대 2쪽, 넘으면 `searchPagesTruncated`). 게시판은 개정본마다 한 줄이므로 오늘 이전 가장 늦은 제·개정일의 줄을 현행본으로 고르고, 시행 예정본이 있으면 `upcomingRevisionAt`으로 알립니다. 제목에 주제어가 없으면 본문 검색을 한 번 하는데(`coverage.channel:"content"`), 본문 검색은 그 단어가 든 개정본만 돌려주므로 규정명으로 다시 찾아 현행본을 확인합니다. 이 재검색도 최대 2쪽과 정렬 검증을 받습니다. 최신순이면 처음 만난 오늘 이전 줄을, 최신순이 아니면 모든 쪽을 읽었을 때만 가장 늦은 줄을 현행본으로 봅니다. 읽지 못한 쪽이 남아 확인할 수 없으면 그 규정은 내려받지 않고 `PDF_REVISION_UNVERIFIED`(`reason: CONFIRMATION_PAGES_UNREAD`)로 남기며 `searchPagesTruncated`·`confirmationPagesTruncated`·`truncated`를 켭니다. `currentRevisionConfirmedByTitle`은 재확인이 필요했던 조회 대상 후보를 모두 확인했을 때만 `true`입니다. 확인 불가뿐 아니라 형식 오류·전송 실패·취소로 재확인이 끝나지 않았거나 조회가 중단되어 시도하지 못한 후보도 `currentRevisionUnverified`에 셉니다. 재확인 단계의 실패는 원래 실패 코드에 `stage:"revision_confirmation"`과 `reason`(`CONFIRMATION_PAGES_UNREAD`·`TITLE_NOT_FOUND`·`CONFIRMATION_REQUEST_FAILED`)을 붙이고, 현행본을 확인한 뒤의 문서 실패는 `stage:"document"`로 구분합니다.
  - 세종대는 현행 규정 전체가 한 페이지(약 5MB)에 실려 있어 이 대학에만 응답 한도를 6 MiB로 두고, 원문은 캐시에 두지 않은 채(캐시는 UTF-8 바이트 기준 2 MiB 이하만) 파싱한 목록만 10분 동안 재사용합니다(`coverage.mode:"catalog_pdf"`). 시행일은 목록에 적힌 시행일(`effectiveSource:"list"`)이며, 목록에 제정·개정 날짜만 있는 규정은 시행일 미확인입니다.
  - 가천대는 규정집 위젯의 공개 JSON 목록과 규정별 첨부를 읽습니다(`coverage.mode:"catalog_files"`). 첨부가 PDF면 텍스트 레이어를, 한글 파일이면 기존 HWP 추출기의 본문을 씁니다(`sourceType`으로 구분). 그 밖의 형식은 `DOCUMENT_FORMAT_UNSUPPORTED`, 한글 파일 해석 실패는 `HWP_PARSE_FAILED`·`HWP_NO_ARTICLES`로 규정별 실패에 남깁니다.
- 한국외대와 상명대는 넣지 않았습니다. 한국외대 규정집은 본문이 이미지라 OCR 없이는 읽을 수 없고, 상명대 규정집은 게스트 로그인 세션이 있어야 열립니다(로그인·쿠키를 쓰지 않는 원칙).
- PDF는 8 MiB·200페이지·추출 텍스트 100만 코드 단위로 제한하고, 별도 worker에서 최대 10초·동시 2건까지 추출합니다. 초과·취소는 실패 사유로 반환합니다. PDF 바이너리는 공용 텍스트 캐시에 저장하지 않습니다. `pdf-parse` 2.4.5를 고정하며 지원 런타임은 Node 20.19.x 이상 20계열 또는 22.3 이상입니다(Node 21 제외). CI는 20.19·22·24에서 검증합니다. [추출기 공식 호환성 문서](https://github.com/mehmet-kozan/pdf-parse/blob/main/docs/troubleshooting.md)
- `retrieved`, `partial`, `no_match_in_scope`, `unsupported`, `unavailable` 구분. 조문 미발견은 규정 부존재를 뜻하지 않음. HWP 별표·시행일·법적 적용성은 미확인.
- 참고 저장소 2026년 7월 탐지 설정 포팅으로 현재 가용성을 보장하지 않음. 차단 우회·로그인·리다이렉트 없음. 서울시립·숭실은 참고 자료의 HTTP 공개 주소.
- 기본으로 켜져 있습니다(공개·재무 프로필 모두). 운영자가 `DONGGUK_UNIVERSITY_COMPARISON_ENABLED=0`을 넣었을 때만 꺼지고, 그때는 `NOT_CONFIGURED`와 꺼진 사유를 돌려줍니다. `get_service_info`의 `integrations.universityComparison.configured`에 켜짐 여부를 표시합니다.
- 서울대(`snu`)만 추가로 `DONGGUK_LAWGO_OC`(법제처 Open API 인증키, 무료)가 필요합니다. 키가 없으면 다른 대학은 정상 동작하고 서울대 열만 `unavailable (LAWGO_OC_NOT_CONFIGURED)`로 표시되며, 그 열의 `notice`·`setup`에 무엇이 없는지와 신청처를 안내합니다. 키는 open.law.go.kr에서 신청해 접근제한 환경파일로 주입하고 명령행·문서에 적지 않습니다.
- 외부대학에 쿠키·인증정보 전송 없음. 호출 전체 60초 제한, 요청당 8초, 외부대학당 15초 예산, 대학별 500ms 간격, HTML·JSON 응답 2 MiB 제한(세종대 목록만 6 MiB, 문서는 8 MiB). 시간 초과 시 받은 결과는 유지하고 남은 대학은 `TOTAL_TIMEOUT`으로 표시합니다. 공개 텍스트 응답 10분/최대 64개 메모리 캐시(UTF-8 2 MiB 이하 응답만)와 중복 요청 합치기. 백그라운드 크롤링·재시도 없음.

실측 예(2026-11-24, "겸직"): 동국대는 「JA교원 운영규정」 등 다른 사안 20건을 빼고 「전임교원 인사규정 시행세칙」 제37조·제39조·제40조를 주규정으로, 국민·건국은 전용 겸직 규정을 주규정으로 표시하며, 기간 칸은 조문 제목이 그 요소인 국민 「제7조(겸직 기간)」을 고릅니다.

합성 테스트 출력 예: 동국대 `제9조`와 고려대 `제5조`를 각각 발췌하고 고려대 열에 `coverage.mode:"public_folder_list"`, `status:"partial"`, "공개 규정만"을 표시합니다. 실제 학교의 지급 기준을 뜻하지 않습니다.

포팅 출처·라이선스: [THIRD_PARTY](THIRD_PARTY.md).

비교 표에는 짧은 발췌를, 표 아래에는 학교별 조문 본문을 제공합니다.

호출의 대기 취소는 공유 캐시 로더를 취소하지 않습니다. 다른 요청이 기다리는 원문 요청은 자체 시간 제한(외부대학 8초, 기존 동국 요청 20초) 내에서 완료되며, 취소된 비교 호출은 다음 원문 요청을 시작하지 않습니다. 타대학 전문검색 후보도 제목의 주제 일치를 우선 정렬합니다.

### 타대학 개정 감시 CLI

`npm run university-watch -- --snapshot /local/private/university-watch.json`으로 19개 대학 대표 여비 규정의 개정일·시행일·본문 앞부분 해시·실패를 직전 기록과 비교할 수 있습니다. 기본은 Markdown 출력이며 Slack 게시에는 명시적인 `--post`가 필요합니다. `--usage-only`는 `DONGGUK_MCP_USAGE_LOG_DIR`의 비교 실패 로그만 집계합니다. [운영 안내](OPERATIONS.md#타대학-주간-스모크와-사용-로그)를 참고하세요. 일반 비교의 캐시 TTL 10분·버전은 유지합니다.

# 동국 규정 MCP

동국대학교 구성원이 AI에서 [공식 통합규정관리시스템](https://rule.dongguk.edu/)의 규정·조문·별표·개정 이력을 찾는 읽기 전용 MCP 서버입니다. **기본 `rules` 프로필은 공개 규정용**이며, 내부 재무지식 기능은 별도 `finance` 프로필로 선택합니다.

[구성원 시작 페이지](https://dgu.kr-univ-rules.com/guide) · [상세 사용 가이드](docs/COP_GUIDE.md) · [운영 가이드](docs/OPERATIONS.md) · [CoP 평가 가이드](docs/EVALUATION.md) · [GitHub 릴리스](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/tag/v0.12.0)

**v0.12.0**은 HWP 원문을 우선해 조문을 비교하고, 표의 셀 좌표·병합 범위·값과 포함된 그림의 파일 내용을 함께 비교합니다. 문서마다 실제 추출 범위와 미지원 항목을 표시하며, HWP를 읽지 못해 HTML로 대체한 결과는 부분 비교로 남깁니다. [v0.12.0 변경 기록](docs/RELEASE-v0.12.0.md)에서 범위를 확인하세요. 출장비·외부 강사료의 교내 규정·한국법령 공동 조회 기능은 유지합니다. [자동 법령 연계 안내](docs/AUTO_LEGAL_INTEGRATION.md) · [v0.10.4 변경 기록](docs/review-2026-10-27.md) · [이전 개선 기록](docs/review-2026-10-07.md) · [빠른 사용과 운영 설정](docs/PERFORMANCE.md)

개발판 **v0.14.0**은 규정이 인용한 국가 법령 조문의 원문을 함께 가져오는 `get_rule_references(include_law_text=true)`와, 최근 개정된 규정과 변경 조문을 정리해 Slack에 올리는 `npm run weekly-updates`를 추가했습니다.

개발판 **v0.15.1**은 타대학 규정 비교를 크게 넓혔습니다. 같은 사안을 규정명이 아니라 주체·행위·규율 요소로 정의한 **사안 프레임**(겸직·여비·연구비·등록금 반환·퇴직급여·근로장학·장학금)으로 조문을 고르고 규율 요소 × 대학 대조표를 보여 주며, 규정 제목 검색을 먼저 돌려 전담 규정을 찾습니다. 비교 대상은 경희·숙명여대·광운·명지·서강·이화·서울대(OC 키 필요)·연세가 더해져 13곳이고, 고려대는 공개 규정 범위만 조회합니다. 규정명이 없는 자연어 질문이 30초 뒤 실패하던 `lookup_dongguk_rule`도 색인 우선 조회로 고쳤습니다. [변경 기록](CHANGELOG.md)

이전 개발판 v0.15.0은 규정이 인용한 국가 법령을 현행 법령 목록과 대조하는 `get_rule_upper_laws`와, 동국대와 타대학 규정의 주제어 일치 조문을 나란히 보여 주는 `compare_university_rules`(운영자가 켤 때만 동작)를 추가했습니다. 띄어 쓴 규정명 인식과 법령 인용 추출도 고쳤습니다. [변경 기록](CHANGELOG.md)

**v0.13.0**은 여러 규정의 개정 여부를 한 번에 점검하는 `check_rule_updates`, 규정이 인용한 교내 규정·국가 법령과 그 규정을 인용한 교내 규정을 찾는 `get_rule_references`, 전체 공개 규정의 전문 색인을 추가했습니다. 색인이 있으면 `search_rule_deep`이 공식 사이트 전문검색 대신 색인에서 후보를 찾고 현행 개정본과 대조합니다. [점검 기록](docs/review-2026-11-11.md)

이전 개발판 v0.12.3은 부칙이 본칙과 섞여 `제1조`·`제2조` 조회와 인용 검증이 막히던 문제를 고치고, `부칙(2024.8.27.) 제1조`처럼 부칙 개정일로 조문을 고를 수 있게 했습니다. 규정명이 없는 질문과 원문에 없는 단어가 섞인 전문검색은 핵심어로 다시 찾습니다. [점검 기록](docs/review-2026-11-09.md)

이전 개발판 v0.12.2는 “여비규정 별표를 보여줘” 같은 자연어 질문에서 별표를 놓치는 문제를 고치고, 표 아래 여러 문단의 주석을 함께 반환합니다. 별표 번호·가지번호를 구분하며, 원문에서 별표 본체를 찾지 못하면 미확인 상태를 표시합니다. [별표 조회 수정](docs/appendix-query-2026-11-05.md)과 이전 [유지보수 및 새 기능 검토](docs/review-2026-11-05.md)에 범위·검증을 정리했습니다. 아래 설치 링크는 게시된 v0.12.0을 가리킵니다.

## 시작하기

| 방법 | 준비 | 연결 |
|---|---|---|
| 공용 서버 | 원격 MCP 지원 앱. 인증 없이 주소만 입력 | `https://dgu.kr-univ-rules.com/mcp/rules` |
| 내 PC | Node.js 20.19 이상, 로컬 MCP 지원 앱 | 아래 GitHub 릴리스 설치, 공유 토큰 불필요 |

공용 주소는 공개 규정 조회 전용이며 접속한 곳(IP)마다 1분 60회·하루 1,000회까지 받습니다. 넘으면 HTTP 429와 재시도 시간을 돌려줍니다. 동국대학교의 공식 서비스가 아닌 개인 운영 도구입니다. 앱·요금제·기관 정책별 연결 가능 여부는 실제 환경에서 확인해야 합니다.

### 개인 설치

**npm 레지스트리는 현재 미발행**입니다. GitHub의 고정 버전 패키지로 설치합니다.

```bash
npm install -g https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/download/v0.12.0/dongguk-rule-mcp-0.12.0.tgz
dongguk-rule-mcp --version
dongguk-rule-mcp --doctor --json
```

[tgz를 내려받아](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/download/v0.12.0/dongguk-rule-mcp-0.12.0.tgz) `npm install -g ./dongguk-rule-mcp-0.12.0.tgz`로 설치해도 됩니다. 설치 권한이 제한된 기관 PC에서는 [직접 실행 방법](docs/COP_GUIDE.md) 또는 공용 연결을 확인하세요.

사용할 앱의 설정 예시를 출력합니다. 아래 중 하나를 선택해 기존 MCP 설정에 추가한 뒤 앱을 완전히 종료하고 다시 실행합니다.

```bash
dongguk-rule-mcp --print-config codex
dongguk-rule-mcp --print-config claude
dongguk-rule-mcp --print-config cursor
```

업데이트 뒤에는 설치 파일의 `--version`, 공용 서버의 `/health`, 실제 앱 연결의 `get_service_info` 버전을 각각 확인합니다. Codex의 기존 연결이 구버전을 유지하면 앱을 완전히 종료한 뒤 다시 실행하고 같은 도구로 재확인합니다. Aside의 도구 목록 갱신과 확인 절차는 [운영 가이드](docs/OPERATIONS.md#클라이언트와-기존-연결-갱신)를 따릅니다.

출력은 현재 Node와 설치 경로를 사용하며 앱 설정을 직접 변경하지 않습니다. 패키지를 이동·삭제한 경우 새 경로에서 설정을 다시 출력합니다. `--doctor --json`은 오프라인 설치 점검이고, `--doctor --json --live`는 대표 공개 규정 조회를 추가합니다. 설치 진단만으로 앱 연결·모든 원문·업무 적용이 검증되지는 않습니다.

### 첫 질문

> 동국 규정 MCP의 `get_service_info`로 버전과 도구를 확인해줘. 이어서 `lookup_dongguk_rule`로 출장 관련 규정을 찾아줘. 소속·캠퍼스는 [입력], 신분은 [입력], 업무 기준일은 [YYYY-MM-DD]야. 정확한 규정명·LAW_ID·HISTORY_ID·조문/별표·원문 링크를 보여주고, 적용범위·시행일·표의 행과 단위를 확인하기 전 금액이나 전결권자를 확정하지 마.

### 평소 빠르게 질문하기

연결 확인 후에는 `get_service_info`를 매번 부를 필요가 없습니다. 규정명과 핵심어를 포함해 바로 조회하고, 근거가 충분하면 같은 검색·본문·목차를 반복 조회하지 않습니다.

> 동국규정에서 여비규정의 국내 숙박비 기준을 찾아줘. 관련 조문·별표와 원문 링크를 먼저 보여주고 핵심만 짧게 정리해줘. 근거가 부족하거나 잘렸으면 그 부분만 추가 확인해줘.

`lookup_dongguk_rule` 한 번으로 검색·최신 개정본·원문 HWP·관련 별표를 함께 받습니다. 짧은 답변과 별개로 필요한 표의 행·단위·주석, 적용범위와 시행일은 확인해야 합니다. [앱 지침 예시와 캐시 사전 준비](docs/PERFORMANCE.md)

급여·출장비·위임전결·과거 감사·기안문 인용에 바로 적용할 질문과 도구 입력 예시는 [업무 활용 가이드](docs/WORKFLOWS.md)를 참고하세요.

## 공개 규정 도구 — 기본 14개

| 도구 | 용도 |
|---|---|
| `get_service_info` | 버전·프로필·도구 범위·이용 안내 확인 |
| `lookup_dongguk_rule` | 기본 조회: 자연어/규정명 검색 → 개정본 → HWP 조문·별표 발췌; `law_id` 직접 선택 지원 |
| `search_rule` | 제목·전문으로 규정 후보 목록 검색 |
| `get_rule_content` | 선택한 규정의 본문·조문·장·키워드 조회 |
| `get_rule_toc` | 목차 조회 |
| `list_rule_history` | 개정 이력 조회 |
| `applicable_rule` | 기준일 이전 개정본 후보와 부칙의 명시 시행일 대조 |
| `compare_rule_versions` | HWP 조문 우선 비교와 별표·서식 텍스트, 표 셀·병합 범위, 그림 파일 내용 비교 |
| `verify_rule_citations` | 비식별 문장의 규정명·조문·제목·항 인용 실존 점검 |
| `search_rule_deep` | 여러 규정의 전문과 관련 조문 탐색. 전문 색인이 있으면 색인 사용(`mode`로 선택) |
| `check_rule_updates` | 여러 규정의 개정 여부 일괄 점검, 기준일 이후 개정된 규정 목록 |
| `get_rule_references` | 규정·조문이 인용한 교내 규정·국가 법령과 역방향 인용(색인 필요). `include_law_text=true`이면 인용된 법령 조문의 현행 원문까지 |
| `get_rule_upper_laws` | 규정·조문이 인용한 국가 법령을 현행 법령 목록과 대조: 현행 여부·시행일, 인용 조문의 존재·삭제, 옛 법령명, 규정 개정 뒤 법령 개정, 시행예정 개정을 점검 신호로 표시. `include_text=true`이면 조문 원문 대조 |
| `compare_university_rules` | 동국대와 타대학(최대 5개) 규정에서 주제어가 든 조문을 학교별로 나란히 표시. 기본 꺼짐(`DONGGUK_UNIVERSITY_COMPARISON_ENABLED=1`), 자세한 범위는 아래 "타대학 규정 비교" |

기본 단일 조회에서 후보가 모호하면 `AMBIGUOUS_RULE`과 후보 목록을 반환합니다. 제목·적용범위를 확인한 뒤 후보의 `LAW_ID`를 `lookup_dongguk_rule`의 `law_id`로 보내 선택합니다. 관련 없는 첫 검색 결과를 업무 근거로 확정하지 않습니다.

**캠퍼스 자동필터는 없습니다.** 공식 화면의 `LAWGROUP`은 캠퍼스 구분이 아닌 문서 종류입니다. 잘못된 `seoul=1 / wise=2` 매핑을 제거했습니다. `campus`는 업무 맥락으로 보존하고 전체 통합목록을 검색하며 `filterApplied:false`를 표시합니다. 서울·WISE·법인 등 소속과 교원·직원·학생 등 대상의 적용범위는 원문에서 확인해야 합니다. [공식 검색 화면](https://rule.dongguk.edu/lmxsrv/main/main.srv), [통합 규정목록](https://rule.dongguk.edu/lmxsrv/law/lawTree.srv) — 2026-09-08 확인.

## 근거의 범위와 한계

- **시점:** 최신 연혁은 최대 10분 캐시합니다. `applicable_rule`은 개정일을 바탕으로 후보를 찾으며 시행일·경과조치·소급 적용까지 최종 확정하지 않습니다.
- **원문 품질:** HWP 추출 실패·HTML 대체·빈 본문·발췌 잘림·검색어 미일치를 구분합니다. 비교 결과에는 문서별 추출 범위와 실제 미지원 객체·누락 진단을 남깁니다. 공식 API가 아닌 웹 원문 파싱이므로 사이트 변경의 영향을 받습니다.
- **개정 비교:** 양쪽 개정본의 HWP 조문을 우선 비교합니다. HWP를 읽을 수 없으면 HTML 조문으로 대체하고 부분 상태와 대체 사유를 표시합니다. 기본값인 `include_appendices:true`에서는 별표·서식 텍스트와 표의 셀 좌표·행/열 병합 범위·값, 포함된 그림 파일의 SHA-256 해시도 비교합니다. `include_appendices:false`는 별표·서식 비교를 생략하며 HWP 조문 우선 원칙은 유지합니다.
- **결과 해석:** 그림 파일의 동일·변경 판정은 OCR, 그림 속 문구의 의미 해석 또는 페이지 배치 비교를 뜻하지 않습니다. 실제 추출 누락·미지원 객체·식별 모호성은 부분 상태로 남기며 “변경 없음”으로 단정하지 않습니다. 시행일과 업무 적용성은 부칙·적용범위를 별도로 확인합니다.
- **전문 색인:** `dongguk-rule-mcp --build-index`로 만든 색인은 후보를 찾는 데만 씁니다. 규정명이 없는 질문("국내출장 일비와 숙박비 한도")은 색인에서 핵심어가 가장 많이 나오는 규정을 고르고(`search.mode:"핵심어 색인"`), 1위가 뚜렷하면 `candidate_preview`로 발췌를 바로 보여 주되 `RULE_IDENTITY_UNCONFIRMED`로 표시합니다. 후보가 비슷하면 `AMBIGUOUS_RULE`에 후보별 일치어와 대표 조문을 붙여 돌려줍니다. 어느 규정에도 없는 단어는 규정이 쓰는 짧은 형태로 바꿔 찾고(교내근로장학금→근로장학금, 국내출장→출장) 바꾼 단어를 표시합니다. 색인이 없으면 공식 사이트 전문검색(요청당 약 10초, 최대 4회)으로 대체합니다. 결과마다 현행 목록의 최신 개정본과 대조하고, 색인 이후 개정된 규정은 현행 본문을 다시 읽습니다. 색인이 없거나 8일을 넘기면 공식 사이트 검색을 사용합니다. 색인은 HTML 본문 기준이라 별표·금액표는 `lookup_dongguk_rule`로 확인합니다.
- **법령 원문 연계:** 운영자가 `DONGGUK_LEGAL_MCP_*`와 `DONGGUK_PUBLIC_LAW_LINK=1`을 설정한 서버에서만 동작합니다. 조문이 특정된 인용만, 한 번에 3개 조문까지 현행 원문을 가져옵니다. 규정 제정·개정 당시의 조문과 다를 수 있습니다. 법령 서버가 응답하지 않으면 규정 인용 결과만 돌려줍니다.
- **상위법령 관계:** `get_rule_upper_laws`의 점검 신호는 규정을 다시 볼 지점이며, 법령과 규정의 충돌이나 적용 여부의 판정이 아닙니다. 법령은 조회 시점의 현행본과 대조합니다. 조문 개정 표시는 공포일 기준이고, 인용한 규정 조문에 개정 표시일이 없으면 규정 개정일과 비교합니다. 제명이 바뀐 법령은 같은 번호의 현행 조문을 보여 주되 같은 내용이라고 보지 않습니다. 법령을 인용하지 않은 규정에 붙는 주제 후보는 규정 제목으로 고른 목록입니다. 한 번에 법령 12개·조문 8개까지 확인하고, 법령 연계가 꺼진 서버에서는 확인할 법령명·조문만 돌려줍니다.
- **인용 관계:** `get_rule_references`와 `get_rule_upper_laws`는 이름을 적은 인용을 찾습니다. "「사립학교법」 제29조, 제31조 및 제32조의2"처럼 나열한 조문, 같은 조문 안의 "동법"·"같은 법 시행령", "(이하 "시행령"이라 한다)"로 정의한 약칭을 앞의 법령에 연결합니다(`anaphora`, `defined_abbreviation`). 낫표 없이 띄어 쓴 법령명은 앞 단어까지 넓혀 추정하고 `name_heuristic`으로 표시하며, 법령 서버에서 정식 이름과 맞춰 본 뒤에만 확정합니다. "관계 법령"처럼 이름이 없는 인용과 다른 조문에 걸친 "동법"은 찾지 못합니다. 역방향 조회의 범위는 색인 범위와 같습니다.
- **인용:** 인용의 실존 확인과 해당 업무의 적용 적합성은 다릅니다. 검색 0건·확인 필요·부분 조회는 검증 통과가 아닙니다.
- **업무와 데이터:** 공개 `rules`는 로그인 쿠키와 내부 지식팩을 사용하지 않습니다. 개인별 급여·계좌·학생기록·인증정보를 입력하지 않습니다. 신고·지급·결재 또는 외부 발송을 수행하지 않습니다.

모든 도구는 읽기용 Markdown `content`와 기계용 `structuredContent`를 함께 반환합니다. v0.10.2부터 `structuredContent`를 표시하지 않는 클라이언트에서도 확인할 수 있도록 `get_service_info`의 `version`·`profile`·`toolCount`와 `lookup_dongguk_rule`의 `sourceType`·`evidenceStatus`·부분 조회 사유를 Markdown에도 표시합니다. 자동화에서는 `ok`, `data`, `error.code`와 개별 원문의 경고·부분 상태를 함께 확인합니다. 규정명·LAW_ID·HISTORY_ID·조문/별표 위치·기준일·조회일·원문 URL을 기록하면 근거를 다시 확인할 수 있습니다.

v0.10.1의 `lookup_dongguk_rule`은 응답과 규정별 `evidenceStatus`(`retrieved`/`partial`) 및 규정별 `incompleteReasons`를 반환합니다. HWP 대체·빈 발췌·글자 수 제한·미확정 후보는 부분 조회이며, `retrieved`도 발췌 확보만 뜻하고 적용성 판단은 아닙니다. `rule_keyword`와 `query`를 함께 보내도 질문으로 관련 부분을 찾으며 명시한 `terms`가 우선합니다. 여러 단어로 된 질문은 현행 규정 목록에서 질문에 들어 있는 가장 긴 규정 제목을 찾아 그 규정을 고릅니다(`identityStatus:"catalog_title"`). "등록금에 관한 시행세칙 제7조 반환"처럼 띄어 쓴 제목도 낫표 없이 인식합니다. 규정 이름은 발췌 검색어에서 빼므로, 남은 단어가 본문에 없으면 `NO_MATCHING_EXCERPT`로 알립니다. 비정상 검색 페이지는 `NOT_FOUND` 대신 `UPSTREAM_FORMAT_CHANGED`로 반환하고 새 캐시에 저장하지 않습니다.

## 공용 서버와 선택 기능

HTTP는 stateless Streamable HTTP이며 MCP 경로는 POST 요청을 사용합니다.

| 경로 | 범위 |
|---|---|
| `/`, `/guide` | 인증정보를 포함하지 않는 구성원 안내 페이지 |
| `/mcp/rules` | 서버 프로필과 무관하게 공개 규정 14개 도구. 공용 서버에서는 인증 없이 열고 IP별 호출 제한 적용 |
| `/mcp` | 운영자가 지정한 프로필의 도구, 기존 연결 경로. 공용 서버에서는 토큰 필요 |
| `/health`, `/ready` | 프로세스·요청 수용 상태; 원문 조회 성공을 의미하지 않음 |
| `/status` | 관리용 인증이 필요한 집계 운영 상태 |

운영자가 개인 또는 그룹별 자격증명을 발급·회수하고 만료·허용 경로를 관리합니다. 등록 파일은 SHA-256 해시를 보관하며 `--token-file` 또는 `DONGGUK_MCP_TOKEN_FILE`로 지정합니다. 설정 예시와 발급 명령은 [운영 가이드](docs/OPERATIONS.md)에 있습니다. 토큰 없이 여는 프로세스는 `rules` 프로필로만 띄우고, 재무 기능이 있는 경로에는 HTTPS와 인증을 사용합니다.

```bash
# 접근제한 운영 폴더의 토큰 등록 파일을 지정
dongguk-rule-mcp --http --profile rules --host 127.0.0.1 --port 3845 --token-file /secure/dongguk/tokens.json
```

공용 서버는 Mac mini에서 운영되며 잠자기·전원·인터넷·터널·공식 원문 서버 상태에 따라 중단될 수 있습니다. 전교 동시 이용 규모·기관 SSO·모든 구성원의 앱 연결·현업 시간절감은 별도 검증 대상이며, 이 릴리스가 전원 계정 개통이나 가용성 SLA를 의미하지 않습니다.

`--profile finance` 또는 `DONGGUK_MCP_PROFILE=finance`를 선택하면 `get_finance_context`, `get_finance_evidence`, `search_finance_handbook`, `review_finance_case`가 추가되어 **18개 도구**가 됩니다. 내장 출장비·외부 강사료 공동 조회는 내부 자료팩 없이 사용할 수 있습니다. 그 외 기존 재무 업무 카드 조회는 검토한 비식별 지식팩을 `DONGGUK_FINANCE_PACK_PATH`로 별도 연결해야 합니다. 법령 연계와 로그인 쿠키도 선택 프로필의 운영 설정으로 관리합니다. 내부 자료는 공개 저장소·패키지에 포함하지 않습니다.

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

실원문 검사는 원문 서버에 접근 가능한 네트워크가 필요합니다. HTTP 오류만으로 특정 IP 차단을 단정하지 않습니다. 자동 검사와 현업 효과는 구분하고, 실제 앱·캠퍼스·직군별 평가는 [빈 평가 양식](examples/cop-evaluation.csv)으로 기록합니다.

추가 설정: `DONGGUK_RULE_ALIASES`는 부서별 규정 별칭 JSON, `DONGGUK_MCP_NO_CACHE=1`은 디스크 캐시 비활성화입니다. 나머지 실행 옵션은 `dongguk-rule-mcp --help`와 [운영 가이드](docs/OPERATIONS.md)를 확인하세요.

## 라이선스·기여

MIT. 원본 Python 구현: 서준호. Node.js MCP 포팅·운영 개선: 오승훈. [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)에서 영감을 받았습니다.

[GitHub Issues](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/issues)에 버전·비식별 재현 질문·오류코드를 남겨주세요. 개인 정보·인증값·내부 문서를 첨부하지 않습니다.

[Finance Desk 통합 기능과 외부 자료팩 설정](docs/FINANCE_DESK.md)

## 타대학 규정 비교 (개발 중)

`compare_university_rules`는 동국대와 타대학의 같은 사안 조문을 학교별 열로 나란히 보여줍니다. 행 순서나 조문 번호는 법적 동등성을 뜻하지 않습니다.

**사안 프레임**: 규정명과 위계(규정·세칙·내규)는 대학마다 다르므로, 등록된 주제(겸직·여비·연구비·등록금 반환·퇴직급여·근로장학·장학금)는 사안을 **주체 × 행위 × 규율 요소**로 정의한 프레임(`src/issue-frames.js`)으로 조문을 고릅니다. 같은 단어가 다른 뜻으로 쓰인 조문(교내 겸무의 "겸직", 지도교수의 학과 겸직 등)은 제외어로 빼고 `columns[].dropped`에 사유별 건수만 남깁니다. 남은 조문에는 규율 요소(`slots`: 허가권자·기간·보수 등)와 주체, 조문이 인용한 국가 법령(`anchorLaws`, 프레임의 근거 법령과 같으면 `inFrame`)을 붙이고, 대학별로 주규정(`role: primary`, 제목에 사안어가 있거나 요소를 가장 많이 다루는 규정)과 보조규정을 가릅니다. `slotMatrix`는 규율 요소 × 대학 표로, 칸마다 `found`(규정·조문·근거 줄·URL·시행일)·`not_found_in_scope`·`unavailable`·`unsupported`를 구분합니다. 빈 칸은 조회 범위에서 찾지 못했다는 뜻이며 규정 부존재가 아닙니다. 모든 판정은 문자열 대조이고 법적 동등성·적용 여부가 아닙니다(`alignment: "issue_frame_slots_not_legal_equivalence"`). 미등록 주제는 주제어 일치 발췌만 제공합니다. 등록 프레임은 `get_service_info`의 `universityComparison.issueFrames`와 결과의 `supportedTopics`에 나옵니다.

```json
{"topic":"여비","universities":["korea","uos"],"max_articles":3}
```

- 동국대 자동 포함. 타대학 키: `korea`(고려), `uos`(서울시립), `konkuk`(건국), `kookmin`(국민), `ssu`(숭실), `khu`(경희), `sookmyung`(숙명여대), `kw`(광운), `mju`(명지), `sogang`(서강), `ewha`(이화), `snu`(서울대, OC 키 필요), `yonsei`(연세). 한 번에 최대 5개. 다른 영문 키는 `unsupported`.
- `columns`마다 조문 번호·본문·규정명·URL·개정일(동국만 확인, 타대학 미확인)·시행일(`effectiveAt`과 출처 `effectiveSource`: 규정 목록의 시행일자 `list` 또는 마지막 부칙의 명시 시행일 `addenda`, `null`은 미확인), `status`, `coverage`, 실패 내역 제공. 학교당 최대 5개 조문, 조문당 2,000자이며 잘림 표시.
- 주제어는 접두어(교내·교외·학부·대학원·학사)와 끝의 '금'을 떼고 등록된 동의어로 넓힙니다(교내근로장학금 → 근로장학·근로보조금·교내근로·근로학생). 동의어 검색은 후보가 부족할 때만 추가로 합니다(`coverage.queries`).
- 서울시립은 `.srv`, 국민·숭실·경희·숙명여대는 `.do` 검색을 씁니다. 먼저 규정 제목 검색(대표어와 첫 제목 단서, `coverage.titleQueries`·`titleMatches`)으로 사안을 전담하는 규정(「전임교원 겸직허가에 관한 규정」 등)을 찾아 가장 먼저 읽고(`matchedBy:"title"`), 그다음 전문검색 첫 페이지 후보를 더해 최대 5개 규정을 조회합니다. 제목 검색이 실패하면 전문검색만으로 이어갑니다. 건국·광운·명지는 공개 규정 트리 전체(각 430·255·267개)에서 제목을 대조합니다(`coverage.mode:"title_tree"`, 제목에 주제 단서가 없는 규정 속 조문은 놓칠 수 있어 `complete:false`). 명지는 본문 제목·부칙이 `lawname2`·`addenda2` 클래스라 함께 처리합니다. 고려는 로그인 없이 **약 55개 규정만 공개**하며(다른 규정은 로그인 화면으로 이동, 2026-11-24 확인) 검색·전체 트리·부서별 목록도 세션이 필요합니다. 공개 분류 목록(`lawListManager`, 8개 분류, 10건씩 페이지 넘김)을 모두 읽어 제목을 대조하고(`coverage.mode:"public_folder_list"`, `publicOnly:true`), 결과 표의 상태에 "공개 규정만"을 붙입니다. 목록에 없는 규정(예: 여비규정)은 비공개로 추정되며 조회할 수 없습니다. 목록 형식이 바뀌면 최근 개정 목록(`recent_list_only`)으로 대체합니다. 동국은 제목 검색 우선·미발견 시 전문검색 20행을 규정 단위로 합쳐 후보 최대 5개를 조회합니다.
- LawMaster가 아닌 대학은 전용 어댑터로 조문을 읽습니다. **서강**(`sogang`)은 자체 REST JSON(`coverage.mode:"rest_json"`)에서 주제어를 제목으로 질의해 매칭 규정의 `content`(조문 HTML)를 받고, **이화**(`ewha`)는 규정집 목록 HTML의 `view-rule` 링크를 따라 각 규정 `.fr-view`의 조문 전문을 읽습니다(`coverage.mode:"html_catalog"`). 두 대학의 조문·부칙 HTML은 공통 변환기(`htmlToArticleMarkdown`)로 `### 제N조`·`## 부칙` 형식으로 바꿔 동일 비교 파이프라인에 올립니다. 개정일은 머리말·부칙 헤딩의 날짜 중 가장 늦은 날, 시행일은 마지막 부칙의 명시일로 채웁니다. 서강대 서버가 중간 인증서를 빠뜨려 TLS 체인이 끊기므로, 공개 중간 인증서(`src/ca/`)를 기본 루트에 **추가**해 검증을 끄지 않고 해결합니다.
- **서울대**(`snu`, 국립)는 규정이 각 대학 사이트가 아니라 국가법령정보센터(law.go.kr)의 학칙 채널에 공개됩니다. DRF 공개 API(`target=school`)를 XML로 직접 호출하며(`coverage.mode:"lawgo_school"`), 운영자가 law.go.kr에서 발급한 무료 OC 키를 `DONGGUK_LAWGO_OC`로 넣어야 동작합니다(중간 서버 없음). 목록(`lawSearch`)의 `<admrul>`에서 소관부처=서울대·현행 규정만 골라 발령일자(개정일)·시행일자를 읽고, 본문(`lawService`)의 `<조문내용>` 요소를 조문 단위로 받습니다. OC 키가 없으면 해당 열이 `unavailable (LAWGO_OC_NOT_CONFIGURED)`로 표시됩니다. 인용 URL에는 OC 키를 넣지 않습니다. 사립대는 이 학칙 채널에 대부분 없습니다.
- **연세대**(`yonsei`)는 규정집이 Next.js(App Router) 앱이라 공개 REST API가 없습니다. 페이지에 내장된 RSC flight 데이터(`self.__next_f.push`)를 재조립해 목록(현행 682개 규정의 이름·개정일·UUID)과 본문(규정 페이지의 조문 HTML row)을 읽습니다(`coverage.mode:"nextjs_rsc"`, 로그인 불필요). 본문 HTML row의 길이는 바이트 기준이라 버퍼로 정확히 잘라 인접 데이터가 새지 않게 합니다. flight 스키마는 배포마다 바뀔 수 있어 필드명(`name`·`revisionHistories`·`html`) 기반으로 느슨하게 파싱합니다.
- `retrieved`, `partial`, `no_match_in_scope`, `unsupported`, `unavailable` 구분. 조문 미발견은 규정 부존재를 뜻하지 않음. HWP 별표·시행일·법적 적용성은 미확인.
- 참고 저장소 2026년 7월 탐지 설정 포팅으로 현재 가용성을 보장하지 않음. 차단 우회·로그인·리다이렉트 없음. 서울시립·숭실은 참고 자료의 HTTP 공개 주소.
- 기본 비활성입니다. 운영자가 `DONGGUK_UNIVERSITY_COMPARISON_ENABLED=1`로 켜야 요청이 나갑니다(공개·재무 프로필 모두). `get_service_info`에 설정 여부를 표시합니다.
- 서울대(`snu`)만 추가로 `DONGGUK_LAWGO_OC`(law.go.kr에서 발급하는 무료 OPEN API OC 키)가 필요합니다. 키가 없으면 다른 대학은 정상 동작하고 서울대 열만 `unavailable (LAWGO_OC_NOT_CONFIGURED)`로 표시됩니다. 키는 law.go.kr 로그인 → OPEN API 신청에서 받아 접근제한 환경파일로 주입하고 명령행·문서에 적지 않습니다.
- 외부대학에 쿠키·인증정보 전송 없음. 호출 전체 60초 제한, 요청당 8초, 외부대학당 15초 예산, 대학별 500ms 간격, 응답 2 MiB 제한. 시간 초과 시 받은 결과는 유지하고 남은 대학은 `TOTAL_TIMEOUT`으로 표시합니다. 공개 응답 10분/최대 64개 메모리 캐시와 중복 요청 합치기. 백그라운드 크롤링·재시도 없음.

실측 예(2026-11-24, "겸직"): 동국대는 「JA교원 운영규정」 등 다른 사안 20건을 빼고 「전임교원 인사규정 시행세칙」 제37조·제39조·제40조를 주규정으로, 국민·건국은 전용 겸직 규정을 주규정으로 표시하며, 기간 칸은 조문 제목이 그 요소인 국민 「제7조(겸직 기간)」을 고릅니다.

합성 테스트 출력 예: 동국대 `제9조`와 고려대 `제5조`를 각각 발췌하고 고려대 열에 `coverage.mode:"public_folder_list"`, `status:"partial"`, "공개 규정만"을 표시합니다. 실제 학교의 지급 기준을 뜻하지 않습니다.

포팅 출처·라이선스: [THIRD_PARTY](docs/THIRD_PARTY.md).

비교 표에는 짧은 발췌를, 표 아래에는 학교별 조문 본문을 제공합니다.

호출의 대기 취소는 공유 캐시 로더를 취소하지 않습니다. 다른 요청이 기다리는 원문 요청은 자체 시간 제한(외부대학 8초, 기존 동국 요청 20초) 내에서 완료되며, 취소된 비교 호출은 다음 원문 요청을 시작하지 않습니다. 타대학 전문검색 후보도 제목의 주제 일치를 우선 정렬합니다.

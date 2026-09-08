# 동국 규정 MCP

동국대학교 구성원이 AI에서 [공식 통합규정관리시스템](https://rule.dongguk.edu/)의 규정·조문·별표·개정 이력을 찾는 읽기 전용 MCP 서버입니다. **v0.9.0의 기본 `rules` 프로필은 공개 규정용**이며, 내부 재무지식 기능은 별도 `finance` 프로필로 선택합니다.

[구성원 시작 페이지](https://dgu.kr-univ-rules.com/guide) · [상세 사용 가이드](docs/COP_GUIDE.md) · [운영 가이드](docs/OPERATIONS.md) · [CoP 평가 가이드](docs/EVALUATION.md) · [GitHub 릴리스](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/tag/v0.9.0)

## 시작하기

| 방법 | 준비 | 연결 |
|---|---|---|
| 공용 서버 | 원격 MCP 지원 앱, 운영자가 개인/그룹별로 발급한 인증정보 | `https://dgu.kr-univ-rules.com/mcp/rules` |
| 내 PC | Node.js 20.19 이상, 로컬 MCP 지원 앱 | 아래 GitHub 릴리스 설치, 공유 토큰 불필요 |

공용 연결의 인증정보는 운영자에게 받습니다. 기존 관리자 토큰을 전 구성원에게 공유하지 않습니다. 앱·요금제·기관 정책별 연결 가능 여부는 실제 환경에서 확인해야 합니다.

### 개인 설치

**npm 레지스트리는 현재 미발행**입니다. GitHub의 고정 버전 패키지로 설치합니다.

```bash
npm install -g https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/download/v0.9.0/dongguk-rule-mcp-0.9.0.tgz
dongguk-rule-mcp --version
dongguk-rule-mcp --doctor --json
```

[tgz를 내려받아](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases/download/v0.9.0/dongguk-rule-mcp-0.9.0.tgz) `npm install -g ./dongguk-rule-mcp-0.9.0.tgz`로 설치해도 됩니다. 설치 권한이 제한된 기관 PC에서는 [직접 실행 방법](docs/COP_GUIDE.md) 또는 공용 연결을 확인하세요.

사용할 앱의 설정 예시를 출력합니다. 아래 중 하나를 선택해 기존 MCP 설정에 추가한 뒤 앱을 완전히 종료하고 다시 실행합니다.

```bash
dongguk-rule-mcp --print-config codex
dongguk-rule-mcp --print-config claude
dongguk-rule-mcp --print-config cursor
```

출력은 현재 Node와 설치 경로를 사용하며 앱 설정을 직접 변경하지 않습니다. 패키지를 이동·삭제한 경우 새 경로에서 설정을 다시 출력합니다. `--doctor --json`은 오프라인 설치 점검이고, `--doctor --json --live`는 대표 공개 규정 조회를 추가합니다. 설치 진단만으로 앱 연결·모든 원문·업무 적용이 검증되지는 않습니다.

### 첫 질문

> 동국 규정 MCP의 `get_service_info`로 버전과 도구를 확인해줘. 이어서 `lookup_dongguk_rule`로 출장 관련 규정을 찾아줘. 소속·캠퍼스는 [입력], 신분은 [입력], 업무 기준일은 [YYYY-MM-DD]야. 정확한 규정명·LAW_ID·HISTORY_ID·조문/별표·원문 링크를 보여주고, 적용범위·시행일·표의 행과 단위를 확인하기 전 금액이나 전결권자를 확정하지 마.

## 공개 규정 도구 — 기본 10개

| 도구 | 용도 |
|---|---|
| `get_service_info` | 버전·프로필·도구 범위·이용 안내 확인 |
| `lookup_dongguk_rule` | 기본 조회: 자연어/규정명 검색 → 개정본 → HWP 조문·별표 발췌; `law_id` 직접 선택 지원 |
| `search_rule` | 제목·전문으로 규정 후보 목록 검색 |
| `get_rule_content` | 선택한 규정의 본문·조문·장·키워드 조회 |
| `get_rule_toc` | 목차 조회 |
| `list_rule_history` | 개정 이력 조회 |
| `applicable_rule` | 기준일 이전 개정본 후보와 부칙의 명시 시행일 대조 |
| `compare_rule_versions` | 같은 규정의 HTML 조문과 HWP 별표·서식 추출 텍스트 비교 |
| `verify_rule_citations` | 비식별 문장의 규정명·조문·제목·항 인용 실존 점검 |
| `search_rule_deep` | 여러 규정의 전문과 관련 조문 탐색 |

기본 단일 조회에서 후보가 모호하면 `AMBIGUOUS_RULE`과 후보 목록을 반환합니다. 제목·적용범위를 확인한 뒤 후보의 `LAW_ID`를 `lookup_dongguk_rule`의 `law_id`로 보내 선택합니다. 관련 없는 첫 검색 결과를 업무 근거로 확정하지 않습니다.

**캠퍼스 자동필터는 없습니다.** 공식 화면의 `LAWGROUP`은 캠퍼스 구분이 아닌 문서 종류입니다. 잘못된 `seoul=1 / wise=2` 매핑을 제거했습니다. `campus`는 업무 맥락으로 보존하고 전체 통합목록을 검색하며 `filterApplied:false`를 표시합니다. 서울·WISE·법인 등 소속과 교원·직원·학생 등 대상의 적용범위는 원문에서 확인해야 합니다. [공식 검색 화면](https://rule.dongguk.edu/lmxsrv/main/main.srv), [통합 규정목록](https://rule.dongguk.edu/lmxsrv/law/lawTree.srv) — 2026-09-08 확인.

## 근거의 범위와 한계

- **시점:** 최신 연혁은 최대 10분 캐시합니다. `applicable_rule`은 개정일을 바탕으로 후보를 찾으며 시행일·경과조치·소급 적용까지 최종 확정하지 않습니다.
- **원문 품질:** HWP 추출 실패·HTML 대체·빈 본문·발췌 잘림·검색어 미일치를 구분합니다. 병합 셀·그림·추출되지 않은 내용은 원문 대조가 필요합니다. 공식 API가 아닌 웹 원문 파싱이므로 사이트 변경의 영향을 받습니다.
- **개정 비교:** `include_appendices:true`가 기본입니다. HTML 조문 결과와 HWP 별표·서식의 **추출 텍스트 비교**를 별도로 반환합니다. 표의 의미·셀 구조·첨부파일·법적 적용성의 완전한 비교는 아닙니다. 별표를 식별하지 못하거나 조회에 실패하면 부분 상태를 남기며 “변경 없음”으로 단정하지 않습니다. HTML만 비교하려면 `include_appendices:false`를 지정합니다.
- **인용:** 인용의 실존 확인과 해당 업무의 적용 적합성은 다릅니다. 검색 0건·확인 필요·부분 조회는 검증 통과가 아닙니다.
- **업무와 데이터:** 공개 `rules`는 로그인 쿠키와 내부 지식팩을 사용하지 않습니다. 개인별 급여·계좌·학생기록·인증정보를 입력하지 않습니다. 신고·지급·결재 또는 외부 발송을 수행하지 않습니다.

모든 도구는 읽기용 Markdown `content`와 기계용 `structuredContent`를 함께 반환합니다. 자동화에서는 `ok`, `data`, `error.code`와 개별 원문의 경고·부분 상태를 함께 확인합니다. 규정명·LAW_ID·HISTORY_ID·조문/별표 위치·기준일·조회일·원문 URL을 기록하면 근거를 다시 확인할 수 있습니다.

## 공용 서버와 선택 기능

HTTP는 stateless Streamable HTTP이며 MCP 경로는 POST 요청을 사용합니다.

| 경로 | 범위 |
|---|---|
| `/`, `/guide` | 인증정보를 포함하지 않는 구성원 안내 페이지 |
| `/mcp/rules` | 서버 프로필과 무관하게 공개 규정 10개 도구, 설정한 인증 적용 |
| `/mcp` | 운영자가 지정한 프로필의 도구, 기존 연결 경로 |
| `/health`, `/ready` | 프로세스·요청 수용 상태; 원문 조회 성공을 의미하지 않음 |
| `/status` | 관리용 인증이 필요한 집계 운영 상태 |

운영자가 개인 또는 그룹별 자격증명을 발급·회수하고 만료·허용 경로를 관리합니다. 등록 파일은 SHA-256 해시를 보관하며 `--token-file` 또는 `DONGGUK_MCP_TOKEN_FILE`로 지정합니다. 설정 예시와 발급 명령은 [운영 가이드](docs/OPERATIONS.md)에 있습니다. 원격 노출에는 HTTPS와 인증을 사용합니다.

```bash
# 접근제한 운영 폴더의 토큰 등록 파일을 지정
dongguk-rule-mcp --http --profile rules --host 127.0.0.1 --port 3845 --token-file /secure/dongguk/tokens.json
```

공용 서버는 Mac mini에서 운영되며 잠자기·전원·인터넷·터널·공식 원문 서버 상태에 따라 중단될 수 있습니다. 전교 동시 이용 규모·기관 SSO·모든 구성원의 앱 연결·현업 시간절감은 별도 검증 대상이며, 이 릴리스가 전원 계정 개통이나 가용성 SLA를 의미하지 않습니다.

`--profile finance` 또는 `DONGGUK_MCP_PROFILE=finance`를 선택하면 `get_finance_context`, `get_finance_evidence`가 추가되어 **12개 도구**가 됩니다. 검토한 비식별 지식팩을 `DONGGUK_FINANCE_PACK_PATH`로 별도 연결해야 합니다. 법령 연계와 로그인 쿠키도 선택 프로필의 운영 설정으로 관리합니다. 내부 자료는 공개 저장소·패키지에 포함하지 않습니다.

## 소스 실행과 검증

```bash
git clone --branch v0.9.0 https://github.com/buenosiempre-cmd/dongguk-rule-mcp.git
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
| `npm run benchmark` | 로컬 HTTP 부하 측정; 전교 운영 용량이나 원문 서버 SLA 검증은 아님 |
| `npm run issue-token -- --help` | 운영자용 개인/그룹 자격증명 발급 도구 사용법 |

실원문 검사는 원문 서버에 접근 가능한 네트워크가 필요합니다. HTTP 오류만으로 특정 IP 차단을 단정하지 않습니다. 자동 검사와 현업 효과는 구분하고, 실제 앱·캠퍼스·직군별 평가는 [빈 평가 양식](examples/cop-evaluation.csv)으로 기록합니다.

추가 설정: `DONGGUK_RULE_ALIASES`는 부서별 규정 별칭 JSON, `DONGGUK_MCP_NO_CACHE=1`은 디스크 캐시 비활성화입니다. 나머지 실행 옵션은 `dongguk-rule-mcp --help`와 [운영 가이드](docs/OPERATIONS.md)를 확인하세요.

## 라이선스·기여

MIT. 원본 Python 구현: 서준호. Node.js MCP 포팅·운영 개선: 오승훈. [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)에서 영감을 받았습니다.

[GitHub Issues](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/issues)에 버전·비식별 재현 질문·오류코드를 남겨주세요. 개인 정보·인증값·내부 문서를 첨부하지 않습니다.

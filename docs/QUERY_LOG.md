# 질문 로그와 노션 동기화

공용 서버에서 사람들이 무엇을 묻는지 남겨 검색 품질(자연어 정답률)을 높이는 데 씁니다. 기본은 꺼져 있고, 운영자가 `DONGGUK_MCP_QUERY_LOG_DIR`를 넣은 HTTP 서버에서만 켜집니다. 기존 사용 로그(`DONGGUK_MCP_USAGE_LOG_DIR`)와는 별개입니다.

## 수집 고지 (공개 문구 초안)

> 동국 규정 MCP 공용 서버는 검색 품질 개선을 위해 검색어(질문)를 저장합니다. 저장 전에 주민등록번호·전화번호·이메일·카드·계좌번호와 긴 숫자를 자동으로 가립니다. IP 주소, 계정·토큰, 답변 본문은 저장하지 않습니다. 저장한 검색어는 운영자만 보며 1년이 지나면 지웁니다. 이름이나 사건 내용 같은 개인정보는 질문에 넣지 마세요. 삭제를 원하면 질문한 날짜와 대략의 문구를 운영자에게 알려 주세요.

`get_service_info`의 `privacy.queryLog`(`enabled`, `retentionDays`, `notice`)와 본문 `검색어 저장:` 줄이 서버 설정에 따라 이 내용을 그대로 알려 줍니다.

## 저장하는 것

대상 도구와 저장하는 인자(첫 번째로 값이 있는 것 하나만):

| 도구 | 인자 |
|---|---|
| `lookup_dongguk_rule` | `query`, 없으면 `rule_keyword` |
| `search_rule` | `keyword` |
| `search_rule_deep` | `query` |
| `applicable_rule` | `query`, 없으면 `rule_keyword` |
| `compare_university_rules` | `topic` |
| `search_finance_handbook`, `get_finance_context`, `get_finance_evidence` (회원 `/mcp`만) | `query` |

`review_finance_case`(기안문 `text`·`facts`), `get_rule_content`의 `grep`, `verify_rule_citations`의 `text`와 그 밖의 도구는 저장하지 않습니다.

JSONL 한 줄(`queries-YYYY-MM.jsonl`, 디렉터리 0700·파일 0600):

| 필드 | 내용 |
|---|---|
| `id` | 무작위 UUID(노션 중복 확인용) |
| `ts` | 요청 시각(KST, `+09:00`) |
| `tool` | 도구 이름 |
| `endpoint` | `/mcp/rules`(공개) 또는 `/mcp`(회원) |
| `query` | 마스킹한 질문, 최대 200자(넘으면 `…`) |
| `queryMasked` | 가린 유형 목록(예: `["phone"]`) |
| `queryTruncated` | 잘렸는지 |
| `status` | `ok` / `error` / `unobserved` |
| `resultStatus` | `retrieved`·`partial`·`no_results` 등 또는 오류 코드(`NOT_FOUND` 등, 영문 코드만) |
| `resultCount` | 결과 규정·문서 수(타대학 비교는 조문이 나온 대학 수) |
| `topRule` | 첫 결과 규정명(마스킹, 최대 100자) |
| `durationMs` | 소요 시간 |

다른 입력값, 답변 본문, IP, 헤더, 토큰, 회원 식별자는 저장하지 않습니다. 원래 질문은 요청을 받자마자 마스킹하고 원문은 보관하지 않습니다. 로그 쓰기 실패나 큐 포화(128건)는 응답에 영향을 주지 않으며 그때 기록은 빠질 수 있습니다. 서버는 노션을 호출하지 않습니다.

## 마스킹 규칙

순서대로 적용합니다.

| 유형 | 예 | 바뀐 값 |
|---|---|---|
| URL | `https://…` | `[URL]` |
| 이메일 | `hong@dgu.ac.kr` | `[이메일]` |
| 비밀값(영문·숫자 섞인 24자 이상) | API 키, 토큰 | `[비밀값]` |
| 주민·외국인등록번호 | `900101-1234567` | `[주민번호]` |
| 카드번호 | `1234-5678-9012-3456`, 16자리 | `[카드번호]` |
| 전화번호 | `010-1234-5678`, `02-2260-3114`, `+82 10…`, `1588-1234` | `[전화번호]` |
| 사업자등록번호 | `123-45-67890` | `[사업자번호]` |
| 계좌번호(하이픈·공백으로 나뉜 숫자 합계 10자리 이상) | `110-123-456789` | `[계좌번호]` |
| 7자리 이상 연속 숫자 | 학번·사번 `2023123456` | `[숫자]` |

날짜(`2024-01-01`), 조문(`제10조의2`), 별표, 쉼표 금액(`1,000,000원`)은 유지합니다. 쉼표 없는 7자리 이상 금액은 `[숫자]`가 됩니다. **사람 이름과 사건 서술은 자동으로 가리지 못합니다.** 그래서 고지 문구로 입력하지 말라고 안내하고, 노션에서 대표가 보고 지웁니다. 동기화 스크립트는 올리기 직전에 한 번 더 마스킹합니다.

## 노션 데이터베이스 설계

데이터베이스는 운영자가 직접 만들고 통합(integration)에 공유합니다. 속성 이름은 스크립트와 같아야 합니다.

| 속성 | 유형 | 채우는 쪽 | 설명 |
|---|---|---|---|
| 질문 | 제목(title) | 스크립트 | 마스킹한 질문 |
| 시각 | 날짜(date) | 스크립트 | KST 요청 시각 |
| 도구 | 선택(select) | 스크립트 | 도구 이름 |
| 경로 | 선택 | 스크립트 | `공개(/mcp/rules)` / `회원(/mcp)` |
| 결과 | 선택 | 스크립트 | `retrieved`, `partial`, `no_results`, `NOT_FOUND` 등 |
| 결과 건수 | 숫자 | 스크립트 | |
| 찾은 규정 | 텍스트 | 스크립트 | 첫 결과 규정명 |
| 소요시간(ms) | 숫자 | 스크립트 | |
| 답 품질 | 선택: 미검토·정답·오답·모름 | 스크립트가 `미검토`로 넣고 대표가 바꿈 | |
| 정답 규정 | 텍스트 | 대표 | 오답일 때 맞는 규정명(쉼표로 여러 개) |
| 메모 | 텍스트 | 대표 | |
| 로그 ID | 텍스트 | 스크립트 | 중복 확인용, 보기에서 숨김 |

권장 보기: `미검토`(답 품질=미검토, 시각 내림차순), `결과 없음`(결과=no_results 또는 NOT_FOUND), `오답 모음`(답 품질=오답), `도구별`(도구로 묶기).

## 동기화

```sh
# 미리보기(노션 호출 없음, 상태 변경 없음, 토큰 불필요)
node scripts/sync-query-log-notion.js --dry-run

# 올리기
NOTION_QUERY_LOG_TOKEN=… NOTION_QUERY_LOG_DATABASE_ID=… DONGGUK_MCP_QUERY_LOG_DIR=… \
  node scripts/sync-query-log-notion.js [--max 500] [--prune] [--prune-notion]
```

- 토큰: `NOTION_QUERY_LOG_TOKEN`(환경변수만, 출력하지 않음). DB ID: `NOTION_QUERY_LOG_DATABASE_ID` 또는 `--database-id`.
- 중복 방지: 파일별 바이트 오프셋을 `<로그 디렉터리>/notion-sync-state.json`(0600, `DONGGUK_MCP_QUERY_LOG_SYNC_STATE`나 `--state`로 변경)에 기록하고 페이지 하나를 만들 때마다 갱신합니다. 줄바꿈이 없는 마지막 줄(쓰는 중)은 다음 실행으로 미룹니다. 손상된 줄은 건너뜁니다. 페이지 생성 직후 프로세스가 죽은 경우에만 한 줄이 두 번 올라갈 수 있으며 `로그 ID`로 찾을 수 있습니다.
- 한 번에 최대 `--max`건(기본 500), 요청 간 0.35초, 429·5xx는 `Retry-After`를 따라 최대 5번 재시도합니다. Notion API 버전 `2022-06-28`.
- 주기: 하루 한 번(예: 매일 07:00 KST) launchd로 충분합니다.

## 보관 기간과 삭제

- 기본 1년(`DONGGUK_MCP_QUERY_LOG_RETENTION_DAYS`, 1~3650일).
- `--prune`: 달 전체가 보관 기간보다 오래된 로컬 `queries-YYYY-MM.jsonl`을 지웁니다.
- `--prune-notion`: `시각`이 보관 기간보다 오래된 노션 페이지를 보관(archive) 처리합니다. 노션 휴지통에서 30일 뒤 완전히 지워집니다.
- 특정 질문 삭제 요청: 노션에서 해당 페이지를 지우고, 로컬 JSONL에서 같은 `id` 줄을 지웁니다(오프셋이 바뀌므로 그 달 파일을 손댄 뒤에는 상태 파일의 해당 파일 항목을 현재 파일 크기로 맞춥니다).
- 수집을 끄려면 런처에서 `DONGGUK_MCP_QUERY_LOG_DIR`를 빼고 재시작합니다.

## 오답을 정답률 질문 세트로

대표가 `답 품질`을 `오답`으로 바꾸고 `정답 규정`을 적으면 다음 명령이 평가기 형식(`[질문, [정답 규정…]|null, null]`)으로 내보냅니다. 같은 질문은 한 번만 넣고, 정답 규정이 빈 줄은 채점하지 않는 줄(`null`)로 둡니다.

```sh
node scripts/sync-query-log-notion.js --export-wrong /local/private/nl-holdout-from-notion.json
npm run evaluate:natural-language -- --questions /local/private/nl-holdout-from-notion.json
```

내보낸 질문은 개발에 쓰기 전에 홀드아웃(평가 전용)과 개발용으로 나눠, 홀드아웃은 키워드 보강에 보지 않는 것을 권장합니다.

## 공용 서버 반영 시 런처 변경(별도 승인)

이 기능이 들어간 릴리스로 버전을 바꿀 때 `public-rules`·`public-http` 런처에 아래를 추가합니다.

```sh
export DONGGUK_MCP_QUERY_LOG_DIR="$HOME/.local/share/dongguk-rule-mcp/queries"
export DONGGUK_MCP_QUERY_LOG_RETENTION_DAYS=365
```

동기화는 서버와 별도의 LaunchAgent(예: `com.bueno.dongguk-query-log-sync`, 매일 07:00)로 돌리고, 토큰은 그 LaunchAgent가 읽는 0600 파일이나 키체인에서 넣습니다. 서버 런처에는 노션 토큰을 넣지 않습니다.

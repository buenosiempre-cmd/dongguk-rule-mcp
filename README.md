# dongguk-rule-mcp

동국대학교 통합규정관리시스템(rule.dongguk.edu)을 AI에서 직접 검색·조회하는 MCP 서버.

> [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)에서 영감.
> 공무원에게 korean-law-mcp가 있다면, 대학 교직원에게는 dongguk-rule-mcp가 있다.

## 도구 (11개)

| 도구 | 설명 |
|------|------|
| `get_finance_context` | **v0.8** — 선택 연결한 재무지식 팩에서 필수 사실·판단카드·절차·완료 증빙 조회 |
| `get_finance_evidence` | **v0.8** — 기준일 교내 규정 후보와 Korean Law MCP의 현행 법령·요청 조문 조회, 부분 실패·개정 차이 표시 |
| `lookup_dongguk_rule` | **기본 권장** — 검색→최신 HWP 원문→관련 조문·별표를 한 번에 조회 |
| `verify_rule_citations` | **v0.7 신규** — 기안문·공문 텍스트의 규정 인용을 실존·조문 제목·항 번호까지 대조 (환각 게이트) |
| `applicable_rule` | **v0.7 신규** — 기준일의 개정일 기준 후보 선택 + 부칙 시행일 대조 + 현행 대비 변경 요약 |
| `search_rule` | 키워드 검색 (제목/전문, 캠퍼스 필터) |
| `get_rule_content` | 규정 본문 마크다운 조회 (조문/장/키워드 필터) |
| `get_rule_toc` | 목차만 빠르게 조회 |
| `list_rule_history` | 개정 연혁 목록 |
| `compare_rule_versions` | 두 HISTORY_ID의 조문별 추가·삭제·변경 비교 |
| `search_rule_deep` | 전문검색 → 본문에서 조문까지 자동 추출 |

`lookup_dongguk_rule`은 HTML 본문에 포함되지 않는 원문 HWP의 별표와 금액표까지 파싱합니다.
Notion AI가 보내는 전체 자연어 `query`와 짧은 규정명 `rule_keyword`를 모두 지원합니다.
일반적인 규정 질문에는 이 도구를 먼저 사용하면 여러 도구를 반복 호출할 필요가 없습니다.

`verify_rule_citations`는 결재 전 인용 점검용입니다. 「규정명」 낫표·가운뎃점 표기(·ㆍ‧•・)·"같은 규정" 조응
(문단 경계에서 승계 중단)을 처리하고, 검색 0건은 ✗(미존재)가 아닌 ⚠(확인필요)로 보고합니다 — ⚠는 통과가 아닙니다.
`applicable_rule`은 연혁의 '개정일' 기준으로 기준일 적용본을 특정하되, 본문 부칙에서 명시 시행일을 추출해
시행일이 기준일 이후면 직전 개정본 적용 가능성을 경고합니다 (개정일≠시행일 한계 상시 고지).
검색어에는 별칭 사전이 적용됩니다 — 내장 별칭에 더해 `DONGGUK_RULE_ALIASES`(JSON 경로)로 부서별 약칭을 확장할 수 있습니다.

모든 도구는 기존 Markdown `content`와 함께 `structuredContent`를 반환합니다. 자동화에서는
`ok`, `tool`, `data` 또는 `error.code`를 사용하면 텍스트를 다시 파싱하지 않아도 됩니다.
대표 오류코드는 `INVALID_ARGUMENT`, `NOT_FOUND`,
`UPSTREAM_UNAVAILABLE`, `UPSTREAM_FORMAT_CHANGED`, `HISTORY_NOT_FOUND`, `CONTENT_UNAVAILABLE`입니다.

통합 조회는 검색 결과의 오래된 HISTORY_ID 대신 연혁의 첫 개정본을 선택합니다.
연혁 캐시는 최대 10분이며, 최신 개정본이 특정 기준일에 시행 중이라는 뜻은 아닙니다.
개정 비교는 두 HISTORY_ID가 해당 규정 연혁에 있는지 확인하며, HTML 조문만 비교합니다.
HWP 별표·첨부 변경과 시행일 판단은 비교 범위에 포함되지 않습니다.

## 요구사항

- **Node.js 18 이상** (`node --version`으로 확인)
- 원문 서버에 접근 가능한 네트워크 (HTTP 503은 일시 장애·접속 제한 등 원인을 추가 확인해야 함)

## 설치 — 4가지 방법

### 방법 A: GitHub에서 바로 (권장 — 한 줄)

Claude Desktop 설정에 아래만 추가하면 설치·실행이 자동으로 됩니다 (Node 18+ 필요):

```json
{
  "mcpServers": {
    "dongguk-rule": {
      "command": "npx",
      "args": ["-y", "github:buenosiempre-cmd/dongguk-rule-mcp"]
    }
  }
}
```

### 방법 B: tarball 직접 설치

[Releases](https://github.com/buenosiempre-cmd/dongguk-rule-mcp/releases)에서 tgz 다운로드 후:

```bash
npm install -g ./dongguk-rule-mcp-0.8.0.tgz
dongguk-rule-mcp --version   # 0.8.0 나오면 성공
```

### 방법 C: 소스 폴더에서

```bash
git clone https://github.com/buenosiempre-cmd/dongguk-rule-mcp.git
cd dongguk-rule-mcp
npm install
npm test                     # 오프라인 회귀 검증
node src/index.js --version
```

### 방법 D: npm 레지스트리 (publish 후)

```bash
npm install -g dongguk-rule-mcp
```

## Claude Desktop 설정

`claude_desktop_config.json` 위치:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

글로벌 설치(방법 A/C) 시:

```json
{
  "mcpServers": {
    "dongguk-rule": {
      "command": "dongguk-rule-mcp"
    }
  }
}
```

소스 폴더(방법 B) 시:

```json
{
  "mcpServers": {
    "dongguk-rule": {
      "command": "node",
      "args": ["/절대경로/dongguk-rule-mcp/src/index.js"]
    }
  }
}
```

설정 후 Claude Desktop 완전 종료 → 재시작.

## HTTP 모드 — Notion AI 연동

Notion 등 원격 MCP 클라이언트는 공개 URL만 연결할 수 있습니다. rule.dongguk.edu가
해외/데이터센터 IP를 차단하므로, 국내 IP의 상시 가동 머신(예: Mac Mini)에서 HTTP
모드로 실행하고 Cloudflare Tunnel로 URL을 노출하는 구성을 권장합니다.

### 1) 서버 실행 (Mac Mini)

```bash
dongguk-rule-mcp --http --port 3845 --token '아무-긴-비밀문자열'
curl -s http://127.0.0.1:3845/health   # {"status":"ok",...} 확인
```

`--token` 생략 시 무인증(테스트용) — 공개 노출 시엔 반드시 설정하세요.
옵션: `--host 0.0.0.0`, env `DONGGUK_MCP_TOKEN` / `DONGGUK_MCP_PORT`.

### 2) 공개 URL (Cloudflare Tunnel)

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:3845
# → https://xxxx.trycloudflare.com 발급 (임시 URL)
# 상시 운영은 named tunnel + 도메인 연결 권장
```

### 3) Notion 설정

1. 워크스페이스 관리자: 설정 → **연결** → **MCP** → **Custom MCP**
2. URL `https://xxxx.trycloudflare.com/mcp` + 표시 이름 + Bearer 토큰 → 연결
3. 일반 Notion AI 새 채팅에서 연결 이름을 명시해 질문
4. 읽기 전용 도구를 반복 승인하지 않으려면 해당 연결의 모든 도구를 항상 허용

커스텀 에이전트의 Tools & Access에서도 동일 URL을 연결할 수 있습니다.

### 수동 점검 (curl)

```bash
curl -s -X POST https://xxxx.trycloudflare.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer 아무-긴-비밀문자열' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

참고: HTTP 모드는 stateless(POST 전용)이며 `GET /health`로 모니터링합니다.
연결 UI가 Bearer 헤더를 지원하지 않으면 지원되는 인증 게이트웨이를 구성해야 합니다.
URL을 숨기는 것만으로는 인증을 대체할 수 없습니다.

## 사용 예시

- "동국대 보수규정 검색해줘"
- "`lookup_dongguk_rule`로 여비규정에서 국내, 철도운임, 숙박비, 일비 기준을 한 번에 찾아줘"
- "LAW_ID 491 본문 보여줘"
- "취업규칙 HISTORY_ID 3478과 3619의 제86조를 비교해줘"
- "제10조의2만 보여줘" / "부칙 제2조만 보여줘"
- "그 규정에서 퇴직금 관련 조문만" (grep 필터)
- "제5장만 보여줘" (chapter 필터)
- "이 규정 개정 이력 알려줘"
- "이 품의서 초안의 규정 인용 검증해줘: (본문 붙여넣기)" (v0.7)
- "2024년 3월 15일 당시 여비규정 제9조 보여줘" (v0.7)

## 검증

### 오프라인 (네트워크 불필요 — 어디서든 동일 결과)

```bash
npm test
```

오프라인 테스트는 운영 파서·별칭·시점·인용·MCP·HTTP·신뢰성 회귀를 검증합니다.
`npm pack --dry-run`으로 필수 소스와 테스트 포함 여부를 검증합니다.

### 실서버 (국내 IP에서)

```bash
npm run test:live                      # 검색어 "재정"
npm run test:live -- --keyword 보수
```

rule.dongguk.edu에 실제 접속해 검색·본문·연혁·HWP 원문 경로를 확인. 503이면 "국내 IP에서 실행하라"고 안내 후 종료.

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `HTTP 503` | 해외/데이터센터 IP 차단 | 가정·캠퍼스 등 국내망에서 실행 |
| `Cannot find module` | 의존성 미설치 | 프로젝트 폴더에서 `npm install` |
| `EACCES` (글로벌 설치) | 권한 부족 | `sudo npm i -g ...` 또는 nvm 사용 |
| Claude에 도구 안 보임 | config 오타/캐시 | JSON 문법 확인 후 Claude 완전 재시작 |
| 구버전 Node 에러 | Node <18 | `engines` 경고 확인, Node 18+ 설치 |
| 검색 0건 | 캠퍼스 코드 불일치 | `campus="all"`로 재시도 |

## 환경변수

| 변수 | 용도 |
|------|------|
| `DONGGUK_RULE_COOKIE` | 비공개 규정 열람용 로그인 쿠키 주입. 쿠키별 전용 캐시 사용 |
| `DONGGUK_MCP_NO_CACHE=1` | 디스크 캐시(`~/.cache/dongguk-rule-mcp/`) 비활성화 |
| `DONGGUK_RULE_ALIASES` | 별칭 사전 확장 JSON 경로. `{"전결규정": ["위임전결규정"]}` 형식 — 내장 별칭에 병합 |

## 알려진 제약

- **캠퍼스 LAWGROUP 코드(seoul=1, wise=2)는 추정값** — `npm run test:live`의 [5] 섹션 결과가 0행이면 브라우저 개발자도구 Network 탭에서 `LAWGROUP=` 실제 값 확인 필요.
- 공식 API가 아닌 HTML 파싱이므로 사이트 개편 시 파서 갱신 필요. 그 경우 실제 HTML로 `test/fixtures.js`를 갱신하고 `npm test`로 재검증.
- 비공개 규정 캐시는 쿠키 해시별로 분리하고 디렉터리 `0700`, 파일 `0600` 권한으로 저장합니다.

## 크레딧

- 원본 Python 구현: 서준호
- Node.js MCP 포팅·하드닝·npm 배포 구조: 오승훈 (동국대 재무팀)
- 영감: korean-law-mcp (류승인, 광진구청)

## 라이선스

MIT

## Finance AI Desk 선택 연결 (v0.8)

기존 9개 규정 도구는 그대로 동작합니다. 두 재무 도구는 운영자가 검토한 비식별 지식팩 JSON을
`DONGGUK_FINANCE_PACK_PATH`로 연결해야 합니다. 개인별 급여·계좌·신고 원시행은 팩에 넣지 않습니다.
팩은 공개 소스 저장소와 별도로 보관하고 배포합니다.

- `get_finance_context`: 질문을 업무 경로로 연결하며, 부족한 사실과 검토 필요 상태를 반환합니다.
- `get_finance_evidence`: 규정 최대 2건, 법령 최대 2건을 조회합니다. 교내 규정은 기준일의 개정일 후보, 국가 법령은 검색 시점 현행 후보입니다. 시행일·경과조치와 실제 적용성은 별도 확인합니다.
- HWP 대체·발췌 누락·법령 실패는 `partial`로 표시합니다. 개정본 식별자 변경은 특정 조항의 변경을 뜻하지 않습니다.
- 신고·납부·결재·지급·Slack 발송을 수행하지 않습니다.

Korean Law MCP는 `DONGGUK_LEGAL_MCP_ENABLED=1`, `LAW_OC`, 고정 버전 실행 경로를
`DONGGUK_LEGAL_MCP_COMMAND`와 `DONGGUK_LEGAL_MCP_ARGS` (JSON 배열)로 설정합니다.
비밀값은 소스·로그가 아닌 접근제한 환경파일이나 서비스 비밀변수에 둡니다.

`test/evaluate-finance.js`는 50개 라우팅·입력·법령 식별 파싱 사례를 검증합니다.
`DONGGUK_FINANCE_PACK_PATH`를 지정하면 실제 팩을, 생략하면 비식별 테스트 픽스처를 사용합니다.
자동 통과율은 법률 정답률이나 실제 업무시간 절감률이 아닙니다.

# dongguk-rule-mcp

동국대학교 통합규정관리시스템(rule.dongguk.edu)을 AI에서 직접 검색·조회하는 MCP 서버.

> [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)에서 영감.
> 공무원에게 korean-law-mcp가 있다면, 대학 교직원에게는 dongguk-rule-mcp가 있다.

## 도구 (7개)

| 도구 | 설명 |
|------|------|
| `lookup_dongguk_rule` | **기본 권장** — 검색→최신 HWP 원문→관련 조문·별표를 한 번에 조회 |
| `search_rule` | 키워드 검색 (제목/전문, 캠퍼스 필터) |
| `get_rule_content` | 규정 본문 마크다운 조회 (조문/장/키워드 필터) |
| `get_rule_toc` | 목차만 빠르게 조회 |
| `list_rule_history` | 개정 연혁 목록 |
| `compare_rule_versions` | 두 HISTORY_ID의 조문별 추가·삭제·변경 비교 |
| `search_rule_deep` | 전문검색 → 본문에서 조문까지 자동 추출 |

`lookup_dongguk_rule`은 HTML 본문에 포함되지 않는 원문 HWP의 별표와 금액표까지 파싱합니다.
Notion AI가 보내는 전체 자연어 `query`와 짧은 규정명 `rule_keyword`를 모두 지원합니다.
일반적인 규정 질문에는 이 도구를 먼저 사용하면 여러 도구를 반복 호출할 필요가 없습니다.

모든 도구는 기존 Markdown `content`와 함께 `structuredContent`를 반환합니다. 자동화에서는
`ok`, `tool`, `data` 또는 `error.code`를 사용하면 텍스트를 다시 파싱하지 않아도 됩니다.
대표 오류코드는 `INVALID_ARGUMENT`, `NOT_FOUND`, `UPSTREAM_BLOCKED`,
`UPSTREAM_UNAVAILABLE`, `UPSTREAM_FORMAT_CHANGED`입니다.

## 요구사항

- **Node.js 18 이상** (`node --version`으로 확인)
- **국내 IP** (rule.dongguk.edu가 해외/데이터센터 IP를 503 차단)

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
npm install -g ./dongguk-rule-mcp-0.6.0.tgz
dongguk-rule-mcp --version   # 0.6.0 나오면 성공
```

### 방법 C: 소스 폴더에서

```bash
git clone https://github.com/buenosiempre-cmd/dongguk-rule-mcp.git
cd dongguk-rule-mcp
npm install
npm test                     # 160개 자체 검증
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
Notion 연결 UI가 Bearer 헤더를 지원하지 않으면 토큰 없이 기동하되 URL을 비공개로 관리하세요.

## 사용 예시

- "동국대 보수규정 검색해줘"
- "`lookup_dongguk_rule`로 여비규정에서 국내, 철도운임, 숙박비, 일비 기준을 한 번에 찾아줘"
- "LAW_ID 491 본문 보여줘"
- "취업규칙 HISTORY_ID 3478과 3619의 제86조를 비교해줘"
- "제10조의2만 보여줘" / "부칙 제2조만 보여줘"
- "그 규정에서 퇴직금 관련 조문만" (grep 필터)
- "제5장만 보여줘" (chapter 필터)
- "이 규정 개정 이력 알려줘"

## 검증

### 오프라인 (네트워크 불필요 — 어디서든 동일 결과)

```bash
npm test
```

7개 스위트 160개: 파싱(45) + 유틸(22) + 통합 조회(17) + 개정비교·구조화응답(14) + 엣지케이스(12) + MCP 프로토콜(28, stdout 순수성 포함) + HTTP(22, Streamable HTTP·Bearer 인증·stateless).
실제 HTML 픽스처 기반이라 국내/해외/CI 어디서든 통과해야 정상.

`npm pack --dry-run`으로 약 36kB tarball과 필수 소스·테스트 17개 파일 포함 여부를 검증합니다.
MCP JSON-RPC 핸드셰이크에서는 도구 7개와 stdout 무오염을 확인합니다.

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

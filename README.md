# dongguk-rule-mcp

동국대학교 통합규정관리시스템(rule.dongguk.edu)을 AI에서 직접 검색·조회하는 MCP 서버.

> [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)에서 영감.
> 공무원에게 korean-law-mcp가 있다면, 대학 교직원에게는 dongguk-rule-mcp가 있다.

## 도구 (5개)

| 도구 | 설명 |
|------|------|
| `search_rule` | 키워드 검색 (제목/전문, 캠퍼스 필터) |
| `get_rule_content` | 규정 본문 마크다운 조회 (조문/장/키워드 필터) |
| `get_rule_toc` | 목차만 빠르게 조회 |
| `list_rule_history` | 개정 연혁 목록 |
| `search_rule_deep` | 전문검색 → 본문에서 조문까지 자동 추출 |

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
npm install -g ./dongguk-rule-mcp-0.3.0.tgz
dongguk-rule-mcp --version   # 0.3.0 나오면 성공
```

### 방법 C: 소스 폴더에서

```bash
git clone https://github.com/buenosiempre-cmd/dongguk-rule-mcp.git
cd dongguk-rule-mcp
npm install
npm test                     # 90개 자체 검증
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

## 사용 예시

- "동국대 보수규정 검색해줘"
- "LAW_ID 491 본문 보여줘"
- "그 규정에서 퇴직금 관련 조문만" (grep 필터)
- "제5장만 보여줘" (chapter 필터)
- "이 규정 개정 이력 알려줘"

## 검증

### 오프라인 (네트워크 불필요 — 어디서든 동일 결과)

```bash
npm test
```

4개 스위트 90개: 파싱(39) + 유틸(22) + 엣지케이스(10) + MCP 프로토콜(19, stdout 순수성 포함).
실제 HTML 픽스처 기반이라 국내/해외/CI 어디서든 통과해야 정상.

추가로 다음 설치 시나리오가 검증되었습니다: `npm pack` tarball(18kB) → 새 디렉토리
로컬 설치 → 설치된 bin으로 JSON-RPC 핸드셰이크(도구 5개·stdout 무오염), 글로벌
설치(`npm i -g`) 후 bin 실행, 설치본 내부 `npm test` 90개 통과(자급자족).

### 실서버 (국내 IP에서)

```bash
npm run test:live                      # 검색어 "재정"
npm run test:live -- --keyword 보수
```

rule.dongguk.edu에 실제 접속해 5개 도구를 호출. 503이면 "국내 IP에서 실행하라"고 안내 후 종료.

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
| `DONGGUK_RULE_COOKIE` | 비공개 규정 열람용 로그인 쿠키 주입 |
| `DONGGUK_MCP_NO_CACHE=1` | 디스크 캐시(`~/.cache/dongguk-rule-mcp/`) 비활성화 |

## 알려진 제약

- **캠퍼스 LAWGROUP 코드(seoul=1, wise=2)는 추정값** — `npm run test:live`의 [4] 섹션 결과가 0행이면 브라우저 개발자도구 Network 탭에서 `LAWGROUP=` 실제 값 확인 필요.
- 공식 API가 아닌 HTML 파싱이므로 사이트 개편 시 파서 갱신 필요. 그 경우 실제 HTML로 `test/fixtures.js`를 갱신하고 `npm test`로 재검증.

## 크레딧

- 원본 Python 구현: 서준호
- Node.js MCP 포팅·하드닝·npm 배포 구조: 오승훈 (동국대 재무팀)
- 영감: korean-law-mcp (류승인, 광진구청)

## 라이선스

MIT

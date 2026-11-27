# I02 날짜 부칙 인용 검증

`부칙(2099.1.1.) 제1조`를 본칙 제1조로 축소해 성공 처리하던 문제를 수정한다. 부칙 접두부를 먼저 전부 소비하고 `normalizeArticleSelector`로 해석하며, 본문 부칙 날짜도 같은 선택자로 대조한다. 해석 불가 접두부는 `ARTICLE_SELECTOR_UNVERIFIED`, 일치하는 날짜·조문 부재는 `NOT_FOUND`, 복수 부칙은 `ARTICLE_AMBIGUOUS`다. 날짜는 개정 부칙의 식별자이며 시행일의 법적 판단은 하지 않는다.

## 검증 결과 (2026-11-27)

기준: 원격 main `d08ef02c10ae33c237a83c335afeccdeaf993a64`에서 독립 worktree 생성.

- `npm test`: main 942 통과 / 0 실패 → I02 959 통과 / 0 실패. 각 테스트가 출력한 ✅/❌ 개수 합산, 두 실행 종료 코드 0.
- 인용 테스트: 37 → 54 통과 / 0 실패. 날짜 구분, 여러 날짜의 중복 제거, 줄바꿈, 날짜 미상, 괄호·공백·날짜 구분자 변형을 포함한다.
- 표준 `harness-d1.js` + `run2.sh`: 엄격 250/339, train/dev 68/71. 339에는 train/dev 71이 포함되며 나머지는 182/268이다. 합계 410으로 중복 집계하지 않았다.
- 기존 v10 원측정, 새 main 기준선, I02의 339개 문항 ID별 정오·오류·표시 규정 순서가 전부 동일. 신규 정답/오답 0/0.
- cache core manifest `dbc6d1faa9b83f08e80784b1ff53b7b76708ebc0e5f20266230b0b452ae219e7`; 원본을 전수해시 확인 후 작업별 사본에만 하네스를 실행했다. 비공개 문항·box-kit 미접근.

| 원래 citation-repros 입력 | main | I02 |
|---|---|---|
| 제1조 | EXISTS, verified 1 | 동일 |
| 제1조의12 | EXISTS, verified 1 | 동일 |
| 부칙 제1조 | EXISTS, verified 1 | 동일 |
| 부칙(2099.1.1.) 제1조 | EXISTS, 목적, verified 1 | NOT_FOUND, verified 0 |
| 별표999 | RULE_EXISTS, verified 1 | 동일: I03 범위 |
| 제1조의123 | 제1조의12 EXISTS, verified 1 | 동일: I03 범위 |
| 제1조 제999항 | 제1조 EXISTS, verified 1 | 동일: I03 범위 |
| search/history/body 장애 | 각 UNAVAILABLE, verified 0 | 동일 |

레드팀 스크립트의 10개 고유 입력(7개 인용+3개 장애)을 모두 재실행했다. 외부 스크립트의 6개 경로 슬롯에는 이번 측정 대상 하나만 연결했으므로, 60회 실행은 6개 서로 다른 PR 비교가 아니다. 저장소의 재현 스크립트는 동일 입력을 현재 checkout에 한 번씩 실행한다.

## 재현

```sh
npm test
node scripts/reproduce-citations.cjs /tmp/i02-citation-repros.json
```

전체 측정 디렉터리: `/Users/bueno/Documents/Codex/p1-citations-validation-20261127`.
`prepare.py`는 지정 인계 core/aux와 공개 문항 해시를 검증하고 새 폴더에 사본을 만든다. 기존 결과를 덮어쓰지 않도록 새 디렉터리에서 실행한다. `run.sh`의 worktree 경로를 측정 checkout으로 지정하고 `zsh run.sh i02`를 실행한다. `NL_SETS=train,dev,probe1,...,probe9,dev_open,scope12v2,scope22v2`, `NL_OFFLINE=1`, 빈 `query-only.json`, `DONGGUK_MCP_RANKING=legacy`, `DONGGUK_MCP_SEMANTIC=auto`이며 main은 의미검색 미구현이다.

근거 파일: `main-npm-test.log`, `i02-npm-test-final.log`, `main-results.json`, `i02-results.json`, `main-repros.json`, `i02-final-repros.json`. 공유 캐시를 수정하거나 v4→v3 호환 복사를 하지 않았다. 기존 main의 캐시 호환 오류 48건을 포함한 엄격 원측정과 비교했다.

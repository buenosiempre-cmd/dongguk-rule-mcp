# I03 미지원 인용 범위 보존과 성공 집계

별표999를 규정명만 확인한 `RULE_EXISTS`로, 제1조의123을 제1조의12로, 제1조 제999항을 제1조로 처리하던 오탐을 차단한다. 전체 숫자와 상세 선택자를 먼저 소비하고 지원하는 파싱 범위를 따로 보존한다. 미지원 범위는 `UNSUPPORTED_CITATION` / 확인필요이며 `summary.verified`에서 제외한다.

## 검증 결과 (2026-11-27)

원격 main `d08ef02c10ae33c237a83c335afeccdeaf993a64`에서 독립 worktree/브랜치를 만들었다. I02 위에 쌓은 브랜치가 아니다.

| 입력 | main | I03 |
|---|---|---|
| 제1조 | EXISTS, verified 1 | 동일 |
| 제1조의12 | EXISTS, verified 1 | 동일 |
| 부칙 제1조 | EXISTS, verified 1 | 동일 |
| 부칙(2099.1.1.) 제1조 | 본칙 EXISTS, verified 1 | UNSUPPORTED_CITATION, verified 0 |
| 별표999 | RULE_EXISTS, verified 1 | UNSUPPORTED_CITATION, verified 0 |
| 제1조의123 | 제1조의12 EXISTS, verified 1 | 전체 제1조의123 보존, UNSUPPORTED_CITATION, verified 0 |
| 제1조 제999항 | 제1조 EXISTS, verified 1 | 전체 범위 보존, UNSUPPORTED_CITATION, verified 0 |
| search/history/body 장애 | 각 UNAVAILABLE, verified 0 | 동일 |

- `npm test`: main 942 통과 / 0 실패 → I03 1,003 통과 / 0 실패. 각 테스트 출력의 ✅/❌ 합산, 종료 코드 0.
- 인용 테스트 37 → 98 통과 / 0 실패. 레드팀 전체 인용·장애, 정상 대조군, 별표·별지·서식·호·목, 항 1/50과 범위 밖 번호, 큰 정수·0·숫자 앞자리 절단, 혼합 인용, 실제 원문 오프셋을 검사한다.
- 표준 `harness-d1.js` + `run2.sh`: 엄격 250/339, train/dev 68/71. **339에 train/dev 71이 포함된다.** 나머지 공개 문항은 182/268이며 410으로 중복 집계하지 않았다.
- v10 원측정·이번 main·I02·I03 모두 339개 문항의 정오·오류·표시 규정 순서·발췌문·채점·검색 메타가 동일하다. 신규 오답 0. 기존 캐시 호환 오류 48건은 그대로 포함한 원측정이다.
- core manifest `dbc6d1faa9b83f08e80784b1ff53b7b76708ebc0e5f20266230b0b452ae219e7`, 보조 manifest `cc3c9fd1c09456c928d6444188b83e246941ec06756a0cbffe92e15fb52b6bf0`. 실행 후 core 733파일·보조 673파일 해시 전부 불변. 작업별 사본만 사용했으며 비공개 보류 문항·box-kit에는 접근하지 않았다.

## I02 #68과 겹치는 부분

두 브랜치 모두 `src/citations.js`의 인용 추출 정규식·필드·판정 시작 부분 및 `test/test-citations.js`를 수정한다. `scripts/reproduce-citations.cjs`는 동일한 새 파일이다.

I02는 날짜 부칙을 `normalizeArticleSelector`로 해석하고 일치하는 부칙 날짜를 필터링한다. I03은 범위를 버리지 않기 위해 날짜 접두부를 보존하되 이 독립 브랜치에서는 미지원으로 남긴다. 통합할 때에는 **I02의 정상 날짜 부칙 해석/날짜별 중복 구분/본문 날짜 필터**와 **I03의 전체 숫자 소비/범위 메타/미지원 상세항목 판정**을 모두 보존해야 한다. 정상 날짜 부칙까지 무조건 미지원 처리하도록 합치면 안 된다. 두 PR을 자동 병합하거나 병합 완료로 간주하지 않았다.

## 재현

```sh
npm test
node scripts/reproduce-citations.cjs /tmp/i03-citation-repros.json
```

스크립트는 레드팀 `citation-repros.cjs`의 7개 인용 + 3개 장애 입력을 현재 checkout에 한 번씩 적용하며 네트워크를 사용하지 않는다. 외부 원본의 6개 경로 슬롯을 같은 측정 checkout에 연결한 60회 결과도 보존했지만 6개 별도 PR의 결과라는 의미는 아니다.

전체 증거: `/Users/bueno/Documents/Codex/p1-citations-validation-20261127`.
`main-npm-test.log`, `i03-npm-test.log`, `main-repros.json`, `i03-repros.json`, `main-results.json`, `i03-results.json`, `validation.json` 및 `validate.py`에 결과와 비교가 있다.

새 측정 폴더에서 `prepare.py`로 지정 core/aux 및 공개 문항을 검증·복사하고, `run.sh`의 checkout 경로를 지정한 뒤 `zsh run.sh i03`으로 실행한다. `run2.sh`와 `harness-d1.js` 원본은 수정하지 않는다. 조건은 `NL_SETS=train,dev,probe1,...,probe9,dev_open,scope12v2,scope22v2`, `NL_OFFLINE=1`, 빈 `query-only.json`, `DONGGUK_MCP_RANKING=legacy`, `DONGGUK_MCP_SEMANTIC=auto`다. 하네스 wrapper 종료값만 믿지 않고 결과 파일·339건·유일 ID·코드/캐시 해시·문항별 비교를 추가 검증했다.

필드·지원 범위·집계 계약은 [REFERENCE.md](REFERENCE.md#verify_rule_citations-구조화-요약-계약)에 정리했고 `verify_rule_citations` 도구 설명도 갱신했다.

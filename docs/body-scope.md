# 본문 적용범위 판별 실험

**1회 측정 완료:** 제외 전용은 hybrid 대비 엄격/top3/1위 신규오답0·개선0으로 박스 비교 조건에 인계한다. [전체 결과](body-scope-exclude-results.md). scope22는 정답표 검증 전 잠정치이며 생산 효과를 확정하지 않는다.

기본은 `legacy`다. 실험은 `DONGGUK_MCP_RANKING=hybrid`에서 측정용 환경변수 `DONGGUK_MCP_MEASURE_SCOPE`로 고른다. 생략/알 수 없는 값은 제목 기반 hybrid 그대로다. 운영 기본값 변경은 없다.

| 값 | 동작 |
|---|---|
| `body` | 기존 본문 판정의 일치·불일치를 모두 사용 |
| `exclude` | 본문 단일 캠퍼스가 질문 캠퍼스와 명시적으로 다를 때만 음수. 일치·미확정·복수·모호·캠퍼스 미언급은 null(제목 판독) |

본문 판독은 `src/scope.js`의 `inferRuleScope`를 유지한다. 본칙 처음3개 중 목적·적용범위·적용대상에서 직접 근거를 읽고, 인용·소재·관리 주체·예외·부정·모호한 복수 범위는 보류한다. 제목 근거를 보존하며, 미확정은 전교 적용 확정이 아니다. 기존513개 판정·근거가 전부 같음을 새 audit로 대조했다.

`createScopeSignal({corpus,mode})`는 corpus별 WeakMap에 판정표를 한번 만들고 두 조건에서 재사용한다. 동기 `agreement(candidate, place)`는 정수 또는 null이다. 없는/연혁이 다른 후보는 null이다. `exclude`는 양수를 반환하지 않으며, 기존 제목 기반 가점/감점은 null 폴백으로 보존한다. 본문 기관 판정으로 추가 배제하지 않고 이번 변형은 명시적 캠퍼스 불일치에만 한정한다.

0954df2의 `fusion.js`를 그대로 사용한다. `index.js`의 `rankIndexHits`에서 opt-in hybrid일 때만 `placeAgreementOf: signal.agreement`를 넘긴다. 판 선택·1.5/0.6 배수는 fusion 소유다. legacy·장소 미언급 질문에서 콜백을 호출하지 않는 계약을 테스트했다. 옛 `hybrid-scope` 방식 이름, fusion의 scope 직접 import, scopeCorpus 인수는 제거했다.

## 제외 전용 후속 1회 고정 계획

결과를 보기 전에 baseline(환경변수 없음)·body·exclude의 세 조건을 고정한다. 표준 harness-d1.js+run2.sh와 최종 공통 캐시(인계733+보조673)를 독립 사본으로 쓴다.

- 질문만 semantic on/off: 공개251·probe9 36·scope12v2 11·scope22 22·dev_open4판20, 각340문항. 회귀71은251의 부분집합이다.
- 공개251의 고정 Sonnet/Haiku 핵심어 조건은 semantic on에서 비교한다.
- 총12조건3,546호출을 각각 한 번 측정한다. 실패/입력 결함 외에는 결과를 보고 규칙·계수·임계값을 고치거나 재선택하지 않는다.
- 기준 커밋0954df2를 merge로 받아 동일 코드 내 세 조건을 비교한다. 513판정표는 고정한다. 문항·규정번호별 분기는 없다.
- scope22 정답표는 적용범위 미검증 문항이 있어 잠정치로 분리한다. Z137 악화를 확정된 검색 오류로 단정하지 않는다. dev_open은4판 SHA c52c81e2…, scope12v2는 f4f78539…를 사용한다.
- 엄격/top3/조건부 조문/1위·변경 문항 전수를 저장한다. 오류/semantic 사용·캐시 무결성·표준하네스 불변을 대조한다. 신규오답0이면 박스 비교 조건에 인계하되 효과 판정은 박스 담당에게 맡긴다.

이전 [scope12v2 재집계](body-scope-scope12v2.md)와 [표준 v1 기록](body-scope-standard-results.md)은 당시 코드/조건의 기록으로 보존한다. 이전 `hybrid-scope`를 재현하려면 해당 측정 커밋을 사용해야 한다.

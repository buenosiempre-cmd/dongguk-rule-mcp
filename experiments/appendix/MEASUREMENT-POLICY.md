# 별표 실험 측정 원칙 통일 반영 — 2026-11-27

**이후 개발 효과 비교는 t10w의 동일 하네스 안에서 수행한다.** 기존 train46/dev25 결과는 신규 오답 회귀 확인으로만 사용한다. 단독 dense 후보 실험의 점수는 진단용이며 t10w·t10x MCP 점수와 직접 비교하지 않는다. 최종 효과 판정은 동국규정팀 박스 보류셋만 담당하며 이 페인은 접근하거나 요청하지 않는다.

## 고정 입력과 현재 상태

- 기준 코드: `907b998a095ffbe7c490fdb961dc90b090ddbf5e`.
- 현재 구현/직전 측정 보고 커밋: `364bc5d6b9e673551fb46f0694bcdb509e5da214`. 이번 변경은 문서뿐이다.
- corpus SHA-256: `59c2e11fe66e57af1ad2e88d732b12e42233ec1446e9a9d43784754e464dcb15`.
- TEXT3 고정 색인: `semantic-v1.c76feb89f199072fecf644f59f1c880519595276b8ec3af54f7a539388da2f7e.bin`. 이번에도 해시를 확인했고 재생성하지 않았다.
- 하네스: 제공 `harness-d1.js`, SHA-256 `c24eb47a2515f29f9486f78a86c22680ce9f31990adc376db9ae3a6b8e799792`. 실제 lookup handler, 제목 검색 모사, 고정 HWP/HTML 발췌, 오프라인 실행이다.
- 입력 범위: train46/dev25 + probe1~8 =251, probe9=36. 각 세트 건수 합계287 일치. `scope12`, `devopen`, `pr60` 자료는 이번 검토 대상에서 제외했다. 키워드는 제공 sonnet/haiku 두 파일만 사용 대상으로 확인했고 새로 생성하지 않았다.
- 학습·계수·동의어·순위 조정 없음. v4~v6·보류셋 미접근. 향후 새 개발 문항도 별도 공개 통지를 받은 범위만 사용한다.

## 전달된 공통 기준선 — 재실행 결과 아님

다음은 제공 결과 JSON 8개의 건수·참/거짓 대사다. 조건별 신규 오답은 같은 하네스·같은 캐시의 전후 결과가 나온 뒤 기록한다. **미측정을 0건으로 쓰지 않는다.**

| 조건 | 엄격 정답 | 기존 오답 전체 | 별표 변경 후 신규 오답 |
|---|---:|---|---|
| 켬 / 질문만 | 238/251 | dev:H21, probe1:P10, probe2:Q13, probe3:R04, probe4:S17, probe4:S18, probe6:V06, probe6:V08, probe6:V23, probe7:W02, probe7:W03, probe7:W20, probe8:X06 | 미측정 |
| 켬 / sonnet | 247/251 | probe2:Q06, probe4:S02, probe4:S18, probe6:V18 | 미측정 |
| 켬 / haiku | 247/251 | dev:H21, probe1:P11, probe3:R01, probe8:X06 | 미측정 |
| 끔 / 질문만 | 229/251 | dev:H21, probe1:P11, probe2:Q06, probe3:R04, probe3:R19, probe3:R21, probe4:S03, probe4:S17, probe4:S18, probe5:U19, probe6:V06, probe6:V07, probe6:V08, probe6:V23, probe7:W02, probe7:W03, probe7:W04, probe7:W06, probe7:W14, probe7:W20, probe8:X02, probe8:X06 | 미측정 |
| 끔 / sonnet | 244/251 | dev:H04, probe2:Q06, probe2:Q10, probe2:Q23, probe4:S18, probe6:V18, probe8:X06 | 미측정 |
| 끔 / haiku | 243/251 | dev:H21, dev:H25, probe1:P11, probe1:P27, probe3:R24, probe6:V23, probe8:X02, probe8:X06 | 미측정 |
| 켬 / probe9 질문만 | 29/36 | probe9:Y01, probe9:Y02, probe9:Y03, probe9:Y14, probe9:Y28, probe9:Y31, probe9:Y36 | 미측정 |
| 끔 / probe9 질문만 | 25/36 | probe9:Y01, probe9:Y02, probe9:Y03, probe9:Y06, probe9:Y11, probe9:Y12, probe9:Y14, probe9:Y25, probe9:Y28, probe9:Y32, probe9:Y36 | 미측정 |

켬 질문만 251문항의 정답 규정 top3는 전달 기준241, probe9는32다. 앞의 JSON은 문항별 strict boolean만 담고 있으므로 top3·본문 차이를 자체 재검증한 것으로 쓰지 않는다. 251문항 중 probe7·8은 과적합 가능성이 있는 개발 자료, probe9 정답은 조 제목 기준이므로 전체 서비스 정확도의 추정치로 해석하지 않는다.

## 재현에 필요한 캐시 확인

제공 재현 폴더에는 하네스·문항·키워드·결과가 있지만 하네스가 기본으로 읽는 `cache` 폴더는 없다. 진행기록은 HWP 캐시 217개 규정을 사용했다고 명시한다. 현재 별표 페인의 D1 평가 복사본은 `original-structure-v2` 파일106개이며 `original` 파일36개다. 이 수는 규정217개와 일대일 대사한 값이 아니지만, 같은 스냅샷이라고 확인할 근거도 없다. 따라서 현재 복사본으로 238/251 등 공통 기준선을 재현했다고 주장하지 않는다.

코디네이터에게 고정 HWP 캐시 경로를 요청했다. 제공되면 읽기 전용 원본에서 독립 복사본을 만들고 corpus·고정 벡터 해시를 검증한 뒤, 같은 하네스로 D1 기준과 별표 브랜치를 전후 비교한다. `NL_OFFLINE=1`로 원문 네트워크 요청을 차단한다. 기준선 자체가 일치하지 않으면 입력 차이를 먼저 기록하고 결과를 섞지 않는다.

현재 별표 모듈은 운영 lookup에 미연결 상태다. 따라서 그 브랜치의 MCP 측정은 동작 보존 확인이며, 별표 효과를 주장하려면 별표 후보를 실제로 사용하는 실험 조건을 동일 하네스에 연결해야 한다. 이는 현재 완료됐다고 보고하지 않는다. 기존 별도 dense 실험의 A02 악화가 해결된 것도 아니므로 운영 연결 보류를 유지한다.

## 이후 보고 필수 항목

1. 기준/실험 커밋, corpus 전체 SHA, 고정 색인 파일명과 SHA, 하네스 SHA 및 입력 파일 SHA.
2. 의미검색 켬/끔, 질문만/sonnet/haiku를 분리한 strict·규정 top3·조건부 조문 포함, 조건별 새로 틀린 문항과 새로 맞은 문항.
3. train46/dev25는 신규 오답 회귀 확인. 공개251·probe9는 개발 비교. 학습·조정에 사용했는지 명시.
4. t10x 하네스 수치와 직접 비교하지 않음. 최종 판정은 별도 팀의 박스 검증이며 이 페인은 접근·요청하지 않음.

원격 실험: https://github.com/buenosiempre-cmd/dongguk-rule-mcp/pull/58 (draft, base feat/nl-semantic).

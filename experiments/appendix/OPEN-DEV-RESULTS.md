# 새 공개 개발20 문항 고정 설정 측정 — 2026-11-27

> 후속 측정 원칙은 [MEASUREMENT-POLICY.md](MEASUREMENT-POLICY.md)를 따른다. train/dev는 회귀용이며, 기존 별도 dense 점수를 t10w 공개251+probe9 하네스의 효과 점수와 직접 비교하지 않는다.

**별표 추가의 개선·악화는 관찰되지 않았다.** 실제 MCP의 D1 기준과 별표 브랜치는 의미검색 off 16/20, on 19/20으로 각각 일치했다. 별도 dense 후보 신호 실험은 D1 단독·좌표표 추가·kordoc 추가 모두 18/20이며 선택된 증거도 동일했다. 추가 별표 청크가 상위 근거에 들어온 문항이 0개여서 별표 효과를 입증하는 자료는 아니다. 이전 공개 train의 A02 악화는 해결된 것이 아니며 운영 연결 보류를 유지한다.

## 입력·코드 고정

- 읽은 제공 파일: `~/herdr-work/rule_mcp_upgrade/새개발문항_t3y_20261127/dev_open.json` 하나뿐. 같은 폴더의 README·다른 파일은 열지 않았다.
- 파일 SHA-256: `4ac646c4c649bb00c37bdb28cb78e557a2c418ae98f3fef09c627ad276ffded3`. 같은 바이트를 저장소 `fixtures/dev-open-t3y-20261127.json`으로 보존했다. `validateQuestions` 통과.
- 문항20, S15/C8/D7은 태그 중복을 허용한 수이며 합산하지 않는다. 기존 공개 train/dev의 정답 규정들과 중복은 0개였다.
- query-only: 문항에 든 `args.keywords`는 사용하지 않았다. **학습·계수 조정·동의어 변경·순위 설정 변경에 사용하지 않았다.** 해시·입력 형식·태그 집계와 새 문항 실행 경로만 추가했다.
- 공통 코드: `907b998a095ffbe7c490fdb961dc90b090ddbf5e`.
- 측정 코드: `77943b6c36247877119d6380e245219ca1e9193e`. 운영 src/index.js·corpus.js·parsers.js·semantic.js는 공통 코드와 동일하다. d1-baseline.js는 기존 measure 함수를 export한 것 외 실행·채점 변경이 없다.
- corpus SHA-256: `59c2e11fe66e57af1ad2e88d732b12e42233ec1446e9a9d43784754e464dcb15`, contentVersion4.
- 의미 입력 TEXT3, 9,790조문·11,422벡터. 파일: `semantic-v1.c76feb89f199072fecf644f59f1c880519595276b8ec3af54f7a539388da2f7e.bin`.
- 의미 meta `semantic-v1.json` SHA-256: `c90991991401d6f1f08f2b62006cbb5648ecb41b3a0e549a543ceb7b1a22e983`. 벡터 SHA는 파일명의 전체 해시와 같다.

공통 rebuilt 캐시는 읽기 전용으로 사용했다. MCP는 기존 자기 D1 스냅샷에서 새 복사본 두 개를 만들고 history/search 쓰기를 그 안으로 한정했다. 실제 네트워크를 차단하고 고정 catalog/HTML을 재생했다. 문항 원본·공통 corpus/meta/vector의 측정 전후 해시는 동일하다.

## 실제 MCP — D1 기준 대 별표 브랜치

별표 기능은 운영 조회에 미연결 상태다. 아래 결과는 기존 경로 보존 확인이며 별표 도입 효과가 아니다. 각 셀의 값은 **D1 기준과 별표 브랜치에서 동일**했다.

| 지표 | 의미검색 off | 의미검색 on |
|---|---:|---:|
| strict | 16/20 | 19/20 |
| 정답 규정 top3 | 19/20 | 20/20 |
| 조건부 정답 조문 | 16/19 | 19/20 |
| S strict / top3 | 12/15 / 15/15 | 14/15 / 15/15 |
| C strict / top3 | 7/8 / 7/8 | 8/8 / 8/8 |
| D strict / top3 | 6/7 / 6/7 | 7/7 / 7/7 |
| 별표 브랜치 신규 오답 | 0 | 0 |
| 반환 규정·본문 차이 문항 | 0 | 0 |
| 실제 의미검색 사용 | 0/20 | 20/20 |
| API 오류 | 0 | 0 |

off 미정답 전체: **R13, R22, R28, R30**. R13은 정답 규정 top3에 없고 나머지는 규정은 있으나 정답 조문 표제가 발췌에서 빠졌다. on 미정답은 **R28**이며 정답 규정은 top3에 있다. off→on의 R13/R22/R30 개선은 기존 의미검색 경로의 결과다. 별표 모듈의 개선으로 인용하지 않는다.

별표 브랜치 지연은 off 중앙 1501.79ms/p95 2002.25ms, on 중앙 499.50ms/p95 1005.93ms다. 동일 캐시 복사본에서 off 뒤 on을 실행했고, HWP 캐시 미스 차단/HTML 폴백 및 내부 요청 대기가 포함돼 속도 개선으로 해석할 수 없다. HWP 요청 차단은 off25/on24회, 실제 외부 요청은 수행하지 않았다.

## 별도 dense 후보 신호 — 고정된 기존 정책

D1의 513규정 전체에서 질문 임베딩1회, 조문별 max cosine, 규정 top3·규정별 증거 top3를 유지했다. 비교는 D1 단독, 기존 좌표표24청크 추가, kordoc43청크 추가다. 실제 MCP의 낱말 결합·범위 판별·본문 발췌를 거치지 않는 별도 지표다.

| 구분 | 문항 | 규정 top3 | 후보 근거 적중 | 조건부 근거 |
|---|---:|---:|---:|---:|
| 전체 | 20 | 20/20 | 18/20 | 18/20 |
| S | 15 | 15/15 | 13/15 | 13/15 |
| C | 8 | 8/8 | 8/8 | 8/8 |
| D | 7 | 7/7 | 7/7 | 7/7 |

세 조건에서 모든 값·선택된 규정/근거가 동일하다. 각 비교의 신규 오답·개선 목록은 모두 `[]`, 미정답은 **R28·R34**다. 별표 청크가 최종 근거에 포함된 문항은 0개다. 이 셋에는 별표 행·금액 정답 라벨이 없어 행 정확도는 미채점(0/0)이다.

신호 실험 중앙/p95: query embedding 3.87/6.77ms, D1 dense 채점 4.07/5.54ms, 별표 색인 검증+채점 2.47/4.46ms. 단일 로컬 실행이며 실제 서비스 지연이 아니다.

## 판단·증거·재현

이 문항군은 특정 약점을 겨냥한 개발 비교용이며 전체 정확도를 대표하지 않는다. 이전 공개71·자체 별표14와 합산하지 않는다. 미사용 박스 보류셋을 대신하지 않으며, 이번 실행 후에도 같은 문항으로 설정을 고치거나 효과를 재주장하지 않았다.

- 입력 건수20 및 S15/C8/D7 대사 일치. corpus513규정·본칙9,790·부칙4,326 및 벡터11,422는 D1 고정값과 일치.
- 전체 npm test 54개 스크립트 성공. 승인 파일 SHA 불일치 거부·query-only 인수·태그 수 검사와 기존 채점 경계 테스트 통과.
- `results/open-dev/summary.json`: 조건별 요약·전체 해시. `public-off.json.gz`, `public-on.json.gz`, `dense-signals.json.gz`: 전체 문항별 응답/후보 원본. 압축을 풀면 JSON이며 SHA는 summary에 있다.
- 원본 표 파싱은 이번에 다시 수집하지 않았다. 이전 별표 대사(앵커189·복제47 일치)는 이 새 문항 평가의 정확도 근거로 전용하지 않는다.

```sh
export DONGGUK_MCP_SEMANTIC_RUNTIME=/path/to/d1-artifacts/runtime
export DONGGUK_MCP_SEMANTIC_MODEL_DIR=/path/to/d1-artifacts/models
node scripts/evaluate-appendix-d1.js \
  /path/to/d1-artifacts/rebuilt/dongguk-rule-mcp/v2/public \
  /tmp/open-dev-signals-new.json --open-dev
node scripts/evaluate-appendix-open-mcp.js \
  /path/to/own-pinned-D1-snapshot-cache-root \
  /path/to/repo-at-907b998 /path/to/d1-artifacts/html \
  /tmp/open-dev-mcp-new-directory
```

MCP 명령은 source snapshot을 새 출력 폴더 아래 두 개로 복사한 다음 측정한다. 원본 폴더 안에 출력을 만들거나 기존 출력을 덮어쓰는 요청은 거부한다. 모델 다운로드 없이 기존 로컬 모델을 사용한다. 소스 디렉터리에는 catalog·원본구조 등 고정 평가 스냅샷이 필요하며 rebuilt 캐시만으로 대체하지 않는다.

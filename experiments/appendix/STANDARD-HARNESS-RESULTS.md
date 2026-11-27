# 별표 실험 표준 하네스·보조 캐시 재측정 — 2026-11-27

**표준 실행 경로 재측정 완료.** 보조 캐시를 포함한 `harness-d1.js + run2.sh`에서 기준 코드와 별표 브랜치의 10조건 신규 오답·개선·반환 규정/본문 차이는 모두0건이다. t10w 최종 공통 기준선 JSON10개와도 문항별 strict 판정 차이가0건이다. 이전 보조 캐시 없는 같은 하네스 측정과 비교해도 점수·반환 규정/본문 차이가0건이다. 서로 다른 하네스의 점수를 직접 비교하지 않았다.

별표 모듈은 운영 lookup에 미연결 상태이므로 이는 동작 보존 확인이다. 별도 dense 후보 진단은 [FINAL-HANDOFF-RESULTS.md](FINAL-HANDOFF-RESULTS.md)에 진단 지표로만 보존하며, `train:A02` 악화에 따른 운영 연결 보류 판단은 유지한다. 이번에 진단을 다시 실행하거나 그 점수를 표준 하네스 효과로 바꾸어 쓰지 않았다.

## 고정 식별·검증

| 항목 | 식별 |
|---|---|
| 기준 코드 | `29bbf6625a46593797ffedeb348a00a99d71c44f` |
| 측정 코드 | `e08bb74b4f361975f77206e15fbc7fa16139dc77` |
| 인계 manifest SHA | `dbc6d1faa9b83f08e80784b1ff53b7b76708ebc0e5f20266230b0b452ae219e7` |
| 보조 manifest SHA | `cc3c9fd1c09456c928d6444188b83e246941ec06756a0cbffe92e15fb52b6bf0` |
| corpus SHA | `830b69968e8f212450a9f152b890d6c78a4724d56d4b0a4e9b41caa18bdbd227` |
| 벡터 파일 | `semantic-v1.fd7d662bb55c82f6d45f102866bc8e8837b046fdf7ac5658830c217a34de5def.bin` |
| 벡터 SHA | `fd7d662bb55c82f6d45f102866bc8e8837b046fdf7ac5658830c217a34de5def` |
| harness-d1.js SHA | `c24eb47a2515f29f9486f78a86c22680ce9f31990adc376db9ae3a6b8e799792` |
| run2.sh SHA | `eae9b6bfbcb29ae018cc7a0591cdda0bfed7f851be2e085210a61d11fdab9602` |

인계733파일·42,451,819바이트와 보조 manifest가 열거한673파일(README1·harness3·catalog1·search668)을 크기·SHA로 대사해 모두 일치했다. 각 조건마다 독립 복사본에 인계733 + 보조 public669를 넣고, history는 표준 하네스가 corpus 연혁으로 생성했다. 원본 두 폴더의 해시는 실행 전후 동일하다. 벡터 재생성·실제 원문 네트워크 요청은 없었다.

표준 하네스3개 파일을 바이트 그대로 복사해 `/bin/zsh run2.sh`로 실행했다. 런타임·모델 경로만 기존 로컬 설치로 지정했다. recorder는 scoreResponse 반환값을 변경하지 않고 문항별 근거를 저장한다. 질문·정답·채점·검색 코드는 바꾸지 않았다.

## 표준 하네스 결과

아래 정답과 top3는 기준 코드·별표 브랜치에서 같다. 10조건×양쪽 코드 총3,236회 채점, API 오류0. 의미검색 실제 사용은 on의 모든 문항, off는0건이다. 조건별 신규 오답·개선·반환 규정/본문 차이는 모두 빈 목록으로 저장했다.

| 세트 | 의미검색/입력 | 엄격 정답(양쪽 동일) | 규정 top3(양쪽 동일) | 새로 틀린 문항 |
|---|---|---:|---:|---:|
| public251 | off/query | 229/251 | 235/251 | 0 |
| public251 | off/sonnet | 244/251 | 246/251 | 0 |
| public251 | off/haiku | 243/251 | 245/251 | 0 |
| public251 | on/query | 239/251 | 242/251 | 0 |
| public251 | on/sonnet | 247/251 | 249/251 | 0 |
| public251 | on/haiku | 246/251 | 248/251 | 0 |
| probe9 | off/query | 25/36 | 30/36 | 0 |
| probe9 | on/query | 29/36 | 32/36 | 0 |
| dev_open | off/query | 16/20 | 19/20 | 0 |
| dev_open | on/query | 19/20 | 20/20 | 0 |

train46/dev25는 공개251의 부분집합으로 회귀 확인에만 사용했다. 질문만 on/off 모두70/71·기존 `dev:H21` 유지, 신규 오답0. scope12는 이번 별표 전후 측정 범위에 포함하지 않았다. 학습·계수·순위 조정 없음. 보류셋·v4~v6 미접근·미요청이며 최종 효과 판정은 담당 팀의 박스 검증으로만 한다.

### 조건별 기존 오답

- public251 off/query: dev:H21, probe1:P11, probe2:Q06, probe3:R04, probe3:R19, probe3:R21, probe4:S03, probe4:S17, probe4:S18, probe5:U19, probe6:V06, probe6:V07, probe6:V08, probe6:V23, probe7:W02, probe7:W03, probe7:W04, probe7:W06, probe7:W14, probe7:W20, probe8:X02, probe8:X06
- public251 off/sonnet: dev:H04, probe2:Q06, probe2:Q10, probe2:Q23, probe4:S18, probe6:V18, probe8:X06
- public251 off/haiku: dev:H21, dev:H25, probe1:P11, probe1:P27, probe3:R24, probe6:V23, probe8:X02, probe8:X06
- public251 on/query: dev:H21, probe1:P10, probe3:R04, probe4:S17, probe4:S18, probe6:V06, probe6:V08, probe6:V23, probe7:W02, probe7:W03, probe7:W20, probe8:X06
- public251 on/sonnet: probe2:Q06, probe4:S02, probe4:S18, probe6:V18
- public251 on/haiku: dev:H21, probe1:P11, probe3:R01, probe4:S02, probe8:X06
- probe9 off/query: probe9:Y01, probe9:Y02, probe9:Y03, probe9:Y06, probe9:Y11, probe9:Y12, probe9:Y14, probe9:Y25, probe9:Y28, probe9:Y32, probe9:Y36
- probe9 on/query: probe9:Y01, probe9:Y02, probe9:Y03, probe9:Y14, probe9:Y28, probe9:Y31, probe9:Y36
- dev_open off/query: dev_open:RT13, dev_open:RT22, dev_open:RT28, dev_open:RT30
- dev_open on/query: dev_open:RT28

## dev_open ID 전환

승인된 파일 `새개발문항_t3y_20261127/dev_open.json`만 다시 읽었다. 현재3판 SHA는 `977def756d89605ffbad21b23c242ad24dbb9880791b61502d62706f909d85ed`다. 종전 fixture와20개 모두 ID를 제외한 전체 필드가 같고 ID만 R→RT로 바뀐 것을 검증했다. 이번 결과에는 `dev_open:RT…`를 사용한다. 제공 기준선의 세트명 `devopen`은 비교 시 `dev_open`으로만 통일했으며 질문·정답은 바꾸지 않았다. query-only 조건에서는 author args를 제외했다.

## 자료와 재현

- 기준선 대조: `공통기준_최종/fin-{on,off}-{q,s,h,y,do-none}.json` 중 해당10개와 문항별 비교, 차이0. 파일별 SHA와 비교 결과는 아래 summary에 있다.
- 결과: `experiments/appendix/results/standard-aux/summary.json`, 문항별 전체 반환 근거20개 gzip JSON. 모든 게시 결과 키는 `세트:ID`다.
- 원본 실행 로그·복사 캐시: `experiments/appendix/input/standard-aux-evaluation/`(git 제외).
- 이전 결과 폴더를 모두 보존했다. 진단 하네스는 표준 하네스 결과와 분리한다.
- 실행 검증: 새 경로 실제20회 실행·3,236문항 채점 성공, 두 입력 manifest 대사 일치, 기존 채점 검사와 diff 공백 검사 통과. 운영 코드 변경 없음.

```sh
export DONGGUK_MCP_SEMANTIC_RUNTIME=/path/to/runtime
export DONGGUK_MCP_SEMANTIC_MODEL_DIR=/path/to/models
node scripts/evaluate-appendix-final.js \
  /path/to/handoff-final /path/to/t10w-question-reference \
  /path/to/baseline-at-29bbf66 /path/to/new-output \
  /path/to/eval-aux/t10w-harness-20261127
```

Draft PR #58: https://github.com/buenosiempre-cmd/dongguk-rule-mcp/pull/58 (base feat/nl-semantic).

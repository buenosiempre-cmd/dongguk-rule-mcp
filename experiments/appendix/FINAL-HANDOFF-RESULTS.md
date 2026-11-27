# 별표 실험 최종 공통 캐시 재측정 — 2026-11-27

**새 공통 기준으로 전환·재측정을 완료했고, 운영 연결 보류를 유지한다.** 동일 t10w 하네스에서 기준 코드와 별표 브랜치의 조건별 신규 오답·개선·반환 규정/본문 차이는 모두 0건이다. 별표 모듈은 운영 lookup에 연결하지 않았으므로 이는 경로 보존 확인이다. 별도 후보 진단에서는 kordoc 행 근거가 도움이 되는 개발 문항이 있지만 `train:A02` 악화도 남았다. 서비스 효과를 입증했다고 보지 않는다.

## 기준 식별 및 대사

- 기준 코드 `29bbf6625a46593797ffedeb348a00a99d71c44f`. `feat/nl-semantic`의 해당 커밋을 merge(`e05eda6`)로 받았다. 강제 push 없이 이력을 보존했다.
- 실제 MCP 측정 코드 `f34d08a6b9f3f17bf0c96bd55e6ad11fd712d479`. 후속 보고 커밋은 원격 검증 절에 별도 기록한다. 진단 옵션 추가분은 아래 codeHashes에 보존한다.
- manifest SHA-256 `dbc6d1faa9b83f08e80784b1ff53b7b76708ebc0e5f20266230b0b452ae219e7`.
- corpus SHA-256 `830b69968e8f212450a9f152b890d6c78a4724d56d4b0a4e9b41caa18bdbd227`.
- 벡터 `semantic-v1.fd7d662bb55c82f6d45f102866bc8e8837b046fdf7ac5658830c217a34de5def.bin`, SHA-256 `fd7d662bb55c82f6d45f102866bc8e8837b046fdf7ac5658830c217a34de5def`. 기존 고정 벡터를 그대로 사용했으며 재생성하지 않았다.
- 전달 캐시 733파일·42,451,819바이트: content-v4 513 + corpus 1 + semantic 2 + original-structure-v2 217. 전체 경로·크기·SHA 일치, 차이0. 실행마다 독립 복사본을 만들고 catalog/history는 같은 corpus에서 생성했다. 기존 search 캐시는 섞지 않았다.
- 원본 전달 폴더와 각 실행 복사본의 733파일 해시를 실행 후 다시 검증해 불변 확인. 진단도 독립 복사본 사용. `NL_OFFLINE=1`, 실제 원문 요청0.
- 하네스: t10w `harness-d1.js`, SHA-256 `c24eb47a2515f29f9486f78a86c22680ce9f31990adc376db9ae3a6b8e799792`. 제공 파일 바이트를 그대로 실행했다. recorder는 기존 scoreResponse 결과를 추가 저장하며 반환값·채점·순위를 변경하지 않는다. baseline/실험 양쪽에 동일 적용했다.
- 제공 train46/dev25/probe1~9와 sonnet/haiku 키워드 파일은 이전에 기록한 SHA와 대조했다. dev_open은 승인된 원본 SHA `4ac646c4c649bb00c37bdb28cb78e557a2c418ae98f3fef09c627ad276ffded3`를 확인하고 질문만 조건을 위해 author args를 제외했다. 제공 폴더의 다른 파일은 열지 않았다.
- 학습·계수·동의어·순위 조정 없음. v4~v6·보류셋 미접근·미요청. scope12는 t10w 담당 기준선 범위이며 이번 별표 전후 측정에는 포함하지 않았다.

## 같은 하네스의 기준선 대 별표 브랜치

아래 정답·top3 값은 두 코드에서 동일했다. 세트307개(251+36+20), 10조건을 양쪽 코드에서 실행해 총3236회 채점했다. 조건별 오류는 모두0. 기존 907b998/c76feb89 결과와 합산하거나 전후 효과로 비교하지 않는다.

| 세트 | 의미검색 / 입력 | 엄격 정답(양쪽 동일) | 규정 top3(양쪽 동일) | 새로 틀린 문항 |
|---|---|---:|---:|---:|
| public251 | off / query | 229/251 | 235/251 | 0 |
| public251 | off / sonnet | 244/251 | 246/251 | 0 |
| public251 | off / haiku | 243/251 | 245/251 | 0 |
| public251 | on / query | 239/251 | 242/251 | 0 |
| public251 | on / sonnet | 247/251 | 249/251 | 0 |
| public251 | on / haiku | 246/251 | 248/251 | 0 |
| probe9 | off / query | 25/36 | 30/36 | 0 |
| probe9 | on / query | 29/36 | 32/36 | 0 |
| dev_open | off / query | 16/20 | 19/20 | 0 |
| dev_open | on / query | 19/20 | 20/20 | 0 |

모든 조건에서 반환 규정·본문 배열이 문항별로 완전히 같았다. 71문항 회귀는 public251 실행 중 train/dev 부분집합으로 확인했으며 질문만 off/on 모두70/71, 기존 `dev:H21` 유지·신규 오답0이다. 이 71문항은 효과 판단에 사용하지 않는다. 생성 키워드는 제공된 파일을 그대로 재생했으며 모델에 새로 요청하지 않았다. 지연은 공통 하네스가 타이머를 가속하고 동시 작업 부하가 있어 성능 효과로 주장하지 않는다.

### 조건별 기존 오답 전체

- public251 off/query: dev:H21, probe1:P11, probe2:Q06, probe3:R04, probe3:R19, probe3:R21, probe4:S03, probe4:S17, probe4:S18, probe5:U19, probe6:V06, probe6:V07, probe6:V08, probe6:V23, probe7:W02, probe7:W03, probe7:W04, probe7:W06, probe7:W14, probe7:W20, probe8:X02, probe8:X06
- public251 off/sonnet: dev:H04, probe2:Q06, probe2:Q10, probe2:Q23, probe4:S18, probe6:V18, probe8:X06
- public251 off/haiku: dev:H21, dev:H25, probe1:P11, probe1:P27, probe3:R24, probe6:V23, probe8:X02, probe8:X06
- public251 on/query: dev:H21, probe1:P10, probe3:R04, probe4:S17, probe4:S18, probe6:V06, probe6:V08, probe6:V23, probe7:W02, probe7:W03, probe7:W20, probe8:X06
- public251 on/sonnet: probe2:Q06, probe4:S02, probe4:S18, probe6:V18
- public251 on/haiku: dev:H21, probe1:P11, probe3:R01, probe4:S02, probe8:X06
- probe9 off/query: probe9:Y01, probe9:Y02, probe9:Y03, probe9:Y06, probe9:Y11, probe9:Y12, probe9:Y14, probe9:Y25, probe9:Y28, probe9:Y32, probe9:Y36
- probe9 on/query: probe9:Y01, probe9:Y02, probe9:Y03, probe9:Y14, probe9:Y28, probe9:Y31, probe9:Y36
- dev_open off/query: dev_open:R13, dev_open:R22, dev_open:R28, dev_open:R30
- dev_open on/query: dev_open:R28

기준→별표 브랜치의 신규 오답·개선은 위10조건 모두 빈 목록이다. JSON 요약에는 조건별 빈 목록을 명시했고, 압축 문항별 결과는 모두 `세트:ID`를 사용한다.

## 별도 dense 후보 진단 — MCP 효과 점수와 구분

같은 새 corpus·고정 벡터로 기존 정책(조문별 max cosine, 규정 상위3, 규정당 근거3)을 유지한 진단이다. 이 진단은 t10w 하네스와 다른 지표이며 두 결과를 직접 비교하지 않는다. train/dev 수치는 회귀 진단으로만 사용한다.

| 세트 | 조문만 | 좌표표 추가 | kordoc 추가 | 신규 악화 |
|---|---:|---:|---:|---|
| train 근거 적중 | 41/46 | 41/46 | 40/46 | kordoc: train:A02 |
| dev 근거 적중 | 18/25 | 17/25 | 18/25 | 좌표표: dev:H23 |
| dev_open 근거 적중 | 18/20 | 18/20 | 18/20 | 없음 |
| 별표 new-dev14 표 근거 | 0/14 | 6/14 | 9/14 | 없음 |
| 별표 new-dev14 행·금액 근거 | 0/14 | 3/14 | 8/14 | 없음 |

new-dev14는 이미 사용한 개발 문항으로 일반화 성능을 주장하지 않는다. 좌표표 대비 kordoc의 표 근거 개선은 `new-dev:N01`, `new-dev:N02`, `new-dev:N03`, 행·금액 근거 개선은 `new-dev:N01`, `new-dev:N02`, `new-dev:N11`, `new-dev:N12`, `new-dev:N14`다. dev_open은 별표 청크 선택이 없고 미정답은 `dev_open:R28`, `dev_open:R34`다. kordoc의 `train:A02`는 별표 행이 조문을 밀어내는 후보 진단의 악화이며, 캐시 차이로 발생했던 다른 하네스의 A02 문제와 혼동하지 않는다.

새 manifest의 여비규정 원본 `rawSourceSha256`과 kordoc fixture 원본 SHA `dedc03e80977f9005848aa13289650668b890171450378ccfbaea4f34e84dca5`가 일치했다. 조문9,790·벡터11,422 정렬 대사, 별표43 passages·그래프47노드46간선은 정상이다. 실제 MCP 조회의 별표 재순위 연결은 아직 하지 않았다. 최종 효과 판정은 동국규정팀 박스 보류셋만 담당한다.

## 검증·재현·산출물

- merge 충돌은 package.json 테스트 목록 한 곳뿐이었고 양쪽 테스트를 보존했다. 운영 src/index.js·corpus.js·parsers.js·semantic.js는29bbf66과 동일하다.
- merge 후 전체 npm test55스크립트 통과(exit0), 후속 진단 옵션 변경 후 별표 채점 검사 통과. 실행 실패·본문 오류0, 입력 해시 대사 일치. 문서·소스 diff 공백 검사 통과.
- 재현 스크립트: `scripts/evaluate-appendix-final.js`, `scripts/evaluate-appendix-d1.js --final-handoff [--open-dev]`.
- 결과·전체 문항별 근거: `experiments/appendix/results/final-handoff/summary.json` 및 같은 폴더 gzip JSON. 원본 로그·캐시: `experiments/appendix/input/final-handoff-evaluation/`(git 제외).
- 이전 `results/d1`, `results/open-dev` 폴더를 보존했다. 이전 수치와 섞지 않는다.
- draft PR #58: https://github.com/buenosiempre-cmd/dongguk-rule-mcp/pull/58 (base feat/nl-semantic).

```sh
export DONGGUK_MCP_SEMANTIC_RUNTIME=/path/to/runtime
export DONGGUK_MCP_SEMANTIC_MODEL_DIR=/path/to/models
node scripts/evaluate-appendix-final.js \
  /path/to/handoff-final /path/to/t10w-reference \
  /path/to/baseline-at-29bbf66 /path/to/new-output
node scripts/evaluate-appendix-d1.js \
  /path/to/copied-handoff/dongguk-rule-mcp/v2/public \
  /path/to/new-signal-output.json --final-handoff
```

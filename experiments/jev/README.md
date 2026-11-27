# JEV 공개 문항 검색 실험

> **최신 재평가:** 공통 코드 `907b998`, corpus `59c2e11fe66e…`, TEXT3 `semantic-v1.c76feb89…bin` 기준 결과는 [D1-FIXED-RESULTS.md](D1-FIXED-RESULTS.md)에 있다. 생산 searchCorpus 대비 악화가 있어 현재 JEV 대체를 권고하지 않는다. 기존 RESULTS.md와 results/의 대용량 자료는 D1 수정 전 역사적 기록이다.

이 실험은 조문 후보의 상대 증거를 로지스틱 회귀로 결합하고, 규정 후보는 최고 조문 점수로 선택한다. 서비스의 `lookup_rule`에는 연결하지 않았다. 설치만으로 검색 동작이 바뀌지 않는다.

## 설계와 범위

- 기반: [Javad Dogani, JEV retrieval](https://github.com/JavadDogani/jev-retrieval/tree/13ae4ccdf21b30c281bfa43a9d150bd221c4e7ef), MIT. 16개 특징식은 원본을 Node로 옮겼고 수치 대조 테스트를 둔다. 저작권 고지는 `JEV-LICENSE`에 보존한다.
- 기존 공개 corpus와 e5-small q8 조각 벡터를 그대로 읽는다. 문서 재임베딩, 외부 모델 API, 가입, 구매는 없다. 모델 파일이 없으면 수집기는 실패하며 다운로드하지 않는다.
- 한국어 검색 키는 기존 `queryConcepts`의 조사·어미 처리와 동의어를 사용한다. 전체 질문 + 개념/인접 개념 키 최대 3개 + Rocchio 키 1개다. 키 선택은 corpus IDF와 다양성만 사용하며 문항 ID·정답을 보지 않는다.
- 기존 corpus의 텍스트를 활용한 실험용 BM25 어댑터(k1=.9, b=.4)다. 서비스의 `searchCorpus` 점수를 그대로 가져오는 실험은 아니다. 조문 길이는 공백 단위이며, 개념 대체어 중 최대 부분문자열 빈도를 사용한다. 영어 원본의 토큰 BM25와 한국어 키 추출은 다르므로 **JEV 한국어 파생 실험**으로 해석한다.
- 전체 질문 BM25/dense 각 top100, 추가 텍스트 키 BM25 각 top50, Rocchio dense top50을 합친다. 추가 dense 키는 후보에만 점수를 계산한다. 긴 조문의 여러 조각은 조문별 최대 cosine으로 먼저 묶는다.
- 기준선은 전체 질문 BM25+dense의 RRF(k=60)와 확장 검색 목록의 RRF 두 가지다. 모두 규정 점수는 최고 조문 점수로 집계하고, 규정 top3에서 조문을 각각 최대 3개 선택한다. 확장 RRF는 각 검색 목록에 동일 가중치를 준다.
- 조문 회귀는 StandardScaler + LogisticRegression(C=1, max_iter=2000)로 고정한다. 규정 확률은 최고 조문 확률 하나를 별도 로지스틱 회귀로 보정한다. 보정 학습용 조문 확률은 내부 3-fold OOF에서만 얻는다. 조문 수에 비례해 확률을 누적하는 noisy-OR는 사용하지 않는다.
- 학습·검증 입력은 저장소 공개 `natural-language-benchmark.train.json` 46개와 `.dev.json` 25개로 수집기에 고정한다. 다른 질문 파일 인수는 받지 않는다. 비공개 보류셋은 사용하지 않는다.
- 같은 정답 lawId를 가진 문항, 여러 대체 정답을 통해 이어진 문항, 정규화한 질문이 같은 문항은 하나의 그룹으로 묶는다. 24개 연결요소를 크기 균형의 결정적 5-fold로 나눈다. 외부 검증 규정은 조문 회귀·표준화·규정 확률 보정 모두에서 제외한다.
- 후보 내 미표기 조문은 음성으로 취급한다. 따라서 확률은 공개 라벨 일치 확률의 추정치이며, 실제 법적 관련성의 완전한 확률이나 법령 해석 확신도가 아니다.

## 재현

Node 의존성은 `npm ci`로 설치한다. 로컬 e5 런타임과 모델, 기존 색인은 운영자가 준비해야 한다. 경로는 각 환경의 공개 corpus·벡터 위치로 지정한다.

```sh
export DONGGUK_MCP_SEMANTIC_RUNTIME=/path/to/transformers-install
export DONGGUK_MCP_SEMANTIC_MODEL_DIR=/path/to/local-models
node scripts/collect-jev-evidence.js \
  --corpus-dir /path/to/public-cache \
  --vector-dir /path/to/e5-small-index \
  --key-encoding single \
  --output /tmp/jev-evidence.json
uv run --with-requirements experiments/jev/requirements.txt python scripts/evaluate-jev.py \
  --evidence /tmp/jev-evidence.json --output /tmp/jev-report.json
node test/test-jev.js
uv run --with-requirements experiments/jev/requirements.txt python test/test-jev-evaluation.py
npm test
```

기존 출력 파일은 덮어쓰지 않는다. 수집기는 공개 문항·corpus·벡터·검색 코드 해시와 후보별 특징/라벨을 기록하고, 평가기는 평가 코드 해시·분할·문항별 결과·계수를 남긴다. `results/evidence.json.gz`를 풀어 재평가하면 임베딩 런타임 없이 점수와 분할을 재현할 수 있다. 지연은 기기와 동시 부하에 따라 달라진다.

수집기는 질의 추론 전에 모든 대상 조문의 벡터 정합을 검사한다. 일부만 일치하면 `JEV_VECTOR_COVERAGE_INCOMPLETE`로 중단하고 결과 파일을 만들지 않는다. D1 수정 corpus에 이전 벡터를 붙여 서로 다른 데이터 세대의 성능을 혼합하지 않기 위한 실험 전용 검사다. 제목만 남은 원문 자체의 본문 충실도까지 보증하는 검사는 아니다.

## 런타임 연동용 경계

`src/jev.js`의 `rerank(candidates, artifact, fingerprint)`는 조문·규정 확률을 반환하는 순수 선택 경로다. `experimentFingerprint(corpusHash, vectorHash)`에는 corpus·벡터뿐 아니라 특징/키 구현·동의어 소스 해시가 들어간다. 없는 모델, 지문 불일치, 잘못된 특징/계수, 수치 오류는 `null`을 반환하므로 호출자는 기존 검색으로 폴백할 수 있다. 현재 생산 경로에 호출자는 없다.

수집기의 corpus/벡터 부재·손상은 실험 실패로 처리한다. 실제 연동 단계에는 기존 `semanticScores`와 같은 시간 제한·큐·폴백 관리가 필요하다. 현재 실험의 단어 빈도 캐시는 한 프로세스에서 누적되므로 장기 서비스에 연결하기 전에 캐시 상한을 정해야 한다.

## 해석 한계

지표는 **검색 후보와 선택 조문 적중**이다. MCP의 실제 본문 발췌·캠퍼스 검증·응답 길이 제한을 거치지 않았으므로 기존 엄격 정답률과 동등하지 않다. 질문 인코딩을 포함한 후보 수집 지연, Python 회귀/선택 지연, 모델 초기 적재를 따로 기록하며 MCP 전체 3초 목표는 여기서 검증하지 않는다.

공개 71문항에는 사용자 제공 keywords가 없어 질문만 평가한다. 정답에서 키워드를 만들지 않는다. 기존 사전/검색 코드가 공개 문항으로 개선된 이력, 적은 규정 그룹 수, 불완전한 음성 라벨 때문에 OOF만으로 새 보류 문항의 개선을 확정하지 않는다. 전체 71문항으로 학습한 최종 계수는 재현 산출물이며 별도 미사용 테스트셋으로 검증된 배포 모델이 아니다.

최종 수치는 `RESULTS.md`와 `results/report.json`을 참고한다. 출시 여부는 별도 공개 개발 확장과 동국규정팀의 미사용 보류셋 검증 후 판단한다.


`--key-encoding single`은 질의 임베딩을 정확히 한 번 사용하고 추가 텍스트 키는 낱말 특징에만 사용한다. `full`(기본값)은 과거 실험 설정으로 추가키도 인코딩한다. 두 조건은 별도로 학습하며 지문에도 조건이 포함된다.

평가기의 `--reference /path/to/d1-semantic-on-v3.json`은 공통 MCP 참조의 corpus·공개 문항·검색 의존성 4파일 해시와 query-only 모드를 검사한다. 생산 searchCorpus 직접 호출은 별도 지표이며 최종 MCP 발췌까지 거치지 않는다. `productionSearchCorpus.on.latencyMs`는 미리 계산한 semantic map을 받은 채점기 비용만으로 임베딩 시간이 제외된다.

## 새 공개 개발 20문항: 고정 모델 비교

[결과](DEV-OPEN-FROZEN-RESULTS.md): 기존 71문항으로 학습한 모델을 고정해 적용했다. 새 문항으로 학습·조정하지 않았다. 두 조건 모두 규정 top3 20/20·선택조문19/20으로 실험 RRF와 같으며, 생산 searchCorpus 선택조문18/20보다 한 건 개선하지만 의미 on의 규정1위에서 두 건 악화했다. 약점 중심 개발 비교이고 전체 MCP strict 및 박스 보류셋 효과는 미측정이다.

`collect-jev-evidence.js --dev-open <dev_open.json>`은 승인된 공개20 파일의 SHA 두 버전(ID R→RT 변경만)을 허용한다. 나머지 경로·옵션은 기존과 같다. `evaluate-jev-frozen.js --evidence <수집JSON> --trained-report <기존 D1 report-single-v2.json 또는 report-full-v2.json> --output <새결과JSON>`은 이전 모델 파일 SHA·입력 기준·생산 소스 해시를 검증하고 추론만 수행한다. 새 대용량 증거는 저장소에 넣지 않는다.

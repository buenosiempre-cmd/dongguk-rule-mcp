# 별표 구조 청크 실험 — 2026-11-27

**판단: 구조 추출은 유효하지만 검색 기본 적용은 보류한다.** 여비규정의 앵커 189개와 병합 복제값 47개가 기존 바이너리 감사 파서와 일치했다. 새 개발문항의 행·금액 근거 공존은 7/14 → 9/14였으나, 정답 별표 적중은 13/14 → 9/14로 떨어졌다. 파서 교체 자체의 우월성이나 서비스 정답률 향상을 입증한 결과는 아니다.

## 현재 수집·파싱 경로

조사 기준은 `origin/fix/pr52-semantic-review-20261127`의 `37b0736`이다.

- `src/index.js:281`의 `getOriginalContent`: 공식 `/fileDown.srv`에 `FILE_SEQ=HISTORY_ID&FILE_TYPE=ori`를 POST해 원문 HWP를 받고 `parseOriginalEvidence`에 전달한다. 별도 첨부의 `FILE_TYPE=attach` 자동 발견·다운로드는 없다.
- `src/hwp-evidence.js`: HWP5 OLE 바이너리 레코드를 감사하고 `@ssabrojs/hwpxjs`로 해석한다. 표의 좌표·rowSpan·colSpan·텍스트·해시와 추출 진단을 저장한다. 출력은 `행 | 열 | 행 병합 | 열 병합 | 내용`의 앵커 목록이다. 이미 병합 정보를 보존하지만 일반 행 표 형태는 아니다.
- `src/appendices.js`: 텍스트 제목으로 별표·서식을 구분한다. 본칙/부칙 경계를 검사하고 계약서 같은 서식의 모호한 조문 경계를 알린다. `lookup_dongguk_rule`, `get_rule_full_text`, 원본 비교 경로가 HWP 원문 내 별표를 사용한다.
- `src/index.js:320`의 전문 색인 빌드는 HTML `getContent`를 사용한다. HWP 별표를 별도로 수집하지 않는다. `src/corpus.js:15`는 조문 블록 중심, `src/semantic.js:60`은 400자·100자 겹침 분할이며 부칙 블록은 임베딩에서 제외한다. 이 조합은 별표 행의 표제·직급·금액을 함께 보존하는 색인이 아니다.
- 별도 PDF/HWPX 첨부·그림 OCR은 이 동국대 원문 경로에서 지원되지 않는다. 다른 대학용 PDF 어댑터가 존재한다고 해서 동국대 첨부 자동 수집이 구현된 것은 아니다.

기존 `docs/appendix-query-2026-11-05.md`는 당시 HISTORY_ID 3350을 예시로 든다. 이번 MCP 실조회는 여비규정 LAW_ID 184 / HISTORY_ID **3856**, 개정일·최종 부칙 시행일 **2026-03-13**을 확인했다. 근거는 **제7조 및 별표 1·2·3**이다. 원문: https://rule.dongguk.edu/lmxsrv/law/lawFullView.srv?SEQ=184&SEQ_HISTORY=3856 . 현행 적용성 전반을 판단하는 보고가 아니다.

## 구현과 충돌 경계

- `src/appendix-kordoc.js`: 로컬 HWP/HWPX/PDF를 선택 설치된 kordoc CLI로 `--format chunks --table-format gfm --no-images --silent` 파싱한다. 실행 상한 30초, 입력 32MiB, 출력 16MiB, 청크 20,000개, 텍스트 400만 자. 셸 실행·자동 설치·OCR 모델 다운로드는 하지 않는다. CLI 부재, 오류, 시간 초과, 잘못된 JSON이면 새 근거 없이 상태를 반환한다.
- kordoc의 breadcrumb에 앞선 부칙 제목이 남는 실사례가 있어, 청크의 **본문 순서에서 별표 제목을 다시 식별**한다. 표의 원래 chunkId·blockRange·page, 규정/연혁 ID·원문 URL·원본 SHA-256을 유지한다.
- GFM 헤더와 단위를 각 데이터 행에 반복한다. 임의 글자 수로 행을 자르지 않는다. 표 다음 주석은 별도 청크와 전체 별표 노드에 보존한다. 최대 4개 선두 헤더 행의 첫 셀 반복으로 다단 헤더를 인식하는 제한적 규칙이며 모든 표 형식에 대한 보증은 아니다.
- 동문부호(`"`, `“`)는 그대로 둔다. 값으로 추론하여 치환하지 않는다. 중복 별표 번호·모호한 서식 경계·해석 불가/복수 GFM 표는 해당 별표를 색인에서 빼고 경고한다.
- `src/appendix-index.js`: e5 로컬 모델로 행/주석 벡터를 만드는 독립 JSON 색인. 한 파일 임시 저장 후 rename한다. 전체 해시·유한 벡터·모델 일치와 **조회 시 catalog의 lawId/historyId 일치**를 확인한다. 없거나 깨지면 null을 반환한다. 모델은 기존 semantic.js의 createEmbedder를 재사용한다.
- 그래프는 별표→청크 `contains`, 같은 규정·같은 연혁의 명시적인 조문→별표 `appendix`만 만든다. 다른 규정 이름이 붙은 참조는 보수적으로 제외한다. 노드는 `ap:lawId:historyId:sourceHash:key`, 조문 노드는 기존 그래프와 같은 `a:lawId:blockIndex`다. 이 blockIndex는 **호출자가 전달한 corpus 순서**이므로 별도 HWP 배열의 번호를 운영 HTML corpus 번호와 섞으면 안 된다.
- `scripts/build-appendix-index.js`: 명시적으로 실행하는 실험 빌드 명령. `scripts/evaluate-appendix.js`: 고정 공개 train/dev와 신규 개발문항만 읽는 재현 하네스.
- **생산 조회에는 연결하지 않았다.** `src/parsers.js`, `src/corpus.js`, `src/index.js`, 기존 순위·임베딩 코드는 변경하지 않았다. t10x의 D1 수정과 t110의 fusion 통합을 침범하지 않는다. 실험 스크립트가 별도 색인에 실제 벡터와 그래프를 저장하며, 운영 설치만으로 결과가 달라지지 않는다.

## 수집·대사

동국규정 MCP의 `lookup_dongguk_rule(law_id=184, query=별표 1·2·3, include_history=true)`로 원문 메타데이터와 표를 먼저 확인했다. 쿠키 없이 고정 개정본 원문 84,992바이트 한 개를 내려받아 재사용했다. 수집 중 잘못된 경로의 701바이트 오류 응답 두 건은 파일 서명/파싱 단계에서 배제했다. 일괄 크롤링은 하지 않았다. 별도 첨부 자동 수집은 미구현이다.

검증은 같은 바이트를 기존 바이너리 감사 파서와 kordoc 4.25.2로 각각 읽어 비교했다. 독립적인 시각 검수나 다양한 PDF 별표 정확도 실험은 아니다. [kordoc 원 저장소](https://github.com/chrisryugj/kordoc)는 MIT이며 설치본 CLI 도움말과 타입 정의에서 chunks/GFM 옵션을 확인했다. 외부 벤치마크의 정확도를 동국대 표 정확도로 인용하지 않는다.

| 대사 항목 | 기존 파서 | kordoc | 차이 |
|---|---:|---:|---:|
| 표 수 | 3 | 3 | 0 |
| 원본 앵커 셀 | 189 | 189 일치 | 0 |
| 세로 병합의 추가 행 값 | 47 | 47 일치 | 0 |
| 단일 숫자/금액 셀 수 | 37 | 37 | 0 |
| 별표 1 단일금액 앵커 합계(KRW) | 140,000 | 140,000 | 0 |
| 별표 2 단일금액 앵커 합계(USD) | 4,553 | 4,553 | 0 |

금액 합계는 **파싱 대사용**이다. 한 셀에 여러 금액/단위가 든 식비 셀 등은 숫자 합계에서 제외하고 텍스트 일치로 확인했다. 지급 총액을 뜻하지 않는다. 공백·줄바꿈·Markdown escape만 정규화했다. 표 3은 국가/등급표라 금액 합계 대상이 아니다.

## 검색 비교

모델·정책은 사전 고정: multilingual-e5-small q8, 같은 query vector 1회, cosine top3, 학습/가중치 조정 없음. 기존 좌표 목록도 `articleTexts`로 임베딩한 **생산보다 유리한 별표 한정 대조군**을 사용했다. 실제 생산 색인은 이 별표를 별도 수집하지 않는다. 정답 규정을 이미 안다고 가정한 제한된 비교이며 513개 규정 검색 성능이 아니다.

| 세트/지표 | 기존 좌표 목록 24청크 | kordoc 43청크 |
|---|---:|---:|
| 공개 train: 정답 별표 적중 | 4/4 | 4/4 |
| 공개 dev: 정답 별표 적중 | 1/2 | 1/2 |
| 신규 dev: 정답 별표 적중 | 13/14 | 9/14 |
| 신규 dev: 항목·금액/등급 근거 공존 | 7/14 | 9/14 |

공개 train46/dev25 중 여비규정 별표 라벨이 있는 **6개**(A01/A02/A26/A27/H01/H23)만 이 실험의 범위다. 나머지 **65개는 미평가**이며 전체 71개 성능을 주장하지 않는다. 공개 라벨은 별표/조문 단위라 정확한 금액 답변 점수는 내지 않았다(`evidenceHits`의 0은 미라벨/미채점이지 오답 수가 아니다). v4~v6 및 보류셋은 읽거나 학습·조정에 사용하지 않았다.

새 문항 14개는 원문 확인 뒤 작성한 개발 자료로 독립 보류셋이 아니다. kordoc 근거 점수는 정답 행 번호와 모든 기대 토큰의 공존, 기존 점수는 한 청크의 토큰 공존만 확인하여 기존 방법에 유리한 상한 추정이다. 실제 정답 생성·해석을 채점하지 않았다.

새로 틀린 별표 문항: **N06, N07, N08, N09**. 새로 틀린 행 근거 문항: **N07, N09**. kordoc 행 근거 실패 전체: **N05~N09**. 공개 dev **H23**은 양쪽 모두 실패했다. 질문·기대 행·양쪽 상위 결과를 `results/evaluation.json`에 전부 보존했다. 실패를 보고 문항 표현·순위 가중치를 조정하지 않았다.

## 실행 비용·테스트

최종 한 번의 20문항 실행 기준(동시 부하에 따라 달라짐): query embedding 중앙 2.51ms/p95 3.30ms, 기존 후보 채점 0.08ms/0.27ms, 별표 색인 검증+채점 1.98ms/2.27ms. 모델 적재 454ms, 새 별표 벡터 빌드 533ms. 프로세스 RSS 약 892MiB이며 **기존 서비스 대비 증분 RSS는 미측정**이다. MCP 종단 지연 3초 기준도 미측정이다.

43 passages = 표 데이터 행 41 + 단위/주석 텍스트 2. 그래프 47노드/46간선 = 별표 3 + 청크 43 + 실제 제7조 1, contains 43 + 조문별표 연결 3. 그래프를 이용한 재순위 효과는 측정하지 않았다. 전체 별표 근거 확장 시 토큰 예산은 후속 통합에서 제한해야 한다.

- `npm test`: 51개 순차 스크립트 전부 성공(새 별표 검사 포함), exit 0.
- 새 검사: 제목 경계·다단 헤더 행·단위/주석·중복/모호 경계·외부 규정 참조 배제·같은 연혁 그래프·미설치·실제 하위 프로세스 timeout·손상 JSON/색인·모델 불일치·과거 연혁 배제.
- 실설치 CLI: 공식 HWP 47청크(약 201ms), 저장소 기존 합성 PDF fixture 1청크(약 211ms). PDF는 어댑터 실행 smoke이며 표 정확도 검증이 아니다. HWPX의 실문서 정확도는 미측정이다.
- 실제 HWP→CLI→벡터/그래프→단일 JSON 빌드 성공, 저장 후 조회와 손상 폴백은 자동 테스트로 확인했다.

## 재현

필수 의존성 추가 없음. kordoc은 별도 선택 설치하며 설치하지 않으면 기존 동작이 유지된다.

```sh
npm ci
# 필요할 때만 별도 설치 (검증 버전)
npm install -g kordoc@4.25.2
node test/test-appendix-kordoc.js

# 모델·런타임은 이미 로컬에 준비된 경로를 지정. 네트워크 모델 다운로드 안 함.
export DONGGUK_MCP_SEMANTIC_RUNTIME=/path/to/transformers-install
export DONGGUK_MCP_SEMANTIC_MODEL_DIR=/path/to/local-models
node scripts/evaluate-appendix.js /tmp/appendix-result-new.json
```

실원문을 다시 파싱할 때는 공식 HWP 한 파일을 로컬에 준비한다. manifest의 `file`은 manifest 기준 상대경로, source는 lawId/historyId/title/url이며 원본 해시는 실행기가 계산한다. 선택 `corpus`는 정확히 그 연혁의 조문 블록 배열이다.

```json
{"file":"travel.hwp","source":{"lawId":184,"historyId":3856,"title":"여비규정","url":"https://rule.dongguk.edu/lmxsrv/law/lawFullView.srv?SEQ=184&SEQ_HISTORY=3856"}}
```

```sh
node scripts/build-appendix-index.js manifest.json /tmp/appendix-index-new.json
```

기존 출력은 덮어쓰지 않는다. 실험 질문·원문 해시·코드 해시·전체 결과는 저장소에, 원본 바이너리/임시 출력/벡터 JSON은 로컬에 둔다. 원문을 여러 개 수집하는 후속 작업은 파일 간 최소 간격과 재사용 캐시를 별도 구현해야 한다.

## 후속 통합 조건

1. t10x D1 복구 corpus와 동일 연혁 catalog에서 다시 연결한다. 이번 실험은 단일 HWP에서 직접 읽어 D1 HTML 본문 누락을 우회했을 뿐 D1을 고친 것이 아니다.
2. t110은 행 벡터를 바로 규정 가점으로 쓰기 전에 규정→별표→행 단계 선택과 기존 좌표표의 구조 재구성 대조군을 비교한다. 현재 이득은 파서와 청킹 변경이 함께 작용하므로 kordoc만의 우위로 분리할 수 없다.
3. 별도 첨부 발견·개정본 귀속·PDF/HWPX/다단·중첩표·주석/동문부호를 추가 검증한다. 성공한 표만으로 전체 첨부 지원을 선언하지 않는다.
4. 기존 조회 폴백과 번호/과거시점 명시 조회를 그대로 유지하고, 통합 시 실제 사용 신호·실패 이유·현재 연혁을 응답에 표시한다.

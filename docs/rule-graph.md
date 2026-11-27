# 규칙 기반 규정 그래프 — 2026-11-27

기존 본문 색인을 입력받아 관련 규정 후보와 인용된 조문을 보충하는 선택 모듈이다. LLM·외부 API·추가 패키지 없이 동작한다. 이 단계에서는 검색 서비스에 자동 적용하지 않는다. RRF/JEV 통합 담당이 아래 API를 호출한다. 그래프 관계는 검색 근거이며 법적 적용이나 상하위 효력을 확정하지 않는다.

## 입력과 관계

`buildRuleGraph(corpus, { histories })`의 corpus는 기존 `src/corpus.js` 형식이다. `rules[]`에 `lawId`, `historyId`, `title`, `blocks[]`가 있어야 한다. 각 블록에는 `article`, `content`, `supplementary`를 사용한다. 선택적 `rule.scope`는 호출자가 확인한 범위 문자열이다. 이름 접두사로 서울·WISE·기관을 추측하지 않는다.

| 관계 | 추출 근거 | 검색 가중치 |
| --- | --- | ---: |
| cites | 현재 목록의 유일한 규정명 또는 같은 규정 조문번호 | 0.65 |
| applies | 인용 주변의 긍정 준용 문구 | 0.85 |
| implements | 한 규정만 인용하며 ‘따라/의하여/근거하여’와 ‘시행에 필요한/위임 사항/세부 사항’을 함께 명시 | 1.0 |
| appendix | 자체 별표 번호 | 0.4, 검색 확장에서는 제외 |
| revises | 같은 규정의 유효하고 서로 다른 개정일 순서 | 0, 검색 확장에서는 제외 |

가중치는 합성 예시용 초기값이며 정답률로 보정한 확률이 아니다. 위계 방향은 하위→상위이고, 탐색은 양방향 한 단계다. 제목이 비슷하다는 이유만으로 위계 관계를 만들지 않는다. 조문 목록의 명시된 번호만 읽고 범위 중간 조문은 추정하지 않는다. 낫표 없는 이름은 문장 시작(선택적 항 번호 뒤)에 완전 이름이 있을 때만 연결한다. 띄어 쓴 기관·캠퍼스 한정자를 잃는 오연결을 피하기 위한 제한이다. 외부 법령·중복 규정명·없는 조문은 미해결 기록에 남긴다. 외부 이름이 함께 있는 문장의 독립적인 자체 인용은 보수적으로 생략할 수 있다. 부칙 조문은 번호 충돌을 피하려고 제외한다. 별표 본문은 만들지 않고 `available:false`로 표시한다.

`histories`는 `{[lawId]: [{historyId, revisedAt}]}`이며 선택 입력이다. YYYY.MM.DD 또는 YYYY-MM-DD 개정일만 허용하고 같은 날짜의 선후 관계는 만들지 않는다. 개정 이력은 시행일이나 조문 변경 내용과 다르다. 실제 규정의 조문·시행일 검증은 이 모듈의 범위가 아니다.

## 검색 통합 계약

```js
const { loadRuleGraph, rankRelatedRules, getRelatedArticles } = require('./rule-graph.js');
const graph = loadRuleGraph(directory, corpus); // 시작/색인 갱신 때 한 번 로드
const seeds = [{ lawId: 123, article: '제2조', score: 0.8 }];
const rules = rankRelatedRules(graph, seeds, { limit: 10 });
const articles = getRelatedArticles(graph, seeds, { limit: 8 });
```

seed는 정수 lawId 또는 `{lawId, article?, score?}`이다. score는 0~1로 제한하며 생략하면 1이다. 서로 다른 검색기의 원시 점수는 직접 넣지 말고 정규화하거나 순위만 사용한다. 같은 규정의 여러 조문 seed는 합친다. 최대 16개 seed와 최대 50개 결과, 기본 10개 결과를 반환한다. 후보 점수는 `seed score × 관계 가중치 / sqrt(대상 규정의 이웃 규정 수)`이며 같은 seed 규정에서 같은 대상에 가는 관계는 최댓값 한 번만 반영한다. 연결이 많은 큰 규정과 반복 인용의 과도한 상승을 억제한다.

규정 결과는 `{lawId,historyId,title,score,relation,evidence}`, 조문 결과에는 `{article,blockIndex}`가 추가된다. evidence는 출처 규정·버전·블록 위치와 인용 문구다. `{scope:'서울'}`처럼 범위를 주면 seed와 대상의 `rule.scope`가 정확히 같은 경우만 사용하며 scope가 없는 규정도 제외된다. 원래 본문 색인에는 scope가 필수 필드가 아니므로 범위를 쓰려면 통합 계층이 먼저 확인해 주어야 한다.

RRF에서는 반환 배열의 순위를 별도 검색 채널로 합친다. JEV에는 그래프 순위/점수를 특징으로 넣을 수 있다. 관련 조문은 원문 corpus의 blockIndex로 읽되 현재 catalog의 historyId를 재확인한다. 그래프 후보만으로 단일 규정을 확정하지 않는다. `loadRuleGraph`가 null이거나 결과가 빈 배열이면 기존 검색 결과를 그대로 반환한다.

## 저장·운영

```sh
npm run build:rule-graph -- /path/to/corpus-v1.json /path/to/index-directory /path/to/histories.json
```

마지막 histories 인수는 생략 가능하다. 생성기는 입력 파일을 수정하지 않으며 네트워크에 접근하지 않는다. `<index-directory>/graph/rule-graph-v1.json`에 그래프와 SHA-256 체크섬을 한 파일로 저장하고 임시 파일 rename으로 교체한다. 원문 규정 ID·버전·제목·본문·scope의 해시가 다르면 이전 그래프를 사용하지 않는다. 조문 위치 범위·본문 여부도 재검증한다. 이력 데이터 자체가 갱신되면 그래프를 다시 생성해야 한다.

복원한 그래프는 읽기 전용으로 취급한다. 첫 탐색에서 노드·인접 관계·연결 수를 준비하고 같은 객체에서 재사용한다. 원문 전체를 해시하는 로드는 요청마다 호출하지 않는다. 추출은 색인 갱신 시 수행하고 요청 중에는 한 단계 인접 관계만 읽는다. 요청당 추가 지연 10ms 이내, 그래프 메모리 30MB 이내를 초기 예산으로 삼되 실제 전체 corpus로 확인해야 한다.

## 검증 범위

`node test/test-rule-graph.js`와 `npm test`로 검사한다. 새로 작성한 합성 규정만 사용한다. 비공개 보류 문항은 접근하지 않는다. 기본 테스트는 위계·인용·별표·이력, 범위 필터, 중복투표 억제, 파일 손상·구버전 본문 폴백, 줄바꿈된 외부 인용, 외부기관 접미 이름 충돌, 부정 준용, 복수 seed 조문을 포함한다. 실제 자연어 정답률 95%나 전체 검색 3초 목표 달성 여부는 통합 후 별도 평가가 필요하다.

성능 재현: `node --expose-gc scripts/benchmark-rule-graph.js`. 500개 합성 규정·조문 10,000개의 순환 인용을 만들고, 인접 관계를 준비한 뒤 규정 후보와 관련 조문 조회를 1,000번 함께 수행한다. 최초 측정은 생성 47.55ms, 조회 중간값 0.016ms·P95 0.027ms, 힙 증가 5.18MB, 직렬화 JSON 2.70MB였다. 단순 합성 연결 구조에 대한 수치이므로 실제 corpus의 분포·정답률을 대표하지 않는다. 원본 500규정과 저장 후 재조회한 500규정이 일치했고, 10,500노드·10,000관계가 보존됐다.

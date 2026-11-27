# 규정 후보 순위 결합 (fusion)

자연어 질문의 규정 후보 순서는 `src/fusion.js` 한 곳에서 정합니다. 낱말 색인(`corpus.js`)이 후보와 낱말 점수를 내고, 의미검색·온톨로지·그래프·확률은 있을 때만 더합니다. 빠진 신호는 빼고 결합하며, 전부 없으면 낱말 색인만의 순서입니다.

## 방식

`DONGGUK_MCP_RANKING`으로 고릅니다. 기본은 `legacy`이고, 모르는 값도 `legacy`로 읽습니다. 응답의 `search.ranking`에 실제 쓴 방식이 나옵니다.

| 값 | 동작 |
|---|---|
| `legacy` | 이 모듈을 넣기 전의 순서. 낱말 점수에 의미 순위 가산, 질문이 말한 캠퍼스·기관의 판이 있으면 그 판의 규정만 남김 |
| `hybrid` | 점수는 같고, 캠퍼스·기관을 온톨로지로 읽음. 물은 곳의 규정은 1.5배, 다른 곳의 규정은 0.6배, 전교 규정은 그대로 후보로 남김. 본문이 다른 직군의 규정은 0.8배 |
| `rrf` | 낱말 순위·의미 순위·장소 단계(·그래프 순위)를 RRF(`1/(k+순위)`, k=10)로 결합. 의미 순위가 없으면 `hybrid`로 동작 |
| `jev` | 호출부가 규정별 확률을 넘기면 확률 순서. 없으면 `hybrid`로 동작 |

`hybrid`가 `legacy`와 다른 점은 세 가지입니다.

1. **전교 규정을 버리지 않습니다.** "경주캠퍼스 직원 병가"에 WISE판이 없는 취업규칙이 후보로 남습니다. `legacy`는 제목에 WISE가 든 규정이 하나라도 걸리면 나머지를 모두 버립니다.
2. **판은 캠퍼스와 기관이 모두 맞아야 고릅니다.** 캠퍼스만 물었을 때 "WISE캠퍼스 산학협력단 취업규칙"이 취업규칙을 대신하지 않습니다.
3. **기관은 그 기관을 가리키는 말로만 읽습니다.** 의대·의학과·병원은 의학계열이고, 불교의학연구소·의학연구소는 연구소 이름입니다(`src/data/ontology.json`의 `scopes[].place`).

한 규정만 보여 주는 판정은 방식과 관계없이 낱말 점수로 합니다(1위가 나머지보다 1.3배 이상).

## 연결 계약 (그래프·JEV 담당)

```js
const { rankRules } = require('./fusion');
rankRules({
  candidates,   // 낱말 색인이 찾은 규정: { lawId, title, family, edition, score, wordScore, semanticRuleRank }
  scope,        // lookup.requestedRuleScope(질문, campus) — legacy가 쓰는 범위
  query, campus,// 질문과 도구의 campus 인수 — hybrid·rrf·jev가 온톨로지로 장소를 읽음
  facets,       // ontology.createFacetSignal({corpus, query}) 또는 null
  semantic,     // 의미 순위가 있으면 true
  graph,        // Map(lawId → 점수) 또는 null. rrf에서 한 목록으로 더함(가중 0.5)
  probability,  // Map(lawId → 확률) 또는 null. jev에서 순서를 정함
  method,       // 생략하면 DONGGUK_MCP_RANKING
}) // → { method: 실제 쓴 방식, ranked: [{ ...후보, scopeMatch, scopeAmbiguous, editions, order }] }
```

- `graph`·`probability`는 후보를 새로 만들지 않습니다. `candidates`에 있는 규정의 순서만 바꿉니다. 그래프로 후보를 넓히려면 호출부(`index.js`의 `rankIndexHits`)에서 후보를 더한 뒤 넘깁니다.
- 호출부는 과거 기준일·조문/별표 명시·로그인 쿠키 요청에서 새 신호를 넘기지 않습니다(지금은 색인 조회 자체를 하지 않는 경로입니다).
- `index.js`·`corpus.js`의 순위 코드는 이 모듈을 통해서만 바꿉니다.

## 측정

```sh
node scripts/measure-natural-language.js --cache <캐시 사본> --questions 문항.json[,문항2.json] \
  [--ranking legacy|hybrid|rrf] [--keywords 핵심어.json] [--out 결과.json] [--compare 이전결과.json]
```

- `<캐시 사본>`은 `XDG_CACHE_HOME`으로 쓰는 폴더입니다(`dongguk-rule-mcp/v2/public/corpus/corpus-v1.json` 필요). 실행하면서 파일 시각을 고치므로 서버가 쓰는 캐시가 아니라 사본을 줍니다. 의미검색까지 재려면 같은 폴더에 벡터 파일이 있어야 하고 런타임 환경변수(`DONGGUK_MCP_SEMANTIC_RUNTIME` 등)를 함께 줍니다.
- 기본은 오프라인입니다. 제목 검색은 색인으로 대신 답하고 그 밖의 원문 요청은 실패시킵니다. 캐시에 없는 원문을 받으려면 `--online`.
- 내는 값: 정답 조문 포함(엄격), 정답 규정 상위 3, 규정이 맞을 때 조문 포함, 한 규정만 보여 준 수와 그 정확도, 지연 중앙값·p95, RSS. 세트(파일)별로 나눠 냅니다. `--compare`는 새로 틀린 문항과 정답 규정이 상위 3에서 빠진 문항을 모두 적습니다.
- 지연은 이 프로세스 안의 조회 시간입니다. 원문 사이트 왕복은 들어 있지 않습니다.

## 그래프 연결 실험 (2026-11-27, #60의 3ee3b90 + #54의 9318ad4)

`DONGGUK_MCP_RANKING=hybrid-graph`만 새 연결을 사용한다. 기본 `legacy`, 기존 `hybrid`, 비교용 `jev` 동작은 유지한다. `src/index.js`·`src/corpus.js`의 순위 코드는 이 실험에서 변경하지 않았다. 병합으로 들어온 D1 파서·캐시 버전 변경은 별도 선행 변경이다.

`src/graph-fusion.js`가 공개 corpus 객체마다 그래프를 한 번 로드/생성하고 `rankRelatedRules`를 호출한다. 별도 디스크 쓰기·네트워크는 없다. corpus 갱신 시 새 객체로 다시 준비한다. 설정은 문항 측정 전에 고정했다.

- hybrid 정렬의 상위 3개를 seed로 쓰며 seed 점수는 1, 1/2, 1/3이다.
- 명시적 `implements` 간선은 하위→상위로 저장된다. **가점은 반대 탐색인 상위→하위만** 허용한다. 단순 제목 유사성을 위계로 추정하지 않는다.
- 하위 대상 제목은 `시행세칙` 또는 `내규`로 끝나고, 상위 규정의 본칙 블록 수가 하위보다 많아야 한다. 이는 법적 효력 판정이 아닌 보수적 검색 제한이다.
- 상향·일반 인용/준용·부칙·별표·개정 관계는 가점하지 않는다. 방향별 적용/차단 횟수와 근거를 실험 하네스가 기록한다. 금지된 방향의 양의 가점 조건은 측정하지 않는다.
- 기존 후보에 있는 규정만 조정하고, 명시적 캠퍼스/기관 불일치 또는 버전 불일치는 건너뛴다. 후보를 추가하거나 선택 조문을 교체하지 않는다. `getRelatedArticles`는 이 범위에서 호출하지 않는다.
- 규정 점수는 `hybrid order × (1 + 0.25 × graphScore)`이며 합산 graphScore는 1을 넘지 않는다. 상향 등 다른 방향의 계수는 0이다. 이미 큰 규정에 모이던 일반 인용 신호는 섞지 않는다.
- corpus·그래프 없음/손상/예외는 가점 0으로 hybrid 순서를 보존한다. 반환 `graphAudit`은 상태와 방향별 근거를 담는다. 실제 MCP의 `search.ranking`은 선택 방식이고, 세부 그래프 audit은 실험 하네스에 저장한다.

`node scripts/measure-graph-fusion.js --cache <자체 캐시> --questions <공개 문항들> --ranking hybrid|hybrid-graph --query-only --out <새 JSON>`으로 실제 MCP를 오프라인 측정한다. `--keywords`와 함께 측정할 때는 `--query-only`를 빼야 한다. wrapper는 고정 corpus/벡터 SHA·TEXT3을 검사하고 입력 해시·커밋·방향 trace를 결과에 보존한다. `--query-only`는 fixture의 args.keywords도 무시한다. 문항별 의미검색 사용 여부도 기록한다.

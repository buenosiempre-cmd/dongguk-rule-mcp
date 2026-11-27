# 규정 후보 순위 결합 (fusion)

자연어 질문의 규정 후보 순서는 `src/fusion.js` 한 곳에서 정합니다. 낱말 색인(`corpus.js`)이 후보와 낱말 점수를 내고, 의미검색·온톨로지·그래프·확률은 있을 때만 더합니다. 빠진 신호는 빼고 결합하며, 전부 없으면 낱말 색인만의 순서입니다.

## 방식

`DONGGUK_MCP_RANKING`으로 고릅니다. 기본은 `legacy`이고, 모르는 값도 `legacy`로 읽습니다. 응답의 `search.ranking`에 실제 쓴 방식이 나옵니다.

| 값 | 동작 |
|---|---|
| `legacy` | 이 모듈을 넣기 전의 순서. 낱말 점수에 의미 순위 가산, 질문이 말한 캠퍼스·기관의 판이 있으면 그 판의 규정만 남김 |
| `hybrid` | 점수는 같고, 캠퍼스·기관을 온톨로지로 읽음. 물은 곳의 규정은 1.5배, 다른 곳의 규정은 0.6배, 전교 규정은 그대로 후보로 남김. 본문이 다른 직군의 규정은 0.8배. 호출부가 그래프 관계를 넘기면 가장 강한 관계의 규정을 1.3배까지 올림 |
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
  graph,        // Map(lawId → 점수) 또는 null. hybrid는 최대 1.3배 가점, rrf는 한 목록으로 더함(가중 0.5)
  probability,  // Map(lawId → 확률) 또는 null. jev에서 순서를 정함
  placeAgreementOf, // (candidate, place) → 정수 | null. 규정의 장소를 제목 말고 다른 근거로 읽는 실험용(아래)
  method,       // 생략하면 DONGGUK_MCP_RANKING
}) // → { method: 실제 쓴 방식, ranked: [{ ...후보, scopeMatch, scopeAmbiguous, editions, order }] }
```

- `placeAgreementOf(candidate, place)`: `candidate`는 위 후보 객체, `place`는 `ontology.placeRequest(질문, campus)`의 결과(`{campuses, institutions, specified, ambiguous}`)입니다. 돌려주는 값은 `placeAgreement`와 같은 뜻의 정수입니다 — 양수: 질문이 말한 곳의 규정, 음수: 질문이 말하지 않은 곳의 규정, 0: 전교 규정. **근거가 없으면 `null`을 돌려주면 그 규정은 제목으로 읽습니다.** 정수가 아니거나 예외가 나도 제목으로 읽습니다. `legacy`에서는 부르지 않고, 질문이 장소를 말하지 않으면(`place.specified`가 false) 부르지 않습니다. 판 고르기(같은 계열에서 가장 잘 맞는 판만 남김)와 가중(1.5배·0.6배)은 fusion에 그대로 있습니다. 동기 함수여야 하고, 규정별 판독은 호출부가 색인당 한 번 만들어 재사용합니다.
- `graph`·`probability`는 후보를 새로 만들지 않습니다. `candidates`에 있는 규정의 순서만 바꿉니다. 그래프로 후보를 넓히려면 호출부(`index.js`의 `rankIndexHits`)에서 후보를 더한 뒤 넘깁니다.
- 호출부는 과거 기준일·조문/별표 명시·로그인 쿠키 요청에서 새 신호를 넘기지 않습니다(지금은 색인 조회 자체를 하지 않는 경로입니다).
- `index.js`·`corpus.js`의 순위 코드는 이 모듈을 통해서만 바꿉니다.

## 그래프 연결 (비교용)

`src/rule-graph.js`의 `rankRelatedRules` 결과를 `relationScores(related, 'down'|'all')`로 걸러 `graph`에 넘깁니다. 씨앗은 점수 순 앞선 후보 5개이고 원점수 대신 순위(1, 1/2, …)를 줍니다. 그래프는 후보를 새로 만들지 않고 있는 후보의 순서만 바꿉니다.

- `down`: 앞선 후보를 "시행"한다고 본문에서 밝힌 하위 규정만 올립니다(학칙 → 그 시행세칙). 상위 규정 쪽이나 단순 인용 관계는 올리지 않습니다. 그 방향은 인용이 많은 큰 규정으로 쏠립니다.
- `all`: 모든 관계를 양방향으로 넘깁니다. 방향별 효과를 재려고 둔 값입니다.

기본으로는 그래프를 만들지도 넘기지도 않습니다. `DONGGUK_MCP_MEASURE_GRAPH`(측정 스크립트의 `--graph`)가 있을 때만 동작합니다.

## 비교용 스위치 (서버 설정이 아님)

측정 스크립트가 켜는 환경변수입니다. 운영 서버에는 두지 않습니다.

| 스크립트 옵션 | 환경변수 | 뜻 |
|---|---|---|
| `--no-standing` | `DONGGUK_MCP_MEASURE_STANDING=off` | 다른 규정이 많이 인용하는 큰 규정의 가점(`corpus.js` `ruleStanding`, 최대 1.35배)을 빼고 점수를 냄. 가점 자체는 바꾸지 않음 |
| `--graph down\|all` | `DONGGUK_MCP_MEASURE_GRAPH` | 규정 그래프 모듈이 있는 브랜치에서만 동작. `down`은 앞선 후보를 "시행"한다고 밝힌 하위 규정만, `all`은 모든 관계를 `graph`로 넘김 |
| `--query-only` | — | 문항에 든 인수(출제자 핵심어)를 빼고 질문만 보냄 |

## 측정

```sh
node scripts/measure-natural-language.js --cache <캐시 사본> --questions 문항.json[,문항2.json] \
  [--ranking legacy|hybrid|rrf] [--keywords 핵심어.json] [--out 결과.json] [--compare 이전결과.json]
```

- `<캐시 사본>`은 `XDG_CACHE_HOME`으로 쓰는 폴더입니다(`dongguk-rule-mcp/v2/public/corpus/corpus-v1.json` 필요). 실행하면서 파일 시각을 고치므로 서버가 쓰는 캐시가 아니라 사본을 줍니다. 의미검색까지 재려면 같은 폴더에 벡터 파일이 있어야 하고 런타임 환경변수(`DONGGUK_MCP_SEMANTIC_RUNTIME` 등)를 함께 줍니다.
- 기본은 오프라인입니다. 제목 검색은 색인으로 대신 답하고 그 밖의 원문 요청은 실패시킵니다. 캐시에 없는 원문을 받으려면 `--online`.
- 내는 값: 정답 조문 포함(엄격), 정답 규정 상위 3, 규정이 맞을 때 조문 포함, 한 규정만 보여 준 수와 그 정확도, 의미검색을 실제로 쓴 문항 수, 오류 수, 지연 중앙값·p95, RSS. 세트(파일)별로 나눠 냅니다. `--compare`는 새로 틀린 문항과 정답 규정이 상위 3에서 빠진 문항을 모두 적습니다.
- 지연은 이 프로세스 안의 조회 시간입니다. 원문 사이트 왕복은 들어 있지 않습니다.

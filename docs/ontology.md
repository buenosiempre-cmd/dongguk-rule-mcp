# 온톨로지 모듈 연결 계약

온톨로지는 검색용 분류 정보입니다. 적용 여부나 법적 우열을 판정하지 않고, 점수를 계산하거나 후보를 추가하지 않습니다. `corpus.js`·`index.js`와 실제 결합 호출부는 이 작업에서 변경하지 않았습니다. t110의 `fusion.js`에서 아래 선택 신호를 연결합니다.

```js
const { createFacetSignal } = require('./ontology');
const facets = createFacetSignal({ corpus, query, keywords });
// corpus가 없거나 rules 배열이 없으면 null
// facets.question: 질문의 대상·범위·개념
// facets.ruleOf(lawId): 규정 분류. 모르는 ID는 null
// facets.matchOf(lawId): { subject, campus, institution }
// 각 값: 'match' | 'mismatch' | 'unknown'
// facets.status: 'packaged' | 'fallback'
rankRules({ corpus, query, keywords, lexical, semantic, graph, facets, method });
```

`unknown`은 일치도 불일치도 아닙니다. 결합 계층에서 중립으로 취급하고, 분류만으로 단독 확정하지 않아야 합니다. 가중치·점수 결합·실제 조회 연결은 t110이 맡습니다. 과거 기준일·조문/별표 명시·쿠키 요청에서 새 신호를 사용하지 않는 책임도 호출부에 있습니다.

## 자료와 기존 사전

- `src/data/ontology.json`: 기존 사전에서 그대로 이전한 204개 동의어 묶음, 대상 5종(직원·교원·학생·강사·조교), 범위 6종, 개념 분류 5종(보수·수당·여비·휴학·복학), 규정 종류와 편제 분류.
- `src/aliases.js`: 이 자료로 기존 `CONCEPT_GROUPS`, 대상·범위 함수를 구성합니다. 동의어 방향·순서·기존 반환 계약을 유지합니다. 새 분류용 서울 범위는 기존 `questionScope` 반환 객체에는 추가하지 않습니다.
- `src/ontology-defaults.js`: 자료 누락·JSON/스키마 오류 시 쓰는 내장 스냅샷. 기본 자료와 일치하는지 테스트합니다. 자료 변경 시 두 파일을 함께 갱신해야 합니다.
- 기존 문항 표현이나 LAW_ID를 추가 매핑하지 않았습니다. 기존 동의어를 늘리지 않고 분류 표제를 붙였습니다. v4~v6와 보류셋은 사용하지 않았습니다.

기존 `questionSubject`는 대상이 복수면 null을 내는 계약을 유지합니다. 새 `questionFacets`는 복수 대상을 보존하고 불명확함을 표시합니다. `교원` 대상 규정은 `강사` 질문을 포함할 수 있으나 그 반대는 자동으로 인정하지 않습니다.

## 질문·규정 분류

`questionFacets(query, keywords)`와 `ruleFacets(rule)`은 다음 모양의 불변 객체를 반환합니다.

```js
{
  subjects: ['직원'],
  scopes: { campus: ['wise'], institution: [] },
  concepts: ['여비'],
  evidence: [{ dimension: 'subject', value: '직원', source: 'title' }],
  ambiguities: [],
  // 규정에만:
  kind: '내규',
  articleCount: 3
}
```

- 질문의 캠퍼스·기관은 `query`에서만 읽습니다. `keywords`의 기관명으로 범위를 바꾸지 않습니다. 대상은 질문에 없을 때에만 keywords를 보조로 사용합니다.
- `서울 출장` 같은 지명만으로 서울캠퍼스라고 판단하지 않습니다. 서울캠퍼스·서울본교처럼 범위가 명시돼야 합니다. 범위 미지정은 서울판을 뜻하지 않습니다.
- 규정 제목과 본칙의 적용범위·적용대상·적용 조문을 읽습니다. 일반 본문 인용과 부칙은 대상 판단 근거로 쓰지 않습니다.
- 제목이 넓고 적용대상이 좁으면 공통 대상만 남깁니다. 서로 충돌하면 해당 분류를 비우고 `CONFLICT_*`를 표시합니다. 제외·준용 등 조건이 있으면 범위를 확정하지 않고 `QUALIFIED_APPLICATION`으로 남깁니다.
- 편제 `8-`은 산학협력단 규정집의 약한 근거로 `evidence`에 기록합니다. 코드만으로 기관 적용이나 서울캠퍼스를 확정하지 않습니다.
- `evidence.source`는 `query`, `keywords`, `title`, `application`, `code`입니다. 적용범위 조문에는 원래 `blockIndex`, 코드 추정에는 `inferred: true`가 있습니다.
- `articleCount`는 부칙을 제외한 문자열 본문 블록 수입니다. 벡터 조각 수나 별표 수를 세지 않습니다.
- corpus 객체를 키로 한 WeakMap 캐시를 사용합니다. 색인이 바뀌면 새 corpus 객체를 전달해야 합니다. 같은 객체의 내용을 나중에 바꾸는 방식은 지원하지 않습니다.

## 근거와 검증 범위

이전 기준은 PR #53의 `37b0736c52d5cb02a01ec7a4f86641b5a80eda1c`입니다. 저장소 train 46문항·dev 25문항, 기존 727개 용어에 대해 기존 함수 출력 서명을 고정했습니다. 별도로 동일한 공개 HTML 색인에서 71문항의 상위 10개 검색 결과(점수·조문 포함)가 이전 전후 모두 같음을 확인했습니다.

추가한 분류 표제의 공개 본문 문서 빈도(513규정, 2026-11-25 23:50:44 UTC 생성 색인): 보수 78, 급여 42, 월급 6, 봉급 3, 임금 18, 수당 59, 여비 16, 출장 18, 휴학 33, 복학 14. 출장비는 0건이나 기존 사전의 여비 동의어를 그대로 보존한 항목입니다. 빈도는 단순 본문 포함 수로서 법적 적용 근거가 아닙니다. 색인 SHA-256: `82074884a0f078cf2d74d7ea01fcd3d6f455a5607a908b44cd1389ea28384d4b`.

`test/fixtures/ontology-development.json`은 새로 작성한 분류용 개발 문항 20개입니다. 실제 규정 정답을 단정하는 평가셋이 아닙니다. 다른 구현 담당자가 계약 검증에 사용할 수 있습니다.

```sh
npm run test:ontology
npm test
```

모델·네트워크 없이 실행합니다. 전체 검색 정답률과 실서비스 응답시간의 향상은 아직 측정하지 않았습니다. 동작 보존과 모듈 비용만 확인하며, 채택 판단은 통합 후 별도 측정 대상입니다.

## D1 반영 공통 비교 기준 (2026-11-27 고정)

위 최초 자료 이전 대조와 문서 빈도는 D1 수정 전 색인의 기록입니다. 후속 비교는 코드 `907b998a095ffbe7c490fdb961dc90b090ddbf5e`(PR #57, PR #53 포함)를 바탕으로 합니다. 이 브랜치에는 해당 D1 수정을 일반 병합으로 반영했으며, 온톨로지 담당이 파서·순위 구현을 별도로 고친 것은 아닙니다.

- 읽기 전용 공통 캐시: `/Users/bueno/Documents/Codex/d1-artifacts-20261127/rebuilt/dongguk-rule-mcp/v2/public`
- corpus SHA-256: `59c2e11fe66e57af1ad2e88d732b12e42233ec1446e9a9d43784754e464dcb15`, contentVersion 4
- 의미 색인 메타데이터: `semantic/semantic-v1.json`, TEXT 3
- 벡터: `semantic/semantic-v1.c76feb89f199072fecf644f59f1c880519595276b8ec3af54f7a539388da2f7e.bin`, 9,790조문·11,422벡터
- 동국규정팀/t10x의 공개 기준선 v3: 의미검색 off/on 각각 strict 70/71(train 46/46, dev 24/25), top3 70/71, 조건부 조문 70/70. 기존 H21 미정답 유지. 담당 결과를 인용한 값이며 온톨로지 모듈의 새 실측 정답률이 아닙니다.

모듈 동작 보존과 strict 정답률은 별도 지표입니다. 같은 공통 코드·색인을 넣은 기존 사전/자료 이전 사전의 문항별 결과·순위·조문 차이를 확인하고, 통합 단계에서는 off/on 등 조건별 신규 오답·악화 문항을 모두 기록합니다. 기존 공개셋 포화 때문에 단순 총점 상승만으로 효과를 판단하지 않습니다. 보류셋·v4~v6는 사용하지 않습니다.

RRF/JEV 그래프 통합은 큰 규정→시행세칙·내규의 하향에만 가점하고 상향·하향·무가점 효과를 나눠 측정합니다. 온톨로지 자체는 그래프 점수를 계산하지 않습니다. 다른 담당자의 파서 재생성·임베딩 빌드·정답률 기준선 측정을 중복 실행하지 않습니다.

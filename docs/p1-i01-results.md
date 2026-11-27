# P1 I01 — HTML 본문 보존과 content-v4 계약 분리 적용

main의 `article_none` 본문·`hang_none` 계속 문장 누락을 고치고 승인 content-v4를 읽도록 맞춘다. 원격 main `d08ef02`에서 시작해 D1의 파서·캐시 이행만 가져왔다. **의미검색 구현·벡터 처리·순위 코드·RANKING 기본값은 추가하지 않았다.**

## 변경과 캐시 계약

- article_none·hang_none·ho_none·mok_none·dann·dann_none·addendacontent_none을 순서대로 보존한다. 실제 빈 조문·삭제 표시·부칙 경계를 유지한다.
- **옛 content-v3 명시적 무효화**: v3를 읽거나 v4로 복사하지 않는다. 파일은 보존한다. 유효한 v4가 있으면 읽고, 없거나 만료됐으면 원문 HTML을 다시 파싱해 v4에 저장한다. 조회 실패 시 v3로 조용히 폴백하지 않는다.
- corpus에 contentVersion4를 기록한다. 이전 버전/버전 없는 색인은 검색에 쓰지 않으며 같은 연혁이어도 조문을 재사용하지 않는다. 구 색인은 규정 수 급감 방지용으로만 읽는다.
- 자동 갱신이 설정된 HTTP 서버는 수신 직후 비동기 갱신을 시작한다. 실패해도 서버는 유지되고 주기 재시도한다. 수동 이행은 `--build-index` → `/status` 확인이며 stdio는 직접 빌드해야 한다.
- 레드팀 합성 입력을 test/fixtures/content-parser-i01.html에 담았다. D1 파서/캐시 테스트와 기동 갱신 테스트를 npm test에 추가했다. 기존13개 테스트/벤치 파일의 합성 캐시 경로만 v3→v4로 바꿨고 검증 조건은 유지했다.

## 로컬 테스트

| 조건 | 커밋 | 전체 npm test 명령 통과 / 실패 | 시간 |
|---|---|---:|---:|
| main 전 | `d08ef02c10ae33c237a83c335afeccdeaf993a64` | 51 / 0 | 69.111초 |
| PR 후 | `246a9ff5d2ebadb8e7422e7c8b1cd81d5fc3a589` | 53 / 0 | 71.105초 |

위 수는 npm test에 연결된 실행 명령 수이며 assert 호출 수가 아니다. 추가된 파서·캐시 이행 테스트는19개 검사, 기동 갱신은 실제 HTTP 프로세스 통합 시나리오1개다.

첫 전체 실행은 옛 v3 경로에 넣은 기존 신뢰성 테스트 입력 때문에 중단됐다. 해당 입력 경로만 새 계약에 맞추고 전체를 다시 실행해53명령 모두 통과했다. 첫 실패 로그도 보존했다. 레드팀 I01 동일 입력은 main에서 본문·계속 문장 둘 다 누락, PR에서 둘 다 보존됨을 별도로 확인했다.

## 표준 하네스 전후 비교

- 원본 표준 harness-d1.js + run2.sh, 질문만(빈 NL_KW), 같은 승인 캐시의 별도 복사본. 전후 각각339문항1회 실행했다. content-v3 별칭이나 호환 복사는 하지 않았다.
- train/dev71은 공개251의 부분집합이다. 전체339는 공개251+probe9 36+dev_open4판20+scope12v2 11+scope22v2 21이며, 서로 다른 세트의 유사 질문은 독립 검증 표본이 아니다. 결과 키는 세트:ID다.
- 실측 PR 커밋은 `3fcf23a262c4fd98131c8da92f9594d2c304db81`. 이후246a9ff는 테스트 입력 경로만 바뀌었고 제품 소스가 같음을 확인했다. 결과 문서 커밋도 제품 코드를 바꾸지 않는다.
- 29bbf66 legacy는 같은 하네스·같은 최신 정답표로 앞서 기록한339원응답을 참고로 재채점했다. 이번 구현과 달리 의미검색이 실제339건에 적용된 조건이며 동등 기능 대조라고 주장하지 않는다.

표의 값은 **엄격 정답 / 정답 규정 상위3 / 정답 규정1위**이며 분모는 문항 수다. 조문 표제 포함 수는 이 측정에서 엄격 정답 수와 모두 같았다.

| 셋 | 문항 수 | main 전 | PR 후 | 참고29bbf66 legacy |
|---|---:|---|---|---|
| train/dev71 | 71 | 68 / 68 / 60 | 70 / 70 / 62 | 70 / 70 / 61 |
| 공개251 | 251 | 226 / 232 / 200 | 229 / 235 / 203 | 239 / 242 / 214 |
| probe9 | 36 | 14 / 15 / 13 | 25 / 30 / 23 | 29 / 32 / 28 |
| dev_open_v4 | 20 | 7 / 9 / 9 | 16 / 19 / 17 | 19 / 20 / 20 |
| scope12v2 | 11 | 1 / 1 / 0 | 6 / 6 / 4 | 6 / 6 / 5 |
| scope22v2 | 21 | 2 / 2 / 2 | 5 / 5 / 5 | 5 / 5 / 5 |
| 전체339 | 339 | 250 / 259 / 224 | 281 / 295 / 252 | 298 / 305 / 272 |

**전후 전체 엄격250→281(+31), 상위3 259→295(+36), 1위224→252(+28), INTERNAL_ERROR48→0. 신규 오답은 세 지표 모두0건이다.** train/dev71 엄격68→70, 상위3 68→70, 1위60→62다.

전후 본문을 이미 읽던291문항은 채점·검색 메타데이터·규정 순서·발췌 내용이 동일하다. 기존 실행 오류48건 중31건이 엄격 정답으로 회복되고17건은 검색/발췌 실패로 남는다. 최종 실패58건은 규정 선택44·조문 선택/발췌14건이다.

### main 대비 신규 오답·새 정답 전수

- 엄격 신규 오답(0): 없음
- 엄격 새 정답(31): dev:H03, dev:H15, probe1:P22, probe9:Y05, probe9:Y09, probe9:Y10, probe9:Y13, probe9:Y17, probe9:Y18, probe9:Y19, probe9:Y21, probe9:Y33, probe9:Y34, probe9:Y35, dev_open:RT01, dev_open:RT04, dev_open:RT06, dev_open:RT07, dev_open:RT08, dev_open:RT14, dev_open:RT19, dev_open:RT26, dev_open:RT40, scope12v2:K07, scope12v2:K08, scope12v2:K09, scope12v2:K11, scope12v2:K12, scope22v2:Z134, scope22v2:Z141, scope22v2:Z142
- 규정 상위3 신규 오답(0): 없음
- 규정 상위3 새 정답(36): dev:H03, dev:H15, probe1:P22, probe9:Y05, probe9:Y09, probe9:Y10, probe9:Y11, probe9:Y12, probe9:Y13, probe9:Y14, probe9:Y17, probe9:Y18, probe9:Y19, probe9:Y21, probe9:Y33, probe9:Y34, probe9:Y35, probe9:Y36, dev_open:RT01, dev_open:RT04, dev_open:RT06, dev_open:RT07, dev_open:RT08, dev_open:RT14, dev_open:RT19, dev_open:RT26, dev_open:RT30, dev_open:RT40, scope12v2:K07, scope12v2:K08, scope12v2:K09, scope12v2:K11, scope12v2:K12, scope22v2:Z134, scope22v2:Z141, scope22v2:Z142
- 규정1위 신규 오답(0): 없음
- 규정1위 새 정답(28): dev:H03, dev:H15, probe1:P22, probe9:Y05, probe9:Y09, probe9:Y10, probe9:Y13, probe9:Y14, probe9:Y17, probe9:Y19, probe9:Y34, probe9:Y35, probe9:Y36, dev_open:RT01, dev_open:RT04, dev_open:RT06, dev_open:RT07, dev_open:RT08, dev_open:RT14, dev_open:RT30, dev_open:RT40, scope12v2:K07, scope12v2:K08, scope12v2:K09, scope12v2:K11, scope22v2:Z134, scope22v2:Z141, scope22v2:Z142

### 참고29bbf66 대비 문항별 차이 전수

main 대비 회귀와 구분한다. 아래 차이는 의미검색 유무 등을 포함하며 I01 코드가 새로 만든 악화라는 뜻이 아니다.

- 엄격 정답→오답(19): probe1:P11, probe2:Q06, probe3:R19, probe3:R21, probe4:S03, probe5:U19, probe6:V07, probe7:W04, probe7:W06, probe7:W14, probe8:X02, probe9:Y06, probe9:Y11, probe9:Y12, probe9:Y25, probe9:Y32, dev_open:RT13, dev_open:RT22, dev_open:RT30
- 엄격 오답→정답(2): probe1:P10, probe9:Y31
- 규정 상위3 정답→오답(11): probe2:Q06, probe3:R19, probe3:R21, probe5:U19, probe6:V07, probe7:W04, probe7:W14, probe8:X02, probe9:Y06, probe9:Y25, dev_open:RT13
- 규정 상위3 오답→정답(1): probe1:P10
- 규정1위 정답→오답(26): train:A14, dev:H25, probe1:P04, probe1:P26, probe1:P27, probe2:Q14, probe2:Q22, probe3:R13, probe3:R21, probe4:S19, probe5:U07, probe6:V07, probe7:W04, probe7:W09, probe7:W14, probe8:X06, probe8:X08, probe9:Y12, probe9:Y18, probe9:Y21, probe9:Y26, probe9:Y30, dev_open:RT13, dev_open:RT19, dev_open:RT26, scope12v2:K10
- 규정1위 오답→정답(6): train:A24, dev:H06, dev:H23, probe2:Q13, probe3:R01, probe4:S02

## 입력 무결성과 재현

- 기준 main: `d08ef02c10ae33c237a83c335afeccdeaf993a64`
- core manifest: `dbc6d1faa9b83f08e80784b1ff53b7b76708ebc0e5f20266230b0b452ae219e7`
- aux manifest: `cc3c9fd1c09456c928d6444188b83e246941ec06756a0cbffe92e15fb52b6bf0`
- corpus: `830b69968e8f212450a9f152b890d6c78a4724d56d4b0a4e9b41caa18bdbd227`
- 캐시에 포함된 벡터 파일: `semantic-v1.fd7d662bb55c82f6d45f102866bc8e8837b046fdf7ac5658830c217a34de5def.bin` (전후 코드에서 사용하지 않음)
- 벡터 SHA-256: `fd7d662bb55c82f6d45f102866bc8e8837b046fdf7ac5658830c217a34de5def`
- 표준 harness-d1.js SHA-256: `c24eb47a2515f29f9486f78a86c22680ce9f31990adc376db9ae3a6b8e799792`
- 표준 run2.sh SHA-256: `eae9b6bfbcb29ae018cc7a0591cdda0bfed7f851be2e085210a61d11fdab9602`
- dev_open4판: c52c81e2909b1b2790d0076fa90858f46bc66ae43db882d539dca8fb8f7e6006
- scope12v2: f4f78539e9f8754e2c5654dde243d6c35720e392e7784bd8c29d3b44a07d65fb
- scope22v2: 6ece263e3ccde1192cf6a8b9aeb44250f8d6cc4cc75e0fda09fef62f52e0e35a
- 공유 core733파일·aux673파일 및 manifest 전후해시 불변. 각 조건의 core 복사본도733파일 전수일치. 전후 캐시에 content-v3 디렉터리가 없는 것을 확인했다. box-kit 읽기·쓰기 없음.
- 전후678응답과 참고339응답, 총1017원응답 재채점 일치. 실제 인자 전부 질문만, 의미검색 사용 전후0건. 기존 main 원측정339응답과 전 조건 재현 동일.

재현(공유 캐시 대신 새 산출물 폴더 사용):

```sh
cd /Users/bueno/Documents/Codex/dongguk-rule-main-d08ef02
npm test
cd /Users/bueno/Documents/Codex/dongguk-rule-p1-i01
npm test
cd /Users/bueno/Documents/Codex/p1-i01-artifacts-20261127
python3 prepare.py
zsh run.sh before
zsh run.sh after
node compare.js
```

이미 실행한 결과는 덮어쓰지 않는다. 재현할 때 prepare.py/preload.js/run.sh/compare.js를 새 빈 산출물 폴더에 복사해 실행한다. prepare.py는 승인733+보조catalog/search를 두 조건에 복사하며 기존 준비 폴더가 있으면 중단한다. run.sh는 원본 run2.sh에 NL_SETS 전체 공개셋, NL_KW 빈 객체, 오프라인·고정 캐시 경로를 전달한다. 모델 환경값은 참고와 조건을 통일하려 남겨 두었으나 전후 제품에는 의미검색 모듈 자체가 없다.

근거 파일은 `/Users/bueno/Documents/Codex/p1-i01-artifacts-20261127/`에 있다: npm-before/after.log·json, i01-repro-before-after.json, before/after-results.json(원응답), comparison.json(셋별·문항별 전수), input-manifest.json, scope-audit.json.

## 남은 한계

- 승인된 D1 고정 본문/색인을 사용하는 측정이므로 +31건은 캐시 계약이 맞아 본문을 읽게 된 개선이다. 새 파서로 실제 전체 규정을 재수집했을 때의 검색 효과를 따로 입증한 것은 아니다. 파서 본문 복구 자체는 정확히 같은 레드팀 합성 입력과19개 회귀로 검증했다.
- 최종58건의 규정·조문 선택 실패는 남는다. 의미검색·캠퍼스 순위·동의어 개선은 별도 PR의 범위다. 참고29bbf66 엄격298/339에 이 PR은281/339로17건 못 미친다.
- 이전 파서 corpus가 거부된 뒤 재생성 전까지 공식 사이트 조회로 폴백하며, 원문 서버가 불가용하면 실패할 수 있다. v3로 되돌리는 자동 폴백은 하지 않는다.
- 지연은 대기 생략·오프라인 고정 응답이 있는 표준 하네스 값으로 운영 성능을 뜻하지 않는다. 학습·가중치 조정·비공개 문항 접근 없음.
- main 병합·릴리스·배포·강제 push·공유 캐시 변경 없음. t3z·t10m에 연락하지 않았다.

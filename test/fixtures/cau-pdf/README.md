# 중앙대 PDF 경계 회귀 fixture

PR #35 레드팀의 2026-11-25 합성 PDF 반례 7종을 그대로 보관합니다.
실제 중앙대 규정이 아니며, 한국어 ToUnicode 매핑을 가진 로컬 생성 텍스트 레이어 PDF입니다.
`test/test-cau-pdf.js`가 실제 PDF worker → 중앙대 어댑터 → 비교 결과를 검증합니다.

- `recognized-appendix`: 기존 [별표 1] 대조군
- `unrecognized-brackets`, `unrecognized-appendix`, `unrecognized-form`: 〔별표 1〕·〔부록 1〕·[서식 1] 이후 제99조·999원을 비교에서 제외
- `appendix-mention-in-body`: 별표 1에 따른 본문 및 후속 제2조 보존
- `wrapped-article-citation`, `inline-article-citation`: 줄바꿈 유무와 관계없이 제9조 인용을 제1조 본문에 보존

PR #35 r2에서 추가된 원본 PDF 3종도 그대로 보관합니다.

- `spaced-article-reference`, `spaced-possessive-reference`: 닫는 괄호 뒤 ` 에서 정한 기준`·` 의 지급 기준`을 제1조에 보존
- `unspaced-reference-control`: 공백 없는 `에서 정한 기준` 대조군

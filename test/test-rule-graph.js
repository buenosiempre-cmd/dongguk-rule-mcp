'use strict';
// Newly written synthetic rules only; no held-out questions or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildRuleGraph, saveRuleGraph, loadRuleGraph, rankRelatedRules, getRelatedArticles } = require('../src/rule-graph.js');
const block = (n, text, supplementary = false) => ({ article: `제${n}조`, content: `### 제${n}조(시험) ${text}`, supplementary });
const rule = (lawId, title, blocks, scope = '서울') => ({ lawId, historyId: lawId * 10, title, blocks, scope });
const corpus = { rules: [
  rule(1, '실험관리규정', [block(1, '실험을 관리한다.'), block(2, '「실험관리규정 시행세칙」 제3조를 준용한다.'), block(3, '제1조에 따라 별표 2를 적용한다.'), block(4, '「근로기준법」 제1조에 따른다.'), block(5, '제2조의2 및 제99조를 적용한다.'), { article: '제2조의2', content: '### 제2조의2(예외) 제1조를 준용한다.' }, block(1, '「다른규정」을 따른다.', true)]),
  rule(2, '실험관리규정 시행세칙', [block(1, '이 세칙은 「실험관리규정」 제1조에 따라 시행에 필요한 사항을 정한다.'), block(3, '세부 신청서는 담당 부서에 낸다.')]),
  rule(3, '동명규정', [block(1, '서울 기준')]),
  rule(4, '동명규정', [block(1, 'WISE 기준')], 'WISE'),
  rule(5, '기타규정', [block(1, '「동명규정」 제1조를 적용한다.'), block(2, '알수없는내규 제1조를 적용한다.'), block(3, '「실험관리규정」 제99조를 준용한다.')]),
  rule(6, '외부참조규정', [block(1, '「실험관리규정」 제1조 및 제2조를 적용한다.')], 'WISE'),
] };
const histories = { 1: [{ historyId: 9, revisedAt: '2025.01.01' }, { historyId: 10, revisedAt: '2026.01.01' }, { historyId: 9, revisedAt: '2025.01.01' }, { historyId: 11, revisedAt: '2026.02.30' }] };
const graph = buildRuleGraph(corpus, { histories });
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`); }
const edges = (from, type) => graph.edges.filter(edge => edge.from === from && (!type || edge.type === type));

check('명시적 시행 문구: 하위 규정에서 상위 규정으로 연결', () => assert.equal(edges('r:2', 'implements')[0].to, 'r:1'));
check('단순 인용은 위계로 승격하지 않음', () => assert.equal(edges('r:6', 'implements').length, 0));
check('규정명 접두 일치만으로 위계를 추측하지 않음', () => {
  const g = buildRuleGraph({ rules: [rule(1, '표본규정', []), rule(2, '표본규정 시행세칙', [])] });
  assert.equal(g.edges.length, 0);
});
check('준용과 자체 조문 인용 및 가지번호', () => {
  assert.equal(edges('a:1:1', 'applies')[0].to, 'a:2:1');
  assert.equal(edges('a:1:2', 'cites')[0].to, 'a:1:0');
  assert.equal(edges('a:1:4', 'cites')[0].to, 'a:1:5');
});
check('별표 참조는 본문이 확인되지 않은 노드로 구별', () => {
  assert.equal(edges('a:1:2', 'appendix')[0].to, 'p:1:별표2');
  assert.equal(graph.nodes.find(n => n.kind === 'appendix').available, false);
});
check('외부 법령·미지의 규정·동명 규정·없는 조문은 내부 조문으로 연결하지 않음', () => {
  assert.equal(edges('a:1:3').length, 0);
  for (const i of [0, 1, 2]) assert.equal(edges(`a:5:${i}`).length, 0);
  assert(graph.unresolved.some(item => item.reason === 'ambiguous_title'));
  assert(graph.unresolved.some(item => item.target === '제99조'));
});
check('부칙의 재시작 조문 번호는 본문으로 연결하지 않음', () => assert(!graph.nodes.some(n => n.id === 'a:1:6')));
check('복수 외부 조문 목록은 같은 외부 규정에 연결', () => assert.deepEqual(edges('a:6:0').map(e => e.to), ['a:1:0', 'a:1:1']));
check('이력은 개정일 순서, 중복 및 잘못된 날짜 제외', () => {
  const e = graph.edges.filter(e => e.type === 'revises');
  assert.equal(e.length, 1); assert.equal(e[0].from, 'v:1:10'); assert.equal(e[0].to, 'v:1:9');
});
check('같은 개정일은 선후 관계를 추측하지 않음', () => {
  const g = buildRuleGraph(corpus, { histories: { 1: [{ historyId: 8, revisedAt: '2025.01.01' }, { historyId: 9, revisedAt: '2025.01.01' }, { historyId: 10, revisedAt: '2026.01.01' }] } });
  assert(!g.edges.some(e => e.type === 'revises'));
});
check('상위 규정 후보에서 작은 하위 규정을 끌어옴', () => assert.equal(rankRelatedRules(graph, [1])[0].lawId, 2));
check('관련 조문은 원본 색인의 위치와 출처 문구 제공', () => {
  const hit = getRelatedArticles(graph, [{ lawId: 1, article: '제2조' }]).find(hit => hit.lawId === 2);
  assert.equal(hit.blockIndex, 1); assert.equal(hit.article, '제3조'); assert(hit.evidence.text.includes('준용'));
});
check('명시적 범위 필터와 0개 제한', () => {
  assert(!rankRelatedRules(graph, [1], { scope: '서울' }).some(hit => hit.lawId === 6));
  assert.equal(rankRelatedRules(graph, [1], { scope: 'WISE' }).length, 0);
  assert.deepEqual(getRelatedArticles(graph, [1], { limit: 0 }), []);
});
check('중복 seed나 반복 인용으로 점수가 부풀지 않음', () => {
  assert.deepEqual(rankRelatedRules(graph, [1, 1]), rankRelatedRules(graph, [1]));
  const once = { rules: [rule(1, '원천규정', [block(1, '「대상규정」 제1조에 따른다.')]), rule(2, '대상규정', [block(1, '내용')])] };
  const many = structuredClone(once); many.rules[0].blocks.push(block(2, '「대상규정」 제1조에 따른다.'));
  assert.equal(rankRelatedRules(buildRuleGraph(once), [1])[0].score, rankRelatedRules(buildRuleGraph(many), [1])[0].score);
});
check('없는 색인·깨진 그래프는 빈 보조 후보로 폴백', () => {
  for (const bad of [null, {}, { version: 1, corpusSignature: 'x', nodes: [], edges: [{}] }]) {
    assert.deepEqual(rankRelatedRules(bad, [1]), []); assert.deepEqual(getRelatedArticles(bad, [1]), []);
  }
});
check('동일 조문 번호가 중복되면 연결하지 않음', () => {
  const g = buildRuleGraph({ rules: [rule(1, '중복시험규정', [block(1, '가'), block(1, '나'), block(2, '제1조를 따른다.')])] });
  assert.equal(g.edges.length, 0);
});
check('줄바꿈된 외부 인용과 이름 접미 일치는 내부 조문으로 오연결하지 않음', () => {
  const g = buildRuleGraph({ rules: [rule(1, '원천규정', [block(1, '「외부법」\n제2조에 따른다.'), block(2, '외부기관시험규정 제2조에 따른다.')]), rule(2, '시험규정', [block(2, '내용')])] });
  assert.equal(g.edges.length, 0);
});
check('띄어 쓴 캠퍼스·기관 한정자를 떼고 다른 규정에 연결하지 않음', () => {
  for (const prefix of ['WISE캠퍼스 ', '외부기관 ', '외부기관\n']) {
    const g = buildRuleGraph({ rules: [rule(1, '원천규정', [block(1, `${prefix}시험규정 제2조에 따른다.`)]), rule(2, '시험규정', [block(2, '내용')])] });
    assert.equal(g.edges.length, 0);
  }
});
check('완전한 무인용부호 이름은 연결하고 부정 준용은 단순 인용으로 구별', () => {
  const g = buildRuleGraph({ rules: [rule(1, '원천규정', [block(1, '시험규정 제2조를 준용하지 아니한다.')]), rule(2, '시험규정', [block(2, '내용')])] });
  assert.equal(g.edges.length, 1); assert.equal(g.edges[0].type, 'cites');
});
check('의거하여: 낫표 유무와 무관하게 명시적 위계를 연결', () => {
  for (const name of ['시험규정', '「시험규정」']) {
    const g = buildRuleGraph({ rules: [rule(1, '시행세칙', [block(1, `이 규정은 ${name} 제2조에 의거하여 세부사항을 정한다.`)]), rule(2, '시험규정', [block(2, '내용')])] });
    assert(g.edges.some(e => e.from === 'r:1' && e.to === 'r:2' && e.type === 'implements'));
    assert(g.edges.some(e => e.to === 'a:2:0' && e.evidence.text.includes('의거하여')));
  }
});
check('주어·접속어·문장부호 뒤 무낫표 이름을 연결', () => {
  for (const prefix of ['이 규정은 ', '이 내규는 ', '본 시행세칙은\n', '담당자는 ', '직원은 ', '업무처리에는 ', '심의하기 위하여 ', '기준 및 ', '기준 또는 ', '적용 근거: ', '선택 사항; ', '가, ', '① 이 규정은 ']) {
    const g = buildRuleGraph({ rules: [rule(1, '원천규정', [block(1, `${prefix}시험규정 제2조를 따른다.`)]), rule(2, '시험규정', [block(2, '내용')])] });
    assert.equal(g.edges.filter(e => e.to === 'a:2:0').length, 1, prefix);
  }
});
check('문장 중간에서도 기관·캠퍼스 한정자와 붙어 쓴 접속어를 보존', () => {
  for (const prefix of ['이 규정은 WISE캠퍼스 ', '이 내규는 외부기관\n', '기준 및 WISE캠퍼스 ', '근거: 외부기관 ', '기관및 ', '외부기관시험규정 및 WISE캠퍼스 ']) {
    const g = buildRuleGraph({ rules: [rule(1, '원천규정', [block(1, `${prefix}시험규정 제2조에 의거하여 세부사항을 정한다.`)]), rule(2, '시험규정', [block(2, '내용')])] });
    assert.equal(g.edges.length, 0, prefix);
  }
});
check('같은 문장의 유효 인용이 앞선 기관 한정 인용을 대신 정당화하지 않음', () => {
  const g = buildRuleGraph({ rules: [rule(1, '원천규정', [block(1, 'WISE캠퍼스 시험규정 제2조 및 시험규정 제3조를 따른다.')]), rule(2, '시험규정', [block(2, '가'), block(3, '나')])] });
  assert.deepEqual(g.edges.filter(e => e.type === 'cites').map(e => e.to), ['a:2:1']);
  assert(g.unresolved.some(item => item.reason === 'incomplete_title_match'));
});
check('완전한 기관 한정 규정명이 목록에 있으면 그 규정만 연결', () => {
  const g = buildRuleGraph({ rules: [rule(1, '원천규정', [block(1, '이 규정은 WISE캠퍼스 시험규정 제2조를 따른다.')]), rule(2, '시험규정', [block(2, '가')]), rule(3, 'WISE캠퍼스 시험규정', [block(2, '나')])] });
  assert.deepEqual(g.edges.map(e => e.to), ['a:3:0']);
});
check('거부한 외부 이름은 지침·요령 등 명칭과 무관하게 자체 조문으로 재해석하지 않음', () => {
  for (const name of ['시험지침', '시험요령', '시험기준']) {
    const g = buildRuleGraph({ rules: [rule(1, '원천규정', [block(1, `WISE캠퍼스 ${name} 제2조에 따른다.`), block(2, '자체 조문')]), rule(2, name, [block(2, '대상 조문')])] });
    assert.equal(g.edges.length, 0, name);
    assert(g.unresolved.some(item => item.reason === 'incomplete_title_match'));
  }
});
check('같은 규정의 복수 seed 조문을 모두 확장', () => {
  const g = buildRuleGraph({ rules: [rule(1, '복수규정', [block(1, '제2조를 따른다.'), block(2, '가'), block(3, '제4조를 따른다.'), block(4, '나')])] });
  assert.deepEqual(getRelatedArticles(g, [{ lawId: 1, article: '제1조' }, { lawId: 1, article: '제3조' }]).map(hit => hit.article), ['제2조', '제4조']);
  assert.deepEqual(getRelatedArticles(g, [{ lawId: 1, article: '잘못된번호' }]), []);
});
check('입력은 변경하지 않고 결정론적으로 추출', () => {
  const before = JSON.stringify(corpus);
  assert.deepEqual(graph, buildRuleGraph(corpus, { histories }));
  assert.equal(JSON.stringify(corpus), before);
  assert.throws(() => buildRuleGraph({ rules: [corpus.rules[0], corpus.rules[0]] }));
});

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-graph-test-'));
try {
  check('저장·재조회 및 원문 변경 시 기존 색인 거부', () => {
    assert.equal(loadRuleGraph(folder, corpus), null);
    saveRuleGraph(folder, graph);
    assert.deepEqual(loadRuleGraph(folder, corpus), graph);
    const changed = structuredClone(corpus); changed.rules[0].blocks[0].content += '개정';
    assert.equal(loadRuleGraph(folder, changed), null);
  });
  check('교체 실패 시 기존 그래프 보존 및 임시 파일 정리', () => {
    saveRuleGraph(folder, graph);
    const rename = fs.renameSync;
    try {
      fs.renameSync = () => { throw new Error('합성 교체 실패'); };
      assert.throws(() => saveRuleGraph(folder, graph), /합성 교체 실패/);
    } finally { fs.renameSync = rename; }
    assert.deepEqual(loadRuleGraph(folder, corpus), graph);
    assert.equal(fs.readdirSync(path.join(folder, 'graph')).length, 1);
  });
  check('명시적 파일 입력 CLI는 생성 후 재조회 건수를 보고', () => {
    const { spawnSync } = require('node:child_process');
    const input = path.join(folder, 'corpus.json');
    fs.writeFileSync(input, JSON.stringify(corpus));
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/build-rule-graph.js'), input, folder], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.원본규정수, report.그래프규정수);
    assert.equal(report.재조회, '일치');
  });
  check('손상 파일 및 체크섬이 맞아도 조문 위치 범위 오류는 폴백', () => {
    const file = saveRuleGraph(folder, graph);
    fs.writeFileSync(file, '{broken'); assert.equal(loadRuleGraph(folder, corpus), null);
    const broken = structuredClone(graph); broken.nodes.find(n => n.kind === 'article').blockIndex = 999;
    const checksum = crypto.createHash('sha256').update(JSON.stringify(broken)).digest('hex');
    fs.writeFileSync(file, JSON.stringify({ checksum, graph: broken }));
    assert.equal(loadRuleGraph(folder, corpus), null);
  });
  check('이전 추출 규칙으로 만든 v1 그래프를 재사용하지 않음', () => {
    const file = saveRuleGraph(folder, graph);
    const old = { ...graph, version: 1 };
    const checksum = crypto.createHash('sha256').update(JSON.stringify(old)).digest('hex');
    fs.writeFileSync(file, JSON.stringify({ checksum, graph: old }));
    assert.equal(loadRuleGraph(folder, corpus), null);
    assert.deepEqual(rankRelatedRules(old, [1]), []);
  });
  check('구조 측정 CLI는 본문 해시와 원본 대비 규정·조문 수를 보고', () => {
    const { spawnSync } = require('node:child_process');
    const input = path.join(folder, 'corpus.json');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/measure-rule-graph.js'), input], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sourceRules, report.graphRules);
    assert.equal(report.sourceMainBlocks, report.graphArticles);
    assert.match(report.corpusSHA256, /^[a-f0-9]{64}$/);
  });
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
console.log(`\n규칙 그래프 ${passed}개 검사 통과`);

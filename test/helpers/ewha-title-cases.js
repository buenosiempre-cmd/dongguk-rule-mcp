'use strict';
const { createHash } = require('node:crypto');
const positives = require('../fixtures/ewha-academic-positive.json').rows;
const cases = [];
for (const [i, row] of positives.entries()) for (const withFallback of [false, true]) {
  cases.push({ id: `positive-${i}-${withFallback}`, ...row, withFallback });
}
const topics = [...new Set(positives.map(x => x.topic))];
for (const topic of topics) for (let count = 1; count <= 4; count++) for (let limit = 1; limit <= 5; limit++) {
  cases.push({ id: `ranking-${topic}-${count}-${limit}`, topic, body: `${topic}을 허가한다.`, count, limit, withFallback: true });
}
for (const topic of topics) for (const mode of ['fail', 'malformed', 'unrelated']) {
  cases.push({ id: `title-${topic}-${mode}`, topic, body: '교육의 목적을 정한다.', mode, withFallback: true });
}
for (const titleOnly of [false, true]) for (const maxRules of [1, 5]) {
  cases.push({ id: `loader-${titleOnly}-${maxRules}`, topic: '휴학', body: '학생은 휴학한다.', count: 6, withFallback: true, loader: true, titleOnly, maxRules });
}
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
async function run(m, c) {
  const { topic, body, count = 1, limit = 3, withFallback, mode } = c;
  const titles = Array.from({ length: count }, (_, i) => `<a href="?mode=view-rule&srRuleCd1=994&srRuleCd2=${10+i}">${topic}규정 ${i}</a>`).join('');
  const catalog = titles + (withFallback ? '<a href="?mode=view-rule&srRuleCd1=994&srRuleCd2=1009">학칙</a>' : '');
  const calls = [];
  const client = { request: async (source, requestPath) => {
    calls.push(requestPath);
    if (!requestPath.includes('mode=view-rule')) return catalog;
    const fallback = requestPath.endsWith('=1009');
    if (!fallback && mode === 'fail') throw Object.assign(new Error('fixture'), { code: 'UPSTREAM_UNAVAILABLE' });
    if (!fallback && mode === 'malformed') return '<div class="fr-view">본문 미제공</div>';
    return `<div class="fr-view"><p>제${fallback ? 40 : 1}조(${fallback ? topic : '기준'})</p><p>${fallback ? topic+'을 허가한다.' : body}</p></div>`;
  } };
  if (c.loader) {
    const spec = { ...m.expandTopic(topic), titleOnly: c.titleOnly, maxRules: c.maxRules };
    const data = await m.loadExternal(m.SOURCES.find(x => x.key === 'ewha'), topic, spec.terms, client, undefined, spec);
    return { data, formatted: null, calls };
  }
  const data = await m.compareUniversityRules({ topic, universities: ['ewha'], max_articles: limit }, {
    client, now: () => new Date('2026-11-27T00:00:00.000Z'),
    loadDongguk: async () => ({ rules: [], failures: [], coverage: { complete: false } }),
  });
  return { data, formatted: m.formatComparison(data), calls };
}
module.exports = { cases, run, hash };

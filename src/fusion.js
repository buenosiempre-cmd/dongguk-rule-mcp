'use strict';

// The one place where the signals of a question are combined into an order of rule candidates:
// words (the full-text index), meaning (article embeddings), place and audience (the ontology),
// and, when a caller supplies them, graph relations or a relevance probability. Every signal
// except the words is optional; a missing one is left out of the combination.
//
// Methods (DONGGUK_MCP_RANKING):
// - legacy  the order used before this module: word score lifted by meaning, rules written for
//           the asked campus or institution first and, when any exist, alone.
// - hybrid  the same scores, with place read from the ontology: a rule for the asked place
//           counts for more, one for another place for less, and a university-wide rule is kept.
//           A rule whose articles are about another class of people than the question counts
//           for less.
//           Graph relations, when a caller passes them, lift a related rule a little.
// - rrf     reciprocal rank fusion of the word, meaning, place and graph rankings.
// - jev     a relevance probability per rule, when the caller supplies one; hybrid otherwise.
const { placeRequest, placeAgreement } = require('./ontology');

const METHODS = ['legacy', 'hybrid', 'rrf', 'jev'];
const DEFAULT_METHOD = 'legacy';
function rankingMethod(value = process.env.DONGGUK_MCP_RANKING) {
  const name = String(value || '').trim().toLowerCase();
  return METHODS.includes(name) ? name : DEFAULT_METHOD;
}

// Reciprocal rank fusion: sum over rankings of weight / (k + rank). Only ranks are used, so a
// word score and a cosine similarity never have to share a scale. A larger k flattens the
// difference between neighbouring ranks.
const RRF_K = 10;
const RRF_WEIGHTS = { words: 1, meaning: 0.6, place: 1, graph: 0.5 };
// Place has three tiers, not a ranking: the asked place, university-wide, another place.
const RRF_PLACE_TIER = 1;

// Ranks (1 = best) from scores, larger first. Equal scores share a rank.
function ranksOf(scores) {
  const ordered = [...scores].filter(([, score]) => Number.isFinite(score)).sort((a, b) => b[1] - a[1]);
  const ranks = new Map();
  let rank = 0, previous = null;
  ordered.forEach(([key, score], index) => {
    if (score !== previous) { rank = index + 1; previous = score; }
    ranks.set(key, rank);
  });
  return ranks;
}

// channels: [{ ranks: Map(key → rank), weight }] → Map(key → fused score) over every key that
// some channel ranks. A key a channel does not hold adds nothing for that channel.
function reciprocalRankFusion(channels, { k = RRF_K } = {}) {
  const fused = new Map();
  for (const { ranks, weight = 1 } of channels) {
    if (!ranks || !(weight > 0)) continue;
    for (const [key, rank] of ranks) {
      if (!(rank >= 1)) continue;
      fused.set(key, (fused.get(key) || 0) + weight / (k + rank));
    }
  }
  return fused;
}

// ── 판 선택 ────────────────────────────────────────────────────
// Campus and affiliate editions of one rule share a family. Before this module an edition
// matched when its prefix held the asked campus and any asked institution, and every rule that
// was not such an edition was dropped once one matched.
function legacyEditions(members, scope) {
  const matches = member => {
    const edition = member.edition || '';
    const campus = edition.startsWith('WISE캠퍼스') ? 'wise' : 'seoul';
    return (!scope.campuses.length || scope.campuses.includes(campus))
      && (!scope.institutions.length || scope.institutions.some(name => edition.includes(name)));
  };
  const matching = scope.specified ? members.filter(matches) : [];
  const selected = matching.length ? matching : members;
  return selected.map(member => ({
    ...member,
    scopeMatch: scope.specified ? matches(member) : null,
    scopeAmbiguous: scope.ambiguous || selected.length > 1,
    editions: members.filter(other => other !== member).map(other => ({ lawId: other.lawId, title: other.title, edition: other.edition, topArticle: other.topArticle })),
  }));
}

// With the ontology: the edition written for the asked place stands in for its family
// ("WISE캠퍼스 구매규정" for a WISE question). A family with no such edition keeps its
// university-wide rule, which still applies there; only an edition for a place the question
// leaves out is set aside.
function placedEditions(members, place) {
  const agreement = new Map(members.map(member => [member, placeAgreement(member.title, place)]));
  const best = Math.max(...agreement.values());
  const selected = best > 0 ? members.filter(member => agreement.get(member) === best)
    : members.some(member => agreement.get(member) === 0) ? members.filter(member => agreement.get(member) === 0) : members;
  return selected.map(member => ({
    ...member,
    // true: written for the asked place. false: written for another. null: no place asked, or a university-wide rule.
    scopeMatch: !place.specified || agreement.get(member) === 0 ? null : agreement.get(member) > 0,
    scopeAmbiguous: place.ambiguous || selected.length > 1,
    editions: members.filter(other => other !== member).map(other => ({ lawId: other.lawId, title: other.title, edition: other.edition, topArticle: other.topArticle })),
  }));
}

// ── 순서 ──────────────────────────────────────────────────────
// Results are the same from 1.2 to 2 and from 0.4 to 0.8 on the development questions.
const PLACE_MATCH_SHARE = 1.5;
const PLACE_MISMATCH_SHARE = 0.6;
// A rule whose articles keep naming another class of people (취업규칙 for a 교수 question).
// Rules that name the class in their title are already weighed by the word index.
const BODY_AUDIENCE_SHARE = 0.8;
// Comparison only: no caller passes graph relations by default.
const GRAPH_SHARE = 0.3;

const placeShare = hit => hit.scopeMatch === true ? PLACE_MATCH_SHARE : hit.scopeMatch === false ? PLACE_MISMATCH_SHARE : 1;
function audienceShare(hit, facets) {
  const asked = facets?.question?.subjects;
  const rule = facets?.ruleOf(hit.lawId);
  if (!rule || !Array.isArray(asked) || asked.length !== 1 || rule.subjects.length || !rule.bodySubject) return 1;
  return rule.bodySubject === asked[0] || facets.covers(rule.bodySubject, asked[0]) ? 1 : BODY_AUDIENCE_SHARE;
}
const byFamily = candidates => {
  const families = new Map();
  for (const candidate of candidates) {
    if (!families.has(candidate.family)) families.set(candidate.family, []);
    families.get(candidate.family).push(candidate);
  }
  return [...families.values()];
};
const scoresOf = signal => signal instanceof Map ? signal : null;

// Relations found by the rule graph (rule-graph.js rankRelatedRules) as scores for `graph`.
// down: only a rule that states it implements a leading candidate (학칙 → its 시행세칙). The
//       parent of a leading rule, or a rule it merely cites, is left out: those relations pull
//       towards the large, much-cited rules.
// all:  every relation, both directions.
// The evidence of a relation sits in the rule that wrote the citation; for "implements" that
// is the lower rule.
function relationScores(related, direction = 'down') {
  if (!Array.isArray(related) || !['down', 'all'].includes(direction)) return null;
  const kept = direction === 'all' ? related : related.filter(item => item?.relation === 'implements' && item.evidence?.lawId === item.lawId);
  const scores = new Map(kept.filter(item => Number.isSafeInteger(item?.lawId) && item.score > 0).map(item => [item.lawId, item.score]));
  return scores.size ? scores : null;
}

// Rule candidates of one question, in order.
// candidates: rules the word index found, each with { lawId, title, family, edition, score
//   (word score lifted by meaning), wordScore, semanticRuleRank }.
// scope:    the place the question asks for as read before this module (lookup.requestedRuleScope).
// query, campus: the question and the caller's campus argument, for the ontology's reading of place.
// facets:   createFacetSignal(...) of the ontology, or null.
// semantic: true when meaning ranks are present.
// graph, probability: Map(lawId → score) from a caller that has them, or null.
// Returns { method, ranked } where each ranked rule carries scopeMatch, scopeAmbiguous,
// editions, and `order` (larger is earlier). `method` is the one actually used.
function rankRules({ candidates, scope, query = '', campus = 'all', facets = null, semantic = false, graph = null, probability = null, method = rankingMethod() }) {
  let used = METHODS.includes(method) ? method : DEFAULT_METHOD;
  if (used === 'jev' && !scoresOf(probability)) used = 'hybrid';
  if (used === 'legacy') {
    let ranked = byFamily(candidates).flatMap(members => legacyEditions(members, scope)).map(hit => ({ ...hit, order: hit.score }))
      .sort((a, b) => Number(b.scopeMatch) - Number(a.scopeMatch) || b.score - a.score || a.lawId - b.lawId);
    // A specified, available scope must not be padded with unrelated editions.
    if (scope.specified && !scope.ambiguous && ranked.some(hit => hit.scopeMatch)) ranked = ranked.filter(hit => hit.scopeMatch);
    return { method: used, ranked };
  }
  const place = placeRequest(query, campus);
  const ranked = byFamily(candidates).flatMap(members => placedEditions(members, place));
  // Graph relations (when a caller supplies them) lift a related rule by up to GRAPH_SHARE,
  // in proportion to the strongest relation among the candidates.
  const relations = scoresOf(graph);
  const strongest = relations ? Math.max(0, ...ranked.map(hit => relations.get(hit.lawId) || 0)) : 0;
  const graphShare = hit => strongest > 0 ? 1 + GRAPH_SHARE * (relations.get(hit.lawId) || 0) / strongest : 1;
  const lifted = hit => hit.score * placeShare(hit) * audienceShare(hit, facets) * graphShare(hit);
  let order;
  if (used === 'jev') {
    const known = scoresOf(probability);
    order = hit => (known.has(hit.lawId) ? known.get(hit.lawId) : 0) * placeShare(hit);
  } else if (used === 'rrf' && semantic) {
    const tier = hit => hit.scopeMatch === true ? 1 : hit.scopeMatch === false ? 1 + 2 * RRF_PLACE_TIER : 1 + RRF_PLACE_TIER;
    const fused = reciprocalRankFusion([
      { ranks: ranksOf(ranked.map(hit => [hit, hit.wordScore * audienceShare(hit, facets)])), weight: RRF_WEIGHTS.words },
      { ranks: new Map(ranked.filter(hit => hit.semanticRuleRank).map(hit => [hit, hit.semanticRuleRank])), weight: RRF_WEIGHTS.meaning },
      { ranks: new Map(ranked.map(hit => [hit, tier(hit)])), weight: RRF_WEIGHTS.place },
      ...(relations ? [{ ranks: ranksOf(ranked.filter(hit => relations.get(hit.lawId) > 0).map(hit => [hit, relations.get(hit.lawId)])), weight: RRF_WEIGHTS.graph }] : []),
    ]);
    order = hit => fused.get(hit) || 0;
  } else {
    // hybrid, and rrf without meaning ranks (one ranking has nothing to fuse with).
    if (used === 'rrf') used = 'hybrid';
    order = lifted;
  }
  return { method: used, ranked: ranked.map(hit => ({ ...hit, order: order(hit) })).sort((a, b) => b.order - a.order || a.lawId - b.lawId) };
}

module.exports = { METHODS, DEFAULT_METHOD, RRF_K, rankingMethod, ranksOf, reciprocalRankFusion, relationScores, rankRules };

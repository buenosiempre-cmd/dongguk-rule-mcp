'use strict';

// The one place where rule candidates of a question are put in order and where the campus or
// institution edition of a rule is chosen.
//
// Methods (DONGGUK_MCP_RANKING):
// - legacy  the order used before this module: word score lifted by meaning, rules written for
//           the asked campus or institution first and, when any exist, alone.
// - hybrid  the same scores, with place read from the ontology: a rule for the asked place
//           counts for more, one for another place for less, and a university-wide rule is kept.
//           A rule whose articles are about another class of people than the question counts
//           for less.
const { placeRequest, placeAgreement } = require('./ontology');

const METHODS = ['legacy', 'hybrid'];
const DEFAULT_METHOD = 'hybrid';
function rankingMethod(value = process.env.DONGGUK_MCP_RANKING) {
  const name = String(value || '').trim().toLowerCase();
  return METHODS.includes(name) ? name : DEFAULT_METHOD;
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
// Rule candidates of one question, in order.
// candidates: rules the word index found, each with { lawId, title, family, edition, score
//   (word score lifted by meaning) }.
// scope:    the place the question asks for as read before this module (lookup.requestedRuleScope).
// query, campus: the question and the caller's campus argument, for the ontology's reading of place.
// facets:   createFacetSignal(...) of the ontology, or null.
// Returns { method, ranked } where each ranked rule carries scopeMatch, scopeAmbiguous and
// editions; under hybrid also `order`, the value it was sorted by (larger is earlier).
// `method` is the one actually used.
function rankRules({ candidates, scope, query = '', campus = 'all', facets = null, method = rankingMethod() }) {
  const used = METHODS.includes(method) ? method : DEFAULT_METHOD;
  if (used === 'legacy') {
    let ranked = byFamily(candidates).flatMap(members => legacyEditions(members, scope))
      .sort((a, b) => Number(b.scopeMatch) - Number(a.scopeMatch) || b.score - a.score || a.lawId - b.lawId);
    // A specified, available scope must not be padded with unrelated editions.
    if (scope.specified && !scope.ambiguous && ranked.some(hit => hit.scopeMatch)) ranked = ranked.filter(hit => hit.scopeMatch);
    return { method: used, ranked };
  }
  const place = placeRequest(query, campus);
  const ranked = byFamily(candidates).flatMap(members => placedEditions(members, place))
    .map(hit => ({ ...hit, order: hit.score * placeShare(hit) * audienceShare(hit, facets) }))
    .sort((a, b) => b.order - a.order || a.lawId - b.lawId);
  return { method: used, ranked };
}

module.exports = { METHODS, DEFAULT_METHOD, rankingMethod, rankRules };

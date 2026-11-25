'use strict';

// Completeness of evidence gathered by one tool on behalf of another.
// A parent result may say "retrieved" only when every child lookup did.

// Reasons one rule lookup response falls short of complete evidence ([] = complete).
function ruleLookupGaps(structured) {
  if (!structured || structured.ok !== true) return [structured?.error?.code || 'LOOKUP_FAILED'];
  const data = structured.data || {};
  // Article-level responses (get_rule_content, applicable_rule) carry no excerpt limits.
  if (data.articles?.length) return [];
  const rules = data.rules || [];
  if (!rules.length) return ['NO_RULE_RETURNED'];
  const reasons = new Set();
  for (const rule of rules) {
    for (const reason of rule.incompleteReasons || []) reasons.add(reason);
    if (rule.warning) reasons.add('RULE_WARNING');
    if (rule.excerpt?.truncated) reasons.add('EXCERPT_TRUNCATED');
    if (rule.excerpt?.missingAppendices?.length) reasons.add('APPENDIX_NOT_FOUND');
    if (!rule.excerpt?.matchedTerms?.length) reasons.add('NO_TERM_MATCH');
    if (rule.evidenceStatus === 'partial' && !(rule.incompleteReasons || []).length) reasons.add('EVIDENCE_PARTIAL');
  }
  if (data.evidenceStatus === 'partial' && !reasons.size) reasons.add('EVIDENCE_PARTIAL');
  return [...reasons];
}

// Coverage of a batch of rule lookups; `results` are serialized tool responses.
function summarizeRuleCoverage(results, requests, limit) {
  const incomplete = [];
  for (const [index, result] of results.entries()) {
    const reasons = ruleLookupGaps(result.structuredContent);
    if (reasons.length) incomplete.push({ reference: result.requested_reference || requests[index] || null, reasons });
  }
  return {
    status: incomplete.length || requests.length > limit ? 'partial' : 'retrieved',
    results, requested: requests.length, attempted: results.length,
    not_retrieved: incomplete.length, incomplete,
    omitted: requests.slice(limit), omitted_count: Math.max(0, requests.length - limit),
  };
}

// Whether the law text asked for with an upper-law check came back whole.
// Kept apart from the identity/existence check: that can succeed on a cut body,
// and a body that never arrived is a different gap from one that was cut.
function lawTextCoverage(laws, { includeText, maxTextChars, lookupCode }) {
  if (!includeText) return { requested: false, status: 'not_requested', truncatedArticles: [], missingArticles: [] };
  const truncatedArticles = [], missingArticles = [];
  let expected = 0, returned = 0;
  for (const law of laws || []) {
    // A law the listing does not have has no body to fetch; LAW_NOT_FOUND reports it.
    if (law.identity?.status === 'not_found') continue;
    const lawName = law.identity?.name || law.lawName;
    for (const article of law.articles || []) {
      if (article.text) {
        expected++; returned++;
        if (article.truncated) truncatedArticles.push({ lawName, article: article.article, mst: law.identity?.mst || null });
        continue;
      }
      // Confirmed absent or deleted articles have no body to return.
      if (['missing', 'deleted'].includes(article.status)) continue;
      expected++;
      missingArticles.push({ lawName, article: article.article, articleStatus: article.status,
        reason: article.code || law.identity?.code || lookupCode || (article.status === 'found' ? 'LAW_TEXT_NOT_RETURNED' : 'LAW_TEXT_NOT_CHECKED') });
    }
  }
  const status = !expected ? 'not_required' : !returned ? 'unavailable' : truncatedArticles.length || missingArticles.length ? 'partial' : 'complete';
  return { requested: true, status, truncatedArticles, missingArticles, maxTextChars };
}

module.exports = { ruleLookupGaps, summarizeRuleCoverage, lawTextCoverage };

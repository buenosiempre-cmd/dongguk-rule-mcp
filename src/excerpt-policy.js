'use strict';

const { isBodyBoundary, appendixHeading } = require('./appendices');

// Read per request; absent or unknown values retain the established extractor.
function excerptPolicy(value = process.env.DONGGUK_MCP_EXCERPT) {
  const name = ['article', 'literal', 'article-literal'].includes(value) ? value : 'legacy';
  return { name, article: name.includes('article'), literal: name.includes('literal') };
}

function excerptInputs(policy, { expandedTerms, literalTerms, priorityArticles = [] }) {
  return {
    terms: policy.literal ? literalTerms : expandedTerms,
    // Priorities computed with expanded vocabulary would leak that vocabulary
    // back into the supposedly literal excerpt selection.
    priorityArticles: policy.literal ? [] : priorityArticles,
  };
}

// Text between complete appendices: preserve source text while each article
// consumes one ranking slot, independently of its blank paragraph boundaries.
function articleUnits(text) {
  const units = [];
  let lines = [], article = false;
  const flush = () => {
    const block = lines.join('\n').trim();
    if (block) units.push(...(article ? [block] : block.split(/\n\s*\n/).filter(Boolean)));
    lines = [];
  };
  for (const line of String(text || '').split('\n')) {
    const boundary = isBodyBoundary(line);
    if (boundary || appendixHeading(line)) {
      flush();
      article = boundary === 'article';
    }
    lines.push(line);
  }
  flush();
  return units;
}

// Scoring sees one prose line per article. A wrapped cross-reference must not
// gain a heading bonus just because a converter starts a new paragraph there.
// Table rows keep their structural marker; returned evidence is never rewritten.
function articleScoreText(block) {
  const [heading, ...body] = block.split('\n');
  return heading + '\n ' + body.map(line => /^\s*\|/.test(line)
    ? '\n' + line.trim() + '\n ' : line.trim()).join(' ');
}

module.exports = { excerptPolicy, excerptInputs, articleUnits, articleScoreText };

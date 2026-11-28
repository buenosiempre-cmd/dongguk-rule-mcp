'use strict';

// Post-retrieval finance topic checks only: these do not add search terms or
// requests, infer legal equivalence, or replace the existing issue-frame slots.
const compact = value => String(value || '').replace(/\s+/g, '');
const PROFILES = [
  { id: 'corporate_card', query: /법인카드|법카/, anchor: /법인카드|클린카드/ },
  { id: 'direct_contract', query: /수의계약/, anchor: /수의계약/ },
  { id: 'purchasing', query: /구매|물품구입/, anchor: /구매|물품구입|물품의구입/ },
  { id: 'meeting_expenses', query: /회의비/, anchor: /회의비/ },
  { id: 'budget_transfer', query: /예산.*전용|전용.*예산/, anchor: /예산(?:의|을)?전용|전용예산/ },
  { id: 'supporting_documents', query: /증빙/, anchor: /증빙|증명서류|증거서류/ },
];

function comparisonTopic(topic) {
  const profiles = PROFILES.filter(p => p.query.test(compact(topic)));
  // Multiple independent subjects need a richer comparison, not a guessed one.
  return profiles.length === 1 ? profiles[0] : null;
}

function assessTopic(block, profile, terms) {
  const text = String(block.content || '');
  // PDF/HTML often put the whole first paragraph on the heading line. Only the
  // parentheses contain the heading; a body mention must not earn heading rank.
  const heading = /^\s*(?:#+\s*)?제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[（(]([^）)]+)[）)]/.exec(text)?.[1] || '';
  const inHeading = profile.anchor.test(compact(heading));
  const inText = profile.anchor.test(compact(text));
  const basis = inHeading ? 'heading' : inText ? 'body' : 'weak';
  return {
    profile: profile.id, basis,
    label: inHeading ? '주제 핵심어 제목 일치' : inText ? '주제 핵심어 본문 일치' : '주제 일치 약함',
    headingTerms: terms.filter(t => compact(heading).includes(compact(t))),
  };
}

module.exports = { comparisonTopic, assessTopic };

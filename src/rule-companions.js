'use strict';

// A title relationship is a reason to show another candidate, not proof of
// delegation or legal applicability. The candidate must already match the query.
function isImplementationOf(parentTitle, childTitle) {
  const compact = value => String(value || '').replace(/\s+/g, '');
  const parent = compact(parentTitle), child = compact(childTitle);
  if (!/(?:규정|규칙|학칙|정관|회칙)$/.test(parent) || /^(?:규정|규칙|회칙)$/.test(parent)) return false;
  const base = child.replace(/(?:시행세칙|시행규칙|시행내규|내규)$/, '');
  return base !== child && base.endsWith(parent);
}

function implementationCompanion(ranked) {
  const parent = ranked[0];
  if (!parent || parent.scopeMatch === false || parent.scopeAmbiguous) return null;
  return ranked.slice(1).find(hit => !hit.scopeNameOnly && hit.scopeMatch !== false && !hit.scopeAmbiguous && isImplementationOf(parent.title, hit.title)) || null;
}

module.exports = { isImplementationOf, implementationCompanion };

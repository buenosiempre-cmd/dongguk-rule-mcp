'use strict';

const { extractArticleSections, listArticleBlocks, normalizeArticleSelector } = require('./parsers.js');

function normalizeForCompare(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value, maxChars = 1600) {
  const text = String(value || '');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}\n...(생략)`;
}

function articleHeading(value) {
  return String(value || '').split('\n', 1)[0].replace(/^###\s*/, '').trim();
}

function indexBlocks(markdown) {
  const counts = new Map();
  const result = new Map();
  for (const block of listArticleBlocks(markdown)) {
    const base = `${block.supplementary ? '부칙 ' : ''}${block.canonical}`;
    const occurrence = (counts.get(base) || 0) + 1;
    counts.set(base, occurrence);
    const key = occurrence === 1 ? base : `${base} (${occurrence})`;
    result.set(key, block.content);
  }
  return result;
}

function compareRuleMarkdown(beforeMarkdown, afterMarkdown, options = {}) {
  const rawArticle = options.article;
  if (rawArticle !== undefined && rawArticle !== null && rawArticle !== '') {
    const selector = normalizeArticleSelector(rawArticle);
    if (!selector) return { error: 'INVALID_ARTICLE_SELECTOR' };
    const before = extractArticleSections(beforeMarkdown, rawArticle).text;
    const after = extractArticleSections(afterMarkdown, rawArticle).text;
    if (!before && !after) return { error: 'NOT_FOUND' };
    let status = 'unchanged';
    if (!before && after) status = 'added';
    else if (before && !after) status = 'removed';
    else if (normalizeForCompare(before) !== normalizeForCompare(after)) status = 'changed';
    return {
      article: selector.canonical,
      counts: {
        added: status === 'added' ? 1 : 0,
        removed: status === 'removed' ? 1 : 0,
        changed: status === 'changed' ? 1 : 0,
        unchanged: status === 'unchanged' ? 1 : 0,
      },
      changes: [{
        key: selector.canonical,
        status,
        headingChanged:!!before && !!after && articleHeading(before) !== articleHeading(after),
        before:clip(before),
        after:clip(after),
      }],
    };
  }

  const before = indexBlocks(beforeMarkdown);
  const after = indexBlocks(afterMarkdown);
  if (!before.size || !after.size) return { error: 'CONTENT_UNAVAILABLE' };
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const changes = [];
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const key of keys) {
    const oldText = before.get(key) || '';
    const newText = after.get(key) || '';
    let status = 'unchanged';
    if (!oldText && newText) status = 'added';
    else if (oldText && !newText) status = 'removed';
    else if (normalizeForCompare(oldText) !== normalizeForCompare(newText)) status = 'changed';
    counts[status]++;
    if (status !== 'unchanged') {
      changes.push({
        key,
        status,
        headingChanged:!!oldText && !!newText && articleHeading(oldText) !== articleHeading(newText),
        before:clip(oldText),
        after:clip(newText),
      });
    }
  }
  return { article: null, counts, changes };
}

function formatVersionComparison(comparison, options = {}) {
  const title = options.title || `HISTORY_ID ${options.fromHistoryId} → ${options.toHistoryId}`;
  let output = `# 규정 개정 비교: ${title}\n\n` +
    `- 추가: ${comparison.counts.added}건\n` +
    `- 삭제: ${comparison.counts.removed}건\n` +
    `- 변경: ${comparison.counts.changed}건\n` +
    `- 동일: ${comparison.counts.unchanged}건\n`;
  if (!comparison.changes.length) return `${output}\n변경된 조문이 없습니다.`;
  for (const change of comparison.changes.slice(0, options.maxChanges || 20)) {
    let label = { added: '추가', removed: '삭제', changed: '변경' }[change.status] || change.status;
    if(change.headingChanged) label+=' · 조문명 변경';
    output += `\n\n## ${change.key} — ${label}`;
    if (change.before) output += `\n\n### 이전\n\n${change.before}`;
    if (change.after) output += `\n\n### 이후\n\n${change.after}`;
  }
  if (comparison.changes.length > (options.maxChanges || 20)) {
    output += `\n\n...(${comparison.changes.length - (options.maxChanges || 20)}개 변경 조문 생략)`;
  }
  return output;
}

module.exports = { compareRuleMarkdown, formatVersionComparison, normalizeForCompare };

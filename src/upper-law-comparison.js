'use strict';

// Reuse the exact HTML blocks that supplied the citations and the already fetched
// korean-law article text. No additional upstream requests or applicability inference.
const LIMITS = { maxPairs: 24, maxRuleChars: 6000, maxTotalRuleChars: 24000 };
const clip = (text, size) => {
  let end = Math.min(text.length, size);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
};

function buildComparison(result, { blocks, source, includeText }) {
  const comparison = { requested: includeText, status: 'not_requested', scope: 'html_citing_blocks_vs_current_law_articles',
    ruleArticles: [], pairs: [], omittedPairs: 0, incompleteReasons: [], limits: { ...LIMITS } };
  if (!includeText) return comparison;
  const reasons = new Set();
  const saved = new Map();
  let remaining = LIMITS.maxTotalRuleChars;
  let completePairs = 0;
  for (const [lawIndex, law] of result.laws.entries()) {
    if (law.relation !== 'cited') continue;
    for (const cite of law.citedBy) {
      if (comparison.pairs.length >= LIMITS.maxPairs) { comparison.omittedPairs++; continue; }
      let rule = saved.get(cite.ruleBlockId);
      if (!rule) {
        const block = blocks.find(x => x.id === cite.ruleBlockId);
        const full = block?.content || '';
        const text = clip(full, Math.min(LIMITS.maxRuleChars, remaining));
        remaining -= text.length;
        const truncated = text.length < full.length;
        const status = !text ? 'unavailable' : truncated ? 'partial' : 'complete';
        rule = { id: cite.ruleBlockId, article: cite.ruleArticle, supplementaryHeading: block?.supplementaryHeading || null,
          source: { ...source, sourceType: 'HTML 본문' }, contentMarkdown: text,
          textCoverage: { status, truncated, returnedChars: text.length, totalChars: full.length, unit: 'utf16' },
          fullTextRequest: { tool: 'get_rule_full_text', arguments: { law_id: source.lawId, history_id: source.historyId } } };
        saved.set(cite.ruleBlockId, rule); comparison.ruleArticles.push(rule);
        if (truncated) reasons.add('RULE_TEXT_TRUNCATED');
        if (!text) reasons.add('RULE_TEXT_UNAVAILABLE');
      }
      const lawArticleIndex = law.articles.findIndex(x => x.article === cite.lawArticle);
      const article = law.articles[lawArticleIndex];
      const lawTextStatus = !cite.lawArticle ? 'not_specified' : !article?.text ? 'unavailable' : article.truncated ? 'partial' : 'complete';
      if (lawTextStatus === 'not_specified') reasons.add('LAW_ARTICLE_UNSPECIFIED');
      if (lawTextStatus === 'unavailable') reasons.add('LAW_TEXT_UNAVAILABLE');
      if (lawTextStatus === 'partial') reasons.add('LAW_TEXT_TRUNCATED');
      const status = rule.textCoverage.status === 'complete' && lawTextStatus === 'complete' ? 'complete'
        : rule.contentMarkdown && article?.text ? 'partial' : 'unavailable';
      if (status === 'complete') completePairs++;
      comparison.pairs.push({ ruleArticleId: rule.id, lawIndex, lawArticleIndex: lawArticleIndex < 0 ? null : lawArticleIndex,
        lawName: law.lawName, lawArticle: cite.lawArticle, paragraph: cite.paragraph || null,
        citationText: cite.citationText, resolutionStatus: cite.resolutionStatus, status, lawTextStatus });
    }
  }
  if (comparison.omittedPairs) reasons.add('COMPARISON_LIMIT');
  // The plan's omitted laws still mean the requested comparison is incomplete.
  if (result.omitted.some(x => x.relation === 'cited')) reasons.add('LAW_LIMIT');
  comparison.incompleteReasons = [...reasons];
  comparison.status = !comparison.pairs.length && !reasons.size ? 'not_required'
    : !comparison.pairs.some(p => ['complete', 'partial'].includes(p.status)) ? 'unavailable'
    : reasons.size || completePairs !== comparison.pairs.length ? 'partial' : 'complete';
  return comparison;
}

// Preserve newlines, pipes, and literal HTML as text inside a two-column table.
const cell = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
function formatComparison(comparison, laws) {
  if (!comparison.requested) return '';
  const lines = ['### 조문 대조', `- 대조 본문 상태: ${comparison.status}${comparison.incompleteReasons.length ? ` (${comparison.incompleteReasons.join(', ')})` : ''}`,
    '- 왼쪽은 인용을 추출한 HTML 규정 조문, 오른쪽은 조회 시점 현행 법령 조문입니다. 과거 규정 당시의 법령이나 업무 적용성을 확정하지 않습니다. 규정 별표·서식 전문은 get_rule_full_text로 확인하세요.'];
  if (!comparison.pairs.length) lines.push('대조할 명시적 법령 인용 조문이 없습니다. 주제 후보를 대조 근거로 채우지 않습니다.');
  for (const rule of comparison.ruleArticles) {
    lines.push('', `#### 규정 ${rule.article || '본문'}${rule.supplementaryHeading ? ` — ${rule.supplementaryHeading}` : ''}`,
      `- LAW_ID ${rule.source.lawId} / HISTORY_ID ${rule.source.historyId} · 규정 개정일 ${rule.source.revisedAt || '미상'} · ${rule.source.sourceUrl}`);
    const pairs = comparison.pairs.filter(p => p.ruleArticleId === rule.id);
    const right = [], shown = new Set();
    for (const pair of pairs) {
      const law = laws[pair.lawIndex], id = law.identity;
      const article = pair.lawArticleIndex === null ? null : law.articles[pair.lawArticleIndex];
      // Every citation (including different paragraphs) remains visible; the body is printed once per target.
      right.push(`규정 ${rule.article || '본문'}: ${pair.citationText}${pair.paragraph ? ` [인용 항: ${pair.paragraph}]` : ''}`);
      const key = `${pair.lawIndex}:${pair.lawArticleIndex}`;
      if (shown.has(key)) continue;
      shown.add(key);
      right.push(`${id.name || law.lawName} ${pair.lawArticle || '(조문 번호 미지정)'} — ${pair.lawTextStatus}`);
      right.push(`현행 여부 ${id.status} · MST ${id.mst || '미확인'} · 현행본 시행일 ${id.effectiveAt || '미확인'} · ${id.url || '원문 URL 미확인'}`);
      if (article?.text) right.push(article.text);
      else right.push(pair.lawArticle ? `법령 본문 미확보 (${article?.status || id.status}${article?.code ? ` / ${article.code}` : ''})` : '인용에 조문 번호가 없어 대응 조문을 선택하지 않았습니다.');
      if (article?.truncated) right.push('법령 본문 잘림: 한국법령 MCP get_law_text로 해당 MST·조문을 확인하세요.');
    }
    const left = rule.contentMarkdown || '규정 본문 미확보(반환 한도 또는 원문 누락)';
    lines.push('', '| 규정 조문 원문 (HTML) | 인용한 국가 법령 조문 원문 (현행본) |', '|---|---|', `| ${cell(left)} | ${cell(right.join('\n\n'))} |`);
    if (rule.textCoverage.status !== 'complete') lines.push(`규정 본문 ${rule.textCoverage.truncated ? '잘림' : '미확보'}: get_rule_full_text에 ${JSON.stringify(rule.fullTextRequest.arguments)}를 전달하고 필요하면 이어받으세요.`);
  }
  if (comparison.omittedPairs) lines.push(`대조 인용 ${comparison.omittedPairs}건을 표시 한도(${comparison.limits.maxPairs}건)로 생략했습니다. article을 지정해 나누어 조회하세요.`);
  return lines.join('\n');
}

module.exports = { buildComparison, formatComparison, LIMITS };

'use strict';
const cheerio = require('cheerio');
const { listArticleBlocks } = require('./parsers');
const { extractPdfText } = require('./pdf-text');
const error = code => Object.assign(new Error(code), { code });
const APPENDIX_HEADING = /^(?:[\[<〈【(（]\s*)?(?:별\s*표|별\s*지|별\s*첨|부\s*록|붙\s*임)(?=\s*\d|\s*[\]>〉】)）]|\s|$)/;
const NOTICE = '중앙대 PDF의 텍스트 레이어에서 조문만 비교합니다(A안). 별표 이후 후반을 제외한 경우 시행일도 미확인입니다. 표의 셀·병합·금액 대응과 별표·별지·부록·서식·그림은 비교하지 않습니다. 관련 금액·조건은 연결된 PDF 원문에서 확인하세요. PDF의 줄바꿈·읽기 순서가 원본 배치와 다를 수 있으며 OCR은 수행하지 않습니다.';
function selectPdf(detail, ruleNo, maxDt) {
  const $ = cheerio.load(detail), files = [];
  $('[onclick]').each((_, node) => {
    const m = /^\s*(?:javascript:\s*)?fileDown\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*\)\s*;?\s*$/.exec($(node).attr('onclick'));
    if (!m || !/\.pdf$/i.test(m[4])) return;
    const path = m[2], file = m[4];
    const parts = /^\/CAU\/\d+\/(\d+)\/(\d{8})\/$/.exec(path);
    if (!parts || parts[1] !== ruleNo || /[\\/\x00-\x1f]/.test(file)) return;
    files.push({ path, file, date: parts[2] });
  });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(maxDt || '') ? maxDt.replace(/-/g, '') : null;
  if (!date) throw error('PDF_REVISION_UNVERIFIED');
  const matches = [...new Map(files.filter(f => f.date === date).map(f => [f.path + f.file, f])).values()];
  if (matches.length !== 1) throw error('PDF_REVISION_UNVERIFIED');
  return matches[0];
}
// PDF text is not HTML: retain literal angle-bracket amendment notes. Only line
// starts define headings, so an in-sentence reference cannot create a new article.
function articleMarkdown(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[\t ]+/g, ' ').trim();
    if (APPENDIX_HEADING.test(line)) break;
    if (/^제\s*\d+\s*조(?:\s*의\s*\d+)?(?=\s*[(（]|\s+삭제(?:\s|$)|$)/.test(line)) out.push('### ' + line);
    else if (/^부\s*칙(?=[\s(（<\[]|$)/.test(line)) out.push('## ' + line.replace(/^부\s*칙/, '부칙'));
    else if (/^제\s*\d+\s*(?:장|절)(?=[\s(（]|$)/.test(line)) out.push('## ' + line);
    else if (line) out.push(line);
  }
  return out.join('\n');
}
async function loadCau(source, topic, terms, client, signal, spec, { rankByTitle, maxRules, latestAddendaEffective, safeCode, extractPdf = extractPdfText }) {
  const raw = await client.request(source, '/ajax/FR_SVC/CampusRuleList.do', undefined, 15000, signal);
  let list;
  try { list = JSON.parse(raw).data; } catch { throw error('UPSTREAM_FORMAT_CHANGED'); }
  if (!Array.isArray(list) || list.some(x => !x || typeof x.RULES !== 'string' || !/^\d+$/.test(String(x.RULES_NO)))) throw error('UPSTREAM_FORMAT_CHANGED');
  const items = list.map(x => ({ no: String(x.RULES_NO), title: x.RULES, maxDt: x.MAX_DT }));
  const ranked = rankByTitle(items, topic, terms, spec.titleHints || terms), rules = [], failures = [];
  for (const hit of ranked.slice(0, maxRules)) {
    try {
      if (signal?.aborted) throw error('TOTAL_TIMEOUT');
      const detailPath = `/cms/FR_CON/RulesDetailView.do?MENU_ID=30&SITE_NO=2&RULES_NO=${hit.no}`;
      const detail = await client.request(source, detailPath, undefined, 15000, signal);
      const file = selectPdf(detail, hit.no, hit.maxDt);
      const pdfPath = `/ajaxFile/FR_SVC/CampusRulePDFDownload2.do?FILE_PATH=${encodeURIComponent(file.path)}&FILE_NM=${encodeURIComponent(file.file)}`;
      const buffer = await client.request(source, pdfPath, undefined, 20000, signal, { binary: true });
      const extracted = await extractPdf(buffer, { signal });
      const markdown = articleMarkdown(extracted.text);
      if (!listArticleBlocks(markdown).length) throw error('PDF_NO_ARTICLES');
      // An appendix boundary removes the tail from article comparison; a later
      // addendum could be there. Never label an earlier date as the latest one.
      const tailExcluded = extracted.text.split(/\r?\n/).some(line => APPENDIX_HEADING.test(line.trim()));
      const effectiveAt = tailExcluded ? null : latestAddendaEffective(markdown);
      rules.push({ title: hit.title, lawId: hit.no, historyId: file.date, markdown,
        url: source.origin + detailPath, originalPdfUrl: source.origin + pdfPath, sourceType: 'PDF 텍스트 레이어',
        revisedAt: hit.maxDt.replace(/-/g, '.'), effectiveAt, effectiveSource: effectiveAt ? 'addenda' : null });
    } catch (e) {
      const code = safeCode(e); failures.push({ lawId: hit.no, code });
      if (['ACCESS_DENIED','SESSION_REQUIRED','UPSTREAM_UNAVAILABLE','REDIRECT_NOT_FOLLOWED','TOTAL_TIMEOUT','PDF_PARSE_BUSY'].includes(code)) break;
    }
  }
  return { rules, failures, coverage: { mode: 'cau_pdf', totalCandidates: items.length, titleMatches: ranked.length,
    truncated: ranked.length > maxRules, complete: false, comparisonScope: 'articles_only', appendicesCompared: false, textLayerOnly: true, notice: NOTICE } };
}
module.exports = { loadCau, selectPdf, articleMarkdown, NOTICE };

'use strict';

const cheerio = require('cheerio');

function parseSearch(html, page, pageShow) {
  const $ = cheerio.load(html);
  let total = 0;
  const info = $('p.infoLeft').html() || '';
  const totalMatch = info.match(/([\d,]+)\s*<\/span>\s*건/);
  if (totalMatch) total = parseInt(totalMatch[1].replace(/,/g, ''), 10);

  const hits = [];
  const seen = new Set();
  let rawCount = 0;
  $('tbody.tbody tr').each(function parseRow() {
    const cell = $(this).find('td.tbody_txt');
    if (!cell.length) return;
    const source = cell.html() || '';
    const idMatch = /lawSearchFullViewSrv\(\s*'(\d+)'\s*,\s*'(\d+)'/.exec(source);
    if (!idMatch) return;
    const lawId = parseInt(idMatch[1], 10);
    const historyId = parseInt(idMatch[2], 10);
    rawCount++;
    const key = `${lawId}_${historyId}`;
    if (seen.has(key)) return;
    seen.add(key);

    const searchText = [];
    cell.find('[onclick]').each(function parseLabel() {
      const value = $(this).attr('onclick') || '';
      const match = /showSearchText\(\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1/.exec(value);
      if (match) searchText.push(match[2].replace(/\\(["'\\])/g, '$1'));
    });
    if (!searchText.length) {
      let textMatch;
      // The live site writes labels through scripts such as
      // showSearchText("여비규정", "검색어"). Read only the first string literal;
      // requiring a ')' after it would incorrectly absorb the second argument.
      const textPattern = /showSearchText\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|&quot;((?:(?!&quot;)[\s\S])*)&quot;)/g;
      while ((textMatch = textPattern.exec(source)) !== null) {
        const value = textMatch[1] ?? textMatch[2] ?? textMatch[3] ?? '';
        searchText.push(value.replace(/\\(["'\\])/g, '$1'));
      }
    }

    let revisedAt = '';
    $(this).find('td.tbody_c').each(function parseDate() {
      const htmlSource = $(this).html() || '';
      const onclick = $(this).find('span').attr('onclick') || '';
      const dateMatch = /showDate\(\s*'(\d{8})'/.exec(`${htmlSource} ${onclick}`);
      if (dateMatch) {
        const date = dateMatch[1];
        revisedAt = `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6)}`;
      }
    });
    hits.push({
      lawId,
      historyId,
      code: searchText[0] || '',
      title: searchText[1] || '',
      revisedAt,
    });
  });

  // HTTP 200 can contain a maintenance/login page or changed markup. Neither
  // proves that a regulation does not exist; reject it before it enters cache.
  const expectsRows = total > 0 && (!page || !pageShow || (page - 1) * pageShow < total);
  if (!totalMatch || (expectsRows && !hits.length) || hits.some(hit => !hit.title.trim())) {
    throw Object.assign(new Error('규정 검색 응답 형식을 확인할 수 없습니다. 원문 검색 화면을 확인하세요.'), { code: 'UPSTREAM_FORMAT_CHANGED' });
  }

  return {
    total,
    page,
    pageShow,
    hits,
    rawCount,
    uniqueCount: hits.length,
    duplicateCount: Math.max(0, rawCount - hits.length),
  };
}

function parseContent(html) {
  const $ = cheerio.load(html);
  const fullBody = $('div.fullbody').length ? $('div.fullbody') : $('body');
  const title = fullBody.find('div.lawname').text().trim();
  const lines = [];
  if (title) lines.push(`# ${title}`, '');
  fullBody.find('div').each(function parseBlock() {
    const classes = ($(this).attr('class') || '').split(/\s+/);
    const text = $(this).text().replace(/\s+/g, ' ').trim();
    if (!text || classes.includes('lawname')) return;
    // The live site marks each 부칙 heading as div.addenda. Without it, 부칙 제1조
    // is indistinguishable from 본칙 제1조 and every repeated number becomes ambiguous.
    if (classes.includes('addenda')) lines.push('', `## ${text.replace(/^부\s*칙\s*/, '부칙 ').trim()}`, '');
    else if (classes.includes('chapter')) lines.push('', `## ${text}`, '');
    else if (classes.includes('section')) lines.push('', `### ${text}`, '');
    else if (classes.includes('article')) lines.push('', `### ${text}`);
    else if (classes.includes('none')) lines.push(text);
    else if (classes.includes('hang')) lines.push(text);
    else if (classes.includes('ho')) lines.push(`  ${text}`);
    else if (classes.includes('mok')) lines.push(`    ${text}`);
  });
  // A surviving title alone does not prove that the upstream body was parsed.
  const bodyLines = title ? lines.slice(2) : lines;
  return { title, markdown: bodyLines.some(line => line.trim()) ? lines.join('\n').trim() : '' };
}

function parseHistory(html) {
  const $ = cheerio.load(html);
  const select = $('#histroySeq');
  if (!select.length) return [];
  const entries = [];
  select.find('option').each(function parseOption() {
    const value = ($(this).attr('value') || '').trim();
    if (!value || value === '0' || !/^\d+$/.test(value)) return;
    let revisedAt = '';
    const dateMatch = /showDate\(\s*'(\d{8})'/.exec(
      $(this).attr('onclick') || $(this).html() || $(this).text()
    );
    if (dateMatch) {
      const date = dateMatch[1];
      revisedAt = `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6)}`;
    }
    entries.push({ historyId: parseInt(value, 10), revisedAt });
  });
  return entries;
}

function searchResultMetrics(result) {
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  const rawRows = Number.isFinite(result?.rawCount) ? result.rawCount : hits.length;
  const uniqueRows = Number.isFinite(result?.uniqueCount) ? result.uniqueCount : hits.length;
  const duplicatesRemoved = Number.isFinite(result?.duplicateCount)
    ? result.duplicateCount
    : Math.max(0, rawRows - uniqueRows);
  return { rawRows, uniqueRows, duplicatesRemoved };
}

function normalizeArticleSelector(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return { number: value, subNumber: null, supplementary: false, canonical: `제${value}조` };
  }
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/\s+/g, '');
  const supplementary = compact.startsWith('부칙');
  let source = supplementary ? compact.slice(2) : compact;
  // Optional 부칙 revision date, e.g. "부칙(2024.8.27.) 제1조" or "부칙 2024-08-27 제1조".
  let supplementaryDate = null;
  if (supplementary) {
    const dated = /^[(（<〈\[]?(\d{4})[.\-/년](\d{1,2})[.\-/월](\d{1,2})[.일]?(?:개정|제정|신설)?[)）>〉\]]?/.exec(source);
    if (dated) {
      supplementaryDate = `${dated[1]}.${parseInt(dated[2], 10)}.${parseInt(dated[3], 10)}`;
      source = source.slice(dated[0].length);
    }
  }
  const match = /^(?:제)?(\d+)(?:조)?(?:의(\d+))?$/.exec(source);
  if (!match) return null;
  const number = parseInt(match[1], 10);
  const subNumber = match[2] ? parseInt(match[2], 10) : null;
  if (!Number.isSafeInteger(number) || !number || (match[2] && (!Number.isSafeInteger(subNumber) || !subNumber))) return null;
  const article = `제${number}조${subNumber ? `의${subNumber}` : ''}`;
  return {
    number,
    subNumber,
    supplementary,
    supplementaryDate,
    canonical: supplementary ? `부칙 ${article}` : article,
    label: supplementaryDate ? `부칙(${supplementaryDate}.) ${article}` : (supplementary ? `부칙 ${article}` : article),
  };
}

function headingDate(heading) {
  const match = /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(String(heading || ''));
  return match ? `${match[1]}.${parseInt(match[2], 10)}.${parseInt(match[3], 10)}` : null;
}

function listArticleBlocks(markdown) {
  const source = String(markdown || '');
  const articlePattern = /^###[ \t]*제[ \t]*(\d+)[ \t]*조(?:[ \t]*의[ \t]*(\d+))?(?=[(（\s]|$).*$/gm;
  const supplementPattern = /^(?:#{1,3}[ \t]*)?부[ \t]*칙(?=[ \t(（<〈\[]|$).*$/gm;
  const chapterPattern = /^##\s+.*$/gm;
  const supplements = [];
  const chapters = [];
  let match;
  while ((match = supplementPattern.exec(source)) !== null) supplements.push({ index: match.index, heading: match[0] });
  while ((match = chapterPattern.exec(source)) !== null) chapters.push(match.index);

  const headings = [];
  while ((match = articlePattern.exec(source)) !== null) {
    headings.push({
      index: match.index,
      heading: match[0],
      number: parseInt(match[1], 10),
      subNumber: match[2] ? parseInt(match[2], 10) : null,
    });
  }

  return headings.map((heading, index) => {
    const following = [
      headings[index + 1]?.index,
      ...chapters.filter(position => position > heading.index),
      ...supplements.filter(item => item.index > heading.index).map(item => item.index),
    ].filter(Number.isFinite);
    const end = following.length ? Math.min(...following) : source.length;
    const supplementIndex = supplements.findLastIndex(item => item.index < heading.index);
    const supplementary = supplementIndex >= 0;
    const canonical = `제${heading.number}조${heading.subNumber ? `의${heading.subNumber}` : ''}`;
    return {
      ...heading,
      canonical,
      supplementary,
      supplementaryHeading: supplementary ? supplements[supplementIndex].heading : null,
      supplementaryIndex: supplementary ? supplementIndex + 1 : null,
      content: source.slice(heading.index, end).trimEnd(),
    };
  });
}

// A ready-to-use article selector for one 부칙 block, or null when its heading has no date.
function supplementarySelector(block) {
  const date = block?.supplementary ? headingDate(block.supplementaryHeading) : null;
  return date ? `부칙(${date}.) ${block.canonical}` : null;
}

function extractArticleSections(markdown, rawSelector) {
  const selector = normalizeArticleSelector(rawSelector);
  if (!selector) return { selector: null, sections: [], text: '' };
  let matches = listArticleBlocks(markdown).filter(block =>
    block.number === selector.number && block.subNumber === selector.subNumber
  );
  if (selector.supplementary) {
    matches = matches.filter(block => block.supplementary);
    if (selector.supplementaryDate) matches = matches.filter(block => headingDate(block.supplementaryHeading) === selector.supplementaryDate);
  } else {
    matches = matches.filter(block => !block.supplementary);
  }
  return {
    selector,
    sections: matches,
    ...(matches.length > 1 ? { error: 'AMBIGUOUS_ARTICLE' } : {}),
    text: matches.length > 1 ? '' : matches.map(block => block.content).join('\n\n'),
  };
}

function extractChapter(markdown, chapter) {
  const number = Number(chapter);
  if (!Number.isInteger(number) || number <= 0) return '';
  const source = String(markdown || '');
  const match = new RegExp(`^## 제\\s*${number}\\s*장`, 'm').exec(source);
  if (!match) return '';
  const start = match.index;
  const endMatch = /^(?:## 제\s*\d+\s*장|(?:#{1,3}[ \t]*)?부[ \t]*칙(?=[ \t(（<〈\[]|$))/m.exec(source.slice(start + match[0].length));
  return source.slice(start, endMatch ? start + match[0].length + endMatch.index : source.length).trimEnd();
}

function grepArticleSections(markdown, query) {
  const tokens = String(query || '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return listArticleBlocks(markdown).filter(block => tokens.every(token => block.content.includes(token)));
}

// Articles containing the most query words; used when no article has them all.
function rankArticlesByTokens(markdown, tokens) {
  const words = (tokens || []).filter(Boolean);
  if (!words.length) return [];
  const scored = listArticleBlocks(markdown).map(block => ({
    block, matched: words.filter(token => block.content.includes(token)),
  }));
  const best = Math.max(0, ...scored.map(item => item.matched.length));
  if (!best) return [];
  return scored.filter(item => item.matched.length === best).map(item => ({ ...item.block, matchedTerms: item.matched }));
}

module.exports = {
  rankArticlesByTokens,
  parseSearch,
  parseContent,
  parseHistory,
  searchResultMetrics,
  normalizeArticleSelector,
  listArticleBlocks,
  extractArticleSections,
  supplementarySelector,
  extractChapter,
  grepArticleSections,
};

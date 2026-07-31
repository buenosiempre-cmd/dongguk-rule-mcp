'use strict';

const cheerio = require('cheerio');

function parseSearch(html, page, pageShow) {
  const $ = cheerio.load(html);
  let total = 0;
  const info = $('p.infoLeft').html() || '';
  const totalMatch = info.match(/(\d+)\s*<\/span>\s*건/);
  if (totalMatch) total = parseInt(totalMatch[1], 10);

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
    let textMatch;
    const textPattern = /showSearchText\(\s*(?:"|&quot;)([^"&]*)(?:"|&quot;)/g;
    while ((textMatch = textPattern.exec(source)) !== null) searchText.push(textMatch[1]);

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
    if (classes.includes('chapter')) lines.push('', `## ${text}`, '');
    else if (classes.includes('section')) lines.push('', `### ${text}`, '');
    else if (classes.includes('article')) lines.push('', `### ${text}`);
    else if (classes.includes('none')) lines.push(text);
    else if (classes.includes('hang')) lines.push(text);
    else if (classes.includes('ho')) lines.push(`  ${text}`);
    else if (classes.includes('mok')) lines.push(`    ${text}`);
  });
  return { title, markdown: lines.join('\n').trim() };
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
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return { number: value, subNumber: null, supplementary: false, canonical: `제${value}조` };
  }
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/\s+/g, '');
  const supplementary = compact.startsWith('부칙');
  const source = supplementary ? compact.slice(2) : compact;
  const match = /^(?:제)?(\d+)(?:조)?(?:의(\d+))?$/.exec(source);
  if (!match) return null;
  const number = parseInt(match[1], 10);
  const subNumber = match[2] ? parseInt(match[2], 10) : null;
  if (!number || (match[2] && !subNumber)) return null;
  const article = `제${number}조${subNumber ? `의${subNumber}` : ''}`;
  return {
    number,
    subNumber,
    supplementary,
    canonical: supplementary ? `부칙 ${article}` : article,
  };
}

function listArticleBlocks(markdown) {
  const source = String(markdown || '');
  const articlePattern = /^###\s*제\s*(\d+)\s*조(?:의\s*(\d+))?(?=[(\s]|$).*$/gm;
  const supplementPattern = /^(?:#{1,3}\s*)?부\s*칙(?:\s|$).*$/gm;
  const chapterPattern = /^##\s+.*$/gm;
  const supplements = [];
  const chapters = [];
  let match;
  while ((match = supplementPattern.exec(source)) !== null) supplements.push(match.index);
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
      ...supplements.filter(position => position > heading.index),
    ].filter(Number.isFinite);
    const end = following.length ? Math.min(...following) : source.length;
    const supplementary = supplements.some(position => position < heading.index);
    const canonical = `제${heading.number}조${heading.subNumber ? `의${heading.subNumber}` : ''}`;
    return {
      ...heading,
      canonical,
      supplementary,
      content: source.slice(heading.index, end).trimEnd(),
    };
  });
}

function extractArticleSections(markdown, rawSelector) {
  const selector = normalizeArticleSelector(rawSelector);
  if (!selector) return { selector: null, sections: [], text: '' };
  let matches = listArticleBlocks(markdown).filter(block =>
    block.number === selector.number && block.subNumber === selector.subNumber
  );
  if (selector.supplementary) {
    matches = matches.filter(block => block.supplementary);
  } else {
    const mainBody = matches.filter(block => !block.supplementary);
    matches = mainBody.length ? mainBody.slice(0, 1) : matches.slice(0, 1);
  }
  return {
    selector,
    sections: matches,
    text: matches.map(block => block.content).join('\n\n'),
  };
}

function extractChapter(markdown, chapter) {
  const number = Number(chapter);
  if (!Number.isInteger(number) || number <= 0) return '';
  const source = String(markdown || '');
  const match = new RegExp(`^## 제\\s*${number}\\s*장`, 'm').exec(source);
  if (!match) return '';
  const start = match.index;
  const endMatch = /^## 제\s*\d+\s*장/m.exec(source.slice(start + match[0].length));
  return source.slice(start, endMatch ? start + match[0].length + endMatch.index : source.length).trimEnd();
}

function grepArticleSections(markdown, query) {
  const tokens = String(query || '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return listArticleBlocks(markdown).filter(block => tokens.every(token => block.content.includes(token)));
}

module.exports = {
  parseSearch,
  parseContent,
  parseHistory,
  searchResultMetrics,
  normalizeArticleSelector,
  listArticleBlocks,
  extractArticleSections,
  extractChapter,
  grepArticleSections,
};

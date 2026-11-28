'use strict';

const DELEGATES = /(?:(?:따로|별도로)\s*정한다|(?:지침|세칙|규정)[」』”"]?\s*으로\s*정한다)[.。]/;
const ARTICLE = /^(?:#{1,6}\s*)?(제\s*\d+\s*조(?:\s*의\s*\d+)?)\s*[(（]([^)）]*)[)）]\s*/;

// Keep the whole returned paragraph: punctuation inside amounts, dates and
// numbered items is never a sentence boundary. Ambiguous regions are omitted.
function delegationNotices(rules) {
  const notices = [];
  for (const rule of rules) {
    const text = rule.excerpt?.text || '';
    let article = null, articleTitle = null, paragraph = null, supplement = null;
    let opaque = false, quoteDepth = 0, offset = 0, pending = null;
    const flush = () => {
      if (!pending) return;
      const quote = text.slice(pending.start, pending.end).trim();
      // Quoted document titles are allowed; quoted operative sentences are not.
      const unquoted = quote.replace(/「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|‘[^’\n]*’|"[^"\n]*"|'[^'\n]*'/g, s => /(?:지침|세칙|규정)[」』”’"']$/.test(s) && !DELEGATES.test(s) ? s.slice(1,-1) + '  ' : ' '.repeat(s.length));
      if (quote.length <= 1000 && !/[「」『』“”‘’"']|\.\.\.|…/.test(unquoted) &&
          /[.。](?:\s*(?:\([^()\n]*\)|\[[^\]\n]*\]|<[^>\n]*>))*\s*$/.test(quote) &&
          DELEGATES.test(unquoted)) {
        notices.push({ lawId: rule.lawId, historyId: rule.historyId, title: rule.title,
          article, articleTitle, paragraph, quote, excerptEnd: pending.end });
      }
      pending = null;
    };
    for (const raw of text.split('\n')) {
      const start = offset;
      offset += raw.length + 1;
      let line = raw.trim(), bodyStart = start + raw.indexOf(line);
      const wasQuoted = quoteDepth > 0;
      for (const char of raw) {
        if (char === '「' || char === '『') quoteDepth++;
        else if (char === '」' || char === '』') quoteDepth = Math.max(0, quoteDepth - 1);
      }
      if (wasQuoted || quoteDepth > 0) { flush(); continue; }
      // Once an appendix/example/code region starts, later article-looking
      // headings may belong to a form or quoted contract, not the main rule.
      if (/^(?:#{1,6}\s*)?[<\[〈【]?별\s*(?:표|지|첨)|^```|^~~~|(?:예시|예문|예제|보기)\s*[:：]|예를\s*들/.test(line)) {
        flush(); opaque = true;
      }
      if (opaque) continue;
      const heading = line.match(ARTICLE);
      if (heading) {
        flush();
        article = (supplement ? supplement + ' ' : '') + heading[1].replace(/\s/g, '');
        articleTitle = heading[2]; paragraph = null;
        bodyStart += heading[0].length;
        line = line.slice(heading[0].length);
      } else if (/^#{1,6}\s|^(?:부\s*칙|제\s*\d+\s*장)/.test(line)) {
        flush(); article = null; paragraph = null;
        const supplementary = line.match(/^(?:#{1,6}\s*)?(부\s*칙.*)$/);
        if (supplementary) supplement = supplementary[1];
        else if (/^(?:#{1,6}\s*)?제\s*\d+\s*장/.test(line)) supplement = null;
        continue;
      }
      if (!line) { flush(); continue; }
      if (!article) continue;
      if (/^[①-⑳]/.test(line)) { flush(); paragraph = line[0]; }
      if (/^>|^\|/.test(line)) { flush(); opaque = true; continue; }
      if (!pending) pending = {start:bodyStart, end:start + raw.length};
      else pending.end = start + raw.length;
    }
    flush();
  }
  return notices;
}

function annotateDelegationExcerpt(text, notices) {
  let rendered = text;
  for (const n of [...notices].sort((a,b)=>b.excerptEnd-a.excerptEnd)) {
    const note = '\n\n> **별도 기준 확인:** 위임된 지침·기준의 내용과 적용 여부는 미확인입니다.';
    rendered = rendered.slice(0,n.excerptEnd) + note + rendered.slice(n.excerptEnd);
  }
  return rendered;
}

// An explicit article request in an identified rule is narrower than a shared
// query word. Candidate previews and inferred article selectors never qualify.
function delegationSummary(notices, {identityStatus, requestedArticles = []} = {}) {
  if (!['explicit_id','exact_title','catalog_title'].includes(identityStatus)) return [];
  return notices.filter(n => requestedArticles.includes(n.article));
}
function formatDelegationNotices(notices) {
  if (!notices.length) return '';
  const articles = [...new Set(notices.map(n=>`${n.title} ${n.article}`))];
  return `> **지정 조문의 별도 기준:** ${articles.join(', ')}에 위임 문구가 있습니다. 해당 문단 옆 안내를 확인하세요. 위임 문서 내용·적용 여부는 미확인입니다.\n\n`;
}
module.exports = { delegationNotices, annotateDelegationExcerpt, delegationSummary, formatDelegationNotices };

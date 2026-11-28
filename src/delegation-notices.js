'use strict';

// Read only the returned excerpt, after ranking and clipping have finished.
// Quote the provision instead of inferring its scope, delegate, or missing limits.
function delegationNotices(rules) {
  const notices = [];
  for (const rule of rules) {
    let article = null, articleTitle = null, paragraph = null, supplement = null;
    for (const raw of (rule.excerpt?.text || '').split('\n')) {
      let line = raw.trim();
      const supplementaryHeading = line.match(/^(?:#{1,6}\s*)?(부\s*칙.*)$/);
      if (supplementaryHeading) supplement = supplementaryHeading[1];
      else if (/^(?:#{1,6}\s*)?제\s*\d+\s*장/.test(line)) supplement = null;
      const heading = line.match(/^(?:#{1,6}\s*)?(제\s*\d+\s*조(?:\s*의\s*\d+)?)\s*[(（]([^)）]*)[)）]\s*/);
      if (heading) {
        article = (supplement ? supplement + ' ' : '') + heading[1].replace(/\s/g, '');
        articleTitle = heading[2];
        paragraph = null;
        line = line.slice(heading[0].length);
      } else if (/^#{1,6}\s|^(?:부\s*칙|[<\[]?별\s*표)/.test(line)) {
        article = null;
        articleTitle = null;
        paragraph = null;
      }
      if (!article || !line) continue;
      const marker = line.match(/^[①-⑳]/);
      if (marker) paragraph = marker[0];
      // A period is required: a clipped unfinished statement is not evidence.
      for (const match of line.matchAll(/[^.!?。]*?(?:(?:따로|별도로)\s*정한다|(?:지침|세칙|규정)[」』”"]?으로\s*정한다)[.。]/g)) {
        const quote = match[0].trim();
        const following = line.slice(match.index + match[0].length);
        // Do not treat a quoted example/label as an operative provision.
        if (!quote || /["“”'‘’]|예시|예문|문구|라는\s*표현/.test(quote) || /^["”'’」』]/.test(following)) continue;
        if (!notices.some(n => n.lawId === rule.lawId && n.article === article && n.quote === quote)) {
          notices.push({ lawId: rule.lawId, historyId: rule.historyId, title: rule.title, article, articleTitle, paragraph, quote });
        }
      }
    }
  }
  return notices;
}

function formatDelegationNotices(notices) {
  if (!notices.length) return '';
  return '> **별도 기준 확인:** 발췌문에 아래 사항을 따로 정하도록 한 내용이 있습니다. 인용된 지침·별도 기준의 내용은 이 알림으로 확인된 것이 아닙니다. 문서명이 없으면 위임 대상 문서도 확인이 필요합니다. 질문의 답이나 후보 규정의 적용 여부를 확정한 알림은 아닙니다.\n' +
    notices.slice(0, 6).map(n => `> - ${n.title} ${n.article}${n.paragraph || ''}${n.articleTitle ? `(${n.articleTitle})` : ''} (LAW_ID ${n.lawId}): ${n.quote}`).join('\n') +
    (notices.length > 6 ? `\n> - 그 밖의 ${notices.length - 6}건은 아래 발췌문과 delegationNotices에서 확인하세요.` : '') + '\n\n';
}

module.exports = { delegationNotices, formatDelegationNotices };

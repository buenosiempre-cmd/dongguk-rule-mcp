'use strict';

// Presentation only: classify the already selected forms; never choose a term.
function rewriteDetails(...maps) {
  return Object.entries(Object.assign({}, ...maps)).map(([from, to]) => {
    let kind = 'substitution';
    if (to !== from && from.endsWith(to) && (!from.startsWith(to) || from.length > 3)) kind = 'head-drop';
    else if (to !== from && from.startsWith(to)) kind = 'tail-cut';
    else if (to !== from && to.replace(/\s/g, '') === from) kind = 'split';
    return { from, to, kind };
  });
}

function rewriteWarning(details) {
  return details.filter(item => item.kind === 'head-drop').map(({ from, to }) =>
    `> **축약 검색 주의:** '${from}'은 조회한 규정 본문 색인에 없는 낱말이라 '${to}'으로 줄여 찾았습니다. 뜻이 다른 낱말일 수 있으니 결과를 그대로 쓰지 마세요.\n\n`
  ).join('');
}

module.exports = { rewriteDetails, rewriteWarning };

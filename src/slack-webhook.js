'use strict';
// Shared opt-in webhook sender. Never expose the URL or upstream error text.
async function postToSlack(text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const raw = (env.DONGGUK_SLACK_WEBHOOK_URL || '').trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('DONGGUK_SLACK_WEBHOOK_URL이 설정되지 않았습니다.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com' || url.port || url.username || url.password) throw new Error('DONGGUK_SLACK_WEBHOOK_URL은 https://hooks.slack.com/ 주소여야 합니다.');
  let response;
  try { response = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(15000), redirect: 'error',
  }); } catch { throw new Error('Slack 게시 요청 실패'); }
  if (!response.ok) throw new Error(`Slack 게시 실패 (HTTP ${response.status})`);
}

module.exports = { postToSlack };

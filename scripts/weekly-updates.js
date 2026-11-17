#!/usr/bin/env node
'use strict';

// 최근 개정된 규정과 변경 조문을 정리해 출력하거나 Slack에 올립니다.
//
//   node scripts/weekly-updates.js                     지난 7일, 마크다운 출력
//   node scripts/weekly-updates.js --days 14           지난 14일
//   node scripts/weekly-updates.js --since 2026-11-01  지정일 이후
//   node scripts/weekly-updates.js --format slack|markdown|json
//   node scripts/weekly-updates.js --post              DONGGUK_SLACK_WEBHOOK_URL로 게시
//   node scripts/weekly-updates.js --post --post-empty 개정이 없어도 게시
//
// 웹훅 주소는 환경변수로만 받고 출력하지 않습니다.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { sinceDate, buildDigest, formatDigest } = require('../src/digest.js');

function parse(argv) {
  const options = { days: 7, since: null, format: 'markdown', post: false, postEmpty: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') options.days = Number(argv[++i]);
    else if (arg === '--since') options.since = argv[++i];
    else if (arg === '--format') options.format = argv[++i];
    else if (arg === '--post') options.post = true;
    else if (arg === '--post-empty') options.postEmpty = true;
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 366) throw new Error('--days는 1~366의 정수여야 합니다.');
  if (options.since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(options.since || '')) throw new Error('--since는 YYYY-MM-DD 형식이어야 합니다.');
  if (!['slack', 'markdown', 'json'].includes(options.format)) throw new Error('--format은 slack, markdown, json 중 하나여야 합니다.');
  return options;
}

async function postToSlack(text) {
  const raw = (process.env.DONGGUK_SLACK_WEBHOOK_URL || '').trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('DONGGUK_SLACK_WEBHOOK_URL이 설정되지 않았습니다.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com') throw new Error('DONGGUK_SLACK_WEBHOOK_URL은 https://hooks.slack.com/ 주소여야 합니다.');
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Slack 게시 실패 (HTTP ${response.status})`);
}

async function main() {
  const options = parse(process.argv.slice(2));
  const since = options.since || sinceDate(options.days);
  const { createServer } = require('../src/index.js');
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ profile: 'rules' });
  await server.connect(serverSide);
  const client = new Client({ name: 'dongguk-weekly-updates', version: require('../package.json').version });
  await client.connect(clientSide);
  const call = async (name, args) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).structuredContent;

  const digest = await buildDigest(call, { since });
  if (options.format === 'json') console.log(JSON.stringify(digest, null, 2));
  else console.log(formatDigest(digest, options.format));

  if (options.post) {
    if (!digest.rules.length && !options.postEmpty) console.error('개정된 규정이 없어 게시하지 않았습니다(--post-empty로 게시 가능).');
    else { await postToSlack(formatDigest(digest, 'slack')); console.error('Slack에 게시했습니다.'); }
  }
}

main().then(() => process.exit(0), error => { console.error(`실패: ${error.message}`); process.exit(1); });

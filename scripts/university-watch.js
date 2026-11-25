#!/usr/bin/env node
'use strict';
const { runWatch, readSnapshot, saveSnapshot, formatWatch } = require('../src/university-watch');
const { aggregateUsage, kst } = require('../src/usage-log');
const { postToSlack } = require('../src/slack-webhook');
function parse(argv) {
  const options = { format: 'markdown', post: false, usageOnly: false, days: 7 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--post') options.post = true;
    else if (arg === '--usage-only') options.usageOnly = true;
    else if (['--format','--snapshot','--previous','--usage-dir','--days'].includes(arg)) {
      if (!argv[i+1] || argv[i+1].startsWith('--')) throw new Error('INVALID_OPTIONS');
      options[{'--format':'format','--snapshot':'snapshot','--previous':'previous','--usage-dir':'usageDir','--days':'days'}[arg]] = argv[++i];
    } else throw new Error('INVALID_OPTIONS');
  }
  options.days = Number(options.days);
  if (!['markdown','slack','json'].includes(options.format) || !Number.isInteger(options.days) || options.days < 1 || options.days > 366 || (options.usageOnly && (options.snapshot || options.previous))) throw new Error('INVALID_OPTIONS');
  return options;
}
async function main(argv = process.argv.slice(2), { watch = runWatch, post = postToSlack, env = process.env, output = console.log } = {}) {
  const options = parse(argv);
  // Aggregate before network activity so unreadable local input never triggers a smoke.
  const until = Date.now();
  const usage = await aggregateUsage({ dir: options.usageDir ?? env.DONGGUK_MCP_USAGE_LOG_DIR, since: new Date(until - options.days * 86400000).toISOString(), until });
  const report = options.usageOnly ? { checkedAt: kst(until), universities: [] } : await watch({ previous: await readSnapshot(options.previous || options.snapshot) });
  report.usage = usage;
  if (options.snapshot) await saveSnapshot(options.snapshot, report);
  output(formatWatch(report, options.format));
  if (options.post) await post(formatWatch(report, 'slack'));
  return report;
}
if (require.main === module) main().catch(() => { console.error('감시 실행 실패: 옵션·스냅샷·로그 경로 또는 게시 설정을 확인하세요.'); process.exitCode = 1; });
module.exports = { parse, main };

'use strict';

function parseWarmRules(value = '') {
  const rules = [...new Set(value.split(',').map(x => x.trim()).filter(Boolean))];
  if (rules.length > 8 || rules.some(x => x.length > 100)) throw new Error('DONGGUK_MCP_WARM_RULES는 100자 이하 규정명 최대 8개를 쉼표로 구분하세요.');
  return rules;
}

async function runWarmupCycle({ rules, warm, isBusy, stopped = () => false }) {
  const result = { completed: 0, failed: 0, deferred: 0 };
  for (let i = 0; i < rules.length; i++) {
    if (stopped() || isBusy()) { result.deferred = rules.length - i; break; }
    try {
      const response = await warm(rules[i]);
      if (response?.ok === false) result.failed++;
      else result.completed++;
    } catch { result.failed++; }
  }
  return result;
}

function startWarmup({ rules, warm, isBusy, intervalMs = 60000, initialDelayMs = 1000 }) {
  let stopped = false, timer;
  const status = { enabled: rules.length > 0, ruleCount: rules.length, cycles: 0, completed: 0, failed: 0, deferred: 0, running: false, lastFinishedAt: null };
  async function tick() {
    if (stopped) return;
    status.running = true;
    try {
      const result = await runWarmupCycle({ rules, warm, isBusy, stopped: () => stopped });
      status.cycles++;
      for (const key of ['completed', 'failed', 'deferred']) status[key] += result[key];
      status.lastFinishedAt = new Date().toISOString();
    } finally {
      status.running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs).unref();
    }
  }
  if (rules.length) timer = setTimeout(tick, initialDelayMs).unref();
  return {
    stop() { stopped = true; clearTimeout(timer); },
    getStatus() { return { ...status }; },
  };
}

module.exports = { parseWarmRules, runWarmupCycle, startWarmup };

'use strict';

// Per-client fixed-window request limiter for the public HTTP endpoint.
// Only a client key and two counters are kept in memory; nothing is logged.
const net = require('net');

function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/i, '');
  return value === '::1' || (net.isIPv4(value) && value.startsWith('127.'));
}

// Behind cloudflared the TCP peer is always loopback, so the Cloudflare
// CF-Connecting-IP header is trusted only for loopback peers when enabled.
function clientAddress(req, { trustProxy = true } = {}) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '') || 'unknown';
  if (trustProxy && isLoopbackAddress(peer)) {
    const forwarded = req.headers['cf-connecting-ip'];
    const candidate = typeof forwarded === 'string' ? forwarded.trim() : '';
    if (net.isIP(candidate)) return candidate.toLowerCase();
  }
  return peer;
}

function createRateLimiter({ perMinute = 60, perDay = 1000, maxClients = 50000, now = Date.now } = {}) {
  const windows = [
    { limit: perMinute, ms: 60 * 1000, label: 'minute' },
    { limit: perDay, ms: 24 * 60 * 60 * 1000, label: 'day' },
  ].filter(w => w.limit > 0);
  const clients = new Map();
  let lastSweep = 0;

  function sweep(t) {
    if (t - lastSweep < 60 * 1000 && clients.size < maxClients) return;
    lastSweep = t;
    for (const [key, entry] of clients) {
      if (entry.every((slot, i) => t - slot.start >= windows[i].ms)) clients.delete(key);
    }
    // Under a flood of distinct addresses, drop the oldest entries rather than
    // growing without bound. Map iteration order is insertion order.
    while (clients.size >= maxClients) clients.delete(clients.keys().next().value);
  }

  function take(key) {
    if (!windows.length) return { allowed: true };
    const t = now();
    sweep(t);
    let entry = clients.get(key);
    if (!entry) { entry = windows.map(() => ({ start: t, count: 0 })); clients.set(key, entry); }
    for (let i = 0; i < windows.length; i++) {
      const slot = entry[i];
      if (t - slot.start >= windows[i].ms) { slot.start = t; slot.count = 0; }
    }
    for (let i = 0; i < windows.length; i++) {
      if (entry[i].count >= windows[i].limit) {
        const retryAfter = Math.max(1, Math.ceil((entry[i].start + windows[i].ms - t) / 1000));
        return { allowed: false, window: windows[i].label, limit: windows[i].limit, retryAfter };
      }
    }
    for (const slot of entry) slot.count++;
    return { allowed: true };
  }

  return { take, size: () => clients.size, limits: { perMinute, perDay } };
}

module.exports = { createRateLimiter, clientAddress, isLoopbackAddress };

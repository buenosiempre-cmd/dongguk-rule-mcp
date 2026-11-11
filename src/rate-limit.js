'use strict';

// Per-client fixed-window request limiter for the public HTTP endpoint.
// Only a client key and two counters are kept in memory; nothing is logged.
const net = require('net');

function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/i, '');
  return value === '::1' || (net.isIPv4(value) && value.startsWith('127.'));
}

// IPv6 clients usually own a whole /64, so they are grouped by that prefix.
function clientKey(address) {
  const value = String(address || '').replace(/^::ffff:(?=\d+\.)/i, '').toLowerCase();
  if (net.isIPv4(value) || !net.isIPv6(value)) return value;
  const [head, tail = ''] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  if (right.length && net.isIPv4(right[right.length - 1])) right.splice(-1, 1, '0', '0');
  const full = value.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return full.slice(0, 4).map(h => (parseInt(h, 16) || 0).toString(16)).join(':') + '::/64';
}

// Behind cloudflared the TCP peer is always loopback, so the Cloudflare
// CF-Connecting-IP header is trusted only for loopback peers when enabled.
function clientAddress(req, { trustProxy = true } = {}) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '') || 'unknown';
  if (trustProxy && isLoopbackAddress(peer)) {
    const forwarded = req.headers['cf-connecting-ip'];
    const candidate = typeof forwarded === 'string' ? forwarded.trim() : '';
    if (net.isIP(candidate)) return clientKey(candidate);
  }
  return clientKey(peer);
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

module.exports = { createRateLimiter, clientAddress, clientKey, isLoopbackAddress };

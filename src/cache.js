'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Refresh-ahead is requested only by the public, idle-time warmer. Foreground
// callers keep using a still-valid entry while it refreshes; expired entries
// must wait for a successful source fetch. This never extends a cache TTL.
function createDiskCache({ directory, disabled = () => false, refreshAhead = () => false, now = Date.now }) {
  const inflight = new Map();
  const retryAfter = new Map();

  return async function cached(category, key, ttl, load) {
    if (disabled()) return load();
    const root = directory(); // Capture the public/private scope before awaiting.
    const folder = path.join(root, category);
    const filename = path.join(folder, `${key}.json`);
    const ahead = refreshAhead();
    let fresh, age;
    try {
      age = now() - fs.statSync(filename).mtimeMs;
      if (age < ttl * 1000) fresh = { value: JSON.parse(fs.readFileSync(filename, 'utf8')) };
    } catch {}
    if (fresh && (!ahead || age < ttl * 800 || now() < (retryAfter.get(filename) || 0))) return fresh.value;
    if (inflight.has(filename)) return inflight.get(filename);

    const pending = Promise.resolve().then(async () => {
      const value = await load();
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        fs.chmodSync(root, 0o700);
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        fs.chmodSync(folder, 0o700);
        const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
          fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
          fs.renameSync(temp, filename);
        } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      } catch {} // Cache persistence must not turn a valid lookup into a failure.
      retryAfter.delete(filename);
      return value;
    });
    inflight.set(filename, pending);
    try { return await pending; }
    catch (error) {
      if (ahead) {
        if (retryAfter.size >= 128) retryAfter.delete(retryAfter.keys().next().value);
        retryAfter.set(filename, now() + 60000);
      }
      throw error;
    } finally { inflight.delete(filename); }
  };
}

module.exports = { createDiskCache };

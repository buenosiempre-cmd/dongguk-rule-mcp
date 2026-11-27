'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PRODUCER = 'dongguk-rule-mcp/semantic-retention';
const META = 'semantic-v1.json';
const LOCK = '.semantic-publish.lock';
const FILE = /^semantic-v1\.([a-f0-9]{64})\.bin$/;
const GRACE_MS = 60 * 60 * 1000;
const latestCleanup = new Map();
const coded = code => Object.assign(new Error(code), { code });
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
function stat(file) { try { return fs.lstatSync(file); } catch { return null; } }
function safeFolder(folder) {
  const value = stat(folder);
  return !!value?.isDirectory() && !value.isSymbolicLink();
}
function plainFile(file) {
  const value = stat(file);
  return value?.isFile() && !value.isSymbolicLink() && value.nlink === 1 ? value : null;
}
function readJSON(file, maxBytes = Infinity) {
  const info = plainFile(file);
  if (!info || info.size > maxBytes) return null;
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')), info }; } catch { return null; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function lockRecord(file) {
  const data = readJSON(file, 2048);
  return data?.value?.producer === PRODUCER && Number.isSafeInteger(data.value.pid) && data.value.pid > 0 &&
    /^[a-f0-9]{32}$/.test(data.value.token) ? data : null;
}
function ownUnlink(file, info) {
  if (same(plainFile(file), info)) fs.unlinkSync(file);
}
function createLock(file) {
  const fd = fs.openSync(file, 'wx', 0o600);
  const info = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, JSON.stringify({ producer: PRODUCER, pid: process.pid, token: crypto.randomBytes(16).toString('hex') }));
  } catch (error) {
    try { ownUnlink(file, info); } catch {}
    throw error;
  } finally { fs.closeSync(fd); }
  return info;
}
function acquire(folder) {
  if (!safeFolder(folder)) throw coded('SEMANTIC_UNSAFE_DIRECTORY');
  const file = path.join(folder, LOCK);
  try { return { file, info: createLock(file) }; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const old = lockRecord(file);
  if (!old || alive(old.value.pid)) throw coded('SEMANTIC_PUBLISH_BUSY');
  // One reclaimer per dead owner's token prevents two stale readers from
  // unlinking the next writer's live lock. A crashed reclaimer fails closed.
  const claim = path.join(folder, `.semantic-reclaim.${old.value.token}.lock`);
  let claimInfo;
  try { claimInfo = createLock(claim); } catch { throw coded('SEMANTIC_RECLAIM_BLOCKED'); }
  try {
    const current = lockRecord(file);
    if (!current || !same(current.info, old.info) || current.value.token !== old.value.token || alive(current.value.pid)) {
      throw coded('SEMANTIC_PUBLISH_BUSY');
    }
    fs.unlinkSync(file);
    try { return { file, info: createLock(file) }; } catch (error) {
      if (error.code === 'EEXIST') throw coded('SEMANTIC_PUBLISH_BUSY');
      throw error;
    }
  } finally { try { ownUnlink(claim, claimInfo); } catch {} }
}
function withGenerationLock(folder, work) {
  const lock = acquire(folder);
  try { return work(); } finally { try { ownUnlink(lock.file, lock.info); } catch {} }
}

function readPublished(folder, validateMeta) {
  if (!safeFolder(folder)) return null;
  const data = readJSON(path.join(folder, META));
  try { return data && validateMeta(data.value) ? data : null; } catch { return null; }
}
function retentionOf(meta) {
  const tracking = meta?.retention;
  if (!tracking || tracking.producer !== PRODUCER || tracking.version !== 1 || !Array.isArray(tracking.generations) ||
      !(tracking.previous === null || (FILE.test(tracking.previous) && tracking.previous !== meta.vectorFile))) return null;
  const names = new Set();
  for (const record of tracking.generations) {
    if (!record || typeof record.file !== 'string' || !FILE.test(record.file) || names.has(record.file) ||
        record.hash !== FILE.exec(record.file)[1] || !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
        !Number.isSafeInteger(record.dev) || !Number.isSafeInteger(record.ino) || record.dev < 0 || record.ino < 0 ||
        !(record.retiredAt === null || (Number.isSafeInteger(record.retiredAt) && record.retiredAt >= 0)) ||
        (record.file === meta.vectorFile ? record.retiredAt !== null : record.retiredAt === null)) return null;
    names.add(record.file);
  }
  return names.has(meta.vectorFile) ? tracking : null;
}
function ownedStat(folder, record) {
  const info = plainFile(path.join(folder, record.file));
  return same(info, record) && info.size === record.bytes ? info : null;
}

// Called under the publication lock after writing the new vector. Older files
// without this writer's receipt are never adopted just because their name fits.
function trackGeneration(folder, meta, previousMeta, now) {
  const prior = retentionOf(previousMeta);
  const previous = previousMeta?.vectorFile === meta.vectorFile ? prior?.previous || null : previousMeta?.vectorFile || null;
  const generations = [];
  for (const record of prior?.generations || []) {
    if (record.file === meta.vectorFile || !ownedStat(folder, record)) continue;
    generations.push({ ...record, retiredAt: record.file === previousMeta.vectorFile ? now : record.retiredAt });
  }
  const info = plainFile(path.join(folder, meta.vectorFile));
  if (!info) throw coded('SEMANTIC_UNSAFE_VECTOR');
  generations.push({ file: meta.vectorFile, hash: meta.vectorHash, bytes: info.size, dev: info.dev, ino: info.ino, retiredAt: null });
  return { ...meta, retention: { producer: PRODUCER, version: 1, previous, generations } };
}

// Must run under the same writer lock as publication. A reader may retain the
// old pointer for an hour; after that, a delayed reader safely falls back.
function cleanGenerationsLocked(folder, validateMeta, now) {
  const report = { at: new Date(now).toISOString(), removedGenerations: 0, removedBytes: 0, skippedGenerations: 0, errors: [] };
  const published = readPublished(folder, validateMeta), meta = published?.value, tracking = retentionOf(meta);
  if (!tracking) report.errors.push('SEMANTIC_RETENTION_UNAVAILABLE');
  else for (const record of tracking.generations) {
    if (record.file === meta.vectorFile || record.file === tracking.previous || record.retiredAt === null || now - record.retiredAt < GRACE_MS) continue;
    const filename = path.join(folder, record.file), info = ownedStat(folder, record);
    if (!info) { if (stat(filename)) report.skippedGenerations++; continue; }
    try {
      // Never delete a user's replacement, a link, or bytes that no longer match
      // the exact generation this writer produced.
      const digest = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      if (digest !== record.hash || !same(ownedStat(folder, record), info)) { report.skippedGenerations++; continue; }
      const stillPublished = readPublished(folder, validateMeta);
      if (!stillPublished || !same(stillPublished.info, published.info) || JSON.stringify(stillPublished.value) !== JSON.stringify(meta)) {
        report.errors.push('SEMANTIC_POINTER_CHANGED'); break;
      }
      if (!safeFolder(folder)) { report.errors.push('SEMANTIC_UNSAFE_DIRECTORY'); break; }
      if (!same(ownedStat(folder, record), info)) { report.skippedGenerations++; continue; }
      fs.unlinkSync(filename);
      report.removedGenerations++; report.removedBytes += info.size;
    } catch { report.errors.push('SEMANTIC_GENERATION_DELETE_FAILED'); }
  }
  report.errors = [...new Set(report.errors)];
  latestCleanup.set(folder, report);
  return report;
}

function cleanupGenerations(folder, validateMeta, now = Date.now()) {
  try { return withGenerationLock(folder, () => cleanGenerationsLocked(folder, validateMeta, now)); }
  catch (error) {
    const report = { at: new Date(now).toISOString(), removedGenerations: 0, removedBytes: 0, skippedGenerations: 0,
      errors: [String(error.code || '').startsWith('SEMANTIC_') ? error.code : 'SEMANTIC_GENERATION_CLEANUP_FAILED'] };
    latestCleanup.set(folder, report); return report;
  }
}

function generationStatus(folder, validateMeta, now = Date.now()) {
  const report = { trackingAvailable: false, graceMs: GRACE_MS, generationCount: 0, totalBytes: 0,
    managedGenerations: 0, managedBytes: 0, protectedGenerations: 0, graceGenerations: 0, graceExpiredCandidates: 0,
    untrackedGenerations: 0, untrackedBytes: 0, ignoredEntries: 0, publicationLocked: false,
    candidateHashesVerified: false, lastCleanupScope: 'process', lastCleanup: latestCleanup.get(folder) || null };
  if (!safeFolder(folder)) return { ...report, code: stat(folder) ? 'SEMANTIC_UNSAFE_DIRECTORY' : 'SEMANTIC_DIRECTORY_MISSING' };
  try {
    const meta = readPublished(folder, validateMeta)?.value, tracking = retentionOf(meta);
    report.trackingAvailable = !!tracking;
    report.publicationLocked = !!stat(path.join(folder, LOCK));
    const owned = new Map((tracking?.generations || []).map(record => [record.file, record]));
    for (const file of fs.readdirSync(folder)) {
      if (!FILE.test(file) && file !== 'semantic-v1.bin') continue;
      const info = plainFile(path.join(folder, file));
      if (!info) { report.ignoredEntries++; continue; }
      report.generationCount++; report.totalBytes += info.size;
      const protectedFile = file === meta?.vectorFile || file === tracking?.previous;
      if (protectedFile) report.protectedGenerations++;
      const record = owned.get(file);
      if (!record || !ownedStat(folder, record)) { report.untrackedGenerations++; report.untrackedBytes += info.size; continue; }
      report.managedGenerations++; report.managedBytes += info.size;
      if (!protectedFile) {
        if (now - record.retiredAt < GRACE_MS) report.graceGenerations++;
        else report.graceExpiredCandidates++;
      }
    }
    return report;
  } catch { return { ...report, code: 'SEMANTIC_GENERATION_STATUS_FAILED' }; }
}

module.exports = { GRACE_MS, withGenerationLock, readPublished, trackGeneration, cleanGenerationsLocked, cleanupGenerations, generationStatus };

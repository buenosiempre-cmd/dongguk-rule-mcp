'use strict';

// HTTP policy is shared by every MCP endpoint. No request text, headers, or
// credential identifiers are written to logs or returned by the status API.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

function isLoopback(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || (net.isIPv4(value) && value.startsWith('127.'));
}

function parseExpiry(value) {
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse silently normalizes dates such as February 30 or 24:00.
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value);
}

function readTokenFile(filename) {
  if (fs.statSync(filename).size > 4 * 1024 * 1024) throw new Error('토큰 파일은 4 MiB 이하여야 합니다.');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('토큰 파일은 유효한 JSON이어야 합니다.'); }
  if (!parsed || !Array.isArray(parsed.tokens) || !parsed.tokens.length || parsed.tokens.length > 16384) {
    throw new Error('토큰 파일에는 1~16384개의 tokens 항목이 필요합니다.');
  }
  const digests = new Set();
  return parsed.tokens.map(entry => {
    if (!entry || typeof entry.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry.sha256)) {
      throw new Error('각 토큰의 sha256은 64자리 SHA-256 hex여야 합니다.');
    }
    if (digests.has(entry.sha256.toLowerCase())) throw new Error('토큰 파일의 sha256은 중복될 수 없습니다.');
    digests.add(entry.sha256.toLowerCase());
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('enabled는 boolean이어야 합니다.');
    if (entry.admin !== undefined && typeof entry.admin !== 'boolean') throw new Error('admin은 boolean이어야 합니다.');
    const endpoints = entry.endpoints === undefined ? ['/mcp/rules'] : entry.endpoints;
    if (!Array.isArray(endpoints) || endpoints.some(p => typeof p !== 'string' || !/^\/[a-zA-Z0-9/_-]+$/.test(p))) {
      throw new Error('endpoints는 MCP 경로 문자열 배열이어야 합니다.');
    }
    let expiresAt = Infinity;
    if (entry.expiresAt !== undefined) {
      expiresAt = parseExpiry(entry.expiresAt);
      if (!Number.isFinite(expiresAt)) throw new Error('expiresAt는 실제 존재하는 날짜와 시각의 ISO 문자열이어야 합니다.');
    }
    return { digest: Buffer.from(entry.sha256, 'hex'), enabled: entry.enabled !== false, expiresAt, endpoints, admin: entry.admin === true };
  });
}

function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} 설정 범위: ${min}~${max}`);
  return n;
}

function validateConfiguration(options = {}) {
  const host = options.host || '127.0.0.1';
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  const credentials = options.tokenFile ? readTokenFile(options.tokenFile) : [];
  if (token) credentials.push({ digest: crypto.createHash('sha256').update(token).digest(), enabled: true, expiresAt: Infinity, endpoints: null, admin: true });
  const configuredAuth = Boolean(token || options.tokenFile);
  if (!isLoopback(host) && !credentials.some(c => c.enabled && c.expiresAt > Date.now())) {
    throw new Error('공개 주소 바인딩에는 유효한 Bearer 토큰이 필요합니다. --token 또는 --token-file을 설정하세요.');
  }
  const endpointFactories = options.endpointFactories || { '/mcp': options.createServer };
  if (!Object.keys(endpointFactories).length || Object.entries(endpointFactories).some(([p, factory]) => !/^\/[a-zA-Z0-9/_-]+$/.test(p) || typeof factory !== 'function' || ['/health','/ready','/status'].includes(p))) {
    throw new Error('endpointFactories에는 MCP 경로와 서버 팩토리가 필요합니다.');
  }
  const allowedOrigins = options.allowedOrigins || [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(origin => {
    try { const u = new URL(origin); return !['http:', 'https:'].includes(u.protocol) || u.origin !== origin; } catch { return true; }
  })) throw new Error('allowedOrigins에는 scheme과 host로 된 정확한 origin 주소만 사용할 수 있습니다.');
  return {
    host, credentials, configuredAuth, endpointFactories, allowedOrigins,
    publicPage: typeof options.publicPage === 'string' ? options.publicPage : '',
    version: String(options.version || 'unknown'),
    maxConcurrent: integer(options.maxConcurrent, 8, 1, 256, 'maxConcurrent'),
    maxQueue: integer(options.maxQueue, 32, 0, 4096, 'maxQueue'),
    queueTimeoutMs: integer(options.queueTimeoutMs, 15000, 10, 300000, 'queueTimeoutMs'),
    bodyTimeoutMs: integer(options.bodyTimeoutMs, 10000, 10, 300000, 'bodyTimeoutMs'),
    maxBodyBytes: integer(options.maxBodyBytes, 1000000, 128, 10000000, 'maxBodyBytes'),
    shutdownTimeoutMs: integer(options.shutdownTimeoutMs, 10000, 10, 60000, 'shutdownTimeoutMs'),
  };
}

function problem(status, message, rpcCode = -32000) {
  return Object.assign(new Error(message), { status, rpcCode });
}

function readBody(req, { maxBodyBytes, bodyTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false, size = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) { req.pause(); reject(error); } else resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) finish(problem(413, 'Request body too large'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(problem(400, 'Request body could not be read', -32700));
    const onAborted = () => finish(problem(499, 'Client disconnected'));
    const timer = setTimeout(() => finish(problem(408, 'Request body timeout')), bodyTimeoutMs);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    const length = req.headers['content-length'];
    if (length && Number(length) > maxBodyBytes) finish(problem(413, 'Request body too large'));
    else if (req.aborted || req.destroyed) onAborted();
  });
}

function createHttpServer(options = {}) {
  const config = validateConfiguration(options);
  // File duplicates have already been rejected. The separately configured
  // legacy token is appended last and deliberately retains administrator and
  // all-endpoint access if its digest also occurs in the member token file.
  const credentialsByDigest = new Map(config.credentials.map(credential => [credential.digest.toString('hex'), credential]));
  const unknownDigest = Buffer.alloc(32);
  const startedAt = Date.now();
  const queue = [], sockets = new Set(), running = new Set();
  let active = 0, peakActive = 0, peakQueued = 0, draining = false, shutdownPromise;
  const counters = { requests: 0, completed: 0, unauthorized: 0, forbidden: 0, rejected: 0, errors: 0 };

  function authenticate(header) {
    if (!config.configuredAuth) return null;
    // Hash both sides first so comparisons always operate on fixed-size buffers.
    const candidate = typeof header === 'string' && /^Bearer /i.test(header) ? header.slice(7) : '';
    const digest = crypto.createHash('sha256').update(candidate).digest();
    const credential = credentialsByDigest.get(digest.toString('hex'));
    const same = crypto.timingSafeEqual(digest, credential?.digest || unknownDigest);
    return same && candidate && credential?.enabled && credential.expiresAt > Date.now() ? credential : null;
  }

  function json(res, status, value, headers = {}) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(value));
  }
  function rejectRequest(req, res, error) {
    if (error.status === 499) return;
    const status = error.status || 500;
    if (status >= 500) counters.errors++;
    const headers = { Connection: 'close' };
    if (status === 401) headers['WWW-Authenticate'] = 'Bearer realm="dongguk-rule-mcp"';
    if (status === 429 || status === 503) headers['Retry-After'] = '5';
    json(res, status, { jsonrpc: '2.0', error: { code: error.rpcCode || -32000, message: error.status ? error.message : 'Internal server error' }, id: null }, headers);
    // Let the error response flush before closing unread input. Destroying req
    // inside a data callback loses the 413 response on real TCP connections.
    req.resume();
  }

  function releaseSlot() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      while (!draining && active < config.maxConcurrent && queue.length) {
        const entry = queue.shift();
        entry.cleanup();
        active++;
        peakActive = Math.max(peakActive, active);
        entry.resolve(releaseSlot());
      }
    };
  }
  function acquire(req, res) {
    if (draining) return Promise.reject(problem(503, 'Server is shutting down'));
    if (active < config.maxConcurrent) { active++; peakActive = Math.max(peakActive, active); return Promise.resolve(releaseSlot()); }
    if (queue.length >= config.maxQueue) { counters.rejected++; return Promise.reject(problem(429, 'Server is busy; retry later')); }
    return new Promise((resolve, reject) => {
      const remove = error => {
        const i = queue.indexOf(entry);
        if (i < 0) return;
        queue.splice(i, 1);
        entry.cleanup();
        reject(error);
      };
      const onClose = () => remove(problem(499, 'Client disconnected'));
      const timer = setTimeout(() => { counters.rejected++; remove(problem(429, 'Server queue timeout; retry later')); }, config.queueTimeoutMs);
      const entry = { resolve, reject, cleanup: () => { clearTimeout(timer); res.removeListener('close', onClose); } };
      res.once('close', onClose);
      queue.push(entry);
      peakQueued = Math.max(peakQueued, queue.length);
    });
  }

  const httpServer = http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    counters.requests++;
    // IncomingMessage can emit an error after its aborted event. Body readers
    // remove their listeners when settled; keep a harmless terminal listener.
    req.on('error', () => {});
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { rejectRequest(req, res, problem(400, 'Invalid URL')); return; }

    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      counters.forbidden++;
      rejectRequest(req, res, problem(403, 'Origin is not allowed')); return;
    }
    if (!config.configuredAuth && isLoopback(config.host)) {
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch {}
      if (!hostname || !isLoopback(hostname)) {
        rejectRequest(req, res, problem(403, 'Host is not allowed')); return;
      }
    }

    if (config.publicPage && (pathname === '/' || pathname === '/guide')) {
      if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' }); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(config.publicPage); return;
    }
    if (pathname === '/health' || pathname === '/ready') {
      if (!['GET','HEAD'].includes(req.method)) { json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' }); return; }
      const ready = !draining && (active < config.maxConcurrent || queue.length < config.maxQueue);
      const status = pathname === '/ready' && !ready ? 503 : 200;
      json(res, status, { status: pathname === '/ready' ? (ready ? 'ready' : 'unavailable') : 'ok', name: 'dongguk-rule-mcp', version: config.version, transport: 'streamable-http', ...(pathname === '/ready' ? { scope: 'process-admission' } : {}) }); return;
    }
    if (pathname !== '/status' && !Object.prototype.hasOwnProperty.call(config.endpointFactories, pathname)) {
      json(res, 404, { error: 'not found' }); return;
    }
    const credential = authenticate(req.headers.authorization);
    if ((config.configuredAuth && !credential) || (pathname === '/status' && !credential)) {
      counters.unauthorized++;
      rejectRequest(req, res, problem(401, 'Unauthorized: Bearer 토큰이 필요합니다', -32001)); return;
    }
    if (credential && ((pathname === '/status' && !credential.admin) || (pathname !== '/status' && credential.endpoints && !credential.endpoints.includes(pathname)))) {
      counters.forbidden++;
      rejectRequest(req, res, problem(403, 'Token does not permit this endpoint')); return;
    }
    if (pathname === '/status') {
      if (!['GET','HEAD'].includes(req.method)) { json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' }); return; }
      json(res, 200, httpServer.getStatus()); return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed — stateless HTTP는 POST만 지원' }, id: null }, { Allow: 'POST' }); return;
    }
    let release, server, transport;
    const operation = { close: async () => {
      await Promise.allSettled([Promise.resolve().then(() => server?.close()), Promise.resolve().then(() => transport?.close())]);
    } };
    try {
      release = await acquire(req, res);
      const text = await readBody(req, config);
      let body;
      try { body = JSON.parse(text); } catch { throw problem(400, 'Parse error: 유효한 JSON이 아닙니다', -32700); }
      // A batch bypasses the HTTP concurrency budget by dispatching many tool
      // handlers inside one transport. MCP's current HTTP protocol is singular.
      if (Array.isArray(body)) throw problem(400, 'JSON-RPC batch requests are not supported', -32600);
      if (!body || typeof body !== 'object') throw problem(400, 'Invalid JSON-RPC request', -32600);
      if (res.destroyed) throw problem(499, 'Client disconnected');
      running.add(operation);
      server = await config.endpointFactories[pathname]();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      // Keep the slot until the handler actually settles, even if its client
      // disconnects. Closing the SDK transport early strands JSON promises and
      // permits canceled clients to start unbounded background work.
      await transport.handleRequest(req, res, body);
      counters.completed++;
    } catch (error) {
      rejectRequest(req, res, error);
    } finally {
      await operation.close();
      running.delete(operation);
      release?.();
    }
  });
  httpServer.requestTimeout = config.queueTimeoutMs + config.bodyTimeoutMs + 1000;
  httpServer.headersTimeout = Math.min(10000, httpServer.requestTimeout);
  httpServer.keepAliveTimeout = 5000;
  httpServer.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  httpServer.getStatus = () => ({
    status: draining ? 'draining' : 'ok', name: 'dongguk-rule-mcp', version: config.version,
    transport: 'streamable-http', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    activeRequests: active, queuedRequests: queue.length,
    peakActiveRequests: peakActive, peakQueuedRequests: peakQueued,
    limits: { maxConcurrent: config.maxConcurrent, maxQueue: config.maxQueue, maxBodyBytes: config.maxBodyBytes, bodyTimeoutMs: config.bodyTimeoutMs, queueTimeoutMs: config.queueTimeoutMs },
    counters: { ...counters },
  });
  httpServer.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    draining = true;
    for (const entry of queue.splice(0)) { entry.cleanup(); entry.reject(problem(503, 'Server is shutting down')); }
    shutdownPromise = new Promise(resolve => {
      let finished = false;
      const finish = forced => { if (finished) return; finished = true; clearTimeout(timer); resolve({ forced }); };
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        for (const operation of running) operation.close().catch(() => {});
        httpServer.closeAllConnections?.();
        finish(true);
      }, config.shutdownTimeoutMs);
      httpServer.close(() => finish(false));
      httpServer.closeIdleConnections?.();
    });
    return shutdownPromise;
  };
  return httpServer;
}

module.exports = { createHttpServer, validateConfiguration, readTokenFile, isLoopback };

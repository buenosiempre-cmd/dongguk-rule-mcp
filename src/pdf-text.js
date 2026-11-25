'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxPages: 200, maxChars: 1000000, timeoutMs: 10000, concurrency: 2 });
const error = code => Object.assign(new Error(code), { code });
let active = 0;
function validatePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).toString('ascii').startsWith('%PDF-')) throw error('PDF_INVALID');
  if (buffer.length > LIMITS.maxBytes) throw error('PDF_TOO_LARGE');
}
async function extractPdfText(buffer, { signal, timeoutMs = LIMITS.timeoutMs } = {}) {
  validatePdf(buffer);
  if (signal?.aborted) throw error('TOTAL_TIMEOUT');
  if (active >= LIMITS.concurrency) throw error('PDF_PARSE_BUSY');
  active++;
  let worker;
  try {
    worker = new Worker(__filename, { workerData: { kind: 'pdf-text', data: buffer }, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    // Parser diagnostics must not corrupt the stdio MCP protocol.
    worker.stdout.resume(); worker.stderr.resume();
    return await new Promise((resolve, reject) => {
      const stop = () => reject(error('TOTAL_TIMEOUT'));
      const timer = setTimeout(() => reject(error('PDF_PARSE_TIMEOUT')), Math.min(timeoutMs, LIMITS.timeoutMs));
      signal?.addEventListener('abort', stop, { once: true });
      worker.once('message', message => message.ok ? resolve(message.result) : reject(error(message.code)));
      worker.once('error', () => reject(error('PDF_PARSE_FAILED')));
      worker.once('exit', () => reject(error('PDF_PARSE_FAILED')));
      // The caller's finally terminates the worker even on abort or parser timeout.
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
      worker.once('exit', cleanup);
      worker.once('message', cleanup);
    });
  } finally { if (worker) await worker.terminate(); active--; }
}
if (!isMainThread && workerData?.kind === 'pdf-text') {
  (async () => {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(workerData.data), isEvalSupported: false, useSystemFonts: false, useWorkerFetch: false });
    try {
      const info = await parser.getInfo();
      if (info.total > LIMITS.maxPages) throw error('PDF_TOO_MANY_PAGES');
      const result = await parser.getText({ lineEnforce: true, pageJoiner: '\n' });
      if (!result.text?.trim()) throw error('PDF_NO_TEXT');
      if (result.text.length > LIMITS.maxChars) throw error('PDF_TEXT_TOO_LARGE');
      parentPort.postMessage({ ok: true, result: { text: result.text, pages: info.total } });
    } finally { await parser.destroy(); }
  })().catch(e => parentPort.postMessage({ ok: false, code: ['PDF_TOO_MANY_PAGES','PDF_NO_TEXT','PDF_TEXT_TOO_LARGE'].includes(e.code) ? e.code : 'PDF_PARSE_FAILED' }));
}
module.exports = { extractPdfText, validatePdf, LIMITS };

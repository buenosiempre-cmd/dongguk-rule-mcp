'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateQuestions } = require('./benchmark-natural-language');
const OPEN_FILE = path.join(__dirname, '../experiments/appendix/fixtures/dev-open-t3y-20261127.json');
const OPEN_SHA = '4ac646c4c649bb00c37bdb28cb78e557a2c418ae98f3fef09c627ad276ffded3';

function parseApprovedQuestions(bytes) {
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== OPEN_SHA) throw new Error('OPEN_QUESTIONS_HASH_MISMATCH');
  const rows = validateQuestions(JSON.parse(bytes));
  if (rows.length !== 20 || rows.some(Array.isArray)) throw new Error('OPEN_QUESTIONS_SCHEMA_MISMATCH');
  return rows.map(row => ({ ...row, split: 'open-dev' }));
}
function loadOpenQuestions() {
  return { questions: parseApprovedQuestions(fs.readFileSync(OPEN_FILE)), file: OPEN_FILE, sha256: OPEN_SHA };
}
module.exports = { OPEN_FILE, OPEN_SHA, parseApprovedQuestions, loadOpenQuestions };

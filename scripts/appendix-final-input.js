'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EXPECTED = {
  commit: '29bbf6625a46593797ffedeb348a00a99d71c44f',
  manifest: 'dbc6d1faa9b83f08e80784b1ff53b7b76708ebc0e5f20266230b0b452ae219e7',
  corpus: '830b69968e8f212450a9f152b890d6c78a4724d56d4b0a4e9b41caa18bdbd227',
  vector: 'fd7d662bb55c82f6d45f102866bc8e8837b046fdf7ac5658830c217a34de5def',
};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function verifyHandoff(root) {
  const file = path.join(root, 'manifest.json');
  if (hash(file) !== EXPECTED.manifest) throw new Error('FINAL_MANIFEST_MISMATCH');
  const manifest = JSON.parse(fs.readFileSync(file));
  const pub = path.join(root, manifest.publicRelativePath);
  if (manifest.sourceCommit !== EXPECTED.commit || manifest.corpusSha256 !== EXPECTED.corpus ||
      manifest.vectorSha256 !== EXPECTED.vector || manifest.entries.length !== 733) throw new Error('FINAL_IDENTITY_MISMATCH');
  const actual = [];
  for (const folder of fs.readdirSync(pub)) for (const name of fs.readdirSync(path.join(pub, folder))) actual.push(folder + '/' + name);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(manifest.entries.map(e => e.path).sort())) throw new Error('FINAL_FILE_SET_MISMATCH');
  for (const entry of manifest.entries) {
    const filename = path.join(pub, entry.path);
    if (fs.statSync(filename).size !== entry.bytes || hash(filename) !== entry.sha256) throw new Error('FINAL_FILE_HASH_MISMATCH: ' + entry.path);
  }
  return { ...EXPECTED, public: pub, files: manifest.files, bytes: manifest.bytes, vectorFile: manifest.vectorFile };
}
const AUX_MANIFEST = 'cc3c9fd1c09456c928d6444188b83e246941ec06756a0cbffe92e15fb52b6bf0';
function verifyAux(root) {
  if (hash(path.join(root, 'manifest.json')) !== AUX_MANIFEST) throw new Error('AUX_MANIFEST_MISMATCH');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  if (manifest.files.length !== 673) throw new Error('AUX_FILE_COUNT_MISMATCH');
  for (const entry of manifest.files) {
    const file = path.join(root, entry.path);
    if (fs.statSync(file).size !== entry.bytes || hash(file) !== entry.sha256) throw new Error('AUX_FILE_HASH_MISMATCH: ' + entry.path);
  }
  return { manifest: AUX_MANIFEST, files: manifest.files.length,
    harness: hash(path.join(root, 'harness/harness-d1.js')), launcher: hash(path.join(root, 'harness/run2.sh')) };
}
module.exports = { EXPECTED, hash, verifyHandoff, verifyAux };

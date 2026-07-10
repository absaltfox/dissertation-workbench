import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let fetchPdfForDocument;
let _setDownloadSafetyOptionsForTests;
let closeDb;
const originalFetch = globalThis.fetch;

const RECORD_URL = 'https://circle.library.ubc.ca/rest/handle/2429/12345';
const doc = { id: '1.0099999', originalRecordUrl: RECORD_URL };

function fakeResponse({ status = 200, body = '', contentType = 'application/json', url = '' }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name) => {
        const lower = String(name).toLowerCase();
        if (lower === 'content-type') return contentType;
        if (lower === 'content-length') return String(bytes.length);
        return null;
      },
    },
    json: async () => JSON.parse(bytes.toString('utf8')),
    text: async () => bytes.toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-download-safety-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  const pdf = await import('../src/pdf.js');
  fetchPdfForDocument = pdf.fetchPdfForDocument;
  _setDownloadSafetyOptionsForTests = pdf._setDownloadSafetyOptionsForTests;
  _setDownloadSafetyOptionsForTests({
    resolveHost: async () => [{ address: '142.103.96.1' }],
  });
  ({ closeDb } = await import('../src/db.js'));
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  _setDownloadSafetyOptionsForTests(null);
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

function mockBitstreamFetch(retrieveResponse) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/rest/handle/')) {
      return fakeResponse({
        body: JSON.stringify({
          id: 77,
          bitstreams: [{ id: 9, mimeType: 'application/pdf', bundleName: 'ORIGINAL', name: 'thesis.pdf' }],
        }),
      });
    }
    if (url.includes('/rest/bitstreams/9/retrieve')) return retrieveResponse(url);
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

test('block pages served as PDFs are detected and reported as blocked', async () => {
  mockBitstreamFetch((url) => fakeResponse({
    body: '<html>Your request was blocked because our system detected unusual activity. Reference ID: abc. Sorry for the inconvenience.</html>',
    contentType: 'text/html',
    url,
  }));
  const result = await fetchPdfForDocument(doc);
  assert.equal(result.blocked, true);
});

test('non-PDF bodies without block markers are rejected', async () => {
  mockBitstreamFetch((url) => fakeResponse({ body: 'not a pdf', contentType: 'text/plain', url }));
  const result = await fetchPdfForDocument(doc);
  assert.equal(result, null);
});

test('real PDF bytes are accepted', async () => {
  mockBitstreamFetch((url) => fakeResponse({
    body: Buffer.from('%PDF-1.4 fake body'),
    contentType: 'application/pdf',
    url,
  }));
  const result = await fetchPdfForDocument(doc);
  assert.equal(Boolean(result?.bytes?.length), true);
  assert.equal(result.blocked, undefined);
});

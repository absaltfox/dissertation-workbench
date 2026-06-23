import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzePdfAtPath,
  detectDownloadBlockPage,
  fetchPdfForDocument,
  fetchFullTextForDocument,
  parseAcknowledgements,
  parseCommittee,
  parseBibliography,
  extractBodyWordCount
} from '../src/pdf.js';

async function writeOnePagePdfWithExtraPageToken(filePath) {
  const stream = 'BT /F1 12 Tf 72 720 Td (This stream mentions /Type /Page but is still one page.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  await fs.writeFile(filePath, body, 'binary');
}

test('detectDownloadBlockPage identifies UBC/F5 security block HTML', () => {
  const html = `
    <h4>Sorry for the inconvenience.</h4>
    <p>Your request was blocked because our system detected unusual activity.</p>
    <p>Reference ID: ITSA - <12345></p>
  `;

  assert.equal(detectDownloadBlockPage(html), true);
  assert.equal(detectDownloadBlockPage('<html><a href="/file.pdf">Download</a></html>'), false);
});

test('fetchFullTextForDocument retrieves cIRcle TEXT bitstream from original record URL', async () => {
  const originalFetch = globalThis.fetch;
  const longText = `A dissertation full text\n${'education '.repeat(200)}`;
  const requested = [];

  globalThis.fetch = async (url) => {
    const textUrl = String(url);
    requested.push(textUrl);
    if (textUrl.includes('/rest/handle/2429/93916')) {
      return {
        ok: true,
        json: async () => ({ id: 119703 }),
      };
    }
    if (textUrl.includes('/rest/items/119703/bitstreams')) {
      return {
        ok: true,
        json: async () => ([
          { id: 512600, bundleName: 'ORIGINAL', mimeType: 'application/pdf', name: 'doc.pdf' },
          { id: 512974, bundleName: 'TEXT', mimeType: 'text/plain', name: 'doc.pdf.txt' },
        ]),
      };
    }
    if (textUrl.includes('/rest/bitstreams/512974/retrieve')) {
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain; charset=UTF-8' }),
        text: async () => longText,
      };
    }
    return { ok: false };
  };

  try {
    const result = await fetchFullTextForDocument({
      id: '1.0451810',
      originalRecordUrl: 'http://circle.library.ubc.ca/rest/handle/2429/93916?expand=metadata',
    });

    assert.equal(result.fullText, longText);
    assert.equal(result.cacheHit, false);
    assert.ok(result.fullTextPath.endsWith('.txt'));
    assert.equal(await fs.readFile(result.fullTextPath, 'utf8'), longText);
    assert.ok(requested[0].startsWith('https://circle.library.ubc.ca/rest/handle/2429/93916'));
    assert.ok(requested.some((url) => url.includes('/rest/bitstreams/512974/retrieve')));
    await fs.unlink(result.fullTextPath).catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPdfForDocument retrieves ORIGINAL PDF bitstream from cIRcle REST', async () => {
  const originalFetch = globalThis.fetch;
  const pdfBytes = Buffer.from('%PDF-1.3\n%%EOF');
  const requested = [];

  globalThis.fetch = async (url) => {
    const textUrl = String(url);
    requested.push(textUrl);
    if (textUrl.includes('/rest/handle/2429/93916')) {
      return {
        ok: true,
        json: async () => ({ id: 119703 }),
      };
    }
    if (textUrl.includes('/rest/items/119703/bitstreams')) {
      return {
        ok: true,
        json: async () => ([
          { id: 512974, bundleName: 'TEXT', mimeType: 'text/plain', name: 'doc.pdf.txt' },
          { id: 512600, bundleName: 'ORIGINAL', mimeType: 'application/pdf', name: 'doc.pdf' },
        ]),
      };
    }
    if (textUrl.includes('/rest/bitstreams/512600/retrieve')) {
      return {
        ok: true,
        url: textUrl,
        headers: new Headers({
          'content-type': 'application/pdf',
          'content-length': String(pdfBytes.length),
        }),
        arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength),
      };
    }
    return { ok: false };
  };

  try {
    const result = await fetchPdfForDocument({
      id: '1.0451810',
      originalRecordUrl: 'http://circle.library.ubc.ca/rest/handle/2429/93916?expand=metadata',
    });

    assert.equal(result.bitstreamId, 512600);
    assert.equal(result.downloadUrl, 'https://circle.library.ubc.ca/rest/bitstreams/512600/retrieve');
    assert.deepEqual(result.bytes, pdfBytes);
    assert.ok(requested.some((url) => url.includes('/rest/bitstreams/512600/retrieve')));
    assert.equal(requested.some((url) => url.includes('/media/download/pdf/')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchFullTextForDocument uses cached full text without network access', async () => {
  const originalFetch = globalThis.fetch;
  const cachedPath = new URL(`../data/full-text-cache/test-${Date.now()}.txt`, import.meta.url);
  const cachedText = `Cached dissertation text\n${'school '.repeat(200)}`;
  await fs.mkdir(new URL('../data/full-text-cache/', import.meta.url), { recursive: true });
  await fs.writeFile(cachedPath, cachedText, 'utf8');
  globalThis.fetch = async () => {
    throw new Error('network should not be called for cached full text');
  };

  try {
    const result = await fetchFullTextForDocument({
      id: 'cached-doc',
      originalRecordUrl: 'http://circle.library.ubc.ca/rest/handle/2429/93916?expand=metadata',
    }, {
      full_text_path: cachedPath.pathname,
      full_text_source_url: 'https://circle.library.ubc.ca/rest/bitstreams/512974/retrieve',
    });

    assert.equal(result.fullText, cachedText);
    assert.equal(result.cacheHit, true);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.unlink(cachedPath).catch(() => {});
  }
});

test('analyzePdfAtPath prefers pdfinfo page count over raw page-token scan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-page-count-'));
  const pdfPath = path.join(dir, 'one-page-extra-token.pdf');
  try {
    await writeOnePagePdfWithExtraPageToken(pdfPath);
    const result = await analyzePdfAtPath(pdfPath);
    assert.equal(result.pageCount, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseAcknowledgements extracts supervisors, co-supervisors, and committee members', () => {
  // Test case 1: Singular supervisor and committee members listing
  const ackText1 = `ACKNOWLEDGEMENTS
First, I would like to express my supervisor, Dr. Jane Smith, for her patience...
I also thank my committee members: Dr. Robert Brown and Dr. Lily White.
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res1 = parseAcknowledgements(ackText1);
  assert.ok(res1.some((m) => m.name === 'Jane Smith' && m.role === 'Supervisor'));
  assert.ok(res1.some((m) => m.name === 'Robert Brown' && m.role === 'Supervisory Committee Member'));
  assert.ok(res1.some((m) => m.name === 'Lily White' && m.role === 'Supervisory Committee Member'));

  // Test case 2: Plural co-supervisors
  const ackText2 = `ACKNOWLEDGEMENTS
I would like to thank my supervisors, Dr. Alan Doe and Dr. Bob Jones, for their guidance.
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res2 = parseAcknowledgements(ackText2);
  assert.ok(res2.some((m) => m.name === 'Alan Doe' && m.role === 'Co-Supervisor'));
  assert.ok(res2.some((m) => m.name === 'Bob Jones' && m.role === 'Co-Supervisor'));

  // Test case 3: Parenthesised roles
  const ackText3 = `ACKNOWLEDGEMENTS
Thank you to Dr. John Watson (Supervisor) and Dr. Sherlock Holmes (Co-Supervisor).
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res3 = parseAcknowledgements(ackText3);
  assert.ok(res3.some((m) => m.name === 'John Watson' && m.role === 'Supervisor'));
  assert.ok(res3.some((m) => m.name === 'Sherlock Holmes' && m.role === 'Co-Supervisor'));

  // Test case 4: Bare name list (consisting of...)
  const ackText4 = `ACKNOWLEDGEMENTS
I am grateful to my research committee consisting of Tom Sork, Pierre Walter and Robert VanWynsberghe.
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res4 = parseAcknowledgements(ackText4);
  assert.ok(res4.some((m) => m.name === 'Tom Sork' && m.role === 'Supervisory Committee Member'));
  assert.ok(res4.some((m) => m.name === 'Pierre Walter' && m.role === 'Supervisory Committee Member'));
  assert.ok(res4.some((m) => m.name === 'Robert VanWynsberghe' && m.role === 'Supervisory Committee Member'));

  // Test case 5: Older UBC acknowledgement prose with bare names before roles
  const ackText5 = `ACKNOWLEDGEMENTS
First, I want to recognize Don Fisher and Kjell Rubenson, my research cosupervisors,
for their many efforts. Peter Jones was the third member of my thesis committee.
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res5 = parseAcknowledgements(ackText5);
  assert.ok(res5.some((m) => m.name === 'Don Fisher' && m.role === 'Co-Supervisor'));
  assert.ok(res5.some((m) => m.name === 'Kjell Rubenson' && m.role === 'Co-Supervisor'));
  assert.ok(res5.some((m) => m.name === 'Peter Jones' && m.role === 'Supervisory Committee Member'));

  // Test case 6: Advisory Committee heading with plural "Drs."
  const ackText6 = `ACKNOWLEDGEMENTS
I am indebted to my Advisory Committee - Drs. Tom Sork, Shauna Butterwick, and Jim Frankish -
for their unfaltering support and care, their respect for my practice-based knowledge and experience,
and their ongoing efforts to challenge my thinking and strengthen this work.`;

  const res6 = parseAcknowledgements(ackText6);
  assert.ok(res6.some((m) => m.name === 'Tom Sork' && m.role === 'Supervisory Committee Member'));
  assert.ok(res6.some((m) => m.name === 'Shauna Butterwick' && m.role === 'Supervisory Committee Member'));
  assert.ok(res6.some((m) => m.name === 'Jim Frankish' && m.role === 'Supervisory Committee Member'));
});

test('parseCommittee parses different layout structures from exam cert pages', () => {
  // Test case 1: Pre-2016 format (name above role label)
  const committeeText1 = `The following individuals certify that they have read, and recommend to the Faculty of Graduate and Postdoctoral Studies...
John Smith, Professor, UBC
Supervisor
Alice Cooper, Associate Professor, SFU
Co-Supervisor`;

  const res1 = parseCommittee(committeeText1);
  assert.ok(res1.some((m) => m.name === 'John Smith' && m.role === 'Supervisor'));
  assert.ok(res1.some((m) => m.name === 'Alice Cooper' && m.role === 'Co-Supervisor'));

  // Test case 2: 2018+ format (role label above name)
  const committeeText2 = `The following individuals certify that they have read, and recommend to the Faculty...
Supervisor
John Smith, Professor, UBC
Co-Supervisor
Alice Cooper, SFU`;

  const res2 = parseCommittee(committeeText2);
  assert.ok(res2.some((m) => m.name === 'John Smith' && m.role === 'Supervisor'));
  assert.ok(res2.some((m) => m.name === 'Alice Cooper' && m.role === 'Co-Supervisor'));

  // Test case 3: 2019+ inline parenthesized format
  const committeeText3 = `The following individuals certify that they have read...
Tracy Friedel (Co-Supervisor)
Bob Dylan (Supervisor)`;

  const res3 = parseCommittee(committeeText3);
  assert.ok(res3.some((m) => m.name === 'Tracy Friedel' && m.role === 'Co-Supervisor'));
  assert.ok(res3.some((m) => m.name === 'Bob Dylan' && m.role === 'Supervisor'));
});

test('parseBibliography extracts lists of references and cleans OCR spacing artifacts', () => {
  const bibText = `Some introductory text about education.
REFERENCES

Smith, J. (2012). Learning Educational Theory. Journal of Education, 12(3), 45-67.

J o n e s, A. (2015). P r o f e s s i o n a l  Development of Teachers. Higher Education Press.`;

  const res = parseBibliography(bibText);

  assert.equal(res.length, 2);
  assert.ok(res[0].includes('Smith, J. (2012). Learning Educational Theory'));
  // Confirm OCR space collapse logic (e.g. "P r o f e s s i o n a l" -> "Professional")
  assert.ok(res[1].includes('Jones, A. (2015)'));
  assert.ok(res[1].includes('Professional  Development of Teachers'));
});

test('extractBodyWordCount excludes the bibliography section', () => {
  const fullText = `Introduction to the dissertation.
This is the body text which has some words in it.
These words should be counted towards the body word count.
REFERENCES
Smith, J. (2012). Some paper.
Jones, A. (2015). Another paper.`;

  const totalWords = fullText.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  const bodyWords = extractBodyWordCount(fullText);

  assert.ok(bodyWords < totalWords, `Expected body word count (${bodyWords}) to be less than total word count (${totalWords})`);
  assert.equal(bodyWords, 25); // Words: "Introduction to the dissertation. This is the body text which has some words in it. These words should be counted towards the body word count." -> 25 words
});

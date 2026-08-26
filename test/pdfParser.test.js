import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  analyzePdfAtPath,
  DEGRADED_WORD_SOURCE,
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

// Writes a valid single-page PDF whose only content is a filled rectangle: no
// text operators anywhere, i.e. exactly what a scanned / image-only dissertation
// looks like to pdftotext. pdftotext reads it fine and exits 0 with no text.
async function writeScannedImageOnlyPdf(filePath) {
  const stream = 'q 0.6 g 72 72 468 648 re f Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
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

// Writes a multi-page PDF whose content streams are FlateDecode-compressed, so
// the raw-byte Tj/TJ fallback can recover nothing and only pdftotext can read it.
// Sized so the extracted text is comfortably over execFile's 1 MB stdout limit.
const LARGE_PDF_MARKER = 'FINAL-LINE-MARKER-OK';

async function writeLargeFlatePdf(filePath, { pages = 400, linesPerPage = 40 } = {}) {
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod '.repeat(2);
  const contentStreams = [];
  for (let p = 0; p < pages; p += 1) {
    const lines = [];
    for (let i = 0; i < linesPerPage; i += 1) {
      // Keep the marker line short so it stays inside the MediaBox: pdftotext
      // clips glyphs drawn past the page edge, and the filler runs well past it.
      const isLast = p === pages - 1 && i === linesPerPage - 1;
      const body = isLast ? LARGE_PDF_MARKER : filler;
      lines.push(`(page${p} line${i} ${body}) Tj 0 -16 Td`);
    }
    const stream = `BT /F1 9 Tf 20 770 Td ${lines.join(' ')} ET`;
    contentStreams.push(zlib.deflateSync(Buffer.from(stream, 'latin1')));
  }

  // Object layout: 1 catalog, 2 pages, 3 font, 4.. page objects, then content streams.
  const firstPage = 4;
  const firstContent = firstPage + pages;
  const total = firstContent + pages - 1;
  const objects = [];
  objects[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pages }, (_, p) => `${firstPage + p} 0 R`);
  objects[2] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`);
  objects[3] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let p = 0; p < pages; p += 1) {
    objects[firstPage + p] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstContent + p} 0 R >>`
    );
    objects[firstContent + p] = Buffer.concat([
      Buffer.from(`<< /Length ${contentStreams[p].length} /Filter /FlateDecode >>\nstream\n`),
      contentStreams[p],
      Buffer.from('\nendstream'),
    ]);
  }

  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let offset = chunks[0].length;
  for (let i = 1; i <= total; i += 1) {
    const buf = Buffer.concat([Buffer.from(`${i} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    offsets[i] = offset;
    offset += buf.length;
    chunks.push(buf);
  }
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  await fs.writeFile(filePath, Buffer.concat(chunks));
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
          { id: 512973, bundleName: 'LICENSE', mimeType: 'text/plain', name: 'license.txt' },
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
    assert.equal(requested.some((url) => url.includes('/rest/bitstreams/512973/retrieve')), false);
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
    assert.equal(result.textSource, 'pdftotext');
    assert.equal(result.degraded, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Regression guard for H-01: pdftotext output used to be piped through
// execFile's 1 MB default maxBuffer, so any dissertation longer than ~150k words
// blew up with ERR_CHILD_PROCESS_STDIO_MAXBUFFER and silently degraded to the
// raw-byte fallback -- which recovers nothing from FlateDecode streams.
test('analyzePdfAtPath extracts text larger than the 1 MB stdout buffer intact', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-large-text-'));
  const pdfPath = path.join(dir, 'large.pdf');
  try {
    await writeLargeFlatePdf(pdfPath);
    const result = await analyzePdfAtPath(pdfPath);

    assert.equal(result.degraded, false);
    assert.equal(result.textSource, 'pdftotext');
    assert.equal(result.pageCount, 400);
    assert.ok(
      result.fullText.length > 1024 * 1024,
      `expected >1 MB of extracted text, got ${result.fullText.length}`
    );
    // Both ends present => the stream was not truncated at any buffer boundary.
    assert.ok(result.fullText.includes('page0 line0'));
    assert.ok(result.fullText.includes(LARGE_PDF_MARKER));
    assert.ok(result.fullText.includes('page399 line39'));
    assert.ok(result.wordCount > 150_000, `expected a large word count, got ${result.wordCount}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('analyzePdfAtPath flags raw-byte fallback extraction as degraded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-degraded-'));
  const pdfPath = path.join(dir, 'broken.pdf');
  try {
    // Not a readable PDF (no xref/trailer) so pdftotext exits non-zero, but it
    // still carries an uncompressed Tj operator the byte scanner can find.
    const bytes = Buffer.from('not really a pdf\nBT (Hidden fallback words here) Tj ET\n', 'latin1');
    await fs.writeFile(pdfPath, bytes);
    const result = await analyzePdfAtPath(pdfPath, bytes);

    assert.equal(result.degraded, true);
    assert.equal(result.textSource, 'raw_bytes_fallback');
    assert.ok(result.fullText.includes('Hidden fallback words here'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('analyzePdfAtPath reports degraded extraction with no recoverable text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-degraded-empty-'));
  const pdfPath = path.join(dir, 'broken.pdf');
  try {
    const bytes = Buffer.from('not really a pdf and no text operators at all\n', 'latin1');
    await fs.writeFile(pdfPath, bytes);
    const result = await analyzePdfAtPath(pdfPath, bytes);

    assert.equal(result.degraded, true);
    assert.equal(result.textSource, 'none');
    assert.equal(result.fullText, null);
    assert.equal(result.wordCount, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A scanned / image-only dissertation is a large, systematic population in a
// cIRcle-style archive, not an edge case. pdftotext succeeding and correctly
// reporting "no text layer" is an accurate result, so it must not be reported as
// a degraded parse -- `degraded` is what relabels a word count as untrustworthy.
test('analyzePdfAtPath reports an image-only PDF as an empty text layer, not degraded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-image-only-'));
  const pdfPath = path.join(dir, 'scanned.pdf');
  try {
    await writeScannedImageOnlyPdf(pdfPath);
    const bytes = await fs.readFile(pdfPath);
    // Both with and without bytes in hand: having bytes must not tip a clean
    // "no text layer" answer into the degraded raw-byte path.
    for (const result of [
      await analyzePdfAtPath(pdfPath),
      await analyzePdfAtPath(pdfPath, bytes),
    ]) {
      assert.equal(result.pageCount, 1);
      assert.equal(result.degraded, false);
      assert.equal(result.extractionStatus, 'empty_text_layer');
      assert.equal(result.textSource, 'empty_text_layer');
      assert.equal(result.wordCount, null);
      assert.equal(result.bodyWordCount, null);
      assert.equal(result.fullText, null);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed extraction is reported as extraction_failed, not an empty text layer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-extraction-failed-'));
  const pdfPath = path.join(dir, 'broken.pdf');
  try {
    const bytes = Buffer.from('not really a pdf\nBT (Hidden fallback words here) Tj ET\n', 'latin1');
    await fs.writeFile(pdfPath, bytes);
    assert.equal((await analyzePdfAtPath(pdfPath, bytes)).extractionStatus, 'extraction_failed');
    // Callers that pass no bytes reach the same verdict: pdfinfo also fails on an
    // unreadable file, so analyzePdfAtPath reads the bytes itself for the page scan.
    const withoutBytes = await analyzePdfAtPath(pdfPath);
    assert.equal(withoutBytes.extractionStatus, 'extraction_failed');
    assert.equal(withoutBytes.degraded, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('DEGRADED_WORD_SOURCE is treated as an unreliable word-count source', async () => {
  const { hasReliableWordCount } = await import('../src/metrics.js');
  assert.equal(DEGRADED_WORD_SOURCE, 'degraded_pdf_text');
  assert.equal(
    hasReliableWordCount({ wordCount: 200_000, wordCountSource: DEGRADED_WORD_SOURCE }),
    false
  );
  assert.equal(
    hasReliableWordCount({ wordCount: 200_000, wordCountSource: 'downloaded_pdf_text' }),
    true
  );
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

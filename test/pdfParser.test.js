import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  analyzePdfAtPath,
  DEGRADED_WORD_SOURCE,
  EXTRACTION_TEXT_TOO_LARGE,
  _setMaxPdfTextBytesForTests,
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

test('parseAcknowledgements recovers thesis 1.0094455 OCR spacing and bare advisor syntax', () => {
  const text = `ACKNOWLEDGEMENTS
I wish to thank my a d v i s o r, M i c h a e l Ignatieff, for his patient guidance
throughout the research and writing of this thesis. I am also grateful to my family,
friends, archivists, and the many communities who supported this project.`;

  assert.deepEqual(parseAcknowledgements(text), [
    { name: 'Michael Ignatieff', role: 'Supervisor', affiliation: null },
  ]);
});

test('parseAcknowledgements accepts conservative advisor variants and complex names', () => {
  const variants = [
    ['my adviser, Anne-Marie O\'Neill', 'Supervisor', "Anne-Marie O'Neill"],
    ['my thesis advisor: José de la Cruz', 'Supervisor', 'José de la Cruz'],
    ['my academic co-adviser — J. R. Smith', 'Co-Supervisor', 'J. R. Smith'],
  ];
  for (const [phrase, role, name] of variants) {
    const text = `ACKNOWLEDGEMENTS\nI am deeply grateful to ${phrase}, whose thoughtful guidance made this work possible.\nThe support of colleagues and friends sustained the project over many years.`;
    assert.ok(parseAcknowledgements(text).some((member) => member.name === name && member.role === role), phrase);
  }
});

test('parseAcknowledgements recognizes thesis/graduate adjective infix and titled advisor (Lever A)', () => {
  const positives = [
    ['my thesis supervisor, Professor Peter Boothroyd', 'Supervisor', 'Boothroyd'],
    ['my thesis advisor, Prof. R.A.J. McDonald', 'Supervisor', 'McDonald'],
    ['my research supervisor, Dr. Jane Smith', 'Supervisor', 'Smith'],
    ['my supervisor, Dr. John Doe', 'Supervisor', 'Doe'],
  ];
  for (const [phrase, role, surname] of positives) {
    const text = `ACKNOWLEDGEMENTS\n\nI am deeply grateful to ${phrase}, whose thoughtful guidance made this work possible.\nThe support of colleagues and friends sustained the project over many years and made a real difference.\n`;
    const members = parseAcknowledgements(text);
    assert.ok(
      members.some((m) => m.role === role && m.name.split(/\s+/).pop() === surname),
      `${phrase} -> expected surname ${surname}; got ${JSON.stringify(members)}`
    );
  }
});

test('parseAcknowledgements does not over-broaden the adjective-infix supervisor pattern', () => {
  const negatives = [
    'my supervisor was extremely generous with her time',
    'the supervisor Michael suggested edits',
  ];
  for (const sentence of negatives) {
    const text = `ACKNOWLEDGEMENTS\n${sentence}, and I am thankful for it.\nI remain grateful to friends and family whose generous support made this long project possible.`;
    const members = parseAcknowledgements(text);
    assert.equal(
      members.some((m) => ['Supervisor', 'Co-Supervisor'].includes(m.role)),
      false,
      sentence
    );
  }
});

test('parseAcknowledgements does not mistake graduate/academic advisor (administrative staff) for the thesis supervisor', () => {
  const negatives = [
    'I am grateful to the graduate advisor, Dr. Jane Smith, for her assistance with administrative matters.',
    'I would like to thank my academic advisor, Dr. John Lee, for help navigating course registration and paperwork.',
  ];
  for (const sentence of negatives) {
    const text = `ACKNOWLEDGEMENTS\n${sentence}, and I am thankful for it.\nI remain grateful to friends and family whose generous support made this long project possible.`;
    const members = parseAcknowledgements(text);
    assert.equal(
      members.some((m) => ['Supervisor', 'Co-Supervisor'].includes(m.role)),
      false,
      sentence
    );
  }
});

test('parseAcknowledgements does not infer bare advisors from ambiguous prose or institutions', () => {
  const negatives = [
    'The advisor Michael suggested that I speak to the archive staff.',
    'I thank my advisor at the University of British Columbia for guidance.',
    'I thank my advisor, The Committee, for its institutional support.',
    'My colleagues J R R and the project team offered encouragement.',
  ];
  for (const sentence of negatives) {
    const text = `ACKNOWLEDGEMENTS\n${sentence}\nI remain grateful to friends and family whose generous support made this long project possible.`;
    assert.equal(parseAcknowledgements(text).some((member) => ['Supervisor', 'Co-Supervisor'].includes(member.role)), false, sentence);
  }
});

test('parseAcknowledgements recognizes untitled advisor without trailing punctuation (Lever B)', () => {
  const PAD = 'I am deeply grateful to the many people who made this long and difficult project possible over the years. ';
  const positives = [
    // doc 1.0090378: infix + untitled + no punctuation
    ['I am in gratitude to my thesis advisor Joy Dixon for reading countless drafts', 'Joy Dixon', 'Supervisor'],
    // doc 1.0340537: untitled, sentence period after the name
    ['Most of all, I thank my advisor Leslie Paris. She helped me develop', 'Leslie Paris', 'Supervisor'],
    // doc 1.0100786: untitled WITH comma (existing punctuation path should handle)
    ['I would like to thank my advisor, Joy Dixon, for her patience', 'Joy Dixon', 'Supervisor'],
  ];
  for (const [sentence, name, role] of positives) {
    const text = `\nACKNOWLEDGEMENTS\n\n${PAD}${sentence} ${PAD}\n`;
    const members = parseAcknowledgements(text);
    assert.ok(
      members.some((m) => m.name === name && m.role === role),
      `${sentence} -> expected ${name}/${role}; got ${JSON.stringify(members)}`
    );
  }
});

test('parseAcknowledgements does not extract untitled advisors from ambiguous or administrative prose (Lever B)', () => {
  const PAD = 'I am deeply grateful to the many people who made this long and difficult project possible over the years. ';
  const negatives = [
    'my advisor was extremely generous with her time',
    'my advisor and I met every week to discuss progress',
    'the advisor Michael suggested I revise the chapter',
    'my advisor at the consulting firm, before graduate school, taught me',
    'my academic advisor Jane Smith helped with course registration',
    'my graduate advisor Bob Jones handled my paperwork',
  ];
  for (const sentence of negatives) {
    const text = `\nACKNOWLEDGEMENTS\n\n${PAD}${sentence} ${PAD}\n`;
    const members = parseAcknowledgements(text);
    assert.equal(
      members.some((m) => ['Supervisor', 'Co-Supervisor'].includes(m.role)),
      false,
      `${sentence} -> unexpectedly extracted ${JSON.stringify(members)}`
    );
  }
});

test('parseAcknowledgements does not misfile institutions or places following "my advisor" as a supervisor (Lever B precision)', () => {
  const PAD = 'I am deeply grateful to the many people who made this long and difficult project possible over the years. ';
  const negatives = [
    'my thesis advisor National Science Foundation funded this work',
    'my advisor Statistics Canada provided data',
    'my thesis advisor United Nations staff assisted',
    'my advisor Vancouver General Hospital staff helped',
    'my thesis advisor North America helped me secure funding',
  ];
  for (const sentence of negatives) {
    const text = `\nACKNOWLEDGEMENTS\n\n${PAD}${sentence} ${PAD}\n`;
    const members = parseAcknowledgements(text);
    assert.equal(
      members.some((m) => ['Supervisor', 'Co-Supervisor'].includes(m.role)),
      false,
      `${sentence} -> unexpectedly extracted ${JSON.stringify(members)}`
    );
  }
});

test('parseAcknowledgements still extracts person names after the org/place guard (Lever B precision)', () => {
  const PAD = 'I am deeply grateful to the many people who made this long and difficult project possible over the years. ';
  const positives = [
    ['my thesis advisor Joy Dixon for reading', 'Joy Dixon', 'Supervisor'],
    ['my advisor Leslie Paris. She helped', 'Leslie Paris', 'Supervisor'],
    ['my advisor, Jane Smith, for her patience', 'Jane Smith', 'Supervisor'],
  ];
  for (const [sentence, name, role] of positives) {
    const text = `\nACKNOWLEDGEMENTS\n\n${PAD}${sentence} ${PAD}\n`;
    const members = parseAcknowledgements(text);
    assert.ok(
      members.some((m) => m.name === name && m.role === role),
      `${sentence} -> expected ${name}/${role}; got ${JSON.stringify(members)}`
    );
  }
});

test('parseAcknowledgements collapses intra-section line-wraps so wrapped names are not truncated (Lever C1)', () => {
  const PAD = 'I am deeply grateful to the many people who made this long and difficult project possible over the years. ';
  const positives = [
    // doc 1.0100786: pdftotext wraps "Joy \nDixon" across a line break
    ['I would like to thank my advisor, Joy \nDixon, for her patience and encouragement.', 'Joy Dixon', 'Supervisor'],
    // titled + wrapped across the line break
    ['I thank my thesis supervisor, Professor Peter \nBoothroyd, who guided this work.', 'Peter Boothroyd', 'Supervisor'],
  ];
  for (const [sentence, name, role] of positives) {
    const text = `\nACKNOWLEDGEMENTS\n\n${PAD}${sentence} ${PAD}\n`;
    const members = parseAcknowledgements(text);
    assert.ok(
      members.some((m) => m.name === name && m.role === role),
      `${sentence} -> expected ${name}/${role}; got ${JSON.stringify(members)}`
    );
  }
});

test('parseAcknowledgements newline-collapse does not create cross-sentence matches (Lever C1 precision)', () => {
  const PAD = 'I am deeply grateful to the many people who made this long and difficult project possible over the years. ';
  const negatives = [
    // Period boundary must still block; Smith is not the supervisor.
    'I thank my supervisor.\nDr. Smith gave a guest lecture that year.',
    'I thank the members of my committee.\nJohn Doe attended the defense as an observer.',
  ];
  for (const sentence of negatives) {
    const text = `\nACKNOWLEDGEMENTS\n\n${PAD}${sentence} ${PAD}\n`;
    const members = parseAcknowledgements(text);
    assert.equal(
      members.length,
      0,
      `${sentence} -> unexpectedly extracted ${JSON.stringify(members)}`
    );
  }
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

test('parseCommittee extracts a supervisor whose name carries a "Professor" honorific', () => {
  // Regression (doc 1.0396863): UBC certificate pages often list the supervisor
  // as "Professor <Name>". The leading honorific must be stripped, not treated
  // as a bare-title reject — otherwise the whole Supervisor entry is dropped and
  // the thesis ends up with a committee member but no supervisor.
  const committeeText = `The following individuals certify that they have read, and recommend to the Faculty of Graduate and Postdoctoral Studies for acceptance, the thesis entitled:
Is Global Convergence of Competition Law the Answer?
submitted by Thomas Martin
Examining Committee:
Professor Shigenori Matsui, Peter A. Allard School of Law, UBC
Supervisor
John Kim, Peter A. Allard School of Law, UBC
Supervisory Committee Member`;

  const res = parseCommittee(committeeText);
  assert.ok(
    res.some((m) => m.name === 'Shigenori Matsui' && m.role === 'Supervisor'),
    `expected Shigenori Matsui as Supervisor, got ${JSON.stringify(res)}`
  );
  assert.ok(res.some((m) => m.name === 'John Kim' && m.role === 'Supervisory Committee Member'));
});

test('parseAcknowledgements extracts an untitled supervisor named after "my supervisor,"', () => {
  // Regression (doc 1.0077471): "my supervisor, Steve Wexler" — no Dr./Prof. title.
  const text = `ACKNOWLEDGEMENTS
I would like to thank my supervisor, Steve Wexler, and second reader, Richard Paisley. Their patience, guidance and invaluable advice have made my graduate study possible and enjoyable this year.`;
  const res = parseAcknowledgements(text);
  assert.ok(res.some((m) => m.name === 'Steve Wexler' && m.role === 'Supervisor'),
    `expected Steve Wexler as Supervisor, got ${JSON.stringify(res)}`);
});

test('parseAcknowledgements extracts an untitled name after "my thesis supervisor"', () => {
  // Regression (doc 1.0077517): "my thesis supervisor Karin Mickelson" — untitled, no comma.
  const text = `ACKNOWLEDGEMENTS
I would like to acknowledge the suggestions, commentaries and guidance of my thesis supervisor Karin Mickelson and my external reader Richard Paisley. Both of them were extremely patient reviewing the draft versions of this thesis.`;
  const res = parseAcknowledgements(text);
  assert.ok(res.some((m) => m.name === 'Karin Mickelson' && m.role === 'Supervisor'),
    `expected Karin Mickelson as Supervisor, got ${JSON.stringify(res)}`);
});

test('parseAcknowledgements extracts a supervisor from "for the supervision of this thesis"', () => {
  // Regression (doc 1.0077661): "Professor A.R. Thompson, not only for the supervision of this thesis".
  const text = `ACKNOWLEDGEMENTS
I wish to express my thanks to Professor A.R. Thompson, not only for the supervision of this thesis, but also for his guidance and assistance generally throughout my time in the graduate program.`;
  const res = parseAcknowledgements(text);
  assert.ok(res.some((m) => m.name === 'A.R. Thompson' && m.role === 'Supervisor'),
    `expected A.R. Thompson as Supervisor, got ${JSON.stringify(res)}`);
});

test('parseAcknowledgements extracts a supervisor from "Professor X, who supervised ... this thesis"', () => {
  // Regression (docs 1.0077436, 1.0077618): relative-clause attribution.
  const text = `ACKNOWLEDGEMENTS
Special thanks are due to Professor Peter Burns, who both supervised and facilitated this thesis with great patience, and to the second reader for his insightful comments throughout the process.`;
  const res = parseAcknowledgements(text);
  assert.ok(res.some((m) => m.name === 'Peter Burns' && m.role === 'Supervisor'),
    `expected Peter Burns as Supervisor, got ${JSON.stringify(res)}`);
});

test('parseAcknowledgements finds the section when the heading is OCR letter-spaced', () => {
  // Regression (doc 1.0077650): "A C K N O W L E D G E M E N T S" defeats heading detection.
  const text = `A C K N O W L E D G E M E N T S
This project would never have even begun without the insight and clear thinking of my advisor Susan B. Boyd, who waded through my multiple proposals to find one that was workable.`;
  const res = parseAcknowledgements(text);
  assert.ok(res.some((m) => m.name === 'Susan B. Boyd' && m.role === 'Supervisor'),
    `expected Susan B. Boyd as Supervisor, got ${JSON.stringify(res)}`);
});

test('parseAcknowledgements finds the section when the heading has a suffix', () => {
  // Regression (doc 1.0077618): "ACKNOWLEDGEMENTS AND DEDICATION" defeats heading detection.
  const text = `ACKNOWLEDGEMENTS AND DEDICATION
The author would like to thank Professor Peter Burns, Q.C., who supervised and facilitated this thesis, and Mr. Daniel Prefontaine, second reader, for his thoughtful comments on the material.`;
  const res = parseAcknowledgements(text);
  assert.ok(res.some((m) => m.name === 'Peter Burns' && m.role === 'Supervisor'),
    `expected Peter Burns as Supervisor, got ${JSON.stringify(res)}`);
});

test('parseAcknowledgements extracts committee members from "my Advisory Committee, Prof. X and Prof. Y"', () => {
  // Regression (doc 1.0077585): committee members present, no supervisor stated.
  const text = `A C K N O W L E D G E M E N T S
It is my wish to express my gratitude to all of those who have supported this work. The members of my Advisory Committee, Prof. Bruce MacDougall and Prof. William Black, have devoted time and energy to this work.`;
  const res = parseAcknowledgements(text);
  assert.ok(res.some((m) => m.name === 'Bruce MacDougall' && m.role === 'Supervisory Committee Member'),
    `expected Bruce MacDougall as committee member, got ${JSON.stringify(res)}`);
  assert.ok(res.some((m) => m.name === 'William Black' && m.role === 'Supervisory Committee Member'));
  assert.ok(!res.some((m) => m.role === 'Supervisor' || m.role === 'Co-Supervisor'),
    `no supervisor should be inferred, got ${JSON.stringify(res)}`);
});

test('parseAcknowledgements does NOT infer a supervisor from gratitude/guidance alone', () => {
  // Guardrail (docs 1.0077655, 1.0077608): "guidance of Professor X" with no role word
  // must not be promoted to a supervisor.
  const text = `ACKNOWLEDGEMENTS
The thesis itself could not have been written without the encouragement and expert guidance of Professor M. J. O'Keefe. I also wish to gratefully acknowledge the invaluable guidance and support of Professor Pitman B. Potter throughout this work.`;
  const res = parseAcknowledgements(text);
  assert.deepEqual(res, [], `expected no supervisor from guidance alone, got ${JSON.stringify(res)}`);
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

test('extraction refuses output larger than the configured text ceiling', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-cap-'));
  const pdfPath = path.join(dir, 'oversize.pdf');
  // 40 pages of real text: comfortably over the tiny ceiling set below, while
  // staying small enough that the fixture itself is cheap to build.
  await writeLargeFlatePdf(pdfPath, { pages: 40, linesPerPage: 40 });

  const uncapped = await analyzePdfAtPath(pdfPath);
  assert.equal(uncapped.extractionStatus, 'ok');
  assert.ok(uncapped.extractedBytes > 4096, 'fixture should exceed the ceiling used below');

  _setMaxPdfTextBytesForTests(4096);
  try {
    const capped = await analyzePdfAtPath(pdfPath);
    assert.equal(capped.extractionStatus, EXTRACTION_TEXT_TOO_LARGE);
    // The point of the guard is that the string is never built.
    assert.equal(capped.fullText, null);
    assert.equal(capped.wordCount, null);
    assert.equal(capped.bodyWordCount, null);
    assert.equal(capped.degraded, true);
    // Page count comes from pdfinfo, not the text, so it survives.
    assert.equal(capped.pageCount, 40);
    // The observed size is reported so an operator can see why it was refused.
    assert.equal(capped.extractedBytes, uncapped.extractedBytes);
  } finally {
    _setMaxPdfTextBytesForTests(null);
  }

  await fs.rm(dir, { recursive: true, force: true });
});


// The previous version of this test built an object by hand and asserted a property
// it had just assigned, so it passed with the entire fix reverted. It was also the
// test that should have caught the refusal being written as a clean success.
test('an oversize refusal is recorded as an error and never erases a stored word count', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-refusal-'));
  const pdfPath = path.join(dir, 'oversize.pdf');
  await writeLargeFlatePdf(pdfPath, { pages: 40, linesPerPage: 40 });

  _setMaxPdfTextBytesForTests(4096);
  try {
    const analysis = await analyzePdfAtPath(pdfPath);
    assert.equal(analysis.extractionStatus, EXTRACTION_TEXT_TOO_LARGE);

    // What the refusal contributes to the persisted row.
    const { _testing } = await import('../src/pdf.js');
    const stored = { word_count: 42000, word_source: 'dspace_full_text' };
    const doc = {};

    const error = _testing.extractionError(analysis);
    assert.ok(error, 'a size refusal must not persist error: null');
    assert.match(error, /exceeded/i);
    assert.ok(error.includes(String(analysis.extractedBytes)), 'error should name the observed size');

    // A clean extraction contributes no error, so ordinary rows stay untouched.
    assert.equal(_testing.extractionError({ extractionStatus: 'ok' }), null);

    // The stored count survives an analysis that produced none.
    assert.equal(_testing.persistedWordCount(doc, stored), 42000);
    // A fresh count still wins.
    assert.equal(_testing.persistedWordCount({ wordCount: 123 }, stored), 123);
    // Nothing anywhere stays null rather than becoming undefined.
    assert.equal(_testing.persistedWordCount({}, null), null);
  } finally {
    _setMaxPdfTextBytesForTests(null);
  }

  await fs.rm(dir, { recursive: true, force: true });
});

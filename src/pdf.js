import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PDF_CACHE_DIR, FULL_TEXT_CACHE_DIR, FILE_CONCURRENCY, MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT_MS,
  PDF_DOWNLOAD_RATE_PER_MIN, GROBID_URL, GROBID_STARTUP_WAIT_MS
} from './config.js';
import {
  loadStoredFileMetric, saveFileMetric, saveDocumentMetadata, saveCommitteeMembers,
  loadCommitteeMembers, saveCitations, clearDocumentCitations, loadDocumentCitations, deleteCommitteeMembersByRoles
} from './db.js';
import { logger } from './logger.js';
import { dedupeSupervisorNames } from './supervisors.js';

const execFileAsync = promisify(execFile);

// --- AnyStyle availability check ---
let _anystyleBin = undefined; // undefined = unchecked, null = not found, string = path

async function resolveAnyStyleBin() {
  if (_anystyleBin !== undefined) return _anystyleBin;
  // Try 'anystyle' on PATH first, then common Homebrew gem bin locations
  const candidates = [
    'anystyle',
    '/opt/homebrew/lib/ruby/gems/3.3.0/bin/anystyle',
    '/opt/homebrew/lib/ruby/gems/3.2.0/bin/anystyle',
    '/opt/homebrew/lib/ruby/gems/3.1.0/bin/anystyle',
    '/usr/local/lib/ruby/gems/3.3.0/bin/anystyle',
  ];
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version']);
      _anystyleBin = bin;
      logger.info(`anystyle-cli found at: ${bin}`);
      return _anystyleBin;
    } catch {
      // try next
    }
  }
  _anystyleBin = null;
  logger.warn('anystyle-cli not found; citation extraction will use regex fallback');
  return _anystyleBin;
}

/**
 * Assemble a readable citation string from a CSL-JSON record.
 */
function buildCitationText(csl) {
  const parts = [];

  // Authors
  if (csl.author?.length) {
    parts.push(csl.author.map(a => {
      if (a.literal) return a.literal;
      return [a.family, a.given].filter(Boolean).join(', ');
    }).join('; '));
  }

  // Date
  const year = csl.issued?.['date-parts']?.[0]?.[0] || csl.date;
  if (year) parts.push(`(${year})`);

  // Title
  if (csl.title) parts.push(csl.title);

  // Container (journal, book, etc.)
  if (csl['container-title']) parts.push(csl['container-title']);

  // Volume/issue/pages
  const vol = [csl.volume, csl.issue ? `(${csl.issue})` : ''].filter(Boolean).join('');
  if (vol) parts.push(vol);
  if (csl.page) parts.push(csl.page);

  // Publisher
  const pub = [csl['publisher-place'], csl.publisher].filter(Boolean).join(': ');
  if (pub) parts.push(pub);

  const text = parts.join('. ').replace(/\.\./g, '.').trim();
  // If AnyStyle couldn't parse much, return raw note/string if available
  if (text.length < 20) return csl.note || null;
  // Reject fragments that aren't real citations
  if (isJunkCitation(text)) return null;
  return text;
}

/**
 * Reject fragments that AnyStyle mis-identifies as standalone references.
 * These are typically URL continuation lines, publisher-only lines, or OCR noise.
 */
function isJunkCitation(text) {
  if (text.length < 25) return true;
  const lower = text.toLowerCase().trim();
  // URL/retrieval fragments
  if (/^(retrieved|accessed|retreived)\s+(from|on)/i.test(lower)) return true;
  if (/^https?:\/\//i.test(lower)) return true;
  // Pure publisher/location lines (no author or title)
  if (/^[A-Z][a-z]+,\s*[A-Z]{2}:\s*\w+$/i.test(text) && text.length < 60) return true;
  return false;
}

// --- GROBID availability check ---
let _grobidAvailable = undefined;

async function ensureGrobidRunning() {
  if (!process.env.FLY_APP_NAME) return;

  const companionAppName = process.env.GROBID_APP_NAME || `${process.env.FLY_APP_NAME}-grobid`;
  const token = process.env.FLY_API_TOKEN;

  if (!token) {
    logger.warn('FLY_API_TOKEN is not set; cannot programmatically start Grobid machines via Fly Machines API.');
    return;
  }

  try {
    const listUrl = `http://_api.internal:4280/v1/apps/${companionAppName}/machines`;
    logger.info(`Checking Grobid companion machines at: ${listUrl}`);
    
    const res = await fetch(listUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      logger.warn(`Failed to list Grobid machines from Fly Machines API: ${res.status} ${res.statusText}`);
      return;
    }

    const machines = await res.json();
    if (!Array.isArray(machines) || machines.length === 0) {
      logger.warn(`No machines found in companion app: ${companionAppName}`);
      return;
    }

    const stoppedMachines = machines.filter(m => m.state === 'stopped' || m.state === 'suspended');
    if (stoppedMachines.length === 0) {
      logger.info('All Grobid companion machines are already running or starting.');
      return;
    }

    logger.info(`Found ${stoppedMachines.length} stopped/suspended Grobid machine(s). Starting them...`);
    for (const machine of stoppedMachines) {
      const startUrl = `http://_api.internal:4280/v1/apps/${companionAppName}/machines/${machine.id}/start`;
      try {
        const startRes = await fetch(startUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(5000)
        });
        if (startRes.ok) {
          logger.info(`Successfully initiated start for Grobid machine ${machine.id}`);
        } else {
          logger.warn(`Failed to start Grobid machine ${machine.id}: ${startRes.status} ${startRes.statusText}`);
        }
      } catch (err) {
        logger.error(`Error starting Grobid machine ${machine.id}: ${err.message}`);
      }
    }

    // Wait for Grobid to become healthy/responsive
    const maxWaitMs = GROBID_STARTUP_WAIT_MS;
    const intervalMs = 2000;
    const start = Date.now();
    logger.info('Waiting for Grobid service to become responsive...');
    
    while (Date.now() - start < maxWaitMs) {
      try {
        const aliveRes = await fetch(`${GROBID_URL}/api/isalive`, { signal: AbortSignal.timeout(2000) });
        if (aliveRes.ok) {
          logger.info(`Grobid service is up and responsive after ${Math.round((Date.now() - start) / 1000)}s`);
          _grobidAvailable = true;
          return;
        }
      } catch {
        // Not ready yet, ignore and keep polling
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    logger.warn(`Grobid service failed to become responsive within ${Math.round(maxWaitMs / 1000)}s`);
  } catch (err) {
    logger.error(`Failed to ensure Grobid is running: ${err.message}`);
  }
}

async function isGrobidAvailable() {
  if (_grobidAvailable === true) return true;

  if (process.env.FLY_APP_NAME) {
    await ensureGrobidRunning();
  }

  try {
    const res = await fetch(`${GROBID_URL}/api/isalive`, { signal: AbortSignal.timeout(3000) });
    _grobidAvailable = res.ok;
    if (res.ok) logger.info('GROBID service available');
  } catch {
    _grobidAvailable = false;
    logger.warn('GROBID not available; will fall back to AnyStyle/regex');
  }
  return _grobidAvailable;
}

/**
 * Parse GROBID TEI-XML output into structured citation objects.
 * Uses regex parsing (zero deps) to extract fields from each <biblStruct> entry.
 */
export function parseGrobidTeiXml(xml) {
  if (!xml) return [];

  const citations = [];
  // Split on <biblStruct boundaries
  const entries = xml.split(/<biblStruct\b/);

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    const endIdx = entry.indexOf('</biblStruct>');
    const block = endIdx >= 0 ? entry.slice(0, endIdx) : entry;

    // Authors: all <surname> + <forename> pairs
    const authors = [];
    for (const am of block.matchAll(/<persName[^>]*>([\s\S]*?)<\/persName>/g)) {
      const nameBlock = am[1];
      const surname = nameBlock.match(/<surname>([\s\S]*?)<\/surname>/)?.[1]?.trim();
      const forename = nameBlock.match(/<forename[^>]*>([\s\S]*?)<\/forename>/)?.[1]?.trim();
      if (surname) {
        authors.push([surname, forename].filter(Boolean).join(', '));
      }
    }

    // Article title
    const articleTitle = block.match(/<title\s+level="a"[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim();

    // Journal title
    const journalTitle = block.match(/<title\s+level="j"[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim();

    // Monograph/book title
    const bookTitle = block.match(/<title\s+level="m"[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim();

    // Year
    const year = block.match(/<date[^>]+when="(\d{4})/)?.[1]
      || block.match(/<date>([\s\S]*?)<\/date>/)?.[1]?.match(/\d{4}/)?.[0]
      || null;

    // Volume, issue, pages
    const volume = block.match(/<biblScope\s+unit="volume">([\s\S]*?)<\/biblScope>/)?.[1]?.trim();
    const issue = block.match(/<biblScope\s+unit="issue">([\s\S]*?)<\/biblScope>/)?.[1]?.trim();
    const pages = block.match(/<biblScope\s+unit="page"[^>]*>([\s\S]*?)<\/biblScope>/)?.[1]?.trim()
      || (() => {
        const from = block.match(/<biblScope\s+unit="page"\s+from="([^"]+)"/)?.[1];
        const to = block.match(/<biblScope\s+unit="page"\s+to="([^"]+)"/)?.[1];
        return from ? (to ? `${from}-${to}` : from) : null;
      })();

    // Publisher
    const publisher = block.match(/<publisher>([\s\S]*?)<\/publisher>/)?.[1]?.trim();

    // Raw reference text (if GROBID provides it)
    const rawRef = block.match(/<note\s+type="raw_reference"[^>]*>([\s\S]*?)<\/note>/)?.[1]?.trim();

    // Determine the main title and source (container)
    const title = articleTitle || bookTitle || null;
    const source = journalTitle || (articleTitle ? bookTitle : null) || null;

    // Build citation text from structured fields
    const textParts = [];
    if (authors.length) textParts.push(authors.join('; '));
    if (year) textParts.push(`(${year})`);
    if (title) textParts.push(title);
    if (source) textParts.push(source);
    const vol = [volume, issue ? `(${issue})` : ''].filter(Boolean).join('');
    if (vol) textParts.push(vol);
    if (pages) textParts.push(pages);
    if (publisher) textParts.push(publisher);

    let text = textParts.join('. ').replace(/\.\./g, '.').trim();

    // Use raw reference if structured text is too short
    if (text.length < 20 && rawRef) text = rawRef;
    // Skip if still too short or junk
    if (!text || text.length < 20) continue;
    if (isJunkCitation(text)) continue;

    // Unescape XML entities
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

    const authorField = authors.length ? authors.join('; ').replace(/&amp;/g, '&') : null;
    const titleField = title ? title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
    const sourceField = source ? source.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;

    citations.push({
      text,
      author: authorField || null,
      title: titleField || null,
      year: year || null,
      source: sourceField || null,
    });
  }

  return citations;
}

/**
 * Extract citations from a PDF file using GROBID's processReferences endpoint.
 * Returns an array of { text, author, title, year, source } objects,
 * or null if GROBID is unavailable/fails (signaling caller to use text-based fallback).
 */
export async function parseBibliographyWithGrobid(pdfPath, { timeoutMs = 120_000 } = {}) {
  if (!pdfPath) return null;
  if (!(await isGrobidAvailable())) return null;

  try {
    const pdfBuffer = await fs.readFile(pdfPath);
    const form = new FormData();
    form.append('input', new Blob([pdfBuffer]), path.basename(pdfPath));
    form.append('includeRawCitations', '1');
    form.append('consolidateCitations', '0');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(`${GROBID_URL}/api/processReferences`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      logger.warn('GROBID processReferences failed', { status: res.status });
      return null;
    }

    const teiXml = await res.text();
    return parseGrobidTeiXml(teiXml);
  } catch (err) {
    logger.warn('GROBID extraction error', { error: err.message });
    return null;
  }
}

/**
 * Extract citations from full text using AnyStyle ML parser.
 * Falls back to regex-based parseBibliography() if AnyStyle is unavailable.
 */
export async function parseBibliographyWithAnyStyle(fullText) {
  if (!fullText) return [];
  const bin = await resolveAnyStyleBin();
  if (!bin) return parseBibliography(fullText);

  const tmpFile = path.join(os.tmpdir(), `anystyle-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    await fs.writeFile(tmpFile, fullText, 'utf8');
    const { stdout } = await execFileAsync(bin, ['-f', 'csl', '--stdout', 'find', tmpFile], {
      maxBuffer: 10 * 1024 * 1024
    });
    const records = JSON.parse(stdout);
    const citations = records.map(buildCitationText).filter(Boolean);
    // Fall back to regex if AnyStyle found suspiciously few references for
    // a document that likely has a real bibliography (long text, few hits).
    if (citations.length === 0) return parseBibliography(fullText);
    if (citations.length < 5 && fullText.length > 50_000) {
      const regexCitations = parseBibliography(fullText);
      if (regexCitations.length > citations.length * 3) {
        logger.info('AnyStyle found few citations, using regex fallback', {
          anystyle: citations.length, regex: regexCitations.length
        });
        return regexCitations;
      }
    }
    return citations;
  } catch (err) {
    logger.warn('AnyStyle extraction failed, falling back to regex parser', { error: err.message });
    return parseBibliography(fullText);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

// --- PDF download rate limiter ---
// Serialized queue so concurrent workers share a single sliding window.
const _downloadTimestamps = [];
let _downloadRateTail = Promise.resolve();

async function acquireDownloadSlot() {
  if (!PDF_DOWNLOAD_RATE_PER_MIN) return; // 0 = unlimited
  let release;
  const prev = _downloadRateTail;
  _downloadRateTail = new Promise((resolve) => { release = resolve; });
  await prev;
  const windowMs = 60_000;
  const now = Date.now();
  while (_downloadTimestamps.length && _downloadTimestamps[0] < now - windowMs) {
    _downloadTimestamps.shift();
  }
  if (_downloadTimestamps.length >= PDF_DOWNLOAD_RATE_PER_MIN) {
    const waitMs = _downloadTimestamps[0] + windowMs - Date.now();
    if (waitMs > 0) {
      logger.info(`PDF rate limit: waiting ${Math.round(waitMs / 1000)}s`, { downloadsInWindow: _downloadTimestamps.length });
      await new Promise((r) => setTimeout(r, waitMs));
      while (_downloadTimestamps.length && _downloadTimestamps[0] < Date.now() - windowMs) {
        _downloadTimestamps.shift();
      }
    }
  }
  _downloadTimestamps.push(Date.now());
  release();
}

let hasPdftotext;

export async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function applyStoredMetricToDoc(doc, stored, statusOverride = 'cached') {
  if (!stored) return;
  if (stored.page_count) {
    doc.pages = Number(stored.page_count);
    doc.pagesSource = stored.page_source || doc.pagesSource;
  }
  if (stored.word_count) {
    doc.wordCount = Number(stored.word_count);
    doc.wordCountSource = stored.word_source || doc.wordCountSource;
  }
  if (stored.body_word_count) {
    doc.bodyWordCount = Number(stored.body_word_count);
  }
  doc.fileBytes = stored.file_bytes ? Number(stored.file_bytes) : null;
  doc.downloadUrl = stored.download_url || null;
  doc.downloadStatus = statusOverride;
  doc.downloadError = stored.error || null;
}

function hasStoredFullTextMetric(stored) {
  return stored?.word_source === 'dspace_full_text'
    && Number(stored.word_count) > 0
    && Number(stored.page_count) > 0;
}

async function applyStoredFullTextMetric(doc, stored, statusOverride = 'full_text_cached') {
  applyStoredMetricToDoc(doc, stored, statusOverride);
  await loadStoredParsedData(doc);
}

function storedFullTextFields(stored) {
  return {
    fullTextPath: stored?.full_text_path || null,
    fullTextBytes: stored?.full_text_bytes || null,
    fullTextSourceUrl: stored?.full_text_source_url || null
  };
}

async function ensurePdftotextAvailability() {
  if (hasPdftotext !== undefined) return hasPdftotext;
  try {
    await execFileAsync('pdftotext', ['-v']);
    hasPdftotext = true;
  } catch {
    hasPdftotext = false;
  }
  return hasPdftotext;
}

export function extractBodyWordCount(text) {
  if (!text) return null;
  const lines = text.split('\n');
  let bibLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BIBLIOGRAPHY_HEADING.test(lines[i].trim())) {
      bibLineIndex = i;
      break;
    }
  }
  let bodyText = text;
  if (bibLineIndex !== -1) {
    bodyText = lines.slice(0, bibLineIndex).join('\n');
  }
  const count = bodyText
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean).length;
  return count || null;
}

async function extractPdfText(filePath) {
  if (!(await ensurePdftotextAvailability())) return { text: null, wordCount: null, bodyWordCount: null };
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-enc', 'UTF-8', filePath, '-']);
    const text = String(stdout || '');
    const wordCount = text
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean).length;
    const bodyWordCount = extractBodyWordCount(text);
    return { text, wordCount: wordCount || null, bodyWordCount };
  } catch {
    return { text: null, wordCount: null, bodyWordCount: null };
  }
}

function countPdfPagesFromBuffer(buffer) {
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : null;
}

async function countPdfPagesWithPdfinfo(filePath) {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [filePath]);
    const match = String(stdout).match(/^Pages:\s*(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function analyzePdfAtPath(pdfPath, bytes) {
  const fileBytes = bytes || (await fs.readFile(pdfPath));
  let pageCount = countPdfPagesFromBuffer(fileBytes);
  if (!pageCount) {
    pageCount = await countPdfPagesWithPdfinfo(pdfPath);
  }
  const { text, wordCount, bodyWordCount } = await extractPdfText(pdfPath);
  return {
    pageCount: pageCount || null,
    wordCount: wordCount || null,
    bodyWordCount: bodyWordCount || null,
    fileBytes: fileBytes.length,
    fullText: text || null
  };
}

function wordCountFromText(text) {
  const count = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean).length;
  return count || null;
}

function estimatePagesFromWords(wordCount) {
  const count = Number(wordCount);
  if (!Number.isFinite(count) || count <= 0) return null;
  return Math.max(1, Math.round(count / 300));
}

function originalRecordRestUrl(doc) {
  const rawUrl = String(doc?.originalRecordUrl || '').trim();
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'circle.library.ubc.ca') return null;
    if (!url.pathname.startsWith('/rest/handle/')) return null;
    url.protocol = 'https:';
    url.searchParams.set('expand', 'all');
    return url;
  } catch {
    return null;
  }
}

function dspaceRestUrl(pathname) {
  const url = new URL('https://circle.library.ubc.ca');
  url.pathname = pathname;
  return url;
}

function fullTextCachePathForDoc(doc) {
  const hash = crypto.createHash('sha1').update(String(doc?.id || '')).digest('hex');
  return path.join(FULL_TEXT_CACHE_DIR, `${hash}.txt`);
}

async function readCachedFullText(stored) {
  if (!stored?.full_text_path) return null;
  try {
    const fullText = await fs.readFile(stored.full_text_path, 'utf8');
    if (fullText.length <= 1000) return null;
    return {
      fullText,
      fullTextPath: stored.full_text_path,
      fullTextBytes: Buffer.byteLength(fullText, 'utf8'),
      fullTextSourceUrl: stored.full_text_source_url || null,
      cacheHit: true
    };
  } catch {
    return null;
  }
}

async function writeCachedFullText(doc, fullText, sourceUrl) {
  await fs.mkdir(FULL_TEXT_CACHE_DIR, { recursive: true });
  const fullTextPath = fullTextCachePathForDoc(doc);
  await fs.writeFile(fullTextPath, fullText, 'utf8');
  return {
    fullTextPath,
    fullTextBytes: Buffer.byteLength(fullText, 'utf8'),
    fullTextSourceUrl: sourceUrl || null
  };
}

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/plain') && !contentType.includes('text/')) return null;
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBytesWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      logger.warn('Download skipped: file too large', { url: url.toString(), bytes: contentLength });
      return null;
    }
    const contentType = res.headers.get('content-type') || '';
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) return null;
    return {
      bytes,
      contentType,
      finalUrl: res.url || url.toString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDspaceBitstreams(doc) {
  const recordUrl = originalRecordRestUrl(doc);
  if (!recordUrl) return null;

  const record = await fetchJsonWithTimeout(recordUrl);
  if (!record) return null;

  let bitstreams = Array.isArray(record.bitstreams) ? record.bitstreams : [];
  if (!bitstreams.length && record.id) {
    const bitstreamUrl = dspaceRestUrl(`/rest/items/${record.id}/bitstreams`);
    bitstreams = await fetchJsonWithTimeout(bitstreamUrl) || [];
  }

  return bitstreams;
}

function chooseDspaceTextBitstream(bitstreams) {
  return (bitstreams || []).find((bitstream) => {
    const mime = String(bitstream?.mimeType || '').toLowerCase();
    const bundle = String(bitstream?.bundleName || '').toUpperCase();
    const name = String(bitstream?.name || '').toLowerCase();
    return mime.startsWith('text/plain') || bundle === 'TEXT' || name.endsWith('.pdf.txt');
  }) || null;
}

function chooseDspacePdfBitstream(bitstreams) {
  return (bitstreams || []).find((bitstream) => {
    const mime = String(bitstream?.mimeType || '').toLowerCase();
    const bundle = String(bitstream?.bundleName || '').toUpperCase();
    const name = String(bitstream?.name || '').toLowerCase();
    return mime.includes('pdf') && (bundle === 'ORIGINAL' || name.endsWith('.pdf'));
  }) || null;
}

export async function fetchFullTextForDocument(doc, stored = null) {
  const cached = await readCachedFullText(stored);
  if (cached) return cached;

  const recordUrl = originalRecordRestUrl(doc);
  if (!recordUrl) return null;

  try {
    const bitstreams = await fetchDspaceBitstreams(doc);

    const textBitstream = chooseDspaceTextBitstream(bitstreams);
    const id = textBitstream?.id;
    if (!id) return null;

    const retrieveUrl = dspaceRestUrl(`/rest/bitstreams/${id}/retrieve`);
    const fullText = await fetchTextWithTimeout(retrieveUrl);
    if (!fullText || fullText.length <= 1000) return null;
    const cachedText = await writeCachedFullText(doc, fullText, retrieveUrl.toString());
    return {
      fullText,
      ...cachedText,
      cacheHit: false
    };
  } catch (err) {
    logger.warn('Failed to fetch cIRcle full-text bitstream', {
      docId: doc?.id,
      error: err?.message || String(err)
    });
    return null;
  }
}

export async function fetchPdfForDocument(doc) {
  try {
    const bitstreams = await fetchDspaceBitstreams(doc);
    const pdfBitstream = chooseDspacePdfBitstream(bitstreams);
    const id = pdfBitstream?.id;
    if (!id) return null;

    const retrieveUrl = dspaceRestUrl(`/rest/bitstreams/${id}/retrieve`);
    const result = await fetchBytesWithTimeout(retrieveUrl);
    if (!result?.bytes?.length) return null;
    if (!result.contentType.includes('pdf') && !String(pdfBitstream?.name || '').toLowerCase().endsWith('.pdf')) {
      return null;
    }

    return {
      downloadUrl: result.finalUrl || retrieveUrl.toString(),
      bytes: result.bytes,
      bitstreamId: id,
      bitstreamName: pdfBitstream.name || null,
    };
  } catch (err) {
    logger.warn('Failed to fetch cIRcle PDF bitstream', {
      docId: doc?.id,
      error: err?.message || String(err)
    });
    return null;
  }
}

async function analyzeDocumentFullText(doc, fullText, { stored = null, status = 'full_text', error = null } = {}) {
  const wordCount = wordCountFromText(fullText);
  const bodyWordCount = extractBodyWordCount(fullText);
  const pageCount = estimatePagesFromWords(bodyWordCount || wordCount);
  if (!wordCount || !pageCount) return false;

  doc.wordCount = wordCount;
  doc.wordCountSource = 'dspace_full_text';
  if (bodyWordCount) doc.bodyWordCount = bodyWordCount;
  doc.pages = pageCount;
  doc.pagesSource = 'estimated_from_full_text_words';
  doc.fileBytes = stored?.file_bytes ? Number(stored.file_bytes) : null;
  doc.downloadUrl = stored?.download_url || null;
  doc.downloadStatus = status;
  doc.downloadError = error;

  await saveFileMetric(doc.id, {
    status,
    error,
    pdfPath: stored?.pdf_path || null,
    downloadUrl: stored?.download_url || null,
    fileBytes: stored?.file_bytes || null,
    wordCount: doc.wordCount,
    bodyWordCount: doc.bodyWordCount || null,
    ...storedFullTextFields(stored),
    pageCount: doc.pages,
    wordSource: doc.wordCountSource,
    pageSource: doc.pagesSource
  });
  await extractAndSaveParsedData(doc, fullText, null);
  logger.info('Document analyzed from cIRcle full-text bitstream', {
    docId: doc.id,
    pages: doc.pages,
    words: doc.wordCount,
    status
  });
  return true;
}

async function analyzeDocumentFullTextFallback(doc, stored, { status = 'full_text', error = null } = {}) {
  const result = await fetchFullTextForDocument(doc, stored);
  if (!result?.fullText) return false;
  return analyzeDocumentFullText(doc, result.fullText, {
    stored: {
      ...stored,
      full_text_path: result.fullTextPath || stored?.full_text_path || null,
      full_text_bytes: result.fullTextBytes || stored?.full_text_bytes || null,
      full_text_source_url: result.fullTextSourceUrl || stored?.full_text_source_url || null
    },
    status,
    error
  });
}

async function analyzeCachedFullText(doc, stored, { status = 'full_text_recomputed', error = null } = {}) {
  const cached = await readCachedFullText(stored);
  if (cached?.fullText) {
    return analyzeDocumentFullText(doc, cached.fullText, { stored, status, error });
  }
  if (hasStoredFullTextMetric(stored)) {
    await applyStoredFullTextMetric(doc, stored);
    return true;
  }
  return false;
}

// --- Committee & Bibliography Parsing ---

const ROLE_PATTERNS = [
  { pattern: /\bco-?supervisor\b/i, role: 'Co-Supervisor' },
  { pattern: /\bsupervisor\b/i, role: 'Supervisor' },
  { pattern: /\bsupervisory committee member\b/i, role: 'Supervisory Committee Member' },
  { pattern: /\buniversity examiner\b/i, role: 'University Examiner' },
  { pattern: /\bexternal examiner\b/i, role: 'External Examiner' },
];
const SUPERVISOR_ROLES = new Set(['Supervisor', 'Co-Supervisor']);

// Known lowercase name particles (Dutch, French, Spanish, German, etc.)
const NAME_PARTICLES = new Set(['de', 'du', 'da', 'di', 'van', 'von', 'le', 'la', 'el', 'al', 'den', 'der', 'dos', 'das', 'ter', 'ten']);

// --- Acknowledgements-based committee parsing (fallback for pre-2018 docs) ---

/**
 * Extract a clean person name from a raw regex capture group such as
 * "((?:[A-Z]\\S*\\s*){1,4})". Keeps only capital-starting tokens, stops on
 * first lowercase-starting word, strips trailing punctuation from each token.
 */
function extractNameFromCapture(raw) {
  const parts = [];
  for (const word of raw.trim().split(/\s+/)) {
    // Strip trailing punctuation but keep periods for middle initials (e.g. "J.")
    const stripped = word.replace(/[,;:()\[\]!?]+$/, '');
    if (!stripped) break;
    // Must start with an uppercase letter (including accented uppercase)
    if (!/^[A-Z\u00C0-\u024F]/.test(stripped)) {
      // Allow known lowercase name particles (de, van, von, etc.)
      if (NAME_PARTICLES.has(stripped.toLowerCase())) {
        parts.push(stripped);
        continue;
      }
      break;
    }
    // Reject common pronouns/articles that appear after a sentence boundary
    if (/^(He|She|They|We|I|It|His|Her|Their|This|That|The|A|An)$/.test(stripped)) break;
    // Sentence-ending period (word length > 2 means NOT a middle initial like "J.")
    const endsWithSentencePeriod = /\.$/.test(stripped) && stripped.length > 2;
    // Push with period stripped from non-initial words
    parts.push(endsWithSentencePeriod ? stripped.slice(0, -1) : stripped);
    if (parts.length >= 4) break;
    // Stop after a sentence-ending period or name-boundary punctuation
    if (endsWithSentencePeriod) break;
    if (/[,;]$/.test(word)) break;
  }
  const name = parts.join(' ').trim();
  return name.length >= 3 ? name : '';
}

// Matches occurrences of an ACKNOWLEDGEMENTS section heading.
// pdftotext prepends \f (form feed) at each page boundary.
// The fuzzy fallback ACKNOW[A-Z]{4,12} captures OCR/transcription typos such as
// "ACKNOWDLEGMENTS" (D/L transposition) and American vs British spelling variants
// that the exact spellings miss. "ACKNOW" is the safe common prefix for all variants.
const ACK_HEADING_RE = /(?:^|\n|\f)(ACKNOWLEDGEMENTS?|Acknowledgements?|ACKNOWLEDG[A-Z]{2,10}|ACKNOW[A-Z]{4,12})\s*\n/g;
// Capture group: 1–4 tokens each starting with uppercase, including \S* tail and optional trailing space
const DR_CAP = '((?:[A-Z\\u00C0-\\u024F]\\S*\\s*){1,4})';
// Title prefix: Dr. or Prof/Professor (period optional for Prof/Professor)
const TITLE_RE = '(?:Dr\\.|Prof(?:essor)?\\.?)';

// --- Acknowledgement extraction patterns (constructed once at module scope) ---
const PAT_PLURAL_SUPERVISORS = new RegExp(
  `my\\s+supervisors?,?\\s+${TITLE_RE}\\s+${DR_CAP}\\s+and\\s+${TITLE_RE}\\s+${DR_CAP}`, 'gi');
const PAT_MY_SUPERVISOR = new RegExp(
  `(?:my|research)\\s+(co-?)?supervisor,?\\s+${TITLE_RE}\\s+${DR_CAP}`, 'gi');
const PAT_COMMITTEE_CHAIR = new RegExp(
  `Committee\\s+Chair\\s+${TITLE_RE}\\s+${DR_CAP}`, 'gi');
const PAT_TITLE_ROLE_PARENS = new RegExp(
  `${TITLE_RE}\\s+${DR_CAP}\\s*\\(\\s*(Co-?)?Supervisor\\s*\\)`, 'gi');
const PAT_ROLE_SUFFIX = new RegExp(
  `${TITLE_RE}\\s+${DR_CAP},\\s*(?:as\\s+)?(?:(?:my|the)\\s+)?(?:research\\s+)?(?:(co-?)?supervisor|committee\\s+chair|chair\\s+of\\s+(?:my\\s+)?(?:the\\s+)?committee)\\b`, 'gi');
const PAT_CO_ADVISOR_SUFFIX = new RegExp(
  `${TITLE_RE}\\s+${DR_CAP},\\s*as\\s+(?:my\\s+)?co-?advisor\\b`, 'gi');
const PAT_CO_ADVISOR_PREFIX = new RegExp(
  `co-?advisor,?\\s+${TITLE_RE}\\s+${DR_CAP}`, 'gi');
const PAT_AS_SUPERVISOR = new RegExp(
  `${TITLE_RE}\\s+${DR_CAP}[^.]{0,150}as\\s+(?:my\\s+)?(?:(co-?))?supervisor`, 'gi');
const PAT_TITLED_NAME = new RegExp(`${TITLE_RE}\\s+${DR_CAP}`, 'g');

export function parseAcknowledgements(fullText) {
  if (!fullText) return [];

  // Normalize form feeds so they appear as newlines to the heading regex
  const text = fullText.replace(/\f/g, '\n');

  // Use the first *substantive* occurrence — TOC entries have dotted leaders and few words
  // while real sections have prose. This avoids appendix "Acknowledgement" headings in
  // appended external documents (policy docs, ethics letters) displacing the actual section.
  let ackMatch = null;
  let m;
  ACK_HEADING_RE.lastIndex = 0;
  while ((m = ACK_HEADING_RE.exec(text)) !== null) {
    const preview = text.slice(m.index + m[0].length, m.index + m[0].length + 300);
    const firstToken = preview.trimStart().split(/\s+/)[0] || '';
    // TOC entries begin with a page number: lowercase Roman numerals (i, ii, xii…) or digits.
    // Capital "I" is always the English first-person pronoun starting a real sentence, not a numeral.
    const isTocPageNum = /^[ivxl]+$/.test(firstToken) || /^\d{1,3}$/.test(firstToken);
    if (preview.split(/\s+/).length > 20 && !/\.{4}/.test(preview) && !isTocPageNum) {
      ackMatch = m;
      break;
    }
  }
  if (!ackMatch) return [];

  const section = text.slice(ackMatch.index + ackMatch[0].length, ackMatch.index + ackMatch[0].length + 3000);

  const members = [];
  const seen = new Set();

  function addMember(rawName, role) {
    const name = extractNameFromCapture(rawName);
    if (!name || name.length > 60) return;
    // Reject pronouns/articles that slip through
    if (/^(The|A|An|My|His|Her|In|For|At|To|With|This|Their|I|We|You|It|She|He|Also)$/i.test(name)) return;
    const key = `${name}|${role}`;
    if (seen.has(key)) return;
    seen.add(key);
    members.push({ name, role, affiliation: null });
  }

  // --- Supervisor patterns ---

  // "my supervisors, Dr. X and Dr. Y" (plural — both are co-supervisors)
  for (const pm of section.matchAll(PAT_PLURAL_SUPERVISORS)) {
    addMember(pm[1], 'Co-Supervisor');
    addMember(pm[2], 'Co-Supervisor');
  }

  // "my supervisor Dr. X" / "research supervisor Dr. X" / "my co-supervisor Dr. X"
  // Allow optional comma between "supervisor" and title (e.g. "my supervisor, Dr. X")
  for (const pm of section.matchAll(PAT_MY_SUPERVISOR)) {
    addMember(pm[2], pm[1] ? 'Co-Supervisor' : 'Supervisor');
  }

  // "Committee Chair Dr. X"
  for (const pm of section.matchAll(PAT_COMMITTEE_CHAIR)) {
    addMember(pm[1], 'Supervisor');
  }

  // "Dr. X (Supervisor)" or "Dr. X (Co-Supervisor)"
  for (const pm of section.matchAll(PAT_TITLE_ROLE_PARENS)) {
    addMember(pm[1], pm[2] ? 'Co-Supervisor' : 'Supervisor');
  }

  // "Dr. X, my supervisor" / "Dr. X, my research supervisor" / "Dr. X, my committee chair"
  // Also: "Dr. X, the chair of my committee" / "Dr. X, chair of the committee"
  // "research" (and similar modifiers) may precede "supervisor".
  for (const pm of section.matchAll(PAT_ROLE_SUFFIX)) {
    addMember(pm[1], pm[2] ? 'Co-Supervisor' : 'Supervisor');
  }

  // "Dr. X, as co-advisor" / "Dr. X, as my co-advisor"
  for (const pm of section.matchAll(PAT_CO_ADVISOR_SUFFIX)) {
    addMember(pm[1], 'Co-Supervisor');
  }

  // "co-advisor Dr. X" / "co-advisor, Dr. X"
  for (const pm of section.matchAll(PAT_CO_ADVISOR_PREFIX)) {
    addMember(pm[1], 'Co-Supervisor');
  }

  // "Dr. X ... as my supervisor" (name comes before the role keyword, within 150 chars)
  for (const pm of section.matchAll(PAT_AS_SUPERVISOR)) {
    addMember(pm[1], pm[2] ? 'Co-Supervisor' : 'Supervisor');
  }

  // --- Committee member patterns ---
  // Text around each "committee members" / "my committee" occurrence — scan 400 chars forward for titled names.
  // (A character-class exclusion on '.' would incorrectly stop at the '.' in "Dr.".)
  for (const cm of section.matchAll(/committee\s+members?|my\s+committee\s*[,:]/gi)) {
    const chunk = section.slice(cm.index, cm.index + 400);
    for (const dm of chunk.matchAll(PAT_TITLED_NAME)) {
      const name = extractNameFromCapture(dm[1]);
      if (name && !seen.has(`${name}|Supervisor`) && !seen.has(`${name}|Co-Supervisor`)) {
        addMember(dm[1], 'Supervisory Committee Member');
      }
    }
  }

  // Bare committee list: "committee consisting of Name1, Name2 and Name3"
  // Used when no title prefix (Dr./Prof.) is present, e.g. "my research committee
  // consisting of Tom Sork, Pierre Walter and Robert VanWynsberghe".
  // Extracts sequences of 2–3 consecutive capitalised words as names.
  const BARE_NAME = '[A-Z\\u00C0-\\u024F][a-zA-Z\\u00C0-\\u024F]+(?:\\s+[A-Z\\u00C0-\\u024F][a-zA-Z\\u00C0-\\u024F]+){1,2}';
  for (const cm of section.matchAll(
    new RegExp(`[Cc]ommittee\\s+(?:[Cc]onsisting|[Cc]omprised)\\s+of\\s+(${BARE_NAME}(?:,\\s*${BARE_NAME})*(?:\\s+and\\s+${BARE_NAME})?)`, 'g')
  )) {
    const listText = cm[1];
    for (const nm of listText.matchAll(new RegExp(BARE_NAME, 'g'))) {
      const name = nm[0].trim();
      if (!seen.has(`${name}|Supervisor`) && !seen.has(`${name}|Co-Supervisor`) &&
          !seen.has(`${name}|Supervisory Committee Member`)) {
        addMember(name, 'Supervisory Committee Member');
      }
    }
  }

  return members;
}

export function parseCommittee(fullText) {
  if (!fullText) return [];

  const startMatch = fullText.match(/the following individuals certify/i);
  if (!startMatch) return [];

  const startIdx = startMatch.index;
  const section = fullText.slice(startIdx, startIdx + 3000);
  const lines = section.split(/\n/).map((l) => l.trim()).filter(Boolean);

  // Join continuation lines that are fragments of a wrapped affiliation line.
  // e.g. "Department of French, Hispanic & Italian Studies,\nUBC" → single line.
  // Process bottom-up so splicing doesn't shift indices we haven't visited yet.
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i];
    // Skip if this IS a role line
    if (ROLE_PATTERNS.some(({ pattern }) => pattern.test(line))) continue;
    // Skip if this looks like a new name,affiliation entry
    if (/^(Dr\.|Prof\.)/.test(line)) continue;
    if (/^[A-Z][a-z]+ [A-Z]/.test(line) && line.includes(',')) continue;
    // Fragment: short (≤40 chars), no comma, not "Firstname Lastname"
    const isFragment = line.length <= 40 && !line.includes(',')
      && !/^[A-Z][a-z]+\s+[A-Z][a-z]/.test(line);
    const isInstitutionTail = /^(University|Columbia|UBC|SFU|of\s)/i.test(line);
    if (isFragment || isInstitutionTail) {
      // Only join if previous line isn't a role line
      if (!ROLE_PATTERNS.some(({ pattern }) => pattern.test(lines[i - 1]))) {
        lines[i - 1] = lines[i - 1] + ' ' + line;
        lines.splice(i, 1);
      }
    }
  }

  const members = [];
  const stopPattern = /^(abstract|table of contents|acknowledgment|dedication|preface)/i;

  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const line = lines[i];

    if (stopPattern.test(line)) break;

    let matchedRole = null;
    for (const { pattern, role } of ROLE_PATTERNS) {
      if (pattern.test(line)) {
        matchedRole = role;
        break;
      }
    }

    if (matchedRole) {
      // Inline format (2019+): "Tracy Friedel (Co-Supervisor)" — name and role on the same line.
      // Extract the text before the parenthesised role as the name.
      // Match any parenthesised text — matchedRole already verified it's a known role.
      const inlineMatch = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (inlineMatch) {
        let inlineName = inlineMatch[1].trim();
        // Clean trailing role/title text
        inlineName = inlineName.replace(/\s*[–—-]\s*(Professor|Assistant|Associate|Instructor).*$/i, '').trim();
        inlineName = inlineName.replace(/\s+(Thank|You|Sessional\s+Le[ct].*|Senior\s+Inst.*)$/i, '').trim();
        inlineName = inlineName.replace(/-$/, '').trim();
        if (inlineName && inlineName.length > 1 && inlineName.length < 120) {
          if (!/^(additional|examining)\s+/i.test(inlineName) && !/committee\s+member/i.test(inlineName)) {
            if (!/^(University|UBC|SFU|Columbia|Research|of\s|&\s)/i.test(inlineName)) {
              const exists = members.some((m) => m.name === inlineName && m.role === matchedRole);
              if (!exists) members.push({ name: inlineName, role: matchedRole, affiliation: null });
            }
          }
        }
        continue;
      }

      // Look backwards for name/affiliation lines (1-2 lines above).
      // Pre-2016 format: name appears above the role label.
      let name = '';
      let affiliation = '';

      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        const prev = lines[j];
        // Skip lines that are themselves role lines or the header
        if (ROLE_PATTERNS.some(({ pattern }) => pattern.test(prev))) break;
        if (/the following individuals certify/i.test(prev)) break;
        if (/examining committee/i.test(prev)) break;
        if (/entitled/i.test(prev)) break;
        // Skip signature-box underscore lines
        if (/^_+$/.test(prev)) continue;

        if (!name) {
          // Check if name,affiliation on one line
          const commaParts = prev.split(',').map((s) => s.trim());
          if (commaParts.length >= 2) {
            name = commaParts[0];
            affiliation = commaParts.slice(1).join(', ');
          } else {
            name = prev;
          }
        } else if (!affiliation) {
          affiliation = prev;
        }
      }

      if (name && members.some((m) => m.name === name)) {
        name = '';
        affiliation = '';
      }

      // Forward-look fallback: 2018+ format has role label above name+affiliation.
      if (!name) {
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
          const next = lines[j];
          if (ROLE_PATTERNS.some(({ pattern }) => pattern.test(next))) break;
          if (stopPattern.test(next)) break;
          if (/^_+$/.test(next)) continue;
          const commaParts = next.split(',').map((s) => s.trim());
          if (commaParts.length >= 2) {
            name = commaParts[0];
            affiliation = commaParts.slice(1).join(', ');
          } else {
            name = next;
          }
          break;
        }
      }

      if (name && name.length > 1 && name.length < 120) {
        // Clean trailing role/title text that leaked into the name
        name = name.replace(/\s*[–—-]\s*(Professor|Assistant|Associate|Instructor).*$/i, '').trim();
        name = name.replace(/\s+(Thank|You|Sessional\s+Le[ct].*|Senior\s+Inst.*)$/i, '').trim();
        name = name.replace(/-$/, '').trim();
        // Skip label lines captured as names
        if (/^(additional|examining)\s+/i.test(name) || /committee\s+member/i.test(name)) continue;
        // Reject institution/department fragments, bare role words, and page artifacts
        if (/^(University|UBC|SFU|Columbia|Research|of\s|&\s)/i.test(name)) continue;
        if (/^(Professor|Examiner|Academic|Abstract)\b/i.test(name)) continue;
        if (/\bExaminer\b/.test(name)) continue;
        if (/^(ii|iii|iv|v|vi)\s/i.test(name)) continue;
        if (!name) continue;
        // Avoid adding duplicates
        const exists = members.some((m) => m.name === name && m.role === matchedRole);
        if (!exists) {
          members.push({ name, role: matchedRole, affiliation: affiliation || null });
        }
      }
    }
  }

  return members;
}

// Collapse OCR character-spacing artifacts in bibliography entries.
// Older typewritten/scanned dissertations often have letters separated by spaces:
//   "A p p l i c a t i o n" → "Application",  "U n i v e r s i t y" → "University"
// Matches runs of 2+ single letters each separated by exactly one space.
// Word boundaries prevent matching across normal word breaks or dotted initials.
function collapseOcrSpacing(text) {
  // Collapse character-spacing runs: "A p p l i c a t i o n" → "Application"
  let result = text.replace(/\b([a-zA-Z])(?: ([a-zA-Z]))+\b/g, (m) => m.replace(/ /g, ''));
  // Remove spaces before punctuation left by OCR: "Alkin ," → "Alkin,", "word ." → "word."
  result = result.replace(/ ([,.:;!?])/g, '$1');
  return result;
}

// Match bibliography/references section headings.
// The simple form ("REFERENCES", "BIBLIOGRAPHY") is anchored to the full line.
// The extended form allows a short suffix (≤ 60 chars) to handle headings like
// "BIBLIOGRAPHY OF SOURCES CITED IN TEXT" or "BIBLIOGRAPHY OF PRIMARY SOURCES".
// The 60-char cap prevents matching mid-sentence OCR wrap fragments such as
// "references to such programs as 'Dr. Curry's Method of Teaching Reading' and".
const BIBLIOGRAPHY_HEADING =
  /^(?:(?:selected|complete|general|annotated|primary)\s+)?(?:references?|bibliography|bibliographie|r[eé]f[eé]rences?|works\s+cited|literature\s+cited|sources\s+consulted)\b.{0,60}\s*$|^(?:list\s+of\s+references?|reference\s+list|ouvrages?\s+(?:de\s+)?r[eé]f[eé]rence)\s*$/im;
const APPENDIX_HEADING = /^(appendix|appendices|glossary|index|vita|curriculum\s+vitae|about\s+the\s+author)\b/im;

function isLikelyCitationStart(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (text.length < 8) return false;
  if (/^\d+\s*$/.test(text)) return false;

  // Numbered citation: "[1] Author..." (IEEE style)
  if (/^\[\d+\]\s+/.test(text)) return true;

  if (!/^[A-Z\u00C0-\u024F]/.test(text)) return false;

  // Person-author starts: "Lastname, Firstname ..."
  // Exclude publisher-location patterns and common non-name words that appear on wrapped lines
  if (/^[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F'\u2019.\-]+,\s+[A-Z\u00C0-\u024F]/.test(text)) {
    if (/^[A-Z][A-Za-z\s]+,\s+[A-Z]{2}\s*:/.test(text)) return false;
    if (/^(Dissertation|Thesis|Theses|Journal|Computers?|University|Department|Faculty|Ministry|Province|Government|Report|Paper|Conference|School|Press|Association|Institute|Committee|Society|Museum|Archive|Archives|Magazine|Newsletter|Vol|Chapter|Retrieved|Available|Accessed|Edited|Translated|Published|Information|Education|Teacher|Teachers|Inc|York|Studies|Study|Distribution|Exceptional|December|January|February|March|April|May|June|July|August|September|October|November)\.?,/i.test(text)) return false;
    return true;
  }

  // Organization-author starts: "BCTF Newsletter. ..." (must be multi-word)
  // Single words before the period ("America.", "Canada.") are location/fragment artifacts, not org authors.
  if (/^[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F0-9&'"\u2019.\- ]{1,90}\.\s+(?:[""'\u201C\u201D\u2018\u2019]|[A-Z\u00C0-\u024F])/.test(text)) {
    // Check that the org name before the sentence-ending period is multi-word.
    // Strip dotted acronyms (e.g. "B.C.T.F.") before checking for spaces.
    const stripped = text.replace(/^([A-Z]\.)+\s*/, (m) => m.replace(/\./g, ''));
    const beforePeriod = stripped.match(/^([^.]+)\./)?.[1]?.trim() || '';
    if (!/\s/.test(beforePeriod)) return false;
    // Reject date fragments: "December 1980.", "October 1983.", etc.
    if (/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/.test(text)) return false;
    return true;
  }

  return false;
}

export function parseBibliography(fullText) {
  if (!fullText) return [];

  // Normalize form feeds to newlines and collapse OCR character-spacing so
  // headings like "L I T E R A T U R E  C I T E D" become matchable.
  // Then strip OCR page-number prefixes fused to heading words at line starts,
  // e.g. "-97BIBLIOGRAPHY" → "BIBLIOGRAPHY" (a common pdftotext artifact in
  // older scanned dissertations where the margin page marker is on the same line).
  const text = collapseOcrSpacing(fullText.replace(/\f/g, '\n'))
    .replace(/^-?\d+([A-Z\u00C0-\u024F])/gm, '$1');

  // Find the LAST occurrence of the heading (skip table-of-contents references)
  let lastMatch = null;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const remaining = text.slice(searchFrom);
    const m = remaining.match(BIBLIOGRAPHY_HEADING);
    if (!m) break;
    lastMatch = { index: searchFrom + m.index, length: m[0].length };
    searchFrom = lastMatch.index + lastMatch.length;
  }
  if (!lastMatch) return [];

  const startIdx = lastMatch.index + lastMatch.length;
  let endText = text.slice(startIdx);

  const appendixMatch = endText.match(APPENDIX_HEADING);
  if (appendixMatch) {
    endText = endText.slice(0, appendixMatch.index);
  }

  // Split on double newlines (page boundaries in pdftotext output)
  const rawBlocks = endText.split(/\n\s*\n/);

  // Sub-split each block on likely citation starts to un-clump merged entries.
  // This handles both person-author and organization-author bibliography lines.
  const entries = [];
  for (const block of rawBlocks) {
    const cleaned = block.replace(/\s*\n\s*/g, ' ').trim();
    if (!cleaned) continue;

    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const subEntries = [];
    let current = [];
    for (const line of lines) {
      if (isLikelyCitationStart(line) && current.length) {
        subEntries.push(current.join(' '));
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length) subEntries.push(current.join(' '));

    if (subEntries.length > 1) {
      entries.push(...subEntries);
    } else {
      entries.push(cleaned);
    }
  }

  // Filter out non-citation content
  const citations = [];
  for (const rawEntry of entries) {
    // Strip leading footnote/endnote number: "146 Caplan, ..." or "31. Author ..." → "Author ..."
    const entry = collapseOcrSpacing(rawEntry).replace(/^\d{1,4}[.\s]\s*(?=[A-Z\u00C0-\u024F])/, '');
    if (entry.length < 20) continue;
    if (entry.length > 2000) continue;
    if (/^\d+\s*$/.test(entry)) continue;                          // bare page numbers
    if (/^(appendix|chapter|section)\b/i.test(entry)) continue;
    if (/[.·]{5,}/.test(entry)) continue;                          // dot leaders
    if (/^(list of|table of|figure\s|table\s)/i.test(entry)) continue;
    if (/^(abstract|acknowledge?ment|dedication|a\s+thesis|the\s+university|in\s+this)/i.test(entry)) continue;
    if (/^(submitted|faculty|doctor|copyright|©)/i.test(entry)) continue;
    // Survey/questionnaire items from appendices: "4. How many years have you..."
    if (/^\d+\.\s+(?:How|Do|Did|Does|Have|Has|Would|Should|Could|Can|What|When|Where|Who|Which|Is|Are|Were|Was|Please|Describe|Indicate|Rate|Check|List|Select|Choose|Rank|Mark|Circle)\b/i.test(entry)) continue;
    if (/^[A-Z][A-Za-z\s]+,\s+[A-Z]{2}\s*:/.test(entry)) continue; // "Toronto, ON: ..."
    if (/^[A-Z][A-Za-z]+\.\s+/.test(entry) && !/\s/.test(entry.match(/^([^.]+)\./)?.[1]?.trim() || '')) continue; // single-word prefix fragments ("Canada. ...", "America. ...")
    if (entry.length < 60 && !/\b(1[89]\d{2}|20[0-2]\d)\b/.test(entry) && /:/.test(entry)) continue; // short fragments with colon but no year
    if (entry.length < 40 && !/\b(1[89]\d{2}|20[0-2]\d)\b/.test(entry)) continue; // very short fragments without a year
    // Short entries without a person-author start, quoted title, or URL/DOI are likely truncated tails
    if (entry.length < 60 && !/^[A-Z][A-Za-z'\u2019.-]+,\s+[A-Z]/.test(entry) && !/[""\u201C\u201D]/.test(entry) && !/https?:|doi[.:]/.test(entry)) continue;
    if (!/[a-zA-Z]{3,}/.test(entry)) continue;                     // must contain words
    citations.push(entry);
  }

  return citations;
}

export function normalizeCitation(text) {
  const normalized = text
    .toLowerCase()
    // Remove all periods — normalises initials (J.A. → JA), trailing dots, and
    // common abbreviations ("Mass." → "Mass", "Ed." → "Ed").
    .replace(/\./g, '')
    // Strip the standalone article "the" so that "The University of Chicago Press"
    // and "University of Chicago Press" hash identically.  The word appears
    // symmetrically in titles too ("The Human Condition" → "Human Condition"),
    // so removing it does not create false positives across different works.
    .replace(/\bthe\b\s*/g, '')
    // Normalise common US/Canadian place-of-publication abbreviations so that
    // "Cambridge, Mass" and "Cambridge, MA" produce the same hash.
    .replace(/\bmass(achusetts)?\b/g, 'ma')
    .replace(/\bconn(ecticut)?\b/g, 'ct')
    .replace(/\bcalif(ornia)?\b/g, 'ca')
    .replace(/\bnew york\b/g, 'ny')
    .replace(/\bn y\b/g, 'ny')
    .replace(/\bnew jersey\b/g, 'nj')
    .replace(/\bn j\b/g, 'nj')
    .replace(/\bont(ario)?\b/g, 'on')
    .replace(/\bbc\b|\bbritish columbia\b/g, 'bc')
    // Collapse spaces between adjacent single letters: "J A Smith" → "JA Smith".
    // Run twice to handle up to 4 consecutive initials.
    .replace(/\b([a-z]) ([a-z])\b/g, '$1$2')
    .replace(/\b([a-z]) ([a-z])\b/g, '$1$2')
    // Normalise author-list semicolons to commas: "Ball, SJ; Gold, A" → "Ball, SJ, Gold, A".
    .replace(/;\s*/g, ', ')
    // Remove stray commas immediately before an opening parenthesis: ", (1993)" → " (1993)".
    .replace(/,\s*\(/g, ' (')
    // Remove spaces before opening parentheses: "103 (6)" → "103(6)".
    .replace(/\s+\(/g, '(')
    // Normalise spacing around remaining punctuation: "MA:Harvard" → "MA: Harvard".
    .replace(/\s*([,:]) \s*/g, '$1 ')
    // Collapse all remaining whitespace and strip trailing punctuation.
    .replace(/\s+/g, ' ')
    .replace(/[,;:\s]+$/, '')
    .trim();
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

function supervisorsFromCommittee(committee) {
  return dedupeSupervisorNames(
    (committee || [])
      .filter((member) => SUPERVISOR_ROLES.has(member.role))
      .map((member) => member.name)
  );
}

function hasApiSupervisors(doc) {
  return dedupeSupervisorNames(doc?.supervisors || []).length > 0;
}

export function detectDownloadBlockPage(html) {
  const text = String(html || '').toLowerCase();
  return (
    text.includes('your request was blocked because our system detected unusual activity')
    || text.includes('ubc cybersecurity block page')
    || (text.includes('sorry for the inconvenience') && text.includes('reference id:'))
    || (text.includes('f5') && text.includes('the requested url was rejected'))
  );
}

export async function extractAndSaveParsedData(doc, fullText, pdfPath) {
  if (!fullText) return;

  // --- Committee extraction ---
  try {
    const committee = parseCommittee(fullText);
    // Fall back to acknowledgements-based parsing when the certify-page parser finds nothing
    const effectiveCommittee = committee.length > 0 ? committee : parseAcknowledgements(fullText);

    if (hasApiSupervisors(doc)) {
      const apiSupervisors = dedupeSupervisorNames(doc.supervisors || []);
      const nonSupervisorCommittee = effectiveCommittee.filter((member) => !SUPERVISOR_ROLES.has(member.role));
      if (nonSupervisorCommittee.length) {
        await saveCommitteeMembers(doc.id, nonSupervisorCommittee, 'pdf');
      }
      await deleteCommitteeMembersByRoles(doc.id, ['Supervisor', 'Co-Supervisor'], 'pdf');
      await saveCommitteeMembers(
        doc.id,
        apiSupervisors.map((name) => ({ name, role: 'Supervisor', affiliation: null })),
        'api'
      );
      doc.supervisors = apiSupervisors;
      doc.supervisorsSource = 'api';
    } else {
      if (effectiveCommittee.length) {
        await saveCommitteeMembers(doc.id, effectiveCommittee, 'pdf');
      }
      const parsedSupervisors = supervisorsFromCommittee(effectiveCommittee);
      if (parsedSupervisors.length) {
        doc.supervisors = parsedSupervisors;
        doc.supervisorsSource = committee.length > 0 ? 'pdf_fallback' : 'pdf_acknowledgements';
      }
    }
    doc.committee = await loadCommitteeMembers(doc.id);

    if ((!doc.supervisors || !doc.supervisors.length) && doc.committee.length) {
      const storedSupervisors = supervisorsFromCommittee(doc.committee);
      if (storedSupervisors.length) {
        doc.supervisors = storedSupervisors;
        doc.supervisorsSource = doc.committee.some((member) =>
          SUPERVISOR_ROLES.has(member.role) && member.source === 'api'
        )
          ? 'api'
          : 'pdf_fallback';
      }
    }
  } catch (err) {
    logger.warn('Failed to extract committee from PDF', { docId: doc.id, error: err.message });
  }

  // --- Citation extraction (independent of committee success) ---
  // Fallback chain: GROBID (PDF layout) → AnyStyle (text ML) → regex
  try {
    let citations = null;
    if (pdfPath) {
      citations = await parseBibliographyWithGrobid(pdfPath);
    }
    if (!citations) {
      const textCitations = await parseBibliographyWithAnyStyle(fullText);
      citations = textCitations.map(text => ({ text }));
    }
    await clearDocumentCitations(doc.id);
    if (citations.length) {
      await saveCitations(doc.id, citations, normalizeCitation);
    }
    doc.citationCount = citations.length || (await loadDocumentCitations(doc.id)).length;
  } catch (err) {
    logger.warn('Failed to extract citations from PDF', { docId: doc.id, error: err.message });
  }

  try {
    await saveDocumentMetadata(doc);
  } catch (err) {
    logger.warn('Failed to save document metadata', { docId: doc.id, error: err.message });
  }
}

async function loadStoredParsedData(doc) {
  try {
    doc.committee = await loadCommitteeMembers(doc.id);
    doc.citationCount = (await loadDocumentCitations(doc.id)).length;
    if ((!doc.supervisors || !doc.supervisors.length) && doc.committee.length) {
      const storedSupervisors = supervisorsFromCommittee(doc.committee);
      if (storedSupervisors.length) {
        doc.supervisors = storedSupervisors;
        doc.supervisorsSource = doc.committee.some((member) =>
          SUPERVISOR_ROLES.has(member.role) && member.source === 'api'
        )
          ? 'api'
          : 'pdf_fallback';
      }
    }
  } catch {
    doc.committee = [];
    doc.citationCount = 0;
  }
}

export async function analyzeDocumentFile(doc, options) {
  const { downloadFiles, forceDownload, recomputeFromCache } = options;
  const stored = await loadStoredFileMetric(doc.id);
  const hasCachedPdf = stored?.pdf_path && (await fileExists(stored.pdf_path));
  const hasCachedFullTextMetric = hasStoredFullTextMetric(stored);

  if (recomputeFromCache) {
    if (!hasCachedPdf) {
      if (await analyzeCachedFullText(doc, stored, {
        status: 'full_text_recomputed',
        error: null
      })) return;
      doc.downloadStatus = 'cache_miss';
      doc.downloadError = 'No local cached PDF or full-text file available for recomputation.';
      await saveFileMetric(doc.id, {
        status: 'cache_miss',
        error: doc.downloadError,
        pdfPath: stored?.pdf_path || null,
        downloadUrl: stored?.download_url || null,
        fileBytes: stored?.file_bytes || null,
        wordCount: stored?.word_count || null,
        bodyWordCount: stored?.body_word_count || null,
        ...storedFullTextFields(stored),
        pageCount: stored?.page_count || null,
        wordSource: stored?.word_source || null,
        pageSource: stored?.page_source || null
      });
      return;
    }

    try {
      const analysis = await analyzePdfAtPath(stored.pdf_path);
      if (analysis.pageCount) {
        doc.pages = analysis.pageCount;
        doc.pagesSource = 'cached_pdf';
      }
      if (analysis.wordCount) {
        doc.wordCount = analysis.wordCount;
        doc.wordCountSource = 'cached_pdf_text';
      }
      if (analysis.bodyWordCount) {
        doc.bodyWordCount = analysis.bodyWordCount;
      }
      doc.fileBytes = analysis.fileBytes;
      doc.downloadUrl = stored.download_url || null;
      doc.downloadStatus = 'recomputed_from_cache';
      doc.downloadError = null;

      await saveFileMetric(doc.id, {
        status: 'recomputed_from_cache',
        error: null,
        pdfPath: stored.pdf_path,
        downloadUrl: stored.download_url,
        fileBytes: analysis.fileBytes,
        wordCount: doc.wordCount,
        bodyWordCount: doc.bodyWordCount,
        ...storedFullTextFields(stored),
        pageCount: doc.pages,
        wordSource: doc.wordCountSource,
        pageSource: doc.pagesSource
      });
      await extractAndSaveParsedData(doc, analysis.fullText, stored.pdf_path);
      return;
    } catch (error) {
      doc.downloadStatus = 'cache_error';
      doc.downloadError = error instanceof Error ? error.message : String(error);
      await saveFileMetric(doc.id, {
        status: 'cache_error',
        error: doc.downloadError,
        pdfPath: stored.pdf_path,
        downloadUrl: stored.download_url,
        fileBytes: stored.file_bytes || null,
        wordCount: stored.word_count || null,
        bodyWordCount: stored.body_word_count || null,
        ...storedFullTextFields(stored),
        pageCount: stored.page_count || null,
        wordSource: stored.word_source || null,
        pageSource: stored.page_source || null
      });
      return;
    }
  }

  if (!forceDownload && hasCachedPdf) {
    applyStoredMetricToDoc(doc, stored, 'cached');
    await loadStoredParsedData(doc);
    return;
  }

  if (!forceDownload && hasCachedFullTextMetric) {
    await applyStoredFullTextMetric(doc, stored);
    return;
  }

  if (!downloadFiles) {
    if (hasCachedPdf) {
      applyStoredMetricToDoc(doc, stored, 'cached');
      await loadStoredParsedData(doc);
    } else if (hasCachedFullTextMetric) {
      await applyStoredFullTextMetric(doc, stored);
    } else {
      if (await analyzeDocumentFullTextFallback(doc, stored, {
        status: 'full_text',
        error: null
      })) return;
      doc.downloadStatus = 'skipped';
    }
    return;
  }

  await acquireDownloadSlot();
  logger.info('Downloading PDF from cIRcle REST bitstreams', { docId: doc.id });

  const resolved = await fetchPdfForDocument(doc);
  if (resolved) {
    const fileHash = crypto.createHash('sha1').update(resolved.downloadUrl).digest('hex');
    const cachePath = path.join(PDF_CACHE_DIR, `${fileHash}.pdf`);

    try {
      await fs.writeFile(cachePath, resolved.bytes);
      const analysis = await analyzePdfAtPath(cachePath, resolved.bytes);

      if (analysis.pageCount) {
        doc.pages = analysis.pageCount;
        doc.pagesSource = 'downloaded_pdf';
      }
      if (analysis.wordCount) {
        doc.wordCount = analysis.wordCount;
        doc.wordCountSource = 'downloaded_pdf_text';
      }
      if (analysis.bodyWordCount) {
        doc.bodyWordCount = analysis.bodyWordCount;
      }

      doc.fileBytes = analysis.fileBytes;
      doc.downloadUrl = resolved.downloadUrl;
      doc.downloadStatus = forceDownload ? 'redownloaded' : 'downloaded';
      doc.downloadError = null;

      await saveFileMetric(doc.id, {
        status: doc.downloadStatus,
        error: null,
        pdfPath: cachePath,
        downloadUrl: resolved.downloadUrl,
        fileBytes: analysis.fileBytes,
        wordCount: doc.wordCount,
        bodyWordCount: doc.bodyWordCount,
        ...storedFullTextFields(stored),
        pageCount: doc.pages,
        wordSource: doc.wordCountSource,
        pageSource: doc.pagesSource
      });
      await extractAndSaveParsedData(doc, analysis.fullText, cachePath);
      logger.info('PDF downloaded and analyzed', {
        docId: doc.id,
        bitstreamId: resolved.bitstreamId,
        pages: doc.pages,
        words: doc.wordCount
      });
      return;
    } catch (error) {
      doc.downloadError = error instanceof Error ? error.message : String(error);
    }
  }

  if (await analyzeDocumentFullTextFallback(doc, stored, {
    status: 'full_text_fallback',
    error: doc.downloadError || 'No downloadable PDF could be resolved for this record.'
  })) return;

  doc.downloadStatus = 'not_found';
  if (!doc.downloadError) doc.downloadError = 'No downloadable PDF could be resolved for this record.';

  await saveFileMetric(doc.id, {
    status: 'not_found',
    error: doc.downloadError,
    pdfPath: stored?.pdf_path || null,
    downloadUrl: stored?.download_url || null,
    fileBytes: stored?.file_bytes || null,
    wordCount: stored?.word_count || null,
    bodyWordCount: stored?.body_word_count || null,
    ...storedFullTextFields(stored),
    pageCount: stored?.page_count || null,
    wordSource: stored?.word_source || null,
    pageSource: stored?.page_source || null
  });
}

export async function enrichDocumentsWithFileAnalysis(documents, options) {
  for (const doc of documents) await saveDocumentMetadata(doc);

  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, FILE_CONCURRENCY) }, async () => {
    while (cursor < documents.length) {
      const idx = cursor;
      cursor += 1;
      await analyzeDocumentFile(documents[idx], options);
      await saveDocumentMetadata(documents[idx]);
    }
  });

  await Promise.all(workers);
}

export async function deleteCachedPdf(docId) {
  const stored = await loadStoredFileMetric(docId);
  if (stored?.pdf_path) {
    try {
      await fs.unlink(stored.pdf_path);
      logger.info('Deleted cached PDF file', { docId, path: stored.pdf_path });
    } catch {
      // File may already be gone
    }
  }
  if (stored?.full_text_path) {
    try {
      await fs.unlink(stored.full_text_path);
      logger.info('Deleted cached full-text file', { docId, path: stored.full_text_path });
    } catch {
      // File may already be gone
    }
  }
}

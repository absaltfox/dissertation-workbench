import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDF_CACHE_DIR, FILE_CONCURRENCY, MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT_MS } from './config.js';
import { loadStoredFileMetric, saveFileMetric, saveDocumentMetadata, saveCommitteeMembers, loadCommitteeMembers, saveCitations, loadDocumentCitations } from './db.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

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
  doc.fileBytes = stored.file_bytes ? Number(stored.file_bytes) : null;
  doc.downloadUrl = stored.download_url || null;
  doc.downloadStatus = statusOverride;
  doc.downloadError = stored.error || null;
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

async function extractPdfText(filePath) {
  if (!(await ensurePdftotextAvailability())) return { text: null, wordCount: null };
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-enc', 'UTF-8', filePath, '-']);
    const text = String(stdout || '');
    const wordCount = text
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean).length;
    return { text, wordCount: wordCount || null };
  } catch {
    return { text: null, wordCount: null };
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
  const { text, wordCount } = await extractPdfText(pdfPath);
  return {
    pageCount: pageCount || null,
    wordCount: wordCount || null,
    fileBytes: fileBytes.length,
    fullText: text || null
  };
}

// --- Committee & Bibliography Parsing ---

const ROLE_PATTERNS = [
  { pattern: /\bco-?supervisor\b/i, role: 'Co-Supervisor' },
  { pattern: /\bsupervisor\b/i, role: 'Supervisor' },
  { pattern: /\bsupervisory committee member\b/i, role: 'Supervisory Committee Member' },
  { pattern: /\buniversity examiner\b/i, role: 'University Examiner' },
  { pattern: /\bexternal examiner\b/i, role: 'External Examiner' },
];

export function parseCommittee(fullText) {
  if (!fullText) return [];

  const startMatch = fullText.match(/the following individuals certify/i);
  if (!startMatch) return [];

  const startIdx = startMatch.index;
  const section = fullText.slice(startIdx, startIdx + 3000);
  const lines = section.split(/\n/).map((l) => l.trim()).filter(Boolean);

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
      // Look backwards for name/affiliation lines (1-2 lines above)
      let name = '';
      let affiliation = '';

      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        const prev = lines[j];
        // Skip lines that are themselves role lines or the header
        if (ROLE_PATTERNS.some(({ pattern }) => pattern.test(prev))) break;
        if (/the following individuals certify/i.test(prev)) break;
        if (/examining committee/i.test(prev)) break;
        if (/entitled/i.test(prev)) break;

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

      if (name && name.length > 1 && name.length < 120) {
        // Skip label lines captured as names
        if (/^(additional|examining)\s+/i.test(name) || /committee\s+member/i.test(name)) continue;
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

const BIBLIOGRAPHY_HEADING = /^(references|bibliography|works\s+cited)\s*$/im;
const APPENDIX_HEADING = /^(appendix|appendices)\b/im;

export function parseBibliography(fullText) {
  if (!fullText) return [];

  // Find the LAST occurrence of the heading (skip table-of-contents references)
  let lastMatch = null;
  let searchFrom = 0;
  while (searchFrom < fullText.length) {
    const remaining = fullText.slice(searchFrom);
    const m = remaining.match(BIBLIOGRAPHY_HEADING);
    if (!m) break;
    lastMatch = { index: searchFrom + m.index, length: m[0].length };
    searchFrom = lastMatch.index + lastMatch.length;
  }
  if (!lastMatch) return [];

  const startIdx = lastMatch.index + lastMatch.length;
  let endText = fullText.slice(startIdx);

  const appendixMatch = endText.match(APPENDIX_HEADING);
  if (appendixMatch) {
    endText = endText.slice(0, appendixMatch.index);
  }

  // Split on double newlines (paragraph boundaries)
  const rawEntries = endText.split(/\n\s*\n/).map((entry) =>
    entry.replace(/\s*\n\s*/g, ' ').trim()
  );

  const citations = [];
  for (const entry of rawEntries) {
    if (entry.length < 20) continue;
    // Skip entries that look like page numbers, section headers, or TOC noise
    if (/^\d+$/.test(entry)) continue;
    if (/^(appendix|chapter|section)\b/i.test(entry)) continue;
    if (/[.·]{5,}/.test(entry)) continue; // dotted leader lines from TOC
    if (/^(list of|table of|figure\s)/i.test(entry)) continue;
    citations.push(entry);
  }

  return citations;
}

export function normalizeCitation(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').replace(/\.\s*$/, '').trim();
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

async function resolveDownloadUrl(candidateUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(candidateUrl, { redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) return null;

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      logger.warn('Download skipped: file too large', { url: candidateUrl, bytes: contentLength });
      return null;
    }

    const finalUrl = res.url || candidateUrl;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('pdf') || /\.pdf($|\?)/i.test(finalUrl)) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_DOWNLOAD_BYTES) return null;
      return { downloadUrl: finalUrl, bytes };
    }

    if (!contentType.includes('html')) return null;

    const html = await res.text();
    const matches = Array.from(html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)).map((m) => m[1]);
    for (const href of matches) {
      try {
        const pdfUrl = new URL(href, finalUrl).toString();
        const pdfController = new AbortController();
        const pdfTimeout = setTimeout(() => pdfController.abort(), DOWNLOAD_TIMEOUT_MS);
        let pdfRes;
        try {
          pdfRes = await fetch(pdfUrl, { redirect: 'follow', signal: pdfController.signal });
        } finally {
          clearTimeout(pdfTimeout);
        }
        if (!pdfRes.ok) continue;
        const pdfType = pdfRes.headers.get('content-type') || '';
        if (!pdfType.includes('pdf') && !/\.pdf($|\?)/i.test(pdfRes.url || pdfUrl)) continue;
        const bytes = Buffer.from(await pdfRes.arrayBuffer());
        if (bytes.length > MAX_DOWNLOAD_BYTES) continue;
        return { downloadUrl: pdfRes.url || pdfUrl, bytes };
      } catch {
        // Try next candidate.
      }
    }

    return null;
  } catch {
    return null;
  }
}

function extractAndSaveParsedData(doc, fullText) {
  if (!fullText) return;
  try {
    const committee = parseCommittee(fullText);
    if (committee.length) {
      saveCommitteeMembers(doc.id, committee, 'pdf');
    }
    doc.committee = committee.length ? committee : loadCommitteeMembers(doc.id);

    const citations = parseBibliography(fullText);
    if (citations.length) {
      saveCitations(doc.id, citations, normalizeCitation);
    }
    doc.citationCount = citations.length || loadDocumentCitations(doc.id).length;
  } catch (err) {
    logger.warn('Failed to extract committee/citations from PDF', { docId: doc.id, error: err.message });
  }
}

function loadStoredParsedData(doc) {
  try {
    doc.committee = loadCommitteeMembers(doc.id);
    doc.citationCount = loadDocumentCitations(doc.id).length;
  } catch {
    doc.committee = [];
    doc.citationCount = 0;
  }
}

export async function analyzeDocumentFile(doc, options) {
  const { downloadFiles, forceDownload, recomputeFromCache } = options;
  const stored = loadStoredFileMetric(doc.id);
  const hasCachedPdf = stored?.pdf_path && (await fileExists(stored.pdf_path));

  if (recomputeFromCache) {
    if (!hasCachedPdf) {
      doc.downloadStatus = 'cache_miss';
      doc.downloadError = 'No local cached PDF available for recomputation.';
      saveFileMetric(doc.id, {
        status: 'cache_miss',
        error: doc.downloadError,
        pdfPath: stored?.pdf_path || null,
        downloadUrl: stored?.download_url || null,
        fileBytes: stored?.file_bytes || null,
        wordCount: stored?.word_count || null,
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
      doc.fileBytes = analysis.fileBytes;
      doc.downloadUrl = stored.download_url || null;
      doc.downloadStatus = 'recomputed_from_cache';
      doc.downloadError = null;

      saveFileMetric(doc.id, {
        status: 'recomputed_from_cache',
        error: null,
        pdfPath: stored.pdf_path,
        downloadUrl: stored.download_url,
        fileBytes: analysis.fileBytes,
        wordCount: doc.wordCount,
        pageCount: doc.pages,
        wordSource: doc.wordCountSource,
        pageSource: doc.pagesSource
      });
      extractAndSaveParsedData(doc, analysis.fullText);
      return;
    } catch (error) {
      doc.downloadStatus = 'cache_error';
      doc.downloadError = error instanceof Error ? error.message : String(error);
      saveFileMetric(doc.id, {
        status: 'cache_error',
        error: doc.downloadError,
        pdfPath: stored.pdf_path,
        downloadUrl: stored.download_url,
        fileBytes: stored.file_bytes || null,
        wordCount: stored.word_count || null,
        pageCount: stored.page_count || null,
        wordSource: stored.word_source || null,
        pageSource: stored.page_source || null
      });
      return;
    }
  }

  if (!forceDownload && hasCachedPdf) {
    applyStoredMetricToDoc(doc, stored, 'cached');
    loadStoredParsedData(doc);
    return;
  }

  if (!downloadFiles) {
    if (hasCachedPdf) {
      applyStoredMetricToDoc(doc, stored, 'cached');
      loadStoredParsedData(doc);
    } else {
      doc.downloadStatus = 'skipped';
    }
    return;
  }

  logger.info('Downloading PDF', { docId: doc.id, candidates: doc.downloadCandidates.length });

  for (const candidate of doc.downloadCandidates) {
    const resolved = await resolveDownloadUrl(candidate);
    if (!resolved) continue;

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

      doc.fileBytes = analysis.fileBytes;
      doc.downloadUrl = resolved.downloadUrl;
      doc.downloadStatus = forceDownload ? 'redownloaded' : 'downloaded';
      doc.downloadError = null;

      saveFileMetric(doc.id, {
        status: doc.downloadStatus,
        error: null,
        pdfPath: cachePath,
        downloadUrl: resolved.downloadUrl,
        fileBytes: analysis.fileBytes,
        wordCount: doc.wordCount,
        pageCount: doc.pages,
        wordSource: doc.wordCountSource,
        pageSource: doc.pagesSource
      });
      extractAndSaveParsedData(doc, analysis.fullText);
      logger.info('PDF downloaded and analyzed', { docId: doc.id, pages: doc.pages, words: doc.wordCount });
      return;
    } catch (error) {
      doc.downloadError = error instanceof Error ? error.message : String(error);
    }
  }

  doc.downloadStatus = 'not_found';
  if (!doc.downloadError) doc.downloadError = 'No downloadable PDF could be resolved for this record.';

  saveFileMetric(doc.id, {
    status: 'not_found',
    error: doc.downloadError,
    pdfPath: stored?.pdf_path || null,
    downloadUrl: stored?.download_url || null,
    fileBytes: stored?.file_bytes || null,
    wordCount: stored?.word_count || null,
    pageCount: stored?.page_count || null,
    wordSource: stored?.word_source || null,
    pageSource: stored?.page_source || null
  });
}

export async function enrichDocumentsWithFileAnalysis(documents, options) {
  for (const doc of documents) saveDocumentMetadata(doc);

  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, FILE_CONCURRENCY) }, async () => {
    while (cursor < documents.length) {
      const idx = cursor;
      cursor += 1;
      await analyzeDocumentFile(documents[idx], options);
    }
  });

  await Promise.all(workers);
}

export async function deleteCachedPdf(docId) {
  const stored = loadStoredFileMetric(docId);
  if (stored?.pdf_path) {
    try {
      await fs.unlink(stored.pdf_path);
      logger.info('Deleted cached PDF file', { docId, path: stored.pdf_path });
    } catch {
      // File may already be gone
    }
  }
}

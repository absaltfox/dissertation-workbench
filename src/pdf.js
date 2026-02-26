import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDF_CACHE_DIR, FILE_CONCURRENCY, MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT_MS, PDF_DOWNLOAD_RATE_PER_MIN } from './config.js';
import {
  loadStoredFileMetric, saveFileMetric, saveDocumentMetadata, saveCommitteeMembers,
  loadCommitteeMembers, saveCitations, loadDocumentCitations, deleteCommitteeMembersByRoles
} from './db.js';
import { logger } from './logger.js';
import { dedupeSupervisorNames } from './supervisors.js';

const execFileAsync = promisify(execFile);

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
const SUPERVISOR_ROLES = new Set(['Supervisor', 'Co-Supervisor']);

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
    if (!/^[A-Z\u00C0-\u024F]/.test(stripped)) break;
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

// Matches the last occurrence of an ACKNOWLEDGEMENTS section heading.
// pdftotext prepends \f (form feed) at each page boundary.
const ACK_HEADING_RE = /(?:^|\n|\f)(ACKNOWLEDGEMENTS?|Acknowledgements?)\s*\n/g;
// Capture group: 1–4 tokens each starting with uppercase, including \S* tail and optional trailing space
const DR_CAP = '((?:[A-Z\\u00C0-\\u024F]\\S*\\s*){1,4})';

export function parseAcknowledgements(fullText) {
  if (!fullText) return [];

  // Normalize form feeds so they appear as newlines to the heading regex
  const text = fullText.replace(/\f/g, '\n');

  // Use the LAST occurrence of the heading (first occurrence is usually the Table of Contents)
  let lastMatch = null;
  let m;
  ACK_HEADING_RE.lastIndex = 0;
  while ((m = ACK_HEADING_RE.exec(text)) !== null) lastMatch = m;
  if (!lastMatch) return [];

  const section = text.slice(lastMatch.index + lastMatch[0].length, lastMatch.index + lastMatch[0].length + 3000);

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

  // "my supervisor Dr. X" / "research supervisor Dr. X" / "my co-supervisor Dr. X"
  // Allow optional comma between "supervisor" and "Dr." (e.g. "my supervisor, Dr. X")
  for (const pm of section.matchAll(new RegExp(
    `(?:my|research)\\s+(co-?)?supervisor,?\\s+Dr\\.\\s+${DR_CAP}`, 'gi'
  ))) {
    addMember(pm[2], pm[1] ? 'Co-Supervisor' : 'Supervisor');
  }

  // "Committee Chair Dr. X"
  for (const pm of section.matchAll(new RegExp(`Committee\\s+Chair\\s+Dr\\.\\s+${DR_CAP}`, 'gi'))) {
    addMember(pm[1], 'Supervisor');
  }

  // "Dr. X (Supervisor)" or "Dr. X (Co-Supervisor)"
  for (const pm of section.matchAll(new RegExp(`Dr\\.\\s+${DR_CAP}\\s*\\(\\s*(Co-?)?Supervisor\\s*\\)`, 'gi'))) {
    addMember(pm[1], pm[2] ? 'Co-Supervisor' : 'Supervisor');
  }

  // "Dr. X, my supervisor" / "Dr. X, my committee chair" / "Dr. X, as my committee chair"
  for (const pm of section.matchAll(new RegExp(`Dr\\.\\s+${DR_CAP},\\s*(?:as\\s+)?(?:my\\s+)?(?:supervisor|committee\\s+chair)\\b`, 'gi'))) {
    addMember(pm[1], 'Supervisor');
  }

  // "Dr. X, as co-advisor" / "Dr. X, as my co-advisor"
  for (const pm of section.matchAll(new RegExp(`Dr\\.\\s+${DR_CAP},\\s*as\\s+(?:my\\s+)?co-?advisor\\b`, 'gi'))) {
    addMember(pm[1], 'Co-Supervisor');
  }

  // "co-advisor Dr. X" / "co-advisor, Dr. X"
  for (const pm of section.matchAll(new RegExp(`co-?advisor,?\\s+Dr\\.\\s+${DR_CAP}`, 'gi'))) {
    addMember(pm[1], 'Co-Supervisor');
  }

  // "Dr. X ... as my supervisor" (name comes before the role keyword, within 150 chars)
  for (const pm of section.matchAll(new RegExp(`Dr\\.\\s+${DR_CAP}[^.]{0,150}as\\s+(?:my\\s+)?(?:(co-?))?supervisor`, 'gi'))) {
    addMember(pm[1], pm[2] ? 'Co-Supervisor' : 'Supervisor');
  }

  // --- Committee member patterns ---
  // Sentences containing "committee members" — extract remaining Dr. names not already supervisors
  for (const cm of section.matchAll(/committee\s+members?[^.!?\n]{0,400}/gi)) {
    for (const dm of cm[0].matchAll(new RegExp(`Dr\\.\\s+${DR_CAP}`, 'g'))) {
      const name = extractNameFromCapture(dm[1]);
      if (name && !seen.has(`${name}|Supervisor`) && !seen.has(`${name}|Co-Supervisor`)) {
        addMember(dm[1], 'Supervisory Committee Member');
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

const BIBLIOGRAPHY_HEADING = /^(references|bibliography|works\s+cited)$/im;
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

  // Normalize form feeds to newlines so page-break headings are matchable
  const text = fullText.replace(/\f/g, '\n');

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
  for (const entry of entries) {
    if (entry.length < 20) continue;
    if (entry.length > 2000) continue;
    if (/^\d+\s*$/.test(entry)) continue;                          // bare page numbers
    if (/^(appendix|chapter|section)\b/i.test(entry)) continue;
    if (/[.·]{5,}/.test(entry)) continue;                          // dot leaders
    if (/^(list of|table of|figure\s|table\s)/i.test(entry)) continue;
    if (/^(abstract|acknowledge?ment|dedication|a\s+thesis|the\s+university|in\s+this)/i.test(entry)) continue;
    if (/^(submitted|faculty|doctor|copyright|©)/i.test(entry)) continue;
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
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').replace(/\.\s*$/, '').trim();
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
    if (/download_blacklist/i.test(finalUrl)) return null;
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

export function extractAndSaveParsedData(doc, fullText) {
  if (!fullText) return;
  try {
    const committee = parseCommittee(fullText);
    // Fall back to acknowledgements-based parsing when the certify-page parser finds nothing
    const effectiveCommittee = committee.length > 0 ? committee : parseAcknowledgements(fullText);

    if (hasApiSupervisors(doc)) {
      const apiSupervisors = dedupeSupervisorNames(doc.supervisors || []);
      const nonSupervisorCommittee = effectiveCommittee.filter((member) => !SUPERVISOR_ROLES.has(member.role));
      if (nonSupervisorCommittee.length) {
        saveCommitteeMembers(doc.id, nonSupervisorCommittee, 'pdf');
      }
      deleteCommitteeMembersByRoles(doc.id, ['Supervisor', 'Co-Supervisor'], 'pdf');
      saveCommitteeMembers(
        doc.id,
        apiSupervisors.map((name) => ({ name, role: 'Supervisor', affiliation: null })),
        'api'
      );
      doc.supervisors = apiSupervisors;
      doc.supervisorsSource = 'api';
    } else {
      if (effectiveCommittee.length) {
        saveCommitteeMembers(doc.id, effectiveCommittee, 'pdf');
      }
      const parsedSupervisors = supervisorsFromCommittee(effectiveCommittee);
      if (parsedSupervisors.length) {
        doc.supervisors = parsedSupervisors;
        doc.supervisorsSource = committee.length > 0 ? 'pdf_fallback' : 'pdf_acknowledgements';
      }
    }
    doc.committee = loadCommitteeMembers(doc.id);

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

    const citations = parseBibliography(fullText);
    if (citations.length) {
      saveCitations(doc.id, citations, normalizeCitation);
    }
    doc.citationCount = citations.length || loadDocumentCitations(doc.id).length;
    saveDocumentMetadata(doc);
  } catch (err) {
    logger.warn('Failed to extract committee/citations from PDF', { docId: doc.id, error: err.message });
  }
}

function loadStoredParsedData(doc) {
  try {
    doc.committee = loadCommitteeMembers(doc.id);
    doc.citationCount = loadDocumentCitations(doc.id).length;
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

  await acquireDownloadSlot();
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
      saveDocumentMetadata(documents[idx]);
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

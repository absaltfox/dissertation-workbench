import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger.js';
import { listPendingLookups, saveCatalogueLookup } from './db.js';

const execFileAsync = promisify(execFile);

const Z3950_HOST = 'ils.library.ubc.ca';
const Z3950_PORT = 7090;
const Z3950_DB = 'VOYAGER';
const BATCH_SIZE = 50;

let hasYazClient;

// --- APA citation parsing ---

/**
 * Extract a searchable author surname and title from an APA-style citation.
 * Returns { author: string|null, title: string|null }.
 */
export function extractSearchTerms(citationText) {
  if (!citationText || typeof citationText !== 'string') {
    return { author: null, title: null };
  }

  let text = citationText.trim();

  // Strip leading numbered-reference markers: "[1]", "[23]", etc.
  text = text.replace(/^\[\d+\]\s*/, '');

  // Normalize OCR-spaced digits inside parentheses: "( 1 9 8 1 )" → "(1981)".
  // Older scanned PDFs frequently have spaces between individual digit characters.
  text = text.replace(/\(\s*(\d)\s+(\d)\s+(\d)\s+(\d)\s*([a-z]?)\s*\)/gi,
    (_, a, b, c, d, s) => `(${a}${b}${c}${d}${s})`);

  // Detect APA vs Chicago: APA has "(YYYY)." early after the author segment,
  // typically as the 2nd or 3rd element. Chicago puts the year at the end or
  // uses quoted titles. Heuristic: if the text has a quoted title before any
  // parenthesized year, prefer Chicago.
  const yearParenIdx = text.search(/\(\d{4}/);
  const quoteIdx = text.search(/[""\u201c]/);
  const useChicagoFirst = quoteIdx !== -1 && (yearParenIdx === -1 || quoteIdx < yearParenIdx);

  if (useChicagoFirst) {
    const chicagoResult = extractChicago(text);
    if (chicagoResult.title) return chicagoResult;
    return extractApa(text);
  }

  // Try APA style first: Author. (Year). Title.
  const apaResult = extractApa(text);
  if (apaResult.title) return apaResult;

  // Fall back to Chicago/Turabian style
  return extractChicago(text);
}

function extractAuthorSurname(beforeTitle) {
  if (!beforeTitle) return null;
  const firstComma = beforeTitle.indexOf(',');
  let author;
  if (firstComma > 0) {
    author = beforeTitle.slice(0, firstComma).trim();
  } else {
    author = beforeTitle.replace(/\.\s*$/, '').trim();
  }
  author = author.replace(/[.,;&]+$/, '').trim();
  return (author && author.length >= 2) ? author : null;
}

function cleanTitle(raw) {
  if (!raw) return null;
  let title = raw.replace(/[*_""]/g, '').trim();
  // Remove trailing punctuation
  title = title.replace(/[.,;:]+$/, '').trim();
  if (!title || title.length < 3) return null;

  // Strip leading editor/translator markers left by extractChicago's part-splitting:
  // "(Ed.) Democracy and difference" → "Democracy and difference"
  title = title.replace(/^\s*\(\s*(?:Ed|Eds|ed|eds)\.?\s*\)\s*/i, '').trim();

  // Strip leading bare year (or year+letter suffix) from Chicago-style citations:
  // "1982 The Paideia Proposal" → "The Paideia Proposal"
  // "1976a Educational Policy" → "Educational Policy"
  title = title.replace(/^\d{4}[a-z]?\s+/, '').trim();

  // Reject a string that IS nothing but a bare year (e.g. "1976a" from a split path)
  if (/^\d{4}[a-z]?$/.test(title)) return null;

  if (!title || title.length < 3) return null;

  // Truncate at colon/subtitle — the main title is more reliable for catalogue matching
  if (title.includes(':')) {
    const mainTitle = title.slice(0, title.indexOf(':')).trim();
    if (mainTitle.length >= 8) title = mainTitle;
  }

  // Truncate very long titles
  if (title.length > 80) {
    title = title.slice(0, 80).replace(/\s+\S*$/, '').trim();
  }

  return title || null;
}

function extractApa(text) {
  // Find the first parenthesized group containing a 4-digit year
  const yearParenMatch = text.match(/\((\d{4}[^)]*)\)/);
  if (!yearParenMatch) return { author: null, title: null };

  const beforeYear = text.slice(0, yearParenMatch.index).trim();
  const author = extractAuthorSurname(beforeYear);

  // Title: text after "(YYYY...)." up to the next sentence-ending period
  const afterYearIdx = yearParenMatch.index + yearParenMatch[0].length;
  let afterYear = text.slice(afterYearIdx).replace(/^\.\s*/, '').trim();

  // Strip translator/edition preambles before the title:
  // "(trans. H. Gray). What is the cinema?" → "What is the cinema?"
  // "(2nd ed.). Principles of..."           → "Principles of..."
  afterYear = afterYear.replace(/^\([^)]{0,60}(?:trans|ed\.?|rev\.?|abridged)[^)]*\)\s*\.?\s*/i, '').trim();

  if (!afterYear) return { author, title: null };

  let titleEnd = -1;
  for (let i = 0; i < afterYear.length; i++) {
    if (afterYear[i] === '.') {
      if (i > 0 && /^[A-Z]$/.test(afterYear[i - 1]) && (i < 2 || /[\s,]/.test(afterYear[i - 2]))) continue;
      const before = afterYear.slice(Math.max(0, i - 4), i).toLowerCase();
      if (/(?:^|\s)(ed|vol|pp|no|dr|st|jr|sr|vs|etc|rev)$/i.test(before)) continue;
      titleEnd = i;
      break;
    }
  }

  const rawTitle = titleEnd > 0 ? afterYear.slice(0, titleEnd) : afterYear;
  return { author, title: cleanTitle(rawTitle) };
}

function extractChicago(text) {
  // Chicago style: Author. "Title." Source. -or- Author. Title. Place: Publisher, Year.
  // First, try quoted title: Author. "Title."
  const quotedMatch = text.match(/^(.+?)\.\s+[""\u201c](.+?)[""\u201d]/);
  if (quotedMatch) {
    const author = extractAuthorSurname(quotedMatch[1].trim());
    const title = cleanTitle(quotedMatch[2]);
    if (title) return { author, title };
  }

  // Bare-year format: "Author YYYY Title" or "Author. YYYY Title" or "Author. YYYYa. Title"
  // Many Chicago/Turabian citations place the year unparenthesized after the author.
  // Scan for the first bare 4-digit year and split on it.
  // Allow an optional period between the year/letter-suffix and the title word.
  const bareYearMatch = text.match(/\b(1[89]\d\d|20\d\d)[a-z]?\.?\s+([A-Z\(].{5,})/);
  if (bareYearMatch) {
    const beforeYear = text.slice(0, bareYearMatch.index).replace(/[.\s]+$/, '');
    const author = extractAuthorSurname(beforeYear) || null;
    // Truncate the captured tail at the first sentence-ending period so we don't
    // drag in the publisher/place/edition that follows the title sentence.
    let rawTitle = bareYearMatch[2];
    const sentenceEnd = rawTitle.search(/\.\s+[A-Z]/);
    if (sentenceEnd > 5) rawTitle = rawTitle.slice(0, sentenceEnd);
    const title = cleanTitle(rawTitle);
    if (title) return { author, title };
  }

  // Institution-authored or title-only entries (e.g. after stripping "[1]"):
  // if the text has no comma in the first 20 chars it's unlikely to be "Last, First. Title."
  // — treat the first sentence directly as the title with no author.
  // Check this BEFORE the split loop so we don't mis-assign a city as the title.
  const firstSentence = text.split(/\.\s+/)[0].trim();
  if (firstSentence.length >= 20 && !/,/.test(firstSentence.slice(0, 20))) {
    const title = cleanTitle(firstSentence);
    if (title) return { author: null, title };
  }

  // Unquoted Chicago: Author. Title. (split on sentence-ending periods)
  // Pattern: "Lastname, Firstname. Title of Work. ..."
  const parts = text.split(/\.\s+/);
  if (parts.length >= 2) {
    // First part(s) are author, next part is likely the title
    const authorPart = parts[0].trim();
    const author = extractAuthorSurname(authorPart);

    // Skip parts that are continuations of the author list rather than titles:
    // "& Surname", "and Firstname", "6c X" (OCR garble of &), "with X".
    // Do NOT skip year-prefixed parts — cleanTitle strips leading years.
    const isAuthorContinuation = (s) =>
      /^(?:[&]|and |6c |with )\s*[A-Z]/i.test(s.trim());

    // If first part looks like a name, scan subsequent parts for a real title
    if (author) {
      for (let i = 1; i < Math.min(parts.length, 5); i++) {
        const candidate = parts[i].trim();
        if (!candidate || candidate.length < 5) continue;
        if (isAuthorContinuation(candidate)) continue;
        const title = cleanTitle(candidate);
        if (title) return { author, title };
      }
    }
  }

  return { author: null, title: null };
}

// --- yaz-client availability ---

export async function checkYazAvailability() {
  if (hasYazClient !== undefined) return hasYazClient;
  try {
    await execFileAsync('yaz-client', ['-V']);
    hasYazClient = true;
    logger.info('yaz-client is available for catalogue lookups');
  } catch {
    hasYazClient = false;
    logger.warn('yaz-client not found — catalogue lookups will be unavailable');
  }
  return hasYazClient;
}

// --- Single citation lookup ---

function buildPqfQuery(author, title) {
  // Escape double quotes in values
  const cleanTitle = title ? title.replace(/"/g, '') : null;
  const cleanAuthor = author ? author.replace(/"/g, '') : null;

  if (cleanTitle && cleanAuthor) {
    return `@and @attr 1=4 "${cleanTitle}" @attr 1=1003 "${cleanAuthor}"`;
  }
  if (cleanTitle) {
    return `@attr 1=4 "${cleanTitle}"`;
  }
  return null;
}

function parseHitsFromOutput(stdout) {
  const match = String(stdout).match(/Number of hits:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseBibIdFromOutput(stdout) {
  const match = String(stdout).match(/^001\s+(\d+)/m);
  return match ? match[1] : null;
}

function runYazClient(commands, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('yaz-client', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    const maxBuffer = 512 * 1024;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('yaz-client timed out'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBuffer) chunks.push(chunk);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf-8');
      // yaz-client exits non-zero even on success, so ignore exit code
      // and just check if we got parseable output
      resolve(stdout);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(commands);
    child.stdin.end();
  });
}

export async function lookupCitation(citationText) {
  const { author, title } = extractSearchTerms(citationText);

  if (!title) {
    return { found: null, hits: null, author, title, skipped: true };
  }

  if (!(await checkYazAvailability())) {
    return { found: null, hits: null, author, title, skipped: true, error: 'yaz-client not available' };
  }

  const query = buildPqfQuery(author, title);
  if (!query) {
    return { found: null, hits: null, author, title, skipped: true };
  }

  const commands = [
    `open ${Z3950_HOST}:${Z3950_PORT}/${Z3950_DB}`,
    `f ${query}`,
    'show 1',
    'quit'
  ].join('\n') + '\n';

  try {
    const stdout = await runYazClient(commands, 15_000);

    const hits = parseHitsFromOutput(stdout);
    if (hits === null) {
      return { found: null, hits: null, author, title, error: 'Could not parse yaz-client output' };
    }

    const bibId = hits > 0 ? parseBibIdFromOutput(stdout) : null;
    return { found: hits > 0, hits, author, title, bibId };
  } catch (err) {
    logger.warn('yaz-client lookup failed', { author, title, error: err.message });
    return { found: null, hits: null, author, title, error: err.message };
  }
}

// --- Batch lookup ---

export async function lookupCitationBatch(citationTexts, { concurrency = 1, onProgress } = {}) {
  if (!(await checkYazAvailability())) {
    return citationTexts.map((text) => {
      const { author, title } = extractSearchTerms(text);
      return { found: null, hits: null, author, title, skipped: true, error: 'yaz-client not available' };
    });
  }

  // Pre-extract search terms for all citations
  const items = citationTexts.map((text, idx) => ({
    idx,
    text,
    ...extractSearchTerms(text),
  }));

  const results = new Array(items.length);

  // Split into items with valid queries and those to skip
  const queryable = [];
  for (const item of items) {
    const query = buildPqfQuery(item.author, item.title);
    if (query) {
      queryable.push({ ...item, query });
    } else {
      results[item.idx] = { found: null, hits: null, author: item.author, title: item.title, skipped: true };
    }
  }

  // Process queryable items in batches via single yaz-client sessions
  for (let batchStart = 0; batchStart < queryable.length; batchStart += BATCH_SIZE) {
    const batch = queryable.slice(batchStart, batchStart + BATCH_SIZE);

    const commandLines = [`open ${Z3950_HOST}:${Z3950_PORT}/${Z3950_DB}`];
    for (const item of batch) {
      commandLines.push(`f ${item.query}`);
      commandLines.push('show 1');
    }
    commandLines.push('quit');

    const commands = commandLines.join('\n') + '\n';

    try {
      const stdout = await runYazClient(commands, 30_000 + batch.length * 2_000);

      // Parse all "Number of hits:" lines in order
      const hitsMatches = [...String(stdout).matchAll(/Number of hits:\s*(\d+)/g)];
      // Parse all bib IDs (001 fields) — only present for queries with hits
      const bibIdMatches = [...String(stdout).matchAll(/^001\s+(\d+)/gm)];

      let bibIdx = 0;
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        if (i < hitsMatches.length) {
          const hits = Number(hitsMatches[i][1]);
          let bibId = null;
          if (hits > 0 && bibIdx < bibIdMatches.length) {
            bibId = bibIdMatches[bibIdx][1];
            bibIdx++;
          }
          results[item.idx] = { found: hits > 0, hits, author: item.author, title: item.title, bibId };
        } else {
          results[item.idx] = { found: null, hits: null, author: item.author, title: item.title, error: 'Missing hits in batch output' };
        }

        if (onProgress) {
          const completed = items.filter((_, j) => results[j] !== undefined).length;
          onProgress(completed, items.length);
        }
      }
    } catch (err) {
      logger.warn('yaz-client batch lookup failed', { batchSize: batch.length, error: err.message });
      for (const item of batch) {
        if (results[item.idx] === undefined) {
          results[item.idx] = { found: null, hits: null, author: item.author, title: item.title, error: err.message };
        }
      }
    }
  }

  // Report final progress for skipped items
  if (onProgress) {
    onProgress(items.length, items.length);
  }

  return results;
}

// --- Automatic pending-lookup runner ---

/**
 * Look up all citations that have no catalogue_lookups entry yet.
 * Processes in pages of `pageSize` to bound memory and provide progress logging.
 * Returns summary stats { processed, found, notFound, skipped }.
 */
export async function runPendingCatalogueLookups({ pageSize = 200 } = {}) {
  if (!(await checkYazAvailability())) {
    logger.warn('Skipping automatic catalogue lookups — yaz-client not available');
    return { processed: 0, found: 0, notFound: 0, skipped: 0 };
  }

  let totalProcessed = 0;
  let totalFound = 0;
  let totalNotFound = 0;
  let totalSkipped = 0;

  // Process in pages until no pending citations remain
  while (true) {
    const pending = listPendingLookups(pageSize);
    if (!pending.length) break;

    const texts = pending.map((row) => row.citation_text);
    const results = await lookupCitationBatch(texts);

    for (let i = 0; i < pending.length; i++) {
      const result = results[i];
      saveCatalogueLookup(pending[i].id, {
        hits: result.hits,
        queryAuthor: result.author,
        queryTitle: result.title,
        bibId: result.bibId,
      });
      if (result.found === true) totalFound++;
      else if (result.found === false) totalNotFound++;
      else totalSkipped++;
    }

    totalProcessed += pending.length;
    logger.info('Catalogue lookup progress', { processed: totalProcessed, found: totalFound, notFound: totalNotFound, skipped: totalSkipped });

    // If we got fewer than a full page, we're done
    if (pending.length < pageSize) break;
  }

  if (totalProcessed > 0) {
    logger.info('Catalogue lookups complete', { processed: totalProcessed, found: totalFound, notFound: totalNotFound, skipped: totalSkipped });
  }

  return { processed: totalProcessed, found: totalFound, notFound: totalNotFound, skipped: totalSkipped };
}

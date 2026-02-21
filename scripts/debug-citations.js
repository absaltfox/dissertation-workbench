import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseBibliography } from '../src/pdf.js';
import { PDF_CACHE_DIR } from '../src/config.js';

const execFileAsync = promisify(execFile);

const files = (await fs.readdir(PDF_CACHE_DIR)).filter(f => f.endsWith('.pdf')).slice(0, 10);

for (const file of files) {
  const pdfPath = path.join(PDF_CACHE_DIR, file);
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-enc', 'UTF-8', pdfPath, '-']);
    const text = String(stdout || '');

    // Check what headings exist
    const headingRegex = /^(references|bibliography|works\s+cited)$/im;
    const looseRegex = /^(references|bibliography|works\s+cited)\s*$/im;
    const hasStrictMatch = headingRegex.test(text);
    const hasLooseMatch = looseRegex.test(text);
    const hasFormFeed = text.includes('\f');

    // Test with form-feed normalization
    const normalized = text.replace(/\f/g, '\n');
    const hasStrictAfterNorm = headingRegex.test(normalized);

    const citations = parseBibliography(text);

    // Find what heading patterns actually appear
    const lines = text.split('\n');
    const matchingLines = lines
      .map((l, i) => ({ line: l.trim(), idx: i }))
      .filter(({ line }) => /^(references|bibliography|works\s+cited)/i.test(line))
      .map(({ line, idx }) => `  L${idx}: "${line.slice(0, 80)}"`);

    console.log(`${file}: citations=${citations.length}, strict=${hasStrictMatch}, loose=${hasLooseMatch}, strictAfterNorm=${hasStrictAfterNorm}, formFeeds=${hasFormFeed}`);
    if (matchingLines.length) {
      console.log(matchingLines.join('\n'));
    }
    if (citations.length > 0) {
      console.log(`  First: "${citations[0].slice(0, 80)}..."`);
      console.log(`  Last:  "${citations[citations.length - 1].slice(0, 80)}..."`);
    }
    console.log();
  } catch (e) {
    console.log(`${file}: ERROR ${e.message}`);
  }
}

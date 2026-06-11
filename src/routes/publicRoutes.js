import { Router } from 'express';
import {
  getCitationForSummon, getTopCitedWorks, loadDocumentCitationsWithSharing,
  loadDocsByCitation
} from '../db.js';
import { parseNumberParam } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';

/**
 * Creates read-only browser endpoints for citation exploration.
 *
 * These routes do not require an admin session. They expose stored citation
 * data and perform one bounded Summon holdings check for a selected citation.
 */
export function createPublicRouter() {
  const router = Router();

  router.get('/documents/:docId/citations', asyncHandler(async (req, res) => {
    const citations = await loadDocumentCitationsWithSharing(req.params.docId);
    res.status(200).json({ citations });
  }));

  router.get('/citations/top', asyncHandler(async (req, res) => {
    const limit = parseNumberParam(getQueryValue(req, 'limit'), 50);
    const works = await getTopCitedWorks(Math.min(limit, 200));
    res.status(200).json({ works });
  }));

  router.get('/citations/:citationId/documents', asyncHandler(async (req, res) => {
    const citationId = Number(req.params.citationId);
    if (!Number.isFinite(citationId) || citationId <= 0) {
      res.status(400).json({ error: 'Invalid citation ID' });
      return;
    }
    const documents = await loadDocsByCitation(citationId);
    res.status(200).json({ documents });
  }));

  router.get('/citations/:citationId/summon-check', asyncHandler(async (req, res) => {
    const citationId = Number(req.params.citationId);
    if (!Number.isFinite(citationId) || citationId <= 0) {
      res.status(400).json({ error: 'Invalid citation ID' });
      return;
    }
    const row = await getCitationForSummon(citationId);
    if (!row) {
      res.status(404).json({ error: 'Citation not found' });
      return;
    }

    // Prefer structured lookup terms from the catalogue parser; fall back to a
    // short raw citation query so malformed citations cannot produce huge URLs.
    const q = row.query_title
      ? `Title:(${row.query_title})${row.query_author ? ` AND Author:(${row.query_author})` : ''}`
      : String(row.citation_text || '').slice(0, 200);
    if (!q) {
      res.status(422).json({ error: 'Insufficient citation data' });
      return;
    }

    try {
      const summonUrl = `https://ubc.summon.serialssolutions.com/api/search?pn=1&l=en&include.ft.matches=t&q=${encodeURIComponent(q)}`;
      const resp = await fetch(summonUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error(`Summon ${resp.status}`);
      const data = await resp.json();
      const results = (data.documents || []).slice(0, 10).map((d) => ({
        title: String(d.title || '').replace(/<\/?mark>/g, ''),
        authors: (d.authors || []).map((a) => a.fullname || a.name || '').filter(Boolean).join(', '),
        contentType: d.content_type || '',
        year: d.publication_date || '',
        inHoldings: d.in_holdings === true,
        link: d.link || '',
        snippet: String(d.snippet || '').replace(/<\/?mark>/g, ''),
      }));
      const found = results.some((r) => r.inHoldings);
      const searchUrl = `https://ubc.summon.serialssolutions.com/#!/search?q=${encodeURIComponent(q)}`;
      res.status(200).json({ found, results, searchUrl, illUrl: 'https://ill-docdel.library.ubc.ca/home' });
    } catch {
      res.status(502).json({ error: 'Summon lookup failed' });
    }
  }));

  return router;
}

// The serving SQL as it stood before the covering-index / affiliation-projection
// work (main d75305f), kept verbatim so the equivalence tests compare the live
// readers against it. Do not "improve" these strings: they are the specification.
// One deliberate change since: search splits the query into words and quoted
// phrases (searchTerms), matched one by one, instead of one substring.
import { searchTerms } from '../../src/db.js';

const ACCESS_SQL = "(COALESCE(d.access_status, 'unknown') NOT IN ('embargoed', 'verification_due'))";

function affiliationValues(raw) {
  const value = String(raw || '').trim().toLowerCase();
  const groups = [
    ['ubc', 'university of british columbia', 'the university of british columbia'],
    ['sfu', 'simon fraser university'],
    ['uvic', 'university of victoria'],
    ['tru', 'thompson rivers university'],
    ['rru', 'royal roads university'],
  ];
  return groups.find((group) => group.includes(value)) || [value];
}

export function referenceFilters({ syncKey = null, degree = '', program = '', affiliation = '', q = '' } = {}, { analytical = false } = {}) {
  const clauses = [];
  const args = [];
  if (syncKey) { clauses.push('d.sync_key = ?'); args.push(syncKey); }
  if (degree) { clauses.push('d.degree = ?'); args.push(degree); }
  if (program) { clauses.push('d.program = ?'); args.push(program); }
  if (affiliation) {
    const values = affiliationValues(affiliation);
    clauses.push(`EXISTS (
      SELECT 1 FROM json_each(d.metadata_json, '$.affiliation') affiliation
      WHERE lower(trim(CAST(affiliation.value AS TEXT))) IN (${values.map(() => '?').join(', ')})
    )`);
    args.push(...values);
  }
  // One clause per search term (word or quoted phrase), as documentServingFilters does.
  for (const term of searchTerms(q)) {
    const pattern = `%${term}%`;
    clauses.push(`(
      lower(COALESCE(d.title, '')) LIKE ? OR
      lower(COALESCE(d.author, '')) LIKE ? OR
      lower(COALESCE(d.degree, '')) LIKE ? OR
      lower(COALESCE(d.program, '')) LIKE ? OR
      CAST(d.year AS TEXT) LIKE ? OR
      EXISTS (
        SELECT 1 FROM json_each(d.metadata_json, '$.supervisors') supervisor
        WHERE lower(CAST(supervisor.value AS TEXT)) LIKE ?
      )
    )`);
    args.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (analytical) clauses.push(ACCESS_SQL);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

export const REFERENCE_PAGE_SORTS = {
  title: "lower(COALESCE(d.title, ''))",
  author: "lower(COALESCE(d.author, ''))",
  year: 'COALESCE(d.year, 0)',
  degree: "lower(COALESCE(d.degree, ''))",
  pages: 'COALESCE(fm.page_count, 0)',
  wordCount: 'COALESCE(fm.word_count, 0)',
  citationCount: 'COALESCE(dc.citation_count, 0)',
};

// queryCachedDocumentPage before the ids-first rewrite.
export async function referenceDocumentPage(client, {
  syncKey = null, filters = {}, q = '', sortKey = '', sortDir = 'asc', limit = 50, offset = 0,
} = {}) {
  const f = referenceFilters({ syncKey, ...filters, q });
  const count = await client.execute({ sql: `SELECT COUNT(*) AS total FROM documents d ${f.where}`, args: f.args });
  const sortExpression = REFERENCE_PAGE_SORTS[sortKey] || 'COALESCE(d.year, 0)';
  const direction = sortKey ? (sortDir === 'asc' ? 'ASC' : 'DESC') : 'DESC';
  const join = sortKey === 'citationCount'
    ? 'LEFT JOIN (SELECT doc_id, COUNT(*) AS citation_count FROM document_citations GROUP BY doc_id) dc ON dc.doc_id = d.doc_id'
    : '';
  const rows = await client.execute({
    sql: `
    SELECT d.doc_id, d.metadata_json,
           fm.download_url, fm.file_bytes, fm.word_count, fm.body_word_count,
           fm.page_count, fm.word_source, fm.page_source, fm.status, fm.error,
           fm.word_count_comparison_json
    FROM documents d
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
    ${join}
    ${f.where}
    ORDER BY ${sortExpression} ${direction}, lower(COALESCE(d.title, '')) ASC, d.doc_id ASC
    LIMIT ? OFFSET ?`,
    args: [...f.args, limit, offset],
  });
  return { total: Number(count.rows[0].total), rows: rows.rows };
}

// Classifies the EXPLAIN QUERY PLAN lines of one serving statement: which documents
// accesses go back to the table instead of staying in a covering index. Used by
// scripts/rehearse-documents-index.mjs; pinned by test/documentsPlanCheck.test.js.

// Must equal DOCUMENTS_COVERING_SCAN_SQL in src/db.js (the test checks it).
export const DOCUMENTS_COVERING_SCAN_SQL = "(d.doc_id >= '' OR d.doc_id IS NULL)";

const isDocumentsAccess = (detail) => /^(SCAN|SEARCH) (d|documents)\b/.test(detail);
const isPkRowProbe = (detail) => /^SEARCH d USING INDEX \S+ \(doc_id=\?\)$/.test(detail);

/** Returns the plan lines that read the documents table (empty array = index-only). */
export function documentsPlanViolations(sql, details) {
  // The analytics "overall" statement reads charCount out of metadata_json.
  if (/json_extract\(d\.metadata_json, '\$\.charCount'\)/.test(sql)) return [];
  let accesses = details.filter(isDocumentsAccess);
  // Phase two of the Documents page fetches metadata_json for the page's rows by doc_id.
  if (/FROM page p\b/.test(sql)) accesses = accesses.filter((detail) => !isPkRowProbe(detail));
  // The unfiltered guard is planned as a MULTI-INDEX OR: its range arm SEARCHes the
  // covering doc_id index, and its IS NULL arm may probe the primary-key index for
  // doc_id = NULL (Turso does). That probe matches no row, so it never reaches the table;
  // allow exactly one such line, and only next to the covering range arm.
  if (sql.includes(DOCUMENTS_COVERING_SCAN_SQL)
    && accesses.some((detail) => /^SEARCH d USING COVERING INDEX \S+ \(doc_id>\?\)$/.test(detail))) {
    const nullArm = accesses.findIndex((detail) => /^SEARCH d USING INDEX sqlite_autoindex_documents_1 \(doc_id=\?\)$/.test(detail));
    if (nullArm !== -1) accesses = accesses.filter((_, i) => i !== nullArm);
  }
  return accesses.filter((detail) => !/COVERING INDEX/.test(detail));
}

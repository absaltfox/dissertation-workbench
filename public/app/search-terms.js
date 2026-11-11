// Search terms, shared by the server SQL (src/db.js) and the Documents table's
// in-browser filter so both match the same way. Terms match one by one in any
// order: authors are stored surname-first ("LeBlanc, Michael"), so "Michael
// LeBlanc" must still find them. Commas and semicolons separate words like
// spaces. Text in double quotes (straight or curly) is one phrase that keeps its
// word order; an unmatched quote is ignored. The cap bounds the per-term work.
export const MAX_SEARCH_TERMS = 8;

export function searchTerms(q) {
  const text = String(q || '').toLowerCase().replace(/[“”„‟]/g, '"');
  const terms = [];
  for (const match of text.matchAll(/"([^"]*)"|[^\s,;"]+/g)) {
    const term = (match[1] ?? match[0]).replace(/\s+/g, ' ').trim();
    if (term) terms.push(term);
  }
  return [...new Set(terms)].slice(0, MAX_SEARCH_TERMS);
}

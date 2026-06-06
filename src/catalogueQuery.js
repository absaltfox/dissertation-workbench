// yaz-client accepts a small command language over stdin. Citation text comes
// from parsed PDFs, so strip controls and quoting characters before embedding
// values into PQF commands.
export function sanitizePqfValue(value) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 240) : null;
}

export function buildPqfQuery(author, title) {
  const cleanTitle = sanitizePqfValue(title);
  const cleanAuthor = sanitizePqfValue(author);

  if (cleanTitle && cleanAuthor) {
    return `@and @attr 1=4 "${cleanTitle}" @attr 1=1003 "${cleanAuthor}"`;
  }
  if (cleanTitle) {
    return `@attr 1=4 "${cleanTitle}"`;
  }
  return null;
}

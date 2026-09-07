export function assessTextQuality(text) {
  const str = String(text || '');
  const byteLength = Buffer.byteLength(str, 'utf8');
  if (byteLength < 1200) return { degraded: true, byteLength, reason: 'short' };

  const tokens = str.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { degraded: true, byteLength, reason: 'short' };
  const singles = tokens.filter((t) => t.replace(/[^\p{L}\p{N}]/gu, '').length === 1).length;
  const ratio = singles / tokens.length;
  if (ratio > 0.25) return { degraded: true, byteLength, reason: 'fragmented' };

  return { degraded: false, byteLength, reason: null };
}

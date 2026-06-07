/**
 * Calculates the Jaro-Winkler similarity between two strings.
 * Returns a value between 0.0 (completely different) and 1.0 (identical).
 */
export function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const len1 = s1.length;
  const len2 = s2.length;

  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches within the matching window
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(len2 - 1, i + matchWindow);

    for (let j = start; j <= end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) {
      transpositions++;
    }
    k++;
  }

  const jaro = (
    (matches / len1) +
    (matches / len2) +
    ((matches - (transpositions / 2)) / matches)
  ) / 3.0;

  // Winkler prefix scale
  const scalingFactor = 0.1;
  let prefixLength = 0;
  const maxPrefix = Math.min(4, Math.min(len1, len2));

  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  return jaro + prefixLength * scalingFactor * (1.0 - jaro);
}

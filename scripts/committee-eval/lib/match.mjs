import { normalizePersonName, supervisorNameKey, namesCompatible } from '../../../src/supervisors.js';

export function namesMatch(a, b) {
  const ka = supervisorNameKey(a);
  const kb = supervisorNameKey(b);
  if (!ka || !kb) return false;
  return namesCompatible(ka, kb);
}

// Greedy one-to-one matching of predicted names against gold member names.
function matchSets(predictedNames, goldNames) {
  const goldRemaining = goldNames.map((n) => ({ name: n, used: false }));
  const pairs = []; // { pIndex, gIndex }
  predictedNames.forEach((p, pIndex) => {
    const gIndex = goldRemaining.findIndex((g) => !g.used && namesMatch(p, g.name));
    if (gIndex !== -1) {
      goldRemaining[gIndex].used = true;
      pairs.push({ pIndex, gIndex });
    }
  });
  return pairs;
}

export function scoreDoc(predicted, gold) {
  const goldMembers = gold.members || [];
  const negatives = gold.negatives || [];
  const predNames = predicted.map((m) => m.name);
  const goldNames = goldMembers.map((m) => m.name);

  const pairs = matchSets(predNames, goldNames);
  const nameTP = pairs.length;
  const nameFP = predNames.length - nameTP;
  const nameFN = goldNames.length - nameTP;

  let roleTP = 0;
  for (const { pIndex, gIndex } of pairs) {
    if (predicted[pIndex].role === goldMembers[gIndex].role) roleTP += 1;
  }
  const roleFP = predicted.length - roleTP;
  const roleFN = goldMembers.length - roleTP;

  const exactCase = nameFP === 0 && nameFN === 0;

  let negativeViolations = 0;
  for (const p of predNames) {
    if (negatives.some((neg) => namesMatch(p, neg))) negativeViolations += 1;
  }

  return { nameTP, nameFP, nameFN, roleTP, roleFP, roleFN, exactCase, negativeViolations };
}

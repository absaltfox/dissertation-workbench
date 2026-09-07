const SUPERVISOR_ROLES = new Set(['Supervisor', 'Co-Supervisor']);

export function extractBaseline(fullText, { parseCommittee, parseAcknowledgementsDetailed }) {
  const committee = parseCommittee(fullText) || [];
  const hasSupervisor = committee.some((m) => SUPERVISOR_ROLES.has(m.role));
  const members = [...committee];
  if (!hasSupervisor) {
    const ack = parseAcknowledgementsDetailed(fullText)?.members || [];
    const ackSupervisors = ack.filter((m) => SUPERVISOR_ROLES.has(m.role));
    // Mirror production (src/pdf.js:2126): ack non-supervisor members are merged
    // only when the certificate page yielded no committee at all. When the cert
    // page listed examiners (committee.length > 0) but no supervisor, production
    // keeps those examiners + only the ack SUPERVISORS, dropping ack non-supervisors.
    const ackOthers = committee.length ? [] : ack.filter((m) => !SUPERVISOR_ROLES.has(m.role));
    members.push(...ackSupervisors, ...ackOthers);
  }
  // Dedupe by lowercased name, keeping first occurrence.
  const seen = new Set();
  return members.filter((m) => {
    const key = String(m.name || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ratio(tp, other) {
  const denom = tp + other;
  return denom === 0 ? 1 : tp / denom;
}
function f1(p, r) { return p + r === 0 ? 0 : (2 * p * r) / (p + r); }

export function aggregate(perDoc) {
  const groups = {};
  for (const { stratumKey, score } of perDoc) {
    if (!groups[stratumKey]) groups[stratumKey] = { nameTP: 0, nameFP: 0, nameFN: 0, roleTP: 0, roleFP: 0, roleFN: 0, exact: 0, neg: 0, docs: 0 };
    const g = groups[stratumKey];
    g.nameTP += score.nameTP; g.nameFP += score.nameFP; g.nameFN += score.nameFN;
    g.roleTP += score.roleTP; g.roleFP += score.roleFP; g.roleFN += score.roleFN;
    g.exact += score.exactCase ? 1 : 0; g.neg += score.negativeViolations; g.docs += 1;
  }
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    const nameP = ratio(g.nameTP, g.nameFP), nameR = ratio(g.nameTP, g.nameFN);
    const roleP = ratio(g.roleTP, g.roleFP), roleR = ratio(g.roleTP, g.roleFN);
    out[k] = {
      namePrecision: nameP, nameRecall: nameR, nameF1: f1(nameP, nameR),
      rolePrecision: roleP, roleRecall: roleR, roleF1: f1(roleP, roleR),
      exactCaseRate: g.docs ? g.exact / g.docs : 0,
      negativeViolations: g.neg, docs: g.docs,
    };
  }
  return out;
}

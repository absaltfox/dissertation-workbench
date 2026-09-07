import { namesMatch } from './match.mjs';

export function buildWorksheetRows(docId, { committee = [], acknowledgement = [], certificatePresent = false }) {
  const rows = [];
  for (const m of committee) {
    rows.push({ docId, name: m.name, proposed_role: m.role, on_certificate: true, source: 'certificate', keep: '', true_role: '', is_negative: '' });
  }
  for (const a of acknowledgement) {
    const onCert = committee.some((c) => namesMatch(c.name, a.name));
    if (onCert) continue; // already represented by its certificate row
    rows.push({ docId, name: a.name, proposed_role: a.role, on_certificate: false, source: 'acknowledgement', keep: '', true_role: '', is_negative: certificatePresent ? 'Y' : '' });
  }
  return rows;
}

export function finalizeGold(rows) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, { docId: r.docId, members: [], negatives: [] });
    const g = byDoc.get(r.docId);
    if (String(r.keep).toUpperCase() === 'Y') g.members.push({ name: r.name, role: (r.true_role && r.true_role.trim()) || r.proposed_role });
    if (String(r.is_negative).toUpperCase() === 'Y') g.negatives.push(r.name);
  }
  return [...byDoc.values()];
}

export function buildReport(byStratum) {
  const cells = Object.entries(byStratum).map(([stratumKey, m]) => ({ stratumKey, ...m }));
  const failureCells = cells.filter((c) => c.stratumKey.startsWith('nocert:'))
    .sort((a, b) => a.nameRecall - b.nameRecall);
  const validationCells = cells.filter((c) => c.stratumKey.startsWith('cert:'));
  const unrecognized = cells.filter(
    (c) => !c.stratumKey.startsWith('nocert:') && !c.stratumKey.startsWith('cert:')
  );
  return {
    failureCells,
    validationCells,
    unrecognized,
    warning: 'Certificate-absent (nocert) and certificate-present (cert) cells must NOT be averaged. '
      + 'cert cells are a harness-validation figure (parseCommittee scored against parseCommittee-derived gold); '
      + 'the metric that matters is nocert recall.',
  };
}

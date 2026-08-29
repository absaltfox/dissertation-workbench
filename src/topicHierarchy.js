// Pure topic-hierarchy helpers: no I/O, no dependency on db.js or metrics.js,
// so both modules can import from here without a circular dependency.
// (#15: db.js's SQL port of topicData.byYear needs buildParentClusters to
// resolve leaf topic ids to parent-cluster ids before grouping — the same
// algorithm the JS aggregation path in metrics.js already uses.)

export function buildParentClusters(hierarchy, topics, targetK = 10) {
  const { leafTopicIds, linkage } = hierarchy;
  const N = leafTopicIds.length;
  if (N <= targetK) {
    // Fewer leaves than target — each leaf is its own parent
    const parentClusters = topics.filter((t) => t.topicId !== -1).map((t, i) => ({
      parentId: i, topicId: i, label: t.label, docCount: t.docCount, children: [t.topicId],
    }));
    const leafToParent = new Map(parentClusters.map((p) => [p.children[0], p.parentId]));
    return { parentClusters, leafToParent };
  }

  // Union-find over N leaves + up to N-1 merge nodes
  const parent = new Array(N + linkage.length).fill(-1);
  const find = (x) => { while (parent[x] !== -1) x = parent[x]; return x; };
  const union = (a, b, into) => { parent[find(a)] = into; parent[find(b)] = into; };

  // Apply first N - targetK merges (linkage is sorted by distance)
  const mergesToApply = N - targetK;
  for (let m = 0; m < mergesToApply; m++) {
    const [i, j] = linkage[m];
    union(i, j, N + m);
  }

  // Collect connected components — each root is a parent cluster
  const rootToChildren = new Map();
  const leafIdxToTopicId = new Map();
  const topicDocCount = new Map(topics.map((t) => [t.topicId, t.docCount || 0]));
  for (let i = 0; i < N; i++) {
    leafIdxToTopicId.set(i, leafTopicIds[i]);
    const root = find(i);
    if (!rootToChildren.has(root)) rootToChildren.set(root, []);
    rootToChildren.get(root).push(leafTopicIds[i]);
  }

  const topicLabelMap = new Map(topics.map((t) => [t.topicId, t.label]));
  const parentClusters = [];
  const leafToParent = new Map();
  let parentIdx = 0;

  for (const [, children] of rootToChildren) {
    // Label = label of the child topic with the most docs
    const bestChild = children.reduce((best, tid) =>
      (topicDocCount.get(tid) || 0) > (topicDocCount.get(best) || 0) ? tid : best
    , children[0]);
    const totalDocs = children.reduce((sum, tid) => sum + (topicDocCount.get(tid) || 0), 0);
    parentClusters.push({
      parentId: parentIdx, topicId: parentIdx,
      label: topicLabelMap.get(bestChild) || `Cluster ${parentIdx}`,
      docCount: totalDocs, children,
    });
    for (const tid of children) leafToParent.set(tid, parentIdx);
    parentIdx++;
  }

  parentClusters.sort((a, b) => b.docCount - a.docCount);
  // Re-index after sort
  const oldToNew = new Map(parentClusters.map((p, i) => [p.parentId, i]));
  for (const p of parentClusters) p.parentId = p.topicId = oldToNew.get(p.parentId);
  for (const [tid, oldPid] of leafToParent) leafToParent.set(tid, oldToNew.get(oldPid));

  return { parentClusters, leafToParent };
}

// Count-row-based aggregation: takes pre-aggregated {topicId, year, count}
// rows (as a bounded SQL GROUP BY would produce) instead of a per-document
// array, and buckets them by resolved parent-cluster id. buildTopicsByYear
// below (the original per-document-array JS path) is a thin wrapper over
// this — one row per document, count 1 — so both the SQL-ported path
// (db.js, at any corpus size) and the JS path (metrics.js, ≤5000-document
// samples) share one aggregation implementation and cannot silently drift
// apart.
export function buildTopicsByYearFromCounts(topics, rows, leafToParent) {
  const yearCounts = new Map(); // resolvedTopicId -> Map<year, count>

  for (const row of rows) {
    if (row.topicId == null || !row.year) continue;
    const resolvedId = leafToParent ? (leafToParent.get(row.topicId) ?? row.topicId) : row.topicId;
    if (!yearCounts.has(resolvedId)) yearCounts.set(resolvedId, new Map());
    const ym = yearCounts.get(resolvedId);
    ym.set(row.year, (ym.get(row.year) || 0) + (row.count || 0));
  }

  return topics
    .filter((t) => t.topicId !== -1)
    .slice(0, 10)
    .map((topic) => {
      const ym = yearCounts.get(topic.topicId) || new Map();
      const data = Array.from(ym.entries())
        .map(([year, count]) => ({ year: Number(year), count }))
        .sort((a, b) => a.year - b.year);
      return { topicId: topic.topicId, label: topic.label, data };
    });
}

export function buildTopicsByYear(topics, documents, leafToParent) {
  const rows = [];
  for (const doc of documents) {
    if (doc.topicId == null || !doc.year) continue;
    rows.push({ topicId: doc.topicId, year: doc.year, count: 1 });
  }
  return buildTopicsByYearFromCounts(topics, rows, leafToParent);
}

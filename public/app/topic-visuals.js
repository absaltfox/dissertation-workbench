
// --- Concept Timeline ---

function renderConceptTimeline() {
  const data = getAnalytics()?.conceptTimeline || [];
  if (!data.length || !conceptTimelineChartEl) {
    if (conceptTimelineChartEl) conceptTimelineChartEl.innerHTML = '<text x="16" y="40" class="axis">No concept timeline data available.</text>';
    if (conceptTimelineLegendEl) conceptTimelineLegendEl.innerHTML = '';
    return;
  }

  const width = 940;
  const height = 360;
  const pad = { t: 20, r: 20, b: 40, l: 58 };

  // Collect all years and find ranges
  const allYears = new Set();
  let maxCount = 1;
  for (const series of data) {
    for (const pt of series.data) {
      allYears.add(pt.year);
      if (pt.count > maxCount) maxCount = pt.count;
    }
  }
  const years = Array.from(allYears).sort((a, b) => a - b);
  if (!years.length) {
    conceptTimelineChartEl.innerHTML = '<text x="16" y="40" class="axis">No year data.</text>';
    conceptTimelineLegendEl.innerHTML = '';
    return;
  }

  const minX = years[0];
  const maxX = years[years.length - 1];
  const x = (v) => pad.l + ((v - minX) / Math.max(maxX - minX, 1)) * (width - pad.l - pad.r);
  const y = (v) => height - pad.b - (v / maxCount) * (height - pad.t - pad.b);

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const val = (maxCount / 5) * i;
    return { val, y: y(val) };
  });

  const hueStep = 360 / data.length;
  const lines = data.map((series, idx) => {
    const hue = Math.round(idx * hueStep);
    const color = `hsl(${hue} 65% 45%)`;
    const points = series.data.map((pt) => `${x(pt.year)},${y(pt.count)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" />`;
  }).join('');

  const xLabels = years
    .filter((_, i) => i % Math.ceil(years.length / 12) === 0)
    .map((yr) => `<text class="axis" x="${x(yr)}" y="${height - 10}" text-anchor="middle">${yr}</text>`)
    .join('');

  conceptTimelineChartEl.innerHTML = `
    ${yTicks.map((tick) => `
      <line x1="${pad.l}" y1="${tick.y}" x2="${width - pad.r}" y2="${tick.y}" stroke="rgba(8,90,99,0.12)"/>
      <text class="axis" x="${pad.l - 8}" y="${tick.y + 4}" text-anchor="end">${formatNum(tick.val)}</text>
    `).join('')}
    ${lines}
    ${xLabels}
  `;

  conceptTimelineLegendEl.innerHTML = data.map((series, idx) => {
    const hue = Math.round(idx * hueStep);
    const color = `hsl(${hue} 65% 45%)`;
    return `<span class="timeline-legend-item"><span class="timeline-legend-swatch" style="background:${color}"></span>${escapeHtml(series.concept)} (${series.totalDocs})</span>`;
  }).join('');
}

// --- Topic Distribution ---

function topicDisplayLabel(label) {
  // BERTopic labels are "0_word1_word2_word3" — strip the ID prefix and join
  const cleaned = label.replace(/^-?\d+_/, '').replace(/_/g, ' ');
  return cleaned || label;
}

function wrapLabel(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

function renderTopicDistribution() {
  const td = getAnalytics()?.topicData;
  if (!td || !td.topics || !td.topics.length) {
    if (topicDistPanelEl) topicDistPanelEl.hidden = true;
    return;
  }
  topicDistPanelEl.hidden = false;
  if (topicModelMetaEl) {
    const modelName = td.topics.find((topic) => topic.modelName)?.modelName;
    const createdAt = td.topics.find((topic) => topic.createdAt)?.createdAt;
    const detail = [modelName, createdAt ? `run ${new Date(createdAt).toLocaleDateString()}` : '']
      .filter(Boolean)
      .join('; ');
    topicModelMetaEl.textContent = `Topics discovered by BERTopic clustering of dissertation abstracts${detail ? ` (${detail})` : ''}.`;
  }

  // Show all topics except outliers at end
  const regular = td.topics.filter((t) => t.topicId !== -1);
  const outlier = td.topics.find((t) => t.topicId === -1);
  const ordered = [...regular];
  if (outlier) ordered.push(outlier);

  const maxCount = Math.max(...ordered.map((t) => t.docCount), 1);

  topicBarsEl.innerHTML = ordered
    .map((topic) => {
      const widthPct = (topic.docCount / maxCount) * 100;
      const displayLabel = topic.topicId === -1 ? 'Uncategorized' : topicDisplayLabel(topic.label);
      const topTerms = topic.topicId === -1 ? '' : (topic.topTerms || []).slice(0, 3).map((pair) => Array.isArray(pair) ? pair[0] : pair).join(', ');
      return `
        <div class="bar-row">
          <span class="bar-label" title="${escapeHtml(topic.label)}">
            ${escapeHtml(displayLabel)}
            ${topTerms ? `<span class="topic-terms">${escapeHtml(topTerms)}</span>` : ''}
          </span>
          <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
          <button class="bar-value" data-topic-id="${topic.topicId}">${formatNum(topic.docCount)}</button>
        </div>
      `;
    })
    .join('');

  for (const node of topicBarsEl.querySelectorAll('[data-topic-id]')) {
    node.addEventListener('click', () => {
      const topicId = Number(node.getAttribute('data-topic-id'));
      const topic = td.topics.find((t) => t.topicId === topicId);
      const label = topicId === -1 ? 'Uncategorized' : topicDisplayLabel(topic?.label || '');
      openMatchesModal(`Topic: ${label}`, docsForTopic(topicId));
    });
  }
}

function renderTopicTimeline() {
  const td = getAnalytics()?.topicData;
  if (!td || !td.byYear || !td.byYear.length) {
    if (topicTimelinePanelEl) topicTimelinePanelEl.hidden = true;
    return;
  }
  topicTimelinePanelEl.hidden = false;

  const data = td.byYear;
  const width = 940;
  const height = 360;
  const pad = { t: 20, r: 20, b: 40, l: 58 };

  const allYears = new Set();
  let maxCount = 1;
  for (const series of data) {
    for (const pt of series.data) {
      allYears.add(pt.year);
      if (pt.count > maxCount) maxCount = pt.count;
    }
  }
  const years = Array.from(allYears).sort((a, b) => a - b);
  if (!years.length) {
    topicTimelineChartEl.innerHTML = '<text x="16" y="40" class="axis">No year data.</text>';
    topicTimelineLegendEl.innerHTML = '';
    return;
  }

  const minX = years[0];
  const maxX = years[years.length - 1];
  const x = (v) => pad.l + ((v - minX) / Math.max(maxX - minX, 1)) * (width - pad.l - pad.r);
  const y = (v) => height - pad.b - (v / maxCount) * (height - pad.t - pad.b);

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const val = (maxCount / 5) * i;
    return { val, y: y(val) };
  });

  const hueStep = 360 / data.length;
  const lines = data.map((series, idx) => {
    const hue = Math.round(idx * hueStep);
    const color = `hsl(${hue} 65% 45%)`;
    const points = series.data.map((pt) => `${x(pt.year)},${y(pt.count)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" />`;
  }).join('');

  const xLabels = years
    .filter((_, i) => i % Math.ceil(years.length / 12) === 0)
    .map((yr) => `<text class="axis" x="${x(yr)}" y="${height - 10}" text-anchor="middle">${yr}</text>`)
    .join('');

  topicTimelineChartEl.innerHTML = `
    ${yTicks.map((tick) => `
      <line x1="${pad.l}" y1="${tick.y}" x2="${width - pad.r}" y2="${tick.y}" stroke="rgba(8,90,99,0.12)"/>
      <text class="axis" x="${pad.l - 8}" y="${tick.y + 4}" text-anchor="end">${formatNum(tick.val)}</text>
    `).join('')}
    ${lines}
    ${xLabels}
  `;

  topicTimelineLegendEl.innerHTML = data.map((series, idx) => {
    const hue = Math.round(idx * hueStep);
    const color = `hsl(${hue} 65% 45%)`;
    const label = topicDisplayLabel(series.label);
    return `<span class="timeline-legend-item"><span class="timeline-legend-swatch" style="background:${color}"></span>${escapeHtml(label)}</span>`;
  }).join('');
}

// --- Analytics sub-tabs ---

function setActiveAnalyticsTab(tabName) {
  for (const btn of analyticsTabButtons) {
    btn.classList.toggle('active', btn.dataset.analyticsTab === tabName);
  }
  for (const section of document.querySelectorAll('.analytics-tab-section')) {
    section.classList.toggle('active', section.id === `analytics-${tabName}`);
  }
  if (tabName === 'visualizations' && state.payload) {
    renderTopicCluster();
    renderTopicDendrogram();
    renderTopicSankey();
    renderMethTopicBubble();
  }
}

// --- Topic Cluster Scatter Plot ---

let _topicClusterRendered = false;
let _topicClusterDocs = [];
let _topicClusterTd = null;

function renderTopicCluster() {
  const docs = getFilteredDocs();
  const td = getAnalytics()?.topicData;
  if (!td?.topics?.length || !topicClusterChartEl) {
    if (topicClusterPanelEl) topicClusterPanelEl.hidden = true;
    return;
  }

  const plotDocs = docs.filter(d => d.umapX != null && d.umapY != null && d.topicId != null);
  if (!plotDocs.length) {
    topicClusterPanelEl.hidden = true;
    return;
  }
  topicClusterPanelEl.hidden = false;

  const width = 940, height = 600;
  const pad = { t: 20, r: 20, b: 20, l: 20 };

  const xs = plotDocs.map(d => d.umapX);
  const ys = plotDocs.map(d => d.umapY);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const sx = v => pad.l + ((v - minX) / rangeX) * (width - pad.l - pad.r);
  const sy = v => pad.t + ((v - minY) / rangeY) * (height - pad.t - pad.b);

  // Assign colors by topic
  const topicIds = [...new Set(plotDocs.map(d => d.topicId))].sort((a, b) => a - b);
  const hueStep = 360 / Math.max(topicIds.length, 1);
  const colorMap = new Map();
  topicIds.forEach((tid, i) => {
    colorMap.set(tid, tid === -1
      ? 'hsl(0 0% 72%)'
      : `hsl(${Math.round(i * hueStep)} 65% 50%)`);
  });

  // Render circles
  const circles = plotDocs.map((doc, i) => {
    const cx = sx(doc.umapX), cy = sy(doc.umapY);
    const color = colorMap.get(doc.topicId) || '#999';
    return `<circle class="cluster-dot" cx="${cx}" cy="${cy}" r="4"
      fill="${color}" fill-opacity="0.7" stroke="${color}" stroke-opacity="0.3"
      stroke-width="1" data-idx="${i}" data-topic="${doc.topicId}" style="cursor:pointer" />`;
  }).join('');

  topicClusterChartEl.innerHTML = circles;
  _topicClusterDocs = plotDocs;
  _topicClusterTd = td;

  // Attach listeners only once
  if (!_topicClusterRendered) {
    _topicClusterRendered = true;

    topicClusterChartEl.addEventListener('mouseover', e => {
      const dot = e.target.closest('.cluster-dot');
      if (!dot) return;
      const doc = _topicClusterDocs[+dot.dataset.idx];
      if (!doc) return;
      const topic = _topicClusterTd?.topics?.find(t => t.topicId === doc.topicId);
      const label = doc.topicId === -1 ? 'Uncategorized' : topicDisplayLabel(topic?.label || '');
      const confidence = typeof doc.topicProbability === 'number' ? ` \u00B7 ${Math.round(doc.topicProbability * 100)}% confidence` : '';
      topicClusterTooltipEl.hidden = false;
      topicClusterTooltipEl.innerHTML = `
        <div class="tooltip-title">${escapeHtml((doc.title || '').slice(0, 100))}</div>
        <div class="tooltip-meta">${doc.year || '\u2014'} \u00B7 ${escapeHtml(label)}${escapeHtml(confidence)}</div>
      `;
      const rect = topicClusterContainerEl.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      topicClusterTooltipEl.style.left = (dotRect.left - rect.left + 12) + 'px';
      topicClusterTooltipEl.style.top = (dotRect.top - rect.top - 10) + 'px';
    });

    topicClusterChartEl.addEventListener('mouseout', e => {
      if (e.target.closest('.cluster-dot')) topicClusterTooltipEl.hidden = true;
    });

    addTouchTooltip(topicClusterChartEl, '.cluster-dot', (dot) => {
      const doc = _topicClusterDocs[+dot.dataset.idx];
      if (!doc) return;
      const topic = _topicClusterTd?.topics?.find(t => t.topicId === doc.topicId);
      const label = doc.topicId === -1 ? 'Uncategorized' : topicDisplayLabel(topic?.label || '');
      const confidence = typeof doc.topicProbability === 'number' ? ` \u00B7 ${Math.round(doc.topicProbability * 100)}% confidence` : '';
      topicClusterTooltipEl.hidden = false;
      topicClusterTooltipEl.innerHTML = `
        <div class="tooltip-title">${escapeHtml((doc.title || '').slice(0, 100))}</div>
        <div class="tooltip-meta">${doc.year || '\u2014'} \u00B7 ${escapeHtml(label)}${escapeHtml(confidence)}</div>
      `;
      const rect = topicClusterContainerEl.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      topicClusterTooltipEl.style.left = (dotRect.left - rect.left + 12) + 'px';
      topicClusterTooltipEl.style.top = (dotRect.top - rect.top - 10) + 'px';
    });

    topicClusterChartEl.addEventListener('click', e => {
      const dot = e.target.closest('.cluster-dot');
      if (!dot) return;
      const doc = _topicClusterDocs[+dot.dataset.idx];
      if (!doc) return;
      state.selectedDocId = doc.id;
      renderDetails();
      docModalOverlay.hidden = false;
    });
  }

  // Legend with toggle
  const activeTids = new Set(topicIds);
  const legendItems = topicIds.map(tid => {
    const topic = td.topics.find(t => t.topicId === tid);
    const label = tid === -1 ? 'Uncategorized' : topicDisplayLabel(topic?.label || `Topic ${tid}`);
    const color = colorMap.get(tid);
    const count = plotDocs.filter(d => d.topicId === tid).length;
    return `<span class="scatter-legend-item" data-legend-tid="${tid}">
      <span class="scatter-legend-swatch" style="background:${color}"></span>
      ${escapeHtml(label)} (${count})
    </span>`;
  }).join('');
  topicClusterLegendEl.innerHTML = legendItems;

  topicClusterLegendEl.onclick = e => {
    const item = e.target.closest('.scatter-legend-item');
    if (!item) return;
    const tid = Number(item.dataset.legendTid);
    if (activeTids.has(tid)) {
      activeTids.delete(tid);
      item.classList.add('dimmed');
    } else {
      activeTids.add(tid);
      item.classList.remove('dimmed');
    }
    // Update dot visibility
    for (const dot of topicClusterChartEl.querySelectorAll('.cluster-dot')) {
      const dotTid = Number(dot.dataset.topic);
      dot.setAttribute('fill-opacity', activeTids.has(dotTid) ? '0.7' : '0.05');
      dot.setAttribute('stroke-opacity', activeTids.has(dotTid) ? '0.3' : '0.02');
    }
  };
}

// --- Shared force-directed layout ---

function forceLayout(nodes, edges, { width, height, pad = 40, iterations = 200 }) {
  const w = width - pad * 2;
  const h = height - pad * 2;
  // Initialize random positions
  for (const n of nodes) {
    n.x = pad + Math.random() * w;
    n.y = pad + Math.random() * h;
    n.vx = 0;
    n.vy = 0;
  }

  const idxMap = new Map(nodes.map((n, i) => [n.id, i]));
  const k = Math.sqrt((w * h) / Math.max(nodes.length, 1));

  for (let iter = 0; iter < iterations; iter++) {
    const damping = 0.9 - (iter / iterations) * 0.4;

    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[i].x - nodes[j].x;
        let dy = nodes[i].y - nodes[j].y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (k * k) / dist;
        const fx = (dx / dist) * force * 0.05;
        const fy = (dy / dist) * force * 0.05;
        nodes[i].vx += fx;
        nodes[i].vy += fy;
        nodes[j].vx -= fx;
        nodes[j].vy -= fy;
      }
    }

    // Attraction along edges
    for (const e of edges) {
      const si = idxMap.get(e.source);
      const ti = idxMap.get(e.target);
      if (si == null || ti == null) continue;
      let dx = nodes[ti].x - nodes[si].x;
      let dy = nodes[ti].y - nodes[si].y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force * 0.01;
      const fy = (dy / dist) * force * 0.01;
      nodes[si].vx += fx;
      nodes[si].vy += fy;
      nodes[ti].vx -= fx;
      nodes[ti].vy -= fy;
    }

    // Centering
    const cx = width / 2, cy = height / 2;
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.002;
      n.vy += (cy - n.y) * 0.002;
    }

    // Apply velocity and clamp
    for (const n of nodes) {
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
      n.x = Math.max(pad, Math.min(width - pad, n.x));
      n.y = Math.max(pad, Math.min(height - pad, n.y));
    }
  }
  return nodes;
}

// --- Network graph tooltip helper ---

function showNetTooltip(containerEl, tooltipEl, target, html) {
  tooltipEl.hidden = false;
  tooltipEl.innerHTML = html;
  const rect = containerEl.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  let left = tRect.left - rect.left + 14;
  let top = tRect.top - rect.top - 10;
  if (left + 200 > rect.width) left = tRect.left - rect.left - 200;
  if (top < 0) top = tRect.bottom - rect.top + 6;
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}

// --- Touch tooltip helper ---

function addTouchTooltip(chartEl, selector, showFn) {
  chartEl.addEventListener('touchstart', (e) => {
    const el = e.target.closest(selector);
    if (!el) return;
    e.preventDefault();
    showFn(el);
  }, { passive: false });
}

document.addEventListener('touchstart', (e) => {
  if (!e.target.closest('.scatter-tooltip') && !e.target.closest('svg[viewBox]'))
    document.querySelectorAll('.scatter-tooltip').forEach(t => t.hidden = true);
});

// --- Topic Hierarchy Dendrogram ---

let _topicDendrogramRendered = false;

function renderTopicDendrogram() {
  const td = getAnalytics()?.topicData;
  if (!td?.topics?.length || !topicDendrogramChartEl) {
    if (topicDendrogramPanelEl) topicDendrogramPanelEl.hidden = true;
    return;
  }

  // Use pre-computed hierarchy from BERTopic if available
  const hierarchy = td.hierarchy;
  if (!hierarchy?.linkage?.length || !hierarchy?.leafTopicIds?.length) {
    topicDendrogramPanelEl.hidden = true;
    return;
  }

  // Build a map from topicId to topic object
  const topicMap = new Map(td.topics.map(t => [t.topicId, t]));

  // leafTopicIds maps leaf index → topicId; filter to topics we actually have data for
  const leafTopicIds = hierarchy.leafTopicIds;
  const leafTopics = leafTopicIds.map(id => topicMap.get(id)).filter(Boolean);

  if (leafTopics.length < 2) {
    topicDendrogramPanelEl.hidden = true;
    return;
  }
  topicDendrogramPanelEl.hidden = false;

  if (_topicDendrogramRendered) return;
  _topicDendrogramRendered = true;

  // Build binary tree from scipy linkage matrix
  // Linkage format: N-1 rows of [cluster_a, cluster_b, distance, size]
  // Clusters 0..N-1 are leaves; clusters N..2N-2 are internal nodes (N + row_index)
  const N = leafTopicIds.length;
  const linkageRows = hierarchy.linkage;

  // Create leaf nodes
  const nodes = [];
  for (let i = 0; i < N; i++) {
    const topic = topicMap.get(leafTopicIds[i]);
    nodes.push({ leaf: true, topic, topicIdx: i });
  }
  // Create internal nodes from linkage
  for (let i = 0; i < linkageRows.length; i++) {
    const [a, b, dist] = linkageRows[i];
    nodes.push({
      leaf: false,
      left: nodes[Math.round(a)],
      right: nodes[Math.round(b)],
      distance: dist,
    });
  }
  const root = nodes[nodes.length - 1];

  // Layout: horizontal dendrogram, root on left, leaves on right
  // Scale height by leaf count so labels don't overlap
  const nLeavesEst = leafTopicIds.length;
  const width = 940, height = Math.max(400, nLeavesEst * 32 + 60);
  const pad = { t: 30, r: 220, b: 30, l: 40 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  // Update SVG viewBox for dynamic height
  topicDendrogramChartEl.setAttribute('viewBox', `0 0 ${width} ${height}`);

  // Find max distance for x-scaling
  function maxDist(node) {
    if (node.leaf) return 0;
    return Math.max(node.distance, maxDist(node.left), maxDist(node.right));
  }
  const dMax = maxDist(root) || 1;

  // Count leaves
  function leafCount(node) {
    if (node.leaf) return 1;
    return leafCount(node.left) + leafCount(node.right);
  }
  const nLeaves = leafCount(root);
  const leafSpacing = plotH / (nLeaves - 1 || 1);

  // Assign y positions to leaves (evenly spaced)
  let leafIdx = 0;
  function assignLeafY(node) {
    if (node.leaf) {
      node.y = pad.t + leafIdx * leafSpacing;
      leafIdx++;
      return;
    }
    assignLeafY(node.left);
    assignLeafY(node.right);
    // Internal node y = midpoint of children
    node.y = (node.left.y + node.right.y) / 2;
  }
  assignLeafY(root);

  // x position: leaves on right, root on left
  // x proportional to distance from leaves
  function assignX(node) {
    if (node.leaf) {
      node.x = pad.l + plotW; // rightmost
      return;
    }
    assignX(node.left);
    assignX(node.right);
    // x based on distance (higher distance = further left = closer to root)
    node.x = pad.l + plotW * (1 - node.distance / dMax);
  }
  assignX(root);

  // Collect all branches and leaves for rendering
  const lines = [];
  const leaves = [];
  function collectDrawables(node) {
    if (node.leaf) {
      leaves.push(node);
      return;
    }
    collectDrawables(node.left);
    collectDrawables(node.right);
    // Horizontal lines from children to this node's x
    // Vertical line connecting children at this node's x
    lines.push(
      // left child horizontal
      `<line x1="${node.left.x}" y1="${node.left.y}" x2="${node.x}" y2="${node.left.y}" stroke="#7c8a97" stroke-width="1.5"/>`,
      // right child horizontal
      `<line x1="${node.right.x}" y1="${node.right.y}" x2="${node.x}" y2="${node.right.y}" stroke="#7c8a97" stroke-width="1.5"/>`,
      // vertical connector
      `<line x1="${node.x}" y1="${node.left.y}" x2="${node.x}" y2="${node.right.y}" stroke="#7c8a97" stroke-width="1.5"/>`
    );
  }
  collectDrawables(root);

  // Color by topic index
  const hueStep = 360 / Math.max(leaves.length, 1);

  // Doc count range for circle sizing
  const docCounts = leaves.map(l => l.topic.docCount);
  const minDoc = Math.min(...docCounts);
  const maxDoc = Math.max(...docCounts);
  const rMin = 5, rMax = 12;

  function circleR(dc) {
    if (maxDoc === minDoc) return (rMin + rMax) / 2;
    return rMin + (dc - minDoc) / (maxDoc - minDoc) * (rMax - rMin);
  }

  const leafSvg = leaves.map((l, i) => {
    const r = circleR(l.topic.docCount);
    const color = `hsl(${Math.round(i * hueStep)} 65% 50%)`;
    const label = topicDisplayLabel(l.topic.label);
    const truncLabel = label.length > 28 ? label.slice(0, 26) + '\u2026' : label;
    return `<circle cx="${l.x}" cy="${l.y}" r="${r}" fill="${color}" stroke="#fff" stroke-width="1.5"
              data-dendro-idx="${i}" style="cursor:pointer"/>
            <text x="${l.x + r + 6}" y="${l.y}" dy="0.35em" font-size="11" fill="var(--fg)"
              data-dendro-idx="${i}" style="cursor:pointer">${escapeHtml(truncLabel)}</text>`;
  });

  topicDendrogramChartEl.innerHTML = lines.join('') + leafSvg.join('');

  // Tooltip + click handlers
  const container = topicDendrogramContainerEl;
  const tooltip = topicDendrogramTooltipEl;
  const chart = topicDendrogramChartEl;

  chart.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-dendro-idx]');
    if (!el) return;
    const idx = +el.dataset.dendroIdx;
    const leaf = leaves[idx];
    if (!leaf) return;
    const t = leaf.topic;
    const label = topicDisplayLabel(t.label);
    const terms = (t.topTerms || []).slice(0, 5).map(p => p[0]).join(', ');
    tooltip.innerHTML = `<strong>${escapeHtml(label)}</strong>
      <div class="tooltip-meta">${t.docCount} dissertation(s)</div>
      <div class="tooltip-meta" style="margin-top:2px">Top terms: ${escapeHtml(terms)}</div>`;
    tooltip.hidden = false;
    const rect = container.getBoundingClientRect();
    const svgRect = chart.getBoundingClientRect();
    const scale = svgRect.width / 940;
    const cx = leaf.x * scale + svgRect.left - rect.left;
    const cy = leaf.y * scale + svgRect.top - rect.top;
    tooltip.style.left = `${cx + 15}px`;
    tooltip.style.top = `${cy - 10}px`;
  });
  chart.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-dendro-idx]');
    if (el) tooltip.hidden = true;
  });
  addTouchTooltip(chart, '[data-dendro-idx]', (el) => {
    const idx = +el.dataset.dendroIdx;
    const leaf = leaves[idx];
    if (!leaf) return;
    const t = leaf.topic;
    const label = topicDisplayLabel(t.label);
    const terms = (t.topTerms || []).slice(0, 5).map(p => p[0]).join(', ');
    tooltip.innerHTML = `<strong>${escapeHtml(label)}</strong>
      <div class="tooltip-meta">${t.docCount} dissertation(s)</div>
      <div class="tooltip-meta" style="margin-top:2px">Top terms: ${escapeHtml(terms)}</div>`;
    tooltip.hidden = false;
    const rect = container.getBoundingClientRect();
    const svgRect = chart.getBoundingClientRect();
    const scale = svgRect.width / 940;
    const cx = leaf.x * scale + svgRect.left - rect.left;
    const cy = leaf.y * scale + svgRect.top - rect.top;
    tooltip.style.left = `${cx + 15}px`;
    tooltip.style.top = `${cy - 10}px`;
  });
  chart.addEventListener('click', (e) => {
    const el = e.target.closest('[data-dendro-idx]');
    if (!el) return;
    const idx = +el.dataset.dendroIdx;
    const leaf = leaves[idx];
    if (!leaf) return;
    const t = leaf.topic;
    const label = topicDisplayLabel(t.label);
    openMatchesModal(`Topic: ${label}`, docsForTopic(t.topicId));
  });
}

// --- Supervisor Network ---

let _supervisorNetRendered = false;
let _supervisorNetNodes = [];
let _supervisorNetEdges = [];

function renderSupervisorNetwork() {
  const data = getAnalytics()?.supervisorNetwork;
  if (!data?.nodes?.length || !supervisorNetworkChartEl) {
    if (supervisorNetworkPanelEl) supervisorNetworkPanelEl.hidden = true;
    return;
  }
  supervisorNetworkPanelEl.hidden = false;

  const width = 940, height = 600;
  const nodes = data.nodes.map(n => ({ ...n }));
  const edges = data.edges;
  _supervisorNetNodes = nodes;
  _supervisorNetEdges = edges;

  forceLayout(nodes, edges, { width, height, pad: 60 });

  const maxDoc = Math.max(...nodes.map(n => n.docCount), 1);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const edgeSvg = edges.map(e => {
    const s = nodeMap.get(e.source);
    const t = nodeMap.get(e.target);
    if (!s || !t) return '';
    const w = Math.max(1, Math.min(6, e.weight));
    const op = Math.min(0.6, 0.15 + e.weight * 0.1);
    return `<line class="net-edge" x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}"
      stroke="hsl(190 50% 50%)" stroke-width="${w}" stroke-opacity="${op}" />`;
  }).join('');

  // Only label nodes with enough connections or docs to stand out
  const supEdgeDeg = new Map();
  for (const e of edges) {
    supEdgeDeg.set(e.source, (supEdgeDeg.get(e.source) || 0) + 1);
    supEdgeDeg.set(e.target, (supEdgeDeg.get(e.target) || 0) + 1);
  }

  const nodeSvg = nodes.map((n, i) => {
    const r = 5 + (n.docCount / maxDoc) * 14;
    const degree = supEdgeDeg.get(n.id) || 0;
    const showLabel = degree >= 2 || n.docCount >= 3;
    const label = showLabel ? (n.id.length > 18 ? n.id.slice(0, 16) + '\u2026' : n.id) : '';
    return `<circle class="net-node" cx="${n.x}" cy="${n.y}" r="${r}"
      fill="hsl(190 60% 48%)" fill-opacity="0.75" stroke="hsl(190 60% 38%)" stroke-width="1"
      data-idx="${i}" />${label ? `
      <text class="net-label" x="${n.x}" y="${n.y + r + 11}">${escapeHtml(label)}</text>` : ''}`;
  }).join('');

  supervisorNetworkChartEl.innerHTML = edgeSvg + nodeSvg;

  if (!_supervisorNetRendered) {
    _supervisorNetRendered = true;

    supervisorNetworkChartEl.addEventListener('mouseover', e => {
      const node = e.target.closest('.net-node');
      if (!node) return;
      const n = _supervisorNetNodes[+node.dataset.idx];
      if (!n) return;
      const connected = _supervisorNetEdges.filter(e => e.source === n.id || e.target === n.id)
        .map(e => e.source === n.id ? e.target : e.source).slice(0, 5);
      showNetTooltip(supervisorNetworkContainerEl, supervisorNetworkTooltipEl, node,
        `<div class="tooltip-title">${escapeHtml(n.id)}</div>
         <div class="tooltip-meta">${n.docCount} dissertation(s)${connected.length ? '<br>Connected: ' + connected.map(c => escapeHtml(c)).join(', ') : ''}</div>`);
    });

    supervisorNetworkChartEl.addEventListener('mouseout', e => {
      if (e.target.closest('.net-node')) supervisorNetworkTooltipEl.hidden = true;
    });

    addTouchTooltip(supervisorNetworkChartEl, '.net-node', (node) => {
      const n = _supervisorNetNodes[+node.dataset.idx];
      if (!n) return;
      const connected = _supervisorNetEdges.filter(e => e.source === n.id || e.target === n.id)
        .map(e => e.source === n.id ? e.target : e.source).slice(0, 5);
      showNetTooltip(supervisorNetworkContainerEl, supervisorNetworkTooltipEl, node,
        `<div class="tooltip-title">${escapeHtml(n.id)}</div>
         <div class="tooltip-meta">${n.docCount} dissertation(s)${connected.length ? '<br>Connected: ' + connected.map(c => escapeHtml(c)).join(', ') : ''}</div>`);
    });

    supervisorNetworkChartEl.addEventListener('click', e => {
      const node = e.target.closest('.net-node');
      if (!node) return;
      const n = _supervisorNetNodes[+node.dataset.idx];
      if (n) openSupervisorProfile(n.id);
    });
  }
}

// --- Citation Co-occurrence Network ---

let _citationNetRendered = false;
let _citationNetNodes = [];

function renderCitationNetwork() {
  const data = getAnalytics()?.citationCooccurrence;
  if (!data?.nodes?.length || !citationNetworkChartEl) {
    if (citationNetworkPanelEl) citationNetworkPanelEl.hidden = true;
    return;
  }
  citationNetworkPanelEl.hidden = false;

  const width = 940, height = 600;
  const nodes = data.nodes.map(n => ({ ...n }));
  const edges = data.edges;
  _citationNetNodes = nodes;

  forceLayout(nodes, edges, { width, height, pad: 50 });

  const maxFreq = Math.max(...nodes.map(n => n.freq), 1);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const edgeSvg = edges.map(e => {
    const s = nodeMap.get(e.source);
    const t = nodeMap.get(e.target);
    if (!s || !t) return '';
    const w = Math.max(1, Math.min(6, e.weight));
    const op = Math.min(0.6, 0.15 + e.weight * 0.1);
    return `<line class="net-edge" x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}"
      stroke="hsl(30 70% 55%)" stroke-width="${w}" stroke-opacity="${op}" />`;
  }).join('');

  // Extract "Author (Year)" from citation text for compact labels
  function citationShortLabel(text) {
    // Try "Author, ... (Year)" or "Author, ... Year"
    const m = text.match(/^([^,(]+?)[\s,].*?\b((?:19|20)\d{2})\b/);
    if (m) return `${m[1].trim()} (${m[2]})`;
    // Fallback: first author surname
    const surname = text.match(/^([A-Z][a-z]+)/);
    return surname ? surname[1] : text.slice(0, 15);
  }

  // Only label nodes with enough connections to be readable
  const edgeCount = new Map();
  for (const e of edges) {
    edgeCount.set(e.source, (edgeCount.get(e.source) || 0) + 1);
    edgeCount.set(e.target, (edgeCount.get(e.target) || 0) + 1);
  }

  const nodeSvg = nodes.map((n, i) => {
    const r = 5 + (n.freq / maxFreq) * 14;
    const degree = edgeCount.get(n.id) || 0;
    const showLabel = degree >= 3 || n.freq >= 3;
    const label = showLabel ? citationShortLabel(n.label) : '';
    return `<circle class="net-node" cx="${n.x}" cy="${n.y}" r="${r}"
      fill="hsl(30 65% 55%)" fill-opacity="0.75" stroke="hsl(30 65% 42%)" stroke-width="1"
      data-idx="${i}" />${label ? `
      <text class="net-label" x="${n.x}" y="${n.y + r + 11}">${escapeHtml(label)}</text>` : ''}`;
  }).join('');

  citationNetworkChartEl.innerHTML = edgeSvg + nodeSvg;

  if (!_citationNetRendered) {
    _citationNetRendered = true;

    citationNetworkChartEl.addEventListener('mouseover', e => {
      const node = e.target.closest('.net-node');
      if (!node) return;
      const n = _citationNetNodes[+node.dataset.idx];
      if (!n) return;
      showNetTooltip(citationNetworkContainerEl, citationNetworkTooltipEl, node,
        `<div class="tooltip-title">${escapeHtml(n.label)}</div>
         <div class="tooltip-meta">Cited in ${n.freq} dissertation(s)</div>`);
    });

    citationNetworkChartEl.addEventListener('mouseout', e => {
      if (e.target.closest('.net-node')) citationNetworkTooltipEl.hidden = true;
    });

    addTouchTooltip(citationNetworkChartEl, '.net-node', (node) => {
      const n = _citationNetNodes[+node.dataset.idx];
      if (!n) return;
      showNetTooltip(citationNetworkContainerEl, citationNetworkTooltipEl, node,
        `<div class="tooltip-title">${escapeHtml(n.label)}</div>
         <div class="tooltip-meta">Cited in ${n.freq} dissertation(s)</div>`);
    });

    citationNetworkChartEl.addEventListener('click', e => {
      const node = e.target.closest('.net-node');
      if (!node) return;
      const n = _citationNetNodes[+node.dataset.idx];
      if (!n) return;
      // Navigate to citation explorer showing docs for this citation
      const docs = state.payload?.documents || [];
      openMatchesModal(`Citation: ${n.label.slice(0, 60)}`, docs);
    });
  }
}

// --- Concept Co-occurrence Network ---

let _conceptNetRendered = false;
let _conceptNetNodes = [];

function renderConceptNetwork() {
  const cooc = getAnalytics()?.termCooccurrence;
  if (!cooc?.length || !conceptNetworkChartEl) {
    if (conceptNetworkPanelEl) conceptNetworkPanelEl.hidden = true;
    return;
  }
  conceptNetworkPanelEl.hidden = false;

  // Extract unique nodes from co-occurrence pairs
  const nodeFreqs = new Map();
  for (const pair of cooc) {
    if (!nodeFreqs.has(pair.termA)) nodeFreqs.set(pair.termA, pair.freqA || pair.count);
    if (!nodeFreqs.has(pair.termB)) nodeFreqs.set(pair.termB, pair.freqB || pair.count);
  }

  const width = 940, height = 600;
  const nodes = Array.from(nodeFreqs.entries()).map(([id, freq]) => ({ id, freq }));
  const edges = cooc.map(p => ({ source: p.termA, target: p.termB, weight: p.lift || p.count }));

  forceLayout(nodes, edges, { width, height, pad: 60 });

  const maxFreq = Math.max(...nodes.map(n => n.freq), 1);
  const maxLift = Math.max(...edges.map(e => e.weight), 1);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const edgeSvg = edges.map(e => {
    const s = nodeMap.get(e.source);
    const t = nodeMap.get(e.target);
    if (!s || !t) return '';
    const w = Math.max(1, Math.min(5, (e.weight / maxLift) * 5));
    const op = Math.min(0.6, 0.1 + (e.weight / maxLift) * 0.5);
    return `<line class="net-edge" x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}"
      stroke="hsl(160 45% 45%)" stroke-width="${w}" stroke-opacity="${op}" />`;
  }).join('');

  // Only label nodes with 2+ edges so the graph stays readable
  const conceptEdgeDeg = new Map();
  for (const e of edges) {
    conceptEdgeDeg.set(e.source, (conceptEdgeDeg.get(e.source) || 0) + 1);
    conceptEdgeDeg.set(e.target, (conceptEdgeDeg.get(e.target) || 0) + 1);
  }

  const nodeSvg = nodes.map((n, i) => {
    const r = 5 + (n.freq / maxFreq) * 14;
    const degree = conceptEdgeDeg.get(n.id) || 0;
    const showLabel = degree >= 2 || n.freq >= 6;
    const label = showLabel ? (n.id.length > 20 ? n.id.slice(0, 18) + '\u2026' : n.id) : '';
    return `<circle class="net-node" cx="${n.x}" cy="${n.y}" r="${r}"
      fill="hsl(160 55% 45%)" fill-opacity="0.7" stroke="hsl(160 55% 35%)" stroke-width="1"
      data-idx="${i}" />${label ? `
      <text class="net-label" x="${n.x}" y="${n.y + r + 11}">${escapeHtml(label)}</text>` : ''}`;
  }).join('');

  conceptNetworkChartEl.innerHTML = edgeSvg + nodeSvg;
  _conceptNetNodes = nodes;

  if (!_conceptNetRendered) {
    _conceptNetRendered = true;

    conceptNetworkChartEl.addEventListener('mouseover', e => {
      const node = e.target.closest('.net-node');
      if (!node) return;
      const n = _conceptNetNodes[+node.dataset.idx];
      if (!n) return;
      showNetTooltip(conceptNetworkContainerEl, conceptNetworkTooltipEl, node,
        `<div class="tooltip-title">${escapeHtml(n.id)}</div>
         <div class="tooltip-meta">${n.freq} document(s)</div>`);
    });

    conceptNetworkChartEl.addEventListener('mouseout', e => {
      if (e.target.closest('.net-node')) conceptNetworkTooltipEl.hidden = true;
    });

    addTouchTooltip(conceptNetworkChartEl, '.net-node', (node) => {
      const n = _conceptNetNodes[+node.dataset.idx];
      if (!n) return;
      showNetTooltip(conceptNetworkContainerEl, conceptNetworkTooltipEl, node,
        `<div class="tooltip-title">${escapeHtml(n.id)}</div>
         <div class="tooltip-meta">${n.freq} document(s)</div>`);
    });

    conceptNetworkChartEl.addEventListener('click', e => {
      const node = e.target.closest('.net-node');
      if (!node) return;
      const n = _conceptNetNodes[+node.dataset.idx];
      if (!n) return;
      const docs = state.payload?.documents || [];
      const matches = docs.filter(d => (d.conceptTerms || []).some(t => t.toLowerCase() === n.id.toLowerCase()));
      openMatchesModal(`Concept: ${n.id}`, matches);
    });
  }
}

// --- Topic Evolution Sankey ---

function renderTopicSankey() {
  const td = getAnalytics()?.topicData;
  if (!td?.byYear?.length || !topicSankeyChartEl) {
    if (topicSankeyPanelEl) topicSankeyPanelEl.hidden = true;
    return;
  }
  topicSankeyPanelEl.hidden = false;

  const byYear = td.byYear;
  const topics = td.topics?.filter(t => t.topicId !== -1).slice(0, 8) || [];
  if (!topics.length) { topicSankeyPanelEl.hidden = true; return; }

  // Collect all years across all topics
  const allYears = new Set();
  for (const t of byYear) {
    for (const d of t.data) allYears.add(d.year);
  }
  const sortedYears = Array.from(allYears).sort((a, b) => a - b);
  if (sortedYears.length < 2) { topicSankeyPanelEl.hidden = true; return; }

  // Bin into periods (5-year bins)
  const minYear = sortedYears[0];
  const maxYear = sortedYears[sortedYears.length - 1];
  const binSize = 5;
  const periods = [];
  for (let y = minYear; y <= maxYear; y += binSize) {
    const end = Math.min(y + binSize - 1, maxYear);
    periods.push({ start: y, end, label: `${y}\u2013${end}` });
  }

  // Build period counts per topic
  const topicPeriods = byYear.map(t => {
    const yearMap = new Map(t.data.map(d => [d.year, d.count]));
    return {
      topicId: t.topicId,
      label: t.label,
      counts: periods.map(p => {
        let sum = 0;
        for (let y = p.start; y <= p.end; y++) sum += (yearMap.get(y) || 0);
        return sum;
      })
    };
  });

  const width = 940, height = 500;
  const pad = { t: 30, r: 30, b: 40, l: 30 };
  const colWidth = (width - pad.l - pad.r) / Math.max(periods.length - 1, 1);

  // Color per topic
  const hueStep = 360 / Math.max(topicPeriods.length, 1);
  const colorForIdx = i => `hsl(${Math.round(i * hueStep)} 60% 50%)`;

  // For each period, compute stacked positions
  const periodTotals = periods.map((_, pi) => topicPeriods.reduce((s, t) => s + t.counts[pi], 0));
  const maxTotal = Math.max(...periodTotals, 1);
  const availH = height - pad.t - pad.b;

  // Compute stacked y positions for each topic at each period
  const stacks = periods.map((_, pi) => {
    const total = periodTotals[pi];
    const scale = total > 0 ? availH / maxTotal : 0;
    let y0 = pad.t + (availH - total * scale) / 2;
    return topicPeriods.map((t, ti) => {
      const h = t.counts[pi] * scale;
      const entry = { y: y0, h };
      y0 += h;
      return entry;
    });
  });

  let svg = '';

  // Draw bands between consecutive periods
  for (let pi = 0; pi < periods.length - 1; pi++) {
    const x1 = pad.l + pi * colWidth;
    const x2 = pad.l + (pi + 1) * colWidth;
    for (let ti = 0; ti < topicPeriods.length; ti++) {
      const s = stacks[pi][ti];
      const e = stacks[pi + 1][ti];
      if (s.h < 0.5 && e.h < 0.5) continue;
      const color = colorForIdx(ti);
      svg += `<path d="M${x1},${s.y} C${(x1 + x2) / 2},${s.y} ${(x1 + x2) / 2},${e.y} ${x2},${e.y}
        L${x2},${e.y + e.h} C${(x1 + x2) / 2},${e.y + e.h} ${(x1 + x2) / 2},${s.y + s.h} ${x1},${s.y + s.h} Z"
        fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-opacity="0.3" stroke-width="0.5" />`;
    }
  }

  // Period labels
  for (let pi = 0; pi < periods.length; pi++) {
    const x = pad.l + pi * colWidth;
    svg += `<text class="axis" x="${x}" y="${height - 10}" text-anchor="middle">${periods[pi].label}</text>`;
  }

  topicSankeyChartEl.innerHTML = svg;

  // Legend
  topicSankeyLegendEl.innerHTML = topicPeriods.map((t, i) => {
    const label = topicDisplayLabel(t.label);
    return `<span class="scatter-legend-item">
      <span class="scatter-legend-swatch" style="background:${colorForIdx(i)}"></span>
      ${escapeHtml(label)}
    </span>`;
  }).join('');
}

// --- Methodology × Topic Bubble Chart ---

let _methTopicRendered = false;
let _methTopicData = null;

function renderMethTopicBubble() {
  const data = getAnalytics()?.methodologyTopicMatrix;
  if (!data?.methodologies?.length || !data?.topics?.length || !methTopicBubbleChartEl) {
    if (methTopicBubblePanelEl) methTopicBubblePanelEl.hidden = true;
    return;
  }
  methTopicBubblePanelEl.hidden = false;
  _methTopicData = data;

  const meths = data.methodologies;
  const topics = data.topics;
  const matrix = data.matrix;

  const width = 940, height = 540;
  const pad = { t: 30, r: 30, b: 130, l: 130 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  const colW = plotW / Math.max(topics.length, 1);
  const rowH = plotH / Math.max(meths.length, 1);

  // Find max count for radius scaling
  let maxVal = 0;
  for (const row of matrix) for (const v of row) if (v > maxVal) maxVal = v;
  const maxR = Math.min(colW, rowH) / 2.5;

  // Color per topic
  const hueStep = 360 / Math.max(topics.length, 1);

  let svg = '';

  // Y-axis labels (methodologies)
  for (let mi = 0; mi < meths.length; mi++) {
    const y = pad.t + mi * rowH + rowH / 2;
    svg += `<text class="axis" x="${pad.l - 8}" y="${y + 3}" text-anchor="end">${escapeHtml(meths[mi])}</text>`;
  }

  // X-axis labels (topics) — rotated, word-wrapped
  for (let ti = 0; ti < topics.length; ti++) {
    const x = pad.l + ti * colW + colW / 2;
    const label = topicDisplayLabel(topics[ti].label);
    const lines = wrapLabel(label, 14);
    const tspans = lines.map((line, li) =>
      `<tspan x="${x}" dy="${li === 0 ? 0 : '1.1em'}">${escapeHtml(line)}</tspan>`
    ).join('');
    svg += `<text class="axis" x="${x}" y="${height - pad.b + 14}" text-anchor="end"
      transform="rotate(-45 ${x} ${height - pad.b + 14})"><title>${escapeHtml(label)}</title>${tspans}</text>`;
  }

  // Bubbles
  for (let mi = 0; mi < meths.length; mi++) {
    for (let ti = 0; ti < topics.length; ti++) {
      const val = matrix[mi][ti];
      if (!val) continue;
      const cx = pad.l + ti * colW + colW / 2;
      const cy = pad.t + mi * rowH + rowH / 2;
      const r = Math.max(3, Math.sqrt(val / Math.max(maxVal, 1)) * maxR);
      const hue = Math.round(ti * hueStep);
      svg += `<circle class="net-node" cx="${cx}" cy="${cy}" r="${r}"
        fill="hsl(${hue} 55% 52%)" fill-opacity="0.65" stroke="hsl(${hue} 55% 40%)" stroke-width="1"
        data-mi="${mi}" data-ti="${ti}" />`;
    }
  }

  methTopicBubbleChartEl.innerHTML = svg;

  if (!_methTopicRendered) {
    _methTopicRendered = true;

    methTopicBubbleChartEl.addEventListener('mouseover', e => {
      const node = e.target.closest('.net-node');
      if (!node) return;
      const d = _methTopicData;
      if (!d) return;
      const mi = +node.dataset.mi;
      const ti = +node.dataset.ti;
      const val = d.matrix[mi]?.[ti] || 0;
      showNetTooltip(methTopicBubbleContainerEl, methTopicBubbleTooltipEl, node,
        `<div class="tooltip-title">${escapeHtml(d.methodologies[mi])}</div>
         <div class="tooltip-meta">${escapeHtml(topicDisplayLabel(d.topics[ti]?.label || ''))} \u00B7 ${val} dissertation(s)</div>`);
    });

    methTopicBubbleChartEl.addEventListener('mouseout', e => {
      if (e.target.closest('.net-node')) methTopicBubbleTooltipEl.hidden = true;
    });

    addTouchTooltip(methTopicBubbleChartEl, '.net-node', (node) => {
      const d = _methTopicData;
      if (!d) return;
      const mi = +node.dataset.mi;
      const ti = +node.dataset.ti;
      const val = d.matrix[mi]?.[ti] || 0;
      showNetTooltip(methTopicBubbleContainerEl, methTopicBubbleTooltipEl, node,
        `<div class="tooltip-title">${escapeHtml(d.methodologies[mi])}</div>
         <div class="tooltip-meta">${escapeHtml(topicDisplayLabel(d.topics[ti]?.label || ''))} \u00B7 ${val} dissertation(s)</div>`);
    });

    methTopicBubbleChartEl.addEventListener('click', e => {
      const node = e.target.closest('.net-node');
      if (!node) return;
      const d = _methTopicData;
      if (!d) return;
      const mi = +node.dataset.mi;
      const ti = +node.dataset.ti;
      const meth = d.methodologies[mi];
      const topicId = d.topics[ti]?.topicId;
      const docs = state.payload?.documents || [];
      const matches = docs.filter(doc =>
        (doc.methodologies || []).includes(meth) && doc.topicId === topicId
      );
      openMatchesModal(`${meth} + ${topicDisplayLabel(d.topics[ti]?.label || '')}`, matches);
    });
  }

}

import {
  dom,
  ensureD3Library,
  escapeHtml,
  formatNum,
  setStatus,
  state,
} from './core.js';
import {
  getAnalytics,
  loadVisualizationData,
} from './data.js';
import {
  getFilteredDocs,
  docsForTopic,
  openMatchesModal,
  openRecord,
} from './documents.js';

const {
  analyticsTabButtons,
  citationNetworkChartEl,
  citationNetworkContainerEl,
  citationNetworkPanelEl,
  citationNetworkTooltipEl,
  conceptNetworkChartEl,
  conceptNetworkContainerEl,
  conceptNetworkPanelEl,
  conceptNetworkTooltipEl,
  conceptTimelineChartEl,
  conceptTimelineLegendEl,
  methTopicBubbleChartEl,
  methTopicBubbleContainerEl,
  methTopicBubblePanelEl,
  methTopicBubbleTooltipEl,
  supervisorNetworkChartEl,
  supervisorNetworkContainerEl,
  supervisorNetworkPanelEl,
  supervisorNetworkTooltipEl,
  topicBarsEl,
  topicClusterChartEl,
  topicClusterContainerEl,
  topicClusterLegendEl,
  topicClusterPanelEl,
  topicClusterTooltipEl,
  topicDendrogramChartEl,
  topicDendrogramContainerEl,
  topicDendrogramPanelEl,
  topicDendrogramTooltipEl,
  topicDistPanelEl,
  topicModelMetaEl,
  topicSankeyChartEl,
  topicSankeyLegendEl,
  topicSankeyPanelEl,
  topicTimelineChartEl,
  topicTimelineLegendEl,
  topicTimelinePanelEl,
} = dom;

let topicVisualsInitialized = false;
const topicVisualIntegrations = {
  openSupervisorProfile: async () => {},
};

function configureTopicVisuals(integrations = {}) {
  Object.assign(topicVisualIntegrations, integrations);
}

function initTopicVisuals() {
  if (topicVisualsInitialized) return;
  topicVisualsInitialized = true;
}

async function loadAndRenderVisualizations() {
  try {
    await ensureD3Library();
    await loadVisualizationData();
  } catch (error) {
    setStatus(`Failed to load visualizations: ${error.message}`, true);
    return;
  }
  renderVisualizations();
}

function renderVisualizations() {
  renderTopicCluster();
  renderTopicDendrogram();
  renderTopicSankey();
  renderMethTopicBubble();
  renderSupervisorNetwork();
  renderCitationNetwork();
  renderConceptNetwork();
}


let conceptTimelineChartInstance = null;

function renderConceptTimeline() {
  const data = getAnalytics()?.conceptTimeline || [];
  if (!data.length || !conceptTimelineChartEl) {
    if (conceptTimelineChartEl) conceptTimelineChartEl.innerHTML = '<p class="meta">No concept timeline data available.</p>';
    if (conceptTimelineLegendEl) conceptTimelineLegendEl.innerHTML = '';
    return;
  }

  const canvas = conceptTimelineChartEl.querySelector('canvas');
  if (!canvas) return;

  if (conceptTimelineChartInstance) {
    conceptTimelineChartInstance.destroy();
  }

  // Collect all years and sort them
  const allYears = new Set();
  for (const series of data) {
    for (const pt of series.data) {
      allYears.add(pt.year);
    }
  }
  const years = Array.from(allYears).sort((a, b) => a - b);
  if (!years.length) {
    conceptTimelineChartEl.innerHTML = '<p class="meta">No year data.</p>';
    if (conceptTimelineLegendEl) conceptTimelineLegendEl.innerHTML = '';
    return;
  }

  const hueStep = 360 / data.length;
  const datasets = data.map((series, idx) => {
    const hue = Math.round(idx * hueStep);
    const color = `hsl(${hue}, 65%, 45%)`;
    
    // Create a map of year -> count for this series
    const yearMap = new Map(series.data.map(pt => [pt.year, pt.count]));
    const seriesData = years.map(yr => yearMap.get(yr) || 0);

    return {
      label: `${series.concept} (${series.totalDocs})`,
      data: seriesData,
      borderColor: color,
      backgroundColor: `hsla(${hue}, 65%, 45%, 0.05)`,
      borderWidth: 2,
      tension: 0.15,
      pointRadius: 3,
      pointHoverRadius: 5
    };
  });

  conceptTimelineChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: years,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: 'var(--fg)',
            boxWidth: 12,
            font: { size: 11 }
          }
        }
      },
      scales: {
        x: { 
          grid: { display: false },
          ticks: { color: 'var(--fg)' }
        },
        y: { 
          beginAtZero: true,
          ticks: { color: 'var(--fg)' }
        }
      }
    }
  });

  if (conceptTimelineLegendEl) conceptTimelineLegendEl.innerHTML = '';
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

let topicTimelineChartInstance = null;

function renderTopicTimeline() {
  const td = getAnalytics()?.topicData;
  if (!td || !td.byYear || !td.byYear.length) {
    if (topicTimelinePanelEl) topicTimelinePanelEl.hidden = true;
    return;
  }
  topicTimelinePanelEl.hidden = false;

  const data = td.byYear;
  const canvas = topicTimelineChartEl.querySelector('canvas');
  if (!canvas) return;

  if (topicTimelineChartInstance) {
    topicTimelineChartInstance.destroy();
  }

  const allYears = new Set();
  for (const series of data) {
    for (const pt of series.data) {
      allYears.add(pt.year);
    }
  }
  const years = Array.from(allYears).sort((a, b) => a - b);
  if (!years.length) {
    topicTimelineChartEl.innerHTML = '<p class="meta">No year data.</p>';
    if (topicTimelineLegendEl) topicTimelineLegendEl.innerHTML = '';
    return;
  }

  const hueStep = 360 / data.length;
  const datasets = data.map((series, idx) => {
    const hue = Math.round(idx * hueStep);
    const color = `hsl(${hue}, 65%, 45%)`;
    
    const yearMap = new Map(series.data.map(pt => [pt.year, pt.count]));
    const seriesData = years.map(yr => yearMap.get(yr) || 0);

    return {
      label: topicDisplayLabel(series.label),
      data: seriesData,
      borderColor: color,
      backgroundColor: `hsla(${hue}, 65%, 45%, 0.05)`,
      borderWidth: 2,
      tension: 0.15,
      pointRadius: 3,
      pointHoverRadius: 5
    };
  });

  topicTimelineChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: years,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: 'var(--fg)',
            boxWidth: 12,
            font: { size: 11 }
          }
        }
      },
      scales: {
        x: { 
          grid: { display: false },
          ticks: { color: 'var(--fg)' }
        },
        y: { 
          beginAtZero: true,
          ticks: { color: 'var(--fg)' }
        }
      }
    }
  });

  if (topicTimelineLegendEl) topicTimelineLegendEl.innerHTML = '';
}

// --- Analytics sub-tabs ---

async function setActiveAnalyticsTab(tabName) {
  for (const btn of analyticsTabButtons) {
    btn.classList.toggle('active', btn.dataset.analyticsTab === tabName);
  }
  for (const section of document.querySelectorAll('.analytics-tab-section')) {
    section.classList.toggle('active', section.id === `analytics-${tabName}`);
  }
  if (tabName === 'visualizations' && state.payload) {
    try {
      await ensureD3Library();
      await loadVisualizationData();
    } catch (error) {
      setStatus(`Failed to load visualizations: ${error.message}`, true);
      return;
    }
    renderTopicCluster();
    renderTopicDendrogram();
    renderTopicSankey();
    renderMethTopicBubble();
    renderSupervisorNetwork();
    renderCitationNetwork();
    renderConceptNetwork();
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
  const minX = d3.min(xs), maxX = d3.max(xs);
  const minY = d3.min(ys), maxY = d3.max(ys);

  const svg = d3.select(topicClusterChartEl)
    .attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  const topicIds = [...new Set(plotDocs.map(d => d.topicId))].sort((a, b) => a - b);
  const hueStep = 360 / Math.max(topicIds.length, 1);
  const colorMap = new Map();
  topicIds.forEach((tid, i) => {
    colorMap.set(tid, tid === -1
      ? 'hsl(0, 0%, 72%)'
      : `hsl(${Math.round(i * hueStep)}, 65%, 50%)`);
  });

  const xScale = d3.scaleLinear()
    .domain([minX, maxX])
    .range([pad.l, width - pad.r]);

  const yScale = d3.scaleLinear()
    .domain([minY, maxY])
    .range([pad.t, height - pad.b]);

  const gContainer = svg.append('g');

  const zoom = d3.zoom()
    .scaleExtent([0.5, 10])
    .on('zoom', (event) => {
      gContainer.attr('transform', event.transform);
    });
  svg.call(zoom);

  const dots = gContainer.selectAll('.cluster-dot')
    .data(plotDocs)
    .enter()
    .append('circle')
    .attr('class', 'cluster-dot')
    .attr('cx', d => xScale(d.umapX))
    .attr('cy', d => yScale(d.umapY))
    .attr('r', 4)
    .attr('fill', d => colorMap.get(d.topicId) || '#999')
    .attr('fill-opacity', 0.7)
    .attr('stroke', d => colorMap.get(d.topicId) || '#999')
    .attr('stroke-opacity', 0.3)
    .attr('stroke-width', 1)
    .style('cursor', 'pointer');

  const tooltip = d3.select(topicClusterTooltipEl);

  dots.on('mouseover', function(event, d) {
    const topic = td?.topics?.find(t => t.topicId === d.topicId);
    const label = d.topicId === -1 ? 'Uncategorized' : topicDisplayLabel(topic?.label || '');
    const confidence = typeof d.topicProbability === 'number' ? ` \u00B7 ${Math.round(d.topicProbability * 100)}% confidence` : '';
    
    d3.select(this)
      .transition()
      .duration(100)
      .attr('r', 8)
      .attr('fill-opacity', 1);

    tooltip.style('display', 'block')
      .html(`
        <div class="tooltip-title">${escapeHtml((d.title || '').slice(0, 100))}</div>
        <div class="tooltip-meta">${d.year || '\u2014'} \u00B7 ${escapeHtml(label)}${escapeHtml(confidence)}</div>
      `);
    
    const rect = topicClusterContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 12) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');
  })
  .on('mousemove', function(event) {
    const rect = topicClusterContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 12) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');
  })
  .on('mouseout', function() {
    d3.select(this)
      .transition()
      .duration(100)
      .attr('r', 4)
      .attr('fill-opacity', 0.7);

    tooltip.style('display', 'none');
  })
  .on('click', function(event, d) {
    openRecord(d.id, 'analytics');
  });

  const activeTids = new Set(topicIds);
  const legendContainer = d3.select(topicClusterLegendEl);
  legendContainer.selectAll('*').remove();

  const legendItems = legendContainer.selectAll('.scatter-legend-item')
    .data(topicIds)
    .enter()
    .append('span')
    .attr('class', 'scatter-legend-item')
    .style('cursor', 'pointer')
    .html(tid => {
      const topic = td.topics.find(t => t.topicId === tid);
      const label = tid === -1 ? 'Uncategorized' : topicDisplayLabel(topic?.label || `Topic ${tid}`);
      const color = colorMap.get(tid);
      const count = plotDocs.filter(d => d.topicId === tid).length;
      return `<span class="scatter-legend-swatch" style="background:${color}"></span>${escapeHtml(label)} (${count})`;
    });

  legendItems.on('click', function(event, tid) {
    if (activeTids.has(tid)) {
      activeTids.delete(tid);
      d3.select(this).classed('dimmed', true);
    } else {
      activeTids.add(tid);
      d3.select(this).classed('dimmed', false);
    }

    dots.transition()
      .duration(200)
      .attr('fill-opacity', d => activeTids.has(d.topicId) ? 0.7 : 0.05)
      .attr('stroke-opacity', d => activeTids.has(d.topicId) ? 0.3 : 0.02)
      .style('pointer-events', d => activeTids.has(d.topicId) ? 'auto' : 'none');
  });
}

// --- Shared force-directed layout ---

function drag(simulation) {
  function dragstarted(event) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
  }
  
  function dragged(event) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }
  
  function dragended(event) {
    if (!event.active) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
  }
  
  return d3.drag()
    .on('start', dragstarted)
    .on('drag', dragged)
    .on('end', dragended);
}

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

function renderTopicDendrogram() {
  const td = getAnalytics()?.topicData;
  if (!td?.topics?.length || !topicDendrogramChartEl) {
    if (topicDendrogramPanelEl) topicDendrogramPanelEl.hidden = true;
    return;
  }

  const hierarchy = td.hierarchy;
  if (!hierarchy?.linkage?.length || !hierarchy?.leafTopicIds?.length) {
    topicDendrogramPanelEl.hidden = true;
    return;
  }

  const topicMap = new Map(td.topics.map(t => [t.topicId, t]));
  const leafTopicIds = hierarchy.leafTopicIds;
  const leafTopics = leafTopicIds.map(id => topicMap.get(id)).filter(Boolean);

  if (leafTopics.length < 2) {
    topicDendrogramPanelEl.hidden = true;
    return;
  }
  topicDendrogramPanelEl.hidden = false;

  const N = leafTopicIds.length;
  const linkageRows = hierarchy.linkage;

  const nodes = [];
  for (let i = 0; i < N; i++) {
    const topic = topicMap.get(leafTopicIds[i]);
    nodes.push({ leaf: true, topic, topicIdx: i, name: topic?.label || `Topic ${leafTopicIds[i]}` });
  }
  for (let i = 0; i < linkageRows.length; i++) {
    const [a, b, dist] = linkageRows[i];
    nodes.push({
      leaf: false,
      left: nodes[Math.round(a)],
      right: nodes[Math.round(b)],
      distance: dist,
      name: `Cluster ${N + i}`
    });
  }
  const rootNode = nodes[nodes.length - 1];

  const width = 940, height = Math.max(400, N * 32 + 60);
  const pad = { t: 30, r: 220, b: 30, l: 40 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  const svg = d3.select(topicDendrogramChartEl)
    .attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  const root = d3.hierarchy(rootNode, d => d.leaf ? null : [d.left, d.right]);

  const clusterLayout = d3.cluster()
    .size([plotH, plotW]);
  clusterLayout(root);

  const dMax = root.data.distance || 1;
  root.each(node => {
    node.y = pad.l + plotW * (1 - (node.data.distance || 0) / dMax);
    node.x = pad.t + node.x;
  });

  const links = root.descendants().filter(d => d.parent);
  svg.append('g')
    .selectAll('path')
    .data(links)
    .enter()
    .append('path')
    .attr('d', d => `
      M ${d.y} ${d.x}
      L ${d.parent.y} ${d.x}
      L ${d.parent.y} ${d.parent.x}
    `)
    .attr('fill', 'none')
    .attr('stroke', '#7c8a97')
    .attr('stroke-width', 1.5);

  const leaves = root.leaves();
  const hueStep = 360 / Math.max(leaves.length, 1);
  const docCounts = leaves.map(l => l.data.topic.docCount);
  const minDoc = d3.min(docCounts);
  const maxDoc = d3.max(docCounts);
  const rMin = 5, rMax = 12;

  const rScale = d3.scaleLinear()
    .domain([minDoc, maxDoc])
    .range([rMin, rMax]);

  const leafGroups = svg.append('g')
    .selectAll('g')
    .data(leaves)
    .enter()
    .append('g')
    .attr('transform', d => `translate(${d.y},${d.x})`)
    .style('cursor', 'pointer');

  leafGroups.append('circle')
    .attr('r', d => rScale(d.data.topic.docCount))
    .attr('fill', (d, i) => `hsl(${Math.round(i * hueStep)}, 65%, 50%)`)
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.5);

  leafGroups.append('text')
    .attr('x', d => rScale(d.data.topic.docCount) + 6)
    .attr('dy', '0.35em')
    .attr('font-size', '11')
    .attr('fill', 'var(--fg)')
    .text(d => {
      const label = topicDisplayLabel(d.data.topic.label);
      return label.length > 28 ? label.slice(0, 26) + '\u2026' : label;
    });

  const tooltip = d3.select(topicDendrogramTooltipEl);

  leafGroups.on('mouseover', function(event, d) {
    const t = d.data.topic;
    const label = topicDisplayLabel(t.label);
    const terms = (t.topTerms || []).slice(0, 5).map(p => Array.isArray(p) ? p[0] : p).join(', ');

    tooltip.html(`<strong>${escapeHtml(label)}</strong>
      <div class="tooltip-meta">${t.docCount} dissertation(s)</div>
      <div class="tooltip-meta" style="margin-top:2px">Top terms: ${escapeHtml(terms)}</div>`)
      .style('display', 'block');

    const rect = topicDendrogramContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 15) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');

    d3.select(this).select('circle')
      .transition()
      .duration(100)
      .attr('r', rScale(t.docCount) + 4);
  })
  .on('mousemove', function(event) {
    const rect = topicDendrogramContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 15) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');
  })
  .on('mouseout', function(event, d) {
    tooltip.style('display', 'none');
    d3.select(this).select('circle')
      .transition()
      .duration(100)
      .attr('r', rScale(d.data.topic.docCount));
  })
  .on('click', function(event, d) {
    const label = topicDisplayLabel(d.data.topic.label);
    openMatchesModal(`Topic: ${label}`, docsForTopic(d.data.topic.topicId));
  });
}

function renderSupervisorNetwork() {
  const data = getAnalytics()?.supervisorNetwork;
  if (!data?.nodes?.length || !supervisorNetworkChartEl) {
    if (supervisorNetworkPanelEl) supervisorNetworkPanelEl.hidden = true;
    return;
  }
  supervisorNetworkPanelEl.hidden = false;

  const width = 940, height = 600;
  
  const nodes = data.nodes.map(n => ({ ...n }));
  const links = data.edges.map(e => ({ ...e }));

  const svg = d3.select(supervisorNetworkChartEl)
    .attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  const maxDoc = d3.max(nodes, n => n.docCount) || 1;
  const supEdgeDeg = new Map();
  for (const link of links) {
    supEdgeDeg.set(link.source, (supEdgeDeg.get(link.source) || 0) + 1);
    supEdgeDeg.set(link.target, (supEdgeDeg.get(link.target) || 0) + 1);
  }

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-150))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => 10 + (d.docCount / maxDoc) * 14));

  const linkElements = svg.append('g')
    .selectAll('line')
    .data(links)
    .enter()
    .append('line')
    .attr('class', 'net-edge')
    .attr('stroke', 'hsl(190, 50%, 50%)')
    .attr('stroke-width', d => Math.max(1, Math.min(6, d.weight)))
    .attr('stroke-opacity', d => Math.min(0.6, 0.15 + d.weight * 0.1));

  const nodeGroups = svg.append('g')
    .selectAll('g')
    .data(nodes)
    .enter()
    .append('g')
    .style('cursor', 'pointer')
    .call(drag(simulation));

  nodeGroups.append('circle')
    .attr('class', 'net-node')
    .attr('r', d => 5 + (d.docCount / maxDoc) * 14)
    .attr('fill', 'hsl(190, 60%, 48%)')
    .attr('fill-opacity', 0.75)
    .attr('stroke', 'hsl(190, 60%, 38%)')
    .attr('stroke-width', 1);

  nodeGroups.append('text')
    .attr('class', 'net-label')
    .attr('text-anchor', 'middle')
    .attr('y', d => 5 + (d.docCount / maxDoc) * 14 + 14)
    .text(d => {
      const degree = supEdgeDeg.get(d.id) || 0;
      const showLabel = degree >= 2 || d.docCount >= 3;
      return showLabel ? (d.id.length > 18 ? d.id.slice(0, 16) + '\u2026' : d.id) : '';
    });

  simulation.on('tick', () => {
    linkElements
      .attr('x1', d => Math.max(20, Math.min(width - 20, d.source.x)))
      .attr('y1', d => Math.max(20, Math.min(height - 20, d.source.y)))
      .attr('x2', d => Math.max(20, Math.min(width - 20, d.target.x)))
      .attr('y2', d => Math.max(20, Math.min(height - 20, d.target.y)));

    nodeGroups
      .attr('transform', d => {
        d.x = Math.max(20, Math.min(width - 20, d.x));
        d.y = Math.max(20, Math.min(height - 20, d.y));
        return `translate(${d.x},${d.y})`;
      });
  });

  const tooltip = d3.select(supervisorNetworkTooltipEl);

  nodeGroups.on('mouseover', function(event, d) {
    const connected = links.filter(e => e.source.id === d.id || e.target.id === d.id)
      .map(e => e.source.id === d.id ? e.target.id : e.source.id).slice(0, 5);
    
    tooltip.html(`<div class="tooltip-title">${escapeHtml(d.id)}</div>
       <div class="tooltip-meta">${d.docCount} dissertation(s)${connected.length ? '<br>Connected: ' + connected.map(c => escapeHtml(c)).join(', ') : ''}</div>`)
      .style('display', 'block');

    const rect = supervisorNetworkContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 14) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');

    d3.select(this).select('circle')
      .transition()
      .duration(100)
      .attr('fill-opacity', 1)
      .attr('r', 5 + (d.docCount / maxDoc) * 14 + 3);
  })
  .on('mousemove', function(event) {
    const rect = supervisorNetworkContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 14) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');
  })
  .on('mouseout', function() {
    tooltip.style('display', 'none');
    d3.select(this).select('circle')
      .transition()
      .duration(100)
      .attr('fill-opacity', 0.75)
      .attr('r', d => 5 + (d.docCount / maxDoc) * 14);
  })
  .on('click', function(event, d) {
    topicVisualIntegrations.openSupervisorProfile(d.id);
  });
}

function renderCitationNetwork() {
  const data = getAnalytics()?.citationCooccurrence;
  if (!data?.nodes?.length || !citationNetworkChartEl) {
    if (citationNetworkPanelEl) citationNetworkPanelEl.hidden = true;
    return;
  }
  citationNetworkPanelEl.hidden = false;

  const width = 940, height = 600;
  const nodes = data.nodes.map(n => ({ ...n }));
  const links = data.edges.map(e => ({ ...e }));

  const svg = d3.select(citationNetworkChartEl)
    .attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  const maxFreq = d3.max(nodes, n => n.freq) || 1;
  const edgeCount = new Map();
  for (const link of links) {
    edgeCount.set(link.source, (edgeCount.get(link.source) || 0) + 1);
    edgeCount.set(link.target, (edgeCount.get(link.target) || 0) + 1);
  }

  function citationShortLabel(text) {
    const m = text.match(/^([^,(]+?)[\s,].*?\b((?:19|20)\d{2})\b/);
    if (m) return `${m[1].trim()} (${m[2]})`;
    const surname = text.match(/^([A-Z][a-z]+)/);
    return surname ? surname[1] : text.slice(0, 15);
  }

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-150))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => 10 + (d.freq / maxFreq) * 14));

  const linkElements = svg.append('g')
    .selectAll('line')
    .data(links)
    .enter()
    .append('line')
    .attr('class', 'net-edge')
    .attr('stroke', 'hsl(30, 70%, 55%)')
    .attr('stroke-width', d => Math.max(1, Math.min(6, d.weight)))
    .attr('stroke-opacity', d => Math.min(0.6, 0.15 + d.weight * 0.1));

  const nodeGroups = svg.append('g')
    .selectAll('g')
    .data(nodes)
    .enter()
    .append('g')
    .style('cursor', 'pointer')
    .call(drag(simulation));

  nodeGroups.append('circle')
    .attr('class', 'net-node')
    .attr('r', d => 5 + (d.freq / maxFreq) * 14)
    .attr('fill', 'hsl(30, 65%, 55%)')
    .attr('fill-opacity', 0.75)
    .attr('stroke', 'hsl(30, 65%, 42%)')
    .attr('stroke-width', 1);

  nodeGroups.append('text')
    .attr('class', 'net-label')
    .attr('text-anchor', 'middle')
    .attr('y', d => 5 + (d.freq / maxFreq) * 14 + 14)
    .text(d => {
      const degree = edgeCount.get(d.id) || 0;
      const showLabel = degree >= 3 || d.freq >= 3;
      return showLabel ? citationShortLabel(d.label) : '';
    });

  simulation.on('tick', () => {
    linkElements
      .attr('x1', d => Math.max(20, Math.min(width - 20, d.source.x)))
      .attr('y1', d => Math.max(20, Math.min(height - 20, d.source.y)))
      .attr('x2', d => Math.max(20, Math.min(width - 20, d.target.x)))
      .attr('y2', d => Math.max(20, Math.min(height - 20, d.target.y)));

    nodeGroups
      .attr('transform', d => {
        d.x = Math.max(20, Math.min(width - 20, d.x));
        d.y = Math.max(20, Math.min(height - 20, d.y));
        return `translate(${d.x},${d.y})`;
      });
  });

  const tooltip = d3.select(citationNetworkTooltipEl);

  nodeGroups.on('mouseover', function(event, d) {
    tooltip.html(`<div class="tooltip-title">${escapeHtml(d.label)}</div>
       <div class="tooltip-meta">Cited in ${d.freq} dissertation(s)</div>`)
      .style('display', 'block');

    const rect = citationNetworkContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 14) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');

    d3.select(this).select('circle')
      .transition()
      .duration(100)
      .attr('fill-opacity', 1)
      .attr('r', 5 + (d.freq / maxFreq) * 14 + 3);
  })
  .on('mousemove', function(event) {
    const rect = citationNetworkContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 14) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');
  })
  .on('mouseout', function(event, d) {
    tooltip.style('display', 'none');
    d3.select(this).select('circle')
      .transition()
      .duration(100)
      .attr('fill-opacity', 0.75)
      .attr('r', 5 + (d.freq / maxFreq) * 14);
  })
  .on('click', function(event, d) {
    const docs = state.payload?.documents || [];
    openMatchesModal(`Citation: ${d.label.slice(0, 60)}`, docs);
  });
}

function renderConceptNetwork() {
  const cooc = getAnalytics()?.termCooccurrence;
  if (!cooc?.length || !conceptNetworkChartEl) {
    if (conceptNetworkPanelEl) conceptNetworkPanelEl.hidden = true;
    return;
  }
  conceptNetworkPanelEl.hidden = false;

  const nodeFreqs = new Map();
  for (const pair of cooc) {
    if (!nodeFreqs.has(pair.termA)) nodeFreqs.set(pair.termA, pair.freqA || pair.count);
    if (!nodeFreqs.has(pair.termB)) nodeFreqs.set(pair.termB, pair.freqB || pair.count);
  }

  const width = 940, height = 600;
  const nodes = Array.from(nodeFreqs.entries()).map(([id, freq]) => ({ id, freq }));
  const links = cooc.map(p => ({ source: p.termA, target: p.termB, weight: p.lift || p.count }));

  const svg = d3.select(conceptNetworkChartEl)
    .attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  const maxFreq = d3.max(nodes, n => n.freq) || 1;
  const maxLift = d3.max(links, e => e.weight) || 1;
  const conceptEdgeDeg = new Map();
  for (const link of links) {
    conceptEdgeDeg.set(link.source, (conceptEdgeDeg.get(link.source) || 0) + 1);
    conceptEdgeDeg.set(link.target, (conceptEdgeDeg.get(link.target) || 0) + 1);
  }

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-150))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => 10 + (d.freq / maxFreq) * 14));

  const linkElements = svg.append('g')
    .selectAll('line')
    .data(links)
    .enter()
    .append('line')
    .attr('class', 'net-edge')
    .attr('stroke', 'hsl(160, 45%, 45%)')
    .attr('stroke-width', d => Math.max(1, Math.min(5, (d.weight / maxLift) * 5)))
    .attr('stroke-opacity', d => Math.min(0.6, 0.1 + (d.weight / maxLift) * 0.5));

  const nodeGroups = svg.append('g')
    .selectAll('g')
    .data(nodes)
    .enter()
    .append('g')
    .style('cursor', 'pointer')
    .call(drag(simulation));

  nodeGroups.append('circle')
    .attr('class', 'net-node')
    .attr('r', d => 5 + (d.freq / maxFreq) * 14)
    .attr('fill', 'hsl(160, 55%, 45%)')
    .attr('fill-opacity', 0.7)
    .attr('stroke', 'hsl(160, 55%, 35%)')
    .attr('stroke-width', 1);

  nodeGroups.append('text')
    .attr('class', 'net-label')
    .attr('text-anchor', 'middle')
    .attr('y', d => 5 + (d.freq / maxFreq) * 14 + 14)
    .text(d => {
      const degree = conceptEdgeDeg.get(d.id) || 0;
      const showLabel = degree >= 2 || d.freq >= 6;
      return showLabel ? (d.id.length > 20 ? d.id.slice(0, 18) + '\u2026' : d.id) : '';
    });

  simulation.on('tick', () => {
    linkElements
      .attr('x1', d => Math.max(20, Math.min(width - 20, d.source.x)))
      .attr('y1', d => Math.max(20, Math.min(height - 20, d.source.y)))
      .attr('x2', d => Math.max(20, Math.min(width - 20, d.target.x)))
      .attr('y2', d => Math.max(20, Math.min(height - 20, d.target.y)));

    nodeGroups
      .attr('transform', d => {
        d.x = Math.max(20, Math.min(width - 20, d.x));
        d.y = Math.max(20, Math.min(height - 20, d.y));
        return `translate(${d.x},${d.y})`;
      });
  });

  const tooltip = d3.select(conceptNetworkTooltipEl);

  nodeGroups.on('mouseover', function(event, d) {
    tooltip.html(`<div class="tooltip-title">${escapeHtml(d.id)}</div>
       <div class="tooltip-meta">${d.freq} document(s)</div>`)
      .style('display', 'block');

    const rect = conceptNetworkContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 14) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');

    d3.select(this).select('circle')
      .transition()
      .duration(100)
      .attr('fill-opacity', 1)
      .attr('r', 5 + (d.freq / maxFreq) * 14 + 3);
  })
  .on('mousemove', function(event) {
    const rect = conceptNetworkContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 14) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');
  })
  .on('mouseout', function(event, d) {
    tooltip.style('display', 'none');
    d3.select(this).select('circle')
      .transition()
      .duration(100)
      .attr('fill-opacity', 0.7)
      .attr('r', 5 + (d.freq / maxFreq) * 14);
  })
  .on('click', function(event, d) {
    const docs = state.payload?.documents || [];
    const matches = docs.filter(doc => (doc.conceptTerms || []).some(t => t.toLowerCase() === d.id.toLowerCase()));
    openMatchesModal(`Concept: ${d.id}`, matches);
  });
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

  const allYears = new Set();
  for (const t of byYear) {
    for (const d of t.data) allYears.add(d.year);
  }
  const sortedYears = Array.from(allYears).sort((a, b) => a - b);
  if (sortedYears.length < 2) { topicSankeyPanelEl.hidden = true; return; }

  const minYear = sortedYears[0];
  const maxYear = sortedYears[sortedYears.length - 1];
  const binSize = 5;
  const periods = [];
  for (let y = minYear; y <= maxYear; y += binSize) {
    const end = Math.min(y + binSize - 1, maxYear);
    periods.push({ start: y, end, label: `${y}\u2013${end}` });
  }

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

  const hueStep = 360 / Math.max(topicPeriods.length, 1);
  const colorForIdx = i => `hsl(${Math.round(i * hueStep)}, 60%, 50%)`;

  const periodTotals = periods.map((_, pi) => topicPeriods.reduce((s, t) => s + t.counts[pi], 0));
  const maxTotal = Math.max(...periodTotals, 1);
  const availH = height - pad.t - pad.b;

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

  const bands = [];
  for (let pi = 0; pi < periods.length - 1; pi++) {
    const x1 = pad.l + pi * colWidth;
    const x2 = pad.l + (pi + 1) * colWidth;
    for (let ti = 0; ti < topicPeriods.length; ti++) {
      const s = stacks[pi][ti];
      const e = stacks[pi + 1][ti];
      if (s.h < 0.5 && e.h < 0.5) continue;
      bands.push({
        x1,
        x2,
        s,
        e,
        topicIdx: ti,
        label: topicPeriods[ti].label,
        countStart: topicPeriods[ti].counts[pi],
        countEnd: topicPeriods[ti].counts[pi + 1]
      });
    }
  }

  const svg = d3.select(topicSankeyChartEl)
    .attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  const paths = svg.append('g')
    .selectAll('path')
    .data(bands)
    .enter()
    .append('path')
    .attr('d', d => `
      M ${d.x1} ${d.s.y}
      C ${(d.x1 + d.x2) / 2} ${d.s.y}, ${(d.x1 + d.x2) / 2} ${d.e.y}, ${d.x2} ${d.e.y}
      L ${d.x2} ${d.e.y + d.e.h}
      C ${(d.x1 + d.x2) / 2} ${d.e.y + d.e.h}, ${(d.x1 + d.x2) / 2} ${d.s.y + d.s.h}, ${d.x1} ${d.s.y + d.s.h}
      Z
    `)
    .attr('fill', d => colorForIdx(d.topicIdx))
    .attr('fill-opacity', 0.55)
    .attr('stroke', d => colorForIdx(d.topicIdx))
    .attr('stroke-opacity', 0.3)
    .attr('stroke-width', 0.5)
    .style('cursor', 'pointer');

  paths.on('mouseover', function() {
    d3.select(this)
      .transition()
      .duration(100)
      .attr('fill-opacity', 0.85);
  })
  .on('mouseout', function() {
    d3.select(this)
      .transition()
      .duration(100)
      .attr('fill-opacity', 0.55);
  });

  svg.append('g')
    .selectAll('text')
    .data(periods)
    .enter()
    .append('text')
    .attr('class', 'axis')
    .attr('x', (_, pi) => pad.l + pi * colWidth)
    .attr('y', height - 10)
    .attr('text-anchor', 'middle')
    .text(d => d.label);

  const legendContainer = d3.select(topicSankeyLegendEl);
  legendContainer.selectAll('*').remove();
  
  legendContainer.selectAll('.scatter-legend-item')
    .data(topicPeriods)
    .enter()
    .append('span')
    .attr('class', 'scatter-legend-item')
    .html((t, i) => `
      <span class="scatter-legend-swatch" style="background:${colorForIdx(i)}"></span>
      ${escapeHtml(topicDisplayLabel(t.label))}
    `);
}

function renderMethTopicBubble() {
  const data = getAnalytics()?.methodologyTopicMatrix;
  if (!data?.methodologies?.length || !data?.topics?.length || !methTopicBubbleChartEl) {
    if (methTopicBubblePanelEl) methTopicBubblePanelEl.hidden = true;
    return;
  }
  methTopicBubblePanelEl.hidden = false;

  const meths = data.methodologies;
  const topics = data.topics;
  const matrix = data.matrix;

  const width = 940, height = 540;
  const pad = { t: 30, r: 30, b: 130, l: 130 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  const colW = plotW / Math.max(topics.length, 1);
  const rowH = plotH / Math.max(meths.length, 1);

  let maxVal = 0;
  for (const row of matrix) {
    for (const v of row) {
      if (v > maxVal) maxVal = v;
    }
  }
  const maxR = Math.min(colW, rowH) / 2.5;
  const hueStep = 360 / Math.max(topics.length, 1);

  const bubblesData = [];
  for (let mi = 0; mi < meths.length; mi++) {
    for (let ti = 0; ti < topics.length; ti++) {
      const val = matrix[mi][ti];
      if (val > 0) {
        bubblesData.push({
          mi,
          ti,
          val,
          meth: meths[mi],
          topic: topics[ti]
        });
      }
    }
  }

  const svg = d3.select(methTopicBubbleChartEl)
    .attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  svg.append('g')
    .selectAll('text')
    .data(meths)
    .enter()
    .append('text')
    .attr('class', 'axis')
    .attr('x', pad.l - 8)
    .attr('y', (_, mi) => pad.t + mi * rowH + rowH / 2 + 3)
    .attr('text-anchor', 'end')
    .text(d => d);

  const xLabels = svg.append('g')
    .selectAll('text')
    .data(topics)
    .enter()
    .append('text')
    .attr('class', 'axis')
    .attr('x', (_, ti) => pad.l + ti * colW + colW / 2)
    .attr('y', height - pad.b + 14)
    .attr('text-anchor', 'end')
    .attr('transform', (_, ti) => {
      const x = pad.l + ti * colW + colW / 2;
      return `rotate(-45, ${x}, ${height - pad.b + 14})`;
    });

  xLabels.each(function(d) {
    const el = d3.select(this);
    const label = topicDisplayLabel(d.label);
    const lines = wrapLabel(label, 14);
    el.selectAll('tspan')
      .data(lines)
      .enter()
      .append('tspan')
      .attr('x', el.attr('x'))
      .attr('dy', (_, li) => li === 0 ? 0 : '1.1em')
      .text(l => l);
    el.append('title').text(label);
  });

  const bubbleGroups = svg.append('g')
    .selectAll('circle')
    .data(bubblesData)
    .enter()
    .append('circle')
    .attr('class', 'net-node')
    .attr('cx', d => pad.l + d.ti * colW + colW / 2)
    .attr('cy', d => pad.t + d.mi * rowH + rowH / 2)
    .attr('r', d => Math.max(3, Math.sqrt(d.val / Math.max(maxVal, 1)) * maxR))
    .attr('fill', d => `hsl(${Math.round(d.ti * hueStep)}, 55%, 52%)`)
    .attr('fill-opacity', 0.65)
    .attr('stroke', d => `hsl(${Math.round(d.ti * hueStep)}, 55%, 40%)`)
    .attr('stroke-width', 1)
    .style('cursor', 'pointer');

  const tooltip = d3.select(methTopicBubbleTooltipEl);

  bubbleGroups.on('mouseover', function(event, d) {
    tooltip.html(`<div class="tooltip-title">${escapeHtml(d.meth)}</div>
       <div class="tooltip-meta">${escapeHtml(topicDisplayLabel(d.topic?.label || ''))} \u00B7 ${d.val} dissertation(s)</div>`)
      .style('display', 'block');

    const rect = methTopicBubbleContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 14) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');

    d3.select(this)
      .transition()
      .duration(100)
      .attr('fill-opacity', 0.95)
      .attr('r', Math.max(3, Math.sqrt(d.val / Math.max(maxVal, 1)) * maxR) + 3);
  })
  .on('mousemove', function(event) {
    const rect = methTopicBubbleContainerEl.getBoundingClientRect();
    tooltip.style('left', (event.clientX - rect.left + 14) + 'px')
      .style('top', (event.clientY - rect.top - 10) + 'px');
  })
  .on('mouseout', function(event, d) {
    tooltip.style('display', 'none');
    d3.select(this)
      .transition()
      .duration(100)
      .attr('fill-opacity', 0.65)
      .attr('r', Math.max(3, Math.sqrt(d.val / Math.max(maxVal, 1)) * maxR));
  })
  .on('click', function(event, d) {
    const docs = state.payload?.documents || [];
    const matches = docs.filter(doc =>
      (doc.methodologies || []).includes(d.meth) && doc.topicId === d.topic.topicId
    );
    openMatchesModal(`${d.meth} + ${topicDisplayLabel(d.topic?.label || '')}`, matches);
  });
}

export {
  configureTopicVisuals,
  initTopicVisuals,
  loadAndRenderVisualizations,
  renderCitationNetwork,
  renderConceptNetwork,
  renderMethTopicBubble,
  renderSupervisorNetwork,
  renderTopicCluster,
  renderTopicDendrogram,
  renderTopicSankey,
  renderVisualizations,
};

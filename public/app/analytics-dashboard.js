import {
  dom,
  ensureChartLibrary,
  escapeHtml,
  formatNum,
  heatmapHeaderCell,
  state,
} from './core.js';
import {
  getAnalytics,
  loadAnalytics,
} from './data.js';
import {
  docsForCooccurrence,
  docsForConceptTerm,
  docsForMethodology,
  docsForSupervisorConcept,
  docsForTheme,
  docsForTopic,
  getFilteredDocs,
  openMatchesModal,
  openRecord,
} from './documents.js';

const {
  analyticsTabButtons,
  cooccurrenceBarsEl,
  conceptTimelineChartEl,
  conceptTimelineLegendEl,
  dissertationsByYearChartEl,
  kpisEl,
  methodologyBarsEl,
  methodologyConceptHeatmapEl,
  ngramCloudEl,
  pageTrendChartEl,
  pagesByYearChartEl,
  subjectBarsEl,
  supervisorHeatmapEl,
  supervisorTopicHeatmapEl,
  supervisorTopicPanelEl,
  themeResultsEl,
  topicBarsEl,
  topicDistPanelEl,
  topicModelMetaEl,
  topicTimelineChartEl,
  topicTimelineLegendEl,
  topicTimelinePanelEl,
  wordCloudEl,
  wordsByYearChartEl,
} = dom;

let analyticsInitialized = false;
const analyticsIntegrations = {
  ensureTopicVisuals: async () => null,
  openSupervisorProfile: async () => {},
};

function configureAnalyticsDashboard(integrations = {}) {
  Object.assign(analyticsIntegrations, integrations);
}

function initAnalyticsDashboard() {
  if (analyticsInitialized) return;
  analyticsInitialized = true;

  for (const btn of analyticsTabButtons) {
    btn.addEventListener('click', () => setActiveAnalyticsTab(btn.dataset.analyticsTab));
  }
}

async function setActiveAnalyticsTab(tabName) {
  for (const btn of analyticsTabButtons) {
    btn.classList.toggle('active', btn.dataset.analyticsTab === tabName);
  }
  for (const section of document.querySelectorAll('.analytics-tab-section')) {
    section.classList.toggle('active', section.id === `analytics-${tabName}`);
  }
  if (tabName === 'visualizations' && state.payload) {
    const visuals = await analyticsIntegrations.ensureTopicVisuals();
    visuals?.renderVisualizations?.();
    return;
  }
  renderAnalytics();
}

async function loadAndRenderAnalytics() {
  await loadAnalytics();
  await ensureChartLibrary();
  renderAnalytics();
}

function renderAnalytics() {
  renderKpis();
  renderPagesByYear();
  renderDissertationsByYear();
  renderWordsByYear();
  renderWordCloud();
  renderSubjectBars();
  renderPageTrend();
  renderNgramCloud();
  renderMethodologies();
  renderCooccurrence();
  renderSupervisorHeatmap();
  renderConceptTimeline();
  renderTopicDistribution();
  renderTopicTimeline();
  renderSupervisorTopicHeatmap();
  renderMethodologyConceptMatrix();
}


// --- Analytics rendering ---

function renderKpis() {
  const metrics = getAnalytics()?.metrics;
  if (!metrics) {
    kpisEl.innerHTML = '';
    return;
  }

  // Compute citation stats from documents with reliably parsed citations.
  // Counts below 20 on a full-text PDF almost always indicate the bibliography
  // section wasn't detected (stray references only) — exclude them from stats.
  const docs = getFilteredDocs();
  const citeCounts = docs.map((d) => d.citationCount || 0).filter((c) => c >= 20);
  const citeMin = citeCounts.length ? Math.min(...citeCounts) : null;
  const citeMax = citeCounts.length ? Math.max(...citeCounts) : null;
  const citeMean = citeCounts.length
    ? citeCounts.reduce((a, b) => a + b, 0) / citeCounts.length
    : null;

  const cards = [
    { label: 'Dissertations', value: formatNum(metrics.recordCount) },
    {
      label: 'Pages',
      value: `${formatNum(metrics.overallPageCount.min)}\u2013${formatNum(metrics.overallPageCount.max)}`,
      range: `mean ${formatNum(metrics.overallPageCount.mean)}`
    },
    {
      label: 'Words',
      value: `${formatNum(metrics.overallWordCount.min)}\u2013${formatNum(metrics.overallWordCount.max)}`,
      range: `mean ${formatNum(metrics.overallWordCount.mean)}`
    }
  ];

  if (citeMin != null) {
    cards.push({
      label: 'Works Cited',
      value: `${formatNum(citeMin)}\u2013${formatNum(citeMax)}`,
      range: `mean ${formatNum(citeMean)}`
    });
  }

  kpisEl.innerHTML = cards
    .map(
      (card) => `
      <article class="kpi">
        <p>${card.label}</p>
        <strong>${card.value}</strong>
        ${card.range ? `<span class="kpi-range">${card.range}</span>` : ''}
      </article>
    `
    )
    .join('');
}

let pagesByYearChartInstance = null;

function renderPagesByYear() {
  const rows = getAnalytics()?.metrics?.avgPagesByYear || [];
  if (!rows.length) {
    pagesByYearChartEl.innerHTML = '<p class="meta">No year/page data available.</p>';
    return;
  }

  const canvas = pagesByYearChartEl.querySelector('canvas');
  if (!canvas) return;

  if (pagesByYearChartInstance) {
    pagesByYearChartInstance.destroy();
  }

  pagesByYearChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: rows.map((d) => d.year),
      datasets: [{
        label: 'Average Page Length',
        data: rows.map((d) => d.mean || 0),
        borderColor: '#085a63',
        backgroundColor: 'rgba(8, 90, 99, 0.08)',
        borderWidth: 2,
        tension: 0.15,
        fill: true,
        pointRadius: 3,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true }
      }
    }
  });
}

let dissertationsByYearChartInstance = null;

function renderDissertationsByYear() {
  const rows = getAnalytics()?.metrics?.byYear || [];
  if (!rows.length) {
    dissertationsByYearChartEl.innerHTML = '<p class="meta">No year data available.</p>';
    return;
  }

  const canvas = dissertationsByYearChartEl.querySelector('canvas');
  if (!canvas) return;

  if (dissertationsByYearChartInstance) {
    dissertationsByYearChartInstance.destroy();
  }

  dissertationsByYearChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((d) => d.year),
      datasets: [{
        label: 'Dissertations',
        data: rows.map((d) => d.count || 0),
        backgroundColor: '#1b808c',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true }
      }
    }
  });
}

let wordsByYearChartInstance = null;

function renderWordsByYear() {
  const rows = getAnalytics()?.metrics?.byYear || [];
  if (!rows.length) {
    wordsByYearChartEl.innerHTML = '<p class="meta">No year/word data available.</p>';
    return;
  }

  const canvas = wordsByYearChartEl.querySelector('canvas');
  if (!canvas) return;

  if (wordsByYearChartInstance) {
    wordsByYearChartInstance.destroy();
  }

  wordsByYearChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: rows.map((d) => d.year),
      datasets: [{
        label: 'Mean Word Count',
        data: rows.map((d) => d.mean || 0),
        borderColor: '#d07a34',
        backgroundColor: 'rgba(208, 122, 52, 0.08)',
        borderWidth: 2,
        tension: 0.15,
        fill: true,
        pointRadius: 3,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true }
      }
    }
  });
}

function renderWordCloud() {
  const words = getAnalytics()?.wordCloud || [];
  if (!words.length) {
    wordCloudEl.innerHTML = '<span>No theme terms available.</span>';
    themeResultsEl.innerHTML = '';
    return;
  }

  const max = Math.max(...words.map((w) => w.count), 1);
  wordCloudEl.innerHTML = words
    .map((word) => {
      const ratio = word.count / max;
      const size = 0.8 + ratio * 1.7;
      const hue = 190 - Math.round(ratio * 70);
      const active = state.selectedTheme && state.selectedTheme.toLowerCase() === word.term.toLowerCase();
      return `<button class="cloud-term${active ? ' active' : ''}" data-theme="${escapeHtml(word.term)}" style="font-size:${size}rem;color:hsl(${hue} 58% 28%)">${escapeHtml(word.term)}</button>`;
    })
    .join('');

  for (const node of wordCloudEl.querySelectorAll('.cloud-term[data-theme]')) {
    node.addEventListener('click', () => {
      state.selectedTheme = node.getAttribute('data-theme');
      renderWordCloud();
      openMatchesModal(`Theme: ${state.selectedTheme}`, docsForTheme(state.selectedTheme));
    });
  }

  themeResultsEl.innerHTML = '<p>Select a theme to view tagged dissertations.</p>';
}

function renderThemeResults() {
  if (!state.selectedTheme) {
    themeResultsEl.innerHTML = '<p>Select a theme to view tagged dissertations.</p>';
    return;
  }

  const matches = docsForTheme(state.selectedTheme);
  if (!matches.length) {
    themeResultsEl.innerHTML = `<p>No dissertations tagged with <strong>${escapeHtml(state.selectedTheme)}</strong>.</p>`;
    return;
  }

  themeResultsEl.innerHTML = `
    <p><strong>${escapeHtml(state.selectedTheme)}</strong> &middot; ${formatNum(matches.length)} dissertation(s)</p>
    <div class="related-list">
      ${matches
        .map(
          (doc) => `
          <div class="related-item" data-related-id="${escapeHtml(doc.id)}">
            <strong>${escapeHtml(doc.title || '(Untitled)')}</strong>
            <p>${escapeHtml(doc.author || 'Unknown')} &middot; ${doc.year || '-'} &middot; ${escapeHtml(doc.degree || '-')}</p>
          </div>
        `
        )
        .join('')}
    </div>
  `;

  for (const item of themeResultsEl.querySelectorAll('.related-item[data-related-id]')) {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-related-id');
      if (targetId) openRecord(targetId, 'records');
    });
  }
}

function renderSubjectBars() {
  const byConcept = getAnalytics()?.metrics?.byConcept || [];
  if (!byConcept.length) {
    subjectBarsEl.innerHTML = '<p style="color:var(--ink-soft);font-family:var(--sans);font-size:0.85rem">No concept length data available.</p>';
    return;
  }
  const maxMean = Math.max(...byConcept.map((s) => s.weightedMean || 0), 1);

  subjectBarsEl.innerHTML = byConcept
    .slice(0, 14)
    .map((entry) => {
      const widthPct = ((entry.weightedMean || 0) / maxMean) * 100;
      const label = `${entry.concept} (n=${formatNum(entry.docCount)})`;
      return `
        <div class="bar-row">
          <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
          <span class="bar-value">${formatNum(entry.weightedMean)}</span>
        </div>
      `;
    })
    .join('');
}

let pageTrendChartInstance = null;

function renderPageTrend() {
  const rows = getAnalytics()?.metrics?.pageTrend || [];
  if (!rows.length) {
    pageTrendChartEl.innerHTML = '<p class="meta">No page trend data available.</p>';
    return;
  }

  const canvas = pageTrendChartEl.querySelector('canvas');
  if (!canvas) return;

  if (pageTrendChartInstance) {
    pageTrendChartInstance.destroy();
  }

  pageTrendChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: rows.map((d) => d.year),
      datasets: [
        {
          label: 'Median Pages',
          data: rows.map((d) => d.median),
          borderColor: '#085a63',
          borderWidth: 3,
          tension: 0.15,
          fill: false,
          pointRadius: 3,
          pointHoverRadius: 5
        },
        {
          label: 'Max Pages',
          data: rows.map((d) => d.max),
          borderColor: 'transparent',
          backgroundColor: 'rgba(8, 90, 99, 0.08)',
          pointRadius: 0,
          fill: '+1', // fill down to Min Pages dataset at index 2
          tension: 0.15
        },
        {
          label: 'Min Pages',
          data: rows.map((d) => d.min),
          borderColor: 'transparent',
          backgroundColor: 'rgba(8, 90, 99, 0.08)',
          pointRadius: 0,
          fill: false,
          tension: 0.15
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            filter: (item) => item.text === 'Median Pages'
          }
        }
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true }
      }
    }
  });
}

function renderNgramCloud() {
  const words = getAnalytics()?.ngramCloud || [];
  if (!words.length) {
    ngramCloudEl.innerHTML = '<span>No n-gram data available.</span>';
    return;
  }

  const max = Math.max(...words.map((w) => w.count), 1);
  ngramCloudEl.innerHTML = words
    .map((word) => {
      const ratio = word.count / max;
      const size = 0.8 + ratio * 1.4;
      const hue = 20 + Math.round(ratio * 40);
      return `<button class="cloud-term" data-ngram-term="${escapeHtml(word.term)}" style="font-size:${size}rem;color:hsl(${hue} 68% 35%)">${escapeHtml(word.term)} <sup style="font-size:0.6em;opacity:0.6">${word.count}</sup></button>`;
    })
    .join('');

  for (const node of ngramCloudEl.querySelectorAll('.cloud-term[data-ngram-term]')) {
    node.addEventListener('click', () => {
      const term = node.getAttribute('data-ngram-term');
      openMatchesModal(`Concept: ${term}`, docsForConceptTerm(term));
    });
  }
}

function renderMethodologies() {
  const items = getAnalytics()?.methodologies || [];
  if (!items.length) {
    methodologyBarsEl.innerHTML = '<p style="color:var(--ink-soft);font-family:var(--sans);font-size:0.85rem">No methodology signals detected.</p>';
    return;
  }

  const maxCount = Math.max(...items.map((m) => m.count), 1);
  methodologyBarsEl.innerHTML = items
    .map((entry) => {
      const widthPct = (entry.count / maxCount) * 100;
      return `
        <div class="bar-row">
          <span class="bar-label" title="${escapeHtml(entry.methodology)}">${escapeHtml(entry.methodology)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
          <button class="bar-value" data-methodology="${escapeHtml(entry.methodology)}">${formatNum(entry.count)}</button>
        </div>
      `;
    })
    .join('');

  for (const node of methodologyBarsEl.querySelectorAll('[data-methodology]')) {
    node.addEventListener('click', () => {
      const methodology = node.getAttribute('data-methodology');
      openMatchesModal(`Methodology: ${methodology}`, docsForMethodology(methodology));
    });
  }
}

function renderCooccurrence() {
  const pairs = getAnalytics()?.termCooccurrence || [];
  if (!pairs.length) {
    cooccurrenceBarsEl.innerHTML = '<p style="color:var(--ink-soft);font-family:var(--sans);font-size:0.85rem">No co-occurring term pairs found.</p>';
    return;
  }

  const maxCount = Math.max(...pairs.map((p) => p.count), 1);
  cooccurrenceBarsEl.innerHTML = pairs
    .map((entry) => {
      const widthPct = (entry.count / maxCount) * 100;
      const label = `${entry.termA} + ${entry.termB}`;
      const liftStr = entry.lift != null ? ` · lift ${entry.lift}` : '';
      return `
        <div class="bar-row">
          <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
          <button class="bar-value" title="${entry.count} dissertations${escapeHtml(liftStr)}" data-co-term-a="${escapeHtml(entry.termA)}" data-co-term-b="${escapeHtml(entry.termB)}">${formatNum(entry.count)}</button>
        </div>
      `;
    })
    .join('');

  for (const node of cooccurrenceBarsEl.querySelectorAll('[data-co-term-a][data-co-term-b]')) {
    node.addEventListener('click', () => {
      const termA = node.getAttribute('data-co-term-a');
      const termB = node.getAttribute('data-co-term-b');
      openMatchesModal(`Co-occurrence: ${termA} + ${termB}`, docsForCooccurrence(termA, termB));
    });
  }
}

function renderSupervisorHeatmap() {
  const data = getAnalytics()?.supervisorNgramMatrix;
  if (!data || !data.supervisors.length || !data.ngrams.length) {
    supervisorHeatmapEl.innerHTML = '<p style="color:var(--ink-soft);font-family:var(--sans);font-size:0.85rem">No supervisor-term data available.</p>';
    return;
  }

  const maxVal = Math.max(...data.matrix.flat(), 1);

  const headerCells = data.ngrams
    .map((s) => heatmapHeaderCell(s))
    .join('');

  const bodyRows = data.supervisors
    .map((sup, si) => {
      const cells = data.ngrams
        .map((concept, nj) => {
          const val = data.matrix[si][nj];
          const lightness = val > 0 ? 95 - Math.round((val / maxVal) * 65) : 97;
          const textColor = lightness < 55 ? '#fff' : 'var(--ink)';
          const content = val > 0
            ? `<button class="heatmap-cell-btn" data-heatmap-sup="${escapeHtml(sup)}" data-heatmap-concept="${escapeHtml(concept)}" style="color:${textColor}">${val}</button>`
            : '';
          return `<td class="heatmap-cell" style="background:hsl(190 58% ${lightness}%);color:${textColor}">${content}</td>`;
        })
        .join('');
      return `<tr><td class="heatmap-label" title="${escapeHtml(sup)}"><button class="supervisor-link" data-supervisor-name="${escapeHtml(sup)}">${escapeHtml(sup)}</button></td>${cells}</tr>`;
    })
    .join('');

  supervisorHeatmapEl.innerHTML = `
    <table class="heatmap-table">
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;

  for (const node of supervisorHeatmapEl.querySelectorAll('[data-heatmap-sup][data-heatmap-concept]')) {
    node.addEventListener('click', () => {
      const sup = node.getAttribute('data-heatmap-sup');
      const concept = node.getAttribute('data-heatmap-concept');
      openMatchesModal(`Supervisor + Concept: ${sup} + ${concept}`, docsForSupervisorConcept(sup, concept));
    });
  }

  for (const btn of supervisorHeatmapEl.querySelectorAll('.supervisor-link[data-supervisor-name]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      analyticsIntegrations.openSupervisorProfile(btn.dataset.supervisorName);
    });
  }
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
  if (conceptTimelineChartInstance) conceptTimelineChartInstance.destroy();

  const allYears = new Set();
  for (const series of data) {
    for (const pt of series.data) allYears.add(pt.year);
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
    const yearMap = new Map(series.data.map(pt => [pt.year, pt.count]));
    return {
      label: `${series.concept} (${series.totalDocs})`,
      data: years.map(yr => yearMap.get(yr) || 0),
      borderColor: `hsl(${hue}, 65%, 45%)`,
      backgroundColor: `hsla(${hue}, 65%, 45%, 0.05)`,
      borderWidth: 2,
      tension: 0.15,
      pointRadius: 3,
      pointHoverRadius: 5
    };
  });

  conceptTimelineChartInstance = new Chart(canvas, {
    type: 'line',
    data: { labels: years, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: 'var(--fg)', boxWidth: 12, font: { size: 11 } }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: 'var(--fg)' } },
        y: { beginAtZero: true, ticks: { color: 'var(--fg)' } }
      }
    }
  });

  if (conceptTimelineLegendEl) conceptTimelineLegendEl.innerHTML = '';
}

function topicDisplayLabel(label) {
  const cleaned = String(label || '').replace(/^-?\d+_/, '').replace(/_/g, ' ');
  return cleaned || label;
}

function wrapLabel(text, maxChars) {
  const words = String(text || '').split(/\s+/);
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
  return lines.length ? lines : [String(text || '')];
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
  if (topicTimelineChartInstance) topicTimelineChartInstance.destroy();

  const allYears = new Set();
  for (const series of data) {
    for (const pt of series.data) allYears.add(pt.year);
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
    const yearMap = new Map(series.data.map(pt => [pt.year, pt.count]));
    return {
      label: topicDisplayLabel(series.label),
      data: years.map(yr => yearMap.get(yr) || 0),
      borderColor: `hsl(${hue}, 65%, 45%)`,
      backgroundColor: `hsla(${hue}, 65%, 45%, 0.05)`,
      borderWidth: 2,
      tension: 0.15,
      pointRadius: 3,
      pointHoverRadius: 5
    };
  });

  topicTimelineChartInstance = new Chart(canvas, {
    type: 'line',
    data: { labels: years, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: 'var(--fg)', boxWidth: 12, font: { size: 11 } }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: 'var(--fg)' } },
        y: { beginAtZero: true, ticks: { color: 'var(--fg)' } }
      }
    }
  });

  if (topicTimelineLegendEl) topicTimelineLegendEl.innerHTML = '';
}

function renderSupervisorTopicHeatmap() {
  const td = getAnalytics()?.topicData;
  if (!td || !td.topics || !td.topics.length) {
    if (supervisorTopicPanelEl) supervisorTopicPanelEl.hidden = true;
    return;
  }

  const docs = getFilteredDocs();
  // Build supervisor counts
  const supCounts = new Map();
  const supTopicCounts = new Map(); // sup -> Map<topicId, count>
  for (const doc of docs) {
    if (doc.topicId == null) continue;
    for (const sup of (doc.supervisors || [])) {
      supCounts.set(sup, (supCounts.get(sup) || 0) + 1);
      if (!supTopicCounts.has(sup)) supTopicCounts.set(sup, new Map());
      const tm = supTopicCounts.get(sup);
      tm.set(doc.topicId, (tm.get(doc.topicId) || 0) + 1);
  }
}

  const topSups = Array.from(supCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name]) => name);

  // Only include topics that appear with at least one of the top supervisors
  const supSet = new Set(topSups);
  const topicIdsWithSups = new Set();
  for (const doc of docs) {
    if (doc.topicId == null || doc.topicId === -1) continue;
    if ((doc.supervisors || []).some((s) => supSet.has(s))) {
      topicIdsWithSups.add(doc.topicId);
    }
  }
  const topTopics = td.topics
    .filter((t) => t.topicId !== -1 && topicIdsWithSups.has(t.topicId))
    .slice(0, 10);

  if (!topSups.length || !topTopics.length) {
    if (supervisorTopicPanelEl) supervisorTopicPanelEl.hidden = true;
    return;
  }

  supervisorTopicPanelEl.hidden = false;

  const matrix = topSups.map((sup) =>
    topTopics.map((topic) => (supTopicCounts.get(sup)?.get(topic.topicId) || 0))
  );
  const maxVal = Math.max(...matrix.flat(), 1);

  const headerCells = topTopics
    .map((t) => {
      const label = topicDisplayLabel(t.label);
      return heatmapHeaderCell(label);
    })
    .join('');

  const bodyRows = topSups
    .map((sup, si) => {
      const cells = topTopics
        .map((topic, tj) => {
          const val = matrix[si][tj];
          const lightness = val > 0 ? 95 - Math.round((val / maxVal) * 65) : 97;
          const textColor = lightness < 55 ? '#fff' : 'var(--ink)';
          const content = val > 0
            ? `<button class="heatmap-cell-btn" data-hm-sup="${escapeHtml(sup)}" data-hm-topic="${topic.topicId}" style="color:${textColor}">${val}</button>`
            : '';
          return `<td class="heatmap-cell" style="background:hsl(190 58% ${lightness}%);color:${textColor}">${content}</td>`;
        })
        .join('');
      return `<tr><td class="heatmap-label" title="${escapeHtml(sup)}"><button class="supervisor-link" data-supervisor-name="${escapeHtml(sup)}">${escapeHtml(sup)}</button></td>${cells}</tr>`;
    })
    .join('');

  supervisorTopicHeatmapEl.innerHTML = `
    <table class="heatmap-table">
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;

  for (const node of supervisorTopicHeatmapEl.querySelectorAll('[data-hm-sup][data-hm-topic]')) {
    node.addEventListener('click', () => {
      const sup = node.getAttribute('data-hm-sup');
      const topicId = Number(node.getAttribute('data-hm-topic'));
      const topic = td.topics.find((t) => t.topicId === topicId);
      const label = topicDisplayLabel(topic?.label || `Topic ${topicId}`);
      const matches = docs.filter((d) =>
        d.topicId === topicId && (d.supervisors || []).includes(sup)
      );
      openMatchesModal(`${sup} + ${label}`, matches);
    });
  }

  for (const btn of supervisorTopicHeatmapEl.querySelectorAll('.supervisor-link[data-supervisor-name]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      analyticsIntegrations.openSupervisorProfile(btn.dataset.supervisorName);
    });
  }


}

function docsForMethodologyConcept(methodology, concept) {
  const methNorm = String(methodology || '').toLowerCase();
  const conceptNorm = String(concept || '').toLowerCase();
  const docs = state.payload?.documents || [];
  return docs.filter((doc) => {
    const hasMeth = (doc.methodologies || []).some((m) => String(m || '').toLowerCase() === methNorm);
    if (!hasMeth) return false;
    const terms = new Set((doc.conceptTerms || []).map((t) => String(t || '').toLowerCase()));
    return terms.has(conceptNorm);
  });
}

function renderMethodologyConceptMatrix() {
  const data = getAnalytics()?.methodologyConceptMatrix;
  if (!data || !data.methodologies.length || !data.concepts.length) {
    if (methodologyConceptHeatmapEl) methodologyConceptHeatmapEl.innerHTML = '<p style="color:var(--ink-soft);font-family:var(--sans);font-size:0.85rem">No methodology-concept data available.</p>';
    return;
  }

  const maxVal = Math.max(...data.matrix.flat(), 1);
  const headerCells = data.concepts.map((c) => heatmapHeaderCell(c)).join('');
  const bodyRows = data.methodologies
    .map((meth, mi) => {
      const cells = data.concepts
        .map((concept, ci) => {
          const val = data.matrix[mi][ci];
          const lightness = val > 0 ? 95 - Math.round((val / maxVal) * 65) : 97;
          const textColor = lightness < 55 ? '#fff' : 'var(--ink)';
          const content = val > 0
            ? `<button class="heatmap-cell-btn" data-mc-meth="${escapeHtml(meth)}" data-mc-concept="${escapeHtml(concept)}" style="color:${textColor}">${val}</button>`
            : '';
          return `<td class="heatmap-cell" style="background:hsl(30 58% ${lightness}%);color:${textColor}">${content}</td>`;
        })
        .join('');
      return `<tr><td class="heatmap-label" title="${escapeHtml(meth)}">${escapeHtml(meth)}</td>${cells}</tr>`;
    })
    .join('');

  methodologyConceptHeatmapEl.innerHTML = `
    <table class="heatmap-table">
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;

  for (const node of methodologyConceptHeatmapEl.querySelectorAll('[data-mc-meth][data-mc-concept]')) {
    node.addEventListener('click', () => {
      const meth = node.getAttribute('data-mc-meth');
      const concept = node.getAttribute('data-mc-concept');
      openMatchesModal(`${meth} + ${concept}`, docsForMethodologyConcept(meth, concept));
    });
  }
}

export {
  configureAnalyticsDashboard,
  initAnalyticsDashboard,
  loadAndRenderAnalytics,
  renderAnalytics,
  renderCooccurrence,
  renderConceptTimeline,
  renderDissertationsByYear,
  renderKpis,
  renderMethodologies,
  renderMethodologyConceptMatrix,
  renderNgramCloud,
  renderPageTrend,
  renderPagesByYear,
  renderSubjectBars,
  renderSupervisorHeatmap,
  renderSupervisorTopicHeatmap,
  renderThemeResults,
  renderTopicDistribution,
  renderTopicTimeline,
  renderWordCloud,
  renderWordsByYear,
  setActiveAnalyticsTab,
  topicDisplayLabel,
  wrapLabel,
};


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

function renderPagesByYear() {
  const rows = getAnalytics()?.metrics?.avgPagesByYear || [];
  if (!rows.length) {
    pagesByYearChartEl.innerHTML = '<text x="16" y="40">No year/page data available.</text>';
    return;
  }

  const width = 940;
  const height = 360;
  const pad = { t: 20, r: 20, b: 40, l: 58 };
  const xs = rows.map((d) => d.year);
  const ys = rows.map((d) => d.mean || 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys, 1);

  const x = (v) => pad.l + ((v - minX) / Math.max(maxX - minX, 1)) * (width - pad.l - pad.r);
  const y = (v) => height - pad.b - (v / maxY) * (height - pad.t - pad.b);

  const points = rows.map((d) => `${x(d.year)},${y(d.mean || 0)}`).join(' ');

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const val = (maxY / 5) * i;
    return { val, y: y(val) };
  });

  pagesByYearChartEl.innerHTML = `
    ${yTicks
      .map(
        (tick) => `
      <line x1="${pad.l}" y1="${tick.y}" x2="${width - pad.r}" y2="${tick.y}" stroke="rgba(8,90,99,0.12)"/>
      <text class="axis" x="${pad.l - 8}" y="${tick.y + 4}" text-anchor="end">${formatNum(tick.val)}</text>
    `
      )
      .join('')}
    <polyline points="${points}" fill="none" stroke="#085a63" stroke-width="3" />
    ${rows
      .filter((_, i) => i % Math.ceil(rows.length / 12) === 0)
      .map((row) => `<text class="axis" x="${x(row.year)}" y="${height - 10}" text-anchor="middle">${row.year}</text>`)
      .join('')}
  `;
}

function renderDissertationsByYear() {
  const rows = getAnalytics()?.metrics?.byYear || [];
  if (!rows.length) {
    dissertationsByYearChartEl.innerHTML = '<text x="16" y="40">No year data available.</text>';
    return;
  }

  const width = 940;
  const height = 360;
  const pad = { t: 20, r: 20, b: 40, l: 58 };
  const xs = rows.map((d) => d.year);
  const ys = rows.map((d) => d.count || 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys, 1);
  const barWidth = Math.max(4, ((width - pad.l - pad.r) / Math.max(rows.length, 1)) * 0.7);
  const barGap = (width - pad.l - pad.r) / Math.max(rows.length, 1);

  const x = (i) => pad.l + i * barGap + (barGap - barWidth) / 2;
  const y = (v) => height - pad.b - (v / maxY) * (height - pad.t - pad.b);

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const val = (maxY / 5) * i;
    return { val, y: y(val) };
  });

  dissertationsByYearChartEl.innerHTML = `
    ${yTicks
      .map(
        (tick) => `
      <line x1="${pad.l}" y1="${tick.y}" x2="${width - pad.r}" y2="${tick.y}" stroke="rgba(8,90,99,0.12)"/>
      <text class="axis" x="${pad.l - 8}" y="${tick.y + 4}" text-anchor="end">${formatNum(tick.val)}</text>
    `
      )
      .join('')}
    ${rows
      .map(
        (row, i) => `<rect x="${x(i)}" y="${y(row.count)}" width="${barWidth}" height="${height - pad.b - y(row.count)}" fill="var(--accent-2)" rx="2" />`
      )
      .join('')}
    ${rows
      .filter((_, i) => i % Math.ceil(rows.length / 12) === 0)
      .map((row, _, arr) => {
        const idx = rows.indexOf(row);
        return `<text class="axis" x="${x(idx) + barWidth / 2}" y="${height - 10}" text-anchor="middle">${row.year}</text>`;
      })
      .join('')}
  `;
}

function renderWordsByYear() {
  const rows = getAnalytics()?.metrics?.byYear || [];
  if (!rows.length) {
    wordsByYearChartEl.innerHTML = '<text x="16" y="40">No year/word data available.</text>';
    return;
  }

  const width = 940;
  const height = 360;
  const pad = { t: 20, r: 20, b: 40, l: 58 };
  const xs = rows.map((d) => d.year);
  const ys = rows.map((d) => d.mean || 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys, 1);

  const x = (v) => pad.l + ((v - minX) / Math.max(maxX - minX, 1)) * (width - pad.l - pad.r);
  const y = (v) => height - pad.b - (v / maxY) * (height - pad.t - pad.b);

  const points = rows.map((d) => `${x(d.year)},${y(d.mean || 0)}`).join(' ');

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const val = (maxY / 5) * i;
    return { val, y: y(val) };
  });

  wordsByYearChartEl.innerHTML = `
    ${yTicks
      .map(
        (tick) => `
      <line x1="${pad.l}" y1="${tick.y}" x2="${width - pad.r}" y2="${tick.y}" stroke="rgba(8,90,99,0.12)"/>
      <text class="axis" x="${pad.l - 8}" y="${tick.y + 4}" text-anchor="end">${formatNum(tick.val)}</text>
    `
      )
      .join('')}
    <polyline points="${points}" fill="none" stroke="var(--accent-3)" stroke-width="3" />
    ${rows
      .filter((_, i) => i % Math.ceil(rows.length / 12) === 0)
      .map((row) => `<text class="axis" x="${x(row.year)}" y="${height - 10}" text-anchor="middle">${row.year}</text>`)
      .join('')}
  `;
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

function renderPageTrend() {
  const rows = getAnalytics()?.metrics?.pageTrend || [];
  if (!rows.length) {
    pageTrendChartEl.innerHTML = '<text x="16" y="40">No page trend data available.</text>';
    return;
  }

  const width = 940;
  const height = 360;
  const pad = { t: 20, r: 20, b: 40, l: 58 };
  const xs = rows.map((d) => d.year);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...rows.map((d) => d.max), 1);

  const x = (v) => pad.l + ((v - minX) / Math.max(maxX - minX, 1)) * (width - pad.l - pad.r);
  const y = (v) => height - pad.b - (v / maxY) * (height - pad.t - pad.b);

  // Min/max band polygon: go forward along max, then backward along min
  const bandTop = rows.map((d) => `${x(d.year)},${y(d.max)}`).join(' ');
  const bandBot = [...rows].reverse().map((d) => `${x(d.year)},${y(d.min)}`).join(' ');
  const bandPoints = `${bandTop} ${bandBot}`;

  const medianPoints = rows.map((d) => `${x(d.year)},${y(d.median)}`).join(' ');

  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const val = (maxY / 5) * i;
    return { val, y: y(val) };
  });

  pageTrendChartEl.innerHTML = `
    ${yTicks
      .map(
        (tick) => `
      <line x1="${pad.l}" y1="${tick.y}" x2="${width - pad.r}" y2="${tick.y}" stroke="rgba(8,90,99,0.12)"/>
      <text class="axis" x="${pad.l - 8}" y="${tick.y + 4}" text-anchor="end">${formatNum(tick.val)}</text>
    `
      )
      .join('')}
    <polygon points="${bandPoints}" fill="rgba(8,90,99,0.12)" />
    <polyline points="${medianPoints}" fill="none" stroke="#085a63" stroke-width="3" />
    ${rows
      .filter((_, i) => i % Math.ceil(rows.length / 12) === 0)
      .map((row) => `<text class="axis" x="${x(row.year)}" y="${height - 10}" text-anchor="middle">${row.year}</text>`)
      .join('')}
  `;
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
      openSupervisorProfile(btn.dataset.supervisorName);
    });
  }
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
      openSupervisorProfile(btn.dataset.supervisorName);
    });
  }


}

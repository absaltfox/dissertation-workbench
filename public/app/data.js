
// --- Facet filter helpers ---

function updateFacetCount() {
  const total    = state.payload?.documents?.length || 0;
  const filtered = getFilteredDocs().length;
  const { degree, program, affiliation } = state.activeFilters;
  const active = !!(degree || program || affiliation);

  facetCountEl.textContent = active ? `${formatNum(filtered)} of ${formatNum(total)}` : '';
  clearFacetsBtn.style.display = active ? '' : 'none';

  // Active highlight on selects
  filterDegreeEl.classList.toggle('is-active', !!degree);
  filterProgramEl.classList.toggle('is-active', !!program);
  filterAffiliationEl.classList.toggle('is-active', !!affiliation);

  // Active filter chips
  const chips = [
    { key: 'degree',      dim: 'Degree',      value: degree },
    { key: 'program',     dim: 'Program',     value: program },
    { key: 'affiliation', dim: 'Affiliation', value: affiliation },
  ].filter(c => c.value);
  facetChipsEl.innerHTML = chips.map(c =>
    `<span class="facet-chip">` +
      `<span class="facet-chip-dim">${escapeHtml(c.dim)}</span> ${escapeHtml(c.value)}` +
      `<button class="facet-chip-remove" data-chip-key="${c.key}" aria-label="Remove ${escapeHtml(c.dim)} filter">&times;</button>` +
    `</span>`
  ).join('');
}

function populateFacetFilters() {
  const docs = state.payload?.documents || [];
  const degrees      = [...new Set(docs.map(d => d.degree).filter(Boolean))].sort();
  const programs     = [...new Set(docs.map(d => d.program).filter(Boolean))].sort();
  const affiliations = [...new Set(docs.flatMap(d => d.affiliation || []).map(normalizeAffiliation).filter(Boolean))].sort();

  const populate = (el, values, allLabel) => {
    el.innerHTML = `<option value="">${allLabel}</option>` +
      values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    el.value = '';
  };
  populate(filterDegreeEl,      degrees,      'All');
  populate(filterProgramEl,     programs,     'All');
  populate(filterAffiliationEl, affiliations, 'All');

  state.activeFilters = { degree: '', program: '', affiliation: '' };
  facetFilterBarEl.hidden = false;
  updateFacetCount();
}

// --- Client-side analytics builder (used when facet filters are active) ---

function buildAnalytics(docs) {
  const MIN_RELIABLE_WORD_COUNT = 1000;
  const MIN_RELIABLE_PAGE_COUNT = 10;
  const unreliableWordSources = new Set(['metadata_text']);
  const unreliablePageSources = new Set(['estimated_from_metadata_words']);

  function activeWordCount(doc) {
    return doc.bodyWordCount != null ? doc.bodyWordCount : doc.wordCount;
  }

  function hasReliableWordCount(doc) {
    const count = Number(activeWordCount(doc));
    return Number.isFinite(count)
      && count >= MIN_RELIABLE_WORD_COUNT
      && !unreliableWordSources.has(doc.wordCountSource);
  }

  function hasReliablePageCount(doc) {
    const count = Number(doc.pages);
    return Number.isFinite(count)
      && count >= MIN_RELIABLE_PAGE_COUNT
      && !unreliablePageSources.has(doc.pagesSource);
  }

  function statsOf(arr) {
    if (!arr.length) return { count: 0, min: null, max: null, mean: null, median: null };
    const s = [...arr].sort((a, b) => a - b);
    return {
      count: s.length,
      min: s[0], max: s[s.length - 1],
      mean: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
      median: s.length % 2 === 0 ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : s[Math.floor(s.length / 2)]
    };
  }

  // Accumulate data in a single pass
  const byYearPagesMap  = new Map();
  const byYearWordsMap  = new Map();
  const byYearCountMap  = new Map();
  const themeMap        = new Map();
  const ngramMap        = new Map();
  const methMap         = new Map();
  const pairMap         = new Map();
  const termCountMap    = new Map();
  const conceptDocMap   = new Map();
  const supCountMap     = new Map();
  const supConceptMap   = new Map();
  const mcCountMap      = new Map();
  const conceptYearMap  = new Map();

  for (const doc of docs) {
    const { year, pages, wordCount,
      themes = [], conceptTerms = [],
      methodologies: meths = [], supervisors: sups = [] } = doc;
    const reliableWords = hasReliableWordCount(doc);
    const reliablePages = hasReliablePageCount(doc);
    const weightedWordCount = reliableWords ? activeWordCount(doc) : null;

    if (year) {
      if (!byYearCountMap.has(year)) {
        byYearPagesMap.set(year, []); byYearWordsMap.set(year, []); byYearCountMap.set(year, 0);
      }
      if (reliablePages) byYearPagesMap.get(year).push(pages);
      if (reliableWords) byYearWordsMap.get(year).push(weightedWordCount);
      byYearCountMap.set(year, byYearCountMap.get(year) + 1);
    }

    for (const t of themes) themeMap.set(t, (themeMap.get(t) || 0) + 1);

    for (const t of conceptTerms) {
      ngramMap.set(t, (ngramMap.get(t) || 0) + 1);
      if (!conceptDocMap.has(t)) conceptDocMap.set(t, { sum: 0, count: 0, docCount: 0 });
      const e = conceptDocMap.get(t);
      e.docCount += 1;
      if (reliableWords) {
        e.sum += weightedWordCount;
        e.count += 1;
      }
      if (year) {
        if (!conceptYearMap.has(t)) conceptYearMap.set(t, new Map());
        const ym = conceptYearMap.get(t);
        ym.set(year, (ym.get(year) || 0) + 1);
      }
    }

    for (const m of meths) methMap.set(m, (methMap.get(m) || 0) + 1);

    // Track document frequency for ALL concept terms (used after the loop to
    // filter pairs to multi-doc concepts only).
    for (const t of new Set(conceptTerms)) termCountMap.set(t, (termCountMap.get(t) || 0) + 1);

    for (const sup of sups) {
      supCountMap.set(sup, (supCountMap.get(sup) || 0) + 1);
      if (!supConceptMap.has(sup)) supConceptMap.set(sup, new Map());
      const sm = supConceptMap.get(sup);
      for (const t of conceptTerms) sm.set(t, (sm.get(t) || 0) + 1);
    }

    for (const m of meths) {
      for (const t of conceptTerms) {
        const key = `${m}\0${t}`;
        mcCountMap.set(key, (mcCountMap.get(key) || 0) + 1);
      }
    }
  }

  const sortedYears = Array.from(byYearCountMap.keys()).sort((a, b) => a - b);

  const byYear = sortedYears.map(year => {
    const ws = statsOf(byYearWordsMap.get(year));
    return { year, count: byYearCountMap.get(year), mean: ws.mean, min: ws.min, max: ws.max };
  }).filter(row => row.mean != null);

  const avgPagesByYear = sortedYears.map(year => {
    const ps = statsOf(byYearPagesMap.get(year));
    return { year, mean: ps.mean, min: ps.min, max: ps.max, count: ps.count };
  }).filter(row => row.count > 0);

  const pageTrend = sortedYears.map(year => {
    const ps = statsOf(byYearPagesMap.get(year));
    return { year, median: ps.median, min: ps.min, max: ps.max, count: ps.count };
  }).filter(row => row.count > 0);

  const byConcept = Array.from(conceptDocMap.entries())
    .map(([concept, { sum, count, docCount }]) => ({ concept, weightedMean: count ? Math.round(sum / count) : null, docCount }))
    .filter(row => row.weightedMean != null)
    .sort((a, b) => b.weightedMean - a.weightedMean)
    .slice(0, 20);

  const overallPageCount = statsOf(docs.filter(hasReliablePageCount).map(d => d.pages));
  const overallWordCount = statsOf(docs.filter(hasReliableWordCount).map(activeWordCount));

  const metrics = { recordCount: docs.length, byYear, avgPagesByYear, pageTrend, byConcept, overallPageCount, overallWordCount };

  const wordCloud = Array.from(themeMap.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 70);

  const ngramCloud = Array.from(ngramMap.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 60);

  const methodologies = Array.from(methMap.entries())
    .map(([methodology, count]) => ({ methodology, count }))
    .sort((a, b) => b.count - a.count);

  // Second pass: build co-occurrence pairs using only multi-doc concepts.
  // Single-doc concepts dominate per-document IDF rankings and crowd out shared
  // concepts from the top slots; filtering to docFreq≥2 concepts ensures pairs
  // can actually reach the count≥3 threshold.
  for (const doc of docs) {
    const multiDocTerms = (doc.conceptTerms || [])
      .filter((t) => (termCountMap.get(t) || 0) >= 2 && !COOCCURRENCE_BLOCKLIST.has(t));
    if (multiDocTerms.length < 2) continue;
    const sorted = [...new Set(multiDocTerms)].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\0${sorted[j]}`;
        pairMap.set(key, (pairMap.get(key) || 0) + 1);
      }
    }
  }

  const N = docs.length;
  const termCooccurrence = Array.from(pairMap.entries())
    .filter(([, count]) => count >= 2) // minimum co-occurrence (corpus ~400 docs)
    .map(([key, count]) => {
      const [termA, termB] = key.split('\0');
      const freqA = termCountMap.get(termA) || 1;
      const freqB = termCountMap.get(termB) || 1;
      // Fragment filter: one term's docs almost entirely overlap the other's
      if (count / Math.min(freqA, freqB) >= 0.7) return null;
      // Shared-token filter removed: education-domain concepts legitimately share
      // words (e.g. "public school" + "school district") and the filter was
      // eliminating the best pairs. Fragment filter handles actual bigram fragments.
      const lift = (count * N) / (freqA * freqB);
      return { termA, termB, count, lift: Math.round(lift * 10) / 10, freqA, freqB };
    })
    .filter(Boolean)
    .sort((a, b) => b.lift - a.lift || b.count - a.count)
    .slice(0, 20);

  const topSups = Array.from(supCountMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s]) => s);
  const top10Ngrams = ngramCloud.slice(0, 10).map(w => w.term);
  const supervisorNgramMatrix = {
    supervisors: topSups,
    ngrams: top10Ngrams,
    matrix: topSups.map(sup => top10Ngrams.map(concept => supConceptMap.get(sup)?.get(concept) || 0))
  };

  const top8Concepts = ngramCloud.slice(0, 8).map(w => w.term);
  const conceptTimeline = top8Concepts
    .map(concept => {
      const ym = conceptYearMap.get(concept) || new Map();
      const data = sortedYears.map(year => ({ year, count: ym.get(year) || 0 }));
      const totalDocs = Array.from(ym.values()).reduce((a, b) => a + b, 0);
      return { concept, data, totalDocs };
    })
    .filter(s => s.totalDocs > 0);

  const topMeths     = methodologies.slice(0, 10).map(m => m.methodology);
  const top10Concepts = ngramCloud.slice(0, 10).map(w => w.term);
  const methodologyConceptMatrix = {
    methodologies: topMeths,
    concepts: top10Concepts,
    matrix: topMeths.map(meth => top10Concepts.map(concept => mcCountMap.get(`${meth}\0${concept}`) || 0))
  };

  // Recompute topic distribution from filtered docs if topicData exists
  let topicData = null;
  const srcTopics = state.payload?.topicData?.topics;
  if (srcTopics && srcTopics.length) {
    const topicCountMap = new Map();
    const topicYearMap = new Map();
    for (const doc of docs) {
      if (doc.topicId == null) continue;
      topicCountMap.set(doc.topicId, (topicCountMap.get(doc.topicId) || 0) + 1);
      if (doc.year) {
        if (!topicYearMap.has(doc.topicId)) topicYearMap.set(doc.topicId, new Map());
        const ym = topicYearMap.get(doc.topicId);
        ym.set(doc.year, (ym.get(doc.year) || 0) + 1);
      }
    }
    const filteredTopics = srcTopics
      .map((t) => ({ ...t, docCount: topicCountMap.get(t.topicId) || 0 }))
      .filter((t) => t.docCount > 0)
      .sort((a, b) => b.docCount - a.docCount);
    const byYear = filteredTopics
      .filter((t) => t.topicId !== -1)
      .slice(0, 8)
      .map((topic) => {
        const ym = topicYearMap.get(topic.topicId) || new Map();
        const data = Array.from(ym.entries())
          .map(([yr, cnt]) => ({ year: Number(yr), count: cnt }))
          .sort((a, b) => a.year - b.year);
        return { topicId: topic.topicId, label: topic.label, data };
      });
    topicData = { topics: filteredTopics, byYear };
  }

  // Build supervisor network for filtered docs
  const supNodeMap = new Map();
  const supEdgeMap = new Map();
  for (const doc of docs) {
    const people = [...(doc.supervisors || [])];
    if (!people.length) continue;
    for (const p of people) supNodeMap.set(p, (supNodeMap.get(p) || 0) + 1);
    const sorted = [...people].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const ek = `${sorted[i]}|||${sorted[j]}`;
        if (!supEdgeMap.has(ek)) supEdgeMap.set(ek, { weight: 0, docs: [] });
        const e = supEdgeMap.get(ek);
        e.weight++;
        e.docs.push(doc.id);
      }
    }
  }
  const topSupNodes = Array.from(supNodeMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const topSupSet = new Set(topSupNodes.map(([n]) => n));
  const supervisorNetwork = {
    nodes: topSupNodes.map(([id, docCount]) => ({ id, docCount })),
    edges: Array.from(supEdgeMap.entries())
      .filter(([k]) => { const [a, b] = k.split('|||'); return topSupSet.has(a) && topSupSet.has(b); })
      .map(([k, e]) => { const [source, target] = k.split('|||'); return { source, target, weight: e.weight, docs: e.docs }; })
  };

  // Citation co-occurrence comes from DB — pass through from payload (not filterable client-side)
  const citationCooccurrence = state.payload?.citationCooccurrence || null;

  // Build methodology-topic matrix for filtered docs
  let methodologyTopicMatrix = null;
  if (topicData?.topics?.length) {
    const mtMeths = methodologies.slice(0, 10).map(m => m.methodology);
    const mtTopics = topicData.topics.filter(t => t.topicId !== -1).slice(0, 8);
    const mtTopicIds = mtTopics.map(t => t.topicId);
    const mtMatrix = mtMeths.map(() => mtTopicIds.map(() => 0));
    const mtTopicSet = new Set(mtTopicIds);
    const mtMethSet = new Set(mtMeths);
    for (const doc of docs) {
      if (doc.topicId == null || !mtTopicSet.has(doc.topicId)) continue;
      const ti = mtTopicIds.indexOf(doc.topicId);
      for (const m of (doc.methodologies || [])) {
        if (!mtMethSet.has(m)) continue;
        mtMatrix[mtMeths.indexOf(m)][ti]++;
      }
    }
    methodologyTopicMatrix = {
      methodologies: mtMeths,
      topics: mtTopics.map(t => ({ topicId: t.topicId, label: t.label })),
      matrix: mtMatrix
    };
  }

  return { metrics, wordCloud, ngramCloud, methodologies, supervisorNgramMatrix, termCooccurrence, conceptTimeline, methodologyConceptMatrix, supervisorNetwork, citationCooccurrence, methodologyTopicMatrix, topicData };
}

function getAnalytics() {
  if (!state.payload) return null;
  const { degree, program, affiliation } = state.activeFilters;
  if (!degree && !program && !affiliation) return state.payload;
  const key = `${degree}\0${program}\0${affiliation}`;
  if (_analyticsCache && _analyticsCacheKey === key) return _analyticsCache;
  _analyticsCache = buildAnalytics(getFilteredDocs());
  _analyticsCacheKey = key;
  return _analyticsCache;
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
  if (document.querySelector('.analytics-tab-section#analytics-visualizations.active')) {
    renderTopicCluster();
    renderTopicDendrogram();
    renderTopicSankey();
    renderMethTopicBubble();
  }
}

function renderAll() {
  renderDocuments();
  if (state.analyticsLoaded) renderAnalytics();
  if (document.querySelector('#tab-people.active')) renderPersonTable();
}

// --- Data loading ---

async function loadData({ refresh = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (loadBtn) loadBtn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  showSpinner(true);
  facetFilterBarEl.hidden = true;

  const params = getCurrentParams();
  if (refresh) params.refresh = '1';

  try {
    const query = new URLSearchParams(params);
    const res = await fetch(`/api/metrics?${query.toString()}`, refresh ? { headers: csrfHeaders() } : {});
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || err.error || `Request failed with ${res.status}`);
    }

    state.payload = await res.json();
    state.analyticsLoaded = false;
    _analyticsCache = null;
    _analyticsCacheKey = '';
    _personListCache = null;
    _personListCacheKey = '';
    state.selectedDocId = state.payload.documents?.[0]?.id || null;
    state.selectedTheme = null;
    state.sortKey = null;
    state.sortDir = 'asc';
    state.filterText = '';
    state.selectedPersonKey = null;
    state.selectedDocIds = new Set();
    docFilterEl.value = '';
    renderAll();
    populateFacetFilters();
    if (document.querySelector('#tab-analytics.active')) loadAnalytics();

    setRefreshRuleFromPayload();
    hideStatus();
  } catch (error) {
    setRefreshRuleError(error.message);
    setStatus(`Failed to load data: ${error.message}`, true);
  } finally {
    state.loading = false;
    if (loadBtn) loadBtn.disabled = false;
    if (refreshBtn) refreshBtn.disabled = false;
    showSpinner(false);
  }
}

function loadAnalytics() {
  if (state.analyticsLoaded || state.analyticsLoading || !state.payload?.metrics) return;
  state.analyticsLoading = true;
  try {
    renderAnalytics();
    state.analyticsLoaded = true;
  } finally {
    state.analyticsLoading = false;
  }
}

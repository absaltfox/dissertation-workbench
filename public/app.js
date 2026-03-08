// --- DOM references ---
const statusTextEl = document.getElementById('statusText');
const spinnerEl = document.getElementById('spinner');
const statusEl = document.getElementById('status');
const documentsTableEl = document.getElementById('documentsTable');
const docFilterEl = document.getElementById('docFilter');
const docTheadRow = document.querySelector('#tab-records thead tr');
const selectAllDocsEl = document.getElementById('selectAllDocs');
const docDetailsEl = document.getElementById('docDetails');
const kpisEl = document.getElementById('kpis');
const pagesByYearChartEl = document.getElementById('pagesByYearChart');
const wordCloudEl = document.getElementById('wordCloud');
const themeResultsEl = document.getElementById('themeResults');
const subjectBarsEl = document.getElementById('subjectBars');
const dissertationsByYearChartEl = document.getElementById('dissertationsByYearChart');
const wordsByYearChartEl = document.getElementById('wordsByYearChart');
const pageTrendChartEl = document.getElementById('pageTrendChart');
const ngramCloudEl = document.getElementById('ngramCloud');
const methodologyBarsEl = document.getElementById('methodologyBars');
const cooccurrenceBarsEl = document.getElementById('cooccurrenceBars');
const supervisorHeatmapEl = document.getElementById('supervisorHeatmap');
const conceptTimelineChartEl = document.getElementById('conceptTimelineChart');
const conceptTimelineLegendEl = document.getElementById('conceptTimelineLegend');
const methodologyConceptHeatmapEl = document.getElementById('methodologyConceptHeatmap');
const researchGapsListEl = document.getElementById('researchGapsList');
const supervisorTopicPanelEl = document.getElementById('supervisorTopicPanel');
const supervisorTopicHeatmapEl = document.getElementById('supervisorTopicHeatmap');
const topicDistPanelEl = document.getElementById('topicDistPanel');
const topicBarsEl = document.getElementById('topicBars');
const topicTimelinePanelEl = document.getElementById('topicTimelinePanel');
const topicTimelineChartEl = document.getElementById('topicTimelineChart');
const topicTimelineLegendEl = document.getElementById('topicTimelineLegend');
const foundationalWorksListEl = document.getElementById('foundationalWorksList');

// Analytics sub-tab elements
const analyticsTabButtons = Array.from(document.querySelectorAll('.sub-tab-btn[data-analytics-tab]'));
const topicClusterPanelEl = document.getElementById('topicClusterPanel');
const topicClusterChartEl = document.getElementById('topicClusterChart');
const topicClusterTooltipEl = document.getElementById('topicClusterTooltip');
const topicClusterLegendEl = document.getElementById('topicClusterLegend');
const topicClusterContainerEl = document.getElementById('topicClusterContainer');

// Visualization panel elements
const topicDendrogramPanelEl = document.getElementById('topicDendrogramPanel');
const topicDendrogramChartEl = document.getElementById('topicDendrogramChart');
const topicDendrogramTooltipEl = document.getElementById('topicDendrogramTooltip');
const topicDendrogramContainerEl = document.getElementById('topicDendrogramContainer');
const topicSankeyPanelEl = document.getElementById('topicSankeyPanel');
const topicSankeyChartEl = document.getElementById('topicSankeyChart');
const topicSankeyLegendEl = document.getElementById('topicSankeyLegend');
const methTopicBubblePanelEl = document.getElementById('methTopicBubblePanel');
const methTopicBubbleChartEl = document.getElementById('methTopicBubbleChart');
const methTopicBubbleTooltipEl = document.getElementById('methTopicBubbleTooltip');
const methTopicBubbleContainerEl = document.getElementById('methTopicBubbleContainer');

const exportBibTeXBtn = document.getElementById('exportBibTeX');
const exportRISBtn = document.getElementById('exportRIS');
const exportCitationBibTeXBtn = document.getElementById('exportCitationBibTeX');
const exportCitationRISBtn = document.getElementById('exportCitationRIS');
const settingsForm = document.getElementById('settingsForm');
const loadBtn = document.getElementById('loadBtn');
const refreshBtn = document.getElementById('refreshBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const rebuildConceptsBtn = document.getElementById('rebuildConceptsBtn');
const conceptPipelineStatusEl = document.getElementById('conceptPipelineStatus');
const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));

// Modal elements
const docModalOverlay = document.getElementById('docModalOverlay');
const docModalCloseBtn = document.getElementById('docModalClose');
const docModalTitleEl = document.getElementById('docModalTitle');

// Summon modal elements
const summonModalOverlayEl = document.getElementById('summonModalOverlay');
const summonModalTitleEl = document.getElementById('summonModalTitle');
const summonResultsEl = document.getElementById('summonResults');
const summonModalCloseBtn = document.getElementById('summonModalClose');

// Admin elements
const loginGate = document.getElementById('loginGate');
const adminContent = document.getElementById('adminContent');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const adminUserLabel = document.getElementById('adminUserLabel');
const logoutBtn = document.getElementById('logoutBtn');
const adminTabButtons = Array.from(document.querySelectorAll('.admin-tab-btn'));
const createUserForm = document.getElementById('createUserForm');
const createUserError = document.getElementById('createUserError');
const refreshCacheBtn = document.getElementById('refreshCacheBtn');
const reparseAllBtn = document.getElementById('reparseAllBtn');

// Citation Explorer elements
const citationDocsTableEl = document.getElementById('citationDocsTable');
const citationDocFilterEl = document.getElementById('citationDocFilter');
const citationListTitleEl = document.getElementById('citationListTitle');
const citationEntriesEl = document.getElementById('citationEntries');
const citationTabButtons = Array.from(document.querySelectorAll('.sub-tab-btn[data-citation-tab]'));

// Person Explorer elements
const personTableEl = document.getElementById('personTable');
const personDetailEl = document.getElementById('personDetail');
const personFilterEl = document.getElementById('personFilter');
const personRoleFilterEl = document.getElementById('personRoleFilter');
const personCountEl = document.getElementById('personCount');
const personSortHeaders = Array.from(document.querySelectorAll('[data-person-sort]'));

// Facet filter bar
const facetFilterBarEl    = document.getElementById('facetFilterBar');
const filterDegreeEl      = document.getElementById('filterDegree');
const filterProgramEl     = document.getElementById('filterProgram');
const filterAffiliationEl = document.getElementById('filterAffiliation');
const clearFacetsBtn      = document.getElementById('clearFacets');
const facetCountEl        = document.getElementById('facetCount');
const facetChipsEl        = document.getElementById('facetChips');

// --- State ---
const state = {
  payload: null,
  selectedDocId: null,
  selectedTheme: null,
  loading: false,
  user: null, // { username } or null
  sortKey: null,   // 'title' | 'author' | 'year' | 'degree' | 'pages' | null
  sortDir: 'asc',  // 'asc' | 'desc'
  filterText: '',
  citationDocId: null,
  citationFilterText: '',
  citationRequestToken: 0,
  selectedDocIds: new Set(),
  selectedCitationIds: new Set(),
  activeFilters: { degree: '', program: '', affiliation: '' },
  personFilterText: '',
  personSortKey: 'docCount',
  personSortDir: 'desc',
  personRoleFilter: '',
  selectedPersonKey: null,
};

let _analyticsCache = null;
let _analyticsCacheKey = '';
let _personListCache = null;
let _personListCacheKey = '';

// Mirrors COOCCURRENCE_BLOCKLIST in src/metrics.js — keep in sync.
const COOCCURRENCE_BLOCKLIST = new Set([
  // Statistical and experimental design
  'significant differences', 'statistically significant', 'significant difference',
  'significant relationships', 'significant relationship', 'significantly related',
  'control group', 'treatment groups', 'treatment group',
  'experimental groups', 'experimental group', 'experimental design',
  'randomly assigned', 'randomly selected', 'random sample',
  'dependent variables', 'independent variables', 'dependent variable', 'independent variable',
  'predictor variables', 'criterion variables',
  'regression analysis', 'regression analyses', 'multiple regression', 'stepwise regression',
  'factor analysis', 'path analysis', 'discriminant analysis', 'canonical analysis',
  'analysis variance', 'multivariate analysis', 'repeated measures',
  'three groups', 'two groups',
  // Results / findings boilerplate
  'results indicated', 'results showed', 'results suggest', 'results revealed',
  'analysis revealed', 'analysis indicated', 'analyses indicated',
  'findings indicate', 'findings indicated', 'findings suggest',
  // Generic academic-writing filler
  'data analysis', 'data collected', 'data collection', 'data gathering', 'data sources',
  'analyzed using', 'semi structured', 'interview data',
  'attitudes toward', 'determine whether', 'based upon', 'directed towards',
  'further investigation', 'important factor', 'wide range',
  'higher levels', 'high levels', 'second part', 'first part',
  // Older psychometric / measurement instruments
  'main effects', 'significant main', 'interaction effects', 'post test',
  'discriminant function', 'tennessee self', 'concept scale',
  'native indian',
]);

// --- Utilities ---

function formatNum(value) {
  if (value === null || value === undefined) return '-';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatBytes(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeAffiliation(raw) {
  if (!raw) return '';
  let s = raw.trim();

  // Strip academic titles/ranks (order matters: longer phrases first)
  const titles = [
    'Associate Professor', 'Assistant Professor', 'Adjunct Professor',
    'Full Professor', 'Professor Emerita', 'Professor Emeritus',
    'Professor of Teaching', 'Senior Instructor', 'Senior Lecturer',
    'Clinical Professor', 'Professor', 'Emerita', 'Emeritus', 'Dean', 'Dr\\.'
  ];
  const titleRe = new RegExp('(?:^|\\b)(' + titles.join('|') + ')(?:\\b|(?=\\s|,|;|$))', 'gi');
  s = s.replace(titleRe, '');

  // Normalize institution names
  s = s.replace(/\bThe University of British Columbia\b/gi, 'UBC');
  s = s.replace(/\bUniversity of British Columbia\b/gi, 'UBC');
  s = s.replace(/\bSimon Fraser University\b/gi, 'SFU');
  s = s.replace(/\bUniversity of Victoria\b/gi, 'UVic');
  s = s.replace(/\bThompson Rivers University\b/gi, 'TRU');
  s = s.replace(/\bRoyal Roads University\b/gi, 'RRU');

  // Strip department/faculty/school prefixes
  s = s.replace(/\b(Department|Dept\.?|Faculty|School|Division|Institute|Centre|Center)\s+of\s+/gi, '');

  // Normalize "and" → "&" in department names
  s = s.replace(/\band\b/gi, '&');

  // Move institution acronym from start to end: "UBC X" → "X, UBC"
  s = s.replace(/^(UBC|SFU|UVic|TRU|RRU)\b[,;\s]*(.+)$/i, (_, inst, rest) => rest.trim() + ', ' + inst.toUpperCase());

  // Collapse whitespace, strip leftover separators
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[,;\s\-–—]+|[,;\s\-–—]+$/g, '').trim();

  // Title case, but preserve all-caps acronyms (UBC, SFU, etc.)
  s = s.replace(/\w\S*/g, w => {
    if (/^[A-Z]{2,}$/.test(w)) return w; // preserve acronyms
    return w.length <= 2 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
  // Fix common small words
  s = s.replace(/\b(And|Or|Of|In|For|The|At|By|To)\b/g, m => m.toLowerCase());

  return s || '';
}

/** Merge semantically similar normalized affiliations for display.
 *  - Defaults bare departments (no institution) to ", UBC"
 *  - Uses token containment: if A's dept tokens ⊆ B's, merge A into B */
function mergeAffiliations(affiliations) {
  const KNOWN_INSTITUTIONS = ['UBC', 'SFU', 'UVic', 'TRU', 'RRU'];
  const instRe = new RegExp(',\\s*(' + KNOWN_INSTITUTIONS.join('|') + ')\\s*$', 'i');

  // Parse each affiliation into { dept tokens, institution, original }
  const parsed = affiliations.map(a => {
    const m = a.match(instRe);
    const institution = m ? m[1].toUpperCase() : null;
    const dept = m ? a.slice(0, m.index).trim() : a.trim();
    const tokens = dept.toLowerCase().replace(/[&,]/g, ' ').split(/\s+/).filter(Boolean);
    return { original: a, dept, institution, tokens };
  });

  // Default bare departments to UBC
  for (const p of parsed) {
    if (!p.institution) {
      p.institution = 'UBC';
      p.original = p.dept + ', UBC';
    }
  }

  // Deduplicate after defaulting institution
  const deduped = new Map();
  for (const p of parsed) {
    const key = p.original.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, p);
  }
  const entries = Array.from(deduped.values());

  // Containment merge: if A's tokens ⊆ B's tokens (same institution), drop A
  const merged = [];
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    let subsumed = false;
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      const b = entries[j];
      if (a.institution !== b.institution) continue;
      if (a.tokens.length >= b.tokens.length) continue;
      // Check if all of A's tokens appear in B
      if (a.tokens.every(t => b.tokens.includes(t))) {
        subsumed = true;
        break;
      }
    }
    if (!subsumed) merged.push(a.original);
  }
  return merged.length ? merged : affiliations;
}

function setStatus(message, isError = false) {
  statusTextEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function showSpinner(show) {
  spinnerEl.hidden = !show;
}

// --- Tab navigation ---

function setActiveTab(tabName) {
  for (const btn of tabButtons) {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const panel of tabPanels) {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  }
  if (tabName === 'citations' && state.payload) {
    renderCitationDocs();
    setActiveCitationTab('browse');
  }
  if (tabName === 'people' && state.payload) {
    renderPersonTable();
    if (state.selectedPersonKey) renderPersonDetail(state.selectedPersonKey);
  }
}

function setActiveCitationTab(tabName) {
  for (const btn of citationTabButtons) {
    btn.classList.toggle('active', btn.dataset.citationTab === tabName);
  }
  for (const section of document.querySelectorAll('.citation-tab-section')) {
    section.classList.toggle('active', section.id === `citation-${tabName}`);
  }
  if (tabName === 'foundational' && state.payload) {
    loadFoundationalWorks();
  }
}

function setActiveAdminTab(tabName) {
  for (const btn of adminTabButtons) {
    btn.classList.toggle('active', btn.dataset.adminTab === tabName);
  }
  for (const section of document.querySelectorAll('.admin-panel-section')) {
    section.classList.toggle('active', section.id === `admin-${tabName}`);
  }
}

// --- Query params ---

function getCurrentParams({ includeApiKey = false } = {}) {
  const params = {
    index: document.getElementById('s-index').value.trim(),
    query: document.getElementById('s-query').value.trim(),
    term: document.getElementById('s-term').value.trim(),
    source: document.getElementById('s-source').value.trim(),
    maxRecords: document.getElementById('s-maxRecords').value,
    pageSize: document.getElementById('s-pageSize').value,
    scanLimit: document.getElementById('s-scanLimit').value,
    subjectLimit: document.getElementById('s-subjectLimit').value,
    downloadFiles: document.getElementById('s-downloadFiles').value,
    recomputeFromCache: document.getElementById('s-recomputeFromCache').value
  };
  if (includeApiKey) {
    params.apiKey = document.getElementById('s-apiKey').value.trim();
  }
  return params;
}

// --- Document rendering ---

function intersectionCount(a, b) {
  const setB = new Set(b);
  let count = 0;
  for (const x of a) {
    if (setB.has(x)) count += 1;
  }
  return count;
}

function relatedDocuments(doc, allDocs, limit = 6) {
  const docThemes = doc.themes || [];
  return allDocs
    .filter((candidate) => candidate.id !== doc.id)
    .map((candidate) => {
      const overlap = intersectionCount(docThemes, candidate.themes || []);
      return {
        ...candidate,
        overlap,
        sharedThemes: (candidate.themes || []).filter((t) => docThemes.includes(t)).slice(0, 4)
      };
    })
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.year || 0) - (a.year || 0))
    .slice(0, limit);
}

function openRecord(docId, focusTab = 'records') {
  state.selectedDocId = docId;
  renderDocuments();
  renderDetails();
  docModalOverlay.hidden = false;
  setActiveTab(focusTab);
}

function closeDocModal() {
  docModalOverlay.hidden = true;
}

function docsForTheme(theme) {
  const docs = state.payload?.documents || [];
  const normalized = String(theme || '').toLowerCase();
  return docs.filter((doc) => (doc.themes || []).some((t) => t.toLowerCase() === normalized));
}

function docsForConceptTerm(term) {
  const docs = state.payload?.documents || [];
  const normalized = String(term || '').toLowerCase();
  return docs.filter((doc) => (doc.conceptTerms || []).some((t) => String(t || '').toLowerCase() === normalized));
}

function docsForTopic(topicId) {
  const docs = state.payload?.documents || [];
  return docs.filter((doc) => doc.topicId === topicId);
}

function docsForMethodology(methodology) {
  const docs = state.payload?.documents || [];
  const normalized = String(methodology || '').toLowerCase();
  return docs.filter((doc) => (doc.methodologies || []).some((m) => String(m || '').toLowerCase() === normalized));
}

function docsForCooccurrence(termA, termB) {
  const a = String(termA || '').toLowerCase();
  const b = String(termB || '').toLowerCase();
  if (!a || !b) return [];
  const docs = state.payload?.documents || [];
  return docs.filter((doc) => {
    const terms = new Set((doc.conceptTerms || []).map((t) => String(t || '').toLowerCase()));
    return terms.has(a) && terms.has(b);
  });
}

function docsForSupervisorConcept(supervisor, concept) {
  const sup = String(supervisor || '').toLowerCase();
  const conceptNorm = String(concept || '').toLowerCase();
  const docs = state.payload?.documents || [];
  return docs.filter((doc) => {
    const hasSup = (doc.supervisors || []).some((s) => String(s || '').toLowerCase() === sup);
    if (!hasSup) return false;
    const terms = new Set((doc.conceptTerms || []).map((t) => String(t || '').toLowerCase()));
    return terms.has(conceptNorm);
  });
}

function openMatchesModal(title, matches) {
  const list = matches || [];
  const body = list.length
    ? `
      <div class="related-list">
        ${list
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
    `
    : '<p class="meta">No matching dissertations found in the current result set.</p>';

  docDetailsEl.innerHTML = `
    <div class="meta">
      <p><strong>${escapeHtml(title)}</strong></p>
      <p>${formatNum(list.length)} dissertation(s)</p>
    </div>
    ${body}
  `;

  for (const item of docDetailsEl.querySelectorAll('.related-item[data-related-id]')) {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-related-id');
      if (targetId) openRecord(targetId, 'records');
    });
  }
  docModalOverlay.hidden = false;
}

function docSortValue(doc, key) {
  switch (key) {
    case 'title': return (doc.title || '').toLowerCase();
    case 'author': return (doc.author || '').toLowerCase();
    case 'year': return doc.year || 0;
    case 'degree': return (doc.degree || doc.type || '').toLowerCase();
    case 'pages': return doc.pages || 0;
    case 'wordCount': return doc.wordCount || 0;
    default: return '';
  }
}

function getFilteredDocs() {
  let docs = state.payload?.documents || [];
  const { degree, program, affiliation } = state.activeFilters;
  if (degree)      docs = docs.filter(d => d.degree === degree);
  if (program)     docs = docs.filter(d => d.program === program);
  if (affiliation) docs = docs.filter(d => (d.affiliation || []).some(a => normalizeAffiliation(a) === affiliation));
  return docs;
}

function getFilteredSortedDocs() {
  let docs = getFilteredDocs();

  if (state.filterText) {
    const q = state.filterText.toLowerCase();
    docs = docs.filter((doc) =>
      (doc.title || '').toLowerCase().includes(q) ||
      (doc.author || '').toLowerCase().includes(q) ||
      (doc.supervisors || []).some((name) => String(name || '').toLowerCase().includes(q)) ||
      (doc.degree || '').toLowerCase().includes(q) ||
      (doc.program || '').toLowerCase().includes(q) ||
      String(doc.year || '').includes(q)
    );
  }

  if (state.sortKey) {
    const dir = state.sortDir === 'asc' ? 1 : -1;
    docs = [...docs].sort((a, b) => {
      const av = docSortValue(a, state.sortKey);
      const bv = docSortValue(b, state.sortKey);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  return docs;
}

function updateSortHeaders() {
  for (const th of docTheadRow.querySelectorAll('th.sortable')) {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sortKey === state.sortKey) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  }
}

function renderDocuments() {
  const docs = getFilteredSortedDocs();

  documentsTableEl.innerHTML = docs
    .map((doc) => {
      const active = doc.id === state.selectedDocId ? ' active' : '';
      const checked = state.selectedDocIds.has(doc.id) ? ' checked' : '';
      return `
        <tr class="doc-row${active}" data-doc-id="${escapeHtml(doc.id)}">
          <td class="doc-check-col"><input type="checkbox" class="doc-row-check" data-check-id="${escapeHtml(doc.id)}"${checked} /></td>
          <td>${escapeHtml(doc.title || '(Untitled)')}</td>
          <td>${escapeHtml(doc.author || '')}</td>
          <td>${doc.year || '-'}</td>
          <td>${escapeHtml(doc.degree || doc.type || '-')}</td>
          <td>${formatNum(doc.pages)}</td>
          <td>${formatNum(doc.wordCount)}</td>
        </tr>
      `;
    })
    .join('');

  syncSelectAllDocs();
  updateSortHeaders();
}

function syncSelectAllDocs() {
  const visibleChecks = documentsTableEl.querySelectorAll('.doc-row-check');
  const allChecked = visibleChecks.length > 0 && Array.from(visibleChecks).every((cb) => cb.checked);
  selectAllDocsEl.checked = allChecked;
  selectAllDocsEl.indeterminate = !allChecked && state.selectedDocIds.size > 0;
}

function renderDetails() {
  const docs = state.payload?.documents || [];
  if (!docs.length) {
    docModalTitleEl.textContent = 'Document Details';
    docDetailsEl.textContent = 'No documents in current result set.';
    return;
  }

  let doc = docs.find((d) => d.id === state.selectedDocId);
  if (!doc) {
    doc = docs[0];
    state.selectedDocId = doc.id;
  }

  // Set modal heading to document title
  docModalTitleEl.textContent = doc.title || '(Untitled)';

  const related = relatedDocuments(doc, docs);
  const abstract = doc.abstract
    ? doc.abstract.split(/\n{2,}|\r?\n/).map((p) => `<p>${escapeHtml(p.trim())}</p>`).join('')
    : '<p>No abstract provided.</p>';
  const themes = doc.themes?.length
    ? doc.themes.map((t) => `<span class="token">${escapeHtml(t)}</span>`).join('')
    : '<span class="token">No themes</span>';
  const concepts = doc.conceptTerms?.length
    ? doc.conceptTerms.map((t) => `<span class="token concept">${escapeHtml(t)}</span>`).join('')
    : '<span class="token concept">No concepts</span>';

  const relatedHtml = related.length
    ? related
        .map(
          (r) => `
          <div class="related-item" data-related-id="${escapeHtml(r.id)}">
            <strong>${escapeHtml(r.title || '(Untitled)')}</strong>
            <p>${escapeHtml(r.author || 'Unknown')} &middot; ${r.year || '-'} &middot; Shared themes: ${escapeHtml(r.sharedThemes.join(', '))}</p>
          </div>
        `
        )
        .join('')
    : '<p class="meta">No related documents identified from overlapping themes.</p>';

  // Committee members for metadata grid
  // Supervisor roles are always shown via the clickable supervisor buttons, never in the committee section
  const supervisorRoles = new Set(['Supervisor', 'Co-Supervisor']);
  let committeeHtml = '';
  if (doc.committee?.length) {
    const grouped = {};
    for (const m of doc.committee) {
      const role = m.role || 'Committee Member';
      if (supervisorRoles.has(role)) continue;
      if (!grouped[role]) grouped[role] = [];
      grouped[role].push(m);
    }
    committeeHtml = Object.entries(grouped).map(([role, members]) => {
      const names = members.map((m) =>
        `${escapeHtml(m.name)}${m.affiliation ? ` (${escapeHtml(normalizeAffiliation(m.affiliation))})` : ''}`
      ).join(', ');
      return `<div class="detail-meta-label">${escapeHtml(role)}</div><div class="detail-meta-value">${names}</div>`;
    }).join('');
  }

  // Subtitle line: author, year, degree
  const subtitleParts = [
    doc.author || 'Unknown',
    doc.year || '',
    doc.degree || ''
  ].filter(Boolean);

  // Action buttons
  const actions = [];
  if (doc.downloadUrl) {
    actions.push(`<a class="btn ghost btn-sm" href="${escapeHtml(doc.downloadUrl)}" target="_blank" rel="noreferrer">Open PDF</a>`);
  }
  if (doc.uri) {
    actions.push(`<a class="btn ghost btn-sm" href="${escapeHtml(doc.uri)}" target="_blank" rel="noreferrer">Open Record</a>`);
  }
  actions.push(`<button class="btn ghost btn-sm" data-doc-bibtex>BibTeX</button>`);
  const actionsHtml = `<div class="doc-actions">${actions.join('')}</div>`;
  const downloadNoteHtml = doc.downloadError
    ? `<p class="detail-download-note">${escapeHtml(doc.downloadError)}</p>`
    : '';

  // Works cited section (lazy loaded)
  const citationCount = doc.citationCount || 0;
  const citationsHtml = citationCount > 0
    ? `<details class="citations-details" data-doc-id="${escapeHtml(doc.id)}">
        <summary>Works Cited (${formatNum(citationCount)} references)</summary>
        <div class="citations-content"><p class="meta">Loading...</p></div>
      </details>`
    : '';

  docDetailsEl.innerHTML = `
    <p class="doc-subtitle">${escapeHtml(subtitleParts.join(' \u00B7 '))}</p>
    ${actionsHtml}
    ${downloadNoteHtml}
    <div class="detail-meta">
      <div class="detail-meta-label">Date</div><div class="detail-meta-value">${escapeHtml((doc.date || '-').replace(/\s*AD\s*$/i, ''))}</div>
      <div class="detail-meta-label">Program</div><div class="detail-meta-value">${escapeHtml(doc.program || '-')}</div>
      <div class="detail-meta-label">Pages</div><div class="detail-meta-value">${formatNum(doc.pages)}</div>
      <div class="detail-meta-label">Words</div><div class="detail-meta-value">${formatNum(doc.wordCount)}</div>
      ${doc.supervisors?.length ? `<div class="detail-meta-label">Supervisor</div><div class="detail-meta-value">${doc.supervisors.map((s) => `<button class="supervisor-link" data-supervisor-name="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('; ')}</div>` : ''}
      ${committeeHtml}
    </div>
    <div>
      <p class="detail-section-title">Abstract</p>
      <div class="detail-abstract">${abstract}</div>
    </div>
    <div>
      <p class="detail-section-title">Key Themes</p>
      <div class="token-list">${themes}</div>
    </div>
    <div>
      <p class="detail-section-title">Concepts</p>
      <div class="token-list">${concepts}</div>
    </div>
    ${doc.topicId != null ? (() => {
      const topic = state.payload?.topicData?.topics?.find((t) => t.topicId === doc.topicId);
      const label = doc.topicId === -1 ? 'Uncategorized' : topicDisplayLabel(topic?.label || `Topic ${doc.topicId}`);
      return `<div><p class="detail-section-title">Topic</p><div class="token-list"><span class="token topic">${escapeHtml(label)}</span></div></div>`;
    })() : ''}
    <div>
      <p class="detail-section-title">Related Documents</p>
      <div class="related-list">${relatedHtml}</div>
    </div>
    ${citationsHtml}
  `;

  for (const item of docDetailsEl.querySelectorAll('.related-item[data-related-id]')) {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-related-id');
      if (targetId) openRecord(targetId, 'records');
    });
  }

  // Supervisor profile links
  for (const btn of docDetailsEl.querySelectorAll('.supervisor-link[data-supervisor-name]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSupervisorProfile(btn.dataset.supervisorName);
    });
  }

  // BibTeX export for single document
  const bibBtn = docDetailsEl.querySelector('[data-doc-bibtex]');
  if (bibBtn) {
    bibBtn.addEventListener('click', () => {
      downloadFile(generateBibTeX([doc]), `${sanitizeBibKey(doc.author)}${doc.year || ''}.bib`, 'application/x-bibtex');
    });
  }

  // Lazy-load citations on toggle
  const citationsDetails = docDetailsEl.querySelector('.citations-details[data-doc-id]');
  if (citationsDetails) {
    citationsDetails.addEventListener('toggle', async () => {
      if (!citationsDetails.open) return;
      const contentEl = citationsDetails.querySelector('.citations-content');
      if (contentEl.dataset.loaded) return;
      contentEl.dataset.loaded = '1';
      try {
        const docId = citationsDetails.dataset.docId;
        const res = await fetch(`/api/documents/${encodeURIComponent(docId)}/citations`);
        if (!res.ok) {
          contentEl.innerHTML = '<p class="meta">Failed to load citations.</p>';
          return;
        }
        const data = await res.json();
        if (!data.citations?.length) {
          contentEl.innerHTML = '<p class="meta">No citations found.</p>';
          return;
        }
        contentEl.innerHTML = data.citations.map((c) =>
          `<p class="citation-entry" data-citation-text="${escapeHtml(c.citation_text)}">${escapeHtml(c.citation_text)}${catalogueBadge(c)}</p>`
        ).join('');
        attachSummonHandlers(contentEl);
      } catch {
        contentEl.innerHTML = '<p class="meta">Connection error.</p>';
      }
    });
  }
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
    .map((s) => `<th class="heatmap-header">${escapeHtml(s)}</th>`)
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
      const short = label.length > 20 ? label.slice(0, 18) + '\u2026' : label;
      return `<th class="heatmap-header" title="${escapeHtml(label)}">${escapeHtml(short)}</th>`;
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

// --- Citation Explorer ---

function renderCitationDocs() {
  let docs = getFilteredDocs();
  if (state.citationFilterText) {
    const q = state.citationFilterText.toLowerCase();
    docs = docs.filter((doc) =>
      (doc.title || '').toLowerCase().includes(q) ||
      (doc.author || '').toLowerCase().includes(q) ||
      String(doc.year || '').includes(q)
    );
  }

  // Sort docs with citations to top, then by citation count descending
  docs = [...docs].sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));

  const withCitations = docs.filter((d) => d.citationCount > 0).length;
  const headerEl = citationDocsTableEl.closest('.panel')?.querySelector('h2');
  if (headerEl) headerEl.textContent = `Dissertations (${withCitations} with parsed citations)`;

  citationDocsTableEl.innerHTML = docs
    .map((doc) => {
      const count = doc.citationCount || 0;
      const active = doc.id === state.citationDocId ? ' active' : '';
      const greyed = count === 0 ? ' greyed' : '';
      return `
        <tr class="citation-doc-row${active}${greyed}" data-cite-doc-id="${escapeHtml(doc.id)}">
          <td>${escapeHtml(doc.title || '(Untitled)')}</td>
          <td>${escapeHtml(doc.author || '')}</td>
          <td>${doc.year || '-'}</td>
          <td>${formatNum(count)}</td>
        </tr>
      `;
    })
    .join('');

  for (const row of citationDocsTableEl.querySelectorAll('.citation-doc-row')) {
    row.addEventListener('click', () => {
      selectCitationDoc(row.dataset.citeDocId);
    });
  }
}

async function selectCitationDoc(docId) {
  const requestToken = ++state.citationRequestToken;
  state.citationDocId = docId;
  renderCitationDocs();

  citationListTitleEl.textContent = 'Works Cited';
  citationEntriesEl.innerHTML = '<p class="meta">Loading citations...</p>';

  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(docId)}/citations`);
    if (requestToken !== state.citationRequestToken) return;
    if (!res.ok) {
      citationEntriesEl.innerHTML = '<p class="meta">Failed to load citations.</p>';
      return;
    }
    const data = await res.json();
    if (requestToken !== state.citationRequestToken) return;
    const citations = data.citations || [];
    if (!citations.length) {
      citationEntriesEl.innerHTML = '<p class="meta">No citations found.</p>';
      citationListTitleEl.textContent = 'Works Cited';
      return;
    }
    citationListTitleEl.textContent = `Works Cited (${citations.length})`;
    renderCitationList(citations);
  } catch {
    if (requestToken !== state.citationRequestToken) return;
    citationEntriesEl.innerHTML = '<p class="meta">Connection error.</p>';
  }
}

function catalogueBadge(citation) {
  if (citation.catalogue_hits == null) return '';
  if (citation.catalogue_hits > 0) {
    const label = `Found in UBC Library (${citation.catalogue_hits} hit${citation.catalogue_hits !== 1 ? 's' : ''})`;
    if (citation.catalogue_bib_id) {
      return `<a class="catalogue-badge held" href="https://webcat.library.ubc.ca/vwebv/holdingsInfo?bibId=${encodeURIComponent(citation.catalogue_bib_id)}" target="_blank" rel="noreferrer" title="${label}" onclick="event.stopPropagation()">UBC Library</a>`;
    }
    return `<span class="catalogue-badge held" title="${label}">UBC Library</span>`;
  }
  return `<button class="catalogue-badge summon-check-btn" data-citation-id="${escapeHtml(String(citation.id))}" title="Check UBC Summon for this item" onclick="event.stopPropagation()">Check Summon</button>`;
}

function openSummonModal(data, citationText) {
  summonModalTitleEl.textContent = citationText
    ? `Summon: ${citationText.slice(0, 80)}${citationText.length > 80 ? '\u2026' : ''}`
    : 'Summon Search Results';

  const itemsHtml = data.results.length
    ? data.results.map((r) => {
        const metaParts = [r.authors, r.year, r.contentType].filter(Boolean).join(' \u00B7 ');
        const holdingsBadge = r.inHoldings
          ? `<span class="catalogue-badge held">In UBC Library</span>`
          : `<span class="catalogue-badge not-held">Not held</span>`;
        const titleHtml = r.link
          ? `<a href="${escapeHtml(r.link)}" target="_blank" rel="noreferrer">${escapeHtml(r.title || '(No title)')}</a>`
          : escapeHtml(r.title || '(No title)');
        return `<div class="summon-result-item">
          <div class="summon-result-title">${titleHtml} ${holdingsBadge}</div>
          ${metaParts ? `<div class="summon-result-meta">${escapeHtml(metaParts)}</div>` : ''}
          ${r.snippet ? `<div class="summon-result-snippet">${escapeHtml(r.snippet)}</div>` : ''}
        </div>`;
      }).join('')
    : '<p class="meta">No results found in Summon.</p>';

  const footerHtml = `<div class="summon-result-footer">
    ${!data.found ? `<a href="${escapeHtml(data.illUrl)}" target="_blank" rel="noreferrer">Not found &mdash; request via ILL/DocDel &rarr;</a>` : '<span></span>'}
    <a href="${escapeHtml(data.searchUrl)}" target="_blank" rel="noreferrer">View all results in UBC Summon &rarr;</a>
  </div>`;

  summonResultsEl.innerHTML = itemsHtml + footerHtml;
  summonModalOverlayEl.hidden = false;
}

function attachSummonHandlers(container) {
  for (const btn of container.querySelectorAll('.summon-check-btn')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const citationId = btn.dataset.citationId;
      const citationText = btn.closest('[data-citation-text]')?.dataset.citationText || '';
      btn.textContent = 'Checking\u2026';
      btn.disabled = true;
      try {
        const res = await fetch(`/api/citations/${encodeURIComponent(citationId)}/summon-check`);
        const data = await res.json();
        // Replace button with a re-openable badge
        const badge = document.createElement('button');
        badge.className = `catalogue-badge summon-check-btn ${data.found ? 'held' : 'not-held'}`;
        badge.dataset.citationId = citationId;
        badge.title = data.found ? 'View Summon results' : 'Not found in UBC Library \u2014 view Summon results';
        badge.textContent = data.found ? 'Summon \u2713' : 'Not in Summon';
        badge.addEventListener('click', (ev) => { ev.stopPropagation(); openSummonModal(data, citationText); });
        btn.replaceWith(badge);
        openSummonModal(data, citationText);
      } catch {
        btn.textContent = 'Check Summon';
        btn.disabled = false;
      }
    });
  }
}

function renderCitationList(citations) {
  state.selectedCitationIds = new Set();
  const selectAllHtml = `<div class="citation-select-all"><label><input type="checkbox" id="selectAllCitations" /> Select all</label></div>`;
  citationEntriesEl.innerHTML = selectAllHtml + citations
    .map((c) => {
      const citeCount = Math.max(1, Number(c.total_docs) || 1);
      const badge = `<span class="citation-count">${formatNum(citeCount)}</span>`;
      return `<div class="citation-entry" title="${escapeHtml(c.citation_text)}" data-citation-id="${c.id}" data-citation-text="${escapeHtml(c.citation_text)}" data-citation-count="${citeCount}"><input type="checkbox" class="citation-entry-check" data-check-cite-id="${c.id}" />${escapeHtml(c.citation_text)}${badge}${catalogueBadge(c)}</div>`;
    })
    .join('');

  const selectAllCb = document.getElementById('selectAllCitations');
  selectAllCb.addEventListener('change', () => {
    for (const cb of citationEntriesEl.querySelectorAll('.citation-entry-check')) {
      cb.checked = selectAllCb.checked;
      const id = cb.dataset.checkCiteId;
      if (selectAllCb.checked) state.selectedCitationIds.add(id);
      else state.selectedCitationIds.delete(id);
    }
  });

  for (const cb of citationEntriesEl.querySelectorAll('.citation-entry-check')) {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.checkCiteId;
      if (cb.checked) state.selectedCitationIds.add(id);
      else state.selectedCitationIds.delete(id);
      const allChecks = citationEntriesEl.querySelectorAll('.citation-entry-check');
      const allChecked = Array.from(allChecks).every((c) => c.checked);
      selectAllCb.checked = allChecked;
      selectAllCb.indeterminate = !allChecked && state.selectedCitationIds.size > 0;
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
  }

  for (const entry of citationEntriesEl.querySelectorAll('.citation-entry[data-citation-id]')) {
    entry.addEventListener('click', (e) => {
      if (e.target.closest('.citation-entry-check')) return;
      showCitingDissertations(
        entry.dataset.citationId,
        entry.dataset.citationText,
        Number(entry.dataset.citationCount || 1)
      );
    });
  }

  attachSummonHandlers(citationEntriesEl);
}

async function showCitingDissertations(citationId, citationText, totalDocs = null) {
  try {
    const res = await fetch(`/api/citations/${encodeURIComponent(citationId)}/documents`);
    if (!res.ok) return;
    const data = await res.json();
    const docs = (data.documents || []).map((d) => ({
      id: d.id,
      title: d.title || '(Untitled)',
      author: d.author || 'Unknown',
    }));

    const shortText = citationText.length > 140 ? citationText.slice(0, 140) + '...' : citationText;
    const linkedCount = totalDocs === null ? docs.length : totalDocs;
    const list = docs.length
      ? `<div class="related-list">
          ${docs.map((d) => `
            <div class="related-item" data-cite-nav-id="${escapeHtml(d.id)}">
              <strong>${escapeHtml(d.title)}</strong>
              <p>${escapeHtml(d.author)}</p>
            </div>
          `).join('')}
        </div>`
      : '<p class="meta">No dissertations found for this citation.</p>';

    docDetailsEl.innerHTML = `
      <div class="meta">
        <p><strong>Citation:</strong> ${escapeHtml(shortText)}</p>
        <p><strong>Linked dissertations:</strong> ${formatNum(linkedCount)}</p>
        <p>${formatNum(docs.length)} dissertation(s) loaded from index</p>
      </div>
      ${list}
    `;

    for (const item of docDetailsEl.querySelectorAll('.related-item[data-cite-nav-id]')) {
      item.addEventListener('click', () => {
        const targetId = item.getAttribute('data-cite-nav-id');
        if (targetId) openRecord(targetId, 'citations');
      });
    }
    docModalOverlay.hidden = false;
  } catch {
    // silently fail
  }
}

// --- Export utilities ---

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeBibKey(text) {
  return String(text || 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

function generateBibTeX(docs) {
  return docs.map((doc) => {
    const key = `${sanitizeBibKey(doc.author)}${doc.year || ''}`;
    const lines = [`@phdthesis{${key},`];
    lines.push(`  author = {${(doc.author || 'Unknown').replace(/[{}]/g, '')}},`);
    lines.push(`  title = {${(doc.title || '').replace(/[{}]/g, '')}},`);
    if (doc.year) lines.push(`  year = {${doc.year}},`);
    lines.push(`  school = {University of British Columbia},`);
    if (doc.degree) lines.push(`  type = {${doc.degree.replace(/[{}]/g, '')}},`);
    if (doc.doi) lines.push(`  doi = {${doc.doi}},`);
    if (doc.uri) lines.push(`  url = {${doc.uri}},`);
    lines.push('}');
    return lines.join('\n');
  }).join('\n\n');
}

function generateRIS(docs) {
  return docs.map((doc) => {
    const lines = ['TY  - THES'];
    lines.push(`AU  - ${doc.author || 'Unknown'}`);
    lines.push(`TI  - ${doc.title || ''}`);
    if (doc.year) lines.push(`PY  - ${doc.year}`);
    lines.push('PB  - University of British Columbia');
    if (doc.degree) lines.push(`M3  - ${doc.degree}`);
    if (doc.doi) lines.push(`DO  - ${doc.doi}`);
    if (doc.uri) lines.push(`UR  - ${doc.uri}`);
    if (doc.abstract) lines.push(`AB  - ${doc.abstract.slice(0, 500)}`);
    lines.push('ER  - ');
    return lines.join('\n');
  }).join('\n');
}

function generateCitationBibTeX(citations) {
  return citations.map((text, i) => {
    const key = `cite${i + 1}`;
    return `@misc{${key},\n  note = {${text.replace(/[{}]/g, '')}}\n}`;
  }).join('\n\n');
}

function generateCitationRIS(citations) {
  return citations.map((text) => {
    return `TY  - GEN\nT1  - ${text}\nER  - `;
  }).join('\n');
}

// --- Foundational Works ---

async function loadFoundationalWorks() {
  if (!foundationalWorksListEl) return;
  foundationalWorksListEl.innerHTML = '<p class="meta">Loading...</p>';
  try {
    const res = await fetch('/api/citations/top?limit=50');
    if (!res.ok) {
      foundationalWorksListEl.innerHTML = '<p class="meta">Could not load foundational works.</p>';
      return;
    }
    const data = await res.json();
    renderFoundationalWorks(data.works || []);
  } catch {
    foundationalWorksListEl.innerHTML = '<p class="meta">Connection error.</p>';
  }
}

function renderFoundationalWorks(works) {
  if (!works.length) {
    foundationalWorksListEl.innerHTML = '<p class="meta">No works cited across multiple dissertations yet.</p>';
    return;
  }

  foundationalWorksListEl.innerHTML = works.map((w) => {
    const badge = w.catalogue_hits > 0
      ? (w.catalogue_bib_id
        ? `<a class="catalogue-badge held" href="https://webcat.library.ubc.ca/vwebv/holdingsInfo?bibId=${encodeURIComponent(w.catalogue_bib_id)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">UBC Library</a>`
        : '<span class="catalogue-badge held">UBC Library</span>')
      : '';
    return `
      <div class="foundational-work-item" data-citation-id="${w.id}" data-citation-text="${escapeHtml(w.citation_text)}" data-citation-count="${w.doc_count}">
        <span class="fw-rank-badge">${formatNum(w.doc_count)}</span>
        <span class="fw-text">${escapeHtml(w.citation_text)}${badge}</span>
      </div>
    `;
  }).join('');

  for (const item of foundationalWorksListEl.querySelectorAll('.foundational-work-item')) {
    item.addEventListener('click', () => {
      showCitingDissertations(
        item.dataset.citationId,
        item.dataset.citationText,
        Number(item.dataset.citationCount || 1)
      );
    });
  }
}

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
      topicClusterTooltipEl.hidden = false;
      topicClusterTooltipEl.innerHTML = `
        <div class="tooltip-title">${escapeHtml((doc.title || '').slice(0, 100))}</div>
        <div class="tooltip-meta">${doc.year || '\u2014'} \u00B7 ${escapeHtml(label)}</div>
      `;
      const rect = topicClusterContainerEl.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      topicClusterTooltipEl.style.left = (dotRect.left - rect.left + 12) + 'px';
      topicClusterTooltipEl.style.top = (dotRect.top - rect.top - 10) + 'px';
    });

    topicClusterChartEl.addEventListener('mouseout', e => {
      if (e.target.closest('.cluster-dot')) topicClusterTooltipEl.hidden = true;
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

// --- Supervisor Profiles ---

function buildSupervisorProfile(name, docs) {
  const supervised = docs.filter((d) => (d.supervisors || []).some((s) => s === name));
  const years = supervised.map((d) => d.year).filter(Boolean).sort((a, b) => a - b);
  const conceptMap = new Map();
  const methMap = new Map();
  for (const doc of supervised) {
    for (const c of (doc.conceptTerms || [])) {
      conceptMap.set(c, (conceptMap.get(c) || 0) + 1);
    }
    for (const m of (doc.methodologies || [])) {
      methMap.set(m, (methMap.get(m) || 0) + 1);
    }
  }
  const topConcepts = Array.from(conceptMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term, count]) => ({ term, count }));
  const methodologies = Array.from(methMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([methodology, count]) => ({ methodology, count }));

  return {
    name,
    count: supervised.length,
    yearRange: years.length ? `${years[0]}\u2013${years[years.length - 1]}` : '-',
    dissertations: supervised,
    topConcepts,
    methodologies
  };
}

function buildTopicSummary(docs) {
  const topicCounts = new Map();
  for (const doc of docs) {
    if (doc.topicId == null) continue;
    topicCounts.set(doc.topicId, (topicCounts.get(doc.topicId) || 0) + 1);
  }
  const topics = state.payload?.topicData?.topics || [];
  return Array.from(topicCounts.entries())
    .map(([topicId, count]) => {
      const topic = topics.find((t) => t.topicId === topicId);
      const label = topicId === -1 ? 'Uncategorized' : topicDisplayLabel(topic?.label || `Topic ${topicId}`);
      return { topicId, label, count };
    })
    .sort((a, b) => b.count - a.count);
}

function renderTopicTokens(docs) {
  const summary = buildTopicSummary(docs);
  if (!summary.length) return '';
  return summary.map((t) =>
    `<span class="token topic">${escapeHtml(t.label)} (${t.count})</span>`
  ).join('');
}

function renderSupervisorProfile(profile) {
  docModalTitleEl.textContent = `Supervisor: ${profile.name}`;

  const concepts = profile.topConcepts.length
    ? profile.topConcepts.map((c) => `<span class="token concept">${escapeHtml(c.term)} (${c.count})</span>`).join('')
    : '<span class="token concept">No concepts</span>';

  const maxMeth = Math.max(...profile.methodologies.map((m) => m.count), 1);
  const methBars = profile.methodologies.length
    ? profile.methodologies.map((m) => {
        const widthPct = (m.count / maxMeth) * 100;
        return `
          <div class="bar-row">
            <span class="bar-label">${escapeHtml(m.methodology)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
            <span class="bar-value">${formatNum(m.count)}</span>
          </div>
        `;
      }).join('')
    : '<p class="meta">No methodology signals.</p>';

  const dissertationList = profile.dissertations.length
    ? profile.dissertations.map((doc) => `
        <div class="related-item" data-related-id="${escapeHtml(doc.id)}">
          <strong>${escapeHtml(doc.title || '(Untitled)')}</strong>
          <p>${escapeHtml(doc.author || 'Unknown')} &middot; ${doc.year || '-'} &middot; ${escapeHtml(doc.degree || '-')}</p>
        </div>
      `).join('')
    : '<p class="meta">No dissertations found.</p>';

  const topicTokens = renderTopicTokens(profile.dissertations);

  docDetailsEl.innerHTML = `
    <div class="meta">
      <p><strong>${escapeHtml(profile.name)}</strong></p>
      <p>${formatNum(profile.count)} dissertation(s) &middot; ${profile.yearRange}</p>
    </div>
    ${topicTokens ? `<div><p class="detail-section-title">Topics</p><div class="token-list">${topicTokens}</div></div>` : ''}
    <div>
      <p class="detail-section-title">Top Concepts</p>
      <div class="token-list">${concepts}</div>
    </div>
    <div>
      <p class="detail-section-title">Methodologies</p>
      <div class="bars">${methBars}</div>
    </div>
    <div>
      <p class="detail-section-title">Supervised Dissertations</p>
      <div class="related-list">${dissertationList}</div>
    </div>
  `;

  for (const item of docDetailsEl.querySelectorAll('.related-item[data-related-id]')) {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-related-id');
      if (targetId) openRecord(targetId, 'records');
    });
  }
  docModalOverlay.hidden = false;
}

function openSupervisorProfile(name) {
  const docs = state.payload?.documents || [];
  const profile = buildSupervisorProfile(name, docs);
  renderSupervisorProfile(profile);
}

// --- Person Explorer ---

function isValidPersonName(name) {
  if (!name) return false;
  const n = name.trim();
  if (n.length < 3) return false;
  const words = n.split(/\s+/);
  if (words.length < 2) return false;
  if (/^(University|UBC|SFU|Columbia|of\s|&\s|Research$)/i.test(n)) return false;
  if (words.every(w => w.replace(/\./g, '').length <= 2)) return false;
  return true;
}

function buildPersonList(docs) {
  const people = new Map();

  for (const doc of docs) {
    const docPersonKeys = new Set();

    // Process supervisors
    for (const name of (doc.supervisors || [])) {
      if (!isValidPersonName(name)) continue;
      const key = name.toLowerCase().trim();
      if (!key) continue;
      docPersonKeys.add(key);
      let person = people.get(key);
      if (!person) {
        person = { name, roles: new Set(), docs: [], affiliations: new Set(), conceptMap: new Map(), methMap: new Map(), coSupervisors: new Set() };
        people.set(key, person);
      }
      person.roles.add('Supervisor');
      person.docs.push(doc);
      for (const c of (doc.conceptTerms || [])) person.conceptMap.set(c, (person.conceptMap.get(c) || 0) + 1);
      for (const m of (doc.methodologies || [])) person.methMap.set(m, (person.methMap.get(m) || 0) + 1);
      // Track co-supervisors
      for (const other of (doc.supervisors || [])) {
        const otherKey = other.toLowerCase().trim();
        if (otherKey && otherKey !== key) person.coSupervisors.add(other);
      }
    }

    // Process committee members
    for (const member of (doc.committee || [])) {
      const name = member.name;
      if (!isValidPersonName(name)) continue;
      const key = name.toLowerCase().trim();
      if (!key) continue;
      let person = people.get(key);
      if (!person) {
        person = { name, roles: new Set(), docs: [], affiliations: new Set(), conceptMap: new Map(), methMap: new Map(), coSupervisors: new Set() };
        people.set(key, person);
      }
      const role = member.role || 'Committee Member';
      person.roles.add(role);
      if (member.affiliation) {
        const norm = normalizeAffiliation(member.affiliation);
        if (norm) person.affiliations.add(norm);
      }
      // Only add doc if not already counted from supervisors
      if (!docPersonKeys.has(key)) {
        person.docs.push(doc);
        for (const c of (doc.conceptTerms || [])) person.conceptMap.set(c, (person.conceptMap.get(c) || 0) + 1);
        for (const m of (doc.methodologies || [])) person.methMap.set(m, (person.methMap.get(m) || 0) + 1);
      }
      docPersonKeys.add(key);
    }
  }

  // Derive final fields
  const result = [];
  for (const [key, p] of people) {
    const years = p.docs.map(d => d.year).filter(Boolean).sort((a, b) => a - b);
    const topConcepts = Array.from(p.conceptMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([term, count]) => ({ term, count }));
    const methodologies = Array.from(p.methMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([methodology, count]) => ({ methodology, count }));
    result.push({
      key,
      name: p.name,
      roles: Array.from(p.roles),
      docCount: p.docs.length,
      docs: p.docs,
      affiliations: mergeAffiliations(Array.from(p.affiliations)),
      yearRange: years.length ? `${years[0]}\u2013${years[years.length - 1]}` : '\u2013',
      yearMin: years[0] || 9999,
      topConcepts,
      methodologies,
      coSupervisors: Array.from(p.coSupervisors),
    });
  }

  return result;
}

function getPersonList() {
  if (!state.payload) return [];
  const { degree, program, affiliation } = state.activeFilters;
  const key = `${degree}\0${program}\0${affiliation}`;
  if (_personListCache && _personListCacheKey === key) return _personListCache;
  _personListCache = buildPersonList(getFilteredDocs());
  _personListCacheKey = key;
  return _personListCache;
}

function renderPersonTable() {
  if (!personTableEl) return;
  let people = getPersonList();

  // Role filter
  if (state.personRoleFilter) {
    people = people.filter(p => p.roles.includes(state.personRoleFilter));
  }

  // Text filter
  if (state.personFilterText) {
    const q = state.personFilterText.toLowerCase();
    people = people.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.roles.some(r => r.toLowerCase().includes(q)) ||
      p.affiliations.some(a => a.toLowerCase().includes(q))
    );
  }

  // Sort
  const dir = state.personSortDir === 'asc' ? 1 : -1;
  people = [...people].sort((a, b) => {
    switch (state.personSortKey) {
      case 'name': {
        const cmp = a.name.localeCompare(b.name);
        return cmp * dir;
      }
      case 'docCount': {
        const cmp = a.docCount - b.docCount || a.name.localeCompare(b.name);
        return cmp * dir;
      }
      case 'roles': {
        const cmp = a.roles.join(', ').localeCompare(b.roles.join(', '));
        return cmp * dir;
      }
      case 'years': {
        const cmp = a.yearMin - b.yearMin || a.name.localeCompare(b.name);
        return cmp * dir;
      }
      default: return 0;
    }
  });

  // Update sort header indicators
  for (const th of personSortHeaders) {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.personSort === state.personSortKey) {
      th.classList.add(state.personSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  }

  // Render rows
  personTableEl.innerHTML = people.map(p => `
    <tr class="doc-row${state.selectedPersonKey === p.key ? ' active' : ''}" data-person-key="${escapeHtml(p.key)}">
      <td>${escapeHtml(p.name)}</td>
      <td>${p.docCount}</td>
      <td><div class="token-list">${p.roles.map(r => `<span class="token">${escapeHtml(r)}</span>`).join('')}</div></td>
      <td>${escapeHtml(p.yearRange)}</td>
    </tr>
  `).join('');

  // Count
  personCountEl.textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;
}

function renderPersonDetail(personKey) {
  if (!personDetailEl) return;
  const people = getPersonList();
  const person = people.find(p => p.key === personKey);
  if (!person) {
    personDetailEl.innerHTML = '<p class="meta">Select a person to view their profile.</p>';
    return;
  }

  const concepts = person.topConcepts.length
    ? person.topConcepts.map(c => `<span class="token concept clickable" data-person-concept="${escapeHtml(c.term)}">${escapeHtml(c.term)} (${c.count})</span>`).join('')
    : '<span class="token">No concepts</span>';

  const maxMeth = Math.max(...person.methodologies.map(m => m.count), 1);
  const methBars = person.methodologies.length
    ? person.methodologies.map(m => {
        const widthPct = (m.count / maxMeth) * 100;
        return `
          <div class="bar-row">
            <span class="bar-label">${escapeHtml(m.methodology)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
            <span class="bar-value">${formatNum(m.count)}</span>
          </div>
        `;
      }).join('')
    : '<p class="meta">No methodology signals.</p>';

  const rolesHtml = person.roles.map(r => `<span class="token">${escapeHtml(r)}</span>`).join(' ');
  const affiliationsHtml = person.affiliations.length
    ? person.affiliations.map(a => `<span class="token">${escapeHtml(a)}</span>`).join(' ')
    : '';

  const coSupHtml = person.coSupervisors.length
    ? person.coSupervisors.map(name =>
        `<button class="supervisor-link" data-person-nav="${escapeHtml(name.toLowerCase().trim())}">${escapeHtml(name)}</button>`
      ).join(', ')
    : '';

  const dissertationList = person.docs.length
    ? person.docs.map(doc => `
        <div class="related-item" data-related-id="${escapeHtml(doc.id)}">
          <strong>${escapeHtml(doc.title || '(Untitled)')}</strong>
          <p>${escapeHtml(doc.author || 'Unknown')} &middot; ${doc.year || '-'} &middot; ${escapeHtml(doc.degree || '-')}</p>
        </div>
      `).join('')
    : '<p class="meta">No dissertations found.</p>';

  personDetailEl.innerHTML = `
    <h2 style="margin-bottom:0.3rem">${escapeHtml(person.name)}</h2>
    <div class="meta">
      <p>${formatNum(person.docCount)} dissertation(s) &middot; ${person.yearRange}</p>
    </div>
    <div class="detail-body">
      <div>
        <p class="detail-section-title">Roles</p>
        <div class="token-list">${rolesHtml}</div>
      </div>
      ${affiliationsHtml ? `<div><p class="detail-section-title">Affiliations</p><div class="token-list">${affiliationsHtml}</div></div>` : ''}
      ${(() => {
        const summary = buildTopicSummary(person.docs);
        if (!summary.length) return '';
        const tt = summary.map(t =>
          `<span class="token topic clickable" data-person-topic="${t.topicId}">${escapeHtml(t.label)} (${t.count})</span>`
        ).join('');
        return `<div><p class="detail-section-title">Topics</p><div class="token-list">${tt}</div></div>`;
      })()}
      <div>
        <p class="detail-section-title">Top Concepts</p>
        <div class="token-list">${concepts}</div>
      </div>
      <div>
        <p class="detail-section-title">Methodologies</p>
        <div class="bars">${methBars}</div>
      </div>
      ${coSupHtml ? `<div><p class="detail-section-title">Co-Supervisors</p><div class="token-list">${coSupHtml}</div></div>` : ''}
      <div>
        <p class="detail-section-title">Dissertations</p>
        <div class="related-list">${dissertationList}</div>
      </div>
    </div>
  `;

  // Wire dissertation clicks
  for (const item of personDetailEl.querySelectorAll('.related-item[data-related-id]')) {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-related-id');
      if (targetId) openRecord(targetId, 'records');
    });
  }

  // Wire co-supervisor navigation
  for (const link of personDetailEl.querySelectorAll('[data-person-nav]')) {
    link.addEventListener('click', () => {
      const targetKey = link.getAttribute('data-person-nav');
      if (targetKey) openPersonProfile(targetKey);
    });
  }

  // Wire concept pill clicks → show matching dissertations for this person
  for (const pill of personDetailEl.querySelectorAll('[data-person-concept]')) {
    pill.style.cursor = 'pointer';
    pill.addEventListener('click', () => {
      const term = pill.getAttribute('data-person-concept');
      const matches = person.docs.filter(d => (d.conceptTerms || []).includes(term));
      openMatchesModal(`${person.name} — "${term}"`, matches);
    });
  }

  // Wire topic pill clicks → show matching dissertations for this person
  for (const pill of personDetailEl.querySelectorAll('[data-person-topic]')) {
    pill.style.cursor = 'pointer';
    pill.addEventListener('click', () => {
      const topicId = Number(pill.getAttribute('data-person-topic'));
      const matches = person.docs.filter(d => d.topicId === topicId);
      const label = pill.textContent.replace(/\s*\(\d+\)\s*$/, '');
      openMatchesModal(`${person.name} — ${label}`, matches);
    });
  }
}

function openPersonProfile(nameOrKey) {
  state.selectedPersonKey = nameOrKey.toLowerCase().trim();
  setActiveTab('people');
  renderPersonTable();
  renderPersonDetail(state.selectedPersonKey);
  // Scroll selected row into view
  const activeRow = personTableEl?.querySelector('.doc-row.active');
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
}

// --- Methodology-Concept Matrix ---

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

  const headerCells = data.concepts
    .map((c) => `<th class="heatmap-header">${escapeHtml(c)}</th>`)
    .join('');

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

// --- Research Gaps ---

function renderResearchGaps() {
  const gaps = getAnalytics()?.researchGaps || [];
  if (!gaps.length) {
    if (researchGapsListEl) researchGapsListEl.innerHTML = '<p style="color:var(--ink-soft);font-family:var(--sans);font-size:0.85rem">No research gap data available.</p>';
    return;
  }

  const maxScore = Math.max(...gaps.map((g) => g.gapScore), 1);

  researchGapsListEl.innerHTML = gaps.map((entry) => {
    const widthPct = (entry.gapScore / maxScore) * 100;
    const label = `${entry.conceptA} + ${entry.conceptB}`;
    return `
      <div class="bar-row">
        <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <div class="bar-track"><div class="bar-fill gap-fill" style="width:${widthPct}%"></div></div>
        <span class="bar-value">${formatNum(Math.round(entry.gapScore))}</span>
      </div>
    `;
  }).join('');

}

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

    if (year) {
      if (!byYearCountMap.has(year)) {
        byYearPagesMap.set(year, []); byYearWordsMap.set(year, []); byYearCountMap.set(year, 0);
      }
      if (pages) byYearPagesMap.get(year).push(pages);
      if (wordCount) byYearWordsMap.get(year).push(wordCount);
      byYearCountMap.set(year, byYearCountMap.get(year) + 1);
    }

    for (const t of themes) themeMap.set(t, (themeMap.get(t) || 0) + 1);

    for (const t of conceptTerms) {
      ngramMap.set(t, (ngramMap.get(t) || 0) + 1);
      if (!conceptDocMap.has(t)) conceptDocMap.set(t, { sum: 0, count: 0 });
      const e = conceptDocMap.get(t);
      e.sum += wordCount || 0; e.count += 1;
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
  });

  const avgPagesByYear = sortedYears.map(year => {
    const ps = statsOf(byYearPagesMap.get(year));
    return { year, mean: ps.mean, min: ps.min, max: ps.max, count: ps.count };
  });

  const pageTrend = sortedYears.map(year => {
    const ps = statsOf(byYearPagesMap.get(year));
    return { year, median: ps.median, min: ps.min, max: ps.max, count: ps.count };
  });

  const byConcept = Array.from(conceptDocMap.entries())
    .map(([concept, { sum, count }]) => ({ concept, weightedMean: count ? Math.round(sum / count) : 0, docCount: count }))
    .sort((a, b) => b.weightedMean - a.weightedMean)
    .slice(0, 20);

  const overallPageCount = statsOf(docs.map(d => d.pages).filter(Boolean));
  const overallWordCount = statsOf(docs.map(d => d.wordCount).filter(Boolean));

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

  const top30 = ngramCloud.slice(0, 30).map(w => ({ term: w.term, count: w.count }));
  const researchGaps = [];
  for (let i = 0; i < top30.length; i++) {
    for (let j = i + 1; j < top30.length; j++) {
      const { term: tA, count: cA } = top30[i];
      const { term: tB, count: cB } = top30[j];
      const key = tA < tB ? `${tA}\0${tB}` : `${tB}\0${tA}`;
      const cooc = pairMap.get(key) || 0;
      researchGaps.push({ conceptA: tA, conceptB: tB, gapScore: (cA * cB) / (cooc + 1) });
    }
  }
  researchGaps.sort((a, b) => b.gapScore - a.gapScore);

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

  return { metrics, wordCloud, ngramCloud, methodologies, supervisorNgramMatrix, termCooccurrence, conceptTimeline, methodologyConceptMatrix, researchGaps: researchGaps.slice(0, 15), supervisorNetwork, citationCooccurrence, methodologyTopicMatrix, topicData };
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

function renderAll() {
  renderDocuments();
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
  renderResearchGaps();
  if (document.querySelector('.analytics-tab-section#analytics-visualizations.active')) {
    renderTopicCluster();
    renderTopicDendrogram();
    renderTopicSankey();
    renderMethTopicBubble();
  }
  if (document.querySelector('#tab-people.active')) renderPersonTable();
}

// --- Data loading ---

async function loadData({ refresh = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  loadBtn.disabled = true;
  refreshBtn.disabled = true;
  showSpinner(true);
  facetFilterBarEl.hidden = true;

  const params = getCurrentParams();
  if (refresh) params.refresh = '1';

  setStatus('Loading records from UBC Open Collections...');

  try {
    const query = new URLSearchParams(params);
    const res = await fetch(`/api/metrics?${query.toString()}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || err.error || `Request failed with ${res.status}`);
    }

    state.payload = await res.json();
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

    const docs = state.payload.documents || [];
    const statusCounts = docs.reduce((acc, doc) => {
      const key = doc.downloadStatus || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const parts = [];
    if (statusCounts.cached) parts.push(`${statusCounts.cached} cached`);
    if (statusCounts.downloaded) parts.push(`${statusCounts.downloaded} downloaded`);
    if (statusCounts.not_found) parts.push(`${statusCounts.not_found} not found`);
    if (statusCounts.skipped) parts.push(`${statusCounts.skipped} skipped`);
    const otherCount = docs.length - parts.reduce((s, p) => s + parseInt(p), 0);
    if (otherCount > 0 && parts.length) parts.push(`${otherCount} other`);

    const summary = parts.length ? ` (${parts.join(', ')})` : '';
    const time = new Date(state.payload.generatedAt).toLocaleString();
    setStatus(`${formatNum(state.payload.metrics.recordCount)} documents loaded${summary}. Generated ${time}.`);
  } catch (error) {
    setStatus(`Failed to load data: ${error.message}`, true);
  } finally {
    state.loading = false;
    loadBtn.disabled = false;
    refreshBtn.disabled = false;
    showSpinner(false);
  }
}

// --- Auth ---

async function checkSession() {
  try {
    const res = await fetch('/api/auth/session');
    if (res.ok) {
      const data = await res.json();
      state.user = { username: data.username };
      showAdminContent();
    } else {
      state.user = null;
      showLoginGate();
    }
  } catch {
    state.user = null;
    showLoginGate();
  }
}

function showLoginGate() {
  loginGate.hidden = false;
  adminContent.hidden = true;
}

function showAdminContent() {
  loginGate.hidden = true;
  adminContent.hidden = false;
  adminUserLabel.textContent = `Signed in as ${state.user.username}`;
  loadAdminData();
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  loginError.hidden = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      loginError.textContent = data.error || 'Login failed';
      loginError.hidden = false;
      return;
    }
    state.user = { username: data.username };
    loginForm.reset();
    showAdminContent();
  } catch (err) {
    loginError.textContent = 'Connection error';
    loginError.hidden = false;
  }
}

async function handleLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch { /* ignore */ }
  state.user = null;
  showLoginGate();
}

// --- Admin data loading ---

async function loadAdminData() {
  await Promise.all([loadUsers(), loadCache(), loadRuns(), loadSettings(), loadConceptPipelineStatus()]);
}

async function loadUsers() {
  try {
    const res = await fetch('/api/admin/users');
    if (!res.ok) return;
    const data = await res.json();
    renderUsers(data.users);
  } catch { /* ignore */ }
}

function renderUsers(users) {
  const el = document.getElementById('usersContent');
  if (!users?.length) {
    el.innerHTML = '<p class="meta">No users found.</p>';
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Username</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${escapeHtml(u.username)}</td>
            <td>${new Date(u.created_at).toLocaleString()}</td>
            <td><button class="btn danger btn-sm" data-delete-user="${escapeHtml(u.username)}">Delete</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  for (const btn of el.querySelectorAll('[data-delete-user]')) {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.deleteUser;
      if (!confirm(`Delete user "${username}"?`)) return;
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Delete failed');
          return;
        }
        await loadUsers();
      } catch { alert('Connection error'); }
    });
  }
}

async function handleCreateUser(e) {
  e.preventDefault();
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  createUserError.hidden = true;

  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      createUserError.textContent = data.errors ? data.errors.join(' ') : data.error || 'Create failed';
      createUserError.hidden = false;
      return;
    }
    createUserForm.reset();
    await loadUsers();
  } catch {
    createUserError.textContent = 'Connection error';
    createUserError.hidden = false;
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/admin/settings');
    if (!res.ok) return;
    const data = await res.json();
    const s = data.settings || {};
    if (s.index) document.getElementById('s-index').value = s.index;
    if (s.query) document.getElementById('s-query').value = s.query;
    if (s.term) document.getElementById('s-term').value = s.term;
    if (s.source) document.getElementById('s-source').value = s.source;
    if (s.maxRecords) document.getElementById('s-maxRecords').value = s.maxRecords;
    if (s.pageSize) document.getElementById('s-pageSize').value = s.pageSize;
    if (s.scanLimit) document.getElementById('s-scanLimit').value = s.scanLimit;
    if (s.subjectLimit) document.getElementById('s-subjectLimit').value = s.subjectLimit;
    const apiKeyInput = document.getElementById('s-apiKey');
    apiKeyInput.value = '';
    apiKeyInput.placeholder = s.apiKeyConfigured
      ? 'Stored on server (enter a new key to replace)'
      : 'No API key saved (optional)';
    if (s.downloadFiles) document.getElementById('s-downloadFiles').value = s.downloadFiles;
    if (s.recomputeFromCache) document.getElementById('s-recomputeFromCache').value = s.recomputeFromCache;
  } catch { /* ignore */ }
}

async function handleSaveSettings() {
  const params = getCurrentParams({ includeApiKey: true });
  if (!params.apiKey) delete params.apiKey;
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    });
    if (res.ok) {
      setStatus('Settings saved.');
    }
  } catch { /* ignore */ }
}

function renderConceptPipelineStatus(status) {
  if (!conceptPipelineStatusEl) return;
  if (!status) {
    conceptPipelineStatusEl.textContent = 'Concept pipeline status unavailable.';
    return;
  }
  const stateLabel = status.status || 'idle';
  const updated = status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : 'never';
  const message = status.message || '';
  conceptPipelineStatusEl.textContent = `Concept Pipeline: ${stateLabel}. Last success: ${updated}. ${message}`.trim();
}

async function loadConceptPipelineStatus() {
  try {
    const res = await fetch('/api/admin/concepts/status');
    if (!res.ok) return;
    const data = await res.json();
    renderConceptPipelineStatus(data.status);
  } catch { /* ignore */ }
}

async function handleRebuildConcepts() {
  if (!rebuildConceptsBtn) return;
  rebuildConceptsBtn.disabled = true;
  rebuildConceptsBtn.textContent = 'Rebuilding...';
  try {
    const res = await fetch('/api/admin/concepts/rebuild', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Concept rebuild failed');
      return;
    }
    const aliases = data.stats?.aliases ?? '?';
    setStatus(`Concept rebuild complete (${aliases} aliases).`);
    await loadConceptPipelineStatus();
  } catch {
    alert('Connection error');
  } finally {
    rebuildConceptsBtn.disabled = false;
    rebuildConceptsBtn.textContent = 'Rebuild Concepts';
  }
}

async function loadCache() {
  try {
    const [entriesRes, statsRes] = await Promise.all([
      fetch('/api/admin/cache'),
      fetch('/api/admin/cache/stats')
    ]);
    if (!entriesRes.ok || !statsRes.ok) return;
    const entriesData = await entriesRes.json();
    const statsData = await statsRes.json();
    renderCacheStats(statsData.stats);
    renderCache(entriesData.entries);
  } catch { /* ignore */ }
}

function renderCacheStats(stats) {
  const el = document.getElementById('cacheStats');
  if (!stats) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    Total entries: <strong>${formatNum(stats.total)}</strong> &middot;
    With PDF: <strong>${formatNum(stats.with_pdf)}</strong> &middot;
    Failed: <strong>${formatNum(stats.failed)}</strong> &middot;
    Total size: <strong>${formatBytes(stats.total_bytes)}</strong>
  `;
}

function renderCache(entries) {
  const el = document.getElementById('cacheTable');
  if (!entries?.length) {
    el.innerHTML = '<tr><td colspan="7">No cache entries.</td></tr>';
    return;
  }
  el.innerHTML = entries.slice(0, 200).map((e) => `
    <tr>
      <td title="${escapeHtml(e.doc_id)}">${escapeHtml(String(e.doc_id).slice(0, 30))}</td>
      <td>${escapeHtml(e.status || '-')}</td>
      <td>${formatBytes(e.file_bytes)}</td>
      <td>${formatNum(e.page_count)}</td>
      <td>${formatNum(e.word_count)}</td>
      <td>${e.updated_at ? new Date(e.updated_at).toLocaleDateString() : '-'}</td>
      <td>
        <button class="btn ghost btn-sm" data-refresh-cache="${escapeHtml(e.doc_id)}">Refresh</button>
        <button class="btn danger btn-sm" data-delete-cache="${escapeHtml(e.doc_id)}">Del</button>
      </td>
    </tr>
  `).join('');

  for (const btn of el.querySelectorAll('[data-refresh-cache]')) {
    btn.addEventListener('click', async () => {
      const docId = btn.dataset.refreshCache;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await fetch(`/api/admin/cache/${encodeURIComponent(docId)}/refresh`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Refresh failed');
          return;
        }
        // Update in-memory document state so Explorer reflects new metrics
        const localDoc = (state.payload?.documents || []).find((d) => d.id === docId);
        if (localDoc) {
          if (data.pages != null) { localDoc.pages = data.pages; localDoc.pagesSource = data.pagesSource; }
          if (data.wordCount != null) { localDoc.wordCount = data.wordCount; localDoc.wordCountSource = data.wordCountSource; }
          localDoc.fileBytes = data.fileBytes ?? localDoc.fileBytes;
          localDoc.downloadUrl = data.downloadUrl ?? localDoc.downloadUrl;
          localDoc.downloadStatus = data.status;
          localDoc.downloadError = data.downloadError ?? null;
          renderDocuments();
        }
        setStatus(`PDF refreshed for ${docId} (${data.status})`);
        await loadCache();
      } catch {
        alert('Connection error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Refresh';
      }
    });
  }

  for (const btn of el.querySelectorAll('[data-delete-cache]')) {
    btn.addEventListener('click', async () => {
      const docId = btn.dataset.deleteCache;
      try {
        const res = await fetch(`/api/admin/cache/${encodeURIComponent(docId)}`, { method: 'DELETE' });
        if (res.ok) await loadCache();
      } catch { /* ignore */ }
    });
  }
}

async function handleRefreshCache() {
  try {
    await fetch('/api/admin/cache/refresh', { method: 'POST' });
    setStatus('In-memory cache cleared. Next query will re-fetch.');
  } catch { /* ignore */ }
}

async function handleReparseAll() {
  reparseAllBtn.disabled = true;
  reparseAllBtn.textContent = 'Reparsing...';
  try {
    const res = await fetch('/api/admin/reparse-all', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Reparse failed');
      return;
    }
    setStatus(`Reparsed ${data.processed} PDFs. Found committees in ${data.committees}, citations in ${data.citations}.`);
  } catch {
    alert('Connection error');
  } finally {
    reparseAllBtn.disabled = false;
    reparseAllBtn.textContent = 'Reparse All PDFs';
  }
}

async function loadRuns() {
  try {
    const res = await fetch('/api/admin/runs');
    if (!res.ok) return;
    const data = await res.json();
    renderRuns(data.runs);
  } catch { /* ignore */ }
}

function renderRuns(runs) {
  const el = document.getElementById('runsTable');
  if (!runs?.length) {
    el.innerHTML = '<tr><td colspan="4">No runs recorded.</td></tr>';
    return;
  }
  el.innerHTML = runs.slice(0, 50).map((r) => {
    let summary = '-';
    try {
      const s = JSON.parse(r.source_json);
      summary = `index=${s.index || s.requestedIndex || '?'}, max=${s.maxRecords || '?'}`;
      if (s.term) summary += `, term=${String(s.term).slice(0, 40)}`;
    } catch { /* ignore */ }
    return `
      <tr>
        <td>${r.id}</td>
        <td title="${escapeHtml(r.run_key)}">${escapeHtml(String(r.run_key).slice(0, 12))}...</td>
        <td>${new Date(r.created_at).toLocaleString()}</td>
        <td>${escapeHtml(summary)}</td>
      </tr>
    `;
  }).join('');
}

// --- Event bindings ---

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loadData();
  setActiveTab('records');
});

refreshBtn.addEventListener('click', () => {
  loadData({ refresh: true });
});

saveSettingsBtn.addEventListener('click', handleSaveSettings);
rebuildConceptsBtn.addEventListener('click', handleRebuildConcepts);

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    setActiveTab(btn.dataset.tab);
    if (btn.dataset.tab === 'admin') checkSession();
  });
}

for (const btn of adminTabButtons) {
  btn.addEventListener('click', () => setActiveAdminTab(btn.dataset.adminTab));
}

for (const btn of citationTabButtons) {
  btn.addEventListener('click', () => setActiveCitationTab(btn.dataset.citationTab));
}

for (const btn of analyticsTabButtons) {
  btn.addEventListener('click', () => setActiveAnalyticsTab(btn.dataset.analyticsTab));
}

// Sort headers
for (const th of docTheadRow.querySelectorAll('th.sortable')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sortKey;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'asc';
    }
    renderDocuments();
  });
}

// Filter input
docFilterEl.addEventListener('input', () => {
  state.filterText = docFilterEl.value.trim();
  renderDocuments();
});

citationDocFilterEl.addEventListener('input', () => {
  state.citationFilterText = citationDocFilterEl.value.trim();
  renderCitationDocs();
});

docModalCloseBtn.addEventListener('click', closeDocModal);
docModalOverlay.addEventListener('click', (e) => {
  if (e.target === docModalOverlay) closeDocModal();
});
summonModalCloseBtn.addEventListener('click', () => { summonModalOverlayEl.hidden = true; });
summonModalOverlayEl.addEventListener('click', (e) => {
  if (e.target === summonModalOverlayEl) summonModalOverlayEl.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!summonModalOverlayEl.hidden) { summonModalOverlayEl.hidden = true; return; }
    if (!docModalOverlay.hidden) closeDocModal();
  }
});

loginForm.addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', handleLogout);
createUserForm.addEventListener('submit', handleCreateUser);
refreshCacheBtn.addEventListener('click', handleRefreshCache);
reparseAllBtn.addEventListener('click', handleReparseAll);

// Keyboard navigation for document table
documentsTableEl.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const docs = state.payload?.documents || [];
  if (!docs.length) return;
  const currentIndex = docs.findIndex((d) => d.id === state.selectedDocId);
  let nextIndex = currentIndex;
  if (e.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, docs.length - 1);
  if (e.key === 'ArrowUp') nextIndex = Math.max(currentIndex - 1, 0);
  if (nextIndex !== currentIndex) {
    openRecord(docs[nextIndex].id, 'records');
    const row = documentsTableEl.querySelector(`[data-doc-id="${CSS.escape(docs[nextIndex].id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }
});

// Export buttons
exportBibTeXBtn.addEventListener('click', () => {
  const all = getFilteredSortedDocs();
  const docs = state.selectedDocIds.size > 0 ? all.filter((d) => state.selectedDocIds.has(d.id)) : all;
  if (!docs.length) return;
  downloadFile(generateBibTeX(docs), 'dissertations.bib', 'application/x-bibtex');
});

exportRISBtn.addEventListener('click', () => {
  const all = getFilteredSortedDocs();
  const docs = state.selectedDocIds.size > 0 ? all.filter((d) => state.selectedDocIds.has(d.id)) : all;
  if (!docs.length) return;
  downloadFile(generateRIS(docs), 'dissertations.ris', 'application/x-research-info-systems');
});

function getSelectedCitationTexts() {
  const entries = Array.from(citationEntriesEl.querySelectorAll('.citation-entry[data-citation-text]'));
  if (state.selectedCitationIds.size > 0) {
    return entries.filter((el) => state.selectedCitationIds.has(el.dataset.citationId)).map((el) => el.dataset.citationText);
  }
  return entries.map((el) => el.dataset.citationText);
}

exportCitationBibTeXBtn.addEventListener('click', () => {
  const texts = getSelectedCitationTexts();
  if (!texts.length) return;
  downloadFile(generateCitationBibTeX(texts), 'citations.bib', 'application/x-bibtex');
});

exportCitationRISBtn.addEventListener('click', () => {
  const texts = getSelectedCitationTexts();
  if (!texts.length) return;
  downloadFile(generateCitationRIS(texts), 'citations.ris', 'application/x-research-info-systems');
});

// Select-all docs checkbox
selectAllDocsEl.addEventListener('change', () => {
  const visibleChecks = documentsTableEl.querySelectorAll('.doc-row-check');
  for (const cb of visibleChecks) {
    const id = cb.dataset.checkId;
    if (selectAllDocsEl.checked) {
      cb.checked = true;
      state.selectedDocIds.add(id);
    } else {
      cb.checked = false;
      state.selectedDocIds.delete(id);
    }
  }
});

// Facet filter handlers
function onFacetChange() {
  state.activeFilters.degree      = filterDegreeEl.value;
  state.activeFilters.program     = filterProgramEl.value;
  state.activeFilters.affiliation = filterAffiliationEl.value;
  updateFacetCount();
  // Deselect docs that are no longer in the filtered set
  if (!getFilteredDocs().some(d => d.id === state.selectedDocId)) state.selectedDocId = null;
  if (!getFilteredDocs().some(d => d.id === state.citationDocId)) {
    state.citationDocId = null;
    citationEntriesEl.innerHTML = '<p class="meta">Select a document to view its works cited.</p>';
    citationListTitleEl.textContent = 'Works Cited';
  }
  renderAll();
  if (document.querySelector('#tab-citations.active')) renderCitationDocs();
}
filterDegreeEl.addEventListener('change', onFacetChange);
filterProgramEl.addEventListener('change', onFacetChange);
filterAffiliationEl.addEventListener('change', onFacetChange);
clearFacetsBtn.addEventListener('click', () => {
  filterDegreeEl.value = filterProgramEl.value = filterAffiliationEl.value = '';
  onFacetChange();
});
facetChipsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.facet-chip-remove');
  if (!btn) return;
  const key = btn.dataset.chipKey;
  if (key === 'degree')      filterDegreeEl.value = '';
  if (key === 'program')     filterProgramEl.value = '';
  if (key === 'affiliation') filterAffiliationEl.value = '';
  onFacetChange();
});

// Delegated row click — navigate to document
documentsTableEl.addEventListener('click', (e) => {
  if (e.target.closest('.doc-row-check')) return;
  const row = e.target.closest('.doc-row');
  if (row) openRecord(row.dataset.docId, 'records');
});

// Delegated checkbox change — update selection state
documentsTableEl.addEventListener('change', (e) => {
  const cb = e.target.closest('.doc-row-check');
  if (!cb) return;
  const id = cb.dataset.checkId;
  if (cb.checked) state.selectedDocIds.add(id);
  else state.selectedDocIds.delete(id);
  syncSelectAllDocs();
});

// Person Explorer event wiring
personTableEl.addEventListener('click', (e) => {
  const row = e.target.closest('.doc-row');
  if (!row) return;
  state.selectedPersonKey = row.dataset.personKey;
  renderPersonTable();
  renderPersonDetail(state.selectedPersonKey);
});

for (const th of personSortHeaders) {
  th.addEventListener('click', () => {
    const key = th.dataset.personSort;
    if (state.personSortKey === key) {
      state.personSortDir = state.personSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.personSortKey = key;
      state.personSortDir = key === 'name' ? 'asc' : 'desc';
    }
    renderPersonTable();
  });
}

personFilterEl.addEventListener('input', () => {
  state.personFilterText = personFilterEl.value.trim();
  renderPersonTable();
});

personRoleFilterEl.addEventListener('change', () => {
  state.personRoleFilter = personRoleFilterEl.value;
  renderPersonTable();
});

// Staggered reveal animation
for (const [idx, node] of document.querySelectorAll('.reveal').entries()) {
  node.style.animationDelay = `${idx * 70}ms`;
}

// Initial load
loadData();

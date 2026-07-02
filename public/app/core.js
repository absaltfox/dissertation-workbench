// --- DOM references ---
const refreshRuleEl = document.getElementById('refreshRule');
const statusWrapEl = document.querySelector('.status-wrap');
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
const supervisorTopicPanelEl = document.getElementById('supervisorTopicPanel');
const supervisorTopicHeatmapEl = document.getElementById('supervisorTopicHeatmap');
const topicDistPanelEl = document.getElementById('topicDistPanel');
const topicModelMetaEl = document.getElementById('topicModelMeta');
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

// Network visualization panel elements (in-progress/optional features)
const supervisorNetworkPanelEl = document.getElementById('supervisorNetworkPanel');
const supervisorNetworkChartEl = document.getElementById('supervisorNetworkChart');
const supervisorNetworkTooltipEl = document.getElementById('supervisorNetworkTooltip');
const supervisorNetworkContainerEl = document.getElementById('supervisorNetworkContainer');

const citationNetworkPanelEl = document.getElementById('citationNetworkPanel');
const citationNetworkChartEl = document.getElementById('citationNetworkChart');
const citationNetworkTooltipEl = document.getElementById('citationNetworkTooltip');
const citationNetworkContainerEl = document.getElementById('citationNetworkContainer');

const conceptNetworkPanelEl = document.getElementById('conceptNetworkPanel');
const conceptNetworkChartEl = document.getElementById('conceptNetworkChart');
const conceptNetworkTooltipEl = document.getElementById('conceptNetworkTooltip');
const conceptNetworkContainerEl = document.getElementById('conceptNetworkContainer');

const exportBibTeXBtn = document.getElementById('exportBibTeX');
const exportRISBtn = document.getElementById('exportRIS');
const exportCitationBibTeXBtn = document.getElementById('exportCitationBibTeX');
const exportCitationRISBtn = document.getElementById('exportCitationRIS');
const settingsForm = document.getElementById('settingsForm');
const loadBtn = document.getElementById('loadBtn');
const refreshBtn = document.getElementById('refreshBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const syncDocumentsBtn = document.getElementById('syncDocumentsBtn');
const rebuildConceptsBtn = document.getElementById('rebuildConceptsBtn');
const documentSyncStatusEl = document.getElementById('documentSyncStatus');
const conceptPipelineStatusEl = document.getElementById('conceptPipelineStatus');
const importRuleForm = document.getElementById('importRuleForm');
const importRuleIdEl = document.getElementById('importRuleId');
const importRuleNameEl = document.getElementById('importRuleName');
const importDegreeEl = document.getElementById('importDegree');
const importProgramEl = document.getElementById('importProgram');
const importAffiliationEl = document.getElementById('importAffiliation');
const importIndexEl = document.getElementById('importIndex');
const importQueryEl = document.getElementById('importQuery');
const importSourceEl = document.getElementById('importSource');
const importGeneratedTermEl = document.getElementById('importGeneratedTerm');
const importRulesListEl = document.getElementById('importRulesList');
const importRulePreviewEl = document.getElementById('importRulePreview');
const newImportRuleBtn = document.getElementById('newImportRuleBtn');
const previewImportRuleBtn = document.getElementById('previewImportRuleBtn');
const importRunScopeEl = document.getElementById('importRunScope');
const importAllRuleBtn = document.getElementById('importAllRuleBtn');
const syncDifferencesRuleBtn = document.getElementById('syncDifferencesRuleBtn');
const refreshMetadataRuleBtn = document.getElementById('refreshMetadataRuleBtn');
const syncMissingPdfsRuleBtn = document.getElementById('syncMissingPdfsRuleBtn');
const deleteImportRuleBtn = document.getElementById('deleteImportRuleBtn');
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
const mfaChallengeForm = document.getElementById('mfaChallengeForm');
const loginMfaCode = document.getElementById('loginMfaCode');
const mfaChallengeError = document.getElementById('mfaChallengeError');
const mfaBackBtn = document.getElementById('mfaBackBtn');
const mfaSetupForm = document.getElementById('mfaSetupForm');
const mfaSetupSecret = document.getElementById('mfaSetupSecret');
const mfaSetupToken = document.getElementById('mfaSetupToken');
const mfaSetupCode = document.getElementById('mfaSetupCode');
const mfaSetupError = document.getElementById('mfaSetupError');
const passwordResetForm = document.getElementById('passwordResetForm');
const passwordResetTokenEl = document.getElementById('passwordResetToken');
const passwordResetPasswordEl = document.getElementById('passwordResetPassword');
const passwordResetConfirmEl = document.getElementById('passwordResetConfirm');
const passwordResetErrorEl = document.getElementById('passwordResetError');
const adminUserLabel = document.getElementById('adminUserLabel');
const logoutBtn = document.getElementById('logoutBtn');
const adminTabButtons = Array.from(document.querySelectorAll('.admin-tab-btn'));
const createUserForm = document.getElementById('createUserForm');
const createUserError = document.getElementById('createUserError');
const createUserResetLinkEl = document.getElementById('createUserResetLink');
const setupOwnMfaBtn = document.getElementById('setupOwnMfaBtn');
const ownMfaSetupEl = document.getElementById('ownMfaSetup');
const ownMfaSecretEl = document.getElementById('ownMfaSecret');
const ownMfaTokenEl = document.getElementById('ownMfaToken');
const ownMfaCodeEl = document.getElementById('ownMfaCode');
const ownMfaErrorEl = document.getElementById('ownMfaError');
const confirmOwnMfaBtn = document.getElementById('confirmOwnMfaBtn');
const cancelOwnMfaBtn = document.getElementById('cancelOwnMfaBtn');
const refreshCacheBtn = document.getElementById('refreshCacheBtn');
const cacheFilterEl = document.getElementById('cacheFilter');
const reparseAllBtn = document.getElementById('reparseAllBtn');
const reparseCitationsBtn = document.getElementById('reparseCitationsBtn');
const refreshJobsBtn = document.getElementById('refreshJobsBtn');
const catalogueLookupLimitEl = document.getElementById('catalogueLookupLimit');
const previewCatalogueLookupsBtn = document.getElementById('previewCatalogueLookupsBtn');
const runCatalogueLookupsBtn = document.getElementById('runCatalogueLookupsBtn');
const runBertopicBtn = document.getElementById('runBertopicBtn');
const refreshTopicLabelsBtn = document.getElementById('refreshTopicLabelsBtn');
const regenerateTopicLabelsBtn = document.getElementById('regenerateTopicLabelsBtn');
const publishPassingTopicLabelsBtn = document.getElementById('publishPassingTopicLabelsBtn');
const topicLabelFilterEl = document.getElementById('topicLabelFilter');
const topicLabelSearchEl = document.getElementById('topicLabelSearch');
const topicLabelSummaryEl = document.getElementById('topicLabelSummary');
const topicLabelCountEl = document.getElementById('topicLabelCount');
const topicLabelsPanelEl = document.getElementById('topicLabelsPanel');
const topicLabelDetailPanelEl = document.getElementById('topicLabelDetailPanel');
const catalogueLookupPreviewEl = document.getElementById('catalogueLookupPreview');
const jobsStatusCardsEl = document.getElementById('jobsStatusCards');
const jobsTableEl = document.getElementById('jobsTable');
const syncRunsTableEl = document.getElementById('syncRunsTable');

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
  documentsById: new Map(),
  detailByDocId: new Map(),
  tabData: {
    analyticsByFilterKey: new Map(),
    visualizationsByFilterKey: new Map(),
    peopleByFilterKey: new Map(),
    citationsByFilterKey: new Map(),
  },
  activeDataKey: '',
  selectedDocId: null,
  selectedTheme: null,
  loading: false,
  analyticsLoaded: false,
  analyticsLoading: false,
  user: null, // { username } or null
  pendingLogin: null,
  csrfToken: '',
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
  importRules: [],
  selectedImportRuleId: '',
  checkedImportRuleIds: new Set(),
  cacheEntries: [],
  cacheFilterText: '',
  topicLabels: null,
  selectedTopicLabelId: null,
  topicLabelSearchText: '',
};

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

function heatmapHeaderCell(label) {
  const full = String(label || '');
  return `<th class="heatmap-header" title="${escapeHtml(full)}"><span class="heatmap-header-label">${escapeHtml(full)}</span></th>`;
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// HTML escaping protects attribute syntax, but it does not make a URL safe.
// Use this before rendering externally supplied links into href attributes.
function safeExternalHref(value) {
  try {
    const url = new URL(String(value || ''), window.location.origin);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (url.protocol === 'http:') {
      const host = url.hostname.toLowerCase();
      const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      const ubc = host === 'ubc.ca' || host.endsWith('.ubc.ca') || host === 'open.library.ubc.ca';
      if (!local && !ubc) return '';
    }
    return url.href;
  } catch {
    return '';
  }
}

const _scriptLoadPromises = new Map();

function loadClassicScript(src) {
  if (_scriptLoadPromises.has(src)) return _scriptLoadPromises.get(src);
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing?.dataset.loaded === 'true') {
    const resolved = Promise.resolve();
    _scriptLoadPromises.set(src, resolved);
    return resolved;
  }

  const promise = new Promise((resolve, reject) => {
    const script = existing || document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => {
      _scriptLoadPromises.delete(src);
      reject(new Error(`Could not load ${src}`));
    };
    if (!existing) document.head.appendChild(script);
  });
  _scriptLoadPromises.set(src, promise);
  return promise;
}

async function ensureChartLibrary() {
  await loadClassicScript('/vendor/chart.js');
}

async function ensureD3Library() {
  await loadClassicScript('/vendor/d3.js');
}

async function ensureVisualizationLibraries() {
  await Promise.all([ensureChartLibrary(), ensureD3Library()]);
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

function formatRefreshDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 'just now';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function setRefreshRuleFromPayload() {
  if (!refreshRuleEl) return;
  const docs = state.payload?.documents || [];
  const supervisors = new Set();
  for (const doc of docs) {
    for (const supervisor of doc.supervisors || []) {
      const name = String(supervisor || '').trim();
      if (name) supervisors.add(name.toLowerCase());
    }
  }

  refreshRuleEl.classList.remove('error');
  refreshRuleEl.innerHTML = [
    `Last refreshed ${escapeHtml(formatRefreshDate(state.payload?.generatedAt))}`,
    `${formatNum(docs.length)} dissertations`,
    `${formatNum(supervisors.size)} supervisors`
  ].map((part) => `<span>${part}</span>`).join('<span class="dot" aria-hidden="true"></span>');
}

function setRefreshRuleError(message) {
  if (!refreshRuleEl) return;
  refreshRuleEl.classList.add('error');
  refreshRuleEl.textContent = `Unable to refresh data: ${message}`;
}

function setStatus(message, isError = false) {
  if (statusWrapEl) statusWrapEl.hidden = false;
  statusTextEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function hideStatus() {
  if (statusWrapEl) statusWrapEl.hidden = true;
}

function showSpinner(show) {
  spinnerEl.hidden = !show;
}

function csrfHeaders(base = {}) {
  return state.csrfToken ? { ...base, 'x-csrf-token': state.csrfToken } : base;
}

function jsonHeaders() {
  return csrfHeaders({ 'content-type': 'application/json' });
}

// --- Tab navigation ---

const ROUTE_TAB_SLUGS = {
  records: 'documents',
  citations: 'citations',
  people: 'people',
  analytics: 'analytics',
  about: 'about',
  admin: 'admin',
};
const ROUTE_SLUG_TABS = {
  documents: 'records',
  document: 'records',
  records: 'records',
  citations: 'citations',
  people: 'people',
  persons: 'people',
  analytics: 'analytics',
  about: 'about',
  admin: 'admin',
};

// The app is still a static single-page bundle, so URL routing is hash-based.
// Keeping tab state in the hash makes refreshes and direct admin links stable.
function getActiveAdminTab() {
  return document.querySelector('.admin-tab-btn.active')?.dataset.adminTab || 'settings';
}

function routeForTab(tabName) {
  const slug = ROUTE_TAB_SLUGS[tabName] || 'documents';
  if (tabName === 'admin') return `#/admin/${getActiveAdminTab()}`;
  return `#/${slug}`;
}

function updateRoute(tabName) {
  const next = routeForTab(tabName);
  if (window.location.hash !== next) {
    window.history.pushState(null, '', next);
  }
}

function setActiveTab(tabName, { updateUrl = true } = {}) {
  const isAdminTab = tabName === 'admin';
  document.body.classList.toggle('admin-mode', isAdminTab);

  for (const btn of tabButtons) {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const panel of tabPanels) {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  }
  if (updateUrl) updateRoute(tabName);
}

function setActiveCitationTab(tabName) {
  for (const btn of citationTabButtons) {
    btn.classList.toggle('active', btn.dataset.citationTab === tabName);
  }
  for (const section of document.querySelectorAll('.citation-tab-section')) {
    section.classList.toggle('active', section.id === `citation-${tabName}`);
  }
}

function setActiveAdminTab(tabName, { updateUrl = true } = {}) {
  for (const btn of adminTabButtons) {
    btn.classList.toggle('active', btn.dataset.adminTab === tabName);
  }
  for (const section of document.querySelectorAll('.admin-panel-section')) {
    section.classList.toggle('active', section.id === `admin-${tabName}`);
  }
  if (updateUrl && document.body.classList.contains('admin-mode')) {
    window.history.pushState(null, '', `#/admin/${tabName}`);
  }
}

function parseRouteFromHash() {
  const rawHash = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = rawHash.split('?');
  const parts = pathPart
    .replace(/^#\/?/, '')
    .split('/')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const tab = ROUTE_SLUG_TABS[parts[0] || 'documents'] || 'records';
  const adminTab = parts[1] || 'settings';
  const query = new URLSearchParams(queryPart);
  return { tab, adminTab, resetToken: query.get('token') || '' };
}

function applyRouteFromHash() {
  const { tab, adminTab, resetToken } = parseRouteFromHash();
  if (tab === 'admin') {
    const hasAdminTab = adminTabButtons.some((btn) => btn.dataset.adminTab === adminTab);
    setActiveAdminTab(hasAdminTab ? adminTab : 'settings', { updateUrl: false });
  }
  setActiveTab(tab, { updateUrl: false });
  return { tab, adminTab, resetToken };
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

function normalizedSet(values) {
  return new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function relatedDocumentScore(doc, candidate) {
  const themeOverlap = intersectionCount([...normalizedSet(doc.themes)], [...normalizedSet(candidate.themes)]);
  const conceptOverlap = intersectionCount([...normalizedSet(doc.conceptTerms)], [...normalizedSet(candidate.conceptTerms)]);
  const methodologyOverlap = intersectionCount([...normalizedSet(doc.methodologies)], [...normalizedSet(candidate.methodologies)]);
  const sameTopic = doc.topicId != null
    && candidate.topicId != null
    && doc.topicId !== -1
    && candidate.topicId !== -1
    && doc.topicId === candidate.topicId;
  const topicConfidence = sameTopic
    ? Math.min(
        typeof doc.topicProbability === 'number' ? doc.topicProbability : 0.75,
        typeof candidate.topicProbability === 'number' ? candidate.topicProbability : 0.75
      )
    : 0;

  return {
    score:
      (themeOverlap * 1)
      + (conceptOverlap * 2)
      + (methodologyOverlap * 0.5)
      + (sameTopic ? 2.5 * topicConfidence : 0),
    themeOverlap,
    conceptOverlap,
    methodologyOverlap,
    sameTopic
  };
}

function relatedDocuments(doc, allDocs, limit = 6) {
  return allDocs
    .filter((candidate) => candidate.id !== doc.id)
    .map((candidate) => {
      const relatedness = relatedDocumentScore(doc, candidate);
      return {
        ...candidate,
        relatedness
      };
    })
    .filter((item) => item.relatedness.score > 0)
    .sort((a, b) => b.relatedness.score - a.relatedness.score || (b.year || 0) - (a.year || 0))
    .slice(0, limit);
}

const dom = {
  refreshRuleEl,
  statusWrapEl,
  statusTextEl,
  spinnerEl,
  statusEl,
  documentsTableEl,
  docFilterEl,
  docTheadRow,
  selectAllDocsEl,
  docDetailsEl,
  kpisEl,
  pagesByYearChartEl,
  wordCloudEl,
  themeResultsEl,
  subjectBarsEl,
  dissertationsByYearChartEl,
  wordsByYearChartEl,
  pageTrendChartEl,
  ngramCloudEl,
  methodologyBarsEl,
  cooccurrenceBarsEl,
  supervisorHeatmapEl,
  conceptTimelineChartEl,
  conceptTimelineLegendEl,
  methodologyConceptHeatmapEl,
  supervisorTopicPanelEl,
  supervisorTopicHeatmapEl,
  topicDistPanelEl,
  topicModelMetaEl,
  topicBarsEl,
  topicTimelinePanelEl,
  topicTimelineChartEl,
  topicTimelineLegendEl,
  foundationalWorksListEl,
  analyticsTabButtons,
  topicClusterPanelEl,
  topicClusterChartEl,
  topicClusterTooltipEl,
  topicClusterLegendEl,
  topicClusterContainerEl,
  topicDendrogramPanelEl,
  topicDendrogramChartEl,
  topicDendrogramTooltipEl,
  topicDendrogramContainerEl,
  topicSankeyPanelEl,
  topicSankeyChartEl,
  topicSankeyLegendEl,
  methTopicBubblePanelEl,
  methTopicBubbleChartEl,
  methTopicBubbleTooltipEl,
  methTopicBubbleContainerEl,
  supervisorNetworkPanelEl,
  supervisorNetworkChartEl,
  supervisorNetworkTooltipEl,
  supervisorNetworkContainerEl,
  citationNetworkPanelEl,
  citationNetworkChartEl,
  citationNetworkTooltipEl,
  citationNetworkContainerEl,
  conceptNetworkPanelEl,
  conceptNetworkChartEl,
  conceptNetworkTooltipEl,
  conceptNetworkContainerEl,
  exportBibTeXBtn,
  exportRISBtn,
  exportCitationBibTeXBtn,
  exportCitationRISBtn,
  settingsForm,
  loadBtn,
  refreshBtn,
  saveSettingsBtn,
  syncDocumentsBtn,
  rebuildConceptsBtn,
  documentSyncStatusEl,
  conceptPipelineStatusEl,
  importRuleForm,
  importRuleIdEl,
  importRuleNameEl,
  importDegreeEl,
  importProgramEl,
  importAffiliationEl,
  importIndexEl,
  importQueryEl,
  importSourceEl,
  importGeneratedTermEl,
  importRulesListEl,
  importRulePreviewEl,
  newImportRuleBtn,
  previewImportRuleBtn,
  importRunScopeEl,
  importAllRuleBtn,
  syncDifferencesRuleBtn,
  refreshMetadataRuleBtn,
  syncMissingPdfsRuleBtn,
  deleteImportRuleBtn,
  tabButtons,
  tabPanels,
  docModalOverlay,
  docModalCloseBtn,
  docModalTitleEl,
  summonModalOverlayEl,
  summonModalTitleEl,
  summonResultsEl,
  summonModalCloseBtn,
  loginGate,
  adminContent,
  loginForm,
  loginError,
  mfaChallengeForm,
  loginMfaCode,
  mfaChallengeError,
  mfaBackBtn,
  mfaSetupForm,
  mfaSetupSecret,
  mfaSetupToken,
  mfaSetupCode,
  mfaSetupError,
  passwordResetForm,
  passwordResetTokenEl,
  passwordResetPasswordEl,
  passwordResetConfirmEl,
  passwordResetErrorEl,
  adminUserLabel,
  logoutBtn,
  adminTabButtons,
  createUserForm,
  createUserError,
  createUserResetLinkEl,
  setupOwnMfaBtn,
  ownMfaSetupEl,
  ownMfaSecretEl,
  ownMfaTokenEl,
  ownMfaCodeEl,
  ownMfaErrorEl,
  confirmOwnMfaBtn,
  cancelOwnMfaBtn,
  refreshCacheBtn,
  cacheFilterEl,
  reparseAllBtn,
  reparseCitationsBtn,
  refreshJobsBtn,
  catalogueLookupLimitEl,
  previewCatalogueLookupsBtn,
  runCatalogueLookupsBtn,
  runBertopicBtn,
  refreshTopicLabelsBtn,
  regenerateTopicLabelsBtn,
  publishPassingTopicLabelsBtn,
  topicLabelFilterEl,
  topicLabelSearchEl,
  topicLabelSummaryEl,
  topicLabelCountEl,
  topicLabelsPanelEl,
  topicLabelDetailPanelEl,
  catalogueLookupPreviewEl,
  jobsStatusCardsEl,
  jobsTableEl,
  syncRunsTableEl,
  citationDocsTableEl,
  citationDocFilterEl,
  citationListTitleEl,
  citationEntriesEl,
  citationTabButtons,
  personTableEl,
  personDetailEl,
  personFilterEl,
  personRoleFilterEl,
  personCountEl,
  personSortHeaders,
  facetFilterBarEl,
  filterDegreeEl,
  filterProgramEl,
  filterAffiliationEl,
  clearFacetsBtn,
  facetCountEl,
  facetChipsEl,
};

function resetDerivedCaches() {
  // Route modules keep their own staged API caches keyed by source/filter.
}

export {
  COOCCURRENCE_BLOCKLIST,
  applyRouteFromHash,
  csrfHeaders,
  dom,
  escapeHtml,
  formatBytes,
  formatNum,
  formatRefreshDate,
  getCurrentParams,
  heatmapHeaderCell,
  hideStatus,
  jsonHeaders,
  mergeAffiliations,
  normalizeAffiliation,
  parseRouteFromHash,
  relatedDocuments,
  resetDerivedCaches,
  routeForTab,
  safeExternalHref,
  setActiveAdminTab,
  setActiveCitationTab,
  setActiveTab,
  setRefreshRuleError,
  setRefreshRuleFromPayload,
  setStatus,
  showSpinner,
  state,
  updateRoute,
  ensureChartLibrary,
  ensureD3Library,
  ensureVisualizationLibraries,
};

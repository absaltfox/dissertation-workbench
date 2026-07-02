import {
  dom,
  parseRouteFromHash,
  resetDerivedCaches,
  setActiveAdminTab,
  setActiveTab,
  state,
} from './core.js';
import {
  closeDocModal,
  configureDocuments,
  getFilteredDocs,
  getFilteredSortedDocs,
  openRecord,
  renderDocuments,
  syncSelectAllDocs,
} from './documents.js';
import {
  configureData,
  loadAnalytics,
  loadCitationDocuments,
  loadData,
  loadDocumentDetail,
  loadPeopleData,
  populateFacetFilters,
  renderAll,
  updateFacetCount,
} from './data.js';

const {
  clearFacetsBtn,
  citationEntriesEl,
  citationListTitleEl,
  docFilterEl,
  docModalCloseBtn,
  docModalOverlay,
  docTheadRow,
  documentsTableEl,
  exportBibTeXBtn,
  exportRISBtn,
  facetChipsEl,
  filterAffiliationEl,
  filterDegreeEl,
  filterProgramEl,
  refreshBtn,
  selectAllDocsEl,
  summonModalCloseBtn,
  summonModalOverlayEl,
  tabButtons,
} = dom;

let citationsModulePromise = null;
let peopleModulePromise = null;
let analyticsModulePromise = null;
let topicVisualsModulePromise = null;
let adminModulePromise = null;

async function ensureCitationsModule() {
  if (!citationsModulePromise) {
    citationsModulePromise = import('./citations.js').then((mod) => {
      mod.initCitations();
      return mod;
    });
  }
  return citationsModulePromise;
}

async function ensurePeopleModule() {
  if (!peopleModulePromise) {
    peopleModulePromise = import('./people.js').then((mod) => {
      mod.configurePeople({ activateTab });
      mod.initPeople();
      return mod;
    });
  }
  return peopleModulePromise;
}

async function ensureTopicVisualsModule() {
  if (!topicVisualsModulePromise) {
    topicVisualsModulePromise = import('./topic-visuals.js').then(async (mod) => {
      mod.configureTopicVisuals({
        openSupervisorProfile: async (name) => {
          const people = await ensurePeopleModule();
          people.openSupervisorProfile(name);
        },
      });
      mod.initTopicVisuals();
      await mod.loadAndRenderVisualizations();
      return mod;
    });
  }
  return topicVisualsModulePromise;
}

async function ensureAnalyticsModule() {
  if (!analyticsModulePromise) {
    analyticsModulePromise = import('./analytics-dashboard.js').then((mod) => {
      mod.configureAnalyticsDashboard({
        ensureTopicVisuals: ensureTopicVisualsModule,
        openSupervisorProfile: async (name) => {
          const people = await ensurePeopleModule();
          people.openSupervisorProfile(name);
        },
      });
      mod.initAnalyticsDashboard();
      configureDocuments({ topicDisplayLabel: mod.topicDisplayLabel });
      return mod;
    });
  }
  return analyticsModulePromise;
}

async function ensureAdminModule() {
  if (!adminModulePromise) {
    adminModulePromise = import('./admin.js').then((mod) => {
      mod.initAdmin();
      return mod;
    });
  }
  return adminModulePromise;
}

async function activateTab(tabName, { updateUrl = true, resetToken = '' } = {}) {
  setActiveTab(tabName, { updateUrl });

  if (tabName === 'citations' && state.payload) {
    const citations = await ensureCitationsModule();
    await loadCitationDocuments();
    citations.renderCitationDocs();
    citations.activateCitationTab('browse');
  }

  if (tabName === 'people' && state.payload) {
    const people = await ensurePeopleModule();
    await loadPeopleData();
    people.renderPersonTable();
    if (state.selectedPersonKey) people.renderPersonDetail(state.selectedPersonKey);
  }

  if (tabName === 'analytics' && state.payload) {
    const analytics = await ensureAnalyticsModule();
    await analytics.loadAndRenderAnalytics();
  }

  if (tabName === 'admin') {
    const admin = await ensureAdminModule();
    const { adminTab } = parseRouteFromHash();
    const hasAdminTab = dom.adminTabButtons.some((btn) => btn.dataset.adminTab === adminTab);
    admin.activateAdminTab(hasAdminTab ? adminTab : 'settings', { updateUrl: false });
    if (resetToken) admin.showPasswordResetGate(resetToken);
    else await admin.checkSession();
  }
}

async function applyRouteFromHash() {
  const { tab, adminTab, resetToken } = parseRouteFromHash();
  if (tab === 'admin') {
    const hasAdminTab = dom.adminTabButtons.some((btn) => btn.dataset.adminTab === adminTab);
    setActiveAdminTab(hasAdminTab ? adminTab : 'settings', { updateUrl: false });
  }
  await activateTab(tab, { updateUrl: false, resetToken });
}

async function onFacetChange() {
  state.activeFilters.degree = filterDegreeEl.value;
  state.activeFilters.program = filterProgramEl.value;
  state.activeFilters.affiliation = filterAffiliationEl.value;
  state.analyticsLoaded = false;
  resetDerivedCaches();
  updateFacetCount();

  const filteredDocs = getFilteredDocs();
  if (!filteredDocs.some(d => d.id === state.selectedDocId)) state.selectedDocId = null;
  if (!filteredDocs.some(d => d.id === state.citationDocId)) {
    state.citationDocId = null;
    citationEntriesEl.innerHTML = '<p class="meta">Select a document to view its works cited.</p>';
    citationListTitleEl.textContent = 'Works Cited';
  }

  renderAll();
  if (document.querySelector('#tab-citations.active')) {
    const citations = await ensureCitationsModule();
    await loadCitationDocuments();
    citations.renderCitationDocs();
  }
  if (document.querySelector('#tab-people.active')) {
    const people = await ensurePeopleModule();
    await loadPeopleData();
    people.renderPersonTable();
  }
  if (document.querySelector('#tab-analytics.active')) {
    const analytics = await ensureAnalyticsModule();
    await analytics.loadAndRenderAnalytics();
  }
}

function bindFirstScreenEvents() {
  refreshBtn?.addEventListener('click', () => {
    loadData({ refresh: true });
  });

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab);
    });
  }

  window.addEventListener('hashchange', applyRouteFromHash);

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

  docFilterEl.addEventListener('input', () => {
    state.filterText = docFilterEl.value.trim();
    renderDocuments();
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

  exportBibTeXBtn.addEventListener('click', async () => {
    const citations = await ensureCitationsModule();
    const all = getFilteredSortedDocs();
    const docs = state.selectedDocIds.size > 0 ? all.filter((d) => state.selectedDocIds.has(d.id)) : all;
    if (!docs.length) return;
    citations.downloadFile(citations.generateBibTeX(docs), 'dissertations.bib', 'application/x-bibtex');
  });

  exportRISBtn.addEventListener('click', async () => {
    const citations = await ensureCitationsModule();
    const all = getFilteredSortedDocs();
    const docs = state.selectedDocIds.size > 0 ? all.filter((d) => state.selectedDocIds.has(d.id)) : all;
    if (!docs.length) return;
    citations.downloadFile(citations.generateRIS(docs), 'dissertations.ris', 'application/x-research-info-systems');
  });

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
    if (key === 'degree') filterDegreeEl.value = '';
    if (key === 'program') filterProgramEl.value = '';
    if (key === 'affiliation') filterAffiliationEl.value = '';
    onFacetChange();
  });

  documentsTableEl.addEventListener('click', (e) => {
    if (e.target.closest('.doc-row-check')) return;
    const row = e.target.closest('.doc-row');
    if (row) openRecord(row.dataset.docId, 'records');
  });

  documentsTableEl.addEventListener('change', (e) => {
    const cb = e.target.closest('.doc-row-check');
    if (!cb) return;
    const id = cb.dataset.checkId;
    if (cb.checked) state.selectedDocIds.add(id);
    else state.selectedDocIds.delete(id);
    syncSelectAllDocs();
  });

  for (const [idx, node] of document.querySelectorAll('.reveal').entries()) {
    node.style.animationDelay = `${idx * 70}ms`;
  }
}

configureDocuments({
  activateTab,
  getCitationHelpers: ensureCitationsModule,
  loadDocumentDetail,
  openSupervisorProfile: async (name) => {
    const people = await ensurePeopleModule();
    people.openSupervisorProfile(name);
  },
});

configureData({
  afterDataLoad: async () => {
    const active = document.querySelector('.tab-panel.active')?.id?.replace(/^tab-/, '') || 'records';
    if (active !== 'records') await activateTab(active, { updateUrl: false });
  },
  renderAnalytics: async () => {
    const analytics = await ensureAnalyticsModule();
    analytics.renderAnalytics();
  },
  renderPeople: async () => {
    const people = await ensurePeopleModule();
    people.renderPersonTable();
  },
});

bindFirstScreenEvents();
applyRouteFromHash();
loadData();
setInterval(async () => {
  if (state.user && document.querySelector('#admin-jobs.active')) {
    const admin = await ensureAdminModule();
    admin.loadJobs();
  }
}, 5000);

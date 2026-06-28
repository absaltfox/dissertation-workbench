// --- Event bindings ---

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  handleSaveSettings();
});

refreshBtn?.addEventListener('click', () => {
  loadData({ refresh: true });
});

saveSettingsBtn.addEventListener('click', handleSaveSettings);
syncDocumentsBtn?.addEventListener('click', handleSyncDocuments);
rebuildConceptsBtn.addEventListener('click', handleRebuildConcepts);
importRuleForm?.addEventListener('submit', handleSaveImportRule);
newImportRuleBtn?.addEventListener('click', () => setImportRuleForm({}));
previewImportRuleBtn?.addEventListener('click', handlePreviewImportRule);
importAllRuleBtn?.addEventListener('click', () => handleRunImportRules('import_all', importAllRuleBtn));
syncDifferencesRuleBtn?.addEventListener('click', () => handleRunImportRules('sync_differences', syncDifferencesRuleBtn));
refreshMetadataRuleBtn?.addEventListener('click', () => handleRunImportRules('refresh_metadata', refreshMetadataRuleBtn));
syncMissingPdfsRuleBtn?.addEventListener('click', () => handleRunImportRules('sync_missing_pdfs', syncMissingPdfsRuleBtn));
deleteImportRuleBtn?.addEventListener('click', handleDeleteImportRule);

for (const input of [importRuleNameEl, importDegreeEl, importProgramEl, importAffiliationEl, importIndexEl, importQueryEl, importSourceEl]) {
  input?.addEventListener('input', () => {
    updateImportGeneratedTerm();
    if (input !== importRuleNameEl) loadImportFacets();
  });
}

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

window.addEventListener('hashchange', applyRouteFromHash);

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
mfaChallengeForm.addEventListener('submit', handleMfaChallenge);
mfaBackBtn.addEventListener('click', handleMfaBack);
mfaSetupForm.addEventListener('submit', handleMfaSetup);
passwordResetForm?.addEventListener('submit', handlePasswordReset);
logoutBtn.addEventListener('click', handleLogout);
createUserForm.addEventListener('submit', handleCreateUser);
setupOwnMfaBtn?.addEventListener('click', handleSetupOwnMfa);
confirmOwnMfaBtn?.addEventListener('click', handleConfirmOwnMfa);
cancelOwnMfaBtn?.addEventListener('click', () => {
  ownMfaSetupEl.hidden = true;
  ownMfaTokenEl.value = '';
  ownMfaCodeEl.value = '';
  ownMfaErrorEl.hidden = true;
});
refreshCacheBtn.addEventListener('click', handleRefreshCache);
cacheFilterEl?.addEventListener('input', () => {
  state.cacheFilterText = cacheFilterEl.value.trim();
  renderCache(state.cacheEntries);
});
reparseAllBtn.addEventListener('click', handleReparseAll);
reparseCitationsBtn?.addEventListener('click', handleReparseCitations);
refreshJobsBtn?.addEventListener('click', loadJobs);
previewCatalogueLookupsBtn?.addEventListener('click', handlePreviewCatalogueLookups);
runCatalogueLookupsBtn?.addEventListener('click', handleRunCatalogueLookups);
runBertopicBtn?.addEventListener('click', handleRunBertopic);
refreshTopicLabelsBtn?.addEventListener('click', loadTopicLabels);
regenerateTopicLabelsBtn?.addEventListener('click', () => handleRegenerateTopicLabels());
publishPassingTopicLabelsBtn?.addEventListener('click', handlePublishPassingTopicLabels);
topicLabelFilterEl?.addEventListener('change', renderTopicLabels);

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
applyRouteFromHash();
loadData();
setInterval(() => {
  if (state.user && document.querySelector('#admin-jobs.active')) loadJobs();
}, 5000);

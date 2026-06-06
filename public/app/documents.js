
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
            <p>${escapeHtml(r.author || 'Unknown')} &middot; ${r.year || '-'}</p>
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
  const downloadHref = safeExternalHref(doc.downloadUrl);
  if (downloadHref) {
    actions.push(`<a class="btn ghost btn-sm" href="${escapeHtml(downloadHref)}" target="_blank" rel="noreferrer">Open PDF</a>`);
  }
  const recordHref = safeExternalHref(doc.uri);
  if (recordHref) {
    actions.push(`<a class="btn ghost btn-sm" href="${escapeHtml(recordHref)}" target="_blank" rel="noreferrer">Open Record</a>`);
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
      const confidence = typeof doc.topicProbability === 'number' ? ` (${Math.round(doc.topicProbability * 100)}% confidence)` : '';
      return `<div><p class="detail-section-title">Topic</p><div class="token-list"><span class="token topic">${escapeHtml(label)}${escapeHtml(confidence)}</span></div></div>`;
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

import {
  dom,
  escapeHtml,
  formatNum,
  safeExternalHref,
  setActiveCitationTab as setActiveCitationTabShell,
  state,
} from './core.js';
import {
  getFilteredDocs,
  openRecord,
} from './documents.js';

const {
  citationDocFilterEl,
  citationDocsTableEl,
  citationEntriesEl,
  citationListTitleEl,
  citationTabButtons,
  docDetailsEl,
  docModalOverlay,
  exportCitationBibTeXBtn,
  exportCitationRISBtn,
  foundationalWorksListEl,
  summonModalOverlayEl,
  summonModalTitleEl,
  summonResultsEl,
} = dom;

let citationsInitialized = false;

function initCitations() {
  if (citationsInitialized) return;
  citationsInitialized = true;

  citationDocFilterEl?.addEventListener('input', () => {
    state.citationFilterText = citationDocFilterEl.value.trim();
    renderCitationDocs();
  });

  for (const btn of citationTabButtons) {
    btn.addEventListener('click', () => activateCitationTab(btn.dataset.citationTab));
  }

  exportCitationBibTeXBtn?.addEventListener('click', () => {
    const texts = getSelectedCitationTexts();
    if (!texts.length) return;
    downloadFile(generateCitationBibTeX(texts), 'works-cited.bib', 'application/x-bibtex');
  });

  exportCitationRISBtn?.addEventListener('click', () => {
    const texts = getSelectedCitationTexts();
    if (!texts.length) return;
    downloadFile(generateCitationRIS(texts), 'works-cited.ris', 'application/x-research-info-systems');
  });
}

function activateCitationTab(tabName) {
  setActiveCitationTabShell(tabName);
  if (tabName === 'foundational' && state.payload) loadFoundationalWorks();
}

function getSelectedCitationTexts() {
  const entries = Array.from(citationEntriesEl.querySelectorAll('.citation-entry[data-citation-text]'));
  return entries
    .filter((entry) => {
      const id = entry.dataset.citationId;
      return !id || state.selectedCitationIds.size === 0 || state.selectedCitationIds.has(id);
    })
    .map((entry) => entry.dataset.citationText)
    .filter(Boolean);
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
        const resultHref = safeExternalHref(r.link);
        const titleHtml = resultHref
          ? `<a href="${escapeHtml(resultHref)}" target="_blank" rel="noreferrer">${escapeHtml(r.title || '(No title)')}</a>`
          : escapeHtml(r.title || '(No title)');
        return `<div class="summon-result-item">
          <div class="summon-result-title">${titleHtml} ${holdingsBadge}</div>
          ${metaParts ? `<div class="summon-result-meta">${escapeHtml(metaParts)}</div>` : ''}
          ${r.snippet ? `<div class="summon-result-snippet">${escapeHtml(r.snippet)}</div>` : ''}
        </div>`;
      }).join('')
    : '<p class="meta">No results found in Summon.</p>';

  const illHref = safeExternalHref(data.illUrl);
  const searchHref = safeExternalHref(data.searchUrl);
  const footerHtml = `<div class="summon-result-footer">
    ${!data.found && illHref ? `<a href="${escapeHtml(illHref)}" target="_blank" rel="noreferrer">Not found &mdash; request via ILL/DocDel &rarr;</a>` : '<span></span>'}
    ${searchHref ? `<a href="${escapeHtml(searchHref)}" target="_blank" rel="noreferrer">View all results in UBC Summon &rarr;</a>` : '<span></span>'}
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

export {
  activateCitationTab,
  attachSummonHandlers,
  catalogueBadge,
  downloadFile,
  generateBibTeX,
  generateCitationBibTeX,
  generateCitationRIS,
  generateRIS,
  getSelectedCitationTexts,
  initCitations,
  loadFoundationalWorks,
  renderCitationDocs,
  renderCitationList,
  sanitizeBibKey,
  selectCitationDoc,
};

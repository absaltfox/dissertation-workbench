import {
  dom,
  escapeHtml,
  formatNum,
  heatmapHeaderCell,
  mergeAffiliations,
  normalizeAffiliation,
  state,
} from './core.js';
import {
  getFilteredDocs,
  isPhoneView,
  openMatchesModal,
  openResponsivePanel,
  openRecord,
} from './documents.js';
import {
  getAnalytics,
  loadPeopleData,
} from './data.js';
const {
  docDetailsEl,
  docModalOverlay,
  docModalTitleEl,
  methodologyConceptHeatmapEl,
  personCountEl,
  personDetailEl,
  personFilterEl,
  personRoleFilterEl,
  personSortHeaders,
  personTableEl,
} = dom;

let peopleInitialized = false;
let personFilterTimer = null;
const peopleIntegrations = {
  activateTab: async () => {},
  loadPersonDetail: async () => null,
};

function configurePeople(integrations = {}) {
  Object.assign(peopleIntegrations, integrations);
}

function initPeople() {
  if (peopleInitialized) return;
  peopleInitialized = true;

  personTableEl?.addEventListener('click', async (e) => {
    const row = e.target.closest('.doc-row[data-person-key]');
    if (row) {
      state.selectedPersonKey = row.dataset.personKey;
      renderPersonTable();
      await renderPersonDetail(state.selectedPersonKey);
    }
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
      loadPeopleData({ reset: true }).then(() => renderPersonTable());
    });
  }

  const peopleTableWrap = personTableEl?.closest('.table-wrap');
  peopleTableWrap?.addEventListener('scroll', async () => {
    const remaining = peopleTableWrap.scrollHeight - peopleTableWrap.scrollTop - peopleTableWrap.clientHeight;
    if (remaining < 320 && !state.peoplePager.loading && !state.peoplePager.done) {
      await loadPeopleData();
      renderPersonTable();
    }
  });

  personFilterEl?.addEventListener('input', () => {
    state.personFilterText = personFilterEl.value.trim();
    window.clearTimeout(personFilterTimer);
    personFilterTimer = window.setTimeout(async () => {
      await loadPeopleData({ reset: true });
      renderPersonTable();
      personDetailEl.innerHTML = '<p class="meta">Select a person to view their profile.</p>';
    }, 250);
  });

  personRoleFilterEl?.addEventListener('change', () => {
    state.personRoleFilter = personRoleFilterEl.value;
    loadPeopleData({ reset: true }).then(() => {
      renderPersonTable();
      personDetailEl.innerHTML = '<p class="meta">Select a person to view their profile.</p>';
    });
  });
}

function topicDisplayLabel(label) {
  const cleaned = String(label || '').replace(/^-?\d+_/, '').replace(/_/g, ' ');
  return cleaned || label;
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

  const bodyHtml = `
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

  openResponsivePanel({
    title: profile.name,
    eyebrow: `${formatNum(profile.count)} dissertation(s)`,
    bodyHtml,
    onMount: (root) => {
      for (const item of root.querySelectorAll('.related-item[data-related-id]')) {
        item.addEventListener('click', () => {
          const targetId = item.getAttribute('data-related-id');
          if (targetId) openRecord(targetId, 'records');
        });
      }
    },
  });
}

async function openSupervisorProfile(name) {
  const person = await peopleIntegrations.loadPersonDetail(String(name || '').toLowerCase().trim());
  const profile = person
    ? {
        name: person.name,
        count: person.docCount,
        yearRange: person.yearRange,
        dissertations: person.docs || [],
        topConcepts: person.topConcepts || [],
        methodologies: person.methodologies || [],
      }
    : buildSupervisorProfile(name, state.payload?.documents || []);
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
  return state.peopleRows || [];
}

function renderPersonTable() {
  if (!personTableEl) return;
  const people = getPersonList();

  // Update sort header indicators
  for (const th of personSortHeaders) {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.personSort === state.personSortKey) {
      th.classList.add(state.personSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  }

  // Render rows
  const rows = people.map(p => `
    <tr class="doc-row${state.selectedPersonKey === p.key ? ' active' : ''}" data-person-key="${escapeHtml(p.key)}">
      <td>${escapeHtml(p.name)}</td>
      <td>${p.docCount}</td>
      <td><div class="token-list">${p.roles.map(r => `<span class="token">${escapeHtml(r)}</span>`).join('')}</div></td>
      <td>${escapeHtml(p.yearRange)}</td>
    </tr>
  `).join('');
  const pager = state.peoplePager || {};
  const footer = pager.loading
    ? '<tr class="document-page-status"><td colspan="4">Loading people...</td></tr>'
    : (!people.length
      ? '<tr class="document-page-status"><td colspan="4">No matching people found.</td></tr>'
      : (!pager.done && pager.total
        ? `<tr class="document-page-status"><td colspan="4">Showing ${formatNum(people.length)} of ${formatNum(pager.total)} people</td></tr>`
        : ''));
  personTableEl.innerHTML = rows + footer;

  // Count
  const total = Number.isFinite(Number(pager.total)) && pager.total > 0 ? pager.total : people.length;
  personCountEl.textContent = `${formatNum(total)} ${total === 1 ? 'person' : 'people'}`;
}

async function renderPersonDetail(personKey) {
  if (!personDetailEl) return;
  const key = String(personKey || '').toLowerCase().trim();
  const listPerson = getPersonList().find(p => p.key === key);
  const loadingHtml = `<p class="meta">Loading ${escapeHtml(listPerson?.name || 'person')}...</p>`;
  if (isPhoneView()) {
    openResponsivePanel({
      title: listPerson?.name || 'Person Profile',
      eyebrow: 'Loading',
      bodyHtml: loadingHtml,
    });
  } else {
    personDetailEl.innerHTML = loadingHtml;
  }
  const person = await peopleIntegrations.loadPersonDetail(key);
  if (!person) {
    const emptyHtml = '<p class="meta">Select a person to view their profile.</p>';
    if (isPhoneView()) {
      openResponsivePanel({
        title: 'Person Profile',
        eyebrow: 'Not found',
        bodyHtml: emptyHtml,
      });
    } else {
      personDetailEl.innerHTML = emptyHtml;
    }
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

  const bodyHtml = `
    ${isPhoneView() ? '' : `<h2 style="margin-bottom:0.3rem">${escapeHtml(person.name)}</h2>`}
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
      ${coSupHtml ? `<div><p class="detail-section-title">Supervisory Network</p><div class="token-list">${coSupHtml}</div></div>` : ''}
      <div>
        <p class="detail-section-title">Dissertations</p>
        <div class="related-list">${dissertationList}</div>
      </div>
    </div>
  `;

  if (isPhoneView()) {
    openResponsivePanel({
      title: person.name,
      eyebrow: `${formatNum(person.docCount)} dissertation(s)`,
      bodyHtml,
      onMount: (root) => attachPersonDetailHandlers(root, person),
    });
    return;
  }

  personDetailEl.innerHTML = bodyHtml;
  attachPersonDetailHandlers(personDetailEl, person);
}

function attachPersonDetailHandlers(root, person) {
  // Wire dissertation clicks
  for (const item of root.querySelectorAll('.related-item[data-related-id]')) {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-related-id');
      if (targetId) openRecord(targetId, 'records');
    });
  }

  // Wire co-supervisor navigation
  for (const link of root.querySelectorAll('[data-person-nav]')) {
    link.addEventListener('click', () => {
      const targetKey = link.getAttribute('data-person-nav');
      if (targetKey) openPersonProfile(targetKey);
    });
  }

  // Wire concept pill clicks → show matching dissertations for this person
  for (const pill of root.querySelectorAll('[data-person-concept]')) {
    pill.style.cursor = 'pointer';
    pill.addEventListener('click', () => {
      const term = pill.getAttribute('data-person-concept');
      const matches = person.docs.filter(d => (d.conceptTerms || []).includes(term));
      openMatchesModal(`${person.name} — "${term}"`, matches);
    });
  }

  // Wire topic pill clicks → show matching dissertations for this person
  for (const pill of root.querySelectorAll('[data-person-topic]')) {
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
  peopleIntegrations.activateTab('people');
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
    .map((c) => heatmapHeaderCell(c))
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

export {
  buildPersonList,
  buildSupervisorProfile,
  buildTopicSummary,
  configurePeople,
  docsForMethodologyConcept,
  getPersonList,
  initPeople,
  openPersonProfile,
  openSupervisorProfile,
  renderMethodologyConceptMatrix,
  renderPersonDetail,
  renderPersonTable,
  renderSupervisorProfile,
  renderTopicTokens,
};

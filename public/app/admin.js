
// --- Auth ---

let jobsPollTimer = null;

async function checkSession() {
  try {
    const res = await fetch('/api/auth/session');
    if (res.ok) {
      const data = await res.json();
      state.user = { username: data.username };
      state.csrfToken = data.csrfToken || '';
      showAdminContent();
    } else {
      state.user = null;
      state.csrfToken = '';
      showLoginGate();
    }
  } catch {
    state.user = null;
    state.csrfToken = '';
    showLoginGate();
  }
}

function showLoginGate() {
  loginGate.hidden = false;
  adminContent.hidden = true;
  loginForm.hidden = false;
  mfaChallengeForm.hidden = true;
  mfaSetupForm.hidden = true;
  passwordResetForm.hidden = true;
  loginError.hidden = true;
  mfaChallengeError.hidden = true;
  mfaSetupError.hidden = true;
  passwordResetErrorEl.hidden = true;
  loginMfaCode.required = false;
  loginMfaCode.value = '';
  state.pendingLogin = null;
}

function showPasswordResetGate(token) {
  state.user = null;
  state.csrfToken = '';
  loginGate.hidden = false;
  adminContent.hidden = true;
  loginForm.hidden = true;
  mfaChallengeForm.hidden = true;
  mfaSetupForm.hidden = true;
  passwordResetForm.hidden = false;
  passwordResetTokenEl.value = token || '';
  passwordResetPasswordEl.value = '';
  passwordResetConfirmEl.value = '';
  passwordResetErrorEl.hidden = true;
  passwordResetPasswordEl.focus();
}

function showAdminContent() {
  loginGate.hidden = true;
  adminContent.hidden = false;
  state.pendingLogin = null;
  adminUserLabel.textContent = `Signed in as ${state.user.username}`;
  loadAdminData();
}

function showMfaChallenge() {
  loginForm.hidden = true;
  mfaChallengeForm.hidden = false;
  mfaSetupForm.hidden = true;
  loginMfaCode.required = true;
  loginMfaCode.value = '';
  mfaChallengeError.hidden = true;
  loginMfaCode.focus();
}

function completeLogin(data, username) {
  state.user = { username: data.username || username };
  state.csrfToken = data.csrfToken || '';
  loginForm.reset();
  mfaChallengeForm.reset();
  mfaSetupForm.reset();
  loginMfaCode.required = false;
  showAdminContent();
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  loginError.hidden = true;
  state.pendingLogin = null;

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
    if (data.mfaRequired) {
      state.pendingLogin = { username, password };
      showMfaChallenge();
      return;
    }
    if (data.mfaSetupRequired) {
      loginForm.hidden = true;
      mfaChallengeForm.hidden = true;
      mfaSetupForm.hidden = false;
      mfaSetupToken.value = data.setupToken || '';
      mfaSetupSecret.textContent = data.secret || '';
      mfaSetupError.hidden = true;
      mfaSetupCode.focus();
      return;
    }
    completeLogin(data, username);
  } catch (err) {
    loginError.textContent = 'Connection error';
    loginError.hidden = false;
  }
}

async function handleMfaChallenge(e) {
  e.preventDefault();
  mfaChallengeError.hidden = true;
  const pending = state.pendingLogin;
  if (!pending) {
    showLoginGate();
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: pending.username,
        password: pending.password,
        mfaCode: loginMfaCode.value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      mfaChallengeError.textContent = data.error || 'Invalid authenticator code';
      mfaChallengeError.hidden = false;
      loginMfaCode.focus();
      return;
    }
    completeLogin(data, pending.username);
  } catch {
    mfaChallengeError.textContent = 'Connection error';
    mfaChallengeError.hidden = false;
  }
}

function handleMfaBack() {
  state.pendingLogin = null;
  mfaChallengeForm.hidden = true;
  mfaChallengeForm.reset();
  mfaChallengeError.hidden = true;
  loginMfaCode.required = false;
  loginForm.hidden = false;
  document.getElementById('loginPassword').focus();
}

async function handleMfaSetup(e) {
  e.preventDefault();
  mfaSetupError.hidden = true;
  try {
    const res = await fetch('/api/auth/mfa/setup/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupToken: mfaSetupToken.value,
        code: mfaSetupCode.value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok) {
      mfaSetupError.textContent = data.error || 'MFA setup failed';
      mfaSetupError.hidden = false;
      return;
    }
    state.user = { username: document.getElementById('loginUsername').value.trim() };
    state.csrfToken = data.csrfToken || '';
    loginForm.reset();
    mfaChallengeForm.reset();
    mfaSetupForm.reset();
    state.pendingLogin = null;
    showAdminContent();
  } catch {
    mfaSetupError.textContent = 'Connection error';
    mfaSetupError.hidden = false;
  }
}

async function handleLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: csrfHeaders() });
  } catch { /* ignore */ }
  state.user = null;
  state.csrfToken = '';
  showLoginGate();
}

async function handlePasswordReset(e) {
  e.preventDefault();
  passwordResetErrorEl.hidden = true;
  const password = passwordResetPasswordEl.value;
  const confirm = passwordResetConfirmEl.value;
  if (password !== confirm) {
    passwordResetErrorEl.textContent = 'Passwords do not match.';
    passwordResetErrorEl.hidden = false;
    return;
  }
  try {
    const res = await fetch('/api/auth/password-reset/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: passwordResetTokenEl.value, password })
    });
    const data = await res.json();
    if (!res.ok) {
      passwordResetErrorEl.textContent = data.errors ? data.errors.join(' ') : data.error || 'Password reset failed.';
      passwordResetErrorEl.hidden = false;
      return;
    }
    window.history.replaceState(null, '', '#/admin/settings');
    showLoginGate();
    loginError.textContent = 'Password set. Sign in with your new password.';
    loginError.hidden = false;
    document.getElementById('loginUsername').focus();
  } catch {
    passwordResetErrorEl.textContent = 'Connection error';
    passwordResetErrorEl.hidden = false;
  }
}

// --- Admin data loading ---

async function loadAdminData() {
  await Promise.all([loadUsers(), loadCache(), loadRuns(), loadSettings(), loadImportRules(), loadImportFacets(), loadConceptPipelineStatus(), loadJobs()]);
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
      <thead><tr><th>Name</th><th>Username</th><th>Email</th><th>MFA</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${escapeHtml([u.first_name, u.last_name].filter(Boolean).join(' ') || '-')}</td>
            <td>${escapeHtml(u.username)}</td>
            <td>${escapeHtml(u.email || '-')}</td>
            <td>${u.mfa_enabled ? 'Enabled' : 'Not enabled'}</td>
            <td>${new Date(u.created_at).toLocaleString()}</td>
            <td>
              <button class="btn ghost btn-sm" data-reset-password="${escapeHtml(u.username)}">Create Reset Link</button>
              <button class="btn ghost btn-sm" data-reset-mfa="${escapeHtml(u.username)}" ${u.mfa_enabled ? '' : 'disabled'}>Reset MFA</button>
              <button class="btn danger btn-sm" data-delete-user="${escapeHtml(u.username)}">Delete</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  for (const btn of el.querySelectorAll('[data-reset-password]')) {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.resetPassword;
      if (!confirm(`Create a password reset link for "${username}"? Existing unused links for this user will be invalidated.`)) return;
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/password-reset`, { method: 'POST', headers: csrfHeaders() });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Password reset link could not be created.');
          return;
        }
        showResetLinkResult(data.resetUrl, data.expiresAt);
      } catch { alert('Connection error'); }
    });
  }
  for (const btn of el.querySelectorAll('[data-reset-mfa]')) {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.resetMfa;
      if (!confirm(`Reset MFA for "${username}"? They will enroll again on next required login.`)) return;
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/mfa`, { method: 'DELETE', headers: csrfHeaders() });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'MFA reset failed');
          return;
        }
        await loadUsers();
      } catch { alert('Connection error'); }
    });
  }
  for (const btn of el.querySelectorAll('[data-delete-user]')) {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.deleteUser;
      if (!confirm(`Delete user "${username}"?`)) return;
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE', headers: csrfHeaders() });
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
  const firstName = document.getElementById('newFirstName').value.trim();
  const lastName = document.getElementById('newLastName').value.trim();
  const email = document.getElementById('newEmail').value.trim();
  createUserError.hidden = true;
  createUserResetLinkEl.hidden = true;

  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ username, firstName, lastName, email })
    });
    const data = await res.json();
    if (!res.ok) {
      createUserError.textContent = data.errors ? data.errors.join(' ') : data.error || 'Create failed';
      createUserError.hidden = false;
      return;
    }
    createUserForm.reset();
    showResetLinkResult(data.resetUrl, data.expiresAt);
    await loadUsers();
  } catch {
    createUserError.textContent = 'Connection error';
    createUserError.hidden = false;
  }
}

function showResetLinkResult(resetUrl, expiresAt) {
  if (!createUserResetLinkEl) return;
  const expiry = expiresAt ? new Date(expiresAt).toLocaleString() : 'soon';
  createUserResetLinkEl.hidden = false;
  createUserResetLinkEl.innerHTML = `
    <p><strong>Password reset link created.</strong> Expires ${escapeHtml(expiry)}.</p>
    <div class="reset-link-row">
      <input type="text" readonly value="${escapeHtml(resetUrl || '')}" />
      <button type="button" class="btn ghost btn-sm">Copy</button>
    </div>
  `;
  const input = createUserResetLinkEl.querySelector('input');
  const button = createUserResetLinkEl.querySelector('button');
  button?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      button.textContent = 'Copied';
    } catch {
      input.select();
    }
  });
}

async function handleSetupOwnMfa() {
  ownMfaErrorEl.hidden = true;
  try {
    const res = await fetch('/api/admin/me/mfa/setup', { method: 'POST', headers: csrfHeaders() });
    const data = await res.json();
    if (!res.ok) {
      ownMfaErrorEl.textContent = data.error || 'MFA setup could not be started.';
      ownMfaErrorEl.hidden = false;
      ownMfaSetupEl.hidden = false;
      return;
    }
    ownMfaTokenEl.value = data.setupToken || '';
    ownMfaSecretEl.textContent = data.secret || '';
    ownMfaCodeEl.value = '';
    ownMfaSetupEl.hidden = false;
    ownMfaCodeEl.focus();
  } catch {
    ownMfaErrorEl.textContent = 'Connection error';
    ownMfaErrorEl.hidden = false;
    ownMfaSetupEl.hidden = false;
  }
}

async function handleConfirmOwnMfa() {
  ownMfaErrorEl.hidden = true;
  try {
    const res = await fetch('/api/auth/mfa/setup/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: ownMfaTokenEl.value, code: ownMfaCodeEl.value.trim() })
    });
    const data = await res.json();
    if (!res.ok) {
      ownMfaErrorEl.textContent = data.error || 'MFA setup failed.';
      ownMfaErrorEl.hidden = false;
      return;
    }
    state.csrfToken = data.csrfToken || state.csrfToken;
    ownMfaSetupEl.hidden = true;
    setStatus('MFA enabled for your account.');
    await loadUsers();
  } catch {
    ownMfaErrorEl.textContent = 'Connection error';
    ownMfaErrorEl.hidden = false;
  }
}

function getImportRuleFormData() {
  return {
    id: importRuleIdEl?.value.trim() || '',
    name: importRuleNameEl?.value.trim() || '',
    degree: importDegreeEl?.value.trim() || '',
    program: importProgramEl?.value.trim() || '',
    affiliation: importAffiliationEl?.value.trim() || '',
    index: importIndexEl?.value.trim() || '',
    query: importQueryEl?.value.trim() || '',
    source: importSourceEl?.value.trim() || document.getElementById('s-source')?.value.trim() || ''
  };
}

function importRuleTerm(rule = getImportRuleFormData()) {
  return [
    ['degree.raw', rule.degree],
    ['program.raw', rule.program],
    ['affiliation.raw', rule.affiliation]
  ]
    .filter(([, value]) => value)
    .map(([field, value]) => `${field},${value}`)
    .join(';');
}

function updateImportGeneratedTerm() {
  if (!importGeneratedTermEl) return;
  const term = importRuleTerm();
  importGeneratedTermEl.textContent = term || 'No rule filters selected.';
}

function summarizeImportRule(rule) {
  const parts = [
    rule.degree ? `Degree: ${rule.degree}` : '',
    rule.program ? `Program: ${rule.program}` : '',
    rule.affiliation ? `Affiliation: ${rule.affiliation}` : ''
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No filters selected';
}

function renderImportRules() {
  if (!importRulesListEl) return;
  if (!state.importRules.length) {
    importRulesListEl.innerHTML = '<p class="meta">No saved import rules yet.</p>';
    return;
  }
  importRulesListEl.innerHTML = state.importRules.map((rule) => `
    <div class="import-rule-card${rule.id === state.selectedImportRuleId ? ' active' : ''}">
      <label class="import-rule-check">
        <input type="checkbox" data-import-rule-check="${escapeHtml(rule.id)}" ${state.checkedImportRuleIds.has(rule.id) ? 'checked' : ''} />
        <span class="sr-only">Select ${escapeHtml(rule.name || 'import rule')}</span>
      </label>
      <button type="button" class="import-rule-open" data-import-rule-id="${escapeHtml(rule.id)}">
        <strong>${escapeHtml(rule.name || 'Untitled rule')}</strong>
        <span>${escapeHtml(summarizeImportRule(rule))}</span>
      </button>
    </div>
  `).join('');
  for (const btn of importRulesListEl.querySelectorAll('[data-import-rule-id]')) {
    btn.addEventListener('click', () => {
      const rule = state.importRules.find((r) => r.id === btn.dataset.importRuleId);
      if (rule) setImportRuleForm(rule);
    });
  }
  for (const check of importRulesListEl.querySelectorAll('[data-import-rule-check]')) {
    check.addEventListener('change', () => {
      if (check.checked) state.checkedImportRuleIds.add(check.dataset.importRuleCheck);
      else state.checkedImportRuleIds.delete(check.dataset.importRuleCheck);
    });
  }
}

function setImportRuleForm(rule = {}) {
  if (!importRuleForm) return;
  state.selectedImportRuleId = rule.id || '';
  importRuleIdEl.value = rule.id || '';
  importRuleNameEl.value = rule.name || '';
  importDegreeEl.value = rule.degree || '';
  importProgramEl.value = rule.program || '';
  importAffiliationEl.value = rule.affiliation || '';
  importIndexEl.value = rule.index ?? document.getElementById('s-index')?.value ?? '';
  importQueryEl.value = rule.query ?? document.getElementById('s-query')?.value ?? '';
  importSourceEl.value = rule.source || document.getElementById('s-source')?.value || '';
  deleteImportRuleBtn.hidden = !rule.id;
  importRulePreviewEl.innerHTML = '';
  updateImportGeneratedTerm();
  renderImportRules();
  loadImportFacets();
}

async function loadImportRules() {
  if (!importRulesListEl) return;
  try {
    const res = await fetch('/api/admin/import-rules');
    if (!res.ok) return;
    const data = await res.json();
    state.importRules = data.rules || [];
    state.checkedImportRuleIds = new Set(
      Array.from(state.checkedImportRuleIds).filter((id) => state.importRules.some((rule) => rule.id === id))
    );
    renderImportRules();
    if (!state.selectedImportRuleId && state.importRules.length && !importRuleNameEl.value) {
      setImportRuleForm(state.importRules[0]);
    } else if (!importSourceEl.value) {
      setImportRuleForm({});
    }
  } catch { /* ignore */ }
}

function selectedImportRuleIdsForRun() {
  const scope = importRunScopeEl?.value || 'current';
  if (scope === 'all') return state.importRules.map((rule) => rule.id);
  if (scope === 'checked') return Array.from(state.checkedImportRuleIds);
  return state.selectedImportRuleId ? [state.selectedImportRuleId] : [];
}

function importScopeLabel() {
  const scope = importRunScopeEl?.value || 'current';
  if (scope === 'all') return 'all saved rules';
  if (scope === 'checked') return `${state.checkedImportRuleIds.size} checked rule${state.checkedImportRuleIds.size === 1 ? '' : 's'}`;
  const current = state.importRules.find((rule) => rule.id === state.selectedImportRuleId);
  return current ? `"${current.name}"` : 'the current rule';
}

function populateImportDatalist(id, buckets = []) {
  const list = document.getElementById(id);
  if (!list) return;
  list.innerHTML = buckets
    .map((bucket) => `<option value="${escapeHtml(bucket.value)}" label="${formatNum(bucket.count)}"></option>`)
    .join('');
}

async function loadImportFacets() {
  if (!importRuleForm) return;
  try {
    const params = new URLSearchParams(getImportRuleFormData());
    const res = await fetch(`/api/admin/open-collections/facets?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    populateImportDatalist('importDegreeOptions', data.facets?.degree || []);
    populateImportDatalist('importProgramOptions', data.facets?.program || []);
    populateImportDatalist('importAffiliationOptions', data.facets?.affiliation || []);
  } catch { /* ignore */ }
}

async function handleSaveImportRule(e) {
  e.preventDefault();
  const rule = getImportRuleFormData();
  if (!rule.name) {
    importRuleNameEl.focus();
    return;
  }
  const url = rule.id ? `/api/admin/import-rules/${encodeURIComponent(rule.id)}` : '/api/admin/import-rules';
  const method = rule.id ? 'PUT' : 'POST';
  try {
    const res = await fetch(url, {
      method,
      headers: jsonHeaders(),
      body: JSON.stringify(rule)
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.errors ? data.errors.join(' ') : data.error || 'Rule could not be saved.');
      return;
    }
    setStatus('Import rule saved.');
    await loadImportRules();
    setImportRuleForm(data.rule);
  } catch {
    alert('Connection error');
  }
}

async function handlePreviewImportRule() {
  const params = new URLSearchParams({
    ...getImportRuleFormData(),
    maxRecords: document.getElementById('s-maxRecords')?.value || '9999',
    scanLimit: document.getElementById('s-scanLimit')?.value || '50000'
  });
  previewImportRuleBtn.disabled = true;
  previewImportRuleBtn.textContent = 'Previewing...';
  importRulePreviewEl.innerHTML = '<p class="meta">Checking Open Collections...</p>';
  try {
    const res = await fetch(`/api/admin/import-rules/preview?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      importRulePreviewEl.innerHTML = `<p class="meta">${escapeHtml(data.error || 'Preview failed.')}</p>`;
      return;
    }
    const samples = data.samples || [];
    const warnings = data.warnings || [];
    importRulePreviewEl.innerHTML = `
      <p class="settings-status-main">${formatNum(data.total || 0)} matching record${data.total === 1 ? '' : 's'}</p>
      ${warnings.map((warning) => `<p class="import-warning">${escapeHtml(warning)}</p>`).join('')}
      ${samples.length ? `
        <ul class="import-preview-list">
          ${samples.map((doc) => `
            <li><strong>${escapeHtml(doc.title || '(Untitled)')}</strong><br><span class="meta">${escapeHtml(doc.author || 'Unknown')} · ${doc.year || '-'} · ${escapeHtml(doc.degree || '-')}</span></li>
          `).join('')}
        </ul>
      ` : '<p class="meta">No sample records returned.</p>'}
    `;
  } catch {
    importRulePreviewEl.innerHTML = '<p class="meta">Connection error.</p>';
  } finally {
    previewImportRuleBtn.disabled = false;
    previewImportRuleBtn.textContent = 'Preview Matches';
  }
}

async function handleRunImportRules(mode, button) {
  const ruleIds = selectedImportRuleIdsForRun();
  const scope = importRunScopeEl?.value === 'all' ? 'all' : 'selected';
  if (!ruleIds.length) {
    alert(importRunScopeEl?.value === 'checked' ? 'Check at least one import rule.' : 'Select a saved import rule first.');
    return;
  }
  const labels = {
    import_all: 'Import all matching records',
    sync_differences: 'Sync only new matching records',
    refresh_metadata: 'Refresh metadata for cached matching records',
    sync_missing_pdfs: 'Download and analyze missing PDFs'
  };
  if (!confirm(`${labels[mode]} for ${importScopeLabel()}?`)) return;

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Running...';
  try {
    const res = await fetch('/api/admin/import-rules/run', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        mode,
        scope,
        ruleIds,
        maxRecords: document.getElementById('s-maxRecords')?.value || '9999',
        pageSize: document.getElementById('s-pageSize')?.value || '20',
        scanLimit: document.getElementById('s-scanLimit')?.value || '50000',
        downloadFiles: document.getElementById('s-downloadFiles')?.value || '0'
      })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Sync failed.');
      return;
    }
    renderDocumentSyncStatus(data.status);
    const skipped = data.totalSkipped ? `, ${formatNum(data.totalSkipped)} skipped` : '';
    setStatus(`${labels[mode]} complete: ${formatNum(data.totalSaved || 0)} saved/updated${skipped}.`);
  } catch {
    alert('Connection error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function handleDeleteImportRule() {
  const id = importRuleIdEl.value;
  if (!id || !confirm('Delete this import rule?')) return;
  try {
    const res = await fetch(`/api/admin/import-rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: csrfHeaders()
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Delete failed.');
      return;
    }
    setStatus('Import rule deleted.');
    state.selectedImportRuleId = '';
    await loadImportRules();
    setImportRuleForm({});
  } catch {
    alert('Connection error');
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
    apiKeyInput.disabled = Boolean(s.apiKeyManagedByEnv);
    apiKeyInput.placeholder = s.apiKeyManagedByEnv
      ? 'Managed by UBC_API_KEY environment variable'
      : s.apiKeyConfigured
      ? 'Stored on server (enter a new key to replace)'
      : 'No API key saved (optional)';
    if (s.downloadFiles) document.getElementById('s-downloadFiles').value = s.downloadFiles;
    if (s.recomputeFromCache) document.getElementById('s-recomputeFromCache').value = s.recomputeFromCache;
    if (importRuleForm && !state.selectedImportRuleId && !importSourceEl.value) {
      importIndexEl.value = document.getElementById('s-index').value;
      importQueryEl.value = document.getElementById('s-query').value;
      importSourceEl.value = document.getElementById('s-source').value;
      updateImportGeneratedTerm();
    }
    await loadDocumentSyncStatus();
  } catch { /* ignore */ }
}

async function handleSaveSettings() {
  const params = getCurrentParams({ includeApiKey: true });
  if (!params.apiKey) delete params.apiKey;
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify(params)
    });
    if (res.ok) {
      setStatus('Settings saved.');
    } else {
      const data = await res.json().catch(() => ({}));
      setStatus(data.error || 'Settings could not be saved.');
    }
  } catch { /* ignore */ }
}

function renderDocumentSyncStatus(status) {
  if (!documentSyncStatusEl) return;
  if (!status) {
    documentSyncStatusEl.innerHTML = `
      <p class="settings-status-title">Document Cache</p>
      <p class="settings-status-main">Status unavailable</p>
    `;
    return;
  }
  const cache = status.cache || {};
  const latest = status.latest || {};
  const total = Number(cache.total || 0);
  const lastSynced = cache.lastSyncedAt ? new Date(cache.lastSyncedAt).toLocaleString() : 'Never synced';
  const runStatus = status.running
    ? 'Sync running'
    : latest.status
      ? `Last sync ${latest.status}`
      : 'No Open Collections sync run yet';
  const saved = latest.status
    ? `${formatNum(latest.totalSaved || 0)} saved${latest.apiTotal ? ` of ${formatNum(latest.apiTotal)}` : ''}`
    : '';
  const main = total > 0
    ? `${formatNum(total)} cached document${total === 1 ? '' : 's'}`
    : 'No cached documents';
  documentSyncStatusEl.innerHTML = `
    <p class="settings-status-title">Document Cache</p>
    <p class="settings-status-main">${escapeHtml(main)}</p>
    <p class="settings-status-detail">${escapeHtml(runStatus)}${saved ? ` · ${escapeHtml(saved)}` : ''}</p>
    <p class="settings-status-detail">Last synced: ${escapeHtml(lastSynced)}</p>
  `;
}

async function loadDocumentSyncStatus() {
  try {
    const res = await fetch('/api/admin/documents/sync/status');
    if (!res.ok) return;
    const data = await res.json();
    renderDocumentSyncStatus(data.status);
  } catch { /* ignore */ }
}

async function handleSyncDocuments() {
  if (!syncDocumentsBtn) return;
  syncDocumentsBtn.disabled = true;
  syncDocumentsBtn.textContent = 'Syncing Metadata...';
  try {
    const params = getCurrentParams();
    const res = await fetch('/api/admin/documents/sync', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(params)
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Document sync failed');
      return;
    }
    renderDocumentSyncStatus(data.status);
    setStatus(data.alreadyRunning ? 'Document sync is already running.' : 'Document sync started.');
  } catch {
    alert('Connection error');
  } finally {
    syncDocumentsBtn.disabled = false;
    syncDocumentsBtn.textContent = 'Sync Open Collections Metadata';
  }
}

function renderConceptPipelineStatus(status) {
  if (!conceptPipelineStatusEl) return;
  if (!status) {
    conceptPipelineStatusEl.innerHTML = `
      <p class="settings-status-title">Concept Dictionary</p>
      <p class="settings-status-main">Status unavailable</p>
    `;
    return;
  }
  const stateLabel = status.status || 'idle';
  const updated = status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : 'Never rebuilt';
  const message = status.message || 'No recent rebuild message.';
  conceptPipelineStatusEl.innerHTML = `
    <p class="settings-status-title">Concept Dictionary</p>
    <p class="settings-status-main">${escapeHtml(stateLabel[0].toUpperCase() + stateLabel.slice(1))}</p>
    <p class="settings-status-detail">Last successful rebuild: ${escapeHtml(updated)}</p>
    <p class="settings-status-detail">${escapeHtml(message)}</p>
  `;
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
    const res = await fetch('/api/admin/concepts/rebuild', { method: 'POST', headers: csrfHeaders() });
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
    rebuildConceptsBtn.textContent = 'Rebuild Concept Dictionary';
  }
}

function formatJobDate(value) {
  return value ? new Date(value).toLocaleString() : '-';
}

function summarizeJobResult(job) {
  if (job.error) return job.error;
  const result = job.result || {};
  if (job.type === 'catalogue_lookup') {
    return `${formatNum(result.processed || 0)} checked, ${formatNum(result.found || 0)} found`;
  }
  if (job.type === 'bertopic') {
    return `${formatNum(result.topics || 0)} topics, ${formatNum(result.assignedDocuments || 0)} documents`;
  }
  if (job.type === 'document_sync' || job.type === 'import_rules_sync') {
    return `${formatNum(result.totalSaved || 0)} saved, ${formatNum(result.totalSkipped || 0)} skipped`;
  }
  if (job.type === 'cache_refresh_doc' || job.type === 'cache_reanalyze_doc') {
    return result.docId ? `${escapeHtml(result.docId)}: ${escapeHtml(result.status || job.status || '-')}` : '-';
  }
  if (job.type === 'reparse_all') {
    return `${formatNum(result.processed || 0)} processed, ${formatNum(result.citations || 0)} citations`;
  }
  if (job.type === 'reparse_committee') {
    return `${formatNum(result.processed || 0)} processed, ${formatNum(result.withCommittee || 0)} with committee`;
  }
  return Object.keys(result).length ? JSON.stringify(result) : '-';
}

function workerJobDetail(job) {
  const parts = [];
  if (job.runnerType) parts.push(job.runnerType);
  if (job.runnerId) parts.push(job.runnerId);
  if (job.runnerState) parts.push(job.runnerState);
  if (job.timeoutAt && job.status === 'running') parts.push(`timeout ${formatJobDate(job.timeoutAt)}`);
  if (job.heartbeatAt && job.status === 'running') parts.push(`heartbeat ${formatJobDate(job.heartbeatAt)}`);
  return parts.join(' · ');
}

function formatJobCounts(counts = {}) {
  const parts = [];
  if (counts.processed != null && counts.total != null) {
    parts.push(`${formatNum(counts.processed)} / ${formatNum(counts.total)}`);
  }
  if (counts.citations != null) parts.push(`${formatNum(counts.citations)} citations`);
  if (counts.fuzzyMatches != null) parts.push(`${formatNum(counts.fuzzyMatches)} fuzzy`);
  if (counts.exactMatches != null) parts.push(`${formatNum(counts.exactMatches)} exact`);
  if (counts.newCitations != null) parts.push(`${formatNum(counts.newCitations)} new`);
  if (counts.pages != null) parts.push(`${formatNum(counts.pages)} pages`);
  if (counts.words != null) parts.push(`${formatNum(counts.words)} words`);
  if (counts.saved != null) parts.push(`${formatNum(counts.saved)} saved`);
  return parts.join(' · ');
}

function renderJobProgress(job) {
  const progress = job.progress || {};
  const tasks = Array.isArray(progress.tasks) ? progress.tasks : [];
  if (!progress.currentTask && !tasks.length) return '';
  const visibleTasks = tasks.slice(-5);
  return `
    <div class="job-progress">
      ${progress.currentTask ? `<div class="job-progress-current">${escapeHtml(progress.currentTask)}</div>` : ''}
      ${visibleTasks.length ? `<div class="job-progress-steps">
        ${visibleTasks.map((task) => {
          const counts = formatJobCounts(task.counts || {});
          return `<div class="job-progress-step ${escapeHtml(task.status || 'running')}">
            <span>${escapeHtml(task.status || 'running')}</span>
            <strong>${escapeHtml(task.label || task.key || 'Task')}</strong>
            ${task.detail ? `<em>${escapeHtml(task.detail)}</em>` : ''}
            ${counts ? `<small>${escapeHtml(counts)}</small>` : ''}
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>
  `;
}

function renderJobs(data = {}) {
  const catalogue = data.catalogueStats || {};
  const topic = data.topicStatus || {};
  const docSync = data.documentSyncStatus || {};
  const concept = data.conceptStatus || {};
  if (jobsStatusCardsEl) {
    jobsStatusCardsEl.innerHTML = `
      <div class="settings-status-card">
        <p class="settings-status-title">Catalogue Lookups</p>
        <p class="settings-status-main">${formatNum(catalogue.total || 0)} checked</p>
        <p class="settings-status-detail">${formatNum(catalogue.found || 0)} found · ${formatNum(catalogue.not_found || 0)} not found · ${formatNum(catalogue.skipped || 0)} skipped</p>
      </div>
      <div class="settings-status-card">
        <p class="settings-status-title">BERTopic</p>
        <p class="settings-status-main">${formatNum(topic.topics || 0)} topics</p>
        <p class="settings-status-detail">${formatNum(topic.assignedDocuments || 0)} assigned documents · built ${escapeHtml(formatJobDate(topic.createdAt))}</p>
      </div>
      <div class="settings-status-card">
        <p class="settings-status-title">Import/PDF Sync</p>
        <p class="settings-status-main">${docSync.running ? 'Running' : (docSync.latest?.status || 'Idle')}</p>
        <p class="settings-status-detail">${formatNum(docSync.latest?.totalSeen || 0)} seen · ${formatNum(docSync.latest?.totalSaved || 0)} saved</p>
      </div>
      <div class="settings-status-card">
        <p class="settings-status-title">Concept Dictionary</p>
        <p class="settings-status-main">${escapeHtml(concept.status || 'idle')}</p>
        <p class="settings-status-detail">Last success: ${escapeHtml(formatJobDate(concept.lastSuccessAt))}</p>
      </div>
    `;
  }

  if (jobsTableEl) {
    const jobs = data.jobs || [];
    const hasRunning = jobs.some((job) => job.status === 'running');
    if (hasRunning && !jobsPollTimer) {
      jobsPollTimer = setInterval(loadJobs, 5000);
    } else if (!hasRunning && jobsPollTimer) {
      clearInterval(jobsPollTimer);
      jobsPollTimer = null;
    }
    jobsTableEl.innerHTML = jobs.length
      ? jobs.map((job) => `
        <tr>
          <td>${escapeHtml(job.label || job.type)}</td>
          <td>${escapeHtml(job.status || '-')}</td>
          <td>${escapeHtml(formatJobDate(job.startedAt))}</td>
          <td>${escapeHtml(formatJobDate(job.finishedAt))}</td>
          <td title="${escapeHtml(job.log || '')}">
            ${escapeHtml(summarizeJobResult(job))}
            ${renderJobProgress(job)}
            ${workerJobDetail(job) ? `<div class="meta">${escapeHtml(workerJobDetail(job))}</div>` : ''}
          </td>
          <td>
            ${job.status === 'running' && job.runnerType ? `<button class="btn danger btn-sm" data-cancel-job="${job.id}">Cancel</button>` : ''}
          </td>
        </tr>
      `).join('')
      : '<tr><td colspan="6">No jobs have run yet.</td></tr>';

    for (const btn of jobsTableEl.querySelectorAll('[data-cancel-job]')) {
      btn.addEventListener('click', async () => {
        if (!confirm('Cancel this worker job?')) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/admin/jobs/${encodeURIComponent(btn.dataset.cancelJob)}/cancel`, {
            method: 'POST',
            headers: csrfHeaders(),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            alert(data.error || 'Job could not be cancelled.');
            return;
          }
          setStatus('Worker job cancelled.');
          await loadJobs();
        } catch {
          alert('Connection error');
        }
      });
    }
  }

  if (syncRunsTableEl) {
    const runs = data.syncRuns || [];
    syncRunsTableEl.innerHTML = runs.length
      ? runs.map((run) => `
        <tr>
          <td>${formatNum(run.id)}</td>
          <td>${escapeHtml(run.status || '-')}</td>
          <td>${formatNum(run.totalSeen || 0)}</td>
          <td>${formatNum(run.totalSaved || 0)}</td>
          <td>${escapeHtml(formatJobDate(run.startedAt))}</td>
          <td>${escapeHtml(run.error || formatJobDate(run.finishedAt))}</td>
        </tr>
      `).join('')
      : '<tr><td colspan="6">No import or PDF sync runs have run yet.</td></tr>';
  }
}

async function loadJobs() {
  if (!jobsTableEl) return;
  try {
    const res = await fetch('/api/admin/jobs');
    if (!res.ok) return;
    const data = await res.json();
    renderJobs(data);
  } catch { /* ignore */ }
}

async function handlePreviewCatalogueLookups() {
  if (!catalogueLookupPreviewEl) return;
  const limit = catalogueLookupLimitEl?.value || '100';
  previewCatalogueLookupsBtn.disabled = true;
  catalogueLookupPreviewEl.innerHTML = '<p class="meta">Checking pending citations...</p>';
  try {
    const res = await fetch('/api/admin/jobs/catalogue-lookup', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ limit, dryRun: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      catalogueLookupPreviewEl.innerHTML = `<p class="form-error">${escapeHtml(data.error || 'Preview failed.')}</p>`;
      return;
    }
    const previews = data.previews || [];
    catalogueLookupPreviewEl.innerHTML = `
      <p class="settings-status-main">${formatNum(data.total || 0)} pending citation${data.total === 1 ? '' : 's'}</p>
      ${previews.slice(0, 5).map((item) => `<p class="meta">${escapeHtml(item.queryAuthor || 'Unknown author')} · ${escapeHtml(item.queryTitle || item.citationText || '')}</p>`).join('')}
    `;
  } catch {
    catalogueLookupPreviewEl.innerHTML = '<p class="form-error">Connection error.</p>';
  } finally {
    previewCatalogueLookupsBtn.disabled = false;
  }
}

async function handleRunCatalogueLookups() {
  const limit = catalogueLookupLimitEl?.value || '100';
  runCatalogueLookupsBtn.disabled = true;
  runCatalogueLookupsBtn.textContent = 'Starting...';
  try {
    const res = await fetch('/api/admin/jobs/catalogue-lookup', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ limit }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Catalogue lookup job failed to start.');
      return;
    }
    setStatus(data.alreadyRunning ? 'Catalogue lookup job is already running.' : 'Catalogue lookup job started.');
    await loadJobs();
  } catch {
    alert('Connection error');
  } finally {
    runCatalogueLookupsBtn.disabled = false;
    runCatalogueLookupsBtn.textContent = 'Run Pending Lookups';
  }
}

async function handleRunBertopic() {
  if (!confirm('Run BERTopic now? This can take several minutes and may use substantial CPU and memory.')) return;
  runBertopicBtn.disabled = true;
  runBertopicBtn.textContent = 'Starting...';
  try {
    const res = await fetch('/api/admin/jobs/bertopic', {
      method: 'POST',
      headers: csrfHeaders(),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'BERTopic job failed to start.');
      return;
    }
    setStatus(data.alreadyRunning ? 'BERTopic is already running.' : 'BERTopic job started.');
    await loadJobs();
  } catch {
    alert('Connection error');
  } finally {
    runBertopicBtn.disabled = false;
    runBertopicBtn.textContent = 'Run BERTopic';
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
    state.cacheEntries = entriesData.entries || [];
    renderCacheStats(statsData.stats);
    renderCache(state.cacheEntries);
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
  const filter = state.cacheFilterText.toLowerCase();
  const filtered = (entries || []).filter((e) => {
    if (!filter) return true;
    const haystack = [
      e.doc_id,
      e.title,
      e.author,
      ...(Array.isArray(e.supervisors) ? e.supervisors : [])
    ].join(' ').toLowerCase();
    return haystack.includes(filter);
  });
  if (!filtered.length) {
    el.innerHTML = `<tr><td colspan="8">${entries?.length ? 'No cache entries match the current filter.' : 'No cache entries.'}</td></tr>`;
    return;
  }
  el.innerHTML = filtered.slice(0, 200).map((e) => `
    <tr>
      <td title="${escapeHtml(e.doc_id)}">${escapeHtml(String(e.doc_id).slice(0, 30))}</td>
      <td>
        <strong>${escapeHtml(e.title || '(Untitled)')}</strong>
        <div class="meta">${escapeHtml([e.author, ...(Array.isArray(e.supervisors) ? e.supervisors : [])].filter(Boolean).join(' · ') || '-')}</div>
      </td>
      <td>${escapeHtml(e.status || '-')}</td>
      <td>${formatBytes(e.file_bytes)}</td>
      <td>${formatNum(e.page_count)}</td>
      <td>${formatNum(e.word_count)}</td>
      <td>${e.updated_at ? new Date(e.updated_at).toLocaleDateString() : '-'}</td>
      <td class="cache-actions">
        <button class="btn ghost btn-sm" data-reanalyze-cache="${escapeHtml(e.doc_id)}">Reanalyze Cached PDF</button>
        <button class="btn ghost btn-sm" data-refresh-cache="${escapeHtml(e.doc_id)}">Redownload &amp; Analyze</button>
        <button class="btn danger btn-sm" data-delete-cache="${escapeHtml(e.doc_id)}">Del</button>
      </td>
    </tr>
  `).join('');

  for (const btn of el.querySelectorAll('[data-refresh-cache]')) {
    btn.addEventListener('click', async () => {
      const docId = btn.dataset.refreshCache;
      btn.disabled = true;
      btn.textContent = 'Analyzing...';
      try {
        const res = await fetch(`/api/admin/cache/${encodeURIComponent(docId)}/refresh`, { method: 'POST', headers: csrfHeaders() });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'PDF redownload and analysis failed');
          return;
        }
        setStatus(data.alreadyRunning ? 'A worker job is already running.' : `PDF refresh worker started for ${docId}.`);
        await loadJobs();
      } catch {
        alert('Connection error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Redownload & Analyze';
      }
    });
  }

  for (const btn of el.querySelectorAll('[data-reanalyze-cache]')) {
    btn.addEventListener('click', async () => {
      const docId = btn.dataset.reanalyzeCache;
      btn.disabled = true;
      btn.textContent = 'Reanalyzing...';
      try {
        const res = await fetch(`/api/admin/cache/${encodeURIComponent(docId)}/reanalyze`, { method: 'POST', headers: csrfHeaders() });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Cached PDF reanalysis failed');
          return;
        }
        setStatus(data.alreadyRunning ? 'A worker job is already running.' : `Cached PDF reanalysis worker started for ${docId}.`);
        await loadJobs();
      } catch {
        alert('Connection error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Reanalyze Cached PDF';
      }
    });
  }

  for (const btn of el.querySelectorAll('[data-delete-cache]')) {
    btn.addEventListener('click', async () => {
      const docId = btn.dataset.deleteCache;
      try {
        const res = await fetch(`/api/admin/cache/${encodeURIComponent(docId)}`, { method: 'DELETE', headers: csrfHeaders() });
        if (res.ok) await loadCache();
      } catch { /* ignore */ }
    });
  }
}

async function handleRefreshCache() {
  try {
    await fetch('/api/admin/cache/refresh', { method: 'POST', headers: csrfHeaders() });
    setStatus('In-memory cache cleared. Next query will re-fetch.');
  } catch { /* ignore */ }
}

async function handleReparseAll() {
  reparseAllBtn.disabled = true;
  reparseAllBtn.textContent = 'Reparsing...';
  try {
    const res = await fetch('/api/admin/reparse-all', { method: 'POST', headers: csrfHeaders() });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Reparse failed');
      return;
    }
    setStatus(data.alreadyRunning ? 'A reparse worker is already running.' : 'Reparse worker started.');
    await loadJobs();
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

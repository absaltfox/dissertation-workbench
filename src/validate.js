export function parseNumberParam(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseBooleanParam(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  return fallback;
}

export function validateMetricsParams({ maxRecords, pageSize, scanLimit, subjectLimit, index, query, term, source }) {
  const errors = [];

  if (maxRecords != null && maxRecords !== '') {
    const n = Number(maxRecords);
    if (!Number.isFinite(n) || n < 1 || n > 9999) errors.push('maxRecords must be between 1 and 9999.');
  }
  if (pageSize != null && pageSize !== '') {
    const n = Number(pageSize);
    if (!Number.isFinite(n) || n < 1 || n > 100) errors.push('pageSize must be between 1 and 100.');
  }
  if (scanLimit != null && scanLimit !== '') {
    const n = Number(scanLimit);
    if (!Number.isFinite(n) || n < 1 || n > 50000) errors.push('scanLimit must be between 1 and 50000.');
  }
  if (subjectLimit != null && subjectLimit !== '') {
    const n = Number(subjectLimit);
    if (!Number.isFinite(n) || n < 1 || n > 100) errors.push('subjectLimit must be between 1 and 100.');
  }
  if (index != null && String(index).length > 200) errors.push('index must be at most 200 characters.');
  if (query != null && String(query).length > 500) errors.push('query must be at most 500 characters.');
  if (term != null && String(term).length > 500) errors.push('term must be at most 500 characters.');
  if (source != null && String(source).length > 2000) errors.push('source must be at most 2000 characters.');

  return { valid: errors.length === 0, errors };
}

export function validateAdminUser(username, password) {
  const errors = [];
  if (!username || typeof username !== 'string') {
    errors.push('Username is required.');
  } else {
    if (username.length < 3 || username.length > 50) errors.push('Username must be 3-50 characters.');
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) errors.push('Username must be alphanumeric (plus _ and -).');
  }
  if (!password || typeof password !== 'string') {
    errors.push('Password is required.');
  } else if (password.length < 8) {
    errors.push('Password must be at least 8 characters.');
  }
  return { valid: errors.length === 0, errors };
}

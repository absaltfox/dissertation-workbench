import { flattenText } from './nlp.js';

export const ACCESS_STATUS = Object.freeze({
  AVAILABLE: 'available',
  EMBARGOED: 'embargoed',
  VERIFICATION_DUE: 'verification_due',
  UNKNOWN: 'unknown',
});

// Repository-generated placeholder text must never be treated as scholarly
// content. Keep this deliberately narrow: ordinary missing/unavailable files
// are not evidence of an embargo.
const EMBARGO_PLACEHOLDER_PATTERNS = [
  // These intentionally require a repository-style full-text availability
  // statement. An abstract that discusses an embargo as a research topic is
  // not an access notice, even if it uses words such as "available".
  /\b(?:the\s+)?full\s+text(?:\s+of\s+(?:this\s+)?(?:item|thesis|dissertation))?\b.{0,100}(?:will be|will become|is to be|becomes?)\s+available.{0,100}\b(?:embargo|restriction)\b.{0,40}\b(?:expires?|ends?|lifts?)\b/is,
  /\b(?:embargo|restriction)\b.{0,40}\b(?:expires?|ends?|lifts?)\b.{0,100}\b(?:the\s+)?full\s+text\b.{0,100}\b(?:will be|becomes?)\s+available\b/is,
  /\b(?:the\s+)?full\s+text\b.{0,100}\bavailable\s+(?:after|when|once)\b.{0,40}\b(?:embargo|restriction)\b.{0,30}\b(?:expires?|ends?|lifts?)\b/is,
  /\b(?:the\s+)?full\s+text\b.{0,100}\b(?:not currently available|will (?:be|become) available)\b.{0,100}\b(?:embargo|restriction)\b/is,
  /\b(?:the\s+)?full\s+text\b.{0,100}\b(?:under|subject to)\s+(?:an?\s+)?(?:embargo|restriction)\b.{0,100}\b(?:available|released)\b/is,
];

function firstScalar(value) {
  if (Array.isArray(value)) return value.map(firstScalar).find(Boolean) || '';
  if (value && typeof value === 'object') {
    return firstScalar(value.value ?? value.display ?? value.label ?? '');
  }
  return flattenText(value);
}

function firstPresent(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

export function isEmbargoPlaceholder(value) {
  const text = flattenText(value).replace(/\s+/g, ' ').trim();
  return Boolean(text && EMBARGO_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text)));
}

export function parseAvailabilityDate(value) {
  const raw = firstScalar(value).trim();
  if (!raw) return null;
  const match = raw.match(/\b(\d{4})-(\d{2})-(\d{2})((?:T|\s)\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?/i);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const time = match[4] ? match[4].trim().replace(/^t/i, 'T') : '';
  if (time) {
    const timeMatch = time.match(/^T?(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))?$/i);
    if (!timeMatch) return null;
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const second = timeMatch[3] == null ? 0 : Number(timeMatch[3]);
    const offsetHour = timeMatch[5] == null ? 0 : Number(timeMatch[5]);
    const offsetMinute = timeMatch[6] == null ? 0 : Number(timeMatch[6]);
    if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  }
  const timestamp = time
    ? `${date}${time.startsWith('T') ? time : `T${time}`}${/(?:Z|[+-]\d{2}:\d{2})$/i.test(time) ? '' : 'Z'}`
    : `${date}T00:00:00.000Z`;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function deriveAccessState(doc, { now = new Date() } = {}) {
  const availabilityRaw = firstPresent(doc, [
    'date_available', 'DateAvailable', 'dateAvailable', 'dc.date.available',
  ]);
  const descriptionRaw = firstPresent(doc, ['description', 'Description', 'abstract', 'Abstract']);
  const availableAt = parseAvailabilityDate(availabilityRaw);
  const placeholder = isEmbargoPlaceholder(descriptionRaw);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const futureAvailability = Boolean(availableAt && new Date(availableAt).getTime() > nowMs);

  if (futureAvailability || (placeholder && !availableAt)) {
    const evidence = [];
    if (futureAvailability) evidence.push('future_repository_availability_date');
    if (placeholder) evidence.push('repository_embargo_placeholder');
    return {
      accessStatus: ACCESS_STATUS.EMBARGOED,
      availableAt,
      accessStatusSource: 'repository_metadata',
      accessStatusReason: evidence.join('+'),
      accessEvidence: {
        dateAvailableRaw: firstScalar(availabilityRaw) || null,
        embargoPlaceholder: placeholder,
      },
      isEmbargoPlaceholder: placeholder,
    };
  }

  // An elapsed date only opens the record for verification. It does not prove
  // that a PDF is actually available; successful resolution establishes that.
  return {
    accessStatus: placeholder ? ACCESS_STATUS.VERIFICATION_DUE : ACCESS_STATUS.UNKNOWN,
    availableAt,
    accessStatusSource: availableAt || placeholder ? 'repository_metadata' : null,
    accessStatusReason: availableAt
      ? 'availability_date_reached_pending_verification'
      : (placeholder ? 'availability_date_reached_pending_verification' : null),
    accessEvidence: (availabilityRaw || placeholder) ? {
      dateAvailableRaw: firstScalar(availabilityRaw) || null,
      embargoPlaceholder: placeholder,
    } : null,
    isEmbargoPlaceholder: placeholder,
  };
}

export function isEmbargoDeferred(record, now = new Date()) {
  if (record?.accessStatus !== ACCESS_STATUS.EMBARGOED) return false;
  if (!record.availableAt) return true;
  const availableMs = new Date(record.availableAt).getTime();
  return Number.isFinite(availableMs) && availableMs > new Date(now).getTime();
}

export function isAnalyticallyEligible(record) {
  return ![ACCESS_STATUS.EMBARGOED, ACCESS_STATUS.VERIFICATION_DUE]
    .includes(record?.accessStatus);
}

export function isAccessRestricted(record) {
  return !isAnalyticallyEligible(record);
}

export const ACTIVE_ANALYTICS_ACCESS_SQL = `(
  COALESCE(d.access_status, 'unknown') NOT IN ('embargoed', 'verification_due')
)`;

export const CONTENT_RETRY_ACCESS_SQL = `(
  COALESCE(d.access_status, 'unknown') <> 'embargoed'
  OR (d.available_at IS NOT NULL AND datetime(d.available_at) <= CURRENT_TIMESTAMP)
)`;

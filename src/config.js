import path from 'node:path';

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEFAULT_BASE_URL = process.env.UBC_API_BASE_URL || 'https://oc-index.library.ubc.ca';
export const DEFAULT_INDEX = process.env.UBC_INDEX || '24';
export const DEFAULT_API_KEY = process.env.UBC_API_KEY || '';
export const DEFAULT_QUERY = process.env.UBC_QUERY || '';
export const DEFAULT_TERM = process.env.UBC_TERM || 'degree.raw,Doctor of Education - EdD';
export const DEFAULT_SOURCE = process.env.UBC_SOURCE || [
  'title', 'author', 'ubc_date_sort', 'uri', 'creator', 'supervisor', 'description', 'genre',
  'date_available', 'rights', 'doi', 'affiliation', 'degree_theses', 'program_theses',
  'scholarly_level', 'campus', 'degree', 'program', 'extent', 'identifier', 'id', 'subject'
].join(',');
export const DEFAULT_DOWNLOAD_FILES = process.env.DOWNLOAD_FILES !== '0';
export const FILE_CONCURRENCY = 2;
export const DATA_DIR = process.env.APP_DATA_DIR || path.join(process.cwd(), 'data');
export const PDF_CACHE_DIR = process.env.PDF_CACHE_DIR || path.join(DATA_DIR, 'pdf-cache');
export const SQLITE_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'metrics.sqlite');
export const PORT = Number(process.env.PORT || 3000);
export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
export const DOWNLOAD_TIMEOUT_MS = 30_000; // 30 seconds
export const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
export const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE
  ? /^(1|true|yes)$/i.test(process.env.SESSION_COOKIE_SECURE)
  : IS_PRODUCTION;
export const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000);
export const LOGIN_BLOCK_MS = Number(process.env.LOGIN_BLOCK_MS || 15 * 60 * 1000);
export const LOGIN_MAX_ATTEMPTS_IP = Number(process.env.LOGIN_MAX_ATTEMPTS_IP || 25);
export const LOGIN_MAX_ATTEMPTS_USER = Number(process.env.LOGIN_MAX_ATTEMPTS_USER || 10);
export const LOGIN_FAILURE_DELAY_MS = Number(process.env.LOGIN_FAILURE_DELAY_MS || 350);
export const PUBLIC_MAX_RECORDS = Number(process.env.PUBLIC_MAX_RECORDS || (IS_PRODUCTION ? 300 : 2000));
export const PUBLIC_SCAN_LIMIT = Number(process.env.PUBLIC_SCAN_LIMIT || (IS_PRODUCTION ? 5000 : 50000));
export const ALLOW_PUBLIC_DOWNLOADS = process.env.ALLOW_PUBLIC_DOWNLOADS
  ? /^(1|true|yes)$/i.test(process.env.ALLOW_PUBLIC_DOWNLOADS)
  : !IS_PRODUCTION;
export const ALLOW_PUBLIC_REFRESH = process.env.ALLOW_PUBLIC_REFRESH
  ? /^(1|true|yes)$/i.test(process.env.ALLOW_PUBLIC_REFRESH)
  : !IS_PRODUCTION;
export const ALLOW_PUBLIC_RECOMPUTE = process.env.ALLOW_PUBLIC_RECOMPUTE
  ? /^(1|true|yes)$/i.test(process.env.ALLOW_PUBLIC_RECOMPUTE)
  : !IS_PRODUCTION;
export const EXPOSE_ERROR_DETAILS = process.env.EXPOSE_ERROR_DETAILS
  ? /^(1|true|yes)$/i.test(process.env.EXPOSE_ERROR_DETAILS)
  : !IS_PRODUCTION;

export const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'among', 'also', 'been', 'before', 'being', 'between',
  'both', 'can', 'could', 'did', 'does', 'doing', 'during', 'each', 'from', 'have', 'having',
  'here', 'into', 'itself', 'just', 'more', 'most', 'much', 'must', 'only', 'other', 'over',
  'same', 'should', 'some', 'such', 'than', 'that', 'their', 'theirs', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'under', 'until', 'very', 'were', 'what', 'when',
  'where', 'which', 'while', 'with', 'within', 'without', 'would', 'your', 'yours', 'study',
  'research', 'thesis', 'dissertation', 'ubc', 'university', 'doctoral', 'doctor', 'education'
]);

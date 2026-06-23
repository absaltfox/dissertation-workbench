import path from 'node:path';
import fs from 'node:fs';
import './env.js';

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEFAULT_BASE_URL = process.env.UBC_API_BASE_URL || 'https://oc-index.library.ubc.ca';
export const DEFAULT_INDEX = process.env.UBC_INDEX || '';
export const DEFAULT_API_KEY = process.env.UBC_API_KEY || '';
export const DEFAULT_QUERY = process.env.UBC_QUERY || '';
export const DEFAULT_TERM = process.env.UBC_TERM || 'degree.raw,Doctor of Education - EdD';
export const DEFAULT_SOURCE = process.env.UBC_SOURCE || [
  'title', 'author', 'ubc_date_sort', 'uri', 'creator', 'supervisor', 'description', 'genre',
  'date_available', 'rights', 'doi', 'affiliation', 'degree_theses', 'program_theses',
  'scholarly_level', 'campus', 'degree', 'program', 'extent', 'identifier', 'id', 'subject',
  'digitalResourceOriginalRecord'
].join(',');
export const DEFAULT_DOWNLOAD_FILES = process.env.DOWNLOAD_FILES !== '0';
export const FILE_CONCURRENCY = 2;
export const PDF_DOWNLOAD_RATE_PER_MIN = Number(process.env.PDF_DOWNLOAD_RATE_PER_MIN || 0); // 0 = unlimited
export const DATA_DIR = process.env.APP_DATA_DIR || path.join(process.cwd(), 'data');
export const PDF_CACHE_DIR = process.env.PDF_CACHE_DIR || path.join(DATA_DIR, 'pdf-cache');
export const FULL_TEXT_CACHE_DIR = process.env.FULL_TEXT_CACHE_DIR || path.join(DATA_DIR, 'full-text-cache');
export const GROBID_URL = process.env.GROBID_URL || (
  process.env.FLY_APP_NAME
    ? `http://${process.env.FLY_APP_NAME}-grobid.internal:8070`
    : 'http://localhost:8070'
);
export const GROBID_STARTUP_WAIT_MS = Number(process.env.GROBID_STARTUP_WAIT_MS || 7 * 60 * 1000);

export const SQLITE_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'metrics.sqlite');
export const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
export const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
export const PORT = Number(process.env.PORT || 3000);
export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
export const DOWNLOAD_TIMEOUT_MS = 30_000; // 30 seconds
export const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
export const PDF_ALLOWED_HOSTS = (process.env.PDF_ALLOWED_HOSTS || 'open.library.ubc.ca,oc-index.library.ubc.ca')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
export const PDF_ALLOW_HTTP_DOWNLOADS = process.env.PDF_ALLOW_HTTP_DOWNLOADS
  ? /^(1|true|yes)$/i.test(process.env.PDF_ALLOW_HTTP_DOWNLOADS)
  : !IS_PRODUCTION;
export const BERTOPIC_PYTHON_COMMAND = process.env.BERTOPIC_PYTHON_COMMAND || 'python3';
export const BERTOPIC_TIMEOUT_MS = Number(process.env.BERTOPIC_TIMEOUT_MS || 60 * 60 * 1000);
export const ADMIN_WORKER_TIMEOUT_MS = Number(process.env.ADMIN_WORKER_TIMEOUT_MS || 6 * 60 * 60 * 1000);
export const ADMIN_WORKER_GRACE_MS = Number(process.env.ADMIN_WORKER_GRACE_MS || 30_000);
export const ADMIN_WORKER_MODE = process.env.ADMIN_WORKER_MODE || 'auto';
export const WORKER_IMAGE = process.env.WORKER_IMAGE || process.env.FLY_IMAGE_REF || '';
export const WORKER_ARTIFACT_BASE_URL = process.env.WORKER_ARTIFACT_BASE_URL || '';
export const WORKER_FORCE_ARTIFACT_API = /^(1|true|yes)$/i.test(process.env.WORKER_FORCE_ARTIFACT_API || '');
export const FLY_API_HOSTNAME = process.env.FLY_API_HOSTNAME || 'https://api.machines.dev';
export const FLY_API_TOKEN = process.env.FLY_API_TOKEN || '';
export const GROBID_FLY_API_TOKEN = process.env.GROBID_FLY_API_TOKEN || FLY_API_TOKEN;
export const FLY_APP_NAME = process.env.FLY_APP_NAME || '';
export const FLY_MACHINE_ID = process.env.FLY_MACHINE_ID || '';
export const FLY_REGION = process.env.FLY_REGION || process.env.PRIMARY_REGION || '';
export const FLY_WORKER_MEMORY_MB = Number(process.env.FLY_WORKER_MEMORY_MB || 2048);
export const FLY_WORKER_CPUS = Number(process.env.FLY_WORKER_CPUS || 1);
export const FLY_WORKER_CPU_KIND = process.env.FLY_WORKER_CPU_KIND || 'shared';
export const FLY_WORKER_REGION = process.env.FLY_WORKER_REGION || FLY_REGION || '';
export const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE
  ? /^(1|true|yes)$/i.test(process.env.SESSION_COOKIE_SECURE)
  : IS_PRODUCTION;
export const REQUIRE_ADMIN_MFA = process.env.REQUIRE_ADMIN_MFA
  ? /^(1|true|yes)$/i.test(process.env.REQUIRE_ADMIN_MFA)
  : IS_PRODUCTION;
export const API_KEY_ENCRYPTION_KEY = process.env.API_KEY_ENCRYPTION_KEY || '';
export const MFA_SECRET_ENCRYPTION_KEY = process.env.MFA_SECRET_ENCRYPTION_KEY || '';
export const ADMIN_BOOTSTRAP_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
export const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000);
export const LOGIN_BLOCK_MS = Number(process.env.LOGIN_BLOCK_MS || 15 * 60 * 1000);
export const LOGIN_MAX_ATTEMPTS_IP = Number(process.env.LOGIN_MAX_ATTEMPTS_IP || 25);
export const LOGIN_MAX_ATTEMPTS_USER = Number(process.env.LOGIN_MAX_ATTEMPTS_USER || 10);
export const LOGIN_FAILURE_DELAY_MS = Number(process.env.LOGIN_FAILURE_DELAY_MS || 350);
export const PUBLIC_MAX_RECORDS = Number(process.env.PUBLIC_MAX_RECORDS || (IS_PRODUCTION ? 300 : 2000));
export const PUBLIC_SCAN_LIMIT = Number(process.env.PUBLIC_SCAN_LIMIT || (IS_PRODUCTION ? 5000 : 50000));
export const DOCUMENT_SYNC_INTERVAL_MS = Number(process.env.DOCUMENT_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000);
export const DOCUMENT_SYNC_ENABLED = process.env.DOCUMENT_SYNC_ENABLED
  ? /^(1|true|yes)$/i.test(process.env.DOCUMENT_SYNC_ENABLED)
  : !IS_PRODUCTION;
export const DOCUMENT_SYNC_ON_START = process.env.DOCUMENT_SYNC_ON_START
  ? /^(1|true|yes)$/i.test(process.env.DOCUMENT_SYNC_ON_START)
  : !IS_PRODUCTION;
export const DOCUMENT_SYNC_ONCE = /^(1|true|yes)$/i.test(process.env.DOCUMENT_SYNC_ONCE || '');
export const DOCUMENT_SYNC_MAX_RECORDS = Number(process.env.DOCUMENT_SYNC_MAX_RECORDS || 0); // 0 = use scan limit
export const CATALOGUE_LOOKUP_ON_START = process.env.CATALOGUE_LOOKUP_ON_START
  ? /^(1|true|yes)$/i.test(process.env.CATALOGUE_LOOKUP_ON_START)
  : true;
export const CATALOGUE_LOOKUP_ENABLED = process.env.CATALOGUE_LOOKUP_ENABLED
  ? /^(1|true|yes)$/i.test(process.env.CATALOGUE_LOOKUP_ENABLED)
  : true;
export const CATALOGUE_LOOKUP_PAGE_SIZE = Number(process.env.CATALOGUE_LOOKUP_PAGE_SIZE || 200);
export const CATALOGUE_LOOKUP_BATCH_SIZE = Number(process.env.CATALOGUE_LOOKUP_BATCH_SIZE || 1);
export const YAZ_CLIENT_TIMEOUT_MS = Number(process.env.YAZ_CLIENT_TIMEOUT_MS || 15_000);
export const YAZ_CLIENT_BATCH_BASE_TIMEOUT_MS = Number(process.env.YAZ_CLIENT_BATCH_BASE_TIMEOUT_MS || 30_000);
export const YAZ_CLIENT_BATCH_ITEM_TIMEOUT_MS = Number(process.env.YAZ_CLIENT_BATCH_ITEM_TIMEOUT_MS || 2_000);
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

export function validateRuntimeSecrets() {
  validateCommittedSecretHygiene();
  if (!IS_PRODUCTION) return;

  const errors = [];
  if (!API_KEY_ENCRYPTION_KEY) {
    errors.push('API_KEY_ENCRYPTION_KEY is required in production.');
  }
  if (!MFA_SECRET_ENCRYPTION_KEY) {
    errors.push('MFA_SECRET_ENCRYPTION_KEY is required in production.');
  }
  if (
    API_KEY_ENCRYPTION_KEY
    && MFA_SECRET_ENCRYPTION_KEY
    && API_KEY_ENCRYPTION_KEY === MFA_SECRET_ENCRYPTION_KEY
  ) {
    errors.push('API_KEY_ENCRYPTION_KEY and MFA_SECRET_ENCRYPTION_KEY must be different values.');
  }
  if (
    TURSO_DATABASE_URL
    && !TURSO_DATABASE_URL.startsWith('file:')
    && !TURSO_AUTH_TOKEN
  ) {
    errors.push('TURSO_AUTH_TOKEN is required in production when TURSO_DATABASE_URL points to Turso/libSQL.');
  }

  if (errors.length) {
    throw new Error(`Invalid production secret configuration: ${errors.join(' ')}`);
  }
}

function validateCommittedSecretHygiene() {
  const checkedFiles = [
    '.env.production',
    '.env.production.local',
    'fly.toml',
    'Dockerfile',
    'docker-compose.yml',
  ];
  const secretPattern = /(sk-ant-api\d{2}-[\w-]{20,}|sk-[A-Za-z0-9_-]{20,}|ANTHROPIC_API_KEY\s*=\s*["']?[^"'\s#]+)/;
  const offenders = [];

  for (const file of checkedFiles) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) continue;
    const body = fs.readFileSync(filePath, 'utf8');
    if (secretPattern.test(body)) offenders.push(file);
  }

  if (!offenders.length) return;
  const message = `Secret-looking values found in production/deployment files: ${offenders.join(', ')}. Move them to the deployment secret manager.`;
  if (IS_PRODUCTION) throw new Error(message);
  console.warn(message);
}

export const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'among', 'also', 'been', 'before', 'being', 'between',
  'both', 'can', 'could', 'did', 'does', 'doing', 'during', 'each', 'from', 'have', 'having',
  'here', 'into', 'itself', 'just', 'more', 'most', 'much', 'must', 'only', 'other', 'over',
  'same', 'should', 'some', 'such', 'than', 'that', 'their', 'theirs', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'under', 'until', 'very', 'were', 'what', 'when',
  'where', 'which', 'while', 'with', 'within', 'without', 'would', 'your', 'yours', 'study',
  'research', 'thesis', 'dissertation', 'ubc', 'university', 'doctoral', 'doctor', 'education'
]);

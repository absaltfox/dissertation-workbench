import path from 'node:path';

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

export const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'among', 'also', 'been', 'before', 'being', 'between',
  'both', 'can', 'could', 'did', 'does', 'doing', 'during', 'each', 'from', 'have', 'having',
  'here', 'into', 'itself', 'just', 'more', 'most', 'much', 'must', 'only', 'other', 'over',
  'same', 'should', 'some', 'such', 'than', 'that', 'their', 'theirs', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'under', 'until', 'very', 'were', 'what', 'when',
  'where', 'which', 'while', 'with', 'within', 'without', 'would', 'your', 'yours', 'study',
  'research', 'thesis', 'dissertation', 'ubc', 'university', 'doctoral', 'doctor', 'education'
]);

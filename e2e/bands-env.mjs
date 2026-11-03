// Shared env for the bands e2e: same isolation as start-server.mjs, but pointed
// at a caller-supplied data directory so the DB survives between the prepare,
// Python and serve phases. Import-free of src/ (it only builds a settings object).
import path from 'node:path';
import { isolatedServerEnv } from './server-env.mjs';

export const ADMIN_PASSWORD = 'e2e-admin-pass-1';

export function bandsServerEnv(dataDir, port) {
  return isolatedServerEnv(process.env, {
    SKIP_LOCAL_ENV: '1',
    NODE_ENV: 'development',
    APP_DATA_DIR: dataDir,
    SQLITE_PATH: path.join(dataDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(dataDir, 'pdf-cache'),
    FULL_TEXT_CACHE_DIR: path.join(dataDir, 'full-text-cache'),
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: '',
    UBC_API_KEY: '',
    UBC_API_BASE_URL: 'http://127.0.0.1:9',
    GROBID_URL: 'http://127.0.0.1:9',
    CATALOGUE_LOOKUP_ENABLED: '0',
    CATALOGUE_LOOKUP_ON_START: '0',
    DOCUMENT_SYNC_ENABLED: '0',
    DOCUMENT_SYNC_ON_START: '0',
    CITATION_SCAN_NIGHTLY_ENABLED: '0',
    CONCEPT_REBUILD_NIGHTLY_ENABLED: '0',
    TRUST_PROXY: '1',
    PORT: String(port),
  });
}

// Nine topics in three obvious meaning clusters (topic t belongs to cluster t % 3).
export const BAND_TOPICS = [
  { id: 0, label: 'Mathematics Teaching', terms: ['mathematics', 'numeracy', 'algebra'] },
  { id: 1, label: 'Literacy Practices', terms: ['literacy', 'reading', 'writing'] },
  { id: 2, label: 'Indigenous Pedagogy', terms: ['indigenous', 'land', 'knowledge'] },
  { id: 3, label: 'Math Anxiety', terms: ['anxiety', 'mathematics', 'students'] },
  { id: 4, label: 'Digital Literacies', terms: ['digital', 'literacy', 'media'] },
  { id: 5, label: 'Reconciliation in Schools', terms: ['reconciliation', 'indigenous', 'schools'] },
  { id: 6, label: 'Geometry Instruction', terms: ['geometry', 'proof', 'spatial'] },
  { id: 7, label: 'Second Language Writing', terms: ['language', 'writing', 'second'] },
  { id: 8, label: 'Land-Based Learning', terms: ['land', 'place', 'community'] },
];

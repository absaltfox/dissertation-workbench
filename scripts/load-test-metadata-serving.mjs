import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const requestedSizes = String(process.env.METADATA_SCALE_SIZES || '1000,5000,10000,56000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)
  .sort((a, b) => a - b);
if (!requestedSizes.length) throw new Error('METADATA_SCALE_SIZES must contain at least one positive integer.');

const latencyTargetsMs = {
  summary: Number(process.env.METADATA_SCALE_SUMMARY_TARGET_MS || 1500),
  documentPage: Number(process.env.METADATA_SCALE_PAGE_TARGET_MS || 1500),
  analytics: Number(process.env.METADATA_SCALE_ANALYTICS_TARGET_MS || 3000),
  peoplePage: Number(process.env.METADATA_SCALE_PEOPLE_TARGET_MS || 1500),
  topicPage: Number(process.env.METADATA_SCALE_TOPIC_PAGE_TARGET_MS || 3000),
};
const maxHeapGrowthBytes = Number(process.env.METADATA_SCALE_MAX_HEAP_MB || 64) * 1024 * 1024;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-metadata-serving-load-'));

process.env.SKIP_LOCAL_ENV = '1';
process.env.NODE_ENV = 'test';
process.env.APP_DATA_DIR = tempDir;
process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');

const db = await import('../src/db.js');
await db.ensureStorage();
const client = await db.getDb();
await client.execute({
  sql: `INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at)
        VALUES (1, 'Scale topic', '["scale"]', 0, 'load-test', ?)`,
  args: [new Date().toISOString()],
});

function docFor(index) {
  const phd = index % 2 === 0;
  return {
    id: `load-${String(index).padStart(6, '0')}`,
    title: `Metadata scale dissertation ${String(index).padStart(6, '0')}`,
    author: `Author ${index}`,
    year: 1960 + (index % 65),
    degree: phd ? 'PhD' : 'EdD',
    program: `Program ${index % 20}`,
    affiliation: [phd ? 'UBC' : 'SFU'],
    supervisors: [`Supervisor ${index % 500}`],
    abstract: `Bounded metadata serving fixture ${index}`,
    subjects: ['education'],
    themes: [`theme-${index % 40}`],
    conceptTerms: [`concept-${index % 80}`],
    methodologies: [`method-${index % 10}`],
    charCount: 100 + (index % 2000),
  };
}

async function time(name, operation) {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  await operation();
  const elapsedMs = performance.now() - startedAt;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    name,
    elapsedMs,
    heapGrowthBytes: Math.max(0, heapAfter - heapBefore),
  };
}

let seeded = 0;
const results = [];
try {
  for (const size of requestedSizes) {
    for (let start = seeded; start < size; start += 250) {
      const count = Math.min(250, size - start);
      await db.saveDocumentMetadataBatch(Array.from({ length: count }, (_, offset) => ({
        doc: docFor(start + offset),
        syncKey: 'metadata-serving-load',
      })));
      await client.batch(Array.from({ length: count }, (_, offset) => ({
        sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, 1, 0.9)',
        args: [`load-${String(start + offset).padStart(6, '0')}`],
      })), 'write');
    }
    seeded = size;
    await client.execute({
      sql: 'UPDATE topics SET doc_count = ? WHERE topic_id = 1',
      args: [size],
    });

    const measurements = [
      await time('summary', () => db.getDocumentServingSummary({ syncKey: 'metadata-serving-load' })),
      await time('documentPage', () => db.queryCachedDocumentPage({
        syncKey: 'metadata-serving-load',
        filters: { degree: 'PhD', affiliation: 'UBC' },
        q: 'metadata scale',
        sortKey: 'year',
        sortDir: 'desc',
        limit: 50,
      })),
      await time('analytics', () => db.getDocumentServingAnalytics({
        syncKey: 'metadata-serving-load',
        filters: { program: 'Program 3' },
        subjectLimit: 25,
      })),
      await time('peoplePage', () => db.queryPeoplePage({
        syncKey: 'metadata-serving-load',
        limit: 50,
      })),
      await time('topicPage', () => db.queryTopicDocumentPage({
        syncKey: 'metadata-serving-load',
        limit: 5000,
      })),
    ];

    const failures = measurements.filter((measurement) => (
      measurement.elapsedMs > latencyTargetsMs[measurement.name]
      || measurement.heapGrowthBytes > maxHeapGrowthBytes
    ));
    results.push({
      records: size,
      measurements: measurements.map(({ name, elapsedMs, heapGrowthBytes }) => ({
        name,
        elapsedMs: Math.round(elapsedMs * 10) / 10,
        heapGrowthMb: Math.round((heapGrowthBytes / 1024 / 1024) * 10) / 10,
        latencyTargetMs: latencyTargetsMs[name],
      })),
      passed: failures.length === 0,
    });
  }

  process.stdout.write(`${JSON.stringify({ latencyTargetsMs, maxHeapGrowthBytes, results }, null, 2)}\n`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
} finally {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
}

// Phase B (#10) reliability tests for #18 (per-document error boundary +
// transient-DB retry) and #23 (limiter backoff + non-throwing exhaustion).
//
// Three groups:
//   1. Pure-function unit tests for classifyDbError/withDbRetry/
//      reserveImportRuleRequestSlot's backoff-and-return-waitMs behaviour.
//   2. Gate harness 1 — induced DB disconnect mid-page (#18): asserts the run
//      does not fail, other documents complete, and the targeted document is
//      durably recorded, on both the queue-drain and OC-scan call sites.
//   3. Gate harness 2 — limiter contention spike (#23): contentConcurrency: 8
//      against a low, fast-window content rate limit, asserting zero
//      documents fail purely from limiter contention and that backoff reduces
//      CAS round trips relative to lockstep retries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let db;
let runDocumentSync;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-sync-reliability-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
  process.env.NODE_ENV = 'test';
  db = await import('../src/db.js');
  ({ runDocumentSync } = await import('../src/sync.js'));
  await db.ensureStorage();
});

test.after(async () => {
  await db.closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

// --- classifyDbError -------------------------------------------------------

test('classifyDbError buckets libsql/network errors as transient', () => {
  const cases = [
    { code: 'HRANA_WEBSOCKET_ERROR' },
    { code: 'HRANA_CLOSED_ERROR' },
    { code: 'HRANA_PROTO_ERROR' },
    { code: 'SERVER_ERROR' },
    { code: 'INTERNAL_ERROR' },
    { code: 'UNKNOWN' },
    { code: 'SQLITE_BUSY' },
    { code: 'SQLITE_BUSY_SNAPSHOT' },
    { code: 'SQLITE_LOCKED' },
  ];
  for (const shape of cases) {
    const error = Object.assign(new Error('boom'), shape);
    assert.equal(db.classifyDbError(error), 'transient', `expected transient for code=${shape.code}`);
  }
  // No code at all, but a message shape a dropped connection would carry.
  for (const message of [
    'read ECONNRESET', 'connect ETIMEDOUT', 'write EPIPE', 'fetch failed', 'socket hang up', 'Network error',
  ]) {
    assert.equal(db.classifyDbError(new Error(message)), 'transient', `expected transient for message="${message}"`);
  }
  // Message-only classification also checks `.cause`.
  assert.equal(
    db.classifyDbError(new Error('wrapped', { cause: new Error('socket hang up') })),
    'transient'
  );
});

test('classifyDbError buckets schema/syntax/data errors as permanent, and defaults unknown shapes to permanent', () => {
  const cases = [
    { code: 'PROTOCOL_VERSION_ERROR' },
    { code: 'TRANSACTION_CLOSED' },
    { code: 'SQLITE_CONSTRAINT' },
    { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' },
    { code: 'SQLITE_MISUSE' },
    { code: 'SQLITE_ERROR' },
  ];
  for (const shape of cases) {
    const error = Object.assign(new Error('boom'), shape);
    assert.equal(db.classifyDbError(error), 'permanent', `expected permanent for code=${shape.code}`);
  }
  assert.equal(db.classifyDbError(Object.assign(new Error('boom'), { name: 'MisuseError' })), 'permanent');
  // Unrecognized code, or no code and no recognizable message: default permanent
  // (retrying an error we can't positively identify as transient risks masking
  // a real bug as routine flakiness).
  assert.equal(db.classifyDbError(Object.assign(new Error('boom'), { code: 'SOME_NEW_CODE' })), 'permanent');
  assert.equal(db.classifyDbError(new Error('a completely unrelated failure')), 'permanent');
  assert.equal(db.classifyDbError(null), 'permanent');
  assert.equal(db.classifyDbError(undefined), 'permanent');
});

// --- withDbRetry -------------------------------------------------------

test('withDbRetry retries a transient error until it succeeds, backing off with non-zero, non-constant, bounded delays', async () => {
  let calls = 0;
  const delays = [];
  const wait = async (ms) => { delays.push(ms); };
  const result = await db.withDbRetry(async () => {
    calls += 1;
    if (calls < 4) {
      const error = new Error('server closed the connection');
      error.code = 'HRANA_CLOSED_ERROR';
      throw error;
    }
    return 'ok';
  }, { label: 'test-op', maxAttempts: 5, wait });
  assert.equal(result, 'ok');
  assert.equal(calls, 4, 'expected exactly 3 failures then a success (4 calls total)');
  assert.equal(delays.length, 3, 'expected a backoff wait before each retry, not before the first attempt');
  assert.ok(delays.every((ms) => ms > 0), `all delays should be non-zero: ${delays.join(', ')}`);
  assert.ok(new Set(delays).size > 1, `delays should not all be identical (jittered exponential): ${delays.join(', ')}`);
  assert.ok(delays.every((ms) => ms <= 5_000), `delays should be bounded: ${delays.join(', ')}`);
});

test('withDbRetry does not retry a permanent error', async () => {
  let calls = 0;
  const wait = async () => { throw new Error('wait should never be called for a permanent error'); };
  await assert.rejects(
    db.withDbRetry(async () => {
      calls += 1;
      const error = new Error('bad SQL');
      error.code = 'SQLITE_CONSTRAINT';
      throw error;
    }, { label: 'test-op', maxAttempts: 5, wait }),
    /bad SQL/
  );
  assert.equal(calls, 1, 'a permanent error must fail fast, not retry');
});

test('withDbRetry re-throws the original, unwrapped error once retries are exhausted', async () => {
  let calls = 0;
  const wait = async () => {};
  await assert.rejects(
    (async () => {
      try {
        await db.withDbRetry(async () => {
          calls += 1;
          const error = new Error('still down');
          error.code = 'HRANA_CLOSED_ERROR';
          throw error;
        }, { label: 'test-op', maxAttempts: 3, wait });
      } catch (error) {
        assert.equal(error.code, 'HRANA_CLOSED_ERROR', 'the caller must still see the original error shape');
        throw error;
      }
    })(),
    /still down/
  );
  assert.equal(calls, 3);
});

// --- #18 cosmetic fix: docCounts.processed reflects completion order ---

test('pdf_document completion progress counts are non-decreasing even when a later-dispatched document finishes first', async () => {
  const originalFetch = globalThis.fetch;
  const suffix = Date.now();
  const slowDocId = `1.${suffix}0`; // dispatched first (index 0), finishes LAST
  const fastDocId = `1.${suffix}1`; // dispatched second (index 1), finishes FIRST
  const fullText = `Monotonic progress fixture\n${'education research '.repeat(50)}`;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/search/8.5')) {
      return new Response(JSON.stringify({
        data: {
          hits: {
            total: 2,
            hits: [
              {
                _source: {
                  id: slowDocId, title: 'Slow Doc', author: 'Tester',
                  digitalResourceOriginalRecord: `https://circle.library.ubc.ca/rest/handle/2429/slow-${suffix}`,
                },
              },
              {
                _source: {
                  id: fastDocId, title: 'Fast Doc', author: 'Tester',
                  digitalResourceOriginalRecord: `https://circle.library.ubc.ca/rest/handle/2429/fast-${suffix}`,
                },
              },
            ],
          },
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes(`/rest/handle/2429/slow-${suffix}`)) {
      // Artificial delay so the earlier-dispatched (index 0) document is the
      // last to actually complete.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(JSON.stringify({
        bitstreams: [{ id: 501, bundleName: 'TEXT', mimeType: 'text/plain', name: 'slow.pdf.txt' }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes(`/rest/handle/2429/fast-${suffix}`)) {
      return new Response(JSON.stringify({
        bitstreams: [{ id: 502, bundleName: 'TEXT', mimeType: 'text/plain', name: 'fast.pdf.txt' }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/bitstreams/501/retrieve') || url.includes('/rest/bitstreams/502/retrieve')) {
      return new Response(fullText, { headers: { 'content-type': 'text/plain' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const events = [];
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,Monotonic-${suffix}`,
      source: 'id,title,author,digitalResourceOriginalRecord',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: 2,
      contentMode: 'full_text_only',
      contentConcurrency: 2,
      downloadFiles: false,
      onProgress: async (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(result.totalEnrichmentAttempted, 2);

    const finishedEvents = events.filter((event) => (
      event.phase === 'pdf_document' && (event.status === 'completed' || event.status === 'failed')
    ));
    assert.equal(finishedEvents.length, 2);
    // The fast document (dispatched second, index 1) must finish first in real
    // time, proving this fixture actually exercises out-of-order completion.
    assert.equal(finishedEvents[0].detail?.includes(fastDocId), true,
      `expected the fast document to complete first; finish order: ${finishedEvents.map((e) => e.detail).join(', ')}`);
    const processedCounts = finishedEvents.map((event) => event.counts.processed);
    for (let i = 1; i < processedCounts.length; i += 1) {
      assert.ok(
        processedCounts[i] >= processedCounts[i - 1],
        `processed counts must be non-decreasing in completion order, got ${processedCounts.join(', ')}`
      );
    }
    assert.deepEqual(processedCounts, [1, 2],
      `expected completion-order counter [1, 2], got ${processedCounts.join(', ')} (index-derived counting would show [2, 1])`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- reserveImportRuleRequestSlot: backoff and non-throwing exhaustion (#23) ---

test('reserveImportRuleRequestSlot never throws under concurrent contention, and returns waitMs for the rest', async () => {
  const rule = await db.saveImportRule({ id: `slot-contention-${Date.now()}`, name: 'Contention fixture' });
  const reservations = await Promise.all(
    Array.from({ length: 8 }, () => db.reserveImportRuleRequestSlot(rule.id, 2, { nowMs: 10_000, windowMs: 60_000 }))
  );
  const acquired = reservations.filter((value) => value === 0);
  const waited = reservations.filter((value) => value > 0);
  assert.equal(acquired.length, 2, `expected exactly limit(2) callers to acquire a slot, got ${acquired.length}`);
  assert.equal(waited.length, 6, `expected the other 6 callers to receive a positive waitMs, got ${waited.length}`);
  for (const waitMs of waited) assert.ok(Number.isFinite(waitMs) && waitMs > 0);
});

test('reserveImportRuleRequestSlot backs off between CAS attempts, reducing round trips under lockstep contention', async () => {
  const rule = await db.saveImportRule({ id: `slot-backoff-${Date.now()}`, name: 'Backoff fixture' });
  const client = await db.getDb();

  async function countStatementsFor(waitFn, backoffFn) {
    const originalExecute = client.execute.bind(client);
    let statements = 0;
    client.execute = async (...args) => {
      statements += 1;
      return originalExecute(...args);
    };
    try {
      await Promise.all(Array.from({ length: 8 }, () => db.reserveImportRuleRequestSlot(rule.id, 2, {
        nowMs: 20_000, windowMs: 60_000, wait: waitFn, backoff: backoffFn,
      })));
    } finally {
      client.execute = originalExecute;
    }
    return statements;
  }

  // Pre-#23 shape: the loop retried in a tight cycle with no delay at all
  // between CAS attempts. A microtask-only no-op `wait` (no setTimeout, so no
  // new macrotask boundary is introduced beyond what the DB call itself
  // already yields) reproduces that lockstep timing without adding real
  // wall-clock delay of its own — every losing caller retries at essentially
  // the same tick, so most of the 8 contenders keep reading the identical
  // stale snapshot and racing on the same write, round after round.
  const noBackoffStatements = await countStatementsFor(async () => {}, () => 0);

  // Reset the rule's limiter row between measurements so both runs start from
  // the same contention shape.
  await client.execute({ sql: 'DELETE FROM import_rule_request_limits WHERE rule_id = ?', args: [rule.id] });

  // Real jittered backoff, scaled down to single-digit milliseconds to keep
  // the test fast: real setTimeout delays that differ per caller spread the
  // retries out in actual wall-clock time, so a caller is more likely to see
  // the *previous* winner's already-updated row and succeed on its very next
  // attempt instead of colliding with the rest of the herd again.
  const backoffStatements = await countStatementsFor(
    (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    (attempt) => db.computeBackoffDelayMs(attempt, { baseMs: 2, factor: 1.6, jitterRatio: 0.4, capMs: 20 })
  );

  assert.ok(
    backoffStatements < noBackoffStatements,
    `expected jittered backoff to reduce total CAS round trips: `
      + `no-backoff=${noBackoffStatements}, with-backoff=${backoffStatements}`
  );
});

test('reserveImportRuleRequestSlot throws a tagged, non-retryable error only when the persisted state never once parses', async () => {
  const rule = await db.saveImportRule({ id: `slot-corrupt-${Date.now()}`, name: 'Corrupt state fixture' });
  const client = await db.getDb();
  await client.execute({
    sql: `INSERT INTO import_rule_request_limits (rule_id, timestamps_json, updated_at) VALUES (?, ?, ?)`,
    args: [rule.id, 'not-json-at-all', new Date().toISOString()],
  });
  // Every read returns the same unparseable JSON, and the CAS's own attempt to
  // replace it always loses (a competing writer keeps winning) — the corrupt
  // state genuinely never resolves within the attempt budget.
  const originalExecute = client.execute.bind(client);
  client.execute = async (statement, ...rest) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (/UPDATE import_rule_request_limits/.test(sql)) {
      return { rows: [], rowsAffected: 0, columns: [], columnTypes: [] };
    }
    return originalExecute(statement, ...rest);
  };
  try {
    await assert.rejects(
      db.reserveImportRuleRequestSlot(rule.id, 2, {
        nowMs: 30_000, windowMs: 60_000, wait: async () => {}, maxAttempts: 5,
      }),
      (error) => {
        assert.equal(error.code, 'RATE_LIMIT_STATE_CORRUPT');
        return true;
      }
    );
  } finally {
    client.execute = originalExecute;
  }
});

// Regression test for Finding 1 (review of #18/#23): reserveImportRuleRequestSlot
// was listed as one of the seven Layer-A withDbRetry-wrapped functions, and its
// own internal 20-attempt CAS loop and jittered backoff make it *look*
// retry-hardened, but the function itself was never actually passed through
// withDbRetry. A transient error out of its SELECT or CAS UPDATE (a dropped
// connection mid-round-trip — not ordinary CAS contention, which never throws)
// threw immediately with zero retries. These two tests fail against the
// unwrapped function (the SELECT/UPDATE error propagates straight out, so the
// call rejects instead of returning 0) and pass once the whole function is
// wrapped in withDbRetry.
test('reserveImportRuleRequestSlot retries a transient error on the initial SELECT and still acquires the slot', async () => {
  const rule = await db.saveImportRule({ id: `slot-transient-select-${Date.now()}`, name: 'Transient SELECT fixture' });
  const client = await db.getDb();
  const originalExecute = client.execute.bind(client);
  let failuresRemaining = 1;
  let selectAttempts = 0;
  client.execute = async (statement, ...rest) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (/SELECT timestamps_json FROM import_rule_request_limits/.test(sql)) {
      selectAttempts += 1;
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        const error = new Error('server closed the connection');
        error.code = 'HRANA_CLOSED_ERROR'; // transient shape
        throw error;
      }
    }
    return originalExecute(statement, ...rest);
  };
  try {
    const result = await db.reserveImportRuleRequestSlot(rule.id, 5, { nowMs: 40_000, windowMs: 60_000 });
    assert.equal(result, 0, 'expected the slot to be acquired once the retry absorbs the transient SELECT error');
    assert.ok(selectAttempts >= 2, `expected the SELECT to be retried at least once, saw ${selectAttempts} attempt(s)`);
  } finally {
    client.execute = originalExecute;
  }
});

test('reserveImportRuleRequestSlot retries a transient error on the CAS UPDATE and still acquires the slot', async () => {
  const rule = await db.saveImportRule({ id: `slot-transient-update-${Date.now()}`, name: 'Transient UPDATE fixture' });
  // Seed an existing row so the CAS path is the UPDATE branch, not INSERT OR IGNORE.
  await db.reserveImportRuleRequestSlot(rule.id, 5, { nowMs: 1_000, windowMs: 60_000 });
  const client = await db.getDb();
  const originalExecute = client.execute.bind(client);
  let failuresRemaining = 1;
  let updateAttempts = 0;
  client.execute = async (statement, ...rest) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (/UPDATE import_rule_request_limits/.test(sql)) {
      updateAttempts += 1;
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        const error = new Error('server closed the connection');
        error.code = 'HRANA_CLOSED_ERROR'; // transient shape
        throw error;
      }
    }
    return originalExecute(statement, ...rest);
  };
  try {
    const result = await db.reserveImportRuleRequestSlot(rule.id, 5, { nowMs: 41_000, windowMs: 60_000 });
    assert.equal(result, 0, 'expected the slot to be acquired once the retry absorbs the transient UPDATE error');
    assert.ok(updateAttempts >= 2, `expected the UPDATE to be retried at least once, saw ${updateAttempts} attempt(s)`);
  } finally {
    client.execute = originalExecute;
  }
});

// --- Gate harness 1 (#18): induced DB disconnect mid-page ------------------
//
// Simulates a transient libsql error partway through a concurrent page by
// wrapping client.batch (saveDocumentMetadata's write path) to throw for one
// targeted document. Asserts: other in-flight documents complete, the failed
// document is durably recorded, and the job does not fail — on both of Phase
// A's call sites (the OC-scan loop and the local-queue-drain loop).

function fullTextFetchMock(docs) {
  const fullText = `Gate harness full text\n${'education research '.repeat(300)}`;
  return async (input) => {
    const url = String(input);
    if (url.includes('/search/8.5')) {
      return new Response(JSON.stringify({
        data: { hits: { total: docs.length, hits: docs.map((doc) => ({ _source: doc })) } },
      }), { headers: { 'content-type': 'application/json' } });
    }
    for (const doc of docs) {
      if (url.includes(doc.handleSlug)) {
        return new Response(JSON.stringify({
          bitstreams: [{ id: doc.bitstreamId, bundleName: 'TEXT', mimeType: 'text/plain', name: `${doc.id}.txt` }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes(`/rest/bitstreams/${doc.bitstreamId}/retrieve`)) {
        return new Response(fullText, { headers: { 'content-type': 'text/plain' } });
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

function buildGateDocs(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `1.${prefix}${String(index).padStart(2, '0')}`,
    title: `Gate Doc ${prefix}-${index}`,
    author: 'Gate Tester',
    handleSlug: `/rest/handle/2429/gate-${prefix}-${index}`,
    digitalResourceOriginalRecord: `https://circle.library.ubc.ca/rest/handle/2429/gate-${prefix}-${index}`,
    bitstreamId: 9_000 + index,
  }));
}

// Patches client.batch to throw for the Nth `INSERT INTO documents` batch
// call whose leading statement's args target `targetDocId` (saveDocumentMetadata
// is called twice per document — once before analysis, once after — so `atCall`
// distinguishes them). `failureBudget: Infinity` reproduces a sustained outage
// (every attempt fails, exhausting Layer A's retries); a small finite budget
// reproduces a single transient blip that a retry absorbs.
function induceDbDisconnect(client, { targetDocId, atCall = 2, failureBudget = Infinity }) {
  const originalBatch = client.batch.bind(client);
  let seenForTarget = 0;
  let remaining = failureBudget;
  // Once the Nth logical saveDocumentMetadata call for targetDocId is seen,
  // `latched` stays true for every physical retry of that SAME logical call
  // (withDbRetry re-invokes client.batch on each attempt) — without this, a
  // naive "seenForTarget === atCall" check would only match once, and the
  // very first internal retry (a fresh physical call) would slip through as
  // if it were a later, unrelated call, making a "sustained" failure
  // (failureBudget: Infinity) accidentally resolve after one retry.
  let latched = false;
  client.batch = async (statements, mode) => {
    const first = statements[0];
    const sql = typeof first === 'string' ? first : first.sql;
    const args = typeof first === 'string' ? [] : (first.args || []);
    const isTargetInsert = /INSERT INTO documents/.test(sql) && args[0] === targetDocId;
    if (isTargetInsert && !latched) {
      seenForTarget += 1;
      if (seenForTarget === atCall) latched = true;
    }
    if (isTargetInsert && latched && remaining > 0) {
      remaining -= 1;
      const error = new Error('server closed the connection');
      error.code = 'HRANA_CLOSED_ERROR'; // transient shape
      throw error;
    }
    return originalBatch(statements, mode);
  };
  return () => { client.batch = originalBatch; };
}

test('gate 1a (OC-scan path): a sustained DB disconnect on one document is recorded as failed, and the run still completes', async () => {
  const originalFetch = globalThis.fetch;
  const suffix = `10${Date.now()}`;
  const docs = buildGateDocs(suffix, 6);
  const targetDocId = docs[3].id;
  globalThis.fetch = fullTextFetchMock(docs);
  const client = await db.getDb();
  const restore = induceDbDisconnect(client, { targetDocId, atCall: 1, failureBudget: Infinity });
  try {
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,Gate-${suffix}`,
      source: 'id,title,author,digitalResourceOriginalRecord',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: docs.length,
      contentMode: 'full_text_only',
      contentConcurrency: 4,
      downloadFiles: false,
    });

    assert.equal(result.ok, true, 'the run must not fail because one document hit a DB disconnect');
    assert.equal(result.totalEnrichmentAttempted, docs.length - 1,
      'the targeted document never gets past its first metadata save, so it is not counted as attempted');

    const targetOutcome = result.enrichmentOutcomes.find((item) => item.docId === targetDocId);
    assert.ok(targetOutcome, 'the targeted document must still produce an outcome entry');
    assert.ok(targetOutcome.error, 'the targeted document outcome must carry the DB error');
    assert.equal(targetOutcome.recorded, true, 'the failure must be durably recorded');
    assert.equal(targetOutcome.outcomeKind, 'document_error');

    const others = result.enrichmentOutcomes.filter((item) => item.docId !== targetDocId);
    assert.equal(others.length, docs.length - 1);
    for (const outcome of others) {
      assert.equal(outcome.error, null, `expected ${outcome.docId} to succeed normally, got error: ${outcome.error}`);
      assert.ok(outcome.wordCount > 0, `expected ${outcome.docId} to have real extracted content`);
    }

    const storedTarget = await db.loadStoredFileMetric(targetDocId);
    assert.ok(storedTarget, 'the targeted document must have a durable file_metrics row');
    assert.ok(storedTarget.error, 'the durable row must carry a non-null error');

    const latestRun = await db.getLatestSyncRun(result.syncKey);
    assert.notEqual(latestRun.status, 'failed', 'the sync_runs row must not be marked failed');
  } finally {
    restore();
    globalThis.fetch = originalFetch;
  }
});

test('gate 1b (OC-scan path): a single transient DB blip is absorbed by retry — the document still succeeds', async () => {
  const originalFetch = globalThis.fetch;
  const suffix = `11${Date.now()}`;
  const docs = buildGateDocs(suffix, 4);
  const targetDocId = docs[1].id;
  globalThis.fetch = fullTextFetchMock(docs);
  const client = await db.getDb();
  // Only the first hit fails; withDbRetry's own retry (default up to 4
  // attempts) should absorb it transparently. atCall: 3 targets sync.js's own
  // POST-analysis saveDocumentMetadata call specifically (the historically
  // unguarded call site at the old sync.js:305) — analyzeDocumentFile's
  // internal extractAndSaveParsedData issues its own (2nd, chronologically)
  // saveDocumentMetadata call with its own pre-existing try/catch, so
  // targeting call #2 would exercise pdf.js's already-existing protection
  // rather than the #18 fix under test here.
  const restore = induceDbDisconnect(client, { targetDocId, atCall: 3, failureBudget: 1 });
  try {
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,Gate-${suffix}`,
      source: 'id,title,author,digitalResourceOriginalRecord',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: docs.length,
      contentMode: 'full_text_only',
      contentConcurrency: 4,
      downloadFiles: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.totalEnrichmentFailed, 0, 'the retry should have absorbed the single blip with no recorded failure');
    const targetOutcome = result.enrichmentOutcomes.find((item) => item.docId === targetDocId);
    assert.ok(targetOutcome, 'the targeted document must still produce an outcome entry');
    assert.equal(targetOutcome.error, null, 'the targeted document must succeed once the retry absorbs the blip');
    assert.ok(targetOutcome.wordCount > 0);
  } finally {
    restore();
    globalThis.fetch = originalFetch;
  }
});

test('gate 1c (local-queue-drain path): the same DB-disconnect resilience holds when enrichment is fed by the local queue, not a live OC scan', async () => {
  const originalFetch = globalThis.fetch;
  const suffix = `12${Date.now()}`;
  const docs = buildGateDocs(suffix, 6);
  const targetDocId = docs[4].id;
  globalThis.fetch = fullTextFetchMock(docs);

  try {
    // Seed the documents table via a plain metadata sync (mode: import_all) —
    // this writes through saveDocumentMetadataBatch, not the per-document
    // saveDocumentMetadata our interception targets, so seeding itself is
    // unaffected. It also leaves nothing enriched, so the very next
    // sync_missing_pdfs run finds everything through drainLocalEnrichmentQueue
    // (runSync's dispatch: enrichmentRequested && the local queue is non-empty)
    // without ever calling fetchPage/resolveIndexName again.
    const seeded = await runDocumentSync({
      mode: 'import_all',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,Gate-${suffix}`,
      source: 'id,title,author,digitalResourceOriginalRecord',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      downloadFiles: false,
    });
    assert.equal(seeded.ok, true);
    assert.equal(seeded.totalSaved, docs.length);

    // Once seeded, fetchPage must never be called again for this run — only
    // bitstream/full-text fetches. Fail loudly if the queue-drain path
    // unexpectedly falls through to a live OC scan.
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/search/8.5')) throw new Error('unexpected OC scan: the local queue should have fed this run');
      return fullTextFetchMock(docs)(input);
    };

    const client = await db.getDb();
    const restore = induceDbDisconnect(client, { targetDocId, atCall: 2, failureBudget: Infinity });
    try {
      const result = await runDocumentSync({
        mode: 'sync_missing_pdfs',
        baseUrl: 'https://oc-index.test',
        term: `degree.raw,Gate-${suffix}`,
        source: 'id,title,author,digitalResourceOriginalRecord',
        pageSize: 100,
        scanLimit: 100,
        syncMaxRecords: 100,
        pdfBatchSize: docs.length,
        contentMode: 'full_text_only',
        contentConcurrency: 4,
        downloadFiles: false,
      });

      assert.equal(result.ok, true, 'the run must not fail because one document hit a DB disconnect');
      const targetOutcome = result.enrichmentOutcomes.find((item) => item.docId === targetDocId);
      assert.ok(targetOutcome);
      assert.ok(targetOutcome.error);
      assert.equal(targetOutcome.recorded, true);

      const others = result.enrichmentOutcomes.filter((item) => item.docId !== targetDocId);
      assert.equal(others.length, docs.length - 1);
      for (const outcome of others) {
        assert.equal(outcome.error, null, `expected ${outcome.docId} to succeed normally`);
      }

      const latestRun = await db.getLatestSyncRun(result.syncKey);
      assert.notEqual(latestRun.status, 'failed');
    } finally {
      restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Gate harness 2 (#23): limiter contention spike -------------------------
//
// contentConcurrency: 8 against a low content rate limit. Asserts no document
// is recorded failed due to limiter contention, using contentRateWindowMs to
// keep the run fast without waiting out real 60-second windows.

test('gate 2: contentConcurrency 8 against a low, fast-window content rate limit fails zero documents to limiter contention', async () => {
  const originalFetch = globalThis.fetch;
  const suffix = `2${Date.now()}`;
  const docs = buildGateDocs(suffix, 12);
  globalThis.fetch = fullTextFetchMock(docs);
  const rule = await db.saveImportRule({ id: `gate2-rule-${suffix}`, name: `Gate 2 rule ${suffix}` });

  const client = await db.getDb();
  const originalExecute = client.execute.bind(client);
  let casStatements = 0;
  client.execute = async (statement, ...rest) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (/import_rule_request_limits/.test(sql)) casStatements += 1;
    return originalExecute(statement, ...rest);
  };

  try {
    const startedAt = Date.now();
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,Gate2-${suffix}`,
      source: 'id,title,author,digitalResourceOriginalRecord',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: docs.length,
      contentMode: 'full_text_only',
      contentConcurrency: 8,
      contentRateLimit: 2,
      // Real contention-spike callers keep the 60s default; this shrinks the
      // window so genuine queuing (not just theoretical contention) resolves
      // in well under a second of real wall-clock time (#23 §2.2).
      contentRateWindowMs: 100,
      importRuleId: rule.id,
      downloadFiles: false,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, true);
    assert.equal(result.totalEnrichmentAttempted, docs.length);
    assert.equal(result.totalEnrichmentFailed, 0, 'no document should fail purely from limiter contention');
    assert.ok(
      !result.enrichmentOutcomes.some((outcome) => /reserve content-request quota|RATE_LIMIT_STATE_CORRUPT/.test(outcome.error || '')),
      `no outcome should carry a limiter-exhaustion error: ${JSON.stringify(result.enrichmentOutcomes.filter((o) => o.error))}`
    );
    for (const outcome of result.enrichmentOutcomes) {
      assert.equal(outcome.error, null, `expected ${outcome.docId} to succeed; contention must never surface as a document failure`);
    }

    // Sanity check the rate limit was actually engaged, not trivially
    // satisfied: 24 documents at limit 2 per 200ms window cannot finish
    // instantly — the run must take measurably longer than a handful of
    // milliseconds, and more than one CAS statement per document must have
    // been issued (i.e., real waiting-and-retrying happened).
    assert.ok(elapsedMs >= 100, `expected genuine rate-limit queuing to take real time, took ${elapsedMs}ms`);
    assert.ok(casStatements > docs.length, `expected more than one limiter statement per document under real contention, saw ${casStatements}`);
  } finally {
    client.execute = originalExecute;
    globalThis.fetch = originalFetch;
  }
});

// --- Combined gate (Finding 2 / #10's literal "and"): induced DB disconnect --
// --- AND a limiter contention spike, in the SAME sync page -------------------
//
// The #10 completion gate reads "survives an induced DB disconnect AND a
// limiter contention spike" — a single run exercising both fault conditions
// at once, not the two gates run separately (which is all Gate 1 and Gate 2
// above ever do). This is exactly the compounding-latency interaction
// docs/phase-b-completion-plan.md §2.1's caveat worried about: Layer A's
// withDbRetry backoff on the disconnected document's DB calls, layered on top
// of genuine rate-limit queuing for every document under contentConcurrency:
// 8 against a low contentRateLimit, must not multiply into a slow or
// mis-recorded run.
test('combined gate: a DB disconnect and a limiter contention spike in the same page both resolve correctly and quickly', async () => {
  const originalFetch = globalThis.fetch;
  const suffix = `3${Date.now()}`;
  const docs = buildGateDocs(suffix, 16);
  const targetDocId = docs[7].id;
  globalThis.fetch = fullTextFetchMock(docs);
  const rule = await db.saveImportRule({ id: `combined-gate-rule-${suffix}`, name: `Combined gate rule ${suffix}` });

  const client = await db.getDb();
  // Sustained (always-fails) disconnect on one document's metadata save — the
  // same shape as gate 1a — layered on top of gate 2's contention setup below.
  const restore = induceDbDisconnect(client, { targetDocId, atCall: 1, failureBudget: Infinity });
  try {
    const startedAt = Date.now();
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,Combined-${suffix}`,
      source: 'id,title,author,digitalResourceOriginalRecord',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: docs.length,
      contentMode: 'full_text_only',
      contentConcurrency: 8,
      contentRateLimit: 2,
      contentRateWindowMs: 100,
      importRuleId: rule.id,
      downloadFiles: false,
    });
    const elapsedMs = Date.now() - startedAt;

    // The run does not abort.
    assert.equal(result.ok, true, 'the run must not fail from either induced fault, individually or combined');
    const latestRun = await db.getLatestSyncRun(result.syncKey);
    assert.notEqual(latestRun.status, 'failed', 'the sync_runs row must not be marked failed');

    // The disconnected document is retried (or, since this is a sustained
    // failure exhausting Layer A's retries, durably recorded as failed) —
    // never silently dropped and never crashing the page.
    const targetOutcome = result.enrichmentOutcomes.find((item) => item.docId === targetDocId);
    assert.ok(targetOutcome, 'the disconnected document must still produce an outcome entry');
    assert.ok(targetOutcome.error, 'the disconnected document outcome must carry the DB error');
    assert.equal(targetOutcome.recorded, true, 'the disconnected document failure must be durably recorded');
    assert.equal(targetOutcome.outcomeKind, 'document_error',
      'the disconnected document must be tagged as a document error, not limiter contention');
    const storedTarget = await db.loadStoredFileMetric(targetDocId);
    assert.ok(storedTarget?.error, 'the disconnected document must have a durable file_metrics row with an error');

    // No document anywhere in the page is recorded as failed due to limiter
    // contention — every other document (all of which race the same
    // contentRateLimit: 2 / contentConcurrency: 8 contention as the
    // disconnected one) must succeed normally.
    const others = result.enrichmentOutcomes.filter((item) => item.docId !== targetDocId);
    assert.equal(others.length, docs.length - 1);
    for (const outcome of others) {
      assert.equal(outcome.error, null,
        `expected ${outcome.docId} to succeed; limiter contention must never surface as a document failure alongside the disconnect`);
    }
    assert.ok(
      !result.enrichmentOutcomes.some((o) => /reserve content-request quota|RATE_LIMIT_STATE_CORRUPT/.test(o.error || '')),
      `no outcome should carry a limiter-exhaustion error: ${JSON.stringify(result.enrichmentOutcomes.filter((o) => o.error))}`
    );

    // The combined fault does not blow up latency: genuine rate-limit queuing
    // (16 docs at limit 2/100ms, concurrency 8) takes real but small time, and
    // Layer A's backoff on the disconnected document's retries (base 25ms,
    // capped, few attempts) does not compound this into anything resembling a
    // real 60s wait. A generous bound well under one second confirms no
    // accidental fallback to the real 60_000ms limiter window occurred.
    assert.ok(elapsedMs < 5_000, `expected the combined-fault run to complete quickly, took ${elapsedMs}ms`);
  } finally {
    restore();
    globalThis.fetch = originalFetch;
  }
});

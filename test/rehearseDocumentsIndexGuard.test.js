import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The rehearsal script writes to its target (indexes, statistics rows, triggers), and
// its output is pasted to the owner. It must refuse the production database host even
// when --confirm-target names it, never contact any host while refusing, and never
// print the auth token. A preloaded module replaces fetch so nothing leaves the machine.

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rehearse-documents-index.mjs');
const noNetwork = `data:text/javascript,${encodeURIComponent(`
  globalThis.fetch = async (input) => {
    process.stderr.write('NETWORK-ATTEMPT ' + new URL(String(input?.url ?? input)).host + '\\n');
    throw new Error('network disabled in test');
  };
`)}`;
const PROD = 'dissertation-workbench-exampleorg.aws-us-east-1.turso.io';
const TOKEN = 'tok-should-never-print-123';

function run(env, extraArgs) {
  return spawnSync(process.execPath, ['--import', noNetwork, script, ...extraArgs], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

for (const [label, urlValue, confirm] of [
  ['libsql URL', `libsql://${PROD}`, PROD],
  ['https URL, upper case, explicit port', `https://${PROD.toUpperCase()}:443`, `${PROD}:443`],
]) {
  test(`the rehearsal refuses the production host (${label}) without any network call or token in its output`, () => {
    const result = run({ TURSO_DATABASE_URL: urlValue, TURSO_AUTH_TOKEN: TOKEN }, [`--confirm-target=${confirm}`]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 2, `exit status ${result.status}; output:\n${output}`);
    assert.match(output, /production database/i);
    assert.doesNotMatch(output, /NETWORK-ATTEMPT/);
    assert.ok(!output.includes(TOKEN), 'the auth token was printed');
  });
}

test('a branch of the production database is not mistaken for production', () => {
  const branch = 'dissertation-workbench-idx-rehearsal2-exampleorg.aws-us-east-1.turso.io';
  const result = run({ TURSO_DATABASE_URL: `libsql://${branch}`, TURSO_AUTH_TOKEN: TOKEN }, [`--confirm-target=${branch}`]);
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(output, /production database/i);
  assert.ok(!output.includes(TOKEN), 'the auth token was printed');
});

test('PROD_TURSO_HOST names the production host exactly', () => {
  const host = 'workbench-prod-exampleorg.aws-us-east-1.turso.io';
  const result = run({ TURSO_DATABASE_URL: `libsql://${host}`, TURSO_AUTH_TOKEN: TOKEN, PROD_TURSO_HOST: host }, [`--confirm-target=${host}`]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2);
  assert.match(output, /production database/i);
  assert.doesNotMatch(output, /NETWORK-ATTEMPT/);
});

test('the rehearsal refuses a target that --confirm-target does not name, without any network call', () => {
  const result = run({ TURSO_DATABASE_URL: 'libsql://some-branch.example.turso.io', TURSO_AUTH_TOKEN: TOKEN }, []);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2);
  assert.doesNotMatch(output, /NETWORK-ATTEMPT/);
  assert.ok(!output.includes(TOKEN));
});

// Review (DBA, phase 4, after the branch rehearsal): the first rehearsal's plan sweep never
// showed getDocumentCacheStats, the first statement of every cold slice: its filter
// /\bdocuments d?\b/ needs a space after "documents" and that SQL had a newline (it also
// skipped SQL passed as text). Pins that the sweep covers it. A file target runs the whole
// script locally (wall time only, no network).
test('the rehearsal plan sweep covers getDocumentCacheStats', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-rehearsal-file-'));
  const dbFile = path.join(dir, 'copy.sqlite');
  try {
    const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      process.env.SKIP_LOCAL_ENV = '1';
      const db = await import(${JSON.stringify(path.join(path.dirname(script), '..', 'src', 'db.js'))});
      const { seedServingCorpus } = await import(${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'documentsServingCorpus.js'))});
      await db.ensureStorage();
      await seedServingCorpus(db);
      await db.closeDb();
    `], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', APP_DATA_DIR: dir, SQLITE_PATH: dbFile,
      PDF_CACHE_DIR: path.join(dir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(dir, 'ft') }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(seed.status, 0, seed.stderr);
    const result = spawnSync(process.execPath, ['--import', noNetwork, script, `--confirm-target=${dbFile}`, '--round-pause-ms=0', '--retry-scale=0'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', TURSO_DATABASE_URL: `file:${dbFile}`,
        APP_DATA_DIR: dir, SQLITE_PATH: dbFile, PDF_CACHE_DIR: path.join(dir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(dir, 'ft') },
      encoding: 'utf8', timeout: 120_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /p1 none +cache stats/, `no cache stats plan line:\n${output.slice(-3000)}`);
    assert.doesNotMatch(output, /NETWORK-ATTEMPT/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

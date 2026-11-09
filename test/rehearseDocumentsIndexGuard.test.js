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

test('the rehearsal refuses a target that --confirm-target does not name, without any network call', () => {
  const result = run({ TURSO_DATABASE_URL: 'libsql://some-branch.example.turso.io', TURSO_AUTH_TOKEN: TOKEN }, []);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2);
  assert.doesNotMatch(output, /NETWORK-ATTEMPT/);
  assert.ok(!output.includes(TOKEN));
});

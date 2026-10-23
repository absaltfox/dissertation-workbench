import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// config.js reads env once at import, so each value needs a fresh process.
function nightlyConceptRebuildEnabled(value) {
  const env = { ...process.env, SKIP_LOCAL_ENV: '1' };
  if (value === undefined) delete env.CONCEPT_REBUILD_NIGHTLY_ENABLED;
  else env.CONCEPT_REBUILD_NIGHTLY_ENABLED = value;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  return execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { CONCEPT_REBUILD_NIGHTLY_ENABLED } = await import(${JSON.stringify(configUrl)});
    process.stdout.write(String(CONCEPT_REBUILD_NIGHTLY_ENABLED));
  `], { env, encoding: 'utf8' });
}

test('the nightly concept rebuild stays on unless explicitly disabled', () => {
  assert.equal(nightlyConceptRebuildEnabled(undefined), 'true');
  assert.equal(nightlyConceptRebuildEnabled('1'), 'true');
  assert.equal(nightlyConceptRebuildEnabled('0'), 'false');
  assert.equal(nightlyConceptRebuildEnabled('false'), 'false');
});

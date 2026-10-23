// The e2e server runs inside whatever shell or CI job launched Playwright, so
// it would inherit every exported secret (FLY_API_TOKEN, ANTHROPIC_API_KEY,
// ADMIN_WORKER_MODE, ...). Build its env from an allowlist instead of blanking
// known names, so a variable added to the app later cannot leak in by default.
// Import-free so the Playwright runner can load it without pulling in src/.
const HOST_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'TZ',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT',
];

export function isolatedServerEnv(source, settings) {
  const env = {};
  for (const name of HOST_ALLOWLIST) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return { ...env, ...settings };
}

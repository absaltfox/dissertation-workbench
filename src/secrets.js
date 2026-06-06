import { getSetting, setSetting } from './db.js';
import { encryptSecret, decryptSecret } from './secretCrypto.js';
import { DEFAULT_API_KEY } from './config.js';

export { encryptSecret, decryptSecret };

export function isApiKeyEnvManaged() {
  return Boolean(String(DEFAULT_API_KEY || '').trim());
}

export async function getConfiguredApiKey() {
  if (isApiKeyEnvManaged()) return DEFAULT_API_KEY.trim();
  const stored = await getSetting('apiKey');
  return decryptSecret(stored) || '';
}

export async function setConfiguredApiKey(value) {
  if (isApiKeyEnvManaged()) {
    throw new Error('UBC_API_KEY is managed by the environment and cannot be changed through the admin UI.');
  }
  await setSetting('apiKey', encryptSecret(value));
}

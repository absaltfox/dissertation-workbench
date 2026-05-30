import { getSetting, setSetting } from './db.js';
import { encryptSecret, decryptSecret } from './secretCrypto.js';

export { encryptSecret, decryptSecret };

export async function getConfiguredApiKey() {
  const stored = await getSetting('apiKey');
  return decryptSecret(stored) || process.env.UBC_API_KEY || '';
}

export async function setConfiguredApiKey(value) {
  await setSetting('apiKey', encryptSecret(value));
}

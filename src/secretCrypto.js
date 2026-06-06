import crypto from 'node:crypto';
import { API_KEY_ENCRYPTION_KEY, IS_PRODUCTION, MFA_SECRET_ENCRYPTION_KEY } from './config.js';

const PREFIX = 'enc:v1:';

function getKey(keyMaterial, envName) {
  if (!keyMaterial) {
    if (IS_PRODUCTION) throw new Error(`${envName} is required in production to store secrets.`);
    return null;
  }
  return crypto.createHash('sha256').update(keyMaterial).digest();
}

export function encryptSecret(value, keyMaterial = API_KEY_ENCRYPTION_KEY, envName = 'API_KEY_ENCRYPTION_KEY') {
  const key = getKey(keyMaterial, envName);
  if (!key) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

export function decryptSecret(value, keyMaterial = API_KEY_ENCRYPTION_KEY, envName = 'API_KEY_ENCRYPTION_KEY') {
  if (!value) return null;
  if (!String(value).startsWith(PREFIX)) {
    if (IS_PRODUCTION) {
      throw new Error(`Stored secret is not encrypted. Re-save it with ${envName} configured.`);
    }
    return value;
  }
  const key = getKey(keyMaterial, envName);
  if (!key) throw new Error(`${envName} is required to decrypt stored secrets.`);
  const payload = Buffer.from(String(value).slice(PREFIX.length), 'base64url');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function encryptMfaSecret(value) {
  return encryptSecret(value, MFA_SECRET_ENCRYPTION_KEY, 'MFA_SECRET_ENCRYPTION_KEY');
}

export function decryptMfaSecret(value) {
  return decryptSecret(value, MFA_SECRET_ENCRYPTION_KEY, 'MFA_SECRET_ENCRYPTION_KEY');
}

import dns from 'node:dns/promises';
import net from 'node:net';
import { PDF_ALLOWED_HOSTS, PDF_ALLOW_HTTP_DOWNLOADS } from './config.js';

const MAX_REDIRECTS = 5;

// Outbound PDF fetching is intentionally conservative. Open Collections records
// can contain metadata URLs, so every candidate and redirect target is checked
// before fetch sees it.
function isPrivateIPv4(host) {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0
    || a === 10
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168
    || a >= 224
    || host === '255.255.255.255'
  );
}

function isPrivateIPv6(host) {
  const normalized = host.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('ff')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

export function isBlockedAddress(address) {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) return isPrivateIPv4(address);
  if (ipVersion === 6) return isPrivateIPv6(address);
  return true;
}

export function isAllowedDownloadHost(hostname, allowedHosts = PDF_ALLOWED_HOSTS) {
  const normalized = String(hostname || '').toLowerCase();
  return allowedHosts.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

// Validate the URL shape, host allowlist, and resolved addresses. DNS is checked
// here, rather than only matching host strings, to block private-network targets
// reached through allowed-looking names or redirects.
export async function assertSafeDownloadUrl(rawUrl, {
  allowedHosts = PDF_ALLOWED_HOSTS,
  allowHttp = PDF_ALLOW_HTTP_DOWNLOADS,
  resolveHost = dns.lookup,
} = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid download URL');
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Unsupported download URL scheme');
  }
  if (url.protocol === 'http:' && !allowHttp) {
    throw new Error('Insecure download URL scheme');
  }
  if (!isAllowedDownloadHost(url.hostname, allowedHosts)) {
    throw new Error('Download URL host is not allowed');
  }

  const addresses = await resolveHost(url.hostname, { all: true });
  const normalizedAddresses = Array.isArray(addresses) ? addresses : [addresses];
  if (!normalizedAddresses.length) throw new Error('Download URL host did not resolve');
  for (const entry of normalizedAddresses) {
    const address = typeof entry === 'string' ? entry : entry.address;
    if (!address || isBlockedAddress(address)) {
      throw new Error('Download URL resolves to a blocked address');
    }
  }

  return url;
}

export async function safeFetchDownloadUrl(rawUrl, fetchOptions = {}, safetyOptions = {}) {
  let currentUrl = String(rawUrl || '');
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const checkedUrl = await assertSafeDownloadUrl(currentUrl, safetyOptions);
    const response = await fetch(checkedUrl, { ...fetchOptions, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    currentUrl = new URL(location, checkedUrl).toString();
  }
  throw new Error('Too many download redirects');
}

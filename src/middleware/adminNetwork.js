import net from 'node:net';

/**
 * Parses a comma-separated list of IPv4/IPv6 addresses or CIDR ranges.
 * Returns null when the value is unset or blank (no restriction). Throws on
 * a malformed entry so a typo fails at startup instead of allowing everyone.
 */
export function parseAllowedNetworks(value) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const list = new net.BlockList();
  for (const entry of entries) {
    const bad = () => new Error(`Invalid ADMIN_ALLOWED_NETWORKS entry: ${entry}`);
    const [address, prefix, extra] = entry.split('/');
    const family = net.isIP(address);
    if (!family || extra !== undefined) throw bad();
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    if (!/^\d+$/.test(prefix) || bits > (family === 4 ? 32 : 128)) throw bad();
    list.addSubnet(address, bits, type);
  }
  return list;
}

/** True when the list is null (unrestricted) or contains the client IP. */
export function isAllowedAdminIp(blockList, ip) {
  if (!blockList) return true;
  let candidate = String(ip || '').trim();
  const mapped = candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) candidate = mapped[1];
  const family = net.isIP(candidate);
  if (!family) return false;
  return blockList.check(candidate, family === 4 ? 'ipv4' : 'ipv6');
}

/** Responds 404 (hiding the surface entirely) to clients outside the list. */
export function createAdminNetworkGate({ blockList, getClientIp }) {
  return (req, res, next) => {
    if (isAllowedAdminIp(blockList, getClientIp(req))) {
      next();
      return;
    }
    res.status(404).json({ error: 'Not found' });
  };
}

import fs from 'node:fs';
import path from 'node:path';

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;

  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    const commentIndex = value.search(/\s#/);
    if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
  }

  return [match[1], value.replace(/\\n/g, '\n')];
}

export function loadLocalEnv() {
  if (TRUE_VALUES.has(String(process.env.SKIP_LOCAL_ENV || '').toLowerCase())) return [];

  const envFile = process.env.ENV_FILE || '.env';
  const envPath = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(envPath)) return [];

  const loaded = [];
  const contents = fs.readFileSync(envPath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

loadLocalEnv();

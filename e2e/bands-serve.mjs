// Serves an already-prepared bands DB. Usage: E2E_BANDS_DIR=<dir> E2E_PORT=<port> node e2e/bands-serve.mjs
import { bandsServerEnv } from './bands-env.mjs';

const env = bandsServerEnv(process.env.E2E_BANDS_DIR, process.env.E2E_PORT);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, env);
const { start } = await import('../src/server.js');
await start();

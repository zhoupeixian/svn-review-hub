import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

for (const [name, minimum] of [['PORTAL_ADMIN_PASSWORD', 20], ['PORTAL_SESSION_SECRET', 32], ['ANONYMOUS_SOURCE_HASH_KEY', 32]]) {
  const value = process.env[name] ?? '';
  if (value.length < minimum || value.startsWith('replace-')) throw new Error(`${name} must be configured; run scripts/init-server.mjs first.`);
}
const masterKey = process.env.REVIEW_SYNC_MASTER_KEY ?? '';
if (Buffer.from(masterKey, 'base64').length !== 32) throw new Error('REVIEW_SYNC_MASTER_KEY must encode exactly 32 bytes.');
const origin = new URL(process.env.PORTAL_ORIGIN ?? 'http://localhost:3000');
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PORTAL_ORIGIN must be an HTTP(S) origin.');
process.env.PORTAL_ORIGIN = origin.origin;
process.env.PORTAL_RUNTIME = 'node';
process.env.PORTAL_DATA_DIR = resolve(process.env.PORTAL_DATA_DIR || './data');
process.env.HOSTNAME = process.env.PORTAL_BIND_ADDRESS || '127.0.0.1';
process.env.NEXT_TELEMETRY_DISABLED = '1';
await import(pathToFileURL(resolve(process.env.PORTAL_SERVER_ENTRY || '.next-server/standalone/server.js')).href);

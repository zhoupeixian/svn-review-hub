import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const origin = new URL(process.argv[2] || 'http://localhost:3000');
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Provide a site origin, for example https://review.example.com');
const secret = () => randomBytes(32).toString('base64url');
const content = [
  `PORTAL_ORIGIN=${origin.origin}`,
  `PORTAL_ADMIN_PASSWORD=${secret()}`,
  `PORTAL_SESSION_SECRET=${secret()}`,
  `ANONYMOUS_SOURCE_HASH_KEY=${secret()}`,
  `REVIEW_SYNC_MASTER_KEY=${randomBytes(32).toString('base64')}`,
  '',
].join('\n');
writeFileSync('.env.server', content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log('Created .env.server. Read PORTAL_ADMIN_PASSWORD there to log in; keep this file private and backed up.');

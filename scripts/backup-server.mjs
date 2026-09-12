import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

if (!process.argv[2]) throw new Error('Usage: node scripts/backup-server.mjs <new-backup-file>');
process.umask(0o077);
const destination = resolve(process.argv[2]);
mkdirSync(dirname(destination), { recursive: true });
const db = new DatabaseSync(resolve(process.env.PORTAL_DATA_DIR || './data', 'portal.sqlite'), { readOnly: true });
try { db.prepare('VACUUM INTO ?').run(destination); } finally { db.close(); }
console.log(`Consistent database and document backup saved: ${destination}`);

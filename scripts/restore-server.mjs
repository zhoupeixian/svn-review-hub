import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync, readdirSync, copyFileSync, constants } from 'node:fs';

if (!process.argv[2]) throw new Error('Usage: node scripts/restore-server.mjs <trusted-backup-file>; target data directory must be empty.');
const source = resolve(process.argv[2]);
const check = new DatabaseSync(source, { readOnly: true });
try {
  if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup integrity check failed.');
  check.prepare('SELECT id FROM review_projects LIMIT 1').get();
  check.prepare('SELECT key FROM portal_objects LIMIT 1').get();
} finally { check.close(); }
const data = resolve(process.env.PORTAL_DATA_DIR || './data');
mkdirSync(data, { recursive: true });
if (readdirSync(data).length) throw new Error('Target data directory must be empty.');
copyFileSync(source, resolve(data, 'portal.sqlite'), constants.COPYFILE_EXCL);
console.log('Restored into a new database. Restore the matching .env.server secrets before starting.');

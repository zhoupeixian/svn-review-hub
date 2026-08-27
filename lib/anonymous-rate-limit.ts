import { env } from 'cloudflare:workers';
import { ensureReviewSchema } from '@/lib/reviews';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 10;
const ANONYMOUS_BUCKET = 'anonymous';

type RuntimeEnv = { DB: D1Database };

function getDb(): D1Database {
  const db = (env as unknown as RuntimeEnv).DB;
  if (!db) throw new Error('审查站的数据存储尚未连接。');
  return db;
}

async function hashClient(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

/** D1 only receives a one-way client hash and a short-lived counter. */
export async function allowAnonymousUpdate(request: Request): Promise<boolean> {
  await ensureReviewSchema();
  const db = getDb();
  const clientHash = await hashClient(
    request.headers.get('CF-Connecting-IP') || ANONYMOUS_BUCKET,
  );
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiredBefore = new Date(now - WINDOW_MS).toISOString();

  await db
    .prepare('DELETE FROM anonymous_update_limits WHERE window_started_at < ?')
    .bind(expiredBefore)
    .run();

  await db
    .prepare(
      'INSERT OR IGNORE INTO anonymous_update_limits (client_hash, window_started_at, request_count) VALUES (?, ?, 0)',
    )
    .bind(clientHash, nowIso)
    .run();
  const updated = await db
    .prepare(
      'UPDATE anonymous_update_limits SET request_count = request_count + 1 WHERE client_hash = ? AND request_count < ?',
    )
    .bind(clientHash, MAX_REQUESTS)
    .run();
  return Number(updated.meta.changes ?? 0) === 1;
}

export const ANONYMOUS_UPDATE_WINDOW_MS = WINDOW_MS;
export const ANONYMOUS_UPDATE_MAX_REQUESTS = MAX_REQUESTS;

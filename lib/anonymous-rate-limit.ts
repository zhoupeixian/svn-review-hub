import { env } from 'cloudflare:workers';
import { ensureReviewSchema } from '@/lib/reviews';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 10;
const ANONYMOUS_BUCKET = 'anonymous';

type RuntimeEnv = {
  DB: D1Database;
  ANONYMOUS_SOURCE_HASH_KEY: string;
};

function getDb(): D1Database {
  const db = (env as unknown as RuntimeEnv).DB;
  if (!db) throw new Error('审查站的数据存储尚未连接。');
  return db;
}

async function hashAnonymousSource(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

type AnonymousUpdateResult = {
  allowed: boolean;
  sourceHash: string;
};

/** D1 only receives a project-bound one-way source hash and a short-lived counter. */
export async function consumeAnonymousUpdate(
  projectId: number,
  request: Request,
): Promise<AnonymousUpdateResult> {
  await ensureReviewSchema();
  const runtime = env as unknown as RuntimeEnv;
  const db = getDb();
  const hashKey = runtime.ANONYMOUS_SOURCE_HASH_KEY;
  if (typeof hashKey !== 'string' || hashKey.length < 32) {
    throw new Error('匿名来源摘要密钥未配置或长度不足。');
  }
  const anonymousSourceHash = await hashAnonymousSource(
    hashKey,
    `${projectId}:${request.headers.get('CF-Connecting-IP') || ANONYMOUS_BUCKET}`,
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
    .bind(anonymousSourceHash, nowIso)
    .run();
  const updated = await db
    .prepare(
      'UPDATE anonymous_update_limits SET request_count = request_count + 1 WHERE client_hash = ? AND request_count < ?',
    )
    .bind(anonymousSourceHash, MAX_REQUESTS)
    .run();
  return {
    allowed: Number(updated.meta.changes ?? 0) === 1,
    sourceHash: anonymousSourceHash,
  };
}

export const ANONYMOUS_UPDATE_WINDOW_MS = WINDOW_MS;
export const ANONYMOUS_UPDATE_MAX_REQUESTS = MAX_REQUESTS;

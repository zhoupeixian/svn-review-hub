import { env } from '@/lib/runtime';

const SESSION_TTL = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'portal_session';
type AuthEnv = {
  PORTAL_RUNTIME?: string;
  PORTAL_ORIGIN?: string;
  PORTAL_ADMIN_PASSWORD?: string;
  PORTAL_SESSION_SECRET?: string;
  PORTAL_TRUST_PROXY?: string;
  DB: D1Database;
};

export function localAuthEnabled() { return (env as unknown as AuthEnv).PORTAL_RUNTIME === 'node'; }

export function authConfig() {
  const runtime = env as unknown as AuthEnv;
  const password = runtime.PORTAL_ADMIN_PASSWORD ?? '';
  const secret = runtime.PORTAL_SESSION_SECRET ?? '';
  const origin = new URL(runtime.PORTAL_ORIGIN ?? 'http://localhost:3000').origin;
  if (password.length < 20 || secret.length < 32 || password.startsWith('replace-') || secret.startsWith('replace-')) {
    throw new Error('请先生成独立部署的管理员密码和会话密钥。');
  }
  return { password, secret, origin };
}

async function hmacKey() {
  const { secret, password } = authConfig();
  return crypto.subtle.importKey('raw', new TextEncoder().encode(`${secret}:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function passwordMatches(value: string) {
  const encoder = new TextEncoder();
  const key = await hmacKey();
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(authConfig().password));
  return crypto.subtle.verify('HMAC', key, expected, encoder.encode(value));
}

export async function createSession(now = Date.now()) {
  const expiry = String(now + SESSION_TTL);
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(), new TextEncoder().encode(expiry));
  return `${expiry}.${Buffer.from(signature).toString('hex')}`;
}

export async function validSession(token: string, now = Date.now()) {
  const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match || Number(match[1]) <= now || Number(match[1]) > now + SESSION_TTL) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(), Buffer.from(match[2], 'hex'), new TextEncoder().encode(match[1]));
}

export function sessionCookie(token: string, clear = false) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_TTL / 1000}${authConfig().origin.startsWith('https:') ? '; Secure' : ''}`;
}

export function safeLoginReturn(value: string | null) {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/admin/projects';
  const base = 'https://portal.invalid';
  const target = new URL(value, base);
  return target.origin === base && target.pathname !== '/login' ? target.pathname + target.search + target.hash : '/admin/projects';
}

async function loginSource(request: Request) {
  const runtime = env as unknown as AuthEnv;
  const source = runtime.PORTAL_TRUST_PROXY === 'true' ? request.headers.get('cf-connecting-ip') ?? 'shared' : 'shared';
  return Buffer.from(await crypto.subtle.sign('HMAC', await hmacKey(), new TextEncoder().encode(source))).toString('hex');
}

export async function consumeLoginAttempt(request: Request) {
  const { DB } = env as unknown as AuthEnv;
  await DB.prepare('CREATE TABLE IF NOT EXISTS portal_login_attempts (source TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL)').run();
  const now = Date.now();
  await DB.prepare('DELETE FROM portal_login_attempts WHERE expires <= ?').bind(now).run();
  const result = await DB.prepare(`INSERT INTO portal_login_attempts (source, attempts, expires) VALUES (?, 1, ?)
    ON CONFLICT(source) DO UPDATE SET attempts = attempts + 1 WHERE attempts < 10`).bind(await loginSource(request), now + 15 * 60 * 1000).run();
  return Number(result.meta.changes) === 1;
}

export async function clearLoginAttempts(request: Request) {
  await (env as unknown as AuthEnv).DB.prepare('DELETE FROM portal_login_attempts WHERE source = ?').bind(await loginSource(request)).run();
}

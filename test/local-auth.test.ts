import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ env: {} as Record<string, unknown>, headers: new Headers() }));
vi.mock('@/lib/runtime', () => ({ env: state.env }));
vi.mock('next/headers', () => ({ headers: async () => state.headers }));
import { createNodeStorage } from '../lib/node-storage';
import { createSession, validSession, passwordMatches, safeLoginReturn, sessionCookie } from '../lib/local-auth';
import { getChatGPTUser } from '../app/chatgpt-auth';
import { POST as login } from '../app/api/session/route';
import { POST as logout } from '../app/api/session/logout/route';

const storage = createNodeStorage(':memory:');
const password = 'test-only-admin-password-long';
const origin = 'https://portal.test';
function request(body: string, source = origin) {
  return new Request(`${origin}/api/session`, { method: 'POST', headers: { origin: source }, body });
}

describe('独立部署身份边界', () => {
  beforeEach(async () => {
    Object.assign(state.env, { PORTAL_RUNTIME: 'node', PORTAL_ORIGIN: origin, PORTAL_ADMIN_PASSWORD: password, PORTAL_SESSION_SECRET: 'test-only-session-secret-at-least-32-characters', DB: storage.DB });
    state.headers = new Headers();
    state.env.PORTAL_TRUST_PROXY = undefined;
    await storage.DB.exec('CREATE TABLE IF NOT EXISTS portal_login_attempts (source TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL); DELETE FROM portal_login_attempts');
  });

  it('校验密码并拒绝篡改、过期和密码轮换前的会话', async () => {
    expect(await passwordMatches(password)).toBe(true);
    expect(await passwordMatches('wrong')).toBe(false);
    const now = Date.now();
    const token = await createSession(now);
    expect(await validSession(token, now)).toBe(true);
    expect(await validSession(token.slice(0, -2) + 'zz', now)).toBe(false);
    expect(await validSession(token, now + 12 * 3600_000)).toBe(false);
    state.env.PORTAL_ADMIN_PASSWORD = password + '-rotated';
    expect(await validSession(token, now)).toBe(false);
  });

  it('忽略伪造的托管身份头，只有本站会话能成为管理员', async () => {
    state.headers = new Headers({ 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'attacker@test' });
    expect(await getChatGPTUser()).toBeNull();
    state.headers.set('cookie', `portal_session=${await createSession()}`);
    expect((await getChatGPTUser())?.userId).toBe('local-admin');
    state.headers.set('origin', 'https://attacker.test');
    expect(await getChatGPTUser()).toBeNull();
  });

  it('拒绝跨站登录、超大请求并持久限制密码尝试', async () => {
    expect((await login(request('password=x', 'https://attacker.test'))).status).toBe(403);
    expect((await login(request('x'.repeat(4097)))).status).toBe(413);
    for (let i = 0; i < 9; i++) expect((await login(request('password=wrong'))).status).toBe(303);
    expect((await login(request(`password=${password}`))).status).toBe(429);
  });

  it('登录设置安全 Cookie，退出需同源 POST', async () => {
    const response = await login(request(`password=${password}&return_to=//attacker.test`));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${origin}/admin/projects`);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    expect(response.headers.get('set-cookie')).toContain('; Secure');
    expect((await logout(request('', 'https://attacker.test'))).status).toBe(403);
    expect((await logout(request(''))).headers.get('set-cookie')).toContain('Max-Age=0');
    expect(sessionCookie('x')).not.toContain(password);
  });

  it('可信代理模式中其他来源的失败不会锁定管理员', async () => {
    state.env.PORTAL_TRUST_PROXY = 'true';
    for (let i = 0; i < 11; i++) {
      const attempt = request('password=wrong');
      attempt.headers.set('cf-connecting-ip', '192.0.2.1');
      expect((await login(attempt)).status).toBe(i < 10 ? 303 : 429);
    }
    const valid = request(`password=${password}`);
    valid.headers.set('cf-connecting-ip', '192.0.2.2');
    expect((await login(valid)).status).toBe(303);
    const rows = await storage.DB.prepare('SELECT source FROM portal_login_attempts').all();
    expect(JSON.stringify(rows.results)).not.toContain('192.0.2.1');
  });

  it('过滤外站和反斜杠跳转，保留正常相对路径', () => {
    for (const value of ['//evil.test', '/\\evil.test', 'https://evil.test', '/login']) expect(safeLoginReturn(value)).toBe('/admin/projects');
    expect(safeLoginReturn('/projects/zherp?scope=active')).toBe('/projects/zherp?scope=active');
  });

  it('托管运行时不开放本地密码登录', async () => {
    state.env.PORTAL_RUNTIME = undefined;
    expect((await login(request(`password=${password}`))).status).toBe(404);
    expect((await logout(request(''))).status).toBe(404);
  });
});

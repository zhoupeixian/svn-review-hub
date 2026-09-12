import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

afterEach(() => vi.unstubAllEnvs());

it('直连服务器清除伪造来源头，可信代理只能映射覆盖后的来源', () => {
  vi.stubEnv('PORTAL_RUNTIME', 'node');
  vi.stubEnv('PORTAL_TRUST_PROXY', 'false');
  const request = new NextRequest('http://localhost/api/session', { headers: { 'cf-connecting-ip': 'forged', 'x-real-ip': '192.0.2.1' } });
  expect(proxy(request).headers.get('x-middleware-request-cf-connecting-ip')).toBeNull();
  vi.stubEnv('PORTAL_TRUST_PROXY', 'true');
  expect(proxy(request).headers.get('x-middleware-request-cf-connecting-ip')).toBe('192.0.2.1');
});

it('Cloudflare 运行模式不改写请求头', () => {
  vi.stubEnv('PORTAL_RUNTIME', '');
  const response = proxy(new NextRequest('https://portal.test/api/reviews', { headers: { 'cf-connecting-ip': '192.0.2.1' } }));
  expect(response.headers.get('x-middleware-override-headers')).toBeNull();
});

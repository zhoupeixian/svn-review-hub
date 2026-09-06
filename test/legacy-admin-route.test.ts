import { beforeEach, expect, it, vi } from 'vitest';

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('../app/chatgpt-auth', () => ({
  requireChatGPTUser: vi.fn(async () => ({
    userId: 'admin-1',
    email: 'admin@example.com',
    displayName: '管理员',
    fullName: '管理员',
  })),
}));
vi.mock('../lib/reviews', () => ({ allowAdministrator: vi.fn(async () => true) }));
vi.mock('../lib/project-administration', () => ({
  listAdminProjects: vi.fn(async () => []),
  getProjectAdminAuditPage: vi.fn(async () => ({
    audits: [],
    nextCursor: null,
    hasMore: false,
  })),
}));

import LegacyAdminPage from '../app/admin/page';

beforeEach(() => {
  redirectMock.mockClear();
});

it('旧管理链接重定向到 ZHERP 项目内日志管理', async () => {
  await LegacyAdminPage();

  expect(redirectMock).toHaveBeenCalledWith('/projects/zherp/admin');
});

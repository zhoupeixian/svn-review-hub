/// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectAdminManager from '../app/admin/project-admin-manager';

const projects = [
  {
    id: 1,
    name: 'ZHERP',
    slug: 'zherp',
    description: 'ERP 主项目',
    displayOrder: 0,
    enabled: true,
    syncKeyMasked: 'abc***wxyz',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 2,
    name: '海华项目',
    slug: 'haihua',
    description: '海华专项',
    displayOrder: 10,
    enabled: true,
    syncKeyMasked: 'def***stuv',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
];

const audits = [
  {
    id: 1,
    projectId: 2,
    projectSlug: 'haihua',
    projectName: '海华项目',
    projectSnapshot: JSON.stringify(projects[1]),
    adminUserId: 'admin-1',
    adminEmail: 'admin@example.com',
    adminDisplayName: '管理员',
    action: 'project.create' as const,
    result: 'success' as const,
    failureCode: null,
    createdAt: '2026-09-01T10:00:00.000Z',
  },
];

describe('全局项目维护 UI', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('创建项目、编辑资料，并将不可变标识与项目内日志管理入口明确分开', async () => {
    const created = {
      ...projects[1],
      id: 3,
      name: '财务项目',
      slug: 'finance',
      description: '财务专项',
      displayOrder: 20,
    };
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ project: created }, 201))
      .mockResolvedValueOnce(jsonResponse({
        project: { ...projects[0], name: 'ZHERP ERP', description: '更新简介' },
      }));

    render(<ProjectAdminManager initialProjects={projects} initialAudits={audits} />);
    expect(screen.getByRole('heading', { name: '维护审查项目' })).toBeTruthy();
    expect((screen.getByLabelText('ZHERP 项目标识') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole('link', { name: '进入 ZHERP 历史管理' }).getAttribute('href'))
      .toBe('/projects/zherp/admin');

    await userEvent.type(screen.getByLabelText('新项目名称'), '财务项目');
    await userEvent.type(screen.getByLabelText('新项目标识'), 'finance');
    await userEvent.type(screen.getByLabelText('新项目简介'), '财务专项');
    await userEvent.clear(screen.getByLabelText('新项目显示顺序'));
    await userEvent.type(screen.getByLabelText('新项目显示顺序'), '20');
    await userEvent.click(screen.getByRole('button', { name: '创建项目' }));

    expect(await screen.findByDisplayValue('财务项目')).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/projects');
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      name: '财务项目', slug: 'finance', description: '财务专项', displayOrder: 20,
    });

    const zherpName = screen.getByLabelText('ZHERP 项目名称');
    await userEvent.clear(zherpName);
    await userEvent.type(zherpName, 'ZHERP ERP');
    const zherpDescription = screen.getByLabelText('ZHERP 项目简介');
    await userEvent.clear(zherpDescription);
    await userEvent.type(zherpDescription, '更新简介');
    await userEvent.click(screen.getByRole('button', { name: '保存 ZHERP 项目资料' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/projects/1');
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      name: 'ZHERP ERP', description: '更新简介',
    });
  });

  it('排序和审计筛选分别调用专用接口，并展示当时管理员身份与结果', async () => {
    const reordered = [
      { ...projects[1], displayOrder: 0 },
      { ...projects[0], displayOrder: 10 },
    ];
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ projects: reordered }))
      .mockResolvedValueOnce(jsonResponse({ audits }));

    render(<ProjectAdminManager initialProjects={projects} initialAudits={audits} />);
    await userEvent.click(screen.getByRole('button', { name: '上移 海华项目' }));

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/projects/order');
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      projectIds: [2, 1],
    });

    await userEvent.type(screen.getByLabelText('按项目标识筛选审计'), 'haihua');
    await userEvent.type(screen.getByLabelText('按管理员 ID 筛选审计'), 'admin-1');
    await userEvent.selectOptions(screen.getByLabelText('按动作筛选审计'), 'project.create');
    await userEvent.click(screen.getByRole('button', { name: '查询审计' }));

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/admin/project-audits?');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('projectSlug=haihua');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('adminUserId=admin-1');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('action=project.create');
    expect(screen.getByText('管理员（admin@example.com）')).toBeTruthy();
    expect(screen.getByText('成功')).toBeTruthy();
    expect(screen.getByText('2026-09-01 18:00:00')).toBeTruthy();
  });

  it('停用和恢复项目并始终保留管理员历史入口', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ project: { ...projects[1], enabled: false } }))
      .mockResolvedValueOnce(jsonResponse({ project: { ...projects[1], enabled: true } }));
    render(<ProjectAdminManager
      initialProjects={[projects[1]]}
      initialAudits={[]}
    />);

    expect(screen.getByRole('link', { name: '进入 海华项目 历史管理' }).getAttribute('href'))
      .toBe('/projects/haihua/admin');
    await userEvent.click(screen.getByRole('button', { name: '停用 海华项目' }));
    expect(await screen.findByRole('button', { name: '恢复 海华项目' })).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/projects/2/status');
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ enabled: false });

    await userEvent.click(screen.getByRole('button', { name: '恢复 海华项目' }));
    expect(await screen.findByRole('button', { name: '停用 海华项目' })).toBeTruthy();
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ enabled: true });
  });

  it('只展示脱敏密钥，复制时不把完整值放进页面状态，且可轮换', async () => {
    const fullKey = 'abc012345678901234567890123456789012345wxyz';
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ syncKey: fullKey, syncKeyMasked: 'abc***wxyz' }))
      .mockResolvedValueOnce(jsonResponse({
        project: { ...projects[0], syncKeyMasked: 'new***mask' },
      }));

    render(<ProjectAdminManager initialProjects={[projects[0]]} initialAudits={[]} />);

    expect(screen.getByText('abc***wxyz')).toBeTruthy();
    expect(screen.queryByText(fullKey)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '复制 ZHERP 同步密钥' }));
    expect(writeText).toHaveBeenCalledWith(fullKey);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/projects/1/sync-key/copy');
    expect(screen.queryByText(fullKey)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '轮换 ZHERP 同步密钥' }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/projects/1/sync-key/rotate');
    expect(await screen.findByText('new***mask')).toBeTruthy();
    expect(screen.queryByText(fullKey)).toBeNull();
  });

  it('同排序值项目改名后按服务端规则重排本地目录位置', async () => {
    const tiedProjects = [
      { ...projects[0], name: 'Alpha', slug: 'alpha', displayOrder: 0 },
      { ...projects[1], name: 'Beta', slug: 'beta', displayOrder: 0 },
    ];
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
      project: { ...tiedProjects[0], name: 'Zulu' },
    }));
    render(<ProjectAdminManager initialProjects={tiedProjects} initialAudits={[]} />);

    await userEvent.click(screen.getByRole('button', { name: '保存 Alpha 项目资料' }));

    await waitFor(() => {
      const articles = screen.getAllByRole('article');
      expect(within(articles[0]).getByLabelText('Beta 项目名称')).toBeTruthy();
      expect(within(articles[1]).getByLabelText('Zulu 项目名称')).toBeTruthy();
    });
  });

  it('同排序值项目按 SQLite NOCASE 规则排列非 ASCII 名称', async () => {
    const tiedProjects = [
      { ...projects[0], name: 'Alpha', slug: 'alpha', displayOrder: 0 },
      { ...projects[1], name: 'Zulu', slug: 'zulu', displayOrder: 0 },
    ];
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
      project: { ...tiedProjects[0], name: 'Éclair' },
    }));
    render(<ProjectAdminManager initialProjects={tiedProjects} initialAudits={[]} />);

    await userEvent.click(screen.getByRole('button', { name: '保存 Alpha 项目资料' }));

    await waitFor(() => {
      const articles = screen.getAllByRole('article');
      expect(within(articles[0]).getByLabelText('Zulu 项目名称')).toBeTruthy();
      expect(within(articles[1]).getByLabelText('Éclair 项目名称')).toBeTruthy();
    });
  });

  it('可以用游标继续加载更早的审计记录', async () => {
    const olderAudit = {
      ...audits[0],
      id: 2,
      projectName: '更早项目',
      createdAt: '2026-08-31T10:00:00.000Z',
    };
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
      audits: [olderAudit], nextCursor: null, hasMore: false,
    }));
    render(<ProjectAdminManager
      initialProjects={projects}
      initialAudits={audits}
      initialAuditCursor="older-cursor"
      initialAuditHasMore
    />);

    await userEvent.click(screen.getByRole('button', { name: '加载更早审计' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/project-audits?cursor=older-cursor', undefined);
    expect(await screen.findByText('更早项目')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更早审计' })).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('link', { name: '进入 ZHERP 日志管理' }).getAttribute('href'))
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
  });

  it('停用项目不显示当前必然返回 404 的日志管理链接', () => {
    render(<ProjectAdminManager
      initialProjects={[{ ...projects[1], enabled: false }]}
      initialAudits={[]}
    />);

    expect(screen.queryByRole('link', { name: '进入 海华项目 日志管理' })).toBeNull();
    expect(screen.getByText('项目已停用，恢复后可进入日志管理')).toBeTruthy();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

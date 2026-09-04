/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGPTUser } from '../app/chatgpt-auth';
import { GET as getAudits } from '../app/api/admin/project-audits/route';
import { PATCH as updateProject } from '../app/api/admin/projects/[id]/route';
import { PUT as reorderProjects } from '../app/api/admin/projects/order/route';
import { GET as getProjects, POST as createProject } from '../app/api/admin/projects/route';
import { projectAdminErrorResponse } from '../lib/global-admin-api';
import { ensureReviewSchema, getReviewProjectDirectory } from '../lib/reviews';

let currentUser: ChatGPTUser | null = {
  userId: 'admin-1',
  email: 'admin-old@example.com',
  displayName: '旧管理员名',
  fullName: '旧管理员名',
};

vi.mock('../app/chatgpt-auth', () => ({
  getChatGPTUser: vi.fn(async () => currentUser),
}));

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
};

const { DB, FILES } = env as unknown as TestEnv;

describe.sequential('全局审查项目维护与审计 API', () => {
  beforeAll(async () => {
    await ensureReviewSchema();
  });

  beforeEach(async () => {
    currentUser = {
      userId: 'admin-1',
      email: 'admin-old@example.com',
      displayName: '旧管理员名',
      fullName: '旧管理员名',
    };
    await DB.batch([
      DB.prepare('DELETE FROM project_admin_audits'),
      DB.prepare('DELETE FROM review_issue_events'),
      DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'),
      DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_projects WHERE id <> 1'),
      DB.prepare("UPDATE review_projects SET name = 'ZHERP', slug = 'zherp', description = '', display_order = 0, enabled = 1 WHERE id = 1"),
      DB.prepare('DELETE FROM admin_users'),
      DB.prepare("INSERT INTO admin_users (user_id, email, display_name, created_at) VALUES ('admin-1', 'stored@example.com', '数据库旧名称', '2026-01-01T00:00:00.000Z')"),
    ]);
    await FILES.put('sentinel/project-admin.txt', 'R2 不应被项目维护修改');
  });

  it('只允许全局管理员访问，且认证失败不写业务审计', async () => {
    currentUser = null;
    const unauthenticated = await getProjects();
    currentUser = {
      userId: 'not-admin',
      email: 'member@example.com',
      displayName: '普通成员',
      fullName: '普通成员',
    };
    const forbidden = await createProject(jsonRequest('/api/admin/projects', 'POST', {
      name: '海华项目', slug: 'haihua', description: '', displayOrder: 10,
    }));

    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(await auditCount()).toBe(0);
  });

  it('格式损坏的 JSON 返回请求错误，且不伪造业务失败审计', async () => {
    const response = await createProject(new Request('https://example.test/api/admin/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_json' });
    expect(await auditCount()).toBe(0);
  });

  it('创建合法项目并立即按显示顺序进入公共目录，同时原有 R2 对象保持不变', async () => {
    const response = await createProject(jsonRequest('/api/admin/projects', 'POST', {
      name: '海华项目',
      slug: 'haihua',
      description: '海华专项审查',
      displayOrder: 20,
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      project: {
        name: '海华项目', slug: 'haihua', description: '海华专项审查',
        displayOrder: 20, enabled: true,
      },
    });
    expect((await getReviewProjectDirectory()).map((project) => project.slug)).toEqual([
      'zherp', 'haihua',
    ]);
    expect(await (await FILES.get('sentinel/project-admin.txt'))?.text()).toBe('R2 不应被项目维护修改');
    expect(await audits()).toMatchObject([
      {
        projectSlug: 'haihua', adminUserId: 'admin-1',
        adminEmail: 'admin-old@example.com', adminDisplayName: '旧管理员名',
        action: 'project.create', result: 'success', failureCode: null,
      },
    ]);
  });

  it.each([
    [{ name: 'ZHERP', slug: 'new-project', displayOrder: 10 }, 'duplicate_name'],
    [{ name: '另一个项目', slug: 'zherp', displayOrder: 10 }, 'duplicate_slug'],
    [{ name: '保留字项目', slug: 'admin', displayOrder: 10 }, 'reserved_slug'],
    [{ name: '非法项目', slug: 'hai_hua', displayOrder: 10 }, 'invalid_slug'],
    [{ name: '大小写项目', slug: 'Haihua', displayOrder: 10 }, 'invalid_slug'],
    [{ name: '空名称', slug: 'empty-name', displayOrder: -1 }, 'invalid_display_order'],
    [{ name: '超大顺序', slug: 'unsafe-order', displayOrder: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_display_order'],
  ])('明确拒绝无效创建 %j 并记录失败审计', async (body, failureCode) => {
    const response = await createProject(jsonRequest('/api/admin/projects', 'POST', body));
    const payload = await response.json() as { error: string; code: string };

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(payload.error).toBeTruthy();
    expect(payload.code).toBe(failureCode);
    expect(await auditCount()).toBe(1);
    expect((await audits())[0]).toMatchObject({
      action: 'project.create', result: 'failure', failureCode,
    });
  });

  it('编辑名称和简介但拒绝修改不可变项目标识', async () => {
    const created = await createProject(jsonRequest('/api/admin/projects', 'POST', {
      name: '海华项目', slug: 'haihua', description: '旧简介', displayOrder: 10,
    }));
    const projectId = ((await created.json()) as { project: { id: number } }).project.id;
    const updated = await updateProject(
      jsonRequest(`/api/admin/projects/${projectId}`, 'PATCH', {
        name: '海华研究院', description: '新简介',
      }),
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    const immutable = await updateProject(
      jsonRequest(`/api/admin/projects/${projectId}`, 'PATCH', {
        name: '篡改项目', description: '', slug: 'changed',
      }),
      { params: Promise.resolve({ id: String(projectId) }) },
    );

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      project: { id: projectId, name: '海华研究院', slug: 'haihua', description: '新简介' },
    });
    expect(immutable.status).toBe(409);
    expect(await immutable.json()).toMatchObject({ code: 'immutable_slug' });
    expect(await DB.prepare('SELECT name, slug, description FROM review_projects WHERE id = ?')
      .bind(projectId).first()).toEqual({ name: '海华研究院', slug: 'haihua', description: '新简介' });
    expect((await audits()).map((audit) => [audit.action, audit.result, audit.failureCode])).toEqual([
      ['project.update', 'failure', 'immutable_slug'],
      ['project.update', 'success', null],
      ['project.create', 'success', null],
    ]);
  });

  it('编辑时继续执行名称唯一约束，不产生部分更新', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua', 10);
    const response = await updateProject(
      jsonRequest(`/api/admin/projects/${projectId}`, 'PATCH', {
        name: 'zherp', description: '不能覆盖',
      }),
      { params: Promise.resolve({ id: String(projectId) }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'duplicate_name' });
    expect(await DB.prepare('SELECT name, description FROM review_projects WHERE id = ?')
      .bind(projectId).first()).toEqual({ name: '海华项目', description: '' });
    expect((await audits())[0]).toMatchObject({
      projectSlug: 'haihua', action: 'project.update', result: 'failure', failureCode: 'duplicate_name',
    });
  });

  it('全量排序原子更新目录顺序，并为每个项目保存排序快照', async () => {
    const haihua = await createProjectAndId('海华项目', 'haihua', 10);
    const finance = await createProjectAndId('财务项目', 'finance', 20);
    const reordered = await reorderProjects(jsonRequest('/api/admin/projects/order', 'PUT', {
      projectIds: [finance, 1, haihua],
    }));

    expect(reordered.status).toBe(200);
    expect((await getReviewProjectDirectory()).map((project) => project.slug)).toEqual([
      'finance', 'zherp', 'haihua',
    ]);
    const reorderAudits = (await audits()).filter((audit) => audit.action === 'project.reorder');
    expect(reorderAudits).toHaveLength(3);
    expect(reorderAudits.every((audit) => audit.result === 'success')).toBe(true);
    expect(reorderAudits.map((audit) => audit.projectSlug).sort()).toEqual(['finance', 'haihua', 'zherp']);
  });

  it('排序写入前项目全集变化时原子拒绝，不写成功审计或部分顺序', async () => {
    const haihua = await createProjectAndId('海华项目', 'haihua', 10);
    const batch = DB.batch.bind(DB);
    const batchSpy = vi.spyOn(DB, 'batch').mockImplementationOnce(async (statements) => {
      await DB.prepare(
        "INSERT INTO review_projects (name, slug, description, display_order, enabled) VALUES ('并发新增项目', 'concurrent', '', 30, 1)",
      ).run();
      return batch(statements);
    });

    const response = await reorderProjects(jsonRequest('/api/admin/projects/order', 'PUT', {
      projectIds: [haihua, 1],
    }));
    batchSpy.mockRestore();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'project_set_changed' });
    expect(await projectOrder()).toEqual([
      { id: 1, displayOrder: 0 },
      { id: haihua, displayOrder: 10 },
      expect.objectContaining({ displayOrder: 30 }),
    ]);
    const reorderAudits = (await audits()).filter((audit) => audit.action === 'project.reorder');
    expect(reorderAudits).toHaveLength(1);
    expect(reorderAudits[0]).toMatchObject({
      result: 'failure', failureCode: 'project_set_changed',
    });
    expect(JSON.parse(reorderAudits[0].projectSnapshot).projects).toHaveLength(3);
  });

  it.each([
    [[1, 1], 'duplicate_project_id'],
    [[1, 999], 'unknown_project_id'],
    [[1], 'incomplete_project_order'],
    [[1, Number.MAX_SAFE_INTEGER + 1], 'invalid_project_id'],
  ])('拒绝无效排序 %j 且不产生部分更新', async (projectIds, failureCode) => {
    const haihua = await createProjectAndId('海华项目', 'haihua', 10);
    const before = await projectOrder();
    const response = await reorderProjects(jsonRequest('/api/admin/projects/order', 'PUT', {
      projectIds: projectIds[0] === 1 && projectIds.length === 1 ? projectIds : projectIds.map((id) => id === 999 ? 999 : id),
    }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toMatchObject({ code: failureCode });
    expect(await projectOrder()).toEqual(before);
    expect((await audits())[0]).toMatchObject({
      action: 'project.reorder', result: 'failure', failureCode,
    });
    expect(JSON.parse((await audits())[0].projectSnapshot)).toMatchObject({
      requestedProjectIds: projectIds,
      projects: [
        { id: 1, name: 'ZHERP', slug: 'zherp', displayOrder: 0 },
        { id: haihua, name: '海华项目', slug: 'haihua', displayOrder: 10 },
      ],
    });
    expect(haihua).toBeGreaterThan(1);
  });

  it('未知基础设施错误使用通用响应，不向前端泄露内部错误原文', async () => {
    const response = projectAdminErrorResponse(new Error('D1 private table detail'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '项目维护暂时不可用。' });
  });

  it('审计保存操作当时身份和项目快照，并支持组合筛选及稳定倒序', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua', 10);
    currentUser = {
      userId: 'admin-1',
      email: 'admin-new@example.com',
      displayName: '新管理员名',
      fullName: '新管理员名',
    };
    await updateProject(
      jsonRequest(`/api/admin/projects/${projectId}`, 'PATCH', {
        name: '海华研究院', description: '更新后',
      }),
      { params: Promise.resolve({ id: String(projectId) }) },
    );

    const filtered = await getAudits(new Request(
      'https://example.test/api/admin/project-audits?projectSlug=haihua&adminUserId=admin-1&action=project.update',
    ));
    expect(filtered.status).toBe(200);
    const body = await filtered.json() as { audits: Awaited<ReturnType<typeof audits>> };
    expect(body.audits).toHaveLength(1);
    expect(body.audits[0]).toMatchObject({
      projectId, projectSlug: 'haihua', projectName: '海华研究院',
      adminEmail: 'admin-new@example.com', adminDisplayName: '新管理员名',
      action: 'project.update', result: 'success',
    });
    expect(JSON.parse(body.audits[0].projectSnapshot)).toMatchObject({
      id: projectId, slug: 'haihua', name: '海华研究院', description: '更新后',
    });

    const all = await audits();
    expect(all.map((audit) => audit.action)).toEqual(['project.update', 'project.create']);
    expect(all[1]).toMatchObject({
      adminEmail: 'admin-old@example.com', adminDisplayName: '旧管理员名', projectName: '海华项目',
    });

    await DB.prepare('DELETE FROM review_projects WHERE id = ?').bind(projectId).run();
    const afterProjectDeletion = await getAudits(new Request(
      'https://example.test/api/admin/project-audits?projectSlug=haihua',
    ));
    expect(((await afterProjectDeletion.json()) as { audits: unknown[] }).audits).toHaveLength(2);
  });
});

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createProjectAndId(name: string, slug: string, displayOrder: number): Promise<number> {
  const response = await createProject(jsonRequest('/api/admin/projects', 'POST', {
    name, slug, description: '', displayOrder,
  }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: number } }).project.id;
}

async function auditCount(): Promise<number> {
  return (await DB.prepare('SELECT COUNT(*) AS count FROM project_admin_audits').first<{ count: number }>())?.count ?? 0;
}

async function audits(): Promise<Array<{
  id: number;
  projectId: number | null;
  projectSlug: string | null;
  projectName: string | null;
  projectSnapshot: string;
  adminUserId: string;
  adminEmail: string;
  adminDisplayName: string;
  action: string;
  result: string;
  failureCode: string | null;
}>> {
  const rows = await DB.prepare(
    `SELECT id, project_id_snapshot AS projectId, project_slug_snapshot AS projectSlug,
            project_name_snapshot AS projectName, project_snapshot_json AS projectSnapshot,
            admin_user_id AS adminUserId, admin_email_snapshot AS adminEmail,
            admin_display_name_snapshot AS adminDisplayName, action, result,
            failure_code AS failureCode
     FROM project_admin_audits ORDER BY created_at DESC, id DESC`,
  ).all();
  return (rows.results ?? []) as Awaited<ReturnType<typeof audits>>;
}

async function projectOrder(): Promise<Array<{ id: number; displayOrder: number }>> {
  const result = await DB.prepare(
    'SELECT id, display_order AS displayOrder FROM review_projects ORDER BY id',
  ).all<{ id: number; displayOrder: number }>();
  return result.results ?? [];
}

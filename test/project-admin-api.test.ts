/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGPTUser } from '../app/chatgpt-auth';
import { GET as getAudits } from '../app/api/admin/project-audits/route';
import { PATCH as updateProject } from '../app/api/admin/projects/[id]/route';
import { PATCH as updateProjectStatus } from '../app/api/admin/projects/[id]/status/route';
import { POST as copyProjectSyncKey } from '../app/api/admin/projects/[id]/sync-key/copy/route';
import { POST as rotateProjectSyncKey } from '../app/api/admin/projects/[id]/sync-key/rotate/route';
import { PUT as reorderProjects } from '../app/api/admin/projects/order/route';
import { GET as getProjects, POST as createProject } from '../app/api/admin/projects/route';
import { projectAdminErrorResponse } from '../lib/global-admin-api';
import { authorizeProjectSync, ensureReviewSchema, getReviewProjectDirectory } from '../lib/reviews';

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
  REVIEW_SYNC_MASTER_KEY?: string;
};

const runtime = env as unknown as TestEnv;
const { DB, FILES } = runtime;
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe.sequential('全局审查项目维护与审计 API', () => {
  beforeAll(async () => {
    runtime.REVIEW_SYNC_MASTER_KEY = MASTER_KEY;
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
      DB.prepare("UPDATE review_projects SET name = 'ZHERP', slug = 'zherp', description = '', display_order = 0, enabled = 1, sync_key_encrypted = NULL WHERE id = 1"),
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

  it('为既有项目和新项目生成独立密钥，只在管理 DTO 中返回脱敏片段', async () => {
    const listed = await getProjects();
    const existing = (await listed.json()) as {
      projects: Array<{ id: number; syncKeyMasked: string }>;
    };
    const created = await createProject(jsonRequest('/api/admin/projects', 'POST', {
      name: '海华项目', slug: 'haihua', description: '', displayOrder: 10,
    }));
    const createdBody = await created.json() as {
      project: { id: number; syncKeyMasked: string };
    };
    const rows = await DB.prepare(
      'SELECT id, sync_key_encrypted AS encrypted FROM review_projects ORDER BY id',
    ).all<{ id: number; encrypted: string | null }>();

    expect(existing.projects[0].syncKeyMasked).toMatch(/^.{3}\*\*\*.{4}$/);
    expect(createdBody.project.syncKeyMasked).toMatch(/^.{3}\*\*\*.{4}$/);
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((row) => row.encrypted?.startsWith('v2.'))).toBe(true);
    expect(new Set(rows.results.map((row) => row.encrypted)).size).toBe(2);
    expect(JSON.stringify(existing)).not.toContain('sync_key_encrypted');
    expect(JSON.stringify(createdBody)).not.toContain('syncKeyEncrypted');

    const zherpCopy = await copyProjectSyncKey(new Request('https://example.test', { method: 'POST' }), {
      params: Promise.resolve({ id: String(existing.projects[0].id) }),
    });
    const haihuaCopy = await copyProjectSyncKey(new Request('https://example.test', { method: 'POST' }), {
      params: Promise.resolve({ id: String(createdBody.project.id) }),
    });
    const zherpKey = ((await zherpCopy.json()) as { syncKey: string }).syncKey;
    const haihuaKey = ((await haihuaCopy.json()) as { syncKey: string }).syncKey;
    expect(zherpKey).not.toBe(haihuaKey);
    await expect(authorizeProjectSync('zherp', zherpKey)).resolves.toMatchObject({ id: 1 });
    await expect(authorizeProjectSync('haihua', haihuaKey)).resolves.toMatchObject({ id: createdBody.project.id });
    await expect(authorizeProjectSync('haihua', zherpKey)).resolves.toBeNull();
  });

  it('复制只在 no-store 响应中返回当前完整密钥并写入无明文审计', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua', 10);
    const response = await copyProjectSyncKey(new Request(
      `https://example.test/api/admin/projects/${projectId}/sync-key/copy`,
      { method: 'POST' },
    ), { params: Promise.resolve({ id: String(projectId) }) });
    const body = await response.json() as { syncKey: string; syncKeyMasked: string };
    const encrypted = await DB.prepare(
      'SELECT sync_key_encrypted AS value FROM review_projects WHERE id = ?',
    ).bind(projectId).first<{ value: string }>();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.syncKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.syncKeyMasked).toBe(`${body.syncKey.slice(0, 3)}***${body.syncKey.slice(-4)}`);
    expect(encrypted?.value).not.toContain(body.syncKey);
    const copyAudit = (await audits()).find((audit) => audit.action === 'project.sync-key.copy');
    expect(copyAudit).toMatchObject({ result: 'success', failureCode: null });
    expect(JSON.stringify(copyAudit)).not.toContain(body.syncKey);
    expect(JSON.stringify(copyAudit)).not.toContain(encrypted?.value);
    expect(await (await FILES.get('sentinel/project-admin.txt'))?.text()).toBe('R2 不应被项目维护修改');
  });

  it('密文不可解密时拒绝复制并记录不含底层错误或密文的失败审计', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua', 10);
    await DB.prepare(
      "UPDATE review_projects SET sync_key_encrypted = 'v2.invalid-ciphertext' WHERE id = ?",
    ).bind(projectId).run();

    const response = await copyProjectSyncKey(new Request('https://example.test', { method: 'POST' }), {
      params: Promise.resolve({ id: String(projectId) }),
    });
    const body = await response.json() as { error: string; code: string };
    const copyAudit = (await audits()).find((audit) => audit.action === 'project.sync-key.copy');

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: '当前项目同步密钥不可用，请检查站点主密钥配置或轮换密钥。',
      code: 'project_sync_key_unavailable',
    });
    expect(copyAudit).toMatchObject({
      result: 'failure', failureCode: 'project_sync_key_unavailable',
    });
    expect(JSON.stringify(copyAudit)).not.toContain('invalid-ciphertext');
    expect(JSON.stringify(copyAudit)).not.toContain('无法解密');
  });

  it('复制时缺失密钥且主密钥无效仍写入不泄密的失败审计', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua', 10);
    await DB.prepare('UPDATE review_projects SET sync_key_encrypted = NULL WHERE id = ?')
      .bind(projectId).run();
    runtime.REVIEW_SYNC_MASTER_KEY = 'invalid-master-key';
    let response: Response;
    try {
      response = await copyProjectSyncKey(new Request('https://example.test', { method: 'POST' }), {
        params: Promise.resolve({ id: String(projectId) }),
      });
    } finally {
      runtime.REVIEW_SYNC_MASTER_KEY = MASTER_KEY;
    }

    expect(response!.status).toBe(409);
    expect(await response!.json()).toEqual({
      error: '当前项目同步密钥不可用，请检查站点主密钥配置或轮换密钥。',
      code: 'project_sync_key_unavailable',
    });
    const audit = (await audits()).find((entry) => entry.action === 'project.sync-key.copy');
    expect(audit).toMatchObject({ result: 'failure', failureCode: 'project_sync_key_unavailable' });
    expect(JSON.stringify(audit)).not.toContain('invalid-master-key');
  });

  it('轮换时主密钥无效仍写入不泄密的失败审计', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua', 10);
    runtime.REVIEW_SYNC_MASTER_KEY = 'invalid-master-key';
    let response: Response;
    try {
      response = await rotateProjectSyncKey(new Request('https://example.test', { method: 'POST' }), {
        params: Promise.resolve({ id: String(projectId) }),
      });
    } finally {
      runtime.REVIEW_SYNC_MASTER_KEY = MASTER_KEY;
    }

    expect(response!.status).toBe(409);
    expect(await response!.json()).toEqual({
      error: '当前项目同步密钥不可用，请检查站点主密钥配置或轮换密钥。',
      code: 'project_sync_key_unavailable',
    });
    const audit = (await audits()).find((entry) => entry.action === 'project.sync-key.rotate');
    expect(audit).toMatchObject({ result: 'failure', failureCode: 'project_sync_key_unavailable' });
    expect(JSON.stringify(audit)).not.toContain('invalid-master-key');
  });

  it('轮换后旧密钥立即失效，新密钥只可通过再次复制取得', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua', 10);
    const copiedBefore = await copyProjectSyncKey(new Request('https://example.test', { method: 'POST' }), {
      params: Promise.resolve({ id: String(projectId) }),
    });
    const oldKey = ((await copiedBefore.json()) as { syncKey: string }).syncKey;
    const rotated = await rotateProjectSyncKey(new Request('https://example.test', { method: 'POST' }), {
      params: Promise.resolve({ id: String(projectId) }),
    });
    const rotatedBody = await rotated.json() as { project: { syncKeyMasked: string } };
    const copiedAfter = await copyProjectSyncKey(new Request('https://example.test', { method: 'POST' }), {
      params: Promise.resolve({ id: String(projectId) }),
    });
    const newKey = ((await copiedAfter.json()) as { syncKey: string }).syncKey;

    expect(rotated.status).toBe(200);
    expect(rotatedBody.project.syncKeyMasked).toMatch(/^.{3}\*\*\*.{4}$/);
    expect(JSON.stringify(rotatedBody)).not.toContain(oldKey);
    expect(newKey).not.toBe(oldKey);
    await expect(authorizeProjectSync('haihua', oldKey)).resolves.toBeNull();
    await expect(authorizeProjectSync('haihua', newKey)).resolves.toMatchObject({ id: projectId });
    expect((await audits()).filter((audit) => audit.action === 'project.sync-key.rotate'))
      .toMatchObject([{ result: 'success', failureCode: null }]);
    expect(JSON.stringify(await audits())).not.toContain(oldKey);
    expect(JSON.stringify(await audits())).not.toContain(newKey);
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

  it('停用和恢复项目会更新公共目录并写入不含密钥的审计', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua', 10);
    await DB.prepare(
      "UPDATE review_projects SET sync_key_encrypted = 'v1.sensitive-ciphertext' WHERE id = ?",
    ).bind(projectId).run();

    const disabled = await updateProjectStatus(
      jsonRequest(`/api/admin/projects/${projectId}/status`, 'PATCH', { enabled: false }),
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    const directoryWhileDisabled = await getReviewProjectDirectory();
    const repeated = await updateProjectStatus(
      jsonRequest(`/api/admin/projects/${projectId}/status`, 'PATCH', { enabled: false }),
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    const restored = await updateProjectStatus(
      jsonRequest(`/api/admin/projects/${projectId}/status`, 'PATCH', { enabled: true }),
      { params: Promise.resolve({ id: String(projectId) }) },
    );

    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ project: { id: projectId, enabled: false } });
    expect(directoryWhileDisabled.map((project) => project.slug)).not.toContain('haihua');
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({ code: 'project_already_disabled' });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ project: { id: projectId, enabled: true } });
    expect((await getReviewProjectDirectory()).map((project) => project.slug)).toContain('haihua');
    const statusAudits = (await audits()).filter((audit) =>
      audit.action === 'project.disable' || audit.action === 'project.restore');
    expect(statusAudits.map((audit) => [audit.action, audit.result, audit.failureCode])).toEqual([
      ['project.restore', 'success', null],
      ['project.disable', 'failure', 'project_already_disabled'],
      ['project.disable', 'success', null],
    ]);
    expect(statusAudits.every((audit) => !audit.projectSnapshot.includes('sensitive-ciphertext'))).toBe(true);
    expect(await (await FILES.get('sentinel/project-admin.txt'))?.text()).toBe('R2 不应被项目维护修改');
  });

  it('同毫秒的并发停用也拒绝借用胜出请求的状态伪造成功审计', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
    try {
      const projectId = await createProjectAndId('海华项目', 'haihua', 10);
      const batch = DB.batch.bind(DB);
      vi.spyOn(DB, 'batch').mockImplementationOnce(async (statements) => {
        await DB.prepare(
          "UPDATE review_projects SET enabled = 0, updated_at = '2026-09-02T00:00:00.000Z' WHERE id = ?",
        ).bind(projectId).run();
        return batch(statements);
      });

      const response = await updateProjectStatus(
        jsonRequest(`/api/admin/projects/${projectId}/status`, 'PATCH', { enabled: false }),
        { params: Promise.resolve({ id: String(projectId) }) },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'project_status_changed' });
      const statusAudits = (await audits()).filter((audit) => audit.action === 'project.disable');
      expect(statusAudits).toHaveLength(1);
      expect(statusAudits[0]).toMatchObject({
        result: 'failure', failureCode: 'project_status_changed',
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('项目数量达到 D1 参数上限附近时仍可全量排序', async () => {
    await DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 2
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 94
       )
       INSERT INTO review_projects
         (name, slug, description, display_order, enabled)
       SELECT '项目' || value, 'project-' || value, '', value * 10, 1
       FROM sequence`,
    ).run();
    const ids = (await projectOrder()).map((project) => project.id).reverse();
    const batch = DB.batch.bind(DB);
    let batchStatementCount = 0;
    const batchSpy = vi.spyOn(DB, 'batch').mockImplementationOnce(async (statements) => {
      batchStatementCount = statements.length;
      return batch(statements);
    });

    const response = await reorderProjects(jsonRequest('/api/admin/projects/order', 'PUT', {
      projectIds: ids,
    }));
    batchSpy.mockRestore();

    expect(response.status).toBe(200);
    expect(batchStatementCount).toBe(2);
    expect((await projectOrder()).map((project) => project.displayOrder)).toEqual(
      Array.from({ length: 94 }, (_, index) => (93 - index) * 10),
    );
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

  it('审计使用稳定游标分页，超过单页上限的历史记录仍全部可达', async () => {
    await DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 205
       )
       INSERT INTO project_admin_audits
         (project_id_snapshot, project_slug_snapshot, project_name_snapshot,
          project_snapshot_json, admin_user_id, admin_email_snapshot,
          admin_display_name_snapshot, action, result, failure_code, created_at)
       SELECT 1, 'zherp', 'ZHERP', '{}', 'admin-1', 'admin@example.com',
              '管理员', 'project.update', 'success', NULL,
              '2026-09-01T10:00:00.000Z'
       FROM sequence`,
    ).run();

    const first = await auditPage('');
    const second = await auditPage(`?cursor=${encodeURIComponent(first.nextCursor ?? '')}`);
    const third = await auditPage(`?cursor=${encodeURIComponent(second.nextCursor ?? '')}`);
    const ids = [...first.audits, ...second.audits, ...third.audits].map((audit) => audit.id);

    expect([first.audits.length, second.audits.length, third.audits.length]).toEqual([100, 100, 5]);
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    expect(new Set(ids).size).toBe(205);
    expect(ids).toEqual([...ids].sort((left, right) => right - left));
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

async function auditPage(search: string): Promise<{
  audits: Array<{ id: number }>;
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const response = await getAudits(new Request(
    `https://example.test/api/admin/project-audits${search}`,
  ));
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    audits: Array<{ id: number }>;
    nextCursor: string | null;
    hasMore: boolean;
  }>;
}

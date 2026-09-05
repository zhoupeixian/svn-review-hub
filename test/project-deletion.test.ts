/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGPTUser } from '../app/chatgpt-auth';
import {
  DELETE as deleteProject,
  GET as previewProjectDeletion,
} from '../app/api/admin/projects/[id]/deletion/route';
import { PATCH as updateProject } from '../app/api/admin/projects/[id]/route';
import { PATCH as updateProjectStatus } from '../app/api/admin/projects/[id]/status/route';
import { POST as createProject } from '../app/api/admin/projects/route';
import { ensureReviewSchema, ingestReviewForProject } from '../lib/reviews';

const admin: ChatGPTUser = {
  userId: 'admin-1',
  email: 'admin@example.com',
  displayName: '管理员',
  fullName: '管理员',
};

vi.mock('../app/chatgpt-auth', () => ({
  getChatGPTUser: vi.fn(async () => admin),
}));

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  REVIEW_SYNC_MASTER_KEY?: string;
};

const runtime = env as unknown as TestEnv;
const { DB, FILES } = runtime;

describe.sequential('永久删除停用项目', () => {
  beforeAll(async () => {
    runtime.REVIEW_SYNC_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    await ensureReviewSchema();
  });

  beforeEach(async () => {
    await DB.batch([
      DB.prepare('DELETE FROM project_deletion_operations'),
      DB.prepare('DELETE FROM review_object_cleanup_queue'),
      DB.prepare('DELETE FROM project_admin_audits'),
      DB.prepare('DELETE FROM archive_operation_previews'),
      DB.prepare('DELETE FROM review_issue_events'),
      DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'),
      DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
      DB.prepare('DELETE FROM review_projects WHERE id <> 1'),
      DB.prepare("UPDATE review_projects SET name = 'ZHERP', slug = 'zherp', description = '', display_order = 0, enabled = 1, sync_key_encrypted = NULL WHERE id = 1"),
      DB.prepare('DELETE FROM admin_users'),
      DB.prepare("INSERT INTO admin_users (user_id, email, display_name, created_at) VALUES ('admin-1', 'admin@example.com', '管理员', '2026-01-01T00:00:00.000Z')"),
    ]);
    let cursor: string | undefined;
    do {
      const page = await FILES.list({ cursor });
      if (page.objects.length) await FILES.delete(page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await FILES.put('sentinel/keep.txt', '保留');
  });

  it('启用项目不能进入预览或确认删除流程', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua');

    const preview = await previewProjectDeletion(new Request('https://example.test'), context(projectId));
    const confirmed = await deleteProject(
      jsonRequest(`/api/admin/projects/${projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(projectId),
    );

    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({ code: 'project_delete_requires_disabled' });
    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toMatchObject({ code: 'project_delete_requires_disabled' });
    expect(await projectRow(projectId)).toMatchObject({ name: '海华项目', enabled: 1 });
  });

  it('预览展示五类删除影响，完整项目名称不匹配时不删除', async () => {
    const seeded = await seedDeletionProject();

    const preview = await previewProjectDeletion(new Request('https://example.test'), context(seeded.projectId));
    const body = await preview.json() as { project: { name: string }; counts: Record<string, number> };
    const rejected = await deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华' }),
      context(seeded.projectId),
    );

    expect(preview.status).toBe(200);
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      project: expect.objectContaining({ id: seeded.projectId, name: '海华项目', slug: 'haihua' }),
      counts: {
        reviewCount: 2,
        issueCount: 2,
        issueEventCount: 1,
        archivedReviewCount: 1,
        rawObjectCount: 3,
      },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'project_delete_name_mismatch' });
    expect(await projectRow(seeded.projectId)).not.toBeNull();
    expect((await FILES.list({ prefix: 'review-logs/haihua/' })).objects).toHaveLength(3);
    expect((await deleteAudits())[0]).toMatchObject({
      action: 'project.delete', result: 'failure', failureCode: 'project_delete_name_mismatch',
    });
  });

  it('确认后只清理目标项目全部 D1、R2、搜索和密钥数据并保留快照审计', async () => {
    const seeded = await seedDeletionProject();
    const encrypted = (await projectRow(seeded.projectId))?.syncKeyEncrypted;
    await DB.prepare(
      `INSERT INTO archive_operation_previews
         (token, admin_user_id, review_ids_json, review_count, revision_count,
          issue_count, created_at, expires_at)
       VALUES ('delete-preview', 'admin-1', ?, 1, 1, 1, ?, ?)`,
    ).bind(
      JSON.stringify([seeded.reviewIds[0]]),
      '2026-09-04T00:00:00.000Z',
      '2026-09-04T00:10:00.000Z',
    ).run();
    await DB.batch([
      DB.prepare(
        `INSERT INTO review_object_cleanup_queue (object_key, created_at, ready)
         VALUES ('review-logs/haihua/orphan.md', '2026-09-04T00:00:00.000Z', 1)`,
      ),
      DB.prepare(
        `INSERT INTO review_object_cleanup_queue (object_key, created_at, ready)
         VALUES ('review-logs/finance/orphan.md', '2026-09-04T00:00:00.000Z', 1)`,
      ),
    ]);

    const response = await deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(seeded.projectId),
    );
    const body = await response.json() as { deletedProject: { name: string; slug: string } };

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.deletedProject).toEqual({ name: '海华项目', slug: 'haihua' });
    expect(await projectRow(seeded.projectId)).toBeNull();
    expect(await count('review_logs', 'project_id = ?', seeded.projectId)).toBe(0);
    expect(await count('review_revisions', `review_id IN (${seeded.reviewIds.map(() => '?').join(',')})`, ...seeded.reviewIds)).toBe(0);
    expect(await count('review_issues', `review_id IN (${seeded.reviewIds.map(() => '?').join(',')})`, ...seeded.reviewIds)).toBe(0);
    expect(await count('review_issue_events')).toBe(1);
    expect(await count('review_search', `rowid IN (${seeded.reviewIds.map(() => '?').join(',')})`, ...seeded.reviewIds)).toBe(0);
    expect(await count('archive_operation_previews', "token = 'delete-preview'")).toBe(0);
    expect(await count('review_object_cleanup_queue', "object_key GLOB 'review-logs/haihua/*'")).toBe(0);
    expect(await count('review_object_cleanup_queue', "object_key GLOB 'review-logs/finance/*'")).toBe(1);
    expect((await FILES.list({ prefix: 'review-logs/haihua/' })).objects).toEqual([]);
    expect(await (await FILES.get('sentinel/keep.txt'))?.text()).toBe('保留');
    expect(await count('review_logs', 'project_id = ?', seeded.otherProjectId)).toBe(1);
    expect((await FILES.list({ prefix: 'review-logs/finance/' })).objects).toHaveLength(1);

    const audit = (await deleteAudits()).find((entry) => entry.result === 'success');
    expect(audit).toMatchObject({ projectId: seeded.projectId, projectName: '海华项目', projectSlug: 'haihua' });
    expect(JSON.parse(audit!.projectSnapshot)).toMatchObject({
      id: seeded.projectId,
      name: '海华项目',
      slug: 'haihua',
      counts: { reviewCount: 2, rawObjectCount: 3 },
    });
    expect(audit!.projectSnapshot).not.toContain(encrypted);

    const recreated = await createProject(jsonRequest('/api/admin/projects', 'POST', {
      name: '海华项目', slug: 'haihua', description: '重新创建', displayOrder: 30,
    }));
    expect(recreated.status).toBe(201);
    expect(await recreated.json()).toMatchObject({ project: { name: '海华项目', slug: 'haihua' } });
  });

  it('R2 清理失败时保留停用项目和删除锁，拒绝恢复并允许原确认安全重试', async () => {
    const seeded = await seedDeletionProject();
    vi.spyOn(FILES, 'delete').mockRejectedValueOnce(new Error('temporary R2 failure'));

    const failed = await deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(seeded.projectId),
    );
    const restore = await updateProjectStatus(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/status`, 'PATCH', { enabled: true }),
      context(seeded.projectId),
    );
    const renamed = await updateProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}`, 'PATCH', {
        name: '删除中改名', description: '',
      }),
      context(seeded.projectId),
    );
    const retried = await deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(seeded.projectId),
    );

    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'project_object_cleanup_failed' });
    expect(restore.status).toBe(409);
    expect(await restore.json()).toMatchObject({ code: 'project_deletion_in_progress' });
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toMatchObject({ code: 'project_deletion_in_progress' });
    expect(retried.status).toBe(200);
    expect(await projectRow(seeded.projectId)).toBeNull();
    expect((await FILES.list({ prefix: 'review-logs/haihua/' })).objects).toEqual([]);
    expect((await deleteAudits()).map((entry) => [entry.result, entry.failureCode])).toEqual([
      ['success', null],
      ['failure', 'project_object_cleanup_failed'],
    ]);
  });
});

async function seedDeletionProject(): Promise<{
  projectId: number;
  otherProjectId: number;
  reviewIds: number[];
}> {
  const projectId = await createProjectAndId('海华项目', 'haihua');
  const otherProjectId = await createProjectAndId('财务项目', 'finance');
  const first = await ingestReviewForProject(
    { id: projectId, slug: 'haihua' },
    ingestInput('haihua/active.md', '活动日志'),
  );
  const second = await ingestReviewForProject(
    { id: projectId, slug: 'haihua' },
    ingestInput('haihua/archived.md', '归档日志'),
  );
  const other = await ingestReviewForProject(
    { id: otherProjectId, slug: 'finance' },
    ingestInput('finance/keep.md', '保留日志'),
  );
  await DB.prepare('UPDATE review_logs SET archived_at = ? WHERE id = ?')
    .bind('2026-09-03T00:00:00.000Z', second.id).run();
  const issue = await DB.prepare(
    `SELECT i.id FROM review_issues i
     JOIN review_logs l ON l.id = i.review_id
     WHERE l.project_id = ? ORDER BY i.id LIMIT 1`,
  ).bind(projectId).first<{ id: number }>();
  await DB.prepare(
    `INSERT INTO review_issue_events
       (issue_id, from_status, to_status, note, created_at, anonymous_source_hash)
     VALUES (?, 'open', 'resolved', '已处理', ?, NULL)`,
  ).bind(issue!.id, '2026-09-04T00:00:00.000Z').run();
  const otherIssue = await DB.prepare(
    'SELECT id FROM review_issues WHERE review_id = ? ORDER BY id LIMIT 1',
  ).bind(other.id).first<{ id: number }>();
  await DB.prepare(
    `INSERT INTO review_issue_events
       (issue_id, from_status, to_status, note, created_at, anonymous_source_hash)
     VALUES (?, 'open', 'resolved', '保留', ?, NULL)`,
  ).bind(otherIssue!.id, '2026-09-04T00:00:00.000Z').run();
  await FILES.put('review-logs/haihua/orphan.md', '旧版本遗留对象');
  await DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id = ?').bind(projectId).run();
  return { projectId, otherProjectId, reviewIds: [first.id, second.id] };
}

function ingestInput(sourceKey: string, title: string) {
  return {
    markdown: `# ${title}\n日期：2026-09-04\n审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个\n\n| Revision | 作者 | 提交说明 | 结果 |\n| --- | --- | --- | --- |\n| r55000 | alice | 删除测试 | 已审查 |\n\n总体结论：发现 1 个 P2。\n\n### P2\n\n#### 删除测试问题\n相关 revision：55000\n\n项目数据应隔离删除。\n`,
    sourceKey,
    sourceName: `${title}.md`,
    importedBy: 'test',
    syncMode: 'manual' as const,
  };
}

async function createProjectAndId(name: string, slug: string): Promise<number> {
  const response = await createProject(jsonRequest('/api/admin/projects', 'POST', {
    name, slug, description: '', displayOrder: 10,
  }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: number } }).project.id;
}

function context(projectId: number) {
  return { params: Promise.resolve({ id: String(projectId) }) };
}

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function projectRow(projectId: number): Promise<{
  name: string;
  enabled: number;
  syncKeyEncrypted: string | null;
} | null> {
  return DB.prepare(
    `SELECT name, enabled, sync_key_encrypted AS syncKeyEncrypted
     FROM review_projects WHERE id = ?`,
  ).bind(projectId).first();
}

async function count(table: string, where = '', ...values: Array<string | number>): Promise<number> {
  const row = await DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`,
  ).bind(...values).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function deleteAudits(): Promise<Array<{
  projectId: number | null;
  projectSlug: string | null;
  projectName: string | null;
  projectSnapshot: string;
  action: string;
  result: string;
  failureCode: string | null;
}>> {
  const result = await DB.prepare(
    `SELECT project_id_snapshot AS projectId, project_slug_snapshot AS projectSlug,
            project_name_snapshot AS projectName, project_snapshot_json AS projectSnapshot,
            action, result, failure_code AS failureCode
     FROM project_admin_audits WHERE action = 'project.delete'
     ORDER BY created_at DESC, id DESC`,
  ).all();
  return result.results as Awaited<ReturnType<typeof deleteAudits>>;
}

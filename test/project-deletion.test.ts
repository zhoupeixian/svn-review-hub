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
import { POST as copyProjectSyncKey } from '../app/api/admin/projects/[id]/sync-key/copy/route';
import { POST as rotateProjectSyncKey } from '../app/api/admin/projects/[id]/sync-key/rotate/route';
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
    const seeded = await seedDeletionProject({ projectIdOutsideReviewSequence: true });
    const encrypted = (await projectRow(seeded.projectId))?.syncKeyEncrypted;
    await DB.prepare(
      `INSERT INTO archive_operation_previews
         (token, admin_user_id, review_ids_json, review_count, revision_count,
          issue_count, created_at, expires_at)
       VALUES ('delete-preview', 'admin-1', ?, 1, 1, 1, ?, ?)`,
    ).bind(
      JSON.stringify({ projectId: seeded.projectId, ids: [seeded.reviewIds[0]] }),
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

  it('同一项目并发删除时只有持有删除权的请求可以清理 R2', async () => {
    const seeded = await seedDeletionProject();
    let releaseFirstDelete!: () => void;
    let markFirstDeleteStarted!: () => void;
    const firstDeleteStarted = new Promise<void>((resolve) => {
      markFirstDeleteStarted = resolve;
    });
    const firstDeleteRelease = new Promise<void>((resolve) => {
      releaseFirstDelete = resolve;
    });
    const deleteSpy = vi.spyOn(FILES, 'delete').mockImplementationOnce(async (keys) => {
      markFirstDeleteStarted();
      await firstDeleteRelease;
      return FILES.delete(keys);
    });

    const firstRequest = deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(seeded.projectId),
    );
    await firstDeleteStarted;
    const secondResponse = await deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(seeded.projectId),
    );
    releaseFirstDelete();
    const firstResponse = await firstRequest;
    deleteSpy.mockRestore();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(409);
    expect(await secondResponse.json()).toMatchObject({ code: 'project_deletion_in_progress' });
  });

  it('租约被接管后陈旧请求会在删除前停止且不影响复用 slug 的新项目', async () => {
    const seeded = await seedDeletionProject();
    await DB.prepare(
      `INSERT INTO project_deletion_operations
         (project_id, project_slug_snapshot, project_name_snapshot,
          project_snapshot_json, started_at)
       VALUES (?, 'haihua', '海华项目', '{}', '2026-09-05T00:00:00.000Z')`,
    ).bind(seeded.projectId).run();
    const originalList = FILES.list.bind(FILES);
    let releaseStaleList!: () => void;
    let markStaleListStarted!: () => void;
    const staleListStarted = new Promise<void>((resolve) => {
      markStaleListStarted = resolve;
    });
    const staleListRelease = new Promise<void>((resolve) => {
      releaseStaleList = resolve;
    });
    const listSpy = vi.spyOn(FILES, 'list').mockImplementationOnce(async (options) => {
      markStaleListStarted();
      await staleListRelease;
      return originalList(options);
    });

    const staleRequest = deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(seeded.projectId),
    );
    await staleListStarted;
    await DB.prepare(
      `UPDATE project_deletion_operations
       SET claim_expires_at = '2026-09-01T00:00:00.000Z'
       WHERE project_id = ?`,
    ).bind(seeded.projectId).run();
    const takeoverResponse = await deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(seeded.projectId),
    );
    const recreated = await createProjectAndId('海华项目', 'haihua');
    const newObjectKey = 'review-logs/haihua/new-project.md';
    await FILES.put(newObjectKey, '新项目对象');
    releaseStaleList();
    const staleResponse = await staleRequest;
    listSpy.mockRestore();

    expect(takeoverResponse.status).toBe(200);
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ code: 'project_deletion_in_progress' });
    expect(await projectRow(recreated)).toMatchObject({ name: '海华项目' });
    expect(await (await FILES.get(newObjectKey))?.text()).toBe('新项目对象');
  });

  it('删除升级前默认项目时也会统计并清理日志行引用的旧版 R2 对象键', async () => {
    const imported = await ingestReviewForProject(
      { id: 1, slug: 'zherp' },
      ingestInput('legacy/default.md', '旧版默认项目日志'),
    );
    const stored = await DB.prepare(
      'SELECT content_object_key AS contentObjectKey FROM review_logs WHERE id = ?',
    ).bind(imported.id).first<{ contentObjectKey: string }>();
    const legacyObjectKey = 'review-logs/2026-09-04/legacy-default.md';
    await FILES.put(legacyObjectKey, '升级前原始日志');
    await FILES.delete(stored!.contentObjectKey);
    await DB.prepare('UPDATE review_logs SET content_object_key = ? WHERE id = ?')
      .bind(legacyObjectKey, imported.id).run();
    await DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id = 1').run();

    const preview = await previewProjectDeletion(new Request('https://example.test'), context(1));
    const deleted = await deleteProject(
      jsonRequest('/api/admin/projects/1/deletion', 'DELETE', { projectName: 'ZHERP' }),
      context(1),
    );

    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ counts: { rawObjectCount: 1 } });
    expect(deleted.status).toBe(200);
    expect(await FILES.head(legacyObjectKey)).toBeNull();
  });

  it('旧版对象键仍被其他项目引用时不会跨项目删除', async () => {
    const targetProjectId = await createProjectAndId('海华项目', 'haihua');
    const otherProjectId = await createProjectAndId('财务项目', 'finance');
    const targetReview = await ingestReviewForProject(
      { id: targetProjectId, slug: 'haihua' },
      ingestInput('legacy/target.md', '目标日志'),
    );
    const otherReview = await ingestReviewForProject(
      { id: otherProjectId, slug: 'finance' },
      ingestInput('legacy/other.md', '保留日志'),
    );
    const stored = await DB.prepare(
      `SELECT id, content_object_key AS contentObjectKey FROM review_logs
       WHERE id IN (?, ?) ORDER BY id`,
    ).bind(targetReview.id, otherReview.id).all<{ id: number; contentObjectKey: string }>();
    const sharedLegacyKey = 'review-logs/haihua/shared-legacy.md';
    await FILES.put(sharedLegacyKey, '其他项目仍在使用');
    await FILES.delete(stored.results.map((row) => row.contentObjectKey));
    await DB.prepare('UPDATE review_logs SET content_object_key = ? WHERE id IN (?, ?)')
      .bind(sharedLegacyKey, targetReview.id, otherReview.id).run();
    await DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id = ?')
      .bind(targetProjectId).run();

    const deleted = await deleteProject(
      jsonRequest(`/api/admin/projects/${targetProjectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(targetProjectId),
    );

    expect(deleted.status).toBe(200);
    expect(await FILES.head(sharedLegacyKey)).not.toBeNull();
    expect(await count('review_logs', 'project_id = ?', otherProjectId)).toBe(1);
  });

  it('共享旧版对象键的两个项目并发删除时会串行重算归属并最终清理对象', async () => {
    const firstProjectId = await createProjectAndId('海华项目', 'haihua');
    const secondProjectId = await createProjectAndId('财务项目', 'finance');
    const firstReview = await ingestReviewForProject(
      { id: firstProjectId, slug: 'haihua' },
      ingestInput('legacy/first.md', '第一项目日志'),
    );
    const secondReview = await ingestReviewForProject(
      { id: secondProjectId, slug: 'finance' },
      ingestInput('legacy/second.md', '第二项目日志'),
    );
    const stored = await DB.prepare(
      `SELECT content_object_key AS contentObjectKey FROM review_logs
       WHERE id IN (?, ?)`,
    ).bind(firstReview.id, secondReview.id).all<{ contentObjectKey: string }>();
    const sharedLegacyKey = 'review-logs/2026-09-05/shared-delete.md';
    await FILES.put(sharedLegacyKey, '等待最后一个项目删除');
    await FILES.delete(stored.results.map((row) => row.contentObjectKey));
    await DB.prepare('UPDATE review_logs SET content_object_key = ? WHERE id IN (?, ?)')
      .bind(sharedLegacyKey, firstReview.id, secondReview.id).run();
    await DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id IN (?, ?)')
      .bind(firstProjectId, secondProjectId).run();
    await DB.prepare(
      `INSERT INTO project_deletion_operations
         (project_id, project_slug_snapshot, project_name_snapshot,
          project_snapshot_json, started_at)
       VALUES (?, 'haihua', '海华项目', '{}', '2026-09-05T00:00:00.000Z')`,
    ).bind(firstProjectId).run();

    const originalList = FILES.list.bind(FILES);
    let releaseFirstList!: () => void;
    let markFirstListStarted!: () => void;
    const firstListStarted = new Promise<void>((resolve) => {
      markFirstListStarted = resolve;
    });
    const firstListRelease = new Promise<void>((resolve) => {
      releaseFirstList = resolve;
    });
    const listSpy = vi.spyOn(FILES, 'list').mockImplementationOnce(async (options) => {
      markFirstListStarted();
      await firstListRelease;
      return originalList(options);
    });
    const firstDeletion = deleteProject(
      jsonRequest(`/api/admin/projects/${firstProjectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(firstProjectId),
    );
    await firstListStarted;

    const overlappingDeletion = await deleteProject(
      jsonRequest(`/api/admin/projects/${secondProjectId}/deletion`, 'DELETE', { projectName: '财务项目' }),
      context(secondProjectId),
    );
    releaseFirstList();
    const firstResponse = await firstDeletion;
    listSpy.mockRestore();
    const retriedDeletion = await deleteProject(
      jsonRequest(`/api/admin/projects/${secondProjectId}/deletion`, 'DELETE', { projectName: '财务项目' }),
      context(secondProjectId),
    );

    expect(overlappingDeletion.status).toBe(409);
    expect(await overlappingDeletion.json()).toMatchObject({ code: 'project_deletion_in_progress' });
    expect(firstResponse.status).toBe(200);
    expect(retriedDeletion.status).toBe(200);
    expect(await FILES.head(sharedLegacyKey)).toBeNull();
  });

  it('其他项目接管全局租约后会阻止过期 Worker 重新续租', async () => {
    const firstProjectId = await createProjectAndId('海华项目', 'haihua');
    const secondProjectId = await createProjectAndId('财务项目', 'finance');
    const firstReview = await ingestReviewForProject(
      { id: firstProjectId, slug: 'haihua' },
      ingestInput('legacy/expired-first.md', '过期项目日志'),
    );
    const secondReview = await ingestReviewForProject(
      { id: secondProjectId, slug: 'finance' },
      ingestInput('legacy/takeover-second.md', '接管项目日志'),
    );
    const stored = await DB.prepare(
      `SELECT content_object_key AS contentObjectKey FROM review_logs
       WHERE id IN (?, ?)`,
    ).bind(firstReview.id, secondReview.id).all<{ contentObjectKey: string }>();
    const sharedLegacyKey = 'review-logs/2026-09-05/shared-takeover.md';
    await FILES.put(sharedLegacyKey, '仅由最后一个项目删除');
    await FILES.delete(stored.results.map((row) => row.contentObjectKey));
    await DB.prepare('UPDATE review_logs SET content_object_key = ? WHERE id IN (?, ?)')
      .bind(sharedLegacyKey, firstReview.id, secondReview.id).run();
    await DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id IN (?, ?)')
      .bind(firstProjectId, secondProjectId).run();
    await DB.batch([
      deletionOperationInsert(firstProjectId, 'haihua', '海华项目'),
      deletionOperationInsert(secondProjectId, 'finance', '财务项目'),
    ]);

    const originalList = FILES.list.bind(FILES);
    let releaseExpiredList!: () => void;
    let releaseTakeoverList!: () => void;
    let markExpiredListStarted!: () => void;
    let markTakeoverListStarted!: () => void;
    const expiredListStarted = new Promise<void>((resolve) => {
      markExpiredListStarted = resolve;
    });
    const takeoverListStarted = new Promise<void>((resolve) => {
      markTakeoverListStarted = resolve;
    });
    const expiredListRelease = new Promise<void>((resolve) => {
      releaseExpiredList = resolve;
    });
    const takeoverListRelease = new Promise<void>((resolve) => {
      releaseTakeoverList = resolve;
    });
    const listSpy = vi.spyOn(FILES, 'list')
      .mockImplementationOnce(async (options) => {
        markExpiredListStarted();
        await expiredListRelease;
        return originalList(options);
      })
      .mockImplementationOnce(async (options) => {
        markTakeoverListStarted();
        await takeoverListRelease;
        return originalList(options);
      });
    const expiredDeletion = deleteProject(
      jsonRequest(`/api/admin/projects/${firstProjectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(firstProjectId),
    );
    await expiredListStarted;
    await DB.prepare(
      `UPDATE project_deletion_operations
       SET claim_expires_at = '2026-09-01T00:00:00.000Z'
       WHERE project_id = ?`,
    ).bind(firstProjectId).run();
    const takeoverDeletion = deleteProject(
      jsonRequest(`/api/admin/projects/${secondProjectId}/deletion`, 'DELETE', { projectName: '财务项目' }),
      context(secondProjectId),
    );
    await takeoverListStarted;

    releaseExpiredList();
    const expiredResponse = await expiredDeletion;
    releaseTakeoverList();
    const takeoverResponse = await takeoverDeletion;
    listSpy.mockRestore();
    const retriedDeletion = await deleteProject(
      jsonRequest(`/api/admin/projects/${firstProjectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(firstProjectId),
    );

    expect(expiredResponse.status).toBe(409);
    expect(await expiredResponse.json()).toMatchObject({ code: 'project_deletion_in_progress' });
    expect(takeoverResponse.status).toBe(200);
    expect(retriedDeletion.status).toBe(200);
    expect(await FILES.head(sharedLegacyKey)).toBeNull();
  });

  it('删除 Worker 中断后可以接管已过期的清理租约继续删除', async () => {
    const seeded = await seedDeletionProject();
    await DB.prepare(
      `INSERT INTO project_deletion_operations
         (project_id, project_slug_snapshot, project_name_snapshot,
          project_snapshot_json, started_at, claim_token, claim_expires_at)
       VALUES (?, 'haihua', '海华项目', '{}', '2026-09-01T00:00:00.000Z',
               'abandoned-worker', '2026-09-01T00:05:00.000Z')`,
    ).bind(seeded.projectId).run();

    const retried = await deleteProject(
      jsonRequest(`/api/admin/projects/${seeded.projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(seeded.projectId),
    );

    expect(retried.status).toBe(200);
    expect(await projectRow(seeded.projectId)).toBeNull();
    expect((await FILES.list({ prefix: 'review-logs/haihua/' })).objects).toEqual([]);
  });

  it('删除期间已开始的导入在上传结束后仍会清理新建的 R2 对象', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua');
    let releaseUpload!: () => void;
    let markUploadStarted!: () => void;
    let uploadedObjectKey = '';
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    const uploadRelease = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const putSpy = vi.spyOn(FILES, 'put').mockImplementationOnce(async (key, value, options) => {
      uploadedObjectKey = String(key);
      markUploadStarted();
      await uploadRelease;
      putSpy.mockRestore();
      return FILES.put(key, value, options);
    });
    const ingestion = ingestReviewForProject(
      { id: projectId, slug: 'haihua' },
      ingestInput('haihua/in-flight.md', '删除中的导入'),
    );
    const rejectedIngestion = expect(ingestion).rejects.toThrow('日志未写入');

    await uploadStarted;
    const disabled = await updateProjectStatus(
      jsonRequest(`/api/admin/projects/${projectId}/status`, 'PATCH', { enabled: false }),
      context(projectId),
    );
    const deleted = await deleteProject(
      jsonRequest(`/api/admin/projects/${projectId}/deletion`, 'DELETE', { projectName: '海华项目' }),
      context(projectId),
    );
    releaseUpload();

    expect(disabled.status).toBe(200);
    expect(deleted.status).toBe(200);
    await rejectedIngestion;
    expect(uploadedObjectKey).toMatch(/^review-logs\/haihua\//);
    expect(await FILES.head(uploadedObjectKey)).toBeNull();
    expect(await count('review_object_cleanup_queue', 'object_key = ?', uploadedObjectKey)).toBe(0);
  });

  it('删除锁与资料编辑并发时不会改名或记录成功审计', async () => {
    const projectId = await createProjectAndId('海华项目', 'haihua');
    await DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id = ?').bind(projectId).run();
    const originalBatch = DB.batch.bind(DB);
    const batchSpy = vi.spyOn(DB, 'batch').mockImplementationOnce(async (statements) => {
      await DB.prepare(
        `INSERT INTO project_deletion_operations
           (project_id, project_slug_snapshot, project_name_snapshot,
            project_snapshot_json, started_at)
         VALUES (?, 'haihua', '海华项目', '{}', '2026-09-05T00:00:00.000Z')`,
      ).bind(projectId).run();
      batchSpy.mockRestore();
      return originalBatch(statements);
    });

    const response = await updateProject(
      jsonRequest(`/api/admin/projects/${projectId}`, 'PATCH', {
        name: '删除中改名', description: '',
      }),
      context(projectId),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'project_deletion_in_progress' });
    expect(await projectRow(projectId)).toMatchObject({ name: '海华项目' });
    expect(await count(
      'project_admin_audits',
      "project_id_snapshot = ? AND action = 'project.update' AND result = 'success'",
      projectId,
    )).toBe(0);
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
    const copiedKey = await copyProjectSyncKey(
      new Request(`https://example.test/api/admin/projects/${seeded.projectId}/sync-key/copy`, { method: 'POST' }),
      context(seeded.projectId),
    );
    const rotatedKey = await rotateProjectSyncKey(
      new Request(`https://example.test/api/admin/projects/${seeded.projectId}/sync-key/rotate`, { method: 'POST' }),
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
    expect(copiedKey.status).toBe(409);
    expect(await copiedKey.json()).toMatchObject({ code: 'project_deletion_in_progress' });
    expect(rotatedKey.status).toBe(409);
    expect(await rotatedKey.json()).toMatchObject({ code: 'project_deletion_in_progress' });
    expect(retried.status).toBe(200);
    expect(await projectRow(seeded.projectId)).toBeNull();
    expect((await FILES.list({ prefix: 'review-logs/haihua/' })).objects).toEqual([]);
    expect((await deleteAudits()).map((entry) => [entry.result, entry.failureCode])).toEqual([
      ['success', null],
      ['failure', 'project_object_cleanup_failed'],
    ]);
  });
});

async function seedDeletionProject(
  options: { projectIdOutsideReviewSequence?: boolean } = {},
): Promise<{
  projectId: number;
  otherProjectId: number;
  reviewIds: number[];
}> {
  let projectId = await createProjectAndId('海华项目', 'haihua');
  const otherProjectId = await createProjectAndId('财务项目', 'finance');
  if (options.projectIdOutsideReviewSequence) {
    const movedProjectId = projectId + 1_000_000;
    await DB.prepare('UPDATE review_projects SET id = ? WHERE id = ?')
      .bind(movedProjectId, projectId).run();
    projectId = movedProjectId;
  }
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

function deletionOperationInsert(projectId: number, slug: string, name: string): D1PreparedStatement {
  return DB.prepare(
    `INSERT INTO project_deletion_operations
       (project_id, project_slug_snapshot, project_name_snapshot,
        project_snapshot_json, started_at)
     VALUES (?, ?, ?, '{}', '2026-09-05T00:00:00.000Z')`,
  ).bind(projectId, slug, name);
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

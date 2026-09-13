/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';

const user = { userId: 'admin-1', displayName: '管理员', email: 'admin@example.com', fullName: '管理员' };
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: vi.fn(async () => user) }));

import { POST as archive } from '@/app/api/reviews/archive/route';
import { archiveReviewsForProject } from '@/lib/project-review-archive';
import { POST as restore } from '@/app/api/reviews/restore/route';
import { restoreReviewsForProject } from '@/lib/project-review-restore';
import { ingestReview } from '@/lib/reviews';

const DB = (env as { DB: D1Database }).DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM archive_operation_previews'), DB.prepare('DELETE FROM admin_users'),
    DB.prepare('DELETE FROM project_deletion_operations'),
    DB.prepare("UPDATE review_projects SET enabled = 1 WHERE slug = 'zherp'"),
    DB.prepare('DELETE FROM review_issue_events'), DB.prepare('DELETE FROM review_issues'),
    DB.prepare('DELETE FROM review_revisions'), DB.prepare('DELETE FROM review_logs'), DB.prepare('DELETE FROM review_search'),
  ]);
  await ingestReview({
    markdown: '# 归档日志\n日期：2026-08-27\n审查范围：共 0 个 revision，实际审查 0 个，跳过 0 个\n总体结论：无问题\n',
    sourceKey: 'archive-test', sourceName: 'archive.md', importedBy: 'test', syncMode: 'automation',
  });
});

it('预览令牌确认归档并可恢复', async () => {
  const review = await DB.prepare('SELECT id FROM review_logs LIMIT 1').first<{ id: number }>();
  const preview = await archive(new Request('https://review.test', {
    method: 'POST', body: JSON.stringify({ mode: 'preview', ids: [review!.id] }),
  }));
  expect(preview.status).toBe(200);
  const { previewToken, reviewCount } = await preview.json() as { previewToken: string; reviewCount: number };
  expect(reviewCount).toBe(1);
  const confirmed = await archive(new Request('https://review.test', {
    method: 'POST', body: JSON.stringify({ mode: 'confirm', previewToken }),
  }));
  expect(confirmed.status).toBe(200);
  expect((await DB.prepare('SELECT archived_at AS archivedAt FROM review_logs WHERE id = ?').bind(review!.id).first<{ archivedAt: string | null }>())?.archivedAt).not.toBeNull();
  const restored = await restore(new Request('https://review.test', { method: 'POST', body: JSON.stringify({ ids: [review!.id] }) }));
  expect(restored.status).toBe(200);
});

it('确认时范围变化返回 409', async () => {
  const review = await DB.prepare('SELECT id FROM review_logs LIMIT 1').first<{ id: number }>();
  const preview = await archive(new Request('https://review.test', { method: 'POST', body: JSON.stringify({ mode: 'preview', ids: [review!.id] }) }));
  const { previewToken } = await preview.json() as { previewToken: string };
  await DB.prepare('UPDATE review_logs SET archived_at = ? WHERE id = ?').bind(new Date().toISOString(), review!.id).run();
  const confirmed = await archive(new Request('https://review.test', { method: 'POST', body: JSON.stringify({ mode: 'confirm', previewToken }) }));
  expect(confirmed.status).toBe(409);
});

it('项目删除已开始时不再创建归档预览', async () => {
  const project = await DB.prepare(
    "SELECT id, slug FROM review_projects WHERE slug = 'zherp'",
  ).first<{ id: number; slug: string }>();
  const review = await DB.prepare('SELECT id FROM review_logs LIMIT 1').first<{ id: number }>();
  await startProjectDeletion(project!);

  const response = await archiveReviewsForProject(new Request('https://review.test', {
    method: 'POST', body: JSON.stringify({ mode: 'preview', ids: [review!.id] }),
  }), project!);

  expect(response.status).toBe(409);
  expect(await DB.prepare('SELECT COUNT(*) AS count FROM archive_operation_previews')
    .first<{ count: number }>()).toMatchObject({ count: 0 });
});

it('项目删除在预览后开始时不再确认归档', async () => {
  const project = await DB.prepare(
    "SELECT id, slug FROM review_projects WHERE slug = 'zherp'",
  ).first<{ id: number; slug: string }>();
  const review = await DB.prepare('SELECT id FROM review_logs LIMIT 1').first<{ id: number }>();
  const preview = await archive(new Request('https://review.test', {
    method: 'POST', body: JSON.stringify({ mode: 'preview', ids: [review!.id] }),
  }));
  const { previewToken } = await preview.json() as { previewToken: string };
  await startProjectDeletion(project!);

  const response = await archiveReviewsForProject(new Request('https://review.test', {
    method: 'POST', body: JSON.stringify({ mode: 'confirm', previewToken }),
  }), project!);

  expect(response.status).toBe(409);
  expect(await DB.prepare('SELECT archived_at AS archivedAt FROM review_logs WHERE id = ?')
    .bind(review!.id).first<{ archivedAt: string | null }>()).toMatchObject({ archivedAt: null });
});

it('项目删除已开始时不再恢复归档日志', async () => {
  const project = await DB.prepare(
    "SELECT id, slug FROM review_projects WHERE slug = 'zherp'",
  ).first<{ id: number; slug: string }>();
  const review = await DB.prepare('SELECT id FROM review_logs LIMIT 1').first<{ id: number }>();
  await DB.prepare('UPDATE review_logs SET archived_at = ? WHERE id = ?')
    .bind('2026-09-05T00:00:00.000Z', review!.id).run();
  await startProjectDeletion(project!);

  const response = await restoreReviewsForProject(new Request('https://review.test', {
    method: 'POST', body: JSON.stringify({ ids: [review!.id] }),
  }), project!);

  expect(response.status).toBe(409);
  expect(await DB.prepare('SELECT archived_at AS archivedAt FROM review_logs WHERE id = ?')
    .bind(review!.id).first<{ archivedAt: string | null }>()).toMatchObject({
      archivedAt: '2026-09-05T00:00:00.000Z',
    });
});

async function startProjectDeletion(project: { id: number; slug: string }): Promise<void> {
  await DB.batch([
    DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id = ?').bind(project.id),
    DB.prepare(
      `INSERT INTO project_deletion_operations
         (project_id, project_slug_snapshot, project_name_snapshot,
          project_snapshot_json, started_at)
       SELECT id, slug, name, '{}', '2026-09-05T00:00:00.000Z'
       FROM review_projects WHERE id = ?`,
    ).bind(project.id),
  ]);
}

/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGPTUser } from '../app/chatgpt-auth';

let currentUser: ChatGPTUser | null = null;
vi.mock('../app/chatgpt-auth', () => ({
  getChatGPTUser: vi.fn(async () => currentUser),
}));
import { GET as getProjectIssues } from '../app/api/projects/[slug]/issues/route';
import { GET as getProjectRaw } from '../app/api/projects/[slug]/reviews/[id]/raw/route';
import { GET as getProjectReviews } from '../app/api/projects/[slug]/reviews/route';
import { ensureReviewSchema } from '../lib/reviews';

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
};

const { DB, FILES } = env as unknown as TestEnv;

describe.sequential('审查项目公开浏览 API', () => {
  beforeAll(async () => {
    await ensureReviewSchema();
  });

  beforeEach(async () => {
    currentUser = null;
    await DB.batch([
      DB.prepare('DELETE FROM admin_users'),
      DB.prepare('DELETE FROM review_issue_events'),
      DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'),
      DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
      DB.prepare('DELETE FROM review_projects WHERE id <> 1'),
      DB.prepare("UPDATE review_projects SET enabled = 1 WHERE id = 1"),
      DB.prepare("INSERT INTO review_projects (id, name, slug, description, display_order, enabled) VALUES (2, '海华项目', 'haihua', '', 10, 1)"),
      DB.prepare("INSERT INTO review_projects (id, name, slug, description, display_order, enabled) VALUES (3, '停用项目', 'disabled', '', 20, 0)"),
      DB.prepare("INSERT INTO admin_users (user_id, email, display_name, created_at) VALUES ('admin-1', 'admin@example.com', '管理员', '2026-09-01T00:00:00.000Z')"),
    ]);
    await DB.batch([
      reviewInsert(1, 1, 'ZHERP 日志', 'review-logs/zherp.md'),
      reviewInsert(2, 2, '海华日志', 'review-logs/haihua.md'),
      reviewInsert(3, 3, '停用日志', 'review-logs/disabled.md'),
      DB.prepare(
        `INSERT INTO review_issues
          (id, review_id, issue_key, severity, title, related_revisions, detail, status, source_current, version)
         VALUES (1, 1, 'zherp-issue', 'P1', 'ZHERP 问题', '1', '', 'open', 1, 0),
                (2, 2, 'haihua-issue', 'P2', '海华问题', '2', '', 'open', 1, 0),
                (3, 3, 'disabled-issue', 'P1', '停用问题', '3', '', 'open', 1, 0)`,
      ),
    ]);
    await FILES.put('review-logs/zherp.md', '# ZHERP 原文');
    await FILES.put('review-logs/haihua.md', '# 海华原文');
    await FILES.put('review-logs/disabled.md', '# 停用原文');
  });

  it('只返回当前启用项目的数据，并隐藏未知、停用和跨项目对象', async () => {
    const projectReviews = await getProjectReviews(
      new Request('https://example.test/api/projects/haihua/reviews?scope=active'),
      { params: Promise.resolve({ slug: 'haihua' }) },
    );
    const projectIssues = await getProjectIssues(
      new Request('https://example.test/api/projects/haihua/issues?scope=active'),
      { params: Promise.resolve({ slug: 'haihua' }) },
    );
    const ownRaw = await getProjectRaw(
      new Request('https://example.test/api/projects/haihua/reviews/2/raw'),
      { params: Promise.resolve({ slug: 'haihua', id: '2' }) },
    );
    const crossProjectRaw = await getProjectRaw(
      new Request('https://example.test/api/projects/haihua/reviews/1/raw'),
      { params: Promise.resolve({ slug: 'haihua', id: '1' }) },
    );
    const disabled = await getProjectReviews(
      new Request('https://example.test/api/projects/disabled/reviews'),
      { params: Promise.resolve({ slug: 'disabled' }) },
    );
    const disabledRaw = await getProjectRaw(
      new Request('https://example.test/api/projects/disabled/reviews/3/raw'),
      { params: Promise.resolve({ slug: 'disabled', id: '3' }) },
    );
    const missing = await getProjectReviews(
      new Request('https://example.test/api/projects/missing/reviews'),
      { params: Promise.resolve({ slug: 'missing' }) },
    );

    expect((await projectReviews.json() as { items: Array<{ id: number }> }).items.map((item) => item.id)).toEqual([2]);
    expect((await projectIssues.json() as { items: Array<{ id: number }> }).items.map((item) => item.id)).toEqual([2]);
    expect(await ownRaw.text()).toBe('# 海华原文');
    expect(crossProjectRaw.status).toBe(404);
    expect(disabled.status).toBe(404);
    expect(disabledRaw.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it('全局管理员仍可读取停用项目的日志、问题和原文', async () => {
    currentUser = {
      userId: 'admin-1', email: 'admin@example.com', displayName: '管理员', fullName: '管理员',
    };

    const reviews = await getProjectReviews(
      new Request('https://example.test/api/projects/disabled/reviews?scope=active'),
      { params: Promise.resolve({ slug: 'disabled' }) },
    );
    const issues = await getProjectIssues(
      new Request('https://example.test/api/projects/disabled/issues?scope=active'),
      { params: Promise.resolve({ slug: 'disabled' }) },
    );
    const raw = await getProjectRaw(
      new Request('https://example.test/api/projects/disabled/reviews/3/raw'),
      { params: Promise.resolve({ slug: 'disabled', id: '3' }) },
    );

    expect(reviews.status).toBe(200);
    expect((await reviews.json() as { items: Array<{ id: number }> }).items).toMatchObject([{ id: 3 }]);
    expect(issues.status).toBe(200);
    expect((await issues.json() as { items: Array<{ id: number }> }).items).toMatchObject([{ id: 3 }]);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe('# 停用原文');
  });
});

function reviewInsert(id: number, projectId: number, title: string, objectKey: string): D1PreparedStatement {
  return DB.prepare(
    `INSERT INTO review_logs (
       id, project_id, log_date, source_key, source_name, source_hash, content_object_key,
       title, overview, scope_text, revision_count, reviewed_count, skipped_count,
       p1_count, p2_count, p3_count, sync_mode, imported_by, imported_at, updated_at
     ) VALUES (?, ?, '2026-08-31', ?, ?, ?, ?, ?, '', '', 1, 1, 0, 0, 0, 0,
               'automation', 'test', '2026-08-31T10:00:00.000Z', '2026-08-31T10:00:00.000Z')`,
  ).bind(id, projectId, `source-${id}`, `review-${id}.md`, `hash-${id}`, objectKey, title);
}

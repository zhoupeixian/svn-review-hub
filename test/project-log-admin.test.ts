/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx-js-style';

const admin = {
  userId: 'admin-project-log',
  displayName: '全局管理员',
  email: 'admin@example.com',
  fullName: '全局管理员',
};
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: vi.fn(async () => admin),
}));

import { POST as uploadProjectReview } from '@/app/api/projects/[slug]/reviews/route';
import { POST as archiveProjectReviews } from '@/app/api/projects/[slug]/reviews/archive/route';
import { POST as restoreProjectReviews } from '@/app/api/projects/[slug]/reviews/restore/route';
import { GET as exportProjectReviews } from '@/app/api/projects/[slug]/reviews/export/route';
import { GET as exportProjectIssues } from '@/app/api/projects/[slug]/issues/export/route';
import { GET as downloadProjectReview } from '@/app/api/projects/[slug]/reviews/[id]/raw/route';
import { ensureReviewSchema } from '@/lib/reviews';

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
};

const { DB, FILES } = env as unknown as TestEnv;

describe.sequential('按审查项目管理日志', () => {
  beforeAll(async () => {
    await ensureReviewSchema();
  });

  beforeEach(async () => {
    await DB.batch([
      DB.prepare('DELETE FROM archive_operation_previews'),
      DB.prepare('DELETE FROM admin_users'),
      DB.prepare('DELETE FROM review_issue_events'),
      DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'),
      DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
      DB.prepare('DELETE FROM review_projects WHERE id <> 1'),
      DB.prepare(
        `INSERT INTO review_projects (
           id, name, slug, description, display_order, enabled
         ) VALUES (2, '海华项目', 'haihua', '', 10, 1)`,
      ),
    ]);
  });

  it('相同文件名、来源路径和 Revision 的手工上传固定写入各自项目', async () => {
    const zherp = await uploadProjectReview(uploadRequest(), {
      params: Promise.resolve({ slug: 'zherp' }),
    });
    const haihua = await uploadProjectReview(uploadRequest(), {
      params: Promise.resolve({ slug: 'haihua' }),
    });

    expect(zherp.status).toBe(201);
    expect(haihua.status).toBe(201);
    const logs = await DB.prepare(
      `SELECT p.slug, l.source_key AS sourceKey,
              l.content_object_key AS contentObjectKey
       FROM review_logs l
       JOIN review_projects p ON p.id = l.project_id
       ORDER BY p.slug`,
    ).all<{ slug: string; sourceKey: string; contentObjectKey: string }>();
    expect(logs.results).toEqual([
      {
        slug: 'haihua',
        sourceKey: 'manual/daily.md',
        contentObjectKey: expect.stringContaining('review-logs/haihua/'),
      },
      {
        slug: 'zherp',
        sourceKey: 'manual/daily.md',
        contentObjectKey: expect.stringContaining('review-logs/zherp/'),
      },
    ]);
    expect(logs.results[0].contentObjectKey).not.toBe(logs.results[1].contentObjectKey);
    await expect(FILES.get(logs.results[0].contentObjectKey)).resolves.not.toBeNull();
    await expect(FILES.get(logs.results[1].contentObjectKey)).resolves.not.toBeNull();
  });

  it('归档预览、确认和恢复拒绝其他项目的日志与令牌', async () => {
    await uploadProjectReview(uploadRequest(), {
      params: Promise.resolve({ slug: 'zherp' }),
    });
    await uploadProjectReview(uploadRequest(), {
      params: Promise.resolve({ slug: 'haihua' }),
    });
    const zherpId = await reviewId('zherp');
    const haihuaId = await reviewId('haihua');

    const crossPreview = await archiveProjectReviews(
      jsonRequest({ mode: 'preview', ids: [haihuaId] }),
      { params: Promise.resolve({ slug: 'zherp' }) },
    );
    expect(crossPreview.status).toBe(404);

    const preview = await archiveProjectReviews(
      jsonRequest({ mode: 'preview', ids: [haihuaId] }),
      { params: Promise.resolve({ slug: 'haihua' }) },
    );
    expect(preview.status).toBe(200);
    const { previewToken } = await preview.json() as { previewToken: string };

    const crossConfirm = await archiveProjectReviews(
      jsonRequest({ mode: 'confirm', previewToken }),
      { params: Promise.resolve({ slug: 'zherp' }) },
    );
    expect(crossConfirm.status).toBe(404);
    expect(await archivedAt(zherpId)).toBeNull();
    expect(await archivedAt(haihuaId)).toBeNull();

    const confirmed = await archiveProjectReviews(
      jsonRequest({ mode: 'confirm', previewToken }),
      { params: Promise.resolve({ slug: 'haihua' }) },
    );
    expect(confirmed.status).toBe(200);
    expect(await archivedAt(zherpId)).toBeNull();
    expect(await archivedAt(haihuaId)).not.toBeNull();

    const crossRestore = await restoreProjectReviews(
      jsonRequest({ ids: [haihuaId] }),
      { params: Promise.resolve({ slug: 'zherp' }) },
    );
    expect(crossRestore.status).toBe(404);
    expect(await archivedAt(haihuaId)).not.toBeNull();

    const restored = await restoreProjectReviews(
      jsonRequest({ ids: [haihuaId] }),
      { params: Promise.resolve({ slug: 'haihua' }) },
    );
    expect(restored.status).toBe(200);
    expect(await archivedAt(haihuaId)).toBeNull();
  });

  it('导出和原始日志下载只返回当前项目并在文件名与链接中包含项目标识', async () => {
    await uploadProjectReview(uploadRequest(), {
      params: Promise.resolve({ slug: 'zherp' }),
    });
    await uploadProjectReview(uploadRequest(), {
      params: Promise.resolve({ slug: 'haihua' }),
    });
    const zherpId = await reviewId('zherp');
    const haihuaId = await reviewId('haihua');
    const haihuaIssueId = await issueId('haihua');

    const reviews = await exportProjectReviews(
      new Request('https://review.test/api/projects/haihua/reviews/export'),
      { params: Promise.resolve({ slug: 'haihua' }) },
    );
    expect(reviews.status).toBe(200);
    expect(reviews.headers.get('content-disposition')).toContain('haihua');
    const csv = await reviews.text();
    expect(csv).toContain(`/projects/haihua/reviews/${haihuaId}`);
    expect(csv).not.toContain(`/projects/zherp/reviews/${zherpId}`);

    const issues = await exportProjectIssues(
      new Request('https://review.test/api/projects/haihua/issues/export'),
      { params: Promise.resolve({ slug: 'haihua' }) },
    );
    expect(issues.status).toBe(200);
    expect(issues.headers.get('content-disposition')).toContain('haihua');
    const workbook = XLSX.read(await issues.arrayBuffer(), { type: 'array' });
    const sheet = workbook.Sheets['问题跟进'];
    expect(sheet.J2.l?.Target).toBe(
      `https://review.test/projects/haihua/reviews/${haihuaId}#issue-${haihuaIssueId}`,
    );

    const ownRaw = await downloadProjectReview(
      new Request('https://review.test'),
      { params: Promise.resolve({ slug: 'haihua', id: String(haihuaId) }) },
    );
    expect(ownRaw.status).toBe(200);
    expect(ownRaw.headers.get('content-disposition')).toContain('haihua-daily.md');

    const crossRaw = await downloadProjectReview(
      new Request('https://review.test'),
      { params: Promise.resolve({ slug: 'haihua', id: String(zherpId) }) },
    );
    expect(crossRaw.status).toBe(404);
  });
});

function jsonRequest(body: unknown): Request {
  return new Request('https://review.test/api/projects/project/reviews/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function reviewId(slug: string): Promise<number> {
  const review = await DB.prepare(
    `SELECT l.id
     FROM review_logs l
     JOIN review_projects p ON p.id = l.project_id
     WHERE p.slug = ?`,
  ).bind(slug).first<{ id: number }>();
  if (!review) throw new Error(`测试项目 ${slug} 没有日志。`);
  return review.id;
}

async function issueId(slug: string): Promise<number> {
  const issue = await DB.prepare(
    `SELECT i.id
     FROM review_issues i
     JOIN review_logs l ON l.id = i.review_id
     JOIN review_projects p ON p.id = l.project_id
     WHERE p.slug = ?`,
  ).bind(slug).first<{ id: number }>();
  if (!issue) throw new Error(`测试项目 ${slug} 没有问题。`);
  return issue.id;
}

async function archivedAt(id: number): Promise<string | null> {
  const review = await DB.prepare(
    'SELECT archived_at AS archivedAt FROM review_logs WHERE id = ?',
  ).bind(id).first<{ archivedAt: string | null }>();
  return review?.archivedAt ?? null;
}

function uploadRequest(): Request {
  const form = new FormData();
  form.append('file', new File([reviewMarkdown()], 'daily.md', {
    type: 'text/markdown',
  }));
  return new Request('https://review.test/api/projects/project/reviews', {
    method: 'POST',
    body: form,
  });
}

function reviewMarkdown(): string {
  return `# 项目手工日志
日期：2026-09-01
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个
总体结论：发现 1 个 P1

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 56000 | alice | 2026-09-01 09:00 | 相同提交 | 已审查 |

### P1

#### 相同项目问题
相关 revision：56000

两个项目内容相同的问题。
`;
}

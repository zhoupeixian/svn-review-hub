/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: vi.fn() }));

import { POST as importReview } from '@/app/api/reviews/route';
import {
  authorizeProjectSync,
  encryptProjectSyncKey,
  ensureReviewSchema,
  ingestReviewForProject,
} from '@/lib/reviews';

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  REVIEW_SYNC_KEY?: string;
  REVIEW_SYNC_MASTER_KEY?: string;
};

const runtime = env as unknown as TestEnv;
const DB = runtime.DB;
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ZHERP_KEY = 'legacy-zherp-secret';
const HAIHUA_KEY = 'haihua-project-secret';

describe.sequential('按项目同步日志', () => {
  beforeAll(async () => {
    runtime.REVIEW_SYNC_MASTER_KEY = MASTER_KEY;
    runtime.REVIEW_SYNC_KEY = ZHERP_KEY;
    await ensureReviewSchema();
  });

  beforeEach(async () => {
    await DB.batch([
      DB.prepare('DELETE FROM review_issue_events'),
      DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'),
      DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
      DB.prepare('DELETE FROM review_projects WHERE id <> 1'),
      DB.prepare('UPDATE review_projects SET enabled = 1 WHERE id = 1'),
    ]);
    let cursor: string | undefined;
    do {
      const page = await runtime.FILES.list({ cursor });
      await Promise.all(page.objects.map((object) => runtime.FILES.delete(object.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  });

  it('只迁移一次旧全站密钥，D1 不保存明文且移除旧环境变量后仍可鉴权', async () => {
    const stored = await DB.prepare(
      'SELECT sync_key_encrypted AS encrypted FROM review_projects WHERE id = 1',
    ).first<{ encrypted: string | null }>();

    expect(stored?.encrypted).toMatch(/^v1\./);
    expect(stored?.encrypted).not.toContain(ZHERP_KEY);
    runtime.REVIEW_SYNC_KEY = undefined;
    await expect(authorizeProjectSync('zherp', ZHERP_KEY)).resolves.toMatchObject({
      id: 1,
      slug: 'zherp',
    });
    await expect(authorizeProjectSync('zherp', 'wrong-key')).resolves.toBeNull();

    const before = stored?.encrypted;
    runtime.REVIEW_SYNC_KEY = 'must-not-overwrite-ciphertext';
    await ensureReviewSchema();
    const after = await DB.prepare(
      'SELECT sync_key_encrypted AS encrypted FROM review_projects WHERE id = 1',
    ).first<{ encrypted: string | null }>();
    expect(after?.encrypted).toBe(before);
  });

  it('相同来源、Revision 和文件名按项目鉴权并隔离 D1/R2', async () => {
    await DB.prepare(
      `INSERT INTO review_projects (
         id, name, slug, description, display_order, enabled, sync_key_encrypted
       ) VALUES (2, '海华项目', 'haihua', '', 10, 1, ?)`,
    )
      .bind(await encryptProjectSyncKey({ id: 2, slug: 'haihua' }, HAIHUA_KEY))
      .run();

    const zherp = await importReview(syncRequest('zherp', ZHERP_KEY));
    const haihua = await importReview(syncRequest('haihua', HAIHUA_KEY));
    expect(zherp.status).toBe(201);
    expect(haihua.status).toBe(201);

    const rows = await DB.prepare(
      `SELECT project_id AS projectId, source_key AS sourceKey,
              content_object_key AS contentObjectKey
       FROM review_logs ORDER BY project_id`,
    ).all<{ projectId: number; sourceKey: string; contentObjectKey: string }>();
    expect(rows.results).toEqual([
      expect.objectContaining({
        projectId: 1,
        sourceKey: '2026-08-31/svn审查日志-2026-08-31.md',
        contentObjectKey: expect.stringContaining('review-logs/zherp/2026-08-31/'),
      }),
      expect.objectContaining({
        projectId: 2,
        sourceKey: '2026-08-31/svn审查日志-2026-08-31.md',
        contentObjectKey: expect.stringContaining('review-logs/haihua/2026-08-31/'),
      }),
    ]);
    expect(
      await DB.prepare(
        `SELECT p.slug, r.revision
         FROM review_revisions r
         JOIN review_logs l ON l.id = r.review_id
         JOIN review_projects p ON p.id = l.project_id
         ORDER BY p.id`,
      ).all(),
    ).toMatchObject({
      results: [
        { slug: 'zherp', revision: 54000 },
        { slug: 'haihua', revision: 54000 },
      ],
    });
    const issueRows = await DB.prepare(
      `SELECT p.slug, i.title
       FROM review_issues i
       JOIN review_logs l ON l.id = i.review_id
       JOIN review_projects p ON p.id = l.project_id
       ORDER BY p.id`,
    ).all();
    expect(issueRows.results).toEqual([
      { slug: 'zherp', title: '项目隔离问题' },
      { slug: 'haihua', title: '项目隔离问题' },
    ]);

    const objects = await runtime.FILES.list({ prefix: 'review-logs/' });
    expect(objects.objects.map((object) => object.key).sort()).toEqual(
      rows.results.map((row) => row.contentObjectKey).sort(),
    );
    expect(new Set(objects.objects.map((object) => object.key)).size).toBe(2);
    await expect(runtime.FILES.get(rows.results[0].contentObjectKey).then((object) => object?.text())).resolves.toContain('项目隔离问题');
    await expect(runtime.FILES.get(rows.results[1].contentObjectKey).then((object) => object?.text())).resolves.toContain('项目隔离问题');
  });

  it('导入函数拒绝不属于同一项目的 id 和 slug 组合且不写入 D1/R2', async () => {
    await expect(ingestReviewForProject(
      { id: 1, slug: 'not-zherp' },
      {
        markdown: reviewMarkdown(),
        sourceKey: 'mismatched-project',
        sourceName: 'mismatch.md',
        importedBy: 'test',
        syncMode: 'automation',
      },
    )).rejects.toThrow('项目标识不匹配');
    expect(await DB.prepare('SELECT COUNT(*) AS count FROM review_logs').first()).toEqual({ count: 0 });
    expect((await runtime.FILES.list()).objects).toEqual([]);
  });

  it('缺少项目返回 400，未知、停用或密钥错误统一返回 401 且不写入', async () => {
    await DB.prepare(
      `INSERT INTO review_projects (
         id, name, slug, description, display_order, enabled, sync_key_encrypted
       ) VALUES (2, '停用项目', 'disabled', '', 10, 0, ?)`,
    )
      .bind(await encryptProjectSyncKey({ id: 2, slug: 'disabled' }, HAIHUA_KEY))
      .run();

    const missingProject = await importReview(syncRequest(undefined, ZHERP_KEY));
    const unknownProject = await importReview(syncRequest('missing', ZHERP_KEY));
    const disabledProject = await importReview(syncRequest('disabled', HAIHUA_KEY));
    const wrongKey = await importReview(syncRequest('zherp', 'wrong-key'));

    expect(missingProject.status).toBe(400);
    expect(unknownProject.status).toBe(401);
    expect(disabledProject.status).toBe(401);
    expect(wrongKey.status).toBe(401);
    expect(await unknownProject.json()).toEqual(await disabledProject.json());
    expect(await wrongKey.json()).toEqual({ error: '项目或项目同步密钥无效。' });
    expect(await DB.prepare('SELECT COUNT(*) AS count FROM review_logs').first()).toEqual({ count: 0 });

    await DB.prepare("UPDATE review_projects SET enabled = 1 WHERE slug = 'disabled'").run();
    const restoredProject = await importReview(syncRequest('disabled', HAIHUA_KEY));
    expect(restoredProject.status).toBe(201);
    expect(await DB.prepare('SELECT COUNT(*) AS count FROM review_logs').first()).toEqual({ count: 1 });
    expect((await runtime.FILES.list({ prefix: 'review-logs/disabled/' })).objects).toHaveLength(1);
  });

  it('导入通过入口校验后项目被并发停用时不提交 D1 并清理新 R2 对象', async () => {
    const batch = DB.batch.bind(DB);
    vi.spyOn(DB, 'batch').mockImplementationOnce(async (statements) => {
      await DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id = 1').run();
      return batch(statements);
    });

    await expect(ingestReviewForProject(
      { id: 1, slug: 'zherp' },
      {
        markdown: reviewMarkdown(),
        sourceKey: 'concurrent-disable',
        sourceName: 'concurrent-disable.md',
        importedBy: 'test',
        syncMode: 'automation',
      },
    )).rejects.toThrow('已停用');
    expect(await DB.prepare('SELECT COUNT(*) AS count FROM review_logs').first()).toEqual({ count: 0 });
    expect((await runtime.FILES.list({ prefix: 'review-logs/zherp/' })).objects).toEqual([]);
  });

  it('相同内容的并发胜者已提交时失败导入不删除其共享 R2 对象', async () => {
    const winner = await ingestReviewForProject(
      { id: 1, slug: 'zherp' },
      {
        markdown: reviewMarkdown(),
        sourceKey: 'winner',
        sourceName: 'winner.md',
        importedBy: 'test',
        syncMode: 'automation',
      },
    );
    const stored = await DB.prepare(
      'SELECT content_object_key AS objectKey FROM review_logs WHERE id = ?',
    ).bind(winner.id).first<{ objectKey: string }>();
    vi.spyOn(runtime.FILES, 'head').mockResolvedValueOnce(null);
    const batch = DB.batch.bind(DB);
    vi.spyOn(DB, 'batch').mockImplementationOnce(async (statements) => {
      await DB.prepare('UPDATE review_projects SET enabled = 0 WHERE id = 1').run();
      return batch(statements);
    });

    await expect(ingestReviewForProject(
      { id: 1, slug: 'zherp' },
      {
        markdown: reviewMarkdown(),
        sourceKey: 'loser',
        sourceName: 'loser.md',
        importedBy: 'test',
        syncMode: 'automation',
      },
    )).rejects.toThrow('已停用');
    expect(await DB.prepare('SELECT COUNT(*) AS count FROM review_logs').first()).toEqual({ count: 1 });
    expect(stored?.objectKey).toBeTruthy();
    await expect(runtime.FILES.get(stored!.objectKey).then((object) => object?.text()))
      .resolves.toContain('项目隔离问题');
  });

  it('主密钥丢失或错误时拒绝解密，不使用旧全站密钥覆盖既有密文', async () => {
    const encryptedBefore = await DB.prepare(
      'SELECT sync_key_encrypted AS encrypted FROM review_projects WHERE id = 1',
    ).first<{ encrypted: string }>();
    try {
      runtime.REVIEW_SYNC_KEY = ZHERP_KEY;
      runtime.REVIEW_SYNC_MASTER_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

      await expect(authorizeProjectSync('zherp', ZHERP_KEY)).rejects.toThrow(
        '项目同步密钥无法解密',
      );
      const encryptedAfter = await DB.prepare(
        'SELECT sync_key_encrypted AS encrypted FROM review_projects WHERE id = 1',
      ).first<{ encrypted: string }>();
      expect(encryptedAfter?.encrypted).toBe(encryptedBefore?.encrypted);
    } finally {
      runtime.REVIEW_SYNC_MASTER_KEY = MASTER_KEY;
    }
  });
});

function syncRequest(projectSlug: string | undefined, key: string): Request {
  return new Request('https://review.test/api/reviews', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-review-sync-key': key,
    },
    body: JSON.stringify({
      projectSlug,
      markdown: reviewMarkdown(),
      sourceKey: '2026-08-31/svn审查日志-2026-08-31.md',
      sourceName: 'svn审查日志-2026-08-31.md',
    }),
  });
}

function reviewMarkdown(): string {
  return `# SVN 审查日志
日期：2026-08-31
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个

| Revision | 作者 | 提交说明 | 结果 |
| --- | --- | --- | --- |
| r54000 | alice | 项目隔离验证 | 已审查 |

总体结论：发现 1 个 P2。

### P2

#### 项目隔离问题
相关 revision：54000

两个项目应分别保存此问题。
`;
}

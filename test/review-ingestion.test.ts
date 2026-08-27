/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getIssuePage,
  ingestReview,
  isSyncRequestAuthorized,
} from '@/lib/reviews';

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  REVIEW_SYNC_KEY?: string;
};

type IssueRow = {
  id: number;
  issueKey: string;
  severity: string;
  title: string;
  relatedRevisions: string;
  detail: string;
  status: string;
  statusNote: string | null;
  statusUpdatedAt: string | null;
  sourceCurrent: number;
  version: number;
};

const runtime = env as unknown as TestEnv;
const { DB, FILES } = runtime;
const SOURCE_KEY = '2026-08-27/svn审查日志-2026-08-27.md';
const SYNC_KEY = 'workers-review-sync-key';

describe('审查日志合并导入', () => {
  beforeEach(async () => {
    await DB.batch([
      DB.prepare('DELETE FROM review_issue_events'),
      DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'),
      DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
    ]);
    await clearBucket();
    runtime.REVIEW_SYNC_KEY = SYNC_KEY;
  });

  it('重复导入同一问题时保留状态、说明、版本和事件，并更新源字段', async () => {
    await ingestReview(ingestInput(initialMarkdown()));
    const firstPass = await issueRows();
    const preserved = firstPass.find(
      (issue) => issue.title === 'Parameter Count Mismatch',
    );
    expect(firstPass).toHaveLength(2);
    expect(firstPass.map((issue) => issue.status)).toEqual(['open', 'open']);

    await DB.batch([
      DB.prepare(
        `UPDATE review_issues
         SET status = 'resolved', status_note = '已修复并验证',
             status_updated_at = '2026-08-27T10:00:00.000Z', version = 3
         WHERE id = ?`,
      ).bind(preserved!.id),
      DB.prepare(
        `INSERT INTO review_issue_events (
          issue_id, from_status, to_status, note, created_at
        ) VALUES (?, 'open', 'resolved', '已修复并验证',
                  '2026-08-27T10:00:00.000Z')`,
      ).bind(preserved!.id),
    ]);

    await ingestReview(ingestInput(formatVariantMarkdown()));

    const secondPass = await issueRows();
    const merged = secondPass.find(
      (issue) => issue.issueKey === 'p1:parameter-count-mismatch:100、101',
    );
    const events = await DB.prepare(
      'SELECT COUNT(*) AS count FROM review_issue_events WHERE issue_id = ?',
    )
      .bind(preserved!.id)
      .first<{ count: number }>();

    expect(secondPass).toHaveLength(2);
    expect(merged).toMatchObject({
      id: preserved!.id,
      severity: 'P1',
      title: 'parameter   count mismatch',
      relatedRevisions: '100、101',
      detail: expect.stringContaining('新版详情'),
      status: 'resolved',
      statusNote: '已修复并验证',
      statusUpdatedAt: '2026-08-27T10:00:00.000Z',
      sourceCurrent: 1,
      version: 3,
    });
    expect(events?.count).toBe(1);
  });

  it('源问题增删及重新出现时保留历史行，只让当前问题进入总览', async () => {
    await ingestReview(ingestInput(initialMarkdown()));
    const firstPass = await issueRows();
    const returning = firstPass.find(
      (issue) => issue.title === 'Legacy Authorization Reuse',
    )!;

    await DB.batch([
      DB.prepare(
        `UPDATE review_issues
         SET status = 'by_design', status_note = '符合现有权限模型', version = 2
         WHERE id = ?`,
      ).bind(returning.id),
      DB.prepare(
        `INSERT INTO review_issue_events (
          issue_id, from_status, to_status, note, created_at
        ) VALUES (?, 'open', 'by_design', '符合现有权限模型',
                  '2026-08-27T11:00:00.000Z')`,
      ).bind(returning.id),
    ]);

    const changed = await ingestReview(ingestInput(changedMarkdown()));
    const afterChange = await issueRows();
    const currentPage = await getIssuePage();
    expect(changed.ingestion).toEqual({
      createdIssueCount: 1,
      updatedIssueCount: 1,
      parsedIssueCount: 2,
    });
    expect(afterChange).toHaveLength(3);
    expect(afterChange.find((issue) => issue.id === returning.id)).toMatchObject({
      status: 'by_design',
      statusNote: '符合现有权限模型',
      sourceCurrent: 0,
      version: 2,
    });
    expect(
      afterChange.find((issue) => issue.title === 'Fresh Source Problem'),
    ).toMatchObject({
      status: 'open',
      statusNote: null,
      sourceCurrent: 1,
      version: 0,
    });
    expect(currentPage.items.map((issue) => issue.title).sort()).toEqual([
      'Fresh Source Problem',
      'Parameter Count Mismatch',
    ]);

    const reappeared = await ingestReview(ingestInput(reappearedMarkdown()));
    const afterReappeared = await issueRows();
    const restored = afterReappeared.find((issue) => issue.id === returning.id);
    const eventCount = await DB.prepare(
      'SELECT COUNT(*) AS count FROM review_issue_events WHERE issue_id = ?',
    )
      .bind(returning.id)
      .first<{ count: number }>();

    expect(reappeared.ingestion).toEqual({
      createdIssueCount: 0,
      updatedIssueCount: 2,
      parsedIssueCount: 2,
    });
    expect(afterReappeared).toHaveLength(3);
    expect(restored).toMatchObject({
      id: returning.id,
      status: 'by_design',
      statusNote: '符合现有权限模型',
      sourceCurrent: 1,
      version: 2,
    });
    expect(eventCount?.count).toBe(1);
  });

  it('不同标题或关联 Revision 生成不同稳定键，不会错误合并', async () => {
    await ingestReview(ingestInput(distinctIssuesMarkdown()));

    const issues = await issueRows();
    expect(issues.map((issue) => issue.issueKey).sort()).toEqual([
      'p2:another-title:200',
      'p2:same-title:200',
      'p2:same-title:201',
    ]);
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(3);
  });

  it('兼容 Task 2 已按旧 Revision 顺序回填的稳定键', async () => {
    await ingestReview(ingestInput(initialMarkdown()));
    const original = (await issueRows()).find(
      (issue) => issue.title === 'Parameter Count Mismatch',
    )!;
    await DB.prepare(
      `UPDATE review_issues
       SET issue_key = 'p1:parameter-count-mismatch:101、100',
           related_revisions = '101、100', status = 'resolved',
           status_note = '升级前已解决', version = 5
       WHERE id = ?`,
    )
      .bind(original.id)
      .run();

    await ingestReview(ingestInput(formatVariantMarkdown()));

    const matching = (await issueRows()).filter(
      (issue) => issue.title.toLowerCase().replace(/\s+/g, ' ') ===
        'parameter count mismatch',
    );
    expect(matching).toEqual([
      expect.objectContaining({
        id: original.id,
        issueKey: 'p1:parameter-count-mismatch:101、100',
        relatedRevisions: '100、101',
        status: 'resolved',
        statusNote: '升级前已解决',
        sourceCurrent: 1,
        version: 5,
      }),
    ]);
  });

  it('D1 导入中途失败时回滚日志、Revision 和问题，但保留先写成功的 R2 原文', async () => {
    await ingestReview(ingestInput(initialMarkdown()));
    const reviewBefore = await reviewStorageRow();
    const issuesBefore = await issueRows();
    const revisionsBefore = await revisionRows();
    const objectsBefore = await bucketKeys();

    await expect(
      ingestReview(ingestInput(failingMarkdownWithDuplicateRevision())),
    ).rejects.toThrow('D1 原子更新失败');

    expect(await reviewStorageRow()).toEqual(reviewBefore);
    expect(await issueRows()).toEqual(issuesBefore);
    expect(await revisionRows()).toEqual(revisionsBefore);
    const objectsAfter = await bucketKeys();
    expect(objectsAfter).toHaveLength(objectsBefore.length + 1);
    expect(objectsAfter).toEqual(
      expect.arrayContaining(objectsBefore),
    );
  });

  it('自动同步仅凭同步密钥即可重复导入，并返回兼容的导入计数', async () => {
    const request = syncRequest(initialMarkdown());
    expect(request.headers.has('cookie')).toBe(false);
    expect(isSyncRequestAuthorized(request)).toBe(true);

    const first = await ingestReview(ingestInput(initialMarkdown()));
    const second = await ingestReview(ingestInput(initialMarkdown()));

    expect(first).toMatchObject({
      logDate: '2026-08-27',
      ingestion: {
        createdIssueCount: 2,
        updatedIssueCount: 0,
        parsedIssueCount: 2,
      },
    });
    expect(second).toMatchObject({
      logDate: '2026-08-27',
      ingestion: {
        createdIssueCount: 0,
        updatedIssueCount: 2,
        parsedIssueCount: 2,
      },
    });

    expect(
      isSyncRequestAuthorized(
        new Request('https://review.test/api/reviews', { method: 'POST' }),
      ),
    ).toBe(false);
  });
});

function ingestInput(markdown: string) {
  return {
    markdown,
    sourceKey: SOURCE_KEY,
    sourceName: 'svn审查日志-2026-08-27.md',
    importedBy: 'Workers 集成测试',
    syncMode: 'automation' as const,
  };
}

function syncRequest(markdown: string): Request {
  return new Request('https://review.test/api/reviews', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-review-sync-key': SYNC_KEY,
    },
    body: JSON.stringify({
      markdown,
      sourceKey: SOURCE_KEY,
      sourceName: 'svn审查日志-2026-08-27.md',
    }),
  });
}

async function issueRows(): Promise<IssueRow[]> {
  const result = await DB.prepare(
    `SELECT id, issue_key AS issueKey, severity, title,
            related_revisions AS relatedRevisions, detail, status,
            status_note AS statusNote, status_updated_at AS statusUpdatedAt,
            source_current AS sourceCurrent, version
     FROM review_issues ORDER BY id`,
  ).all<IssueRow>();
  return result.results ?? [];
}

async function revisionRows() {
  const result = await DB.prepare(
    `SELECT revision, author, committed_at AS committedAt, description, conclusion
     FROM review_revisions ORDER BY revision`,
  ).all();
  return result.results ?? [];
}

async function reviewStorageRow() {
  return DB.prepare(
    `SELECT log_date AS logDate, source_hash AS sourceHash,
            content_object_key AS contentObjectKey, title, overview, updated_at AS updatedAt
     FROM review_logs WHERE source_key = ?`,
  )
    .bind(SOURCE_KEY)
    .first();
}

async function clearBucket(): Promise<void> {
  const keys = await bucketKeys();
  if (keys.length) await FILES.delete(keys);
}

async function bucketKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await FILES.list({ cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

function initialMarkdown(): string {
  return `# 初始审查日志
日期：2026-08-27
审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个
总体结论：保留 1 个 P1、1 个 P2

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 100 | alice | 2026-08-27 09:00 | 首次提交 | 已审查 |
| 101 | bob | 2026-08-27 09:30 | 后续提交 | 已审查 |

### P1

#### Parameter Count Mismatch
相关 revision：101、100

初始详情。

### P2

#### Legacy Authorization Reuse
相关 revision：102

权限复用详情。
`;
}

function formatVariantMarkdown(): string {
  return `# 格式变化后的审查日志
日期：2026-08-27
审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个
总体结论：保留 1 个 P1、1 个 P2

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 100 | changed-author | 2026-08-27 09:00 | 首次提交 | 已审查 |
| 101 | bob | 2026-08-27 09:30 | 后续提交 | 已审查 |

### p1

#### parameter   count mismatch
相关 revision：100, 101

新版详情，不能进入稳定键。

### p2

#### legacy authorization reuse
相关 revision：102

更新后的权限详情。
`;
}

function changedMarkdown(): string {
  return `# 增删问题后的审查日志
日期：2026-08-27
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个
总体结论：保留 1 个 P1、1 个 P3

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 100 | alice | 2026-08-27 09:00 | 首次提交 | 已审查 |

### P1

#### Parameter Count Mismatch
相关 revision：100、101

当前问题。

### P3

#### Fresh Source Problem
相关 revision：103

新增问题。
`;
}

function reappearedMarkdown(): string {
  return `# 问题重新出现的审查日志
日期：2026-08-27
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个
总体结论：保留 1 个 P2、1 个 P3

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 102 | carol | 2026-08-27 10:00 | 权限提交 | 已审查 |

### P2

#### Legacy Authorization Reuse
相关 revision：102

重新出现后的源详情。

### P3

#### Fresh Source Problem
相关 revision：103

仍然存在。
`;
}

function distinctIssuesMarkdown(): string {
  return `# 稳定键边界审查日志
日期：2026-08-27
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个
总体结论：保留 3 个 P2

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 200 | alice | 2026-08-27 09:00 | 边界提交 | 已审查 |

### P2

#### Same Title
相关 revision：200

第一项。

#### Same Title
相关 revision：201

第二项。

#### Another Title
相关 revision：200

第三项。
`;
}

function failingMarkdownWithDuplicateRevision(): string {
  return `# 不应提交的失败日志
日期：2026-08-27
审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个
总体结论：保留 1 个 P3

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 999 | alice | 2026-08-27 12:00 | 重复一 | 已审查 |
| 999 | bob | 2026-08-27 12:01 | 重复二 | 已审查 |

### P3

#### Only Failed Import Problem
相关 revision：999

该问题不得替换旧问题。
`;
}

/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { getSyncHealth, ingestReview, ingestReviewForProject } from '@/lib/reviews';

const DB = (env as { DB: D1Database }).DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM review_issue_events'), DB.prepare('DELETE FROM review_issues'),
    DB.prepare('DELETE FROM review_revisions'), DB.prepare('DELETE FROM review_logs'),
    DB.prepare('DELETE FROM review_search'),
    DB.prepare('DELETE FROM review_projects WHERE id <> 1'),
  ]);
});

it('健康指标只认 automation 的最近成功同步，不把管理员上传当自动同步', async () => {
  await ingestReview({
    markdown: '# 自动日志\n日期：2026-08-27\n审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个\n总体结论：无问题\n\n| Revision | 提交人 | 提交时间 | 说明 | 结论 |\n| --- | --- | --- | --- | --- |\n| 100 | alice | 2026-08-27 09:00 | 提交 | 已审查 |\n',
    sourceKey: 'health-auto', sourceName: 'auto.md', importedBy: 'automation', syncMode: 'automation',
  });
  await ingestReview({
    markdown: '# 管理员日志\n日期：2026-08-28\n审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个\n总体结论：无问题\n\n| Revision | 提交人 | 提交时间 | 说明 | 结论 |\n| --- | --- | --- | --- | --- |\n| 999 | admin | 2026-08-28 09:00 | 提交 | 已审查 |\n',
    sourceKey: 'health-manual', sourceName: 'manual.md', importedBy: 'admin@example.test', syncMode: 'manual',
  });
  await DB.prepare(
    `INSERT INTO review_projects (id, name, slug, description, display_order, enabled)
     VALUES (2, '海华项目', 'haihua', '', 10, 1)`,
  ).run();
  await ingestReviewForProject({ id: 2, slug: 'haihua' }, {
    markdown: '# 海华自动日志\n日期：2026-08-29\n审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个\n总体结论：发现 1 个 P2\n\n| Revision | 提交人 | 提交时间 | 说明 | 结论 |\n| --- | --- | --- | --- | --- |\n| 100 | bob | 2026-08-29 09:00 | 提交 | 已审查 |\n\n### P2\n\n#### 海华问题\n相关 revision：100\n\n详情。\n',
    sourceKey: 'health-auto', sourceName: 'auto.md', importedBy: 'automation', syncMode: 'automation',
  });
  const health = await getSyncHealth(1);
  expect(health.latestLogDate).toBe('2026-08-27');
  expect(health.latestRevision).toBe(100);
  expect(health.latestAutomationSyncAt).toBeTruthy();
  expect(health.zeroIssueWarning).toBe(true);
  expect(health.parseFailure).toBe(false);

  const haihuaHealth = await getSyncHealth(2);
  expect(haihuaHealth.latestLogDate).toBe('2026-08-29');
  expect(haihuaHealth.latestRevision).toBe(100);
  expect(haihuaHealth.reviewCount).toBe(1);
  expect(haihuaHealth.currentIssueCount).toBe(1);
  expect(haihuaHealth.zeroIssueWarning).toBe(false);
});

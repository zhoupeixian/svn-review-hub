/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { getSyncHealth, ingestReview } from '@/lib/reviews';

const DB = (env as { DB: D1Database }).DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM review_issue_events'), DB.prepare('DELETE FROM review_issues'),
    DB.prepare('DELETE FROM review_revisions'), DB.prepare('DELETE FROM review_logs'),
    DB.prepare('DELETE FROM review_search'),
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
  const health = await getSyncHealth();
  expect(health.latestLogDate).toBe('2026-08-27');
  expect(health.latestRevision).toBe(100);
  expect(health.latestAutomationSyncAt).toBeTruthy();
  expect(health.zeroIssueWarning).toBe(true);
  expect(health.parseFailure).toBe(false);
});

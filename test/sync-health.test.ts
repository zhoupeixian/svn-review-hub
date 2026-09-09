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

it('2026-09-08 完整自动接收后按实际当前问题判断零问题告警', async () => {
  const review = await ingestReview({
    markdown: reviewMarkdown20260908(),
    sourceKey: '2026-09-08/run-20260908-190437/svn审查日志-2026-09-08.md',
    sourceName: 'svn审查日志-2026-09-08.md',
    importedBy: 'automation',
    syncMode: 'automation',
  });

  expect(review).toMatchObject({
    logDate: '2026-09-08',
    revisionCount: 20,
    reviewedCount: 20,
    skippedCount: 0,
    p1Count: 3,
    p2Count: 3,
    p3Count: 0,
    ingestion: {
      createdIssueCount: 6,
      updatedIssueCount: 0,
      parsedIssueCount: 6,
    },
  });

  await DB.prepare(
    'UPDATE review_logs SET p1_count = 0, p2_count = 0, p3_count = 0 WHERE id = ?',
  ).bind(review.id).run();

  const health = await getSyncHealth(1);
  expect(health.currentIssueCount).toBe(6);
  expect(health.zeroIssueWarning).toBe(false);
});

function reviewMarkdown20260908(): string {
  const revisions = [
    54265, 54267, 54270, 54276, 54277, 54279, 54280, 54282, 54284, 54288,
    54292, 54301, 54302, 54303, 54304, 54305, 54307, 54311, 54315, 54316,
  ];
  const revisionRows = revisions.map(
    (revision) => `| ${revision} | reviewer | 2026-09-08 10:00 | 提交 ${revision} | 已审查 |`,
  );
  return [
    '# ZHERP 当日 SVN 提交审查日志',
    '',
    '日期：2026-09-08',
    '',
    '审查范围：2026-09-07 19:00:00 至 2026-09-08 18:59:59 内共 20 个 revision。',
    '',
    '总体结论：本轮发现 3 项需合并前修复的 P1 财务报表问题，以及 3 项 P2 功能/兼容性问题；当前不建议直接合并或部署。',
    '',
    '| Revision | 提交人 | 提交时间 | 提交说明 | 结论 |',
    '| --- | --- | --- | --- | --- |',
    ...revisionRows,
    '',
    '### P1',
    '',
    '#### 1. 按税种销售收入报表未排除无效财务凭证',
    '- 相关 revision：54301',
    '',
    '#### 2. 客户收入成本表的收入/成本分支均未过滤凭证状态',
    '- 相关 revision：54302',
    '',
    '#### 3. 客户收入成本表的 ML 左连接条件没有约束已选中的 ML 明细',
    '- 相关 revision：54302',
    '',
    '### P2',
    '',
    '#### 4. 部门客户余额报表的授信类别筛选读取了不存在的控件键',
    '- 相关 revision：54265、54270',
    '',
    '#### 5. MES/电商接口的触发条件、数据源与业务 Scope 已经分叉',
    '- 相关 revision：54284、54307',
    '',
    '#### 6. 销售订单报文批量转换删除了 DocumentNumber 兼容回退',
    '- 相关 revision：54305',
    '',
  ].join('\n');
}

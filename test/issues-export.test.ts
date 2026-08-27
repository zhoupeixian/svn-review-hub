/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: vi.fn(async () => null) }));
import { GET as exportIssues } from '@/app/api/issues/export/route';
import { GET as exportReviews } from '@/app/api/reviews/export/route';
import { ingestReview } from '@/lib/reviews';

const DB = (env as { DB: D1Database }).DB;

describe.sequential('CSV 导出', () => {
  beforeEach(async () => {
    await DB.batch([
      DB.prepare('DELETE FROM review_issue_events'), DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'), DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
    ]);
  });

  it('问题导出复用活动筛选，不混入归档问题并防护 CSV 公式', async () => {
    const markdown = `# 导出日志\n日期：2026-08-27\n审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个\n总体结论：保留 1 个 P1\n\n| Revision | 提交人 | 提交时间 | 说明 | 结论 |\n| --- | --- | --- | --- | --- |\n| 100 | alice | 2026-08-27 09:00 | 提交 | 已审查 |\n\n### P1\n\n#### 公式,标题\n相关 revision：100\n\n详情\n`;
    await ingestReview({ markdown, sourceKey: 'export-active', sourceName: 'export.md', importedBy: 'test', syncMode: 'automation' });
    const issue = await DB.prepare('SELECT id, review_id AS reviewId FROM review_issues LIMIT 1').first<{ id: number; reviewId: number }>();
    await DB.prepare('UPDATE review_logs SET archived_at = ? WHERE id = ?').bind('2026-08-27T12:00:00.000Z', issue!.reviewId).run();
    await ingestReview({ markdown: markdown.replace('导出日志', '当前日志'), sourceKey: 'export-current', sourceName: 'current.md', importedBy: 'test', syncMode: 'automation' });
    const currentIssue = await DB.prepare('SELECT id FROM review_issues WHERE review_id = (SELECT id FROM review_logs WHERE source_key = ?)').bind('export-current').first<{ id: number }>();
    await DB.prepare('UPDATE review_issues SET status_note = ? WHERE id = ?').bind('=SUM(A1),\n中文 "说明"', currentIssue!.id).run();

    const response = await exportIssues(new Request('https://review.test/api/issues/export?severity=P1'));
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(response.headers.get('content-type')).toContain('text/csv; charset=utf-8');
    expect(body).toContain('问题键');
    expect(body).not.toContain('export-active');
    expect(body).toContain("'=SUM(A1),\n中文 \"\"说明\"\"");
  });

  it('日志导出不读取 R2 原文且支持归档范围', async () => {
    await ingestReview({
      markdown: '# 归档日志\n日期：2026-08-26\n审查范围：共 0 个 revision，实际审查 0 个，跳过 0 个\n总体结论：无问题\n',
      sourceKey: 'export-archive', sourceName: 'archive.md', importedBy: 'test', syncMode: 'manual',
    });
    await DB.prepare('UPDATE review_logs SET archived_at = ? WHERE source_key = ?').bind('2026-08-27T12:00:00.000Z', 'export-archive').run();
    const response = await exportReviews(new Request('https://review.test/api/reviews/export?scope=archived'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('归档日志');
  });
});

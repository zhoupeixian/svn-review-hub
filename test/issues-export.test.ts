/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import * as XLSX from 'xlsx-js-style';
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: vi.fn(async () => null) }));
import { GET as exportIssues } from '@/app/api/issues/export/route';
import { GET as exportReviews } from '@/app/api/reviews/export/route';
import { ingestReview, toCsv } from '@/lib/reviews';

const DB = (env as { DB: D1Database }).DB;

describe.sequential('问题导出', () => {
  beforeEach(async () => {
    await DB.batch([
      DB.prepare('DELETE FROM review_issue_events'), DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'), DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
    ]);
  });

  it('问题导出为可分派的 Excel 工作表，不混入归档问题并防护公式', async () => {
    const markdown = `# 导出日志\n日期：2026-08-27\n审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个\n总体结论：保留 1 个 P1\n\n| Revision | 提交人 | 提交时间 | 说明 | 结论 |\n| --- | --- | --- | --- | --- |\n| 100 | alice | 2026-08-27 09:00 | 提交 | 已审查 |\n\n### P1\n\n#### 公式,标题\n相关 revision：100\n\n详情\n`;
    await ingestReview({ markdown, sourceKey: 'export-active', sourceName: 'export.md', importedBy: 'test', syncMode: 'automation' });
    const issue = await DB.prepare('SELECT id, review_id AS reviewId FROM review_issues LIMIT 1').first<{ id: number; reviewId: number }>();
    await DB.prepare('UPDATE review_logs SET archived_at = ? WHERE id = ?').bind('2026-08-27T12:00:00.000Z', issue!.reviewId).run();
    await ingestReview({ markdown: markdown.replace('导出日志', '当前日志'), sourceKey: 'export-current', sourceName: 'current.md', importedBy: 'test', syncMode: 'automation' });
    const currentIssue = await DB.prepare('SELECT id FROM review_issues WHERE review_id = (SELECT id FROM review_logs WHERE source_key = ?)').bind('export-current').first<{ id: number }>();
    await DB.prepare('UPDATE review_issues SET status_note = ? WHERE id = ?').bind('=SUM(A1),\n中文 "说明"', currentIssue!.id).run();

    const response = await exportIssues(new Request('https://review.test/api/issues/export?severity=P1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
    expect(workbook.SheetNames).toEqual(['问题跟进']);
    const worksheet = workbook.Sheets['问题跟进'];
    expect(XLSX.utils.sheet_to_json(worksheet, { header: 1 })).toEqual(expect.arrayContaining([
      ['严重级别', '状态', '问题标题', '关联 Revision', '提交人', '日志日期', '来源日志', '处理说明', '最后更新', '详情链接'],
      expect.arrayContaining(['P1', '待处理', '公式,标题']),
    ]));
    expect(worksheet.J2.l?.Target).toBe('https://review.test/reviews/2#issue-2');
    expect(worksheet.H2.v).toBe("'=SUM(A1),\n中文 \"说明\"");
    expect(worksheet['!autofilter']?.ref).toBe('A1:J2');
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

  it('公式防护忽略公式前的空白字符', () => {
    const row = {
      issueKey: 'issue', status: 'open', updatedAt: '', severity: 'P1', title: '标题',
      revision: '', author: '', logDate: '', sourceName: '', detailUrl: '', statusNote: '',
    };
    const csv = toCsv([
      { ...row, statusNote: ' =SUM(A1)' },
      { ...row, statusNote: '\t+SUM(A1)' },
      { ...row, statusNote: '\r-1' },
      { ...row, statusNote: '\n@cmd' },
    ]);
    expect(csv).toContain("\"' =SUM(A1)\"");
    expect(csv).toContain("\"'\t+SUM(A1)\"");
    expect(csv).toContain("\"'\r-1\"");
    expect(csv).toContain("\"'\n@cmd\"");
  });
});

/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureReviewSchema,
  getCurrentReviewStats,
  getEnabledReviewProject,
  getIssuePage,
  getReviewDetail,
  getReviewMarkdown,
  getReviewProjectDirectory,
  getReviewPage,
  getReviewSummaries,
  getSyncHealth,
  rebuildReviewSearch,
} from '../lib/reviews';

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
};

type ReviewFixture = {
  id: number;
  projectId?: number;
  logDate: string;
  archived?: boolean;
  title?: string;
  overview?: string;
  scopeText?: string;
};

type RevisionFixture = {
  id: number;
  reviewId: number;
  revision: number;
  author: string;
  description?: string;
};

type IssueFixture = {
  id: number;
  reviewId: number;
  severity: 'P1' | 'P2' | 'P3';
  title: string;
  relatedRevisions: string;
  detail?: string;
  status?: string;
  statusNote?: string | null;
  statusUpdatedAt?: string | null;
  sourceCurrent?: number;
};

const DB = (env as unknown as TestEnv).DB;
const FILES = (env as unknown as TestEnv).FILES;

describe.sequential('审查日志 Repository 查询', () => {
  beforeAll(async () => {
    await ensureReviewSchema();
  });

  beforeEach(async () => {
    await DB.batch(
      [
        'DELETE FROM review_issue_events',
        'DELETE FROM review_issues',
        'DELETE FROM review_revisions',
        'DELETE FROM review_logs',
        'DELETE FROM review_search',
        'DELETE FROM review_projects WHERE id <> 1',
      ].map((sql) => DB.prepare(sql)),
    );
  });

  it('按显示顺序列出启用项目，并提供当前项目的目录统计和同步状态', async () => {
    await DB.batch([
      DB.prepare(
        `UPDATE review_projects
         SET name = 'ZHERP', description = 'ERP 主项目', display_order = 20, enabled = 1
         WHERE id = 1`,
      ),
      DB.prepare(
        `INSERT INTO review_projects (id, name, slug, description, display_order, enabled)
         VALUES (2, '海华项目', 'haihua', '海华专项审查', 10, 1)`,
      ),
      DB.prepare(
        `INSERT INTO review_projects (id, name, slug, description, display_order, enabled)
         VALUES (3, '停用项目', 'disabled', '不应公开', 0, 0)`,
      ),
      DB.prepare(
        `INSERT INTO review_projects (id, name, slug, description, display_order, enabled)
         VALUES (4, '空项目', 'empty', '等待同步', 15, 1)`,
      ),
    ]);
    await insertReviews([
      { id: 1, projectId: 1, logDate: '2026-08-30', title: 'ZHERP 日志' },
      { id: 2, projectId: 2, logDate: '2026-08-31', title: '海华日志' },
      { id: 3, projectId: 3, logDate: '2026-09-01', title: '停用日志' },
    ]);
    await insertIssues([
      { id: 1, reviewId: 1, severity: 'P1', title: 'ZHERP 风险', relatedRevisions: '1' },
      { id: 2, reviewId: 2, severity: 'P2', title: '海华风险', relatedRevisions: '2' },
      { id: 3, reviewId: 2, severity: 'P3', title: '海华普通问题', relatedRevisions: '3' },
    ]);

    const projects = await getReviewProjectDirectory();

    expect(projects.map((project) => project.slug)).toEqual(['haihua', 'empty', 'zherp']);
    expect(projects[0]).toMatchObject({
      name: '海华项目',
      description: '海华专项审查',
      latestReviewDate: '2026-08-31',
      openIssueCount: 2,
      highRiskCount: 1,
    });
    expect(projects[1]).toMatchObject({
      slug: 'empty', latestReviewDate: null, openIssueCount: 0,
      highRiskCount: 0, latestAutomationSyncAt: null, syncStatus: 'waiting',
    });
    expect(await getEnabledReviewProject('haihua')).toMatchObject({ id: 2, slug: 'haihua' });
    expect(await getEnabledReviewProject('disabled')).toBeNull();
    expect(await getEnabledReviewProject('missing')).toBeNull();
  });

  it('日志、问题、统计、同步状态、详情和原文只读取指定项目', async () => {
    await DB.prepare(
      `INSERT INTO review_projects (id, name, slug, description, display_order, enabled)
       VALUES (2, '海华项目', 'haihua', '', 10, 1)`,
    ).run();
    await insertReviews([
      { id: 70, projectId: 1, logDate: '2026-08-30', title: 'ZHERP 隔离日志' },
      { id: 71, projectId: 2, logDate: '2026-08-31', title: '海华隔离日志' },
    ]);
    await insertRevisions([
      { id: 700, reviewId: 70, revision: 57001, author: 'zherp-user' },
      { id: 710, reviewId: 71, revision: 57001, author: 'haihua-user' },
    ]);
    await insertIssues([
      { id: 700, reviewId: 70, severity: 'P1', title: 'ZHERP 问题', relatedRevisions: '57001' },
      { id: 710, reviewId: 71, severity: 'P2', title: '海华问题', relatedRevisions: '57001' },
    ]);
    await FILES.put('review-logs/70.md', '# ZHERP 原文');
    await FILES.put('review-logs/71.md', '# 海华原文');

    expect((await getReviewPage(2, { scope: 'active', keyword: '隔离' })).items.map((item) => item.id)).toEqual([71]);
    expect((await getIssuePage(2, { scope: 'active', keyword: '问题' })).items.map((item) => item.id)).toEqual([710]);
    expect(await getCurrentReviewStats(2)).toMatchObject({ reviewCount: 1, openIssueCount: 1, highRiskCount: 1 });
    expect(await getSyncHealth(2)).toMatchObject({ latestLogDate: '2026-08-31', latestRevision: 57001, reviewCount: 1, currentIssueCount: 1 });
    expect(await getReviewDetail(2, 70)).toBeNull();
    expect(await getReviewDetail(2, 71)).toMatchObject({ id: 71, title: '海华隔离日志' });
    expect(await getReviewMarkdown(2, 70)).toBeNull();
    expect(await getReviewMarkdown(2, 71)).toEqual({ content: '# 海华原文', sourceName: 'fixture-71.md' });
  });

  it('按日期和 id 分页读取当前日志，且默认 20 条、最多 50 条', async () => {
    const fixtures: ReviewFixture[] = [
      { id: 1, logDate: '2026-08-27', title: '最新日志' },
      ...Array.from({ length: 50 }, (_, index) => ({
        id: index + 2,
        logDate: '2026-08-26',
      })),
      { id: 99, logDate: '2026-08-28', archived: true, title: '归档日志' },
    ];
    await insertReviews(fixtures);

    const firstPage = await getReviewPage(1, { scope: 'active' });
    const secondPage = await getReviewPage(1, {
      scope: 'active',
      cursor: firstPage.nextCursor ?? undefined,
    });
    const cappedPage = await getReviewPage(1, { scope: 'active', limit: 500 });

    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.items.map((item) => item.id)).toEqual([
      1, 51, 50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35,
      34, 33,
    ]);
    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.items[0]?.id).toBe(32);
    expect(secondPage.items).toHaveLength(20);
    expect(cappedPage.items).toHaveLength(50);
    expect(cappedPage.hasMore).toBe(true);
    expect(cappedPage.items.some((item) => item.id === 99)).toBe(false);
  });

  it('旧日志的范围文本可补齐历史错误保存的审查与跳过计数', async () => {
    await insertReviews([{
      id: 2,
      logDate: '2026-08-27',
      scopeText: '共 24 个 revision，其中 22 个可审查，2 个按默认规则跳过。',
    }]);

    const page = await getReviewPage(1, { scope: 'active' });

    expect(page.items[0]).toMatchObject({ revisionCount: 24, reviewedCount: 22, skippedCount: 2 });
  });

  it('在当前分区内组合日期、作者、Revision、风险、状态和关键词过滤', async () => {
    await insertReviews([
      {
        id: 10,
        logDate: '2026-08-27',
        title: '当前目标日志',
        overview: '结构化摘要',
      },
      {
        id: 11,
        logDate: '2026-08-27',
        archived: true,
        title: '归档同条件日志',
      },
      { id: 12, logDate: '2026-08-27', title: '状态不符日志' },
    ]);
    await insertRevisions([
      { id: 100, reviewId: 10, revision: 54001, author: '张三' },
      { id: 101, reviewId: 11, revision: 54001, author: '张三' },
      { id: 102, reviewId: 12, revision: 54001, author: '张三' },
    ]);
    await insertIssues([
      {
        id: 200,
        reviewId: 10,
        severity: 'P1',
        title: '参数数量不匹配',
        relatedRevisions: '54001',
        detail: '库存凭证写入失败',
        status: 'resolved',
      },
      {
        id: 201,
        reviewId: 11,
        severity: 'P1',
        title: '参数数量不匹配',
        relatedRevisions: '54001',
        detail: '库存凭证写入失败',
        status: 'resolved',
      },
      {
        id: 202,
        reviewId: 12,
        severity: 'P1',
        title: '参数数量不匹配',
        relatedRevisions: '54001',
        detail: '库存凭证写入失败',
        status: 'open',
      },
    ]);

    const page = await getReviewPage(1, {
      scope: 'active',
      fromDate: '2026-08-27',
      toDate: '2026-08-27',
      author: '张三',
      revision: 54001,
      severity: 'P1',
      status: 'resolved',
      keyword: '库存凭证',
    });

    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(page.items.map((item) => item.id)).toEqual([10]);
    expect(page.items[0]).not.toHaveProperty('detail');
    expect(page.items[0]).not.toHaveProperty('markdown');
    expect(page.items[0]).not.toHaveProperty('contentObjectKey');

    const injectedStatus = await getReviewPage(1, {
      scope: 'active',
      status: "resolved' OR 1=1 --" as never,
    });
    expect(injectedStatus.items).toEqual([]);
  });

  it('无效 FTS 查询安全降级，且不会把归档日志或 SQL 注入结果带入当前区', async () => {
    await insertReviews([
      { id: 20, logDate: '2026-08-27', title: '当前安全日志' },
      {
        id: 21,
        logDate: '2026-08-28',
        archived: true,
        title: "归档 ' OR 1=1 -- 日志",
      },
    ]);

    const malformed = await getReviewPage(1, {
      scope: 'active',
      keyword: '" OR 1=1 --',
    });
    const shortKeyword = await getReviewPage(1, {
      scope: 'active',
      keyword: '安全',
    });

    expect(malformed).toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(shortKeyword.items.map((item) => item.id)).toEqual([20]);
  });

  it('问题查询默认当前分区和当前来源，并按状态更新时间、id 游标分页', async () => {
    await insertReviews([
      { id: 30, logDate: '2026-08-27', title: '当前问题日志' },
      {
        id: 31,
        logDate: '2026-08-28',
        archived: true,
        title: '归档问题日志',
      },
    ]);
    await insertIssues([
      ...Array.from({ length: 21 }, (_, index) => ({
        id: 300 + index,
        reviewId: 30,
        severity: 'P2' as const,
        title: `当前问题 ${index}`,
        relatedRevisions: '55001',
        statusUpdatedAt: '2026-08-27T10:00:00.000Z',
      })),
      {
        id: 400,
        reviewId: 30,
        severity: 'P1',
        title: '旧来源问题',
        relatedRevisions: '55002',
        statusUpdatedAt: '2026-08-29T10:00:00.000Z',
        sourceCurrent: 0,
      },
      {
        id: 401,
        reviewId: 31,
        severity: 'P1',
        title: '归档问题',
        relatedRevisions: '55003',
        statusUpdatedAt: '2026-08-30T10:00:00.000Z',
      },
    ]);

    const firstPage = await getIssuePage(1);
    const secondPage = await getIssuePage(1, {
      cursor: firstPage.nextCursor ?? undefined,
    });
    const archivedPage = await getIssuePage(1, { scope: 'archived' });

    expect(firstPage.items.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => 320 - index),
    );
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage).toMatchObject({ hasMore: false, nextCursor: null });
    expect(secondPage.items.map((item) => item.id)).toEqual([300]);
    expect(archivedPage.items.map((item) => item.id)).toEqual([401]);
    expect(firstPage.items.some((item) => item.id === 400)).toBe(false);
  });

  it('问题查询组合状态、风险、日期、作者、Revision 和关键词时不跨分区', async () => {
    await insertReviews([
      { id: 40, logDate: '2026-08-27', title: '当前目标问题日志' },
      {
        id: 41,
        logDate: '2026-08-27',
        archived: true,
        title: '归档目标问题日志',
      },
    ]);
    await insertRevisions([
      {
        id: 410,
        reviewId: 40,
        revision: 56001,
        author: '李四',
        description: '修复仓库权限判断',
      },
      {
        id: 411,
        reviewId: 41,
        revision: 56001,
        author: '李四',
        description: '修复仓库权限判断',
      },
    ]);
    await insertIssues([
      {
        id: 420,
        reviewId: 40,
        severity: 'P1',
        title: '权限复用错误',
        relatedRevisions: '56001',
        status: 'pending_review',
        statusNote: '等待仓库负责人确认',
        statusUpdatedAt: '2026-08-27T11:00:00.000Z',
      },
      {
        id: 421,
        reviewId: 41,
        severity: 'P1',
        title: '权限复用错误',
        relatedRevisions: '56001',
        status: 'pending_review',
        statusNote: '等待仓库负责人确认',
        statusUpdatedAt: '2026-08-27T12:00:00.000Z',
      },
    ]);

    const page = await getIssuePage(1, {
      scope: 'active',
      fromDate: '2026-08-27',
      toDate: '2026-08-27',
      status: 'pending_review',
      severity: 'P1',
      author: '李四',
      revision: 56001,
      keyword: '负责人',
    });

    expect(page.items.map((item) => item.id)).toEqual([420]);
    expect(page.items[0]).toMatchObject({
      reviewId: 40,
      logDate: '2026-08-27',
      reviewTitle: '当前目标问题日志',
      authors: '李四',
      sourceCurrent: 1,
    });
    expect(page.items[0]).not.toHaveProperty('detail');
  });

  it('问题看板可联合筛选 P1 和 P2，而不会混入 P3 或归档数据', async () => {
    await insertReviews([
      { id: 43, logDate: '2026-08-27', title: '当前联合风险日志' },
      { id: 44, logDate: '2026-08-27', archived: true, title: '归档联合风险日志' },
    ]);
    await insertIssues([
      { id: 430, reviewId: 43, severity: 'P1', title: 'P1 当前问题', relatedRevisions: '56011' },
      { id: 431, reviewId: 43, severity: 'P2', title: 'P2 当前问题', relatedRevisions: '56012' },
      { id: 432, reviewId: 43, severity: 'P3', title: 'P3 当前问题', relatedRevisions: '56013' },
      { id: 433, reviewId: 44, severity: 'P1', title: 'P1 归档问题', relatedRevisions: '56014' },
    ]);

    const page = await getIssuePage(1, { scope: 'active', severities: ['P1', 'P2'] });

    expect(page.items.map((item) => item.id).sort()).toEqual([430, 431]);
  });

  it('空页返回稳定结构，兼容摘要接口只返回当前区首页', async () => {
    await insertReviews([
      {
        id: 50,
        logDate: '2026-08-27',
        archived: true,
        title: '只有归档日志',
      },
    ]);

    expect(await getReviewPage(1, { scope: 'active' })).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(await getIssuePage(1)).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(await getReviewSummaries(1)).toEqual([]);
  });

  it('重建单条日志的 FTS 行，不影响其他日志索引', async () => {
    await insertReviews([
      { id: 60, logDate: '2026-08-27', title: '需要恢复索引' },
      { id: 61, logDate: '2026-08-26', title: '其他日志索引' },
    ]);
    await DB.prepare('DELETE FROM review_search WHERE rowid = ?').bind(60).run();

    await rebuildReviewSearch(60);

    const rows = await DB.prepare(
      'SELECT review_id AS reviewId, title FROM review_search ORDER BY review_id',
    ).all<{ reviewId: number; title: string }>();
    expect(rows.results).toEqual([
      { reviewId: 60, title: '需要恢复索引' },
      { reviewId: 61, title: '其他日志索引' },
    ]);
  });
});

async function insertReviews(fixtures: ReviewFixture[]): Promise<void> {
  await DB.batch(
    fixtures.map((fixture) =>
      DB.prepare(
        `INSERT INTO review_logs (
          id, project_id, log_date, source_key, source_name, source_hash, content_object_key,
          title, overview, scope_text, revision_count, reviewed_count,
          skipped_count, p1_count, p2_count, p3_count, sync_mode, imported_by,
          imported_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0,
                  'automation', 'test', ?, ?, ?)`,
      ).bind(
        fixture.id,
        fixture.projectId ?? 1,
        fixture.logDate,
        `fixture/${fixture.id}.md`,
        `fixture-${fixture.id}.md`,
        `hash-${fixture.id}`,
        `review-logs/${fixture.id}.md`,
        fixture.title ?? `日志 ${fixture.id}`,
        fixture.overview ?? `概览 ${fixture.id}`,
        fixture.scopeText ?? `范围 ${fixture.id}`,
        `${fixture.logDate}T00:00:00.000Z`,
        `${fixture.logDate}T00:00:00.000Z`,
        fixture.archived ? `${fixture.logDate}T12:00:00.000Z` : null,
      ),
    ),
  );
}

async function insertRevisions(fixtures: RevisionFixture[]): Promise<void> {
  await DB.batch(
    fixtures.map((fixture) =>
      DB.prepare(
        `INSERT INTO review_revisions (
          id, review_id, revision, author, committed_at, description, conclusion
        ) VALUES (?, ?, ?, ?, '2026-08-27T00:00:00.000Z', ?, '已审查')`,
      ).bind(
        fixture.id,
        fixture.reviewId,
        fixture.revision,
        fixture.author,
        fixture.description ?? `提交 ${fixture.revision}`,
      ),
    ),
  );
}

async function insertIssues(fixtures: IssueFixture[]): Promise<void> {
  await DB.batch(
    fixtures.map((fixture) =>
      DB.prepare(
        `INSERT INTO review_issues (
          id, review_id, issue_key, severity, title, related_revisions, detail,
          status, status_note, status_updated_at, source_current, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).bind(
        fixture.id,
        fixture.reviewId,
        `issue-${fixture.id}`,
        fixture.severity,
        fixture.title,
        fixture.relatedRevisions,
        fixture.detail ?? `问题详情 ${fixture.id}`,
        fixture.status ?? 'open',
        fixture.statusNote ?? null,
        fixture.statusUpdatedAt ?? null,
        fixture.sourceCurrent ?? 1,
      ),
    ),
  );
}

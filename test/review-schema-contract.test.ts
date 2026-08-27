/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { ensureReviewSchema } from '../lib/reviews';

type TestEnv = {
  DB: D1Database;
};

const DB = (env as unknown as TestEnv).DB;

async function tableColumns(table: string): Promise<string[]> {
  const result = await DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
  }>();
  return (result.results ?? []).map((column) => column.name);
}

async function indexNames(table: string): Promise<string[]> {
  const result = await DB.prepare(`PRAGMA index_list(${table})`).all<{
    name: string;
  }>();
  return (result.results ?? []).map((index) => index.name);
}

async function foreignKeyTargets(table: string): Promise<string[]> {
  const result = await DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
    table: string;
  }>();
  return (result.results ?? []).map((foreignKey) => foreignKey.table);
}

async function resetToLegacySchema(): Promise<void> {
  const statements = [
    'DROP TABLE IF EXISTS review_search',
    'DROP TABLE IF EXISTS review_issue_events',
    'DROP TABLE IF EXISTS anonymous_update_limits',
    'DROP TABLE IF EXISTS archive_operation_previews',
    'DROP TABLE IF EXISTS review_issues',
    'DROP TABLE IF EXISTS review_revisions',
    'DROP TABLE IF EXISTS review_logs',
    `CREATE TABLE review_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT NOT NULL,
      source_key TEXT NOT NULL UNIQUE,
      source_name TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      content_object_key TEXT NOT NULL,
      title TEXT NOT NULL,
      overview TEXT NOT NULL,
      scope_text TEXT NOT NULL,
      revision_count INTEGER NOT NULL DEFAULT 0,
      reviewed_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      p1_count INTEGER NOT NULL DEFAULT 0,
      p2_count INTEGER NOT NULL DEFAULT 0,
      p3_count INTEGER NOT NULL DEFAULT 0,
      sync_mode TEXT NOT NULL,
      imported_by TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE review_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      author TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      description TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      UNIQUE(review_id, revision)
    )`,
    `CREATE TABLE review_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      related_revisions TEXT NOT NULL,
      detail TEXT NOT NULL
    )`,
    `CREATE TABLE review_issue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  ];
  await DB.batch(statements.map((statement) => DB.prepare(statement)));

  await DB.prepare(
    `INSERT INTO review_logs (
      id, log_date, source_key, source_name, source_hash, content_object_key,
      title, overview, scope_text, revision_count, reviewed_count, skipped_count,
      p1_count, p2_count, p3_count, sync_mode, imported_by, imported_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 1, 0, 0, ?, ?, ?, ?)`,
  )
    .bind(
      '2026-08-20',
      'legacy/2026-08-20.md',
      '2026-08-20.md',
      'legacy-hash',
      'review-logs/2026-08-20/legacy.md',
      '历史审查日志',
      '保留的概览',
      'r123',
      'automation',
      'legacy-importer',
      '2026-08-20T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z',
    )
    .run();
  await DB.prepare(
    `INSERT INTO review_issues (
      id, review_id, severity, title, related_revisions, detail
    ) VALUES (10, 1, 'P1', '旧问题', '123、124', '历史问题详情')`,
  ).run();
  await DB.prepare(
    `INSERT INTO review_issue_events (
      id, issue_id, from_status, to_status, note, created_at
    ) VALUES (20, 10, 'open', 'pending_review', '历史复核记录',
              '2026-08-21T00:00:00.000Z')`,
  ).run();
}

describe.sequential('审查生命周期 D1 schema', () => {
  it('迁移创建生命周期字段、索引、短期表和 FTS5 表', async () => {
    expect(await tableColumns('review_logs')).toContain('archived_at');
    expect(await tableColumns('review_issues')).toEqual(
      expect.arrayContaining([
        'issue_key',
        'status',
        'status_note',
        'status_updated_at',
        'source_current',
        'version',
      ]),
    );
    expect(await tableColumns('review_issue_events')).toEqual(
      expect.arrayContaining([
        'id',
        'issue_id',
        'from_status',
        'to_status',
        'note',
        'created_at',
      ]),
    );
    expect(await tableColumns('anonymous_update_limits')).toEqual([
      'client_hash',
      'window_started_at',
      'request_count',
    ]);
    expect(await tableColumns('archive_operation_previews')).toEqual([
      'token',
      'admin_user_id',
      'review_ids_json',
      'review_count',
      'revision_count',
      'issue_count',
      'created_at',
      'expires_at',
    ]);
    expect(await indexNames('review_logs')).toContain(
      'idx_review_logs_archive_date_id',
    );
    expect(await indexNames('review_issues')).toEqual(
      expect.arrayContaining([
        'idx_review_issues_status_current_review',
        'idx_review_issues_review_issue_key',
      ]),
    );
    expect(await indexNames('review_issue_events')).toContain(
      'idx_review_issue_events_issue_created',
    );
    expect(await foreignKeyTargets('review_issues')).toContain('review_logs');
    expect(await foreignKeyTargets('review_issue_events')).toContain(
      'review_issues',
    );

    const fts = await DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_search'",
    ).first<{ name: string }>();
    expect(fts?.name).toBe('review_search');
  });

  it('幂等升级旧库并保留日志、问题和原文引用', async () => {
    await resetToLegacySchema();

    vi.resetModules();
    const { ensureReviewSchema: ensureReviewSchemaAgain } = await import(
      '../lib/reviews'
    );
    await ensureReviewSchemaAgain();
    const firstPass = await DB.prepare(
      `SELECT l.content_object_key AS contentObjectKey,
              i.id, i.issue_key AS issueKey, i.status, i.status_note AS statusNote,
              i.source_current AS sourceCurrent, i.version
       FROM review_logs l
       JOIN review_issues i ON i.review_id = l.id
       WHERE l.id = 1 AND i.id = 10`,
    ).first<{
      contentObjectKey: string;
      id: number;
      issueKey: string;
      status: string;
      statusNote: string | null;
      sourceCurrent: number;
      version: number;
    }>();

    await DB.prepare(
      `UPDATE review_issues
       SET status = 'resolved', status_note = '历史状态不得覆盖', version = 4
       WHERE id = 10`,
    ).run();
    await DB.prepare(
      `INSERT INTO review_search (
        rowid, review_id, title, overview, scope_text, revisions, authors,
        descriptions, issue_titles, issue_details, status_notes
      ) VALUES (999, 999, '保留索引行', '', '', '', '', '', '', '', '')`,
    ).run();
    await ensureReviewSchema();
    const secondPass = await DB.prepare(
      `SELECT id, issue_key AS issueKey, status, status_note AS statusNote,
              source_current AS sourceCurrent, version
       FROM review_issues WHERE review_id = 1`,
    ).all<{
      id: number;
      issueKey: string;
      status: string;
      statusNote: string | null;
      sourceCurrent: number;
      version: number;
    }>();
    const eventCount = await DB.prepare(
      'SELECT COUNT(*) AS count FROM review_issue_events WHERE id = 20',
    ).first<{ count: number }>();
    const preservedSearchRow = await DB.prepare(
      'SELECT title FROM review_search WHERE rowid = 999',
    ).first<{ title: string }>();

    expect(firstPass).toEqual({
      contentObjectKey: 'review-logs/2026-08-20/legacy.md',
      id: 10,
      issueKey: 'p1:旧问题:123、124',
      status: 'open',
      statusNote: null,
      sourceCurrent: 1,
      version: 0,
    });
    expect(secondPass.results).toEqual([
      {
        id: 10,
        issueKey: 'p1:旧问题:123、124',
        status: 'resolved',
        statusNote: '历史状态不得覆盖',
        sourceCurrent: 1,
        version: 4,
      },
    ]);
    expect(eventCount?.count).toBe(1);
    expect(preservedSearchRow?.title).toBe('保留索引行');
  });

  it('新问题使用默认状态，事件必须关联问题，问题必须关联日志', async () => {
    await DB.prepare(
      `INSERT INTO review_issues (
        review_id, issue_key, severity, title, related_revisions, detail
      ) VALUES (1, 'p2:新问题:125', 'P2', '新问题', '125', '详情')`,
    ).run();

    const issue = await DB.prepare(
      `SELECT id, status, source_current AS sourceCurrent, version
       FROM review_issues WHERE issue_key = 'p2:新问题:125'`,
    ).first<{
      id: number;
      status: string;
      sourceCurrent: number;
      version: number;
    }>();
    expect(issue).toMatchObject({ status: 'open', sourceCurrent: 1, version: 0 });

    await expect(
      DB.prepare(
        `INSERT INTO review_issues (
          review_id, issue_key, severity, title, related_revisions, detail
        ) VALUES (9999, 'orphan', 'P1', '孤立问题', '', '详情')`,
      ).run(),
    ).rejects.toThrow();

    await DB.prepare(
      `INSERT INTO review_issue_events (
        issue_id, from_status, to_status, note, created_at
      ) VALUES (?, 'open', 'resolved', '已修复', '2026-08-27T10:00:00.000Z')`,
    )
      .bind(issue!.id)
      .run();
    const event = await DB.prepare(
      `SELECT from_status AS fromStatus, to_status AS toStatus, note,
              created_at AS createdAt
       FROM review_issue_events WHERE issue_id = ?`,
    )
      .bind(issue!.id)
      .first();
    expect(event).toEqual({
      fromStatus: 'open',
      toStatus: 'resolved',
      note: '已修复',
      createdAt: '2026-08-27T10:00:00.000Z',
    });
    await expect(
      DB.prepare(
        `INSERT INTO review_issue_events (
          issue_id, from_status, to_status, note, created_at
        ) VALUES (9999, 'open', 'resolved', '', '2026-08-27T10:00:00.000Z')`,
      ).run(),
    ).rejects.toThrow();
  });

  it('同一稳定键只能保留一条记录，重新出现时激活原记录', async () => {
    const existing = await DB.prepare(
      `INSERT INTO review_issues (
        review_id, issue_key, severity, title, related_revisions, detail,
        status, status_note, source_current, version
      ) VALUES (1, 'p3:重复问题:126', 'P3', '重复问题', '126', '旧详情',
                'pending_review', '等待确认', 0, 2)
       RETURNING id`,
    ).first<{ id: number }>();

    await DB.prepare(
      `INSERT INTO review_issues (
        review_id, issue_key, severity, title, related_revisions, detail
      ) VALUES (1, 'p3:重复问题:126', 'P3', '重复问题', '126', '新详情')
       ON CONFLICT(review_id, issue_key) WHERE issue_key IS NOT NULL
       DO UPDATE SET source_current = 1`,
    ).run();

    const records = await DB.prepare(
      `SELECT id, status, status_note AS statusNote,
              source_current AS sourceCurrent, version
       FROM review_issues
       WHERE review_id = 1 AND issue_key = 'p3:重复问题:126'`,
    ).all();
    expect(records.results).toEqual([
      {
        id: existing!.id,
        status: 'pending_review',
        statusNote: '等待确认',
        sourceCurrent: 1,
        version: 2,
      },
    ]);
  });

  it('FTS5 索引可搜索摘要和当前处理说明，不包含原文对象字段', async () => {
    await DB.prepare(
      `UPDATE review_issues
       SET status_note = '等待仓库负责人复核'
       WHERE issue_key = 'p2:新问题:125'`,
    ).run();

    const matches = await DB.prepare(
      "SELECT review_id AS reviewId FROM review_search WHERE review_search MATCH '负责人'",
    ).all<{ reviewId: number }>();
    expect(matches.results).toEqual([{ reviewId: 1 }]);
    expect(await tableColumns('review_search')).not.toContain('content_object_key');
  });
});

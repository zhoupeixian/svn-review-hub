/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { ensureReviewSchema } from '../lib/reviews';

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
};

const { DB, FILES, TEST_MIGRATIONS } = env as unknown as TestEnv;

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

async function indexColumns(index: string): Promise<string[]> {
  const result = await DB.prepare(`PRAGMA index_info(${index})`).all<{
    name: string;
  }>();
  return (result.results ?? []).map((column) => column.name);
}

async function resetToPreProjectSchema(): Promise<void> {
  const statements = [
    'DROP TABLE IF EXISTS review_search',
    'DROP TABLE IF EXISTS review_issue_events',
    'DROP TABLE IF EXISTS anonymous_update_limits',
    'DROP TABLE IF EXISTS archive_operation_previews',
    'DROP TABLE IF EXISTS review_issues',
    'DROP TABLE IF EXISTS review_revisions',
    'DROP TABLE IF EXISTS review_logs',
    'DROP TABLE IF EXISTS review_projects',
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
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )`,
    `CREATE TABLE review_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      author TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      description TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      UNIQUE(review_id, revision),
      FOREIGN KEY(review_id) REFERENCES review_logs(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE review_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      issue_key TEXT,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      related_revisions TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      status_note TEXT,
      status_updated_at TEXT,
      source_current INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(review_id) REFERENCES review_logs(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE review_issue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES review_issues(id) ON DELETE CASCADE
    )`,
  ];
  await DB.batch(statements.map((statement) => DB.prepare(statement)));

  await DB.batch([
    DB.prepare(
      `INSERT INTO review_logs (
        id, log_date, source_key, source_name, source_hash, content_object_key,
        title, overview, scope_text, revision_count, reviewed_count, skipped_count,
        p1_count, p2_count, p3_count, sync_mode, imported_by, imported_at,
        updated_at, archived_at
      ) VALUES (1, '2026-08-20', 'legacy/active.md', 'active.md', 'active-hash',
                'review-logs/2026-08-20/active.md', '活动日志', '活动概览', 'r123',
                1, 1, 0, 1, 0, 0, 'automation', 'legacy-importer',
                '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z', NULL)`,
    ),
    DB.prepare(
      `INSERT INTO review_logs (
        id, log_date, source_key, source_name, source_hash, content_object_key,
        title, overview, scope_text, revision_count, reviewed_count, skipped_count,
        p1_count, p2_count, p3_count, sync_mode, imported_by, imported_at,
        updated_at, archived_at
      ) VALUES (2, '2026-08-19', 'legacy/archived.md', 'archived.md', 'archived-hash',
                'review-logs/2026-08-19/archived.md', '归档日志', '归档概览', 'r122',
                1, 1, 0, 0, 1, 0, 'manual', 'admin@example.com',
                '2026-08-19T00:00:00.000Z', '2026-08-22T00:00:00.000Z',
                '2026-08-23T00:00:00.000Z')`,
    ),
    DB.prepare(
      `INSERT INTO review_revisions (
        id, review_id, revision, author, committed_at, description, conclusion
      ) VALUES (30, 1, 123, 'alice', '2026-08-20T09:00:00.000Z',
                '历史提交', '已审查')`,
    ),
    DB.prepare(
      `INSERT INTO review_issues (
        id, review_id, issue_key, severity, title, related_revisions, detail,
        status, status_note, status_updated_at, source_current, version
      ) VALUES (10, 1, 'p1:旧问题:123', 'P1', '旧问题', '123', '历史问题详情',
                'resolved', '历史状态不得覆盖', '2026-08-21T10:00:00.000Z', 1, 4)`,
    ),
    DB.prepare(
      `INSERT INTO review_issue_events (
        id, issue_id, from_status, to_status, note, created_at
      ) VALUES (20, 10, 'pending_review', 'resolved', '历史复核记录',
                '2026-08-21T10:00:00.000Z')`,
    ),
  ]);
}

describe.sequential('审查生命周期 D1 schema', () => {
  it('迁移创建默认 ZHERP 审查项目和日志归属', async () => {
    expect(await tableColumns('review_projects')).toEqual([
      'id',
      'name',
      'slug',
      'description',
      'display_order',
      'enabled',
      'created_at',
      'updated_at',
    ]);
    expect(
      await DB.prepare(
        `SELECT id, name, slug, description,
                display_order AS displayOrder, enabled
         FROM review_projects`,
      ).first(),
    ).toEqual({
      id: 1,
      name: 'ZHERP',
      slug: 'zherp',
      description: '',
      displayOrder: 0,
      enabled: 1,
    });
    expect(await tableColumns('review_logs')).toContain('project_id');
    expect(await foreignKeyTargets('review_logs')).toContain(
      'review_projects',
    );
  });

  it('部署迁移可升级含历史数据的项目化前数据库', async () => {
    await resetToPreProjectSchema();
    const migration = TEST_MIGRATIONS.find((item) =>
      item.name.startsWith('0003_'),
    );
    expect(migration).toBeDefined();

    await DB.batch(
      migration!.queries.map((query) => DB.prepare(query)),
    );

    expect(
      await DB.prepare(
        `SELECT l.id, p.slug AS projectSlug, l.archived_at AS archivedAt
         FROM review_logs l
         JOIN review_projects p ON p.id = l.project_id
         ORDER BY l.id`,
      ).all(),
    ).toMatchObject({
      results: [
        { id: 1, projectSlug: 'zherp', archivedAt: null },
        {
          id: 2,
          projectSlug: 'zherp',
          archivedAt: '2026-08-23T00:00:00.000Z',
        },
      ],
    });
    expect(
      await DB.prepare('SELECT id FROM review_revisions ORDER BY id').all(),
    ).toMatchObject({ results: [{ id: 30 }] });
    expect(
      await DB.prepare(
        'SELECT id, status, status_note AS statusNote, version FROM review_issues ORDER BY id',
      ).all(),
    ).toMatchObject({
      results: [
        {
          id: 10,
          status: 'resolved',
          statusNote: '历史状态不得覆盖',
          version: 4,
        },
      ],
    });
    expect(
      await DB.prepare('SELECT id FROM review_issue_events ORDER BY id').all(),
    ).toMatchObject({ results: [{ id: 20 }] });
    expect(
      await indexColumns('idx_review_logs_project_source_key'),
    ).toEqual(['project_id', 'source_key']);
    expect(await DB.prepare('PRAGMA foreign_key_check').all()).toMatchObject({
      results: [],
    });
  });

  it('幂等升级项目化前的数据库并完整保留历史数据和原文', async () => {
    await resetToPreProjectSchema();
    await FILES.put(
      'review-logs/2026-08-20/active.md',
      '# 活动日志\n历史原文',
    );
    await FILES.put(
      'review-logs/2026-08-19/archived.md',
      '# 归档日志\n历史原文',
    );

    vi.resetModules();
    const firstUpgrade = await import('../lib/reviews');
    await firstUpgrade.ensureReviewSchema();

    expect(
      await DB.prepare(
        `SELECT l.id, p.slug AS projectSlug, l.source_key AS sourceKey,
                l.source_name AS sourceName, l.source_hash AS sourceHash,
                l.content_object_key AS contentObjectKey, l.sync_mode AS syncMode,
                l.imported_by AS importedBy, l.imported_at AS importedAt,
                l.updated_at AS updatedAt, l.archived_at AS archivedAt
         FROM review_logs l
         JOIN review_projects p ON p.id = l.project_id
         ORDER BY l.id`,
      ).all(),
    ).toEqual({
      success: true,
      meta: expect.any(Object),
      results: [
        {
          id: 1,
          projectSlug: 'zherp',
          sourceKey: 'legacy/active.md',
          sourceName: 'active.md',
          sourceHash: 'active-hash',
          contentObjectKey: 'review-logs/2026-08-20/active.md',
          syncMode: 'automation',
          importedBy: 'legacy-importer',
          importedAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-21T00:00:00.000Z',
          archivedAt: null,
        },
        {
          id: 2,
          projectSlug: 'zherp',
          sourceKey: 'legacy/archived.md',
          sourceName: 'archived.md',
          sourceHash: 'archived-hash',
          contentObjectKey: 'review-logs/2026-08-19/archived.md',
          syncMode: 'manual',
          importedBy: 'admin@example.com',
          importedAt: '2026-08-19T00:00:00.000Z',
          updatedAt: '2026-08-22T00:00:00.000Z',
          archivedAt: '2026-08-23T00:00:00.000Z',
        },
      ],
    });
    expect(
      await DB.prepare(
        `SELECT r.id, r.revision, r.author, p.slug AS projectSlug
         FROM review_revisions r
         JOIN review_logs l ON l.id = r.review_id
         JOIN review_projects p ON p.id = l.project_id`,
      ).first(),
    ).toEqual({ id: 30, revision: 123, author: 'alice', projectSlug: 'zherp' });
    expect(
      await DB.prepare(
        `SELECT i.id, i.status, i.status_note AS statusNote, i.version,
                e.id AS eventId, e.note, p.slug AS projectSlug
         FROM review_issues i
         JOIN review_issue_events e ON e.issue_id = i.id
         JOIN review_logs l ON l.id = i.review_id
         JOIN review_projects p ON p.id = l.project_id`,
      ).first(),
    ).toEqual({
      id: 10,
      status: 'resolved',
      statusNote: '历史状态不得覆盖',
      version: 4,
      eventId: 20,
      note: '历史复核记录',
      projectSlug: 'zherp',
    });
    expect(
      await FILES.get('review-logs/2026-08-20/active.md').then((object) =>
        object?.text(),
      ),
    ).toBe('# 活动日志\n历史原文');

    expect((await firstUpgrade.getReviewPage(1)).items.map((item) => item.id)).toEqual([1]);
    expect(
      (await firstUpgrade.getReviewPage(1, { scope: 'archived' })).items.map(
        (item) => item.id,
      ),
    ).toEqual([2]);
    expect((await firstUpgrade.getIssuePage(1)).items.map((item) => item.id)).toEqual([10]);

    vi.resetModules();
    const secondUpgrade = await import('../lib/reviews');
    await secondUpgrade.ensureReviewSchema();
    expect(
      await DB.prepare(
        "SELECT COUNT(*) AS count FROM review_projects WHERE slug = 'zherp'",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await DB.prepare('PRAGMA foreign_key_check').all(),
    ).toMatchObject({ results: [] });
    expect(
      await DB.prepare(
        'SELECT status, status_note AS statusNote, version FROM review_issues WHERE id = 10',
      ).first(),
    ).toEqual({
      status: 'resolved',
      statusNote: '历史状态不得覆盖',
      version: 4,
    });
  });

  it('日志来源只在审查项目内唯一，相同 Revision 和问题可跨项目共存', async () => {
    expect(
      await indexColumns('idx_review_logs_project_source_key'),
    ).toEqual(['project_id', 'source_key']);
    await DB.prepare(
      `INSERT INTO review_projects (
        id, name, slug, description, display_order, enabled
      ) VALUES (2, '第二项目', 'second-project', '', 1, 1)`,
    ).run();
    await DB.prepare(
      `INSERT INTO review_logs (
        project_id, log_date, source_key, source_name, source_hash,
        content_object_key, title, overview, scope_text, revision_count,
        reviewed_count, skipped_count, p1_count, p2_count, p3_count,
        sync_mode, imported_by, imported_at, updated_at, archived_at
      )
      SELECT 2, log_date, source_key, source_name, source_hash,
             content_object_key, title, overview, scope_text, revision_count,
             reviewed_count, skipped_count, p1_count, p2_count, p3_count,
             sync_mode, imported_by, imported_at, updated_at, archived_at
      FROM review_logs WHERE id = 1`,
    ).run();
    const secondReview = await DB.prepare(
      "SELECT id FROM review_logs WHERE project_id = 2 AND source_key = 'legacy/active.md'",
    ).first<{ id: number }>();
    await DB.batch([
      DB.prepare(
        `INSERT INTO review_revisions (
          review_id, revision, author, committed_at, description, conclusion
        ) VALUES (?, 123, 'alice', '2026-08-20T09:00:00.000Z',
                  '另一项目的提交', '已审查')`,
      ).bind(secondReview!.id),
      DB.prepare(
        `INSERT INTO review_issues (
          review_id, issue_key, severity, title, related_revisions, detail
        ) VALUES (?, 'p1:旧问题:123', 'P1', '旧问题', '123', '另一项目的问题')`,
      ).bind(secondReview!.id),
    ]);

    await expect(
      DB.prepare(
        `INSERT INTO review_logs (
          project_id, log_date, source_key, source_name, source_hash,
          content_object_key, title, overview, scope_text, revision_count,
          reviewed_count, skipped_count, p1_count, p2_count, p3_count,
          sync_mode, imported_by, imported_at, updated_at
        )
        SELECT 2, log_date, source_key, source_name, source_hash,
               content_object_key, title, overview, scope_text, revision_count,
               reviewed_count, skipped_count, p1_count, p2_count, p3_count,
               sync_mode, imported_by, imported_at, updated_at
        FROM review_logs WHERE id = 1`,
      ).run(),
    ).rejects.toThrow();
    expect(
      await DB.prepare(
        `SELECT COUNT(*) AS count
         FROM review_revisions r
         JOIN review_logs l ON l.id = r.review_id
         WHERE r.revision = 123 AND l.project_id IN (1, 2)`,
      ).first(),
    ).toEqual({ count: 2 });

    await DB.prepare('DELETE FROM review_projects WHERE id = 2').run();
    expect(await DB.prepare('PRAGMA foreign_key_check').all()).toMatchObject({
      results: [],
    });
  });

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

import { env } from 'cloudflare:workers';
import type { ChatGPTUser } from '@/app/chatgpt-auth';
import {
  type ParsedIssue,
  type ParsedRevision,
  parseReviewMarkdown,
} from '@/lib/review-parser';
import { ISSUE_STATUSES, normalizeIssueKey } from '@/lib/issue-lifecycle';

type SqlValue = string | number | null;

export type ReviewSummary = {
  id: number;
  logDate: string;
  title: string;
  overview: string;
  scopeText: string;
  sourceName: string;
  revisionCount: number;
  reviewedCount: number;
  skippedCount: number;
  p1Count: number;
  p2Count: number;
  p3Count: number;
  syncMode: string;
  importedAt: string;
  updatedAt: string;
};

export type ReviewDetail = ReviewSummary & {
  markdown: string;
  revisions: ParsedRevision[];
  issues: ParsedIssue[];
};

type ReviewRow = ReviewSummary & {
  contentObjectKey: string;
};

type RuntimeEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  REVIEW_SYNC_KEY?: string;
};

const schemaReady = new WeakMap<D1Database, Promise<void>>();

type SchemaColumn = {
  name: string;
};

type IssueIdentityRow = {
  id: number;
  reviewId: number;
  issueKey: string | null;
  severity: string;
  title: string;
  relatedRevisions: string;
};

function getRuntime(): RuntimeEnv {
  const runtime = env as unknown as RuntimeEnv;
  if (!runtime.DB || !runtime.FILES) {
    throw new Error('审查站的数据存储尚未连接。');
  }
  return runtime;
}

export async function ensureReviewSchema(): Promise<void> {
  const { DB } = getRuntime();
  const cached = schemaReady.get(DB);
  if (cached) return cached;

  const ready = (async () => {
    const baseStatements = [
      [
        'CREATE TABLE IF NOT EXISTS review_logs (',
        'id INTEGER PRIMARY KEY AUTOINCREMENT,',
        'log_date TEXT NOT NULL,',
        'source_key TEXT NOT NULL UNIQUE,',
        'source_name TEXT NOT NULL,',
        'source_hash TEXT NOT NULL,',
        'content_object_key TEXT NOT NULL,',
        'title TEXT NOT NULL,',
        'overview TEXT NOT NULL,',
        'scope_text TEXT NOT NULL,',
        'revision_count INTEGER NOT NULL DEFAULT 0,',
        'reviewed_count INTEGER NOT NULL DEFAULT 0,',
        'skipped_count INTEGER NOT NULL DEFAULT 0,',
        'p1_count INTEGER NOT NULL DEFAULT 0,',
        'p2_count INTEGER NOT NULL DEFAULT 0,',
        'p3_count INTEGER NOT NULL DEFAULT 0,',
        'sync_mode TEXT NOT NULL,',
        'imported_by TEXT NOT NULL,',
        'imported_at TEXT NOT NULL,',
        'updated_at TEXT NOT NULL,',
        'archived_at TEXT',
        ')',
      ].join(' '),
      [
        'CREATE TABLE IF NOT EXISTS review_revisions (',
        'id INTEGER PRIMARY KEY AUTOINCREMENT,',
        'review_id INTEGER NOT NULL,',
        'revision INTEGER NOT NULL,',
        'author TEXT NOT NULL,',
        'committed_at TEXT NOT NULL,',
        'description TEXT NOT NULL,',
        'conclusion TEXT NOT NULL,',
        'UNIQUE(review_id, revision),',
        'FOREIGN KEY(review_id) REFERENCES review_logs(id) ON DELETE CASCADE',
        ')',
      ].join(' '),
      [
        'CREATE TABLE IF NOT EXISTS review_issues (',
        'id INTEGER PRIMARY KEY AUTOINCREMENT,',
        'review_id INTEGER NOT NULL,',
        'issue_key TEXT,',
        'severity TEXT NOT NULL,',
        'title TEXT NOT NULL,',
        'related_revisions TEXT NOT NULL,',
        'detail TEXT NOT NULL,',
        `status TEXT NOT NULL DEFAULT '${ISSUE_STATUSES[0]}',`,
        'status_note TEXT,',
        'status_updated_at TEXT,',
        'source_current INTEGER NOT NULL DEFAULT 1,',
        'version INTEGER NOT NULL DEFAULT 0,',
        'FOREIGN KEY(review_id) REFERENCES review_logs(id) ON DELETE CASCADE',
        ')',
      ].join(' '),
      [
        'CREATE TABLE IF NOT EXISTS admin_users (',
        'user_id TEXT PRIMARY KEY,',
        'email TEXT NOT NULL,',
        'display_name TEXT NOT NULL,',
        'created_at TEXT NOT NULL',
        ')',
      ].join(' '),
    ];

    await DB.batch(baseStatements.map((statement) => DB.prepare(statement)));

    const [logColumns, issueColumns] = await Promise.all([
      DB.prepare('PRAGMA table_info(review_logs)').all<SchemaColumn>(),
      DB.prepare('PRAGMA table_info(review_issues)').all<SchemaColumn>(),
    ]);
    const logColumnNames = new Set(
      (logColumns.results ?? []).map((column) => column.name),
    );
    const issueColumnNames = new Set(
      (issueColumns.results ?? []).map((column) => column.name),
    );
    const upgrades: string[] = [];
    if (!logColumnNames.has('archived_at')) {
      upgrades.push('ALTER TABLE review_logs ADD COLUMN archived_at TEXT');
    }
    if (!issueColumnNames.has('issue_key')) {
      upgrades.push('ALTER TABLE review_issues ADD COLUMN issue_key TEXT');
    }
    if (!issueColumnNames.has('status')) {
      upgrades.push(
        `ALTER TABLE review_issues ADD COLUMN status TEXT NOT NULL DEFAULT '${ISSUE_STATUSES[0]}'`,
      );
    }
    if (!issueColumnNames.has('status_note')) {
      upgrades.push('ALTER TABLE review_issues ADD COLUMN status_note TEXT');
    }
    if (!issueColumnNames.has('status_updated_at')) {
      upgrades.push('ALTER TABLE review_issues ADD COLUMN status_updated_at TEXT');
    }
    if (!issueColumnNames.has('source_current')) {
      upgrades.push(
        'ALTER TABLE review_issues ADD COLUMN source_current INTEGER NOT NULL DEFAULT 1',
      );
    }
    if (!issueColumnNames.has('version')) {
      upgrades.push(
        'ALTER TABLE review_issues ADD COLUMN version INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (upgrades.length) {
      await DB.batch(upgrades.map((statement) => DB.prepare(statement)));
    }

    await DB.batch([
      DB.prepare(
        'UPDATE review_issues SET status = ? WHERE status IS NULL OR TRIM(status) = ?',
      ).bind(ISSUE_STATUSES[0], ''),
      DB.prepare(
        'UPDATE review_issues SET source_current = 1 WHERE source_current IS NULL',
      ),
      DB.prepare('UPDATE review_issues SET version = 0 WHERE version IS NULL'),
    ]);
    await backfillIssueKeys(DB);

    const lifecycleStatements = [
      [
        'CREATE TABLE IF NOT EXISTS review_issue_events (',
        'id INTEGER PRIMARY KEY AUTOINCREMENT,',
        'issue_id INTEGER NOT NULL,',
        'from_status TEXT,',
        'to_status TEXT NOT NULL,',
        'note TEXT NOT NULL,',
        'created_at TEXT NOT NULL,',
        'FOREIGN KEY(issue_id) REFERENCES review_issues(id) ON DELETE CASCADE',
        ')',
      ].join(' '),
      [
        'CREATE TABLE IF NOT EXISTS anonymous_update_limits (',
        'client_hash TEXT PRIMARY KEY,',
        'window_started_at TEXT NOT NULL,',
        'request_count INTEGER NOT NULL',
        ')',
      ].join(' '),
      [
        'CREATE TABLE IF NOT EXISTS archive_operation_previews (',
        'token TEXT PRIMARY KEY,',
        'admin_user_id TEXT NOT NULL,',
        'review_ids_json TEXT NOT NULL,',
        'review_count INTEGER NOT NULL,',
        'revision_count INTEGER NOT NULL,',
        'issue_count INTEGER NOT NULL,',
        'created_at TEXT NOT NULL,',
        'expires_at TEXT NOT NULL,',
        'FOREIGN KEY(admin_user_id) REFERENCES admin_users(user_id) ON DELETE CASCADE',
        ')',
      ].join(' '),
      'CREATE INDEX IF NOT EXISTS idx_review_logs_log_date ON review_logs(log_date)',
      'CREATE INDEX IF NOT EXISTS idx_review_logs_severity ON review_logs(p1_count, p2_count)',
      'CREATE INDEX IF NOT EXISTS idx_review_logs_archive_date_id ON review_logs(archived_at, log_date, id)',
      'CREATE INDEX IF NOT EXISTS idx_review_revisions_revision ON review_revisions(revision)',
      'CREATE INDEX IF NOT EXISTS idx_review_revisions_author ON review_revisions(author)',
      'CREATE INDEX IF NOT EXISTS idx_review_issues_review_id ON review_issues(review_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_issues_severity ON review_issues(severity)',
      'CREATE INDEX IF NOT EXISTS idx_review_issues_status_current_review ON review_issues(status, source_current, review_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_issues_review_issue_key ON review_issues(review_id, issue_key) WHERE issue_key IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_review_issue_events_issue_created ON review_issue_events(issue_id, created_at)',
      [
        'CREATE TRIGGER IF NOT EXISTS review_issues_review_fk_insert',
        'BEFORE INSERT ON review_issues',
        'WHEN NOT EXISTS (SELECT 1 FROM review_logs WHERE id = NEW.review_id)',
        "BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END",
      ].join(' '),
      [
        'CREATE TRIGGER IF NOT EXISTS review_issues_review_fk_update',
        'BEFORE UPDATE OF review_id ON review_issues',
        'WHEN NOT EXISTS (SELECT 1 FROM review_logs WHERE id = NEW.review_id)',
        "BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END",
      ].join(' '),
      [
        'CREATE TRIGGER IF NOT EXISTS review_issue_events_issue_fk_insert',
        'BEFORE INSERT ON review_issue_events',
        'WHEN NOT EXISTS (SELECT 1 FROM review_issues WHERE id = NEW.issue_id)',
        "BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END",
      ].join(' '),
      [
        'CREATE TRIGGER IF NOT EXISTS review_issue_events_issue_fk_update',
        'BEFORE UPDATE OF issue_id ON review_issue_events',
        'WHEN NOT EXISTS (SELECT 1 FROM review_issues WHERE id = NEW.issue_id)',
        "BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END",
      ].join(' '),
    ];

    await DB.batch(
      lifecycleStatements.map((statement) => DB.prepare(statement)),
    );
    await ensureReviewSearch(DB);
    await DB.prepare('PRAGMA optimize').run();
  })();

  schemaReady.set(DB, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(DB);
    throw error;
  }
}

async function backfillIssueKeys(DB: D1Database): Promise<void> {
  const result = await DB.prepare(
    `SELECT id, review_id AS reviewId, issue_key AS issueKey,
            severity, title, related_revisions AS relatedRevisions
     FROM review_issues
     ORDER BY review_id, id`,
  ).all<IssueIdentityRow>();
  const usedKeys = new Set<string>();
  const updates: D1PreparedStatement[] = [];

  for (const issue of result.results ?? []) {
    const prefix = `${issue.reviewId}:`;
    const currentKey = issue.issueKey?.trim() ?? '';
    const baseKey =
      currentKey ||
      normalizeIssueKey(
        `${issue.severity}:${issue.title}:${issue.relatedRevisions}`,
      );
    let issueKey = baseKey;
    if (usedKeys.has(prefix + issueKey)) {
      issueKey = `${baseKey}:${issue.id}`;
    }
    usedKeys.add(prefix + issueKey);

    if (issue.issueKey !== issueKey) {
      updates.push(
        DB.prepare('UPDATE review_issues SET issue_key = ? WHERE id = ?').bind(
          issueKey,
          issue.id,
        ),
      );
    }
  }

  if (updates.length) await DB.batch(updates);
}

async function ensureReviewSearch(DB: D1Database): Promise<void> {
  const searchColumns = [
    'review_id UNINDEXED',
    'title',
    'overview',
    'scope_text',
    'revisions',
    'authors',
    'descriptions',
    'issue_titles',
    'issue_details',
    'status_notes',
  ].join(', ');
  await DB.prepare(
    `CREATE VIRTUAL TABLE IF NOT EXISTS review_search USING fts5(${searchColumns}, tokenize='trigram')`,
  ).run();
  await rebuildReviewSearch(DB);

  const rebuildNewReview = reviewSearchTriggerBody('NEW.id');
  const rebuildNewRevisionReview = reviewSearchTriggerBody('NEW.review_id');
  const rebuildOldRevisionReview = reviewSearchTriggerBody('OLD.review_id');
  const triggers = [
    `CREATE TRIGGER IF NOT EXISTS review_search_logs_ai AFTER INSERT ON review_logs BEGIN ${rebuildNewReview} END`,
    `CREATE TRIGGER IF NOT EXISTS review_search_logs_au AFTER UPDATE ON review_logs BEGIN ${rebuildNewReview} END`,
    `CREATE TRIGGER IF NOT EXISTS review_search_logs_ad AFTER DELETE ON review_logs BEGIN DELETE FROM review_search WHERE rowid = OLD.id; END`,
    `CREATE TRIGGER IF NOT EXISTS review_search_revisions_ai AFTER INSERT ON review_revisions BEGIN ${rebuildNewRevisionReview} END`,
    `CREATE TRIGGER IF NOT EXISTS review_search_revisions_au AFTER UPDATE ON review_revisions BEGIN ${rebuildOldRevisionReview} ${rebuildNewRevisionReview} END`,
    `CREATE TRIGGER IF NOT EXISTS review_search_revisions_ad AFTER DELETE ON review_revisions BEGIN ${rebuildOldRevisionReview} END`,
    `CREATE TRIGGER IF NOT EXISTS review_search_issues_ai AFTER INSERT ON review_issues BEGIN ${rebuildNewRevisionReview} END`,
    `CREATE TRIGGER IF NOT EXISTS review_search_issues_au AFTER UPDATE ON review_issues BEGIN ${rebuildOldRevisionReview} ${rebuildNewRevisionReview} END`,
    `CREATE TRIGGER IF NOT EXISTS review_search_issues_ad AFTER DELETE ON review_issues BEGIN ${rebuildOldRevisionReview} END`,
  ];
  await DB.batch(triggers.map((statement) => DB.prepare(statement)));
}

async function rebuildReviewSearch(DB: D1Database): Promise<void> {
  await DB.batch([
    DB.prepare('DELETE FROM review_search'),
    DB.prepare(reviewSearchInsertSql()),
  ]);
}

function reviewSearchTriggerBody(reviewId: string): string {
  return [
    `DELETE FROM review_search WHERE rowid = ${reviewId};`,
    reviewSearchInsertSql(`l.id = ${reviewId}`) + ';',
  ].join(' ');
}

function reviewSearchInsertSql(where?: string): string {
  return [
    'INSERT INTO review_search (',
    'rowid, review_id, title, overview, scope_text, revisions, authors,',
    'descriptions, issue_titles, issue_details, status_notes',
    ')',
    'SELECT l.id, l.id, l.title, l.overview, l.scope_text,',
    "COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),",
    "COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),",
    "COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),",
    "COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),",
    "COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),",
    "COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')",
    'FROM review_logs l',
    where ? `WHERE ${where}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function all<T>(
  statement: string,
  values: SqlValue[] = [],
): Promise<T[]> {
  await ensureReviewSchema();
  const { DB } = getRuntime();
  const result = await DB.prepare(statement).bind(...values).all<T>();
  return result.results ?? [];
}

async function first<T>(
  statement: string,
  values: SqlValue[] = [],
): Promise<T | null> {
  await ensureReviewSchema();
  const { DB } = getRuntime();
  return (await DB.prepare(statement).bind(...values).first<T>()) ?? null;
}

export async function getReviewSummaries(): Promise<ReviewSummary[]> {
  return all<ReviewSummary>(
    [
      'SELECT id, log_date AS logDate, title, overview,',
      'scope_text AS scopeText, source_name AS sourceName,',
      'revision_count AS revisionCount, reviewed_count AS reviewedCount,',
      'skipped_count AS skippedCount, p1_count AS p1Count,',
      'p2_count AS p2Count, p3_count AS p3Count,',
      'sync_mode AS syncMode, imported_at AS importedAt,',
      'updated_at AS updatedAt',
      'FROM review_logs',
      'ORDER BY log_date DESC, id DESC',
    ].join(' '),
  );
}

export async function getReviewDetail(id: number): Promise<ReviewDetail | null> {
  const review = await first<ReviewRow>(
    [
      'SELECT id, log_date AS logDate, title, overview,',
      'scope_text AS scopeText, source_name AS sourceName,',
      'content_object_key AS contentObjectKey,',
      'revision_count AS revisionCount, reviewed_count AS reviewedCount,',
      'skipped_count AS skippedCount, p1_count AS p1Count,',
      'p2_count AS p2Count, p3_count AS p3Count,',
      'sync_mode AS syncMode, imported_at AS importedAt,',
      'updated_at AS updatedAt',
      'FROM review_logs WHERE id = ?',
    ].join(' '),
    [id],
  );
  if (!review) return null;

  const [revisions, issues, object] = await Promise.all([
    all<ParsedRevision>(
      [
        'SELECT revision, author, committed_at AS committedAt,',
        'description, conclusion',
        'FROM review_revisions WHERE review_id = ? ORDER BY revision',
      ].join(' '),
      [id],
    ),
    all<ParsedIssue>(
      [
        'SELECT severity, title, related_revisions AS relatedRevisions, detail',
        'FROM review_issues WHERE review_id = ?',
        "ORDER BY CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, id",
      ].join(' '),
      [id],
    ),
    getRuntime().FILES.get(review.contentObjectKey),
  ]);

  return {
    ...review,
    revisions,
    issues,
    markdown: object ? await object.text() : '',
  };
}

export async function getReviewMarkdown(id: number): Promise<{
  content: string;
  sourceName: string;
} | null> {
  const review = await first<Pick<ReviewRow, 'sourceName' | 'contentObjectKey'>>(
    'SELECT source_name AS sourceName, content_object_key AS contentObjectKey FROM review_logs WHERE id = ?',
    [id],
  );
  if (!review) return null;

  const object = await getRuntime().FILES.get(review.contentObjectKey);
  if (!object) return null;
  return { content: await object.text(), sourceName: review.sourceName };
}

type IngestInput = {
  markdown: string;
  sourceKey: string;
  sourceName: string;
  importedBy: string;
  syncMode: 'automation' | 'manual';
};

export async function ingestReview(input: IngestInput): Promise<ReviewSummary> {
  const markdown = input.markdown.replace(/^\uFEFF/, '');
  if (!markdown.trim()) throw new Error('日志文件为空。');
  if (new TextEncoder().encode(markdown).byteLength > 2_000_000) {
    throw new Error('日志文件超过 2MB 限制。');
  }

  const parsed = parseReviewMarkdown(markdown);
  if (!parsed.logDate) {
    throw new Error('未识别到“日期：YYYY-MM-DD”字段，不能作为审查日志导入。');
  }

  const sourceKey = input.sourceKey.trim().slice(0, 500);
  if (!sourceKey) throw new Error('日志来源标识不能为空。');

  const sourceName = input.sourceName.trim().slice(0, 255) || 'svn审查日志.md';
  const now = new Date().toISOString();
  const sourceHash = await sha256(markdown);
  const contentObjectKey =
    'review-logs/' + parsed.logDate + '/' + sourceHash + '.md';
  const { DB, FILES } = getRuntime();

  await FILES.put(contentObjectKey, markdown, {
    httpMetadata: {
      contentType: 'text/markdown; charset=utf-8',
    },
    customMetadata: {
      logDate: parsed.logDate,
      sourceName,
    },
  });

  const existing = await first<{ id: number }>(
    'SELECT id FROM review_logs WHERE source_key = ?',
    [sourceKey],
  );
  let reviewId: number;

  if (existing) {
    reviewId = existing.id;
    await DB.batch([
      DB.prepare('DELETE FROM review_revisions WHERE review_id = ?').bind(reviewId),
      DB.prepare('DELETE FROM review_issues WHERE review_id = ?').bind(reviewId),
      DB.prepare(
        [
          'UPDATE review_logs SET log_date = ?, source_name = ?,',
          'source_hash = ?, content_object_key = ?, title = ?, overview = ?,',
          'scope_text = ?, revision_count = ?, reviewed_count = ?,',
          'skipped_count = ?, p1_count = ?, p2_count = ?, p3_count = ?,',
          'sync_mode = ?, imported_by = ?, updated_at = ? WHERE id = ?',
        ].join(' '),
      ).bind(
        parsed.logDate,
        sourceName,
        sourceHash,
        contentObjectKey,
        parsed.title,
        parsed.overview,
        parsed.scopeText,
        parsed.revisionCount,
        parsed.reviewedCount,
        parsed.skippedCount,
        parsed.p1Count,
        parsed.p2Count,
        parsed.p3Count,
        input.syncMode,
        input.importedBy.slice(0, 255),
        now,
        reviewId,
      ),
    ]);
  } else {
    const result = await DB.prepare(
      [
        'INSERT INTO review_logs (',
        'log_date, source_key, source_name, source_hash, content_object_key,',
        'title, overview, scope_text, revision_count, reviewed_count, skipped_count,',
        'p1_count, p2_count, p3_count, sync_mode, imported_by, imported_at, updated_at',
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join(' '),
    )
      .bind(
        parsed.logDate,
        sourceKey,
        sourceName,
        sourceHash,
        contentObjectKey,
        parsed.title,
        parsed.overview,
        parsed.scopeText,
        parsed.revisionCount,
        parsed.reviewedCount,
        parsed.skippedCount,
        parsed.p1Count,
        parsed.p2Count,
        parsed.p3Count,
        input.syncMode,
        input.importedBy.slice(0, 255),
        now,
        now,
      )
      .run();
    reviewId = Number(result.meta.last_row_id);
  }

  if (parsed.revisions.length) {
    await DB.batch(
      parsed.revisions.map((revision) =>
        DB.prepare(
          [
            'INSERT INTO review_revisions (',
            'review_id, revision, author, committed_at, description, conclusion',
            ') VALUES (?, ?, ?, ?, ?, ?)',
          ].join(' '),
        ).bind(
          reviewId,
          revision.revision,
          revision.author,
          revision.committedAt,
          revision.description,
          revision.conclusion,
        ),
      ),
    );
  }

  if (parsed.issues.length) {
    await DB.batch(
      parsed.issues.map((issue) =>
        DB.prepare(
          [
            'INSERT INTO review_issues (',
            'review_id, severity, title, related_revisions, detail',
            ') VALUES (?, ?, ?, ?, ?)',
          ].join(' '),
        ).bind(
          reviewId,
          issue.severity,
          issue.title,
          issue.relatedRevisions,
          issue.detail,
        ),
      ),
    );
  }

  const review = await first<ReviewSummary>(
    [
      'SELECT id, log_date AS logDate, title, overview,',
      'scope_text AS scopeText, source_name AS sourceName,',
      'revision_count AS revisionCount, reviewed_count AS reviewedCount,',
      'skipped_count AS skippedCount, p1_count AS p1Count,',
      'p2_count AS p2Count, p3_count AS p3Count,',
      'sync_mode AS syncMode, imported_at AS importedAt,',
      'updated_at AS updatedAt',
      'FROM review_logs WHERE id = ?',
    ].join(' '),
    [reviewId],
  );
  if (!review) throw new Error('日志已写入，但未能读取导入结果。');
  return review;
}

export async function allowAdministrator(user: ChatGPTUser): Promise<boolean> {
  await ensureReviewSchema();
  const { DB } = getRuntime();
  const existing = await first<{ userId: string }>(
    'SELECT user_id AS userId FROM admin_users WHERE user_id = ?',
    [user.userId],
  );
  if (existing) return true;

  const count = await first<{ count: number }>(
    'SELECT COUNT(*) AS count FROM admin_users',
  );
  if ((count?.count ?? 0) !== 0) return false;

  await DB.prepare(
    'INSERT OR IGNORE INTO admin_users (user_id, email, display_name, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(user.userId, user.email, user.displayName, new Date().toISOString())
    .run();

  return Boolean(
    await first<{ userId: string }>(
      'SELECT user_id AS userId FROM admin_users WHERE user_id = ?',
      [user.userId],
    ),
  );
}

export function isSyncRequestAuthorized(request: Request): boolean {
  const expected = getRuntime().REVIEW_SYNC_KEY;
  return Boolean(expected && request.headers.get('x-review-sync-key') === expected);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

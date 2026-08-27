import { env } from 'cloudflare:workers';
import type { ChatGPTUser } from '@/app/chatgpt-auth';
import {
  type ParsedIssue,
  type ParsedRevision,
  parseReviewMarkdown,
} from '@/lib/review-parser';

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
    const statements = [
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
        'updated_at TEXT NOT NULL',
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
        'UNIQUE(review_id, revision)',
        ')',
      ].join(' '),
      [
        'CREATE TABLE IF NOT EXISTS review_issues (',
        'id INTEGER PRIMARY KEY AUTOINCREMENT,',
        'review_id INTEGER NOT NULL,',
        'severity TEXT NOT NULL,',
        'title TEXT NOT NULL,',
        'related_revisions TEXT NOT NULL,',
        'detail TEXT NOT NULL',
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
      'CREATE INDEX IF NOT EXISTS idx_review_logs_log_date ON review_logs(log_date)',
      'CREATE INDEX IF NOT EXISTS idx_review_logs_severity ON review_logs(p1_count, p2_count)',
      'CREATE INDEX IF NOT EXISTS idx_review_revisions_revision ON review_revisions(revision)',
      'CREATE INDEX IF NOT EXISTS idx_review_revisions_author ON review_revisions(author)',
      'CREATE INDEX IF NOT EXISTS idx_review_issues_review_id ON review_issues(review_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_issues_severity ON review_issues(severity)',
    ];

    await DB.batch(statements.map((statement) => DB.prepare(statement)));
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

import { env } from 'cloudflare:workers';
import type { ChatGPTUser } from '@/app/chatgpt-auth';
import {
  type ParsedIssue,
  type ParsedRevision,
  normalizeRelatedRevisions,
  parseReviewMarkdown,
  parseReviewScopeCounts,
  reviewScopeDeclaresZeroRevisions,
} from '@/lib/review-parser';
import {
  ISSUE_STATUS_LABELS,
  ISSUE_STATUSES,
  type IssueStatus,
  normalizeIssueKey,
} from '@/lib/issue-lifecycle';
import * as XLSX from 'xlsx-js-style';
import {
  decodePageCursor,
  encodePageCursor,
  normalizePageSize,
  type PageResult,
} from '@/lib/review-query';

export type { PageResult } from '@/lib/review-query';

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
  archivedAt: string | null;
};

export type ReviewScope = 'active' | 'archived';

export type ReviewProject = {
  id: number;
  name: string;
  slug: string;
  description: string;
  displayOrder: number;
  enabled: boolean;
};

export type ReviewProjectDirectoryItem = Omit<ReviewProject, 'enabled'> & {
  latestReviewDate: string | null;
  openIssueCount: number;
  highRiskCount: number;
  latestAutomationSyncAt: string | null;
  syncStatus: 'waiting' | 'manual_only' | 'healthy' | 'attention';
};

export type ReviewListFilters = {
  scope?: ReviewScope;
  fromDate?: string;
  toDate?: string;
  author?: string;
  revision?: number;
  severity?: ParsedIssue['severity'];
  severities?: ParsedIssue['severity'][];
  status?: IssueStatus;
  keyword?: string;
  cursor?: string;
  limit?: number;
};

export type IssueListFilters = ReviewListFilters & { statuses?: IssueStatus[] };

export type ReviewIssueSummary = {
  id: number;
  reviewId: number;
  issueKey: string | null;
  severity: ParsedIssue['severity'];
  title: string;
  relatedRevisions: string;
  status: IssueStatus;
  statusNote: string | null;
  statusUpdatedAt: string | null;
  sourceCurrent: number;
  version: number;
  logDate: string;
  reviewTitle: string;
  authors: string;
};

export type ReviewDetail = ReviewSummary & {
  markdown: string;
  revisions: ParsedRevision[];
  issues: Array<ParsedIssue & Pick<ReviewIssueSummary, 'id' | 'status' | 'statusNote' | 'statusUpdatedAt' | 'version'> & { events: IssueEvent[] }>;
};

export type IssueEvent = { id: number; issueId: number; fromStatus: IssueStatus | null; toStatus: IssueStatus; note: string; createdAt: string };
export type CurrentReviewStats = { reviewCount: number; openIssueCount: number; pendingReviewCount: number; highRiskCount: number };

export type SyncHealth = {
  latestAutomationSyncAt: string | null;
  latestLogDate: string | null;
  latestRevision: number | null;
  reviewCount: number;
  currentIssueCount: number;
  pendingIssueCount: number;
  parseFailure: boolean;
  zeroIssueWarning: boolean;
};

export type ReviewExportRow = {
  issueKey: string;
  status: string;
  statusNote: string;
  updatedAt: string;
  severity: string;
  title: string;
  revision: string;
  author: string;
  logDate: string;
  sourceName: string;
  detailUrl: string;
};

const EXPORT_MAX_ROWS = 1000;
const DEFAULT_REVIEW_PROJECT_ID = 1;
const DEFAULT_REVIEW_PROJECT_SLUG = 'zherp';

export type ReviewIngestionResult = ReviewSummary & {
  ingestion: {
    createdIssueCount: number;
    updatedIssueCount: number;
    parsedIssueCount: number;
  };
};

type ReviewRow = ReviewSummary & {
  contentObjectKey: string;
};

type RuntimeEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  REVIEW_SYNC_KEY?: string;
  REVIEW_SYNC_MASTER_KEY?: string;
};

export type ReviewProjectIdentity = {
  id: number;
  slug: string;
};

export function isValidReviewProjectSlug(value: string): boolean {
  return /^[a-z0-9-]+$/.test(value);
}

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

const LEGACY_SYNC_KEY_ENVELOPE_VERSION = 'v1';
const SYNC_KEY_ENVELOPE_VERSION = 'v2';

export async function encryptProjectSyncKey(
  project: ReviewProjectIdentity,
  plaintext: string,
): Promise<string> {
  return encryptProjectSyncKeyVersion(project, plaintext, SYNC_KEY_ENVELOPE_VERSION);
}

async function encryptProjectSyncKeyVersion(
  project: ReviewProjectIdentity,
  plaintext: string,
  version: typeof LEGACY_SYNC_KEY_ENVELOPE_VERSION | typeof SYNC_KEY_ENVELOPE_VERSION,
): Promise<string> {
  if (!plaintext) throw new Error('项目同步密钥不能为空。');
  const key = await importSyncMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: syncKeyAdditionalData(project, version),
    },
    key,
    new TextEncoder().encode(plaintext),
  );
  return [
    version,
    encodeBase64(iv),
    encodeBase64(new Uint8Array(encrypted)),
  ].join('.');
}

export async function decryptProjectSyncKey(
  project: ReviewProjectIdentity,
  envelope: string,
): Promise<string> {
  const [version, ivValue, ciphertextValue, extra] = envelope.split('.');
  if (
    (version !== LEGACY_SYNC_KEY_ENVELOPE_VERSION && version !== SYNC_KEY_ENVELOPE_VERSION) ||
    !ivValue ||
    !ciphertextValue ||
    extra !== undefined
  ) {
    throw new Error('项目同步密钥密文格式无效。');
  }
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decodeBase64(ivValue),
        additionalData: syncKeyAdditionalData(project, version),
      },
      await importSyncMasterKey(),
      decodeBase64(ciphertextValue),
    );
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    throw new Error('项目同步密钥无法解密，请检查站点主密钥配置。', {
      cause: error,
    });
  }
}

async function importSyncMasterKey(): Promise<CryptoKey> {
  const encoded = getRuntime().REVIEW_SYNC_MASTER_KEY?.trim();
  if (!encoded) throw new Error('站点未配置项目同步主密钥。');
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = decodeBase64(encoded);
  } catch (error) {
    throw new Error('项目同步主密钥必须是有效的 Base64。', { cause: error });
  }
  if (raw.byteLength !== 32) {
    throw new Error('项目同步主密钥解码后必须是 32 字节。');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

function syncKeyAdditionalData(
  project: ReviewProjectIdentity,
  version: typeof LEGACY_SYNC_KEY_ENVELOPE_VERSION | typeof SYNC_KEY_ENVELOPE_VERSION,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    version === LEGACY_SYNC_KEY_ENVELOPE_VERSION
      ? `review-project-sync-key:v1:${project.id}:${project.slug}`
      : `review-project-sync-key:v2:${project.slug}`,
  );
}

export function generateProjectSyncKey(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function maskProjectSyncKey(value: string): string {
  return value.length > 7 ? `${value.slice(0, 3)}***${value.slice(-4)}` : '***';
}

function encodeBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const decoded = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded;
}

async function ensureLegacySyncKeyMigrated(DB: D1Database): Promise<void> {
  const legacyKey = getRuntime().REVIEW_SYNC_KEY?.trim();
  if (!legacyKey) return;
  const project = await DB.prepare(
    `SELECT id, slug, sync_key_encrypted AS syncKeyEncrypted
     FROM review_projects WHERE slug = ?`,
  )
    .bind(DEFAULT_REVIEW_PROJECT_SLUG)
    .first<ReviewProjectIdentity & { syncKeyEncrypted: string | null }>();
  if (!project || project.syncKeyEncrypted) return;

  const encrypted = await encryptProjectSyncKeyVersion(
    project,
    legacyKey,
    LEGACY_SYNC_KEY_ENVELOPE_VERSION,
  );
  await DB.prepare(
    `UPDATE review_projects SET sync_key_encrypted = ?, updated_at = ?
     WHERE id = ? AND sync_key_encrypted IS NULL`,
  )
    .bind(encrypted, new Date().toISOString(), project.id)
    .run();
}

export async function authorizeProjectSync(
  projectSlug: string,
  presentedKey: string,
): Promise<ReviewProjectIdentity | null> {
  if (!projectSlug.trim() || !presentedKey) return null;
  await ensureReviewSchema();
  const { DB } = getRuntime();
  await ensureLegacySyncKeyMigrated(DB);
  const project = await DB.prepare(
    `SELECT id, slug, sync_key_encrypted AS syncKeyEncrypted
     FROM review_projects
     WHERE slug = ? AND enabled = 1`,
  )
    .bind(projectSlug.trim())
    .first<ReviewProjectIdentity & { syncKeyEncrypted: string | null }>();
  if (!project?.syncKeyEncrypted) return null;

  const expected = await decryptProjectSyncKey(project, project.syncKeyEncrypted);
  const [expectedDigest, presentedDigest] = await Promise.all([
    sha256Bytes(expected),
    sha256Bytes(presentedKey),
  ]);
  let mismatch = expectedDigest.byteLength ^ presentedDigest.byteLength;
  const length = Math.max(expectedDigest.byteLength, presentedDigest.byteLength);
  for (let index = 0; index < length; index += 1) {
    mismatch |=
      (expectedDigest[index] ?? 0) ^ (presentedDigest[index] ?? 0);
  }
  return mismatch === 0 ? { id: project.id, slug: project.slug } : null;
}

function reviewLogsTableSql(tableName: string, ifNotExists = false): string {
  return [
    `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (`,
    'id INTEGER PRIMARY KEY AUTOINCREMENT,',
    `project_id INTEGER NOT NULL DEFAULT ${DEFAULT_REVIEW_PROJECT_ID},`,
    'log_date TEXT NOT NULL,',
    'source_key TEXT NOT NULL,',
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
    'archived_at TEXT,',
    'FOREIGN KEY(project_id) REFERENCES review_projects(id) ON DELETE CASCADE',
    ')',
  ].join(' ');
}

function reviewRevisionsTableSql(
  tableName: string,
  ifNotExists = false,
): string {
  return [
    `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (`,
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
  ].join(' ');
}

function reviewIssuesTableSql(
  tableName: string,
  ifNotExists = false,
): string {
  return [
    `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (`,
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
  ].join(' ');
}

function reviewIssueEventsTableSql(
  tableName: string,
  ifNotExists = false,
): string {
  return [
    `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (`,
    'id INTEGER PRIMARY KEY AUTOINCREMENT,',
    'issue_id INTEGER NOT NULL,',
    'from_status TEXT,',
    'to_status TEXT NOT NULL,',
    'note TEXT NOT NULL,',
    'created_at TEXT NOT NULL,',
    'anonymous_source_hash TEXT,',
    'FOREIGN KEY(issue_id) REFERENCES review_issues(id) ON DELETE CASCADE',
    ')',
  ].join(' ');
}

export async function ensureReviewSchema(): Promise<void> {
  const { DB } = getRuntime();
  const cached = schemaReady.get(DB);
  if (cached) return cached;

  const ready = (async () => {
    const baseStatements = [
      [
        'CREATE TABLE IF NOT EXISTS review_projects (',
        'id INTEGER PRIMARY KEY AUTOINCREMENT,',
        'name TEXT NOT NULL,',
        'slug TEXT NOT NULL,',
        "description TEXT NOT NULL DEFAULT '',",
        'display_order INTEGER NOT NULL DEFAULT 0,',
        'enabled INTEGER NOT NULL DEFAULT 1,',
        'sync_key_encrypted TEXT,',
        'created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
        ')',
      ].join(' '),
      reviewLogsTableSql('review_logs', true),
      reviewRevisionsTableSql('review_revisions', true),
      reviewIssuesTableSql('review_issues', true),
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

    await DB.prepare(
      `INSERT OR IGNORE INTO review_projects
         (id, name, slug, description, display_order, enabled)
       VALUES (?, 'ZHERP', ?, '', 0, 1)`,
    )
      .bind(DEFAULT_REVIEW_PROJECT_ID, DEFAULT_REVIEW_PROJECT_SLUG)
      .run();

    const [projectColumns, logColumns, issueColumns, eventColumns] = await Promise.all([
      DB.prepare('PRAGMA table_info(review_projects)').all<SchemaColumn>(),
      DB.prepare('PRAGMA table_info(review_logs)').all<SchemaColumn>(),
      DB.prepare('PRAGMA table_info(review_issues)').all<SchemaColumn>(),
      DB.prepare('PRAGMA table_info(review_issue_events)').all<SchemaColumn>(),
    ]);
    const projectColumnNames = new Set(
      (projectColumns.results ?? []).map((column) => column.name),
    );
    const logColumnNames = new Set(
      (logColumns.results ?? []).map((column) => column.name),
    );
    const issueColumnNames = new Set(
      (issueColumns.results ?? []).map((column) => column.name),
    );
    const eventColumnNames = new Set(
      (eventColumns.results ?? []).map((column) => column.name),
    );
    const needsProjectMigration = !logColumnNames.has('project_id');
    const upgrades: string[] = [];
    if (!projectColumnNames.has('sync_key_encrypted')) {
      upgrades.push(
        'ALTER TABLE review_projects ADD COLUMN sync_key_encrypted TEXT',
      );
    }
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
    if (
      eventColumnNames.size > 0 &&
      !eventColumnNames.has('anonymous_source_hash')
    ) {
      upgrades.push(
        'ALTER TABLE review_issue_events ADD COLUMN anonymous_source_hash TEXT',
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

    const lifecycleTableStatements = [
      reviewIssueEventsTableSql('review_issue_events', true),
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
      [
        'CREATE TABLE IF NOT EXISTS project_admin_audits (',
        'id INTEGER PRIMARY KEY AUTOINCREMENT,',
        'project_id_snapshot INTEGER,',
        'project_slug_snapshot TEXT,',
        'project_name_snapshot TEXT,',
        'project_snapshot_json TEXT NOT NULL,',
        'admin_user_id TEXT NOT NULL,',
        'admin_email_snapshot TEXT NOT NULL,',
        'admin_display_name_snapshot TEXT NOT NULL,',
        'action TEXT NOT NULL,',
        'result TEXT NOT NULL,',
        'failure_code TEXT,',
        'created_at TEXT NOT NULL',
        ')',
      ].join(' '),
      [
        'CREATE TABLE IF NOT EXISTS review_object_cleanup_queue (',
        'object_key TEXT PRIMARY KEY,',
        'created_at TEXT NOT NULL,',
        'ready INTEGER NOT NULL DEFAULT 1',
        ')',
      ].join(' '),
      [
        'CREATE TABLE IF NOT EXISTS project_deletion_operations (',
        'project_id INTEGER PRIMARY KEY,',
        'project_slug_snapshot TEXT NOT NULL,',
        'project_name_snapshot TEXT NOT NULL,',
        'project_snapshot_json TEXT NOT NULL,',
        'started_at TEXT NOT NULL,',
        'claim_token TEXT,',
        'claim_expires_at TEXT',
        ')',
      ].join(' '),
    ];

    await DB.batch(
      lifecycleTableStatements.map((statement) => DB.prepare(statement)),
    );
    if (needsProjectMigration) {
      await rebuildReviewStorageWithProject(DB);
    }

    const integrityStatements = [
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_projects_name ON review_projects(name COLLATE NOCASE)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_projects_slug ON review_projects(slug)',
      'CREATE INDEX IF NOT EXISTS idx_review_projects_directory ON review_projects(enabled, display_order, id)',
      'DROP INDEX IF EXISTS idx_review_logs_source_key',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_logs_project_source_key ON review_logs(project_id, source_key)',
      'CREATE INDEX IF NOT EXISTS idx_review_logs_project_id ON review_logs(project_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_logs_content_object_key ON review_logs(content_object_key)',
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
      'CREATE INDEX IF NOT EXISTS idx_project_admin_audits_time ON project_admin_audits(created_at, id)',
      'CREATE INDEX IF NOT EXISTS idx_project_admin_audits_project ON project_admin_audits(project_slug_snapshot, created_at, id)',
      'CREATE INDEX IF NOT EXISTS idx_project_admin_audits_admin ON project_admin_audits(admin_user_id, created_at, id)',
      'CREATE INDEX IF NOT EXISTS idx_project_admin_audits_action ON project_admin_audits(action, created_at, id)',
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
      integrityStatements.map((statement) => DB.prepare(statement)),
    );
    await ensureReviewSearch(DB);
    await ensureLegacySyncKeyMigrated(DB);
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

async function rebuildReviewStorageWithProject(DB: D1Database): Promise<void> {
  const revisionBackup = '__review_revisions_before_project';
  const issueBackup = '__review_issues_before_project';
  const eventBackup = '__review_issue_events_before_project';
  const replacementLogs = '__review_logs_with_project';
  await DB.batch([
    DB.prepare(`DROP TABLE IF EXISTS ${revisionBackup}`),
    DB.prepare(`DROP TABLE IF EXISTS ${issueBackup}`),
    DB.prepare(`DROP TABLE IF EXISTS ${eventBackup}`),
    DB.prepare(`DROP TABLE IF EXISTS ${replacementLogs}`),
    DB.prepare(
      `CREATE TABLE ${revisionBackup} AS SELECT * FROM review_revisions`,
    ),
    DB.prepare(`CREATE TABLE ${issueBackup} AS SELECT * FROM review_issues`),
    DB.prepare(
      `CREATE TABLE ${eventBackup} AS SELECT * FROM review_issue_events`,
    ),
    DB.prepare('DROP TABLE review_issue_events'),
    DB.prepare('DROP TABLE review_issues'),
    DB.prepare('DROP TABLE review_revisions'),
    DB.prepare(reviewLogsTableSql(replacementLogs)),
    DB.prepare(
      `INSERT INTO ${replacementLogs} (
         id, project_id, log_date, source_key, source_name, source_hash,
         content_object_key, title, overview, scope_text, revision_count,
         reviewed_count, skipped_count, p1_count, p2_count, p3_count,
         sync_mode, imported_by, imported_at, updated_at, archived_at
       )
       SELECT id, ?, log_date, source_key, source_name, source_hash,
              content_object_key, title, overview, scope_text, revision_count,
              reviewed_count, skipped_count, p1_count, p2_count, p3_count,
              sync_mode, imported_by, imported_at, updated_at, archived_at
       FROM review_logs`,
    ).bind(DEFAULT_REVIEW_PROJECT_ID),
    DB.prepare('DROP TABLE review_logs'),
    DB.prepare(`ALTER TABLE ${replacementLogs} RENAME TO review_logs`),
    DB.prepare(reviewRevisionsTableSql('review_revisions')),
    DB.prepare(
      `INSERT INTO review_revisions (
         id, review_id, revision, author, committed_at, description, conclusion
       )
       SELECT id, review_id, revision, author, committed_at, description,
              conclusion
       FROM ${revisionBackup}`,
    ),
    DB.prepare(reviewIssuesTableSql('review_issues')),
    DB.prepare(
      `INSERT INTO review_issues (
         id, review_id, issue_key, severity, title, related_revisions, detail,
         status, status_note, status_updated_at, source_current, version
       )
       SELECT id, review_id, issue_key, severity, title, related_revisions,
              detail, status, status_note, status_updated_at, source_current,
              version
       FROM ${issueBackup}`,
    ),
    DB.prepare(reviewIssueEventsTableSql('review_issue_events')),
    DB.prepare(
      `INSERT INTO review_issue_events (
         id, issue_id, from_status, to_status, note, created_at,
         anonymous_source_hash
       )
       SELECT id, issue_id, from_status, to_status, note, created_at,
              anonymous_source_hash
       FROM ${eventBackup}`,
    ),
    DB.prepare(`DROP TABLE ${revisionBackup}`),
    DB.prepare(`DROP TABLE ${issueBackup}`),
    DB.prepare(`DROP TABLE ${eventBackup}`),
  ]);
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
  const existingSearch = await DB.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_search'",
  ).first();
  if (!existingSearch) {
    await DB.prepare(
      `CREATE VIRTUAL TABLE review_search USING fts5(${searchColumns}, tokenize='trigram')`,
    ).run();
    await rebuildAllReviewSearch(DB);
  }

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

async function rebuildAllReviewSearch(DB: D1Database): Promise<void> {
  await DB.batch([
    DB.prepare('DELETE FROM review_search'),
    DB.prepare(reviewSearchInsertSql()),
  ]);
}

export async function rebuildReviewSearch(reviewId: number): Promise<void> {
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    throw new Error('审查日志 ID 无效。');
  }
  await ensureReviewSchema();
  const { DB } = getRuntime();
  await DB.batch([
    DB.prepare('DELETE FROM review_search WHERE rowid = ?').bind(reviewId),
    DB.prepare(reviewSearchInsertSql('l.id = ?')).bind(reviewId),
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

export async function getReviewSummaries(
  projectId: number,
): Promise<ReviewSummary[]> {
  return (await getReviewPage(projectId, { scope: 'active' })).items;
}

export async function getEnabledReviewProject(
  slug: string,
): Promise<ReviewProject | null> {
  const project = await getReviewProject(slug);
  return project?.enabled ? project : null;
}

export async function getReviewProject(
  slug: string,
): Promise<ReviewProject | null> {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!isValidReviewProjectSlug(normalizedSlug)) return null;
  const project = await first<Omit<ReviewProject, 'enabled'> & { enabled: number }>(
    `SELECT id, name, slug, description, display_order AS displayOrder, enabled
     FROM review_projects WHERE slug = ?`,
    [normalizedSlug],
  );
  return project ? { ...project, enabled: project.enabled === 1 } : null;
}

export async function getReviewProjectDirectory(): Promise<
  ReviewProjectDirectoryItem[]
> {
  const rows = await all<
    Omit<ReviewProjectDirectoryItem, 'syncStatus'> & {
      latestAutomationRevisionCount: number | null;
      latestAutomationReviewedCount: number | null;
      latestAutomationSkippedCount: number | null;
    }
  >(
    `SELECT p.id, p.name, p.slug, p.description,
       p.display_order AS displayOrder,
       MAX(l.log_date) AS latestReviewDate,
       COUNT(DISTINCT CASE
         WHEN l.archived_at IS NULL AND i.source_current = 1
          AND i.status = 'open' THEN i.id END
       ) AS openIssueCount,
       COUNT(DISTINCT CASE
         WHEN l.archived_at IS NULL AND i.source_current = 1
          AND i.status IN ('open', 'pending_review')
          AND i.severity IN ('P1', 'P2') THEN i.id END
       ) AS highRiskCount,
       (SELECT a.updated_at FROM review_logs a
        WHERE a.project_id = p.id AND a.sync_mode = 'automation'
        ORDER BY a.updated_at DESC, a.id DESC LIMIT 1) AS latestAutomationSyncAt,
       (SELECT a.revision_count FROM review_logs a
        WHERE a.project_id = p.id AND a.sync_mode = 'automation'
        ORDER BY a.updated_at DESC, a.id DESC LIMIT 1) AS latestAutomationRevisionCount,
       (SELECT a.reviewed_count FROM review_logs a
        WHERE a.project_id = p.id AND a.sync_mode = 'automation'
        ORDER BY a.updated_at DESC, a.id DESC LIMIT 1) AS latestAutomationReviewedCount,
       (SELECT a.skipped_count FROM review_logs a
        WHERE a.project_id = p.id AND a.sync_mode = 'automation'
        ORDER BY a.updated_at DESC, a.id DESC LIMIT 1) AS latestAutomationSkippedCount
     FROM review_projects p
     LEFT JOIN review_logs l ON l.project_id = p.id
     LEFT JOIN review_issues i ON i.review_id = l.id
     WHERE p.enabled = 1
     GROUP BY p.id
     ORDER BY p.display_order, p.name COLLATE NOCASE, p.id`,
  );

  return rows.map((row) => {
    const {
      latestAutomationRevisionCount,
      latestAutomationReviewedCount,
      latestAutomationSkippedCount,
      ...project
    } = row;
    const syncStatus = !row.latestReviewDate
      ? 'waiting'
      : !row.latestAutomationSyncAt
        ? 'manual_only'
        : latestAutomationRevisionCount === 0 &&
            latestAutomationReviewedCount === 0 &&
            latestAutomationSkippedCount === 0
          ? 'attention'
          : 'healthy';
    return { ...project, syncStatus };
  });
}

export async function getCurrentReviewStats(
  projectId: number,
): Promise<CurrentReviewStats> {
  return (await first<CurrentReviewStats>(`SELECT COUNT(DISTINCT l.id) AS reviewCount,
      COUNT(DISTINCT CASE WHEN i.source_current = 1 AND i.status = 'open' THEN i.id END) AS openIssueCount,
      COUNT(DISTINCT CASE WHEN i.source_current = 1 AND i.status = 'pending_review' THEN i.id END) AS pendingReviewCount,
      COUNT(DISTINCT CASE WHEN i.source_current = 1 AND i.status IN ('open', 'pending_review') AND i.severity IN ('P1', 'P2') THEN i.id END) AS highRiskCount
     FROM review_logs l LEFT JOIN review_issues i ON i.review_id = l.id
     WHERE l.project_id = ? AND l.archived_at IS NULL`, [projectId])) ?? { reviewCount: 0, openIssueCount: 0, pendingReviewCount: 0, highRiskCount: 0 };
}

export async function getSyncHealth(projectId: number): Promise<SyncHealth> {
  const latest = await first<{
    updatedAt: string;
    logDate: string;
    revisionCount: number;
    reviewedCount: number;
    skippedCount: number;
    id: number;
    scopeText: string;
  }>([
    'SELECT updated_at AS updatedAt, log_date AS logDate,',
    'revision_count AS revisionCount, reviewed_count AS reviewedCount,',
    'skipped_count AS skippedCount, scope_text AS scopeText, id',
    'FROM review_logs WHERE project_id = ? AND sync_mode = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
  ].join(' '), [projectId, 'automation']);
  const normalizedLatest = latest ? normalizeReviewCounts(latest) : null;
  const latestRevision = normalizedLatest
    ? await first<{ revision: number }>(
        'SELECT MAX(revision) AS revision FROM review_revisions WHERE review_id = ?',
        [normalizedLatest.id],
      )
    : null;
  const stats = await getCurrentReviewStats(projectId);
  const reviewCount = await first<{ count: number }>(
    'SELECT COUNT(*) AS count FROM review_logs WHERE project_id = ? AND archived_at IS NULL',
    [projectId],
  );
  const currentIssueCount = await first<{ count: number }>(
    `SELECT COUNT(*) AS count FROM review_issues i
     JOIN review_logs l ON l.id = i.review_id
     WHERE l.project_id = ? AND l.archived_at IS NULL AND i.source_current = 1`,
    [projectId],
  );
  const latestIssueCount = normalizedLatest
    ? await first<{ count: number }>(
        'SELECT COUNT(*) AS count FROM review_issues WHERE review_id = ? AND source_current = 1',
        [normalizedLatest.id],
      )
    : null;

  return {
    latestAutomationSyncAt: normalizedLatest?.updatedAt ?? null,
    latestLogDate: normalizedLatest?.logDate ?? null,
    latestRevision: latestRevision?.revision ?? null,
    reviewCount: reviewCount?.count ?? stats.reviewCount,
    currentIssueCount: currentIssueCount?.count ?? 0,
    pendingIssueCount: stats.pendingReviewCount,
    parseFailure: Boolean(
      normalizedLatest && normalizedLatest.revisionCount === 0 && normalizedLatest.reviewedCount === 0 && normalizedLatest.skippedCount === 0,
    ),
    zeroIssueWarning: Boolean(
      normalizedLatest && (latestIssueCount?.count ?? 0) === 0,
    ),
  };
}

type IssueExportRowDb = {
  id: number;
  issueKey: string | null;
  status: string;
  statusNote: string | null;
  statusUpdatedAt: string | null;
  updatedAt: string;
  severity: string;
  title: string;
  relatedRevisions: string;
  author: string;
  logDate: string;
  sourceName: string;
  reviewId: number;
};

async function collectIssuePageItems(
  projectId: number,
  filters: IssueListFilters,
): Promise<ReviewIssueSummary[]> {
  const items: ReviewIssueSummary[] = [];
  let cursor = filters.cursor;
  while (items.length < EXPORT_MAX_ROWS) {
    const page = await getIssuePage(projectId, { ...filters, cursor, limit: 50 });
    items.push(...page.items);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items.slice(0, EXPORT_MAX_ROWS);
}

export async function getIssueExportRows(
  project: ReviewProjectIdentity,
  filters: IssueListFilters = {},
): Promise<ReviewExportRow[]> {
  const items = await collectIssuePageItems(project.id, filters);
  if (!items.length) return [];
  const rows = await all<IssueExportRowDb>([
    'SELECT i.id, i.issue_key AS issueKey, i.status, i.status_note AS statusNote,',
    'i.status_updated_at AS statusUpdatedAt, l.updated_at AS updatedAt,',
    'i.severity, i.title, i.related_revisions AS relatedRevisions,',
    "COALESCE((SELECT group_concat(DISTINCT r.author) FROM review_revisions r WHERE r.review_id = l.id), '') AS author,",
    'l.log_date AS logDate, l.source_name AS sourceName, l.id AS reviewId',
    'FROM review_issues i JOIN review_logs l ON l.id = i.review_id',
    `WHERE i.id IN (${items.map(() => '?').join(',')})`,
  ].join(' '), items.map((item) => item.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return items.flatMap((item) => {
    const row = byId.get(item.id);
    if (!row) return [];
    return [{
      issueKey: row.issueKey ?? '',
      status: row.status,
      statusNote: row.statusNote ?? '',
      updatedAt: row.statusUpdatedAt ?? row.updatedAt,
      severity: row.severity,
      title: row.title,
      revision: row.relatedRevisions,
      author: row.author,
      logDate: row.logDate,
      sourceName: row.sourceName,
      detailUrl: `/projects/${project.slug}/reviews/${row.reviewId}#issue-${row.id}`,
    }];
  });
}

export async function getReviewExportRows(
  project: ReviewProjectIdentity,
  filters: ReviewListFilters = {},
): Promise<ReviewExportRow[]> {
  const items: ReviewSummary[] = [];
  let cursor = filters.cursor;
  while (items.length < EXPORT_MAX_ROWS) {
    const page = await getReviewPage(project.id, { ...filters, cursor, limit: 50 });
    items.push(...page.items);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const selected = items.slice(0, EXPORT_MAX_ROWS);
  if (!selected.length) return [];
  const rows = await all<IssueExportRowDb>([
    'SELECT l.id AS reviewId, l.log_date AS logDate, l.source_name AS sourceName, l.updated_at AS updatedAt,',
    'i.id, i.issue_key AS issueKey, i.status, i.status_note AS statusNote,',
    'i.status_updated_at AS statusUpdatedAt, i.severity, i.title,',
    'i.related_revisions AS relatedRevisions,',
    "COALESCE((SELECT group_concat(DISTINCT r.author) FROM review_revisions r WHERE r.review_id = l.id), '') AS author",
    'FROM review_logs l LEFT JOIN review_issues i ON i.review_id = l.id AND i.source_current = 1',
    `WHERE l.id IN (${selected.map(() => '?').join(',')})`,
    'ORDER BY l.log_date DESC, l.id DESC, i.id',
  ].join(' '), selected.map((item) => item.id));
  const grouped = new Map<number, IssueExportRowDb[]>();
  for (const row of rows) {
    const list = grouped.get(row.reviewId) ?? [];
    list.push(row);
    grouped.set(row.reviewId, list);
  }
  return selected.flatMap((review) => {
    const reviewRows = grouped.get(review.id) ?? [];
    if (!reviewRows.length) {
      return [{
        issueKey: '', status: '', statusNote: '', updatedAt: review.updatedAt,
        severity: '', title: review.title, revision: '', author: '',
        logDate: review.logDate, sourceName: review.sourceName,
        detailUrl: `/projects/${project.slug}/reviews/${review.id}`,
      }];
    }
    return reviewRows.map((row) => ({
      issueKey: row.issueKey ?? '',
      status: row.status ?? '',
      statusNote: row.statusNote ?? '',
      updatedAt: row.statusUpdatedAt ?? row.updatedAt,
      severity: row.severity ?? '',
      title: row.title ?? review.title,
      revision: row.relatedRevisions ?? '',
      author: row.author,
      logDate: row.logDate,
      sourceName: row.sourceName,
      detailUrl: row.id
        ? `/projects/${project.slug}/reviews/${row.reviewId}#issue-${row.id}`
        : `/projects/${project.slug}/reviews/${row.reviewId}`,
    }));
  }).slice(0, EXPORT_MAX_ROWS);
}

export function toCsv(rows: ReviewExportRow[]): string {
  const headers = ['问题键', '状态', '处理说明', '更新时间', '严重级别', '标题', 'Revision', '作者', '日志日期', '详情链接'];
  const protect = (value: string): string => /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  const cell = (value: string): string => `"${protect(value).replace(/"/g, '""')}"`;
  return [headers, ...rows.map((row) => [
    row.issueKey, row.status, row.statusNote, row.updatedAt, row.severity,
    row.title, row.revision, row.author, row.logDate, row.detailUrl,
  ])].map((line) => line.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function toIssueWorkbook(rows: ReviewExportRow[], origin: string): Uint8Array {
  const headers = ['严重级别', '状态', '问题标题', '关联 Revision', '提交人', '日志日期', '来源日志', '处理说明', '最后更新', '详情链接'];
  const worksheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => [
      protectSpreadsheetText(row.severity),
      protectSpreadsheetText(ISSUE_STATUS_LABELS[row.status as IssueStatus] ?? row.status),
      protectSpreadsheetText(row.title),
      protectSpreadsheetText(row.revision),
      protectSpreadsheetText(row.author),
      protectSpreadsheetText(row.logDate),
      protectSpreadsheetText(row.sourceName),
      protectSpreadsheetText(row.statusNote),
      protectSpreadsheetText(row.updatedAt),
      '打开详情',
    ]),
  ]);

  const headerStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '315C4B' } },
    alignment: { vertical: 'center' },
  };
  for (let column = 0; column < headers.length; column += 1) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: 0, c: column })];
    if (cell) cell.s = headerStyle;
  }
  for (let rowIndex = 1; rowIndex <= rows.length; rowIndex += 1) {
    for (const column of [2, 7]) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: column })];
      if (cell) cell.s = { alignment: { vertical: 'top', wrapText: true } };
    }
    const link = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: 9 })];
    if (link) {
      link.l = { Target: safeDetailUrl(rows[rowIndex - 1].detailUrl, origin) };
      link.s = { font: { color: { rgb: '1D5B46' }, underline: true } };
    }
  }
  worksheet['!autofilter'] = { ref: `A1:J${Math.max(rows.length + 1, 1)}` };
  worksheet['!cols'] = [
    { wch: 10 }, { wch: 12 }, { wch: 42 }, { wch: 18 }, { wch: 28 },
    { wch: 13 }, { wch: 24 }, { wch: 42 }, { wch: 20 }, { wch: 14 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '问题跟进');
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
}

function protectSpreadsheetText(value: string): string {
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

function safeDetailUrl(path: string, origin: string): string {
  if (!/^\/projects\/[a-z0-9-]+\/reviews\/\d+(?:#issue-\d+)?$/.test(path)) {
    throw new Error('导出详情链接无效。');
  }
  return new URL(path, origin).toString();
}

export async function getReviewPage(
  projectId: number,
  filters: ReviewListFilters = {},
): Promise<PageResult<ReviewSummary>> {
  const scope = normalizeScope(filters.scope);
  const limit = normalizeRepositoryPageSize(filters.limit);
  const keyword = filters.keyword?.trim() ?? '';
  const useLike = keyword.length > 0 && [...keyword].length < 3;

  try {
    return await queryReviewPage(projectId, filters, scope, limit, keyword, useLike);
  } catch (error) {
    if (!keyword || useLike || !isFtsQueryError(error)) throw error;
    return queryReviewPage(projectId, filters, scope, limit, keyword, true);
  }
}

export async function getIssuePage(
  projectId: number,
  filters: IssueListFilters = {},
): Promise<PageResult<ReviewIssueSummary>> {
  const scope = normalizeScope(filters.scope);
  const limit = normalizeRepositoryPageSize(filters.limit);
  const keyword = filters.keyword?.trim() ?? '';
  const useLike = keyword.length > 0 && [...keyword].length < 3;

  try {
    return await queryIssuePage(projectId, filters, scope, limit, keyword, useLike);
  } catch (error) {
    if (!keyword || useLike || !isFtsQueryError(error)) throw error;
    return queryIssuePage(projectId, filters, scope, limit, keyword, true);
  }
}

type ReviewSummaryRow = ReviewSummary & {
  cursorUpdatedAt: string;
};

type ReviewIssueSummaryRow = ReviewIssueSummary & {
  cursorUpdatedAt: string;
};

const ISSUE_CURSOR_FLOOR = '1000-01-01T00:00:00.000Z';

async function queryReviewPage(
  projectId: number,
  filters: ReviewListFilters,
  scope: ReviewScope,
  limit: 20 | 50,
  keyword: string,
  useLike: boolean,
): Promise<PageResult<ReviewSummary>> {
  const values: SqlValue[] = [projectId];
  const where = [
    'l.project_id = ?',
    scope === 'active' ? 'l.archived_at IS NULL' : 'l.archived_at IS NOT NULL',
  ];
  addReviewDateFilters(where, values, filters);
  addReviewRevisionFilters(where, values, filters);
  addReviewIssueFilters(where, values, filters);
  addReviewKeywordFilter(where, values, keyword, useLike);

  if (filters.cursor) {
    const cursor = decodePageCursor(filters.cursor);
    where.push('(l.log_date < ? OR (l.log_date = ? AND l.id < ?))');
    values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  values.push(limit + 1);

  const rows = await all<ReviewSummaryRow>(
    [
      'SELECT l.id, l.log_date AS logDate, l.log_date AS cursorUpdatedAt,',
      'l.title, l.overview, l.scope_text AS scopeText,',
      'l.source_name AS sourceName, l.revision_count AS revisionCount,',
      'l.reviewed_count AS reviewedCount, l.skipped_count AS skippedCount,',
      'l.p1_count AS p1Count, l.p2_count AS p2Count, l.p3_count AS p3Count,',
      'l.sync_mode AS syncMode, l.imported_at AS importedAt,',
      'l.updated_at AS updatedAt, l.archived_at AS archivedAt',
      'FROM review_logs l',
      `WHERE ${where.join(' AND ')}`,
      'ORDER BY l.log_date DESC, l.id DESC',
      'LIMIT ?',
    ].join(' '),
    values,
  );

  const page = toPageResult(rows, limit);
  return { ...page, items: page.items.map(normalizeReviewCounts) };
}

async function queryIssuePage(
  projectId: number,
  filters: IssueListFilters,
  scope: ReviewScope,
  limit: 20 | 50,
  keyword: string,
  useLike: boolean,
): Promise<PageResult<ReviewIssueSummary>> {
  const values: SqlValue[] = [projectId];
  const sortExpression = `COALESCE(i.status_updated_at, '${ISSUE_CURSOR_FLOOR}')`;
  const where = [
    'l.project_id = ?',
    scope === 'active' ? 'l.archived_at IS NULL' : 'l.archived_at IS NOT NULL',
    'i.source_current = 1',
  ];
  addReviewDateFilters(where, values, filters);
  if (filters.statuses?.length) {
    where.push(`i.status IN (${filters.statuses.map(() => '?').join(',')})`);
    values.push(...filters.statuses);
  } else if (filters.status) {
    where.push('i.status = ?');
    values.push(filters.status);
  }
  if (filters.severities?.length) {
    where.push(`i.severity IN (${filters.severities.map(() => '?').join(',')})`);
    values.push(...filters.severities);
  } else if (filters.severity) {
    where.push('i.severity = ?');
    values.push(filters.severity);
  }
  if (filters.author?.trim()) {
    where.push(
      'EXISTS (SELECT 1 FROM review_revisions r WHERE r.review_id = l.id AND r.author LIKE ? ESCAPE \'\\\')',
    );
    values.push(toLikePattern(filters.author.trim()));
  }
  if (Number.isInteger(filters.revision)) {
    where.push('i.related_revisions LIKE ? ESCAPE \'\\\'');
    values.push(toLikePattern(String(filters.revision)));
  }
  addIssueKeywordFilter(where, values, keyword, useLike);

  if (filters.cursor) {
    const cursor = decodePageCursor(filters.cursor);
    where.push(
      `(${sortExpression} < ? OR (${sortExpression} = ? AND i.id < ?))`,
    );
    values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  values.push(limit + 1);

  const rows = await all<ReviewIssueSummaryRow>(
    [
      'SELECT i.id, i.review_id AS reviewId, i.issue_key AS issueKey,',
      'i.severity, i.title, i.related_revisions AS relatedRevisions,',
      'i.status, i.status_note AS statusNote,',
      'i.status_updated_at AS statusUpdatedAt,',
      `${sortExpression} AS cursorUpdatedAt,`,
      'i.source_current AS sourceCurrent, i.version,',
      'l.log_date AS logDate, l.title AS reviewTitle,',
      "COALESCE((SELECT group_concat(DISTINCT r.author) FROM review_revisions r WHERE r.review_id = l.id), '') AS authors",
      'FROM review_issues i JOIN review_logs l ON l.id = i.review_id',
      `WHERE ${where.join(' AND ')}`,
      `ORDER BY ${sortExpression} DESC, i.id DESC`,
      'LIMIT ?',
    ].join(' '),
    values,
  );

  return toPageResult(rows, limit);
}

function addReviewDateFilters(
  where: string[],
  values: SqlValue[],
  filters: Pick<ReviewListFilters, 'fromDate' | 'toDate'>,
): void {
  if (filters.fromDate?.trim()) {
    where.push('l.log_date >= ?');
    values.push(filters.fromDate.trim());
  }
  if (filters.toDate?.trim()) {
    where.push('l.log_date <= ?');
    values.push(filters.toDate.trim());
  }
}

function addReviewRevisionFilters(
  where: string[],
  values: SqlValue[],
  filters: Pick<ReviewListFilters, 'author' | 'revision'>,
): void {
  const revisionWhere = ['r.review_id = l.id'];
  if (filters.author?.trim()) {
    revisionWhere.push("r.author LIKE ? ESCAPE '\\'");
    values.push(toLikePattern(filters.author.trim()));
  }
  if (Number.isInteger(filters.revision)) {
    revisionWhere.push('r.revision = ?');
    values.push(filters.revision!);
  }
  if (revisionWhere.length > 1) {
    where.push(
      `EXISTS (SELECT 1 FROM review_revisions r WHERE ${revisionWhere.join(' AND ')})`,
    );
  }
}

function addReviewIssueFilters(
  where: string[],
  values: SqlValue[],
  filters: Pick<ReviewListFilters, 'severity' | 'severities' | 'status'>,
): void {
  const issueWhere = ['i.review_id = l.id', 'i.source_current = 1'];
  if (filters.severities?.length) {
    issueWhere.push(`i.severity IN (${filters.severities.map(() => '?').join(',')})`);
    values.push(...filters.severities);
  } else if (filters.severity) {
    issueWhere.push('i.severity = ?');
    values.push(filters.severity);
  }
  if (filters.status) {
    issueWhere.push('i.status = ?');
    values.push(filters.status);
  }
  if (issueWhere.length > 2) {
    where.push(
      `EXISTS (SELECT 1 FROM review_issues i WHERE ${issueWhere.join(' AND ')})`,
    );
  }
}

function addReviewKeywordFilter(
  where: string[],
  values: SqlValue[],
  keyword: string,
  useLike: boolean,
): void {
  if (!keyword) return;
  if (!useLike) {
    where.push(
      'l.id IN (SELECT review_id FROM review_search WHERE review_search MATCH ?)',
    );
    values.push(keyword);
    return;
  }

  const pattern = toLikePattern(keyword);
  where.push(
    [
      '(l.title LIKE ? ESCAPE \'\\\'',
      'OR l.overview LIKE ? ESCAPE \'\\\'',
      'OR l.scope_text LIKE ? ESCAPE \'\\\'',
      'OR EXISTS (SELECT 1 FROM review_revisions r',
      'WHERE r.review_id = l.id AND (r.author LIKE ? ESCAPE \'\\\'',
      'OR r.description LIKE ? ESCAPE \'\\\'',
      'OR CAST(r.revision AS TEXT) LIKE ? ESCAPE \'\\\'))',
      'OR EXISTS (SELECT 1 FROM review_issues i',
      'WHERE i.review_id = l.id AND (i.title LIKE ? ESCAPE \'\\\'',
      'OR i.detail LIKE ? ESCAPE \'\\\'',
      'OR COALESCE(i.status_note, \'\') LIKE ? ESCAPE \'\\\')))',
    ].join(' '),
  );
  values.push(...Array<SqlValue>(9).fill(pattern));
}

function addIssueKeywordFilter(
  where: string[],
  values: SqlValue[],
  keyword: string,
  useLike: boolean,
): void {
  if (!keyword) return;
  if (!useLike) {
    where.push(
      'l.id IN (SELECT review_id FROM review_search WHERE review_search MATCH ?)',
    );
    values.push(keyword);
    return;
  }

  const pattern = toLikePattern(keyword);
  where.push(
    [
      '(l.title LIKE ? ESCAPE \'\\\'',
      'OR l.overview LIKE ? ESCAPE \'\\\'',
      'OR l.scope_text LIKE ? ESCAPE \'\\\'',
      'OR i.title LIKE ? ESCAPE \'\\\'',
      'OR i.detail LIKE ? ESCAPE \'\\\'',
      'OR i.related_revisions LIKE ? ESCAPE \'\\\'',
      'OR COALESCE(i.status_note, \'\') LIKE ? ESCAPE \'\\\'',
      'OR EXISTS (SELECT 1 FROM review_revisions r',
      'WHERE r.review_id = l.id AND (r.author LIKE ? ESCAPE \'\\\'',
      'OR r.description LIKE ? ESCAPE \'\\\'',
      'OR CAST(r.revision AS TEXT) LIKE ? ESCAPE \'\\\')))',
    ].join(' '),
  );
  values.push(...Array<SqlValue>(10).fill(pattern));
}

function toPageResult<
  T extends { id: number; cursorUpdatedAt: string },
>(rows: T[], limit: 20 | 50): PageResult<Omit<T, 'cursorUpdatedAt'>> {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(withoutCursorField);
  const last = pageRows.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodePageCursor({ updatedAt: last.cursorUpdatedAt, id: last.id })
        : null,
  };
}

function withoutCursorField<T extends { cursorUpdatedAt: string }>(
  row: T,
): Omit<T, 'cursorUpdatedAt'> {
  const item = { ...row } as Omit<T, 'cursorUpdatedAt'> & {
    cursorUpdatedAt?: string;
  };
  delete item.cursorUpdatedAt;
  return item;
}

function normalizeScope(scope: ReviewScope | undefined): ReviewScope {
  if (scope === undefined) return 'active';
  if (scope !== 'active' && scope !== 'archived') {
    throw new Error('审查范围无效。');
  }
  return scope;
}

function normalizeRepositoryPageSize(value: unknown): 20 | 50 {
  return Number(value) > 50 ? normalizePageSize(50) : normalizePageSize(value);
}

function toLikePattern(value: string): string {
  return `%${value.replace(/([%_\\])/g, '\\$1')}%`;
}

function isFtsQueryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = `${error.message} ${(error as Error & { cause?: unknown }).cause ?? ''}`.toLowerCase();
  return (
    message.includes('fts5') ||
    message.includes('match') ||
    message.includes('syntax') ||
    message.includes('unterminated') ||
    message.includes('malformed')
  );
}

export async function getReviewDetail(
  projectId: number,
  id: number,
): Promise<ReviewDetail | null> {
  const review = await first<ReviewRow>(
    [
      'SELECT id, log_date AS logDate, title, overview,',
      'scope_text AS scopeText, source_name AS sourceName,',
      'content_object_key AS contentObjectKey,',
      'revision_count AS revisionCount, reviewed_count AS reviewedCount,',
      'skipped_count AS skippedCount, p1_count AS p1Count,',
      'p2_count AS p2Count, p3_count AS p3Count,',
      'sync_mode AS syncMode, imported_at AS importedAt,',
      'updated_at AS updatedAt, archived_at AS archivedAt',
      'FROM review_logs WHERE project_id = ? AND id = ?',
    ].join(' '),
    [projectId, id],
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
    all<ParsedIssue & Pick<ReviewIssueSummary, 'id' | 'status' | 'statusNote' | 'statusUpdatedAt' | 'version'>>(
      [
        'SELECT id, severity, title, related_revisions AS relatedRevisions, detail, status, status_note AS statusNote, status_updated_at AS statusUpdatedAt, version',
        'FROM review_issues WHERE review_id = ? AND source_current = 1',
        "ORDER BY CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, id",
      ].join(' '),
      [id],
    ),
    getRuntime().FILES.get(review.contentObjectKey),
  ]);
  const events = issues.length ? await all<IssueEvent>(
    `SELECT id, issue_id AS issueId, from_status AS fromStatus, to_status AS toStatus, note, created_at AS createdAt
     FROM review_issue_events WHERE issue_id IN (${issues.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC`,
    issues.map((issue) => issue.id),
  ) : [];

  return {
    ...review,
    revisions,
    issues: issues.map((issue) => ({ ...issue, events: events.filter((event) => event.issueId === issue.id) })),
    markdown: object ? await object.text() : '',
  };
}

export async function getReviewMarkdown(projectId: number, id: number): Promise<{
  content: string;
  sourceName: string;
} | null> {
  const review = await first<Pick<ReviewRow, 'sourceName' | 'contentObjectKey'>>(
    'SELECT source_name AS sourceName, content_object_key AS contentObjectKey FROM review_logs WHERE project_id = ? AND id = ?',
    [projectId, id],
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

export async function ingestReview(
  input: IngestInput,
): Promise<ReviewIngestionResult> {
  await ensureReviewSchema();
  const defaultProject = await first<ReviewProjectIdentity>(
    'SELECT id, slug FROM review_projects WHERE slug = ?',
    [DEFAULT_REVIEW_PROJECT_SLUG],
  );
  if (!defaultProject) throw new Error('默认 ZHERP 审查项目不存在。');
  return ingestReviewForProject(defaultProject, input);
}

export async function ingestReviewForProject(
  project: ReviewProjectIdentity,
  input: IngestInput,
): Promise<ReviewIngestionResult> {
  await ensureReviewSchema();
  const storedProject = await first<ReviewProjectIdentity>(
    `SELECT id, slug FROM review_projects
     WHERE id = ? AND slug = ? AND enabled = 1`,
    [project.id, project.slug],
  );
  if (!storedProject) {
    throw new Error('审查项目不存在、已停用或项目标识不匹配。');
  }
  const markdown = input.markdown.replace(/^\uFEFF/, '');
  if (!markdown.trim()) throw new Error('日志文件为空。');
  if (new TextEncoder().encode(markdown).byteLength > 2_000_000) {
    throw new Error('日志文件超过 2MB 限制。');
  }

  const parsed = parseReviewMarkdown(markdown);
  if (!parsed.logDate) {
    throw new Error('未识别到“日期：YYYY-MM-DD”字段，不能作为审查日志导入。');
  }
  validateParsedReview(parsed);

  const sourceKey = input.sourceKey.trim().slice(0, 500);
  if (!sourceKey) throw new Error('日志来源标识不能为空。');

  const sourceName = input.sourceName.trim().slice(0, 255) || 'svn审查日志.md';
  const now = new Date().toISOString();
  const sourceHash = await sha256(markdown);
  const { DB, FILES } = getRuntime();
  const projectId = storedProject.id;
  const existing = await first<{
    id: number;
    sourceHash: string;
    contentObjectKey: string;
  }>(
    `SELECT id, source_hash AS sourceHash, content_object_key AS contentObjectKey
     FROM review_logs WHERE project_id = ? AND source_key = ?`,
    [projectId, sourceKey],
  );
  const reusableObject = existing?.sourceHash === sourceHash
    ? await FILES.head(existing.contentObjectKey)
    : null;
  const contentObjectKey = reusableObject
    ? existing!.contentObjectKey
    : 'review-logs/' + storedProject.slug + '/' + parsed.logDate + '/' +
      sourceHash + '-' + crypto.randomUUID() + '.md';
  const createdContentObject = !reusableObject;

  if (createdContentObject) {
    await DB.prepare(
      `INSERT OR IGNORE INTO review_object_cleanup_queue (object_key, created_at, ready)
       VALUES (?, ?, 0)`,
    ).bind(contentObjectKey, now).run();
    try {
      await FILES.put(contentObjectKey, markdown, {
        httpMetadata: {
          contentType: 'text/markdown; charset=utf-8',
        },
        customMetadata: {
          projectSlug: storedProject.slug,
          logDate: parsed.logDate,
          sourceName,
        },
      });
    } catch (error) {
      await markReviewObjectCleanupReady(DB, contentObjectKey);
      await drainReviewObjectCleanupQueue(DB, FILES);
      throw error;
    }
  }

  const existingIssues = existing
    ? await all<IssueIdentityRow>(
        `SELECT id, review_id AS reviewId, issue_key AS issueKey,
                severity, title, related_revisions AS relatedRevisions
         FROM review_issues
         WHERE review_id = ? AND issue_key IS NOT NULL`,
        [existing.id],
      )
    : [];
  const existingIssueKeys = new Set(
    existingIssues.map((issue) => issue.issueKey!),
  );
  const existingKeyByIdentity = new Map(
    existingIssues.map((issue) => [issueStableKey(issue), issue.issueKey!]),
  );
  const issuesByKey = new Map<string, ParsedIssue>();
  for (const issue of parsed.issues) {
    const identity = issueStableKey(issue);
    const legacyIdentity =
      issue.legacyRelatedRevisions !== undefined
        ? issueStableKey({
            ...issue,
            relatedRevisions: issue.legacyRelatedRevisions,
          })
        : '';
    issuesByKey.set(
      existingKeyByIdentity.get(identity) ??
        existingKeyByIdentity.get(legacyIdentity) ??
        identity,
      issue,
    );
  }
  const currentIssues = [...issuesByKey.entries()];
  const createdIssueCount = currentIssues.filter(
    ([issueKey]) => !existingIssueKeys.has(issueKey),
  ).length;
  const updatedIssueCount = currentIssues.length - createdIssueCount;

  const statements: D1PreparedStatement[] = [
    DB.prepare(
      [
        'INSERT INTO review_logs (',
        'project_id, log_date, source_key, source_name, source_hash, content_object_key,',
        'title, overview, scope_text, revision_count, reviewed_count, skipped_count,',
        'p1_count, p2_count, p3_count, sync_mode, imported_by, imported_at, updated_at',
        ') SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?',
        'FROM review_projects WHERE id = ? AND slug = ? AND enabled = 1',
        'AND NOT EXISTS (SELECT 1 FROM project_deletion_operations',
        'WHERE claim_token IS NOT NULL AND claim_expires_at > ?)',
        'ON CONFLICT(project_id, source_key) DO UPDATE SET',
        'log_date = excluded.log_date, source_name = excluded.source_name,',
        'source_hash = excluded.source_hash, content_object_key = excluded.content_object_key,',
        'title = excluded.title, overview = excluded.overview,',
        'scope_text = excluded.scope_text, revision_count = excluded.revision_count,',
        'reviewed_count = excluded.reviewed_count, skipped_count = excluded.skipped_count,',
        'p1_count = excluded.p1_count, p2_count = excluded.p2_count,',
        'p3_count = excluded.p3_count, sync_mode = excluded.sync_mode,',
        'imported_by = excluded.imported_by, updated_at = excluded.updated_at',
        'WHERE review_logs.content_object_key = ?',
      ].join(' '),
    ).bind(
      projectId,
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
      projectId,
      storedProject.slug,
      now,
      existing?.contentObjectKey ?? null,
    ),
    DB.prepare(
      `DELETE FROM review_revisions
       WHERE review_id = (SELECT id FROM review_logs
                          WHERE project_id = ? AND source_key = ? AND content_object_key = ?)
         AND EXISTS (SELECT 1 FROM review_projects WHERE id = ? AND enabled = 1)
         AND NOT EXISTS (
           SELECT 1 FROM project_deletion_operations
           WHERE claim_token IS NOT NULL AND claim_expires_at > ?
         )`,
    ).bind(projectId, sourceKey, contentObjectKey, projectId, now),
    DB.prepare(
      `UPDATE review_issues SET source_current = 0
       WHERE review_id = (SELECT id FROM review_logs
                          WHERE project_id = ? AND source_key = ? AND content_object_key = ?)
         AND EXISTS (SELECT 1 FROM review_projects WHERE id = ? AND enabled = 1)
         AND NOT EXISTS (
           SELECT 1 FROM project_deletion_operations
           WHERE claim_token IS NOT NULL AND claim_expires_at > ?
         )`,
    ).bind(projectId, sourceKey, contentObjectKey, projectId, now),
    ...parsed.revisions.map((revision) =>
      DB.prepare(
        [
          'INSERT INTO review_revisions (',
          'review_id, revision, author, committed_at, description, conclusion',
          ') SELECT l.id, ?, ?, ?, ?, ? FROM review_logs l',
          'JOIN review_projects p ON p.id = l.project_id',
          'WHERE l.project_id = ? AND l.source_key = ? AND l.content_object_key = ?',
          'AND p.enabled = 1',
          'AND NOT EXISTS (SELECT 1 FROM project_deletion_operations',
          'WHERE claim_token IS NOT NULL AND claim_expires_at > ?)',
        ].join(' '),
      ).bind(
        revision.revision,
        revision.author,
        revision.committedAt,
        revision.description,
        revision.conclusion,
        projectId,
        sourceKey,
        contentObjectKey,
        now,
      ),
    ),
    ...currentIssues.map(([issueKey, issue]) =>
      DB.prepare(
        [
          'INSERT INTO review_issues (',
          'review_id, issue_key, severity, title, related_revisions, detail,',
          'status, status_note, status_updated_at, source_current, version',
          ") SELECT l.id, ?, ?, ?, ?, ?, 'open', NULL, NULL, 1, 0",
          'FROM review_logs l JOIN review_projects p ON p.id = l.project_id',
          'WHERE l.project_id = ? AND l.source_key = ? AND l.content_object_key = ?',
          'AND p.enabled = 1',
          'AND NOT EXISTS (SELECT 1 FROM project_deletion_operations',
          'WHERE claim_token IS NOT NULL AND claim_expires_at > ?)',
          'ON CONFLICT(review_id, issue_key) WHERE issue_key IS NOT NULL',
          'DO UPDATE SET severity = excluded.severity, title = excluded.title,',
          'related_revisions = excluded.related_revisions, detail = excluded.detail,',
          'source_current = 1',
        ].join(' '),
      ).bind(
        issueKey,
        issue.severity,
        issue.title,
        issue.relatedRevisions,
        issue.detail,
        projectId,
        sourceKey,
        contentObjectKey,
        now,
      ),
    ),
    ...(existing && existing.contentObjectKey !== contentObjectKey
      ? [
          DB.prepare(
            `INSERT OR IGNORE INTO review_object_cleanup_queue (object_key, created_at)
             SELECT ?, ?
             WHERE EXISTS (
               SELECT 1 FROM review_logs
               WHERE project_id = ? AND source_key = ? AND content_object_key = ?
             ) AND NOT EXISTS (
               SELECT 1 FROM project_deletion_operations
               WHERE claim_token IS NOT NULL AND claim_expires_at > ?
             )`,
          ).bind(existing.contentObjectKey, now, projectId, sourceKey, contentObjectKey, now),
        ]
      : []),
    ...(createdContentObject
      ? [
          DB.prepare(
            `DELETE FROM review_object_cleanup_queue
             WHERE object_key = ?
               AND EXISTS (
                 SELECT 1 FROM review_logs
                 WHERE project_id = ? AND source_key = ? AND content_object_key = ?
               ) AND NOT EXISTS (
                 SELECT 1 FROM project_deletion_operations
                 WHERE claim_token IS NOT NULL AND claim_expires_at > ?
               )`,
          ).bind(contentObjectKey, projectId, sourceKey, contentObjectKey, now),
        ]
      : []),
    DB.prepare(
      `SELECT l.id FROM review_logs l
       JOIN review_projects p ON p.id = l.project_id
       WHERE l.project_id = ? AND l.source_key = ? AND l.content_object_key = ?
         AND p.slug = ? AND p.enabled = 1
         AND NOT EXISTS (
           SELECT 1 FROM project_deletion_operations
           WHERE claim_token IS NOT NULL AND claim_expires_at > ?
         )`,
    ).bind(projectId, sourceKey, contentObjectKey, storedProject.slug, now),
  ];

  let results: D1Result[];
  try {
    results = await DB.batch(statements);
  } catch (error) {
    if (createdContentObject) {
      await markReviewObjectCleanupReady(DB, contentObjectKey);
      await drainReviewObjectCleanupQueue(DB, FILES);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `D1 原子更新失败，未提交部分结构化变更：${message}`,
      { cause: error },
    );
  }
  if (!results.at(-1)?.results?.length) {
    if (createdContentObject) {
      await markReviewObjectCleanupReady(DB, contentObjectKey);
      await drainReviewObjectCleanupQueue(DB, FILES);
    }
    throw new Error('审查项目已停用或同一来源已被并发更新，日志未写入。');
  }

  const committedIdentity = results.at(-1)!.results[0] as { id: number };
  const reviewId = committedIdentity.id;
  await drainReviewObjectCleanupQueue(DB, FILES);

  const review = await first<ReviewSummary>(
    [
      'SELECT id, log_date AS logDate, title, overview,',
      'scope_text AS scopeText, source_name AS sourceName,',
      'revision_count AS revisionCount, reviewed_count AS reviewedCount,',
      'skipped_count AS skippedCount, p1_count AS p1Count,',
      'p2_count AS p2Count, p3_count AS p3Count,',
      'sync_mode AS syncMode, imported_at AS importedAt,',
      'updated_at AS updatedAt, archived_at AS archivedAt',
      'FROM review_logs WHERE id = ?',
    ].join(' '),
    [reviewId],
  );
  if (!review) throw new Error('日志已写入，但未能读取导入结果。');
  return {
    ...normalizeReviewCounts(review),
    ingestion: {
      createdIssueCount,
      updatedIssueCount,
      parsedIssueCount: currentIssues.length,
    },
  };
}

async function drainReviewObjectCleanupQueue(
  DB: D1Database,
  FILES: R2Bucket,
): Promise<void> {
  const abandonedBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  let queued: D1Result<{ objectKey: string }>;
  try {
    queued = await DB.prepare(
      `SELECT cleanup.object_key AS objectKey
       FROM review_object_cleanup_queue cleanup
       WHERE (cleanup.ready = 1 OR cleanup.created_at <= ?)
         AND NOT EXISTS (
          SELECT 1 FROM review_logs review
          WHERE review.content_object_key = cleanup.object_key
        )
       ORDER BY cleanup.created_at, cleanup.object_key
       LIMIT 100`,
    ).bind(abandonedBefore).all<{ objectKey: string }>();
  } catch {
    return;
  }

  const objectKeys = (queued.results ?? []).map((item) => item.objectKey);
  if (!objectKeys.length) return;
  try {
    await FILES.delete(objectKeys);
    await DB.prepare(
      `DELETE FROM review_object_cleanup_queue
       WHERE object_key IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (
           SELECT 1 FROM review_logs
           WHERE review_logs.content_object_key = review_object_cleanup_queue.object_key
         )`,
    ).bind(JSON.stringify(objectKeys)).run();
  } catch {
    return;
  }
}

async function markReviewObjectCleanupReady(
  DB: D1Database,
  objectKey: string,
): Promise<void> {
  try {
    await DB.prepare(
      'UPDATE review_object_cleanup_queue SET ready = 1 WHERE object_key = ?',
    ).bind(objectKey).run();
  } catch {
    return;
  }
}

function validateParsedReview(parsed: ReturnType<typeof parseReviewMarkdown>): void {
  const explicitlyZero = reviewScopeDeclaresZeroRevisions(
    `${parsed.scopeText}\n${parsed.overview}`,
  );
  if (parsed.revisionCount === 0) {
    if (
      explicitlyZero &&
      parsed.reviewedCount === 0 &&
      parsed.skippedCount === 0 &&
      parsed.revisions.length === 0
    ) {
      return;
    }
    throw new Error('未识别到明确的审查提交总数。');
  }
  if (parsed.reviewedCount + parsed.skippedCount !== parsed.revisionCount) {
    throw new Error(
      `审查范围计数不一致：共 ${parsed.revisionCount} 个，审查 ${parsed.reviewedCount} 个，跳过 ${parsed.skippedCount} 个。`,
    );
  }
  const expectedRevisionRows =
    parsed.revisionTableMode === 'reviewed-only'
      ? parsed.reviewedCount
      : parsed.revisionCount;
  if (parsed.revisions.length !== expectedRevisionRows) {
    throw new Error(
      `提交表解析不完整：应解析 ${expectedRevisionRows} 个，实际解析 ${parsed.revisions.length} 个。`,
    );
  }
}

function normalizeReviewCounts<T extends Pick<ReviewSummary, 'scopeText' | 'revisionCount' | 'reviewedCount' | 'skippedCount'>>(review: T): T {
  if (review.revisionCount || review.reviewedCount || review.skippedCount || !review.scopeText) return review;
  return { ...review, ...parseReviewScopeCounts(review.scopeText) };
}

function issueStableKey(
  issue: { severity: string; title: string; relatedRevisions: string },
): string {
  return normalizeIssueKey(
    `${issue.severity.toUpperCase()}:${issue.title}:${normalizeRelatedRevisions(issue.relatedRevisions)}`,
  );
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

async function sha256(value: string): Promise<string> {
  return [...await sha256Bytes(value)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
}

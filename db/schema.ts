import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { ISSUE_STATUSES } from '../lib/issue-lifecycle';

export const reviewProjects = sqliteTable(
  'review_projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    displayOrder: integer('display_order').notNull().default(0),
    enabled: integer('enabled').notNull().default(1),
    syncKeyEncrypted: text('sync_key_encrypted'),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('idx_review_projects_name').on(
      sql`${table.name} COLLATE NOCASE`,
    ),
    uniqueIndex('idx_review_projects_slug').on(table.slug),
    index('idx_review_projects_directory').on(
      table.enabled,
      table.displayOrder,
      table.id,
    ),
  ],
);

export const reviewLogs = sqliteTable(
  'review_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .default(1)
      .references(() => reviewProjects.id, { onDelete: 'cascade' }),
    logDate: text('log_date').notNull(),
    sourceKey: text('source_key').notNull(),
    sourceName: text('source_name').notNull(),
    sourceHash: text('source_hash').notNull(),
    contentObjectKey: text('content_object_key').notNull(),
    title: text('title').notNull(),
    overview: text('overview').notNull(),
    scopeText: text('scope_text').notNull(),
    revisionCount: integer('revision_count').notNull(),
    reviewedCount: integer('reviewed_count').notNull(),
    skippedCount: integer('skipped_count').notNull(),
    p1Count: integer('p1_count').notNull(),
    p2Count: integer('p2_count').notNull(),
    p3Count: integer('p3_count').notNull(),
    syncMode: text('sync_mode').notNull(),
    importedBy: text('imported_by').notNull(),
    importedAt: text('imported_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (table) => [
    uniqueIndex('idx_review_logs_project_source_key').on(
      table.projectId,
      table.sourceKey,
    ),
    index('idx_review_logs_project_id').on(table.projectId),
    index('idx_review_logs_log_date').on(table.logDate),
    index('idx_review_logs_severity').on(table.p1Count, table.p2Count),
    index('idx_review_logs_archive_date_id').on(
      table.archivedAt,
      table.logDate,
      table.id,
    ),
  ],
);

export const reviewRevisions = sqliteTable(
  'review_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: integer('review_id')
      .notNull()
      .references(() => reviewLogs.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    author: text('author').notNull(),
    committedAt: text('committed_at').notNull(),
    description: text('description').notNull(),
    conclusion: text('conclusion').notNull(),
  },
  (table) => [
    uniqueIndex('idx_review_revisions_review_revision').on(
      table.reviewId,
      table.revision,
    ),
    index('idx_review_revisions_revision').on(table.revision),
    index('idx_review_revisions_author').on(table.author),
  ],
);

export const reviewIssues = sqliteTable(
  'review_issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: integer('review_id')
      .notNull()
      .references(() => reviewLogs.id, { onDelete: 'cascade' }),
    issueKey: text('issue_key'),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    relatedRevisions: text('related_revisions').notNull(),
    detail: text('detail').notNull(),
    status: text('status').notNull().default(ISSUE_STATUSES[0]),
    statusNote: text('status_note'),
    statusUpdatedAt: text('status_updated_at'),
    sourceCurrent: integer('source_current').notNull().default(1),
    version: integer('version').notNull().default(0),
  },
  (table) => [
    index('idx_review_issues_review_id').on(table.reviewId),
    index('idx_review_issues_severity').on(table.severity),
    index('idx_review_issues_status_current_review').on(
      table.status,
      table.sourceCurrent,
      table.reviewId,
    ),
    uniqueIndex('idx_review_issues_review_issue_key')
      .on(table.reviewId, table.issueKey)
      .where(sql`${table.issueKey} IS NOT NULL`),
  ],
);

export const adminUsers = sqliteTable('admin_users', {
  userId: text('user_id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const projectAdminAudits = sqliteTable(
  'project_admin_audits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectIdSnapshot: integer('project_id_snapshot'),
    projectSlugSnapshot: text('project_slug_snapshot'),
    projectNameSnapshot: text('project_name_snapshot'),
    projectSnapshotJson: text('project_snapshot_json').notNull(),
    adminUserId: text('admin_user_id').notNull(),
    adminEmailSnapshot: text('admin_email_snapshot').notNull(),
    adminDisplayNameSnapshot: text('admin_display_name_snapshot').notNull(),
    action: text('action').notNull(),
    result: text('result').notNull(),
    failureCode: text('failure_code'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_project_admin_audits_time').on(table.createdAt, table.id),
    index('idx_project_admin_audits_project').on(
      table.projectSlugSnapshot,
      table.createdAt,
      table.id,
    ),
    index('idx_project_admin_audits_admin').on(
      table.adminUserId,
      table.createdAt,
      table.id,
    ),
    index('idx_project_admin_audits_action').on(
      table.action,
      table.createdAt,
      table.id,
    ),
  ],
);

export const reviewIssueEvents = sqliteTable(
  'review_issue_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    issueId: integer('issue_id')
      .notNull()
      .references(() => reviewIssues.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    note: text('note').notNull(),
    createdAt: text('created_at').notNull(),
    anonymousSourceHash: text('anonymous_source_hash'),
  },
  (table) => [
    index('idx_review_issue_events_issue_created').on(
      table.issueId,
      table.createdAt,
    ),
  ],
);

export const anonymousUpdateLimits = sqliteTable('anonymous_update_limits', {
  clientHash: text('client_hash').primaryKey(),
  windowStartedAt: text('window_started_at').notNull(),
  requestCount: integer('request_count').notNull(),
});

export const archiveOperationPreviews = sqliteTable(
  'archive_operation_previews',
  {
    token: text('token').primaryKey(),
    adminUserId: text('admin_user_id')
      .notNull()
      .references(() => adminUsers.userId, { onDelete: 'cascade' }),
    reviewIdsJson: text('review_ids_json').notNull(),
    reviewCount: integer('review_count').notNull(),
    revisionCount: integer('revision_count').notNull(),
    issueCount: integer('issue_count').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
);

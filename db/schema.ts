import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const reviewLogs = sqliteTable(
  'review_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
  },
  (table) => [
    uniqueIndex('idx_review_logs_source_key').on(table.sourceKey),
    index('idx_review_logs_log_date').on(table.logDate),
    index('idx_review_logs_severity').on(table.p1Count, table.p2Count),
  ],
);

export const reviewRevisions = sqliteTable(
  'review_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: integer('review_id').notNull(),
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
    reviewId: integer('review_id').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    relatedRevisions: text('related_revisions').notNull(),
    detail: text('detail').notNull(),
  },
  (table) => [
    index('idx_review_issues_review_id').on(table.reviewId),
    index('idx_review_issues_severity').on(table.severity),
  ],
);

export const adminUsers = sqliteTable('admin_users', {
  userId: text('user_id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull(),
});

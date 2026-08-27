CREATE TABLE `admin_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`related_revisions` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_review_issues_review_id` ON `review_issues` (`review_id`);--> statement-breakpoint
CREATE INDEX `idx_review_issues_severity` ON `review_issues` (`severity`);--> statement-breakpoint
CREATE TABLE `review_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`log_date` text NOT NULL,
	`source_key` text NOT NULL,
	`source_name` text NOT NULL,
	`source_hash` text NOT NULL,
	`content_object_key` text NOT NULL,
	`title` text NOT NULL,
	`overview` text NOT NULL,
	`scope_text` text NOT NULL,
	`revision_count` integer NOT NULL,
	`reviewed_count` integer NOT NULL,
	`skipped_count` integer NOT NULL,
	`p1_count` integer NOT NULL,
	`p2_count` integer NOT NULL,
	`p3_count` integer NOT NULL,
	`sync_mode` text NOT NULL,
	`imported_by` text NOT NULL,
	`imported_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_logs_source_key` ON `review_logs` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_review_logs_log_date` ON `review_logs` (`log_date`);--> statement-breakpoint
CREATE INDEX `idx_review_logs_severity` ON `review_logs` (`p1_count`,`p2_count`);--> statement-breakpoint
CREATE TABLE `review_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`author` text NOT NULL,
	`committed_at` text NOT NULL,
	`description` text NOT NULL,
	`conclusion` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_revisions_review_revision` ON `review_revisions` (`review_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_revision` ON `review_revisions` (`revision`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_author` ON `review_revisions` (`author`);
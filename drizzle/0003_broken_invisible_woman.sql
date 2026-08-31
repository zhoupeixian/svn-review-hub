CREATE TABLE `review_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_projects_name` ON `review_projects` ("name" COLLATE NOCASE);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_projects_slug` ON `review_projects` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_review_projects_directory` ON `review_projects` (`enabled`,`display_order`,`id`);--> statement-breakpoint
INSERT INTO `review_projects` (
	`id`, `name`, `slug`, `description`, `display_order`, `enabled`
) VALUES (1, 'ZHERP', 'zherp', '', 0, 1);--> statement-breakpoint
DROP TABLE IF EXISTS `__review_revisions_before_project`;--> statement-breakpoint
DROP TABLE IF EXISTS `__review_issues_before_project`;--> statement-breakpoint
DROP TABLE IF EXISTS `__review_issue_events_before_project`;--> statement-breakpoint
CREATE TABLE `__review_revisions_before_project` AS
SELECT * FROM `review_revisions`;--> statement-breakpoint
CREATE TABLE `__review_issues_before_project` AS
SELECT * FROM `review_issues`;--> statement-breakpoint
CREATE TABLE `__review_issue_events_before_project` AS
SELECT * FROM `review_issue_events`;--> statement-breakpoint
DROP TABLE `review_issue_events`;--> statement-breakpoint
DROP TABLE `review_issues`;--> statement-breakpoint
DROP TABLE `review_revisions`;--> statement-breakpoint
CREATE TABLE `__new_review_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer DEFAULT 1 NOT NULL,
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
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `review_projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_review_logs` (
	`id`, `project_id`, `log_date`, `source_key`, `source_name`, `source_hash`,
	`content_object_key`, `title`, `overview`, `scope_text`, `revision_count`,
	`reviewed_count`, `skipped_count`, `p1_count`, `p2_count`, `p3_count`,
	`sync_mode`, `imported_by`, `imported_at`, `updated_at`, `archived_at`
)
SELECT
	`id`, 1, `log_date`, `source_key`, `source_name`, `source_hash`,
	`content_object_key`, `title`, `overview`, `scope_text`, `revision_count`,
	`reviewed_count`, `skipped_count`, `p1_count`, `p2_count`, `p3_count`,
	`sync_mode`, `imported_by`, `imported_at`, `updated_at`, `archived_at`
FROM `review_logs`;--> statement-breakpoint
DROP TABLE `review_logs`;--> statement-breakpoint
ALTER TABLE `__new_review_logs` RENAME TO `review_logs`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_logs_project_source_key` ON `review_logs` (`project_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_review_logs_project_id` ON `review_logs` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_review_logs_log_date` ON `review_logs` (`log_date`);--> statement-breakpoint
CREATE INDEX `idx_review_logs_severity` ON `review_logs` (`p1_count`,`p2_count`);--> statement-breakpoint
CREATE INDEX `idx_review_logs_archive_date_id` ON `review_logs` (`archived_at`,`log_date`,`id`);--> statement-breakpoint
CREATE TABLE `review_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`author` text NOT NULL,
	`committed_at` text NOT NULL,
	`description` text NOT NULL,
	`conclusion` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `review_logs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `review_revisions` (
	`id`, `review_id`, `revision`, `author`, `committed_at`, `description`, `conclusion`
)
SELECT
	`id`, `review_id`, `revision`, `author`, `committed_at`, `description`, `conclusion`
FROM `__review_revisions_before_project`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_revisions_review_revision` ON `review_revisions` (`review_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_revision` ON `review_revisions` (`revision`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_author` ON `review_revisions` (`author`);--> statement-breakpoint
CREATE TABLE `review_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`issue_key` text,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`related_revisions` text NOT NULL,
	`detail` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`status_note` text,
	`status_updated_at` text,
	`source_current` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `review_logs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `review_issues` (
	`id`, `review_id`, `issue_key`, `severity`, `title`, `related_revisions`,
	`detail`, `status`, `status_note`, `status_updated_at`, `source_current`, `version`
)
SELECT
	`id`, `review_id`, `issue_key`, `severity`, `title`, `related_revisions`,
	`detail`, `status`, `status_note`, `status_updated_at`, `source_current`, `version`
FROM `__review_issues_before_project`;--> statement-breakpoint
CREATE INDEX `idx_review_issues_review_id` ON `review_issues` (`review_id`);--> statement-breakpoint
CREATE INDEX `idx_review_issues_severity` ON `review_issues` (`severity`);--> statement-breakpoint
CREATE INDEX `idx_review_issues_status_current_review` ON `review_issues` (`status`,`source_current`,`review_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_issues_review_issue_key` ON `review_issues` (`review_id`,`issue_key`) WHERE `issue_key` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `review_issue_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `review_issues`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `review_issue_events` (
	`id`, `issue_id`, `from_status`, `to_status`, `note`, `created_at`
)
SELECT
	`id`, `issue_id`, `from_status`, `to_status`, `note`, `created_at`
FROM `__review_issue_events_before_project`;--> statement-breakpoint
CREATE INDEX `idx_review_issue_events_issue_created` ON `review_issue_events` (`issue_id`,`created_at`);--> statement-breakpoint
DROP TABLE `__review_revisions_before_project`;--> statement-breakpoint
DROP TABLE `__review_issues_before_project`;--> statement-breakpoint
DROP TABLE `__review_issue_events_before_project`;

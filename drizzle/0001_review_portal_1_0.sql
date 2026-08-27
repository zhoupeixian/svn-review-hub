CREATE TABLE `anonymous_update_limits` (
	`client_hash` text PRIMARY KEY NOT NULL,
	`window_started_at` text NOT NULL,
	`request_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `archive_operation_previews` (
	`token` text PRIMARY KEY NOT NULL,
	`admin_user_id` text NOT NULL,
	`review_ids_json` text NOT NULL,
	`review_count` integer NOT NULL,
	`revision_count` integer NOT NULL,
	`issue_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `review_issue_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `review_issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_issue_events_issue_created` ON `review_issue_events` (`issue_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `review_issues` ADD `issue_key` text;--> statement-breakpoint
ALTER TABLE `review_issues` ADD `status` text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE `review_issues` ADD `status_note` text;--> statement-breakpoint
ALTER TABLE `review_issues` ADD `status_updated_at` text;--> statement-breakpoint
ALTER TABLE `review_issues` ADD `source_current` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_issues` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_review_issues_status_current_review` ON `review_issues` (`status`,`source_current`,`review_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_issues_review_issue_key` ON `review_issues` (`review_id`,`issue_key`) WHERE "review_issues"."issue_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `idx_review_logs_archive_date_id` ON `review_logs` (`archived_at`,`log_date`,`id`);
CREATE TABLE `project_admin_audits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id_snapshot` integer,
	`project_slug_snapshot` text,
	`project_name_snapshot` text,
	`project_snapshot_json` text NOT NULL,
	`admin_user_id` text NOT NULL,
	`admin_email_snapshot` text NOT NULL,
	`admin_display_name_snapshot` text NOT NULL,
	`action` text NOT NULL,
	`result` text NOT NULL,
	`failure_code` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_project_admin_audits_time` ON `project_admin_audits` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_project_admin_audits_project` ON `project_admin_audits` (`project_slug_snapshot`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_project_admin_audits_admin` ON `project_admin_audits` (`admin_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_project_admin_audits_action` ON `project_admin_audits` (`action`,`created_at`,`id`);
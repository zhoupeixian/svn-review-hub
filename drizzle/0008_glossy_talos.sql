CREATE TABLE `project_deletion_operations` (
	`project_id` integer PRIMARY KEY NOT NULL,
	`project_slug_snapshot` text NOT NULL,
	`project_name_snapshot` text NOT NULL,
	`project_snapshot_json` text NOT NULL,
	`started_at` text NOT NULL,
	`claim_token` text,
	`claim_expires_at` text
);

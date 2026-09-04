CREATE TABLE `review_object_cleanup_queue` (
	`object_key` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`ready` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_review_logs_content_object_key` ON `review_logs` (`content_object_key`);

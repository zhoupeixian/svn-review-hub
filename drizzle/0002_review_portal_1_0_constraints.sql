PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_review_issues` (
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
);
--> statement-breakpoint
INSERT INTO `__new_review_issues`("id", "review_id", "issue_key", "severity", "title", "related_revisions", "detail", "status", "status_note", "status_updated_at", "source_current", "version") SELECT "id", "review_id", "issue_key", "severity", "title", "related_revisions", "detail", "status", "status_note", "status_updated_at", "source_current", "version" FROM `review_issues`;--> statement-breakpoint
DROP TABLE `review_issues`;--> statement-breakpoint
ALTER TABLE `__new_review_issues` RENAME TO `review_issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_review_issues_review_id` ON `review_issues` (`review_id`);--> statement-breakpoint
CREATE INDEX `idx_review_issues_severity` ON `review_issues` (`severity`);--> statement-breakpoint
CREATE INDEX `idx_review_issues_status_current_review` ON `review_issues` (`status`,`source_current`,`review_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_issues_review_issue_key` ON `review_issues` (`review_id`,`issue_key`) WHERE "review_issues"."issue_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_review_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`author` text NOT NULL,
	`committed_at` text NOT NULL,
	`description` text NOT NULL,
	`conclusion` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `review_logs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_review_revisions`("id", "review_id", "revision", "author", "committed_at", "description", "conclusion") SELECT "id", "review_id", "revision", "author", "committed_at", "description", "conclusion" FROM `review_revisions`;--> statement-breakpoint
DROP TABLE `review_revisions`;--> statement-breakpoint
ALTER TABLE `__new_review_revisions` RENAME TO `review_revisions`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_revisions_review_revision` ON `review_revisions` (`review_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_revision` ON `review_revisions` (`revision`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_author` ON `review_revisions` (`author`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `review_search` USING fts5(
	`review_id` UNINDEXED,
	`title`,
	`overview`,
	`scope_text`,
	`revisions`,
	`authors`,
	`descriptions`,
	`issue_titles`,
	`issue_details`,
	`status_notes`,
	tokenize='trigram'
);
--> statement-breakpoint
INSERT INTO `review_search` (
	rowid, review_id, title, overview, scope_text, revisions, authors,
	descriptions, issue_titles, issue_details, status_notes
)
SELECT
	l.id,
	l.id,
	l.title,
	l.overview,
	l.scope_text,
	COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
	COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
	COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
	COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
	COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
	COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
FROM review_logs l;
--> statement-breakpoint
CREATE TRIGGER `review_search_logs_ai` AFTER INSERT ON `review_logs` BEGIN
	DELETE FROM review_search WHERE rowid = NEW.id;
	INSERT INTO review_search (rowid, review_id, title, overview, scope_text, revisions, authors, descriptions, issue_titles, issue_details, status_notes)
	SELECT l.id, l.id, l.title, l.overview, l.scope_text,
		COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
	FROM review_logs l WHERE l.id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `review_search_logs_au` AFTER UPDATE ON `review_logs` BEGIN
	DELETE FROM review_search WHERE rowid = NEW.id;
	INSERT INTO review_search (rowid, review_id, title, overview, scope_text, revisions, authors, descriptions, issue_titles, issue_details, status_notes)
	SELECT l.id, l.id, l.title, l.overview, l.scope_text,
		COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
	FROM review_logs l WHERE l.id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `review_search_logs_ad` AFTER DELETE ON `review_logs` BEGIN
	DELETE FROM review_search WHERE rowid = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `review_search_revisions_ai` AFTER INSERT ON `review_revisions` BEGIN
	DELETE FROM review_search WHERE rowid = NEW.review_id;
	INSERT INTO review_search (rowid, review_id, title, overview, scope_text, revisions, authors, descriptions, issue_titles, issue_details, status_notes)
	SELECT l.id, l.id, l.title, l.overview, l.scope_text,
		COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
	FROM review_logs l WHERE l.id = NEW.review_id;
END;
--> statement-breakpoint
CREATE TRIGGER `review_search_revisions_au` AFTER UPDATE ON `review_revisions` BEGIN
	DELETE FROM review_search WHERE rowid IN (OLD.review_id, NEW.review_id);
	INSERT INTO review_search (rowid, review_id, title, overview, scope_text, revisions, authors, descriptions, issue_titles, issue_details, status_notes)
	SELECT l.id, l.id, l.title, l.overview, l.scope_text,
		COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
	FROM review_logs l WHERE l.id IN (OLD.review_id, NEW.review_id);
END;
--> statement-breakpoint
CREATE TRIGGER `review_search_revisions_ad` AFTER DELETE ON `review_revisions` BEGIN
	DELETE FROM review_search WHERE rowid = OLD.review_id;
	INSERT INTO review_search (rowid, review_id, title, overview, scope_text, revisions, authors, descriptions, issue_titles, issue_details, status_notes)
	SELECT l.id, l.id, l.title, l.overview, l.scope_text,
		COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
	FROM review_logs l WHERE l.id = OLD.review_id;
END;
--> statement-breakpoint
CREATE TRIGGER `review_search_issues_ai` AFTER INSERT ON `review_issues` BEGIN
	DELETE FROM review_search WHERE rowid = NEW.review_id;
	INSERT INTO review_search (rowid, review_id, title, overview, scope_text, revisions, authors, descriptions, issue_titles, issue_details, status_notes)
	SELECT l.id, l.id, l.title, l.overview, l.scope_text,
		COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
	FROM review_logs l WHERE l.id = NEW.review_id;
END;
--> statement-breakpoint
CREATE TRIGGER `review_search_issues_au` AFTER UPDATE ON `review_issues` BEGIN
	DELETE FROM review_search WHERE rowid IN (OLD.review_id, NEW.review_id);
	INSERT INTO review_search (rowid, review_id, title, overview, scope_text, revisions, authors, descriptions, issue_titles, issue_details, status_notes)
	SELECT l.id, l.id, l.title, l.overview, l.scope_text,
		COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
	FROM review_logs l WHERE l.id IN (OLD.review_id, NEW.review_id);
END;
--> statement-breakpoint
CREATE TRIGGER `review_search_issues_ad` AFTER DELETE ON `review_issues` BEGIN
	DELETE FROM review_search WHERE rowid = OLD.review_id;
	INSERT INTO review_search (rowid, review_id, title, overview, scope_text, revisions, authors, descriptions, issue_titles, issue_details, status_notes)
	SELECT l.id, l.id, l.title, l.overview, l.scope_text,
		COALESCE((SELECT group_concat('r' || revision, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(author, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(description, ' ') FROM review_revisions WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(title, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(detail, ' ') FROM review_issues WHERE review_id = l.id), ''),
		COALESCE((SELECT group_concat(status_note, ' ') FROM review_issues WHERE review_id = l.id), '')
	FROM review_logs l WHERE l.id = OLD.review_id;
END;

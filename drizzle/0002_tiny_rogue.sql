ALTER TABLE `files` ADD `is_pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `files_owner_pinned_idx` ON `files` (`owner_id`,`is_pinned`,`status`);
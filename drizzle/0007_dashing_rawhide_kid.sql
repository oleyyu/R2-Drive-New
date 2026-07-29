ALTER TABLE `files` ADD `purge_operation_id` text;--> statement-breakpoint
ALTER TABLE `files` ADD `purge_root_id` text;--> statement-breakpoint
ALTER TABLE `files` ADD `purge_claim_token` text;--> statement-breakpoint
CREATE INDEX `files_owner_purge_idx` ON `files` (`owner_id`,`purge_operation_id`,`status`,`purge_claim_token`);
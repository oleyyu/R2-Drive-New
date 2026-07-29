CREATE TABLE `storage_node_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_node_enrollments_token_idx` ON `storage_node_enrollments` (`token_hash`);--> statement-breakpoint
CREATE INDEX `storage_node_enrollments_expiry_idx` ON `storage_node_enrollments` (`expires_at`);--> statement-breakpoint
CREATE TABLE `storage_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text DEFAULT 'worker_proxy' NOT NULL,
	`account_id` text NOT NULL,
	`bucket_name` text NOT NULL,
	`worker_name` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`soft_limit_bytes` integer NOT NULL,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`managed_bucket` integer DEFAULT false NOT NULL,
	`managed_worker` integer DEFAULT false NOT NULL,
	`last_health_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_nodes_account_bucket_idx` ON `storage_nodes` (`account_id`,`bucket_name`);--> statement-breakpoint
CREATE INDEX `storage_nodes_status_idx` ON `storage_nodes` (`status`);--> statement-breakpoint
ALTER TABLE `files` ADD `storage_node_id` text REFERENCES storage_nodes(id);--> statement-breakpoint
CREATE INDEX `files_storage_node_idx` ON `files` (`storage_node_id`,`status`);--> statement-breakpoint
ALTER TABLE `multipart_uploads` ADD `storage_node_id` text REFERENCES storage_nodes(id);--> statement-breakpoint
ALTER TABLE `multipart_uploads` ADD `reserved_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `multipart_uploads`
SET `reserved_bytes` = COALESCE(
	(SELECT `size` FROM `files` WHERE `files`.`id` = `multipart_uploads`.`file_id`),
	0
);--> statement-breakpoint
CREATE INDEX `multipart_storage_node_idx` ON `multipart_uploads` (`storage_node_id`,`expires_at`);

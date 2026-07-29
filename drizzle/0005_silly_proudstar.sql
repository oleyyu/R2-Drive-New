ALTER TABLE `users` ADD `storage_reserved` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `users`
SET `storage_reserved` = COALESCE(
	(
		SELECT SUM(`reserved_bytes`)
		FROM `multipart_uploads`
		WHERE `multipart_uploads`.`owner_id` = `users`.`id`
	),
	0
);

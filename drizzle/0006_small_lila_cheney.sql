ALTER TABLE `storage_nodes` ADD `quota_owner_id` text REFERENCES users(id);
--> statement-breakpoint
UPDATE `storage_nodes`
SET `quota_owner_id` = COALESCE(
	(
		SELECT `actor_id`
		FROM `audit_events`
		WHERE `action` IN ('storage_node.connected', 'storage_node.reconnected')
			AND `target_type` = 'storage_node'
			AND `target_id` = `storage_nodes`.`id`
			AND `actor_id` IS NOT NULL
		ORDER BY `created_at` ASC
		LIMIT 1
	),
	(
		SELECT `id`
		FROM `users`
		WHERE `role` = 'admin'
		ORDER BY `created_at` ASC
		LIMIT 1
	)
);

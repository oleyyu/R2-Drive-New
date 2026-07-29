import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    storageQuota: integer("storage_quota").notNull(),
    storageUsed: integer("storage_used").notNull().default(0),
    storageReserved: integer("storage_reserved").notNull().default(0),
    preferences: text("preferences").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)],
);

export const storageNodes = sqliteTable(
  "storage_nodes",
  {
    id: text("id").primaryKey(),
    quotaOwnerId: text("quota_owner_id").references(() => users.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    kind: text("kind", { enum: ["worker_proxy"] }).notNull().default("worker_proxy"),
    accountId: text("account_id").notNull(),
    bucketName: text("bucket_name").notNull(),
    workerName: text("worker_name").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status", { enum: ["active", "draining", "offline"] }).notNull().default("active"),
    softLimitBytes: integer("soft_limit_bytes").notNull(),
    usedBytes: integer("used_bytes").notNull().default(0),
    reservedBytes: integer("reserved_bytes").notNull().default(0),
    managedBucket: integer("managed_bucket", { mode: "boolean" }).notNull().default(false),
    managedWorker: integer("managed_worker", { mode: "boolean" }).notNull().default(false),
    lastHealthAt: text("last_health_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("storage_nodes_account_bucket_idx").on(table.accountId, table.bucketName),
    index("storage_nodes_status_idx").on(table.status),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    userAgent: text("user_agent"),
  },
  (table) => [index("sessions_user_idx").on(table.userId), index("sessions_expiry_idx").on(table.expiresAt)],
);

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    kind: text("kind", { enum: ["file", "folder"] }).notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    storageKey: text("storage_key"),
    storageNodeId: text("storage_node_id").references(() => storageNodes.id, { onDelete: "restrict" }),
    size: integer("size").notNull().default(0),
    contentType: text("content_type"),
    etag: text("etag"),
    isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["uploading", "ready", "failed", "deleted", "purging"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    purgeOperationId: text("purge_operation_id"),
    purgeRootId: text("purge_root_id"),
    purgeClaimToken: text("purge_claim_token"),
  },
  (table) => [
    index("files_owner_parent_idx").on(table.ownerId, table.parentId, table.status),
    index("files_storage_key_idx").on(table.storageKey),
    index("files_storage_node_idx").on(table.storageNodeId, table.status),
    index("files_owner_pinned_idx").on(table.ownerId, table.isPinned, table.status),
    index("files_owner_purge_idx").on(
      table.ownerId,
      table.purgeOperationId,
      table.status,
      table.purgeClaimToken,
    ),
  ],
);

export const multipartUploads = sqliteTable(
  "multipart_uploads",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    uploadId: text("upload_id").notNull(),
    storageKey: text("storage_key").notNull(),
    storageNodeId: text("storage_node_id").references(() => storageNodes.id, { onDelete: "restrict" }),
    reservedBytes: integer("reserved_bytes").notNull().default(0),
    partSize: integer("part_size").notNull(),
    expectedParts: integer("expected_parts").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("multipart_file_idx").on(table.fileId),
    index("multipart_expiry_idx").on(table.expiresAt),
    index("multipart_storage_node_idx").on(table.storageNodeId, table.expiresAt),
  ],
);

export const storageNodeEnrollments = sqliteTable(
  "storage_node_enrollments",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    completedNodeId: text("completed_node_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("storage_node_enrollments_token_idx").on(table.tokenHash),
    index("storage_node_enrollments_expiry_idx").on(table.expiresAt),
  ],
);

export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    tokenValue: text("token_value"),
    expiresAt: text("expires_at"),
    maxDownloads: integer("max_downloads"),
    downloadCount: integer("download_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("shares_token_idx").on(table.tokenHash), index("shares_file_idx").on(table.fileId)],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes").notNull(),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("api_tokens_hash_idx").on(table.tokenHash), index("api_tokens_user_idx").on(table.userId)],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    email: text("email"),
    tokenHash: text("token_hash").notNull(),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: text("expires_at").notNull(),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("invitations_token_idx").on(table.tokenHash),
    index("invitations_expiry_idx").on(table.expiresAt),
  ],
);

export const systemSettings = sqliteTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("audit_created_idx").on(table.createdAt), index("audit_actor_idx").on(table.actorId)],
);

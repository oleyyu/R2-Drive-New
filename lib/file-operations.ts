import { getFileBucket } from "@/db/runtime";
import {
  deleteNodeObjects,
  getStorageNode,
} from "@/lib/storage";

export type FileTreeRow = {
  id: string;
  kind: "file" | "folder";
  storage_key: string | null;
  storage_node_id: string | null;
  size: number;
  etag: string | null;
};

export async function readFileTree(
  db: D1Database,
  ownerId: string,
  rootId: string,
): Promise<FileTreeRow[]> {
  const result = await db
    .prepare(
      `WITH RECURSIVE tree(id, kind, storage_key, storage_node_id, size, etag) AS (
         SELECT id, kind, storage_key, storage_node_id, size, etag
         FROM files
         WHERE id = ? AND owner_id = ?
         UNION ALL
         SELECT child.id, child.kind, child.storage_key, child.storage_node_id,
                child.size, child.etag
         FROM files child
         JOIN tree parent ON child.parent_id = parent.id
         WHERE child.owner_id = ?
       )
       SELECT id, kind, storage_key, storage_node_id, size, etag FROM tree`,
    )
    .bind(rootId, ownerId, ownerId)
    .all<FileTreeRow>();
  return result.results;
}

const PURGE_BATCH_SIZE = 500;
const STALE_PURGE_MS = 15 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PurgeOperation = {
  operationId: string;
  rootId: string;
  claimToken: string;
  legacyDeletedAt: string | null;
};

type PurgeAnchorRow = {
  id: string;
  status: "deleted" | "purging" | string;
  deleted_at: string | null;
  updated_at: string;
  purge_operation_id: string | null;
  purge_root_id: string | null;
  purge_claim_token: string | null;
};

type PurgeStatsRow = {
  deleted_items: number;
  released_bytes: number;
};

class PurgeLeaseLostError extends Error {
  constructor() {
    super("永久删除任务已由另一个请求接管。");
  }
}

async function deletePrimaryR2Objects(
  keys: string[],
  heartbeat?: () => Promise<void>,
): Promise<void> {
  const bucket = getFileBucket();
  for (let offset = 0; offset < keys.length; offset += 1_000) {
    await bucket.delete(keys.slice(offset, offset + 1_000));
    await heartbeat?.();
  }
}

async function deleteStoredObjects(
  db: D1Database,
  files: FileTreeRow[],
  heartbeat?: () => Promise<void>,
): Promise<void> {
  const primaryKeys: string[] = [];
  const remoteKeys = new Map<string, string[]>();
  for (const file of files) {
    if (!file.storage_key) continue;
    if (!file.storage_node_id) {
      primaryKeys.push(file.storage_key);
      continue;
    }
    const keys = remoteKeys.get(file.storage_node_id) ?? [];
    keys.push(file.storage_key);
    remoteKeys.set(file.storage_node_id, keys);
  }
  if (primaryKeys.length) {
    await deletePrimaryR2Objects(primaryKeys, heartbeat);
  }
  for (const [nodeId, keys] of remoteKeys) {
    const node = await getStorageNode(db, nodeId);
    if (!node) {
      throw new Error(`文件所属的存储节点 ${nodeId} 不存在，无法永久删除。`);
    }
    for (let offset = 0; offset < keys.length; offset += PURGE_BATCH_SIZE) {
      await deleteNodeObjects(
        node,
        keys.slice(offset, offset + PURGE_BATCH_SIZE),
      );
      await heartbeat?.();
    }
  }
}

async function readPurgeAnchor(
  db: D1Database,
  ownerId: string,
  fileId: string,
): Promise<PurgeAnchorRow | null> {
  return db
    .prepare(
      `SELECT id, status, deleted_at, updated_at, purge_operation_id,
              purge_root_id, purge_claim_token
       FROM files
       WHERE id = ? AND owner_id = ?`,
    )
    .bind(fileId, ownerId)
    .first<PurgeAnchorRow>();
}

function validatePurgeIdentity(
  operationId: string | null,
  rootId: string | null,
): { operationId: string; rootId: string } {
  if (
    !operationId ||
    !rootId ||
    !UUID_PATTERN.test(operationId) ||
    !UUID_PATTERN.test(rootId)
  ) {
    throw new Error("永久删除任务记录无效，已停止以保护文件。");
  }
  return { operationId, rootId };
}

async function heartbeatPurgeLease(
  db: D1Database,
  ownerId: string,
  operation: PurgeOperation,
): Promise<void> {
  const heartbeat = await db
    .prepare(
      `UPDATE files
       SET updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'purging'
         AND purge_operation_id = ? AND purge_root_id = ?
         AND purge_claim_token = ?`,
    )
    .bind(
      new Date().toISOString(),
      operation.rootId,
      ownerId,
      operation.operationId,
      operation.rootId,
      operation.claimToken,
    )
    .run();
  if (Number(heartbeat.meta.changes ?? 0) !== 1) {
    throw new PurgeLeaseLostError();
  }
}

async function releasePurgeLease(
  db: D1Database,
  ownerId: string,
  operation: PurgeOperation,
): Promise<void> {
  // The objects may already be gone or their delete response may have been
  // lost. Never make these rows restorable again. Clearing only this lease
  // makes the same purging operation immediately available for an idempotent
  // retry while preserving its full discovery set.
  await db
    .prepare(
      `UPDATE files
       SET purge_claim_token = NULL, updated_at = ?
       WHERE owner_id = ? AND status = 'purging'
         AND purge_operation_id = ? AND purge_root_id = ?
         AND purge_claim_token = ?`,
    )
    .bind(
      new Date().toISOString(),
      ownerId,
      operation.operationId,
      operation.rootId,
      operation.claimToken,
    )
    .run();
}

async function acquirePurgeOperation(
  db: D1Database,
  ownerId: string,
  operationId: string,
  rootId: string,
): Promise<PurgeOperation | null> {
  validatePurgeIdentity(operationId, rootId);
  const claimToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_PURGE_MS).toISOString();
  const acquired = await db
    .prepare(
      `UPDATE files
       SET purge_claim_token = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'purging'
         AND purge_operation_id = ? AND purge_root_id = ?
         AND (
           purge_claim_token IS NULL
           OR updated_at < ?
         )`,
    )
    .bind(
      claimToken,
      now,
      rootId,
      ownerId,
      operationId,
      rootId,
      staleBefore,
    )
    .run();
  if (Number(acquired.meta.changes ?? 0) !== 1) return null;
  const root = await readPurgeAnchor(db, ownerId, rootId);
  if (
    !root ||
    root.status !== "purging" ||
    root.purge_operation_id !== operationId ||
    root.purge_root_id !== rootId ||
    root.purge_claim_token !== claimToken
  ) {
    throw new PurgeLeaseLostError();
  }
  return {
    operationId,
    rootId,
    claimToken,
    legacyDeletedAt:
      root.deleted_at?.startsWith("purge:") ? root.deleted_at : null,
  };
}

async function startPurgeOperation(
  db: D1Database,
  ownerId: string,
  rootId: string,
): Promise<PurgeOperation | null> {
  const operationId = crypto.randomUUID();
  const claimToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const started = await db
    .prepare(
      `UPDATE files
       SET status = 'purging',
           purge_operation_id = ?,
           purge_root_id = ?,
           purge_claim_token = ?,
           updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'deleted'
         AND purge_operation_id IS NULL`,
    )
    .bind(
      operationId,
      rootId,
      claimToken,
      now,
      rootId,
      ownerId,
    )
    .run();
  if (Number(started.meta.changes ?? 0) !== 1) return null;
  return {
    operationId,
    rootId,
    claimToken,
    legacyDeletedAt: null,
  };
}

async function adoptLegacyPurgeOperation(
  db: D1Database,
  ownerId: string,
  root: PurgeAnchorRow,
): Promise<PurgeOperation | null> {
  const operationId = crypto.randomUUID();
  const claimToken = crypto.randomUUID();
  const adopted = await db
    .prepare(
      `UPDATE files
       SET purge_operation_id = ?,
           purge_root_id = ?,
           purge_claim_token = ?,
           updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'purging'
         AND purge_operation_id IS NULL`,
    )
    .bind(
      operationId,
      root.id,
      claimToken,
      new Date().toISOString(),
      root.id,
      ownerId,
    )
    .run();
  if (Number(adopted.meta.changes ?? 0) !== 1) return null;
  return {
    operationId,
    rootId: root.id,
    claimToken,
    legacyDeletedAt:
      root.deleted_at?.startsWith("purge:") ? root.deleted_at : null,
  };
}

async function operationForFile(
  db: D1Database,
  ownerId: string,
  fileId: string,
): Promise<PurgeOperation | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await readPurgeAnchor(db, ownerId, fileId);
    if (!row) return null;
    if (row.status === "deleted") {
      const started = await startPurgeOperation(db, ownerId, fileId);
      if (started) return started;
      continue;
    }
    if (row.status !== "purging") return null;
    if (!row.purge_operation_id || !row.purge_root_id) {
      const adopted = await adoptLegacyPurgeOperation(db, ownerId, row);
      if (adopted) return adopted;
      continue;
    }
    const identity = validatePurgeIdentity(
      row.purge_operation_id,
      row.purge_root_id,
    );
    return acquirePurgeOperation(
      db,
      ownerId,
      identity.operationId,
      identity.rootId,
    );
  }
  return null;
}

async function adoptLegacyOperationRows(
  db: D1Database,
  ownerId: string,
  operation: PurgeOperation,
): Promise<void> {
  if (!operation.legacyDeletedAt) return;
  while (true) {
    const now = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE files
           SET purge_operation_id = ?,
               purge_root_id = ?,
               purge_claim_token = NULL,
               updated_at = ?
           WHERE id IN (
             SELECT id
             FROM files
             WHERE owner_id = ? AND status = 'purging'
               AND purge_operation_id IS NULL AND deleted_at = ?
             ORDER BY id
             LIMIT ?
           )`,
        )
        .bind(
          operation.operationId,
          operation.rootId,
          now,
          ownerId,
          operation.legacyDeletedAt,
          PURGE_BATCH_SIZE,
        ),
      db
        .prepare(
          `UPDATE files SET updated_at = ?
           WHERE id = ? AND owner_id = ? AND status = 'purging'
             AND purge_operation_id = ? AND purge_root_id = ?
             AND purge_claim_token = ?`,
        )
        .bind(
          now,
          operation.rootId,
          ownerId,
          operation.operationId,
          operation.rootId,
          operation.claimToken,
        ),
    ]);
    if (Number(results[1]?.meta.changes ?? 0) !== 1) {
      throw new PurgeLeaseLostError();
    }
    if (Number(results[0]?.meta.changes ?? 0) === 0) return;
  }
}

async function discoverPurgeTree(
  db: D1Database,
  ownerId: string,
  operation: PurgeOperation,
): Promise<void> {
  await adoptLegacyOperationRows(db, ownerId, operation);
  while (true) {
    const now = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE files
           SET status = 'purging',
               purge_operation_id = ?,
               purge_root_id = ?,
               purge_claim_token = NULL,
               updated_at = ?
           WHERE id IN (
             SELECT child.id
             FROM files child
             JOIN files parent ON child.parent_id = parent.id
             WHERE child.owner_id = ? AND child.status = 'deleted'
               AND parent.owner_id = ?
               AND parent.status = 'purging'
               AND parent.purge_operation_id = ?
               AND parent.purge_root_id = ?
             ORDER BY child.id
             LIMIT ?
           )`,
        )
        .bind(
          operation.operationId,
          operation.rootId,
          now,
          ownerId,
          ownerId,
          operation.operationId,
          operation.rootId,
          PURGE_BATCH_SIZE,
        ),
      db
        .prepare(
          `UPDATE files SET updated_at = ?
           WHERE id = ? AND owner_id = ? AND status = 'purging'
             AND purge_operation_id = ? AND purge_root_id = ?
             AND purge_claim_token = ?`,
        )
        .bind(
          now,
          operation.rootId,
          ownerId,
          operation.operationId,
          operation.rootId,
          operation.claimToken,
        ),
    ]);
    if (Number(results[1]?.meta.changes ?? 0) !== 1) {
      throw new PurgeLeaseLostError();
    }
    if (Number(results[0]?.meta.changes ?? 0) === 0) return;
  }
}

async function claimNextPurgeBatch(
  db: D1Database,
  ownerId: string,
  operation: PurgeOperation,
): Promise<FileTreeRow[]> {
  const claimed = await db
    .prepare(
      `UPDATE files
       SET purge_claim_token = ?, updated_at = ?
       WHERE id IN (
         SELECT id
         FROM files
         WHERE owner_id = ? AND status = 'purging'
           AND purge_operation_id = ? AND purge_root_id = ?
           AND id != ? AND purge_claim_token IS NOT ?
         ORDER BY id
         LIMIT ?
       )
       RETURNING id, kind, storage_key, storage_node_id, size, etag`,
    )
    .bind(
      operation.claimToken,
      new Date().toISOString(),
      ownerId,
      operation.operationId,
      operation.rootId,
      operation.rootId,
      operation.claimToken,
      PURGE_BATCH_SIZE,
    )
    .run<FileTreeRow>();
  return claimed.results ?? [];
}

async function readClaimedRoot(
  db: D1Database,
  ownerId: string,
  operation: PurgeOperation,
): Promise<FileTreeRow | null> {
  return db
    .prepare(
      `SELECT id, kind, storage_key, storage_node_id, size, etag
       FROM files
       WHERE id = ? AND owner_id = ? AND status = 'purging'
         AND purge_operation_id = ? AND purge_root_id = ?
         AND purge_claim_token = ?`,
    )
    .bind(
      operation.rootId,
      ownerId,
      operation.operationId,
      operation.rootId,
      operation.claimToken,
    )
    .first<FileTreeRow>();
}

function billableNodeIds(files: FileTreeRow[]): string[] {
  return [
    ...new Set(
      files
        .filter(
          (file) =>
            file.kind === "file" &&
            Boolean(file.etag) &&
            Boolean(file.storage_node_id) &&
            file.size > 0,
        )
        .map((file) => file.storage_node_id as string),
    ),
  ];
}

async function settlePurgeBatch(
  db: D1Database,
  ownerId: string,
  operation: PurgeOperation,
  files: FileTreeRow[],
  rootOnly: boolean,
): Promise<{ deletedItems: number; releasedBytes: number }> {
  const itemScope = rootOnly ? "id = ?3" : "id != ?3";
  const claimWhere = `
    owner_id = ?1 AND status = 'purging'
    AND purge_operation_id = ?2 AND purge_root_id = ?3
    AND purge_claim_token = ?4 AND ${itemScope}
  `;
  const now = new Date().toISOString();
  const bindClaim = (statement: D1PreparedStatement) =>
    statement.bind(
      ownerId,
      operation.operationId,
      operation.rootId,
      operation.claimToken,
    );
  const statements: D1PreparedStatement[] = [
    bindClaim(
      db.prepare(
        `SELECT COUNT(*) AS deleted_items,
                COALESCE(SUM(
                  CASE
                    WHEN kind = 'file' AND etag IS NOT NULL AND size > 0
                      THEN size
                    ELSE 0
                  END
                ), 0) AS released_bytes
         FROM files
         WHERE ${claimWhere}`,
      ),
    ),
  ];
  const userStatementIndex = statements.length;
  statements.push(
    db
      .prepare(
        `UPDATE users
         SET storage_used = MAX(
               0,
               storage_used - COALESCE(
                 (
                   SELECT SUM(
                     CASE
                       WHEN kind = 'file' AND etag IS NOT NULL AND size > 0
                         THEN size
                       ELSE 0
                     END
                   )
                   FROM files
                   WHERE ${claimWhere}
                 ),
                 0
               )
             ),
             updated_at = ?5
         WHERE id = ?1
           AND EXISTS (SELECT 1 FROM files WHERE ${claimWhere})`,
      )
      .bind(
        ownerId,
        operation.operationId,
        operation.rootId,
        operation.claimToken,
        now,
      ),
  );
  for (const nodeId of billableNodeIds(files)) {
    statements.push(
      db
        .prepare(
          `UPDATE storage_nodes
           SET used_bytes = MAX(
                 0,
                 used_bytes - COALESCE(
                   (
                     SELECT SUM(size)
                     FROM files
                     WHERE ${claimWhere}
                       AND kind = 'file' AND etag IS NOT NULL AND size > 0
                       AND storage_node_id = ?5
                   ),
                   0
                 )
               ),
               updated_at = ?6
           WHERE id = ?5
             AND EXISTS (
               SELECT 1 FROM files
               WHERE ${claimWhere} AND storage_node_id = ?5
             )`,
        )
        .bind(
          ownerId,
          operation.operationId,
          operation.rootId,
          operation.claimToken,
          nodeId,
          now,
        ),
    );
  }
  const deleteStatementIndex = statements.length;
  statements.push(
    bindClaim(
      db.prepare(`DELETE FROM files WHERE ${claimWhere}`),
    ),
  );
  const heartbeatStatementIndex = rootOnly ? -1 : statements.length;
  if (!rootOnly) {
    statements.push(
      db
        .prepare(
          `UPDATE files SET updated_at = ?
           WHERE id = ? AND owner_id = ? AND status = 'purging'
             AND purge_operation_id = ? AND purge_root_id = ?
             AND purge_claim_token = ?`,
        )
        .bind(
          now,
          operation.rootId,
          ownerId,
          operation.operationId,
          operation.rootId,
          operation.claimToken,
        ),
    );
  }

  const results = await db.batch(statements);
  const stats = (results[0]?.results?.[0] ?? null) as PurgeStatsRow | null;
  const deletedItems = Number(
    results[deleteStatementIndex]?.meta.changes ?? 0,
  );
  const expectedItems = Number(stats?.deleted_items ?? 0);
  const releasedBytes = Number(stats?.released_bytes ?? 0);
  if (deletedItems !== expectedItems) {
    throw new Error("永久删除结算数量不一致；任务仍可安全重试。");
  }
  if (
    expectedItems > 0 &&
    Number(results[userStatementIndex]?.meta.changes ?? 0) !== 1
  ) {
    throw new Error("永久删除未能结算用户容量；任务仍可安全重试。");
  }
  if (
    heartbeatStatementIndex >= 0 &&
    Number(results[heartbeatStatementIndex]?.meta.changes ?? 0) !== 1
  ) {
    throw new PurgeLeaseLostError();
  }
  if (rootOnly && expectedItems !== 1) {
    throw new PurgeLeaseLostError();
  }
  return { deletedItems, releasedBytes };
}

async function executePurgeOperation(
  db: D1Database,
  ownerId: string,
  operation: PurgeOperation,
): Promise<{ deletedItems: number; releasedBytes: number }> {
  let deletedItems = 0;
  let releasedBytes = 0;
  try {
    await discoverPurgeTree(db, ownerId, operation);
    while (true) {
      const files = await claimNextPurgeBatch(db, ownerId, operation);
      if (files.length === 0) break;
      await deleteStoredObjects(db, files, () =>
        heartbeatPurgeLease(db, ownerId, operation),
      );
      const settled = await settlePurgeBatch(
        db,
        ownerId,
        operation,
        files,
        false,
      );
      deletedItems += settled.deletedItems;
      releasedBytes += settled.releasedBytes;
    }

    const root = await readClaimedRoot(db, ownerId, operation);
    if (!root) throw new PurgeLeaseLostError();
    await deleteStoredObjects(db, [root], () =>
      heartbeatPurgeLease(db, ownerId, operation),
    );
    const settledRoot = await settlePurgeBatch(
      db,
      ownerId,
      operation,
      [root],
      true,
    );
    deletedItems += settledRoot.deletedItems;
    releasedBytes += settledRoot.releasedBytes;
    return { deletedItems, releasedBytes };
  } catch (error) {
    await releasePurgeLease(db, ownerId, operation).catch(() => undefined);
    throw error;
  }
}

async function pendingPurgeOperations(
  db: D1Database,
  ownerId: string,
): Promise<Array<{ operationId: string; rootId: string }>> {
  const result = await db
    .prepare(
      `SELECT purge_operation_id, purge_root_id
       FROM files
       WHERE owner_id = ? AND status = 'purging'
         AND purge_operation_id IS NOT NULL
         AND purge_root_id IS NOT NULL
       GROUP BY purge_operation_id, purge_root_id
       ORDER BY MIN(updated_at) ASC
       LIMIT 50`,
    )
    .bind(ownerId)
    .all<{ purge_operation_id: string; purge_root_id: string }>();
  return result.results.map((row) =>
    validatePurgeIdentity(row.purge_operation_id, row.purge_root_id),
  );
}

async function findLegacyPurgeRoot(
  db: D1Database,
  ownerId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id
       FROM files
       WHERE owner_id = ? AND status = 'purging'
         AND purge_operation_id IS NULL
       ORDER BY updated_at ASC, id ASC
       LIMIT 1`,
    )
    .bind(ownerId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function findDeletedTrashRoot(
  db: D1Database,
  ownerId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT child.id
       FROM files child
       WHERE child.owner_id = ? AND child.status = 'deleted'
         AND child.purge_operation_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM files parent
           WHERE parent.id = child.parent_id
             AND parent.owner_id = child.owner_id
             AND parent.status = 'deleted'
         )
       ORDER BY child.deleted_at ASC, child.id ASC
       LIMIT 1`,
    )
    .bind(ownerId)
    .first<{ id: string }>();
  if (row?.id) return row.id;
  const cyclicOrOrphan = await db
    .prepare(
      `SELECT id
       FROM files
       WHERE owner_id = ? AND status = 'deleted'
         AND purge_operation_id IS NULL
       ORDER BY deleted_at ASC, id ASC
       LIMIT 1`,
    )
    .bind(ownerId)
    .first<{ id: string }>();
  return cyclicOrOrphan?.id ?? null;
}

async function nextTrashOperation(
  db: D1Database,
  ownerId: string,
): Promise<PurgeOperation | null> {
  for (const pending of await pendingPurgeOperations(db, ownerId)) {
    const acquired = await acquirePurgeOperation(
      db,
      ownerId,
      pending.operationId,
      pending.rootId,
    );
    if (acquired) return acquired;
  }
  const legacyRoot = await findLegacyPurgeRoot(db, ownerId);
  if (legacyRoot) {
    const legacy = await operationForFile(db, ownerId, legacyRoot);
    if (legacy) return legacy;
  }
  const deletedRoot = await findDeletedTrashRoot(db, ownerId);
  return deletedRoot
    ? operationForFile(db, ownerId, deletedRoot)
    : null;
}

export async function permanentlyDeleteTree(
  db: D1Database,
  ownerId: string,
  rootId: string,
): Promise<{ deletedItems: number; releasedBytes: number }> {
  const operation = await operationForFile(db, ownerId, rootId);
  return operation
    ? executePurgeOperation(db, ownerId, operation)
    : { deletedItems: 0, releasedBytes: 0 };
}

export async function emptyTrash(
  db: D1Database,
  ownerId: string,
): Promise<{ deletedItems: number; releasedBytes: number }> {
  let deletedItems = 0;
  let releasedBytes = 0;
  while (true) {
    const operation = await nextTrashOperation(db, ownerId);
    if (!operation) {
      return { deletedItems, releasedBytes };
    }
    const settled = await executePurgeOperation(db, ownerId, operation);
    deletedItems += settled.deletedItems;
    releasedBytes += settled.releasedBytes;
  }
}

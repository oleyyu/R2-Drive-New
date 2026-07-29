import { getFileBucket } from "@/db/runtime";

export type FileTreeRow = {
  id: string;
  kind: "file" | "folder";
  storage_key: string | null;
  size: number;
};

export async function readFileTree(
  db: D1Database,
  ownerId: string,
  rootId: string,
): Promise<FileTreeRow[]> {
  const result = await db
    .prepare(
      `WITH RECURSIVE tree(id, kind, storage_key, size) AS (
         SELECT id, kind, storage_key, size
         FROM files
         WHERE id = ? AND owner_id = ?
         UNION ALL
         SELECT child.id, child.kind, child.storage_key, child.size
         FROM files child
         JOIN tree parent ON child.parent_id = parent.id
         WHERE child.owner_id = ?
       )
       SELECT id, kind, storage_key, size FROM tree`,
    )
    .bind(rootId, ownerId, ownerId)
    .all<FileTreeRow>();
  return result.results;
}

async function deleteR2Objects(keys: string[]): Promise<void> {
  const bucket = getFileBucket();
  for (let offset = 0; offset < keys.length; offset += 1_000) {
    await bucket.delete(keys.slice(offset, offset + 1_000));
  }
}

export async function permanentlyDeleteTree(
  db: D1Database,
  ownerId: string,
  rootId: string,
): Promise<{ deletedItems: number; releasedBytes: number }> {
  const tree = await readFileTree(db, ownerId, rootId);
  if (!tree.length) return { deletedItems: 0, releasedBytes: 0 };
  const keys = tree
    .map((file) => file.storage_key)
    .filter((key): key is string => Boolean(key));
  await deleteR2Objects(keys);
  await db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM files WHERE id = ? AND owner_id = ?
         UNION ALL
         SELECT child.id
         FROM files child
         JOIN tree parent ON child.parent_id = parent.id
         WHERE child.owner_id = ?
       )
       DELETE FROM files WHERE owner_id = ? AND id IN (SELECT id FROM tree)`,
    )
    .bind(rootId, ownerId, ownerId, ownerId)
    .run();
  const releasedBytes = tree.reduce(
    (total, file) => total + (file.kind === "file" ? file.size : 0),
    0,
  );
  if (releasedBytes > 0) {
    const now = new Date().toISOString();
    await db
      .prepare(
        "UPDATE users SET storage_used = MAX(0, storage_used - ?), updated_at = ? WHERE id = ?",
      )
      .bind(releasedBytes, now, ownerId)
      .run();
  }
  return { deletedItems: tree.length, releasedBytes };
}

export async function emptyTrash(
  db: D1Database,
  ownerId: string,
): Promise<{ deletedItems: number; releasedBytes: number }> {
  const result = await db
    .prepare(
      `SELECT id, kind, storage_key, size
       FROM files WHERE owner_id = ? AND status = 'deleted'`,
    )
    .bind(ownerId)
    .all<FileTreeRow>();
  const keys = result.results
    .map((file) => file.storage_key)
    .filter((key): key is string => Boolean(key));
  await deleteR2Objects(keys);
  await db
    .prepare("DELETE FROM files WHERE owner_id = ? AND status = 'deleted'")
    .bind(ownerId)
    .run();
  const releasedBytes = result.results.reduce(
    (total, file) => total + (file.kind === "file" ? file.size : 0),
    0,
  );
  if (releasedBytes > 0) {
    const now = new Date().toISOString();
    await db
      .prepare(
        "UPDATE users SET storage_used = MAX(0, storage_used - ?), updated_at = ? WHERE id = ?",
      )
      .bind(releasedBytes, now, ownerId)
      .run();
  }
  return { deletedItems: result.results.length, releasedBytes };
}

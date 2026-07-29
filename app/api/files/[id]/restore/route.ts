import { audit, ensureDatabase } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const { id } = await context.params;
    const db = await ensureDatabase();
    const file = await db
      .prepare(
        `SELECT id, parent_id, name, normalized_name
         FROM files
         WHERE id = ? AND owner_id = ? AND status = 'deleted'`,
      )
      .bind(id, user.id)
      .first<{
        id: string;
        parent_id: string | null;
        name: string;
        normalized_name: string;
      }>();
    if (!file) {
      throw new HttpError(404, "回收站中没有这个项目。", "not_found");
    }

    let parentId = file.parent_id;
    if (parentId) {
      const parent = await db
        .prepare(
          "SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'",
        )
        .bind(parentId, user.id)
        .first();
      if (!parent) parentId = null;
    }
    const conflict = await db
      .prepare(
        `SELECT id FROM files
         WHERE owner_id = ?
           AND COALESCE(parent_id, '') = COALESCE(?, '')
           AND normalized_name = ?
           AND status != 'deleted'
         LIMIT 1`,
      )
      .bind(user.id, parentId, file.normalized_name)
      .first();
    if (conflict) {
      throw new HttpError(
        409,
        `目标位置已有“${file.name}”，请先重命名现有项目。`,
        "name_exists",
      );
    }

    const now = new Date().toISOString();
    let restored;
    try {
      restored = await db
        .prepare(
          `WITH RECURSIVE
           target_parent(parent_id) AS (
             SELECT CASE
               WHEN ? IS NULL THEN NULL
               WHEN EXISTS (
                 SELECT 1
                 FROM files parent
                 WHERE parent.id = ? AND parent.owner_id = ?
                   AND parent.kind = 'folder' AND parent.status = 'ready'
               ) THEN ?
               ELSE NULL
             END
           ),
           tree(id) AS (
             SELECT root.id
             FROM files root
             WHERE root.id = ? AND root.owner_id = ?
               AND root.status = 'deleted'
               AND NOT EXISTS (
                 SELECT 1
                 FROM files sibling
                 WHERE sibling.owner_id = root.owner_id
                   AND COALESCE(sibling.parent_id, '') =
                       COALESCE((SELECT parent_id FROM target_parent), '')
                   AND sibling.normalized_name = root.normalized_name
                   AND sibling.status != 'deleted'
                   AND sibling.id != root.id
               )
             UNION ALL
             SELECT child.id
             FROM files child
             JOIN tree parent ON child.parent_id = parent.id
             WHERE child.owner_id = ? AND child.status = 'deleted'
           )
           UPDATE files
           SET status = 'ready',
               deleted_at = NULL,
               parent_id = CASE
                 WHEN id = ? THEN (SELECT parent_id FROM target_parent)
                 ELSE parent_id
               END,
               updated_at = ?
           WHERE owner_id = ? AND status = 'deleted'
             AND id IN (SELECT id FROM tree)`,
        )
        .bind(
          parentId,
          parentId,
          user.id,
          parentId,
          id,
          user.id,
          user.id,
          id,
          now,
          user.id,
        )
        .run();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new HttpError(
          409,
          `目标位置已有“${file.name}”，请先重命名现有项目。`,
          "name_exists",
        );
      }
      throw error;
    }
    if (Number(restored.meta.changes ?? 0) === 0) {
      let currentParentId: string | null = null;
      if (parentId) {
        const currentParent = await db
          .prepare(
            "SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'",
          )
          .bind(parentId, user.id)
          .first();
        if (currentParent) currentParentId = parentId;
      }
      const currentConflict = await db
        .prepare(
          `SELECT id
           FROM files
           WHERE owner_id = ?
             AND COALESCE(parent_id, '') = COALESCE(?, '')
             AND normalized_name = ?
             AND status != 'deleted'
             AND id != ?
           LIMIT 1`,
        )
        .bind(user.id, currentParentId, file.normalized_name, id)
        .first();
      if (currentConflict) {
        throw new HttpError(
          409,
          `目标位置已有“${file.name}”，请先重命名现有项目。`,
          "name_exists",
        );
      }
      throw new HttpError(
        409,
        "项目状态已经变化，请刷新回收站后重试。",
        "restore_conflict",
      );
    }
    const restoredRoot = await db
      .prepare("SELECT parent_id FROM files WHERE id = ? AND owner_id = ?")
      .bind(id, user.id)
      .first<{ parent_id: string | null }>();
    const restoredParentId = restoredRoot?.parent_id ?? null;
    await audit("file.restored", user.id, "file", id, {
      parentId: restoredParentId,
    });
    return json({ ok: true, parentId: restoredParentId });
  } catch (error) {
    return apiError(error);
  }
}

import { audit, ensureDatabase } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { permanentlyDeleteTree } from "@/lib/file-operations";
import { apiError, assertSameOrigin, HttpError, json, safeFileName } from "@/lib/http";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parentId: z.string().uuid().nullable().optional(),
  isPinned: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const { id } = await context.params;
    const input = updateSchema.safeParse(await request.json());
    if (
      !input.success ||
      (input.data.name === undefined &&
        input.data.parentId === undefined &&
        input.data.isPinned === undefined)
    ) {
      throw new HttpError(400, "没有可更新的字段。", "invalid_input");
    }
    const db = await ensureDatabase();
    const current = await db
      .prepare(
        "SELECT id, parent_id, kind, name, is_pinned FROM files WHERE id = ? AND owner_id = ? AND status = 'ready'",
      )
      .bind(id, user.id)
      .first<{
        id: string;
        parent_id: string | null;
        kind: "file" | "folder";
        name: string;
        is_pinned: number;
      }>();
    if (!current) throw new HttpError(404, "文件不存在。", "not_found");
    const name = input.data.name === undefined ? current.name : safeFileName(input.data.name);
    const parentId = input.data.parentId === undefined ? current.parent_id : input.data.parentId;
    const isPinned =
      input.data.isPinned === undefined ? current.is_pinned : Number(input.data.isPinned);
    if (parentId === id) throw new HttpError(400, "不能移动到自身。", "invalid_parent");
    if (parentId) {
      const parent = await db
        .prepare("SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'")
        .bind(parentId, user.id)
        .first();
      if (!parent) {
        throw new HttpError(409, "目标文件夹不存在。", "parent_not_found");
      }
      if (current.kind === "folder") {
        const cycle = await db
          .prepare(
            `WITH RECURSIVE descendants(id) AS (
               SELECT id FROM files WHERE parent_id = ? AND owner_id = ? AND status = 'ready'
               UNION ALL
               SELECT child.id
               FROM files child
               JOIN descendants parent ON child.parent_id = parent.id
               WHERE child.owner_id = ? AND child.status = 'ready'
             )
             SELECT id FROM descendants WHERE id = ? LIMIT 1`,
          )
          .bind(id, user.id, user.id, parentId)
          .first();
        if (cycle) {
          throw new HttpError(400, "不能把文件夹移入自己的子文件夹。", "invalid_parent");
        }
      }
    }
    const normalizedName = name.toLocaleLowerCase();
    try {
      const updated = await db
        .prepare(
          `UPDATE files
           SET name = ?, normalized_name = ?, parent_id = ?, is_pinned = ?, updated_at = ?
           WHERE id = ? AND owner_id = ? AND status = 'ready'
             AND (
               ? IS NULL
               OR EXISTS (
                 SELECT 1
                 FROM files parent
                 WHERE parent.id = ? AND parent.owner_id = ?
                   AND parent.kind = 'folder' AND parent.status = 'ready'
               )
             )
             AND (
               files.kind != 'folder'
               OR ? IS NULL
               OR NOT EXISTS (
                 WITH RECURSIVE descendants(id) AS (
                   SELECT id
                   FROM files
                   WHERE id = ? AND owner_id = ? AND status = 'ready'
                   UNION
                   SELECT child.id
                   FROM files child
                   JOIN descendants parent ON child.parent_id = parent.id
                   WHERE child.owner_id = ? AND child.status = 'ready'
                 )
                 SELECT 1 FROM descendants WHERE id = ?
               )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM files sibling
               WHERE sibling.owner_id = ?
                 AND COALESCE(sibling.parent_id, '') = COALESCE(?, '')
                 AND sibling.normalized_name = ?
                 AND sibling.status != 'deleted'
                 AND sibling.id != ?
             )`,
        )
        .bind(
          name,
          normalizedName,
          parentId,
          isPinned,
          new Date().toISOString(),
          id,
          user.id,
          parentId,
          parentId,
          user.id,
          parentId,
          id,
          user.id,
          user.id,
          parentId,
          user.id,
          parentId,
          normalizedName,
          id,
        )
        .run();
      if (Number(updated.meta.changes ?? 0) === 0) {
        const latest = await db
          .prepare(
            "SELECT status FROM files WHERE id = ? AND owner_id = ?",
          )
          .bind(id, user.id)
          .first<{ status: string }>();
        if (!latest || latest.status !== "ready") {
          throw new HttpError(
            409,
            "项目状态已经变化，请刷新后重试。",
            "update_conflict",
          );
        }
        if (parentId) {
          const latestParent = await db
            .prepare(
              "SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'",
            )
            .bind(parentId, user.id)
            .first();
          if (!latestParent) {
            throw new HttpError(
              409,
              "目标文件夹状态已经变化，请刷新后重试。",
              "parent_not_found",
            );
          }
        }
        if (current.kind === "folder" && parentId) {
          const cycle = await db
            .prepare(
              `WITH RECURSIVE descendants(id) AS (
                 SELECT id
                 FROM files
                 WHERE id = ? AND owner_id = ? AND status = 'ready'
                 UNION
                 SELECT child.id
                 FROM files child
                 JOIN descendants parent ON child.parent_id = parent.id
                 WHERE child.owner_id = ? AND child.status = 'ready'
               )
               SELECT id FROM descendants WHERE id = ? LIMIT 1`,
            )
            .bind(id, user.id, user.id, parentId)
            .first();
          if (cycle) {
            throw new HttpError(
              400,
              "不能把文件夹移入自己的子文件夹。",
              "invalid_parent",
            );
          }
        }
        throw new HttpError(
          409,
          "目标位置已有同名项目。",
          "name_exists",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new HttpError(409, "目标位置已有同名项目。", "name_exists");
      }
      throw error;
    }
    await audit("file.updated", user.id, "file", id, {
      name,
      parentId,
      isPinned: Boolean(isPinned),
    });
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const { id } = await context.params;
    const db = await ensureDatabase();
    const permanent = new URL(request.url).searchParams.get("permanent") === "true";
    const file = await db
      .prepare(
        "SELECT id, kind, size, status FROM files WHERE id = ? AND owner_id = ?",
      )
      .bind(id, user.id)
      .first<{
        id: string;
        kind: "file" | "folder";
        size: number;
        status: "uploading" | "ready" | "failed" | "deleted" | "purging";
      }>();
    if (!file) throw new HttpError(404, "文件不存在。", "not_found");

    if (permanent) {
      if (file.status !== "deleted" && file.status !== "purging") {
        throw new HttpError(409, "请先把项目移入回收站。", "not_in_trash");
      }
      const result = await permanentlyDeleteTree(db, user.id, id);
      await audit("file.permanently_deleted", user.id, "file", id, result);
      return json(result);
    }

    if (file.status !== "ready") {
      throw new HttpError(409, "只有已完成项目可以移入回收站。", "invalid_status");
    }
    const activeUpload = await db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM files WHERE id = ? AND owner_id = ?
           UNION ALL
           SELECT child.id
           FROM files child JOIN tree parent ON child.parent_id = parent.id
           WHERE child.owner_id = ?
         )
         SELECT upload.id
         FROM multipart_uploads upload
         WHERE upload.file_id IN (SELECT id FROM tree)
         LIMIT 1`,
      )
      .bind(id, user.id, user.id)
      .first();
    if (activeUpload) {
      throw new HttpError(409, "文件夹中仍有上传任务，请稍后再试。", "upload_in_progress");
    }
    const now = new Date().toISOString();
    const claimToken = `trash:${crypto.randomUUID()}`;
    const results = await db.batch([
      db
        .prepare(
          `WITH RECURSIVE
           subtree(id) AS (
             SELECT id FROM files WHERE id = ? AND owner_id = ?
             UNION ALL
             SELECT child.id
             FROM files child
             JOIN subtree parent ON child.parent_id = parent.id
             WHERE child.owner_id = ?
           ),
           tree(id) AS (
             SELECT id
             FROM files
             WHERE id = ? AND owner_id = ? AND status = 'ready'
               AND NOT EXISTS (
                 SELECT 1
                 FROM multipart_uploads upload
                 WHERE upload.file_id IN (SELECT id FROM subtree)
               )
             UNION ALL
             SELECT child.id
             FROM files child
             JOIN tree parent ON child.parent_id = parent.id
             WHERE child.owner_id = ? AND child.status = 'ready'
           )
           UPDATE files
           SET status = 'deleted', deleted_at = ?, updated_at = ?
           WHERE owner_id = ? AND status = 'ready'
             AND id IN (SELECT id FROM tree)`,
        )
        .bind(
          id,
          user.id,
          user.id,
          id,
          user.id,
          user.id,
          now,
          claimToken,
          user.id,
        ),
      db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id
             FROM files
             WHERE id = ? AND owner_id = ?
               AND status = 'deleted' AND updated_at = ?
             UNION ALL
             SELECT child.id
             FROM files child
             JOIN tree parent ON child.parent_id = parent.id
             WHERE child.owner_id = ?
               AND child.status = 'deleted' AND child.updated_at = ?
           )
           DELETE FROM shares
           WHERE owner_id = ? AND file_id IN (SELECT id FROM tree)`,
        )
        .bind(
          id,
          user.id,
          claimToken,
          user.id,
          claimToken,
          user.id,
        ),
      db
        .prepare(
          `UPDATE files
           SET updated_at = ?
           WHERE owner_id = ? AND status = 'deleted' AND updated_at = ?`,
        )
        .bind(now, user.id, claimToken),
    ]);
    if (Number(results[0].meta.changes ?? 0) === 0) {
      throw new HttpError(
        409,
        "项目状态或文件夹内容已经变化，请刷新后重试。",
        "trash_conflict",
      );
    }
    await audit("file.trashed", user.id, "file", id, {
      kind: file.kind,
      size: file.size,
    });
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

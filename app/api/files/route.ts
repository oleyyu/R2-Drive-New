import { audit, ensureDatabase } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { emptyTrash } from "@/lib/file-operations";
import { apiError, assertSameOrigin, HttpError, json, safeFileName } from "@/lib/http";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
});

type FileRow = {
  id: string;
  parent_id: string | null;
  kind: "file" | "folder";
  name: string;
  size: number;
  content_type: string | null;
  is_pinned: number;
  status: "uploading" | "ready" | "failed" | "deleted";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const scopeSchema = z.enum([
  "all",
  "recent",
  "image",
  "document",
  "video",
  "audio",
  "other",
  "trash",
  "pinned",
  "folders",
]);
const sortSchema = z.enum(["name", "size", "updated"]);
const orderSchema = z.enum(["asc", "desc"]);

const imageCondition =
  "(f.content_type LIKE 'image/%' OR lower(f.name) GLOB '*.jpg' OR lower(f.name) GLOB '*.jpeg' OR lower(f.name) GLOB '*.png' OR lower(f.name) GLOB '*.gif' OR lower(f.name) GLOB '*.webp' OR lower(f.name) GLOB '*.svg' OR lower(f.name) GLOB '*.heic')";
const videoCondition =
  "(f.content_type LIKE 'video/%' OR lower(f.name) GLOB '*.mp4' OR lower(f.name) GLOB '*.mov' OR lower(f.name) GLOB '*.mkv' OR lower(f.name) GLOB '*.webm')";
const audioCondition =
  "(f.content_type LIKE 'audio/%' OR lower(f.name) GLOB '*.mp3' OR lower(f.name) GLOB '*.m4a' OR lower(f.name) GLOB '*.wav' OR lower(f.name) GLOB '*.flac' OR lower(f.name) GLOB '*.aac')";
const documentCondition =
  "(f.content_type LIKE 'text/%' OR f.content_type = 'application/pdf' OR lower(f.name) GLOB '*.doc' OR lower(f.name) GLOB '*.docx' OR lower(f.name) GLOB '*.xls' OR lower(f.name) GLOB '*.xlsx' OR lower(f.name) GLOB '*.ppt' OR lower(f.name) GLOB '*.pptx' OR lower(f.name) GLOB '*.csv' OR lower(f.name) GLOB '*.md' OR lower(f.name) GLOB '*.json')";

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, "files:read");
    const url = new URL(request.url);
    const parentId = url.searchParams.get("parentId");
    const scope = scopeSchema.catch("all").parse(url.searchParams.get("scope") ?? "all");
    const sort = sortSchema.catch("name").parse(url.searchParams.get("sort") ?? "name");
    const order = orderSchema.catch("asc").parse(url.searchParams.get("order") ?? "asc");
    const search = url.searchParams.get("search")?.trim().slice(0, 255) ?? "";
    const db = await ensureDatabase();
    if (parentId && scope === "all" && !search) {
      const parent = await db
        .prepare(
          "SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'",
        )
        .bind(parentId, user.id)
        .first();
      if (!parent) throw new HttpError(404, "文件夹不存在。", "parent_not_found");
    }

    const conditions = ["f.owner_id = ?"];
    const parameters: Array<string | number | null> = [user.id];
    if (scope === "trash") {
      conditions.push("f.status = 'deleted'");
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM files parent WHERE parent.id = f.parent_id AND parent.owner_id = f.owner_id AND parent.status = 'deleted')",
      );
    } else {
      conditions.push("f.status = 'ready'");
    }
    if (scope === "all" && !search) {
      conditions.push(parentId ? "f.parent_id = ?" : "f.parent_id IS NULL");
      if (parentId) parameters.push(parentId);
    } else if (scope === "recent") {
      conditions.push("f.updated_at >= ?");
      parameters.push(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    } else if (scope === "image") {
      conditions.push("f.kind = 'file'", imageCondition);
    } else if (scope === "document") {
      conditions.push("f.kind = 'file'", documentCondition);
    } else if (scope === "video") {
      conditions.push("f.kind = 'file'", videoCondition);
    } else if (scope === "audio") {
      conditions.push("f.kind = 'file'", audioCondition);
    } else if (scope === "other") {
      conditions.push(
        "f.kind = 'file'",
        `NOT (${imageCondition} OR ${documentCondition} OR ${videoCondition} OR ${audioCondition})`,
      );
    } else if (scope === "pinned") {
      conditions.push("f.is_pinned = 1");
    } else if (scope === "folders") {
      conditions.push("f.kind = 'folder'");
    }
    if (search) {
      conditions.push("f.normalized_name LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLike(search.toLocaleLowerCase())}%`);
    }

    const direction = order === "desc" ? "DESC" : "ASC";
    const orderColumn =
      sort === "size"
        ? "f.size"
        : sort === "updated"
          ? "f.updated_at"
          : "f.normalized_name";
    const folderOrder =
      ["all", "recent", "pinned", "trash", "folders"].includes(scope)
        ? "f.kind DESC, "
        : "";
    const statement = db
      .prepare(
        `SELECT f.id, f.parent_id, f.kind, f.name, f.size, f.content_type, f.is_pinned,
                f.status, f.created_at, f.updated_at, f.deleted_at
         FROM files f
         WHERE ${conditions.join(" AND ")}
         ORDER BY ${folderOrder}${orderColumn} ${direction}
         LIMIT 500`,
      )
      .bind(...parameters);
    const result = await statement.all<FileRow>();

    let breadcrumbs: Array<{ id: string; name: string }> = [];
    if (parentId && scope === "all" && !search) {
      const ancestors = await db
        .prepare(
          `WITH RECURSIVE ancestors(id, parent_id, name, depth) AS (
             SELECT id, parent_id, name, 0
             FROM files WHERE id = ? AND owner_id = ? AND status = 'ready'
             UNION ALL
             SELECT parent.id, parent.parent_id, parent.name, child.depth + 1
             FROM files parent
             JOIN ancestors child ON parent.id = child.parent_id
             WHERE parent.owner_id = ? AND parent.status = 'ready'
           )
           SELECT id, name FROM ancestors ORDER BY depth DESC`,
        )
        .bind(parentId, user.id, user.id)
        .all<{ id: string; name: string }>();
      breadcrumbs = ancestors.results;
    }
    const shortcutResult = await db
      .prepare(
        `SELECT id, parent_id, kind, name
         FROM files
         WHERE owner_id = ? AND is_pinned = 1 AND status = 'ready'
         ORDER BY kind DESC, normalized_name ASC LIMIT 12`,
      )
      .bind(user.id)
      .all<{ id: string; parent_id: string | null; kind: "file" | "folder"; name: string }>();

    return json({
      files: result.results.map((file) => ({
        id: file.id,
        parentId: file.parent_id,
        kind: file.kind,
        name: file.name,
        size: file.size,
        contentType: file.content_type,
        isPinned: Boolean(file.is_pinned),
        status: file.status,
        createdAt: file.created_at,
        updatedAt: file.updated_at,
        deletedAt: file.deleted_at,
      })),
      usage: { used: user.storageUsed, quota: user.storageQuota },
      breadcrumbs,
      shortcuts: shortcutResult.results.map((file) => ({
        id: file.id,
        parentId: file.parent_id,
        kind: file.kind,
        name: file.name,
      })),
      scope,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const scope = new URL(request.url).searchParams.get("scope");
    if (scope !== "trash") {
      throw new HttpError(400, "只允许清空回收站。", "invalid_scope");
    }
    const db = await ensureDatabase();
    const result = await emptyTrash(db, user.id);
    await audit("trash.emptied", user.id, "user", user.id, result);
    return json(result);
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const input = createSchema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "文件夹信息无效。", "invalid_input");
    const name = safeFileName(input.data.name);
    const parentId = input.data.parentId ?? null;
    const db = await ensureDatabase();
    if (parentId) {
      const parent = await db
        .prepare(
          "SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'",
        )
        .bind(parentId, user.id)
        .first();
      if (!parent) {
        throw new HttpError(409, "上级文件夹不存在。", "parent_not_found");
      }
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const normalizedName = name.toLocaleLowerCase();
    try {
      const inserted = await db
        .prepare(
          `INSERT INTO files (
            id, owner_id, parent_id, kind, name, normalized_name, size, status, created_at, updated_at
          )
          SELECT ?, ?, ?, 'folder', ?, ?, 0, 'ready', ?, ?
          WHERE (
            ? IS NULL
            OR EXISTS (
               SELECT 1
               FROM files
               WHERE id = ? AND owner_id = ?
                 AND kind = 'folder' AND status = 'ready'
            )
          )
            AND NOT EXISTS (
              SELECT 1
              FROM files sibling
              WHERE sibling.owner_id = ?
                AND COALESCE(sibling.parent_id, '') = COALESCE(?, '')
                AND sibling.normalized_name = ?
                AND sibling.status != 'deleted'
            )`,
        )
        .bind(
          id,
          user.id,
          parentId,
          name,
          normalizedName,
          now,
          now,
          parentId,
          parentId,
          user.id,
          user.id,
          parentId,
          normalizedName,
        )
        .run();
      if (Number(inserted.meta.changes ?? 0) === 0) {
        if (parentId) {
          const currentParent = await db
            .prepare(
              "SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'",
            )
            .bind(parentId, user.id)
            .first();
          if (!currentParent) {
            throw new HttpError(
              409,
              "上级文件夹状态已经变化，请刷新后重试。",
              "parent_not_found",
            );
          }
        }
        throw new HttpError(
          409,
          "同一位置已有同名项目。",
          "name_exists",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new HttpError(409, "同一位置已有同名项目。", "name_exists");
      }
      throw error;
    }
    await audit("folder.created", user.id, "file", id, { parentId });
    return json({ file: { id, parentId, kind: "folder", name, size: 0, status: "ready", createdAt: now, updatedAt: now } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

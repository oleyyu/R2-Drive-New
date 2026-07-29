import { audit, ensureDatabase, getFileBucket } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import {
  appConfig,
  calculatePartSize,
  directR2Configured,
  MAX_R2_PARTS,
  MAX_R2_PART_BYTES,
  MIN_R2_PART_BYTES,
} from "@/lib/config";
import { apiError, assertSameOrigin, HttpError, json, safeFileName } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  contentType: z.string().trim().max(255).optional().default("application/octet-stream"),
  parentId: z.string().uuid().nullable().optional(),
  partSizeHintBytes: z.number().int().min(MIN_R2_PART_BYTES).max(MAX_R2_PART_BYTES).optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "上传信息无效。", "invalid_input");
    const config = appConfig();
    if (input.data.size > config.maxFileSizeBytes) {
      throw new HttpError(413, "文件超过管理员设置的单文件上限。", "file_too_large");
    }
    const db = await ensureDatabase();
    const reserved = await db
      .prepare(
        `SELECT COALESCE(SUM(f.size), 0) AS total
         FROM multipart_uploads m JOIN files f ON f.id = m.file_id
         WHERE m.owner_id = ? AND m.expires_at > ?`,
      )
      .bind(user.id, new Date().toISOString())
      .first<{ total: number }>();
    if (user.storageUsed + Number(reserved?.total ?? 0) + input.data.size > user.storageQuota) {
      throw new HttpError(413, "剩余空间不足。", "quota_exceeded");
    }
    const parentId = input.data.parentId ?? null;
    if (parentId) {
      const parent = await db
        .prepare("SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'")
        .bind(parentId, user.id)
        .first();
      if (!parent) throw new HttpError(404, "目标文件夹不存在。", "parent_not_found");
    }

    const name = safeFileName(input.data.name);
    const fileId = crypto.randomUUID();
    const storageKey = `${user.id}/${fileId}/blob`;
    const multipart = await getFileBucket().createMultipartUpload(storageKey, {
      httpMetadata: {
        contentType: input.data.contentType || "application/octet-stream",
      },
      customMetadata: {
        ownerId: user.id,
        fileId,
      },
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const partSize = calculatePartSize(input.data.size, input.data.partSizeHintBytes);
    const expectedParts = Math.ceil(input.data.size / partSize);
    if (expectedParts > MAX_R2_PARTS) {
      await multipart.abort();
      throw new HttpError(413, "文件需要的分片数超过 R2 上限。", "too_many_parts");
    }
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO files (
              id, owner_id, parent_id, kind, name, normalized_name, storage_key, size,
              content_type, status, created_at, updated_at
            ) VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
          )
          .bind(
            fileId,
            user.id,
            parentId,
            name,
            name.toLocaleLowerCase(),
            storageKey,
            input.data.size,
            input.data.contentType,
            now.toISOString(),
            now.toISOString(),
          ),
        db
          .prepare(
            `INSERT INTO multipart_uploads (
              id, owner_id, file_id, upload_id, storage_key, part_size,
              expected_parts, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            user.id,
            fileId,
            multipart.uploadId,
            storageKey,
            partSize,
            expectedParts,
            expiresAt.toISOString(),
            now.toISOString(),
          ),
      ]);
    } catch (error) {
      await multipart.abort();
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new HttpError(409, "同一位置已有同名项目。", "name_exists");
      }
      throw error;
    }
    await audit("upload.started", user.id, "file", fileId, {
      size: input.data.size,
      parts: expectedParts,
      direct: config.uploadMode !== "proxy" && directR2Configured(),
      uploadMode: config.uploadMode,
    });
    return json(
      {
        fileId,
        uploadId: multipart.uploadId,
        partSize,
        expectedParts,
        direct: config.uploadMode !== "proxy" && directR2Configured(),
        expiresAt: expiresAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}

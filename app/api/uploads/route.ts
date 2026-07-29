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
import {
  abortNodeMultipartUpload,
  cleanupExpiredMultipartMetadata,
  createNodeMultipartUpload,
  recordStorageNodeError,
  releaseStorageNodeReservation,
  releaseUserStorageReservation,
  reserveStorageNode,
  reserveUserStorage,
  StorageNodeRequestError,
  type StorageNode,
} from "@/lib/storage";
import { StorageCapabilityConfigurationError } from "@/lib/storage-capability";
import { z } from "zod";

// Storage Nodes must also work on Free Workers (100 MB inbound body limit).
// 95 MiB leaves a small safety margin while preserving the default 64/80 MiB
// upload profiles. Larger parts stay on the primary bucket/direct S3 path.
const MAX_STORAGE_NODE_PART_BYTES = 95 * 1024 ** 2;

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
    const uploadInput = input.data;
    const config = appConfig();
    if (uploadInput.size > config.maxFileSizeBytes) {
      throw new HttpError(413, "文件超过管理员设置的单文件上限。", "file_too_large");
    }
    const db = await ensureDatabase();
    await cleanupExpiredMultipartMetadata(db);
    const reserved = await db
      .prepare(
        `SELECT COALESCE(SUM(m.reserved_bytes), 0) AS total
         FROM multipart_uploads m
         WHERE m.owner_id = ? AND m.expires_at > ?`,
      )
      .bind(user.id, new Date().toISOString())
      .first<{ total: number }>();
    if (user.storageUsed + Number(reserved?.total ?? 0) + uploadInput.size > user.storageQuota) {
      throw new HttpError(413, "剩余空间不足。", "quota_exceeded");
    }
    const parentId = uploadInput.parentId ?? null;
    if (parentId) {
      const parent = await db
        .prepare("SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'")
        .bind(parentId, user.id)
        .first();
      if (!parent) {
        throw new HttpError(409, "目标文件夹不存在。", "parent_not_found");
      }
    }

    const name = safeFileName(uploadInput.name);
    const normalizedName = name.toLocaleLowerCase();
    const fileId = crypto.randomUUID();
    const storageKey = `${user.id}/${fileId}/blob`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const partSize = calculatePartSize(uploadInput.size, uploadInput.partSizeHintBytes);
    const expectedParts = Math.ceil(uploadInput.size / partSize);
    if (expectedParts > MAX_R2_PARTS) {
      throw new HttpError(413, "文件需要的分片数超过 R2 上限。", "too_many_parts");
    }
    let storageNode: StorageNode | null =
      partSize <= MAX_STORAGE_NODE_PART_BYTES
        ? await reserveStorageNode(db, uploadInput.size)
        : null;
    let storageFallback = false;
    let primaryMultipart: R2MultipartUpload | null = null;
    let uploadId = "";
    if (storageNode) {
      try {
        uploadId = await createNodeMultipartUpload(storageNode, storageKey, {
          contentType: uploadInput.contentType || "application/octet-stream",
          ownerId: user.id,
          fileId,
        });
      } catch (nodeError) {
        await releaseStorageNodeReservation(db, storageNode.id, uploadInput.size);
        const permanentNodeFailure =
          nodeError instanceof StorageCapabilityConfigurationError ||
          (nodeError instanceof StorageNodeRequestError &&
            nodeError.status !== 408 &&
            nodeError.status !== 429 &&
            nodeError.status < 500);
        await recordStorageNodeError(
          db,
          storageNode.id,
          nodeError,
          permanentNodeFailure,
        ).catch(() => undefined);
        if (permanentNodeFailure) {
          throw new HttpError(
            503,
            "附加存储节点配置异常，已暂停写入；请在设置中完成健康检查。",
            "storage_node_misconfigured",
          );
        }
        storageFallback = true;
        storageNode = null;
      }
    }
    if (!storageNode) {
      primaryMultipart = await getFileBucket().createMultipartUpload(storageKey, {
        httpMetadata: {
          contentType: uploadInput.contentType || "application/octet-stream",
        },
        customMetadata: {
          ownerId: user.id,
          fileId,
        },
      });
      uploadId = primaryMultipart.uploadId;
    }

    async function cleanupCreatedUpload(): Promise<void> {
      if (storageNode) {
        try {
          await abortNodeMultipartUpload(storageNode, storageKey, uploadId, {
            ownerId: user.id,
            fileId,
          });
        } finally {
          await releaseStorageNodeReservation(db, storageNode.id, uploadInput.size);
        }
      } else if (primaryMultipart) {
        await primaryMultipart.abort();
      }
    }

    let userReservationCreated = false;
    try {
      userReservationCreated = await reserveUserStorage(
        db,
        user.id,
        uploadInput.size,
      );
    } catch (error) {
      await cleanupCreatedUpload().catch(() => undefined);
      throw error;
    }
    if (!userReservationCreated) {
      await cleanupCreatedUpload().catch(() => undefined);
      throw new HttpError(413, "剩余空间不足。", "quota_exceeded");
    }

    async function cleanupPersistenceFailure(
      removeFileRow = false,
    ): Promise<void> {
      const cleanups: Promise<unknown>[] = [
        cleanupCreatedUpload(),
        releaseUserStorageReservation(db, user.id, uploadInput.size),
      ];
      if (removeFileRow) {
        cleanups.push(
          db
            .prepare(
              "DELETE FROM files WHERE id = ? AND owner_id = ? AND status = 'uploading'",
            )
            .bind(fileId, user.id)
            .run(),
        );
      }
      await Promise.allSettled(cleanups);
    }

    let persistenceResults;
    try {
      persistenceResults = await db.batch([
        db
          .prepare(
            `INSERT INTO files (
              id, owner_id, parent_id, kind, name, normalized_name, storage_key,
              storage_node_id, size, content_type, status, created_at, updated_at
            )
            SELECT ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, 'uploading', ?, ?
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
            fileId,
            user.id,
            parentId,
            name,
            normalizedName,
            storageKey,
            storageNode?.id ?? null,
            uploadInput.size,
            uploadInput.contentType,
            now.toISOString(),
            now.toISOString(),
            parentId,
            parentId,
            user.id,
            user.id,
            parentId,
            normalizedName,
          ),
        db
          .prepare(
            `INSERT INTO multipart_uploads (
              id, owner_id, file_id, upload_id, storage_key, storage_node_id,
              reserved_bytes, part_size, expected_parts, expires_at, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1
              FROM files
              WHERE id = ? AND owner_id = ? AND status = 'uploading'
            )`,
          )
          .bind(
            crypto.randomUUID(),
            user.id,
            fileId,
            uploadId,
            storageKey,
            storageNode?.id ?? null,
            uploadInput.size,
            partSize,
            expectedParts,
            expiresAt.toISOString(),
            now.toISOString(),
            fileId,
            user.id,
          ),
      ]);
    } catch (error) {
      await cleanupPersistenceFailure();
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new HttpError(409, "同一位置已有同名项目。", "name_exists");
      }
      throw error;
    }
    const fileInserted = Number(persistenceResults[0].meta.changes ?? 0) === 1;
    const multipartInserted =
      Number(persistenceResults[1].meta.changes ?? 0) === 1;
    if (!fileInserted || !multipartInserted) {
      await cleanupPersistenceFailure(fileInserted);
      if (!fileInserted && parentId) {
        const currentParent = await db
          .prepare(
            "SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'folder' AND status = 'ready'",
          )
          .bind(parentId, user.id)
          .first();
        if (currentParent) {
          throw new HttpError(
            409,
            "同一位置已有同名项目。",
            "name_exists",
          );
        }
        throw new HttpError(
          409,
          "目标文件夹状态已经变化，请刷新后重试。",
          "parent_not_found",
        );
      }
      if (!fileInserted) {
        throw new HttpError(
          409,
          "同一位置已有同名项目。",
          "name_exists",
        );
      }
      throw new Error("上传任务未能安全写入资料数据库。");
    }
    await audit("upload.started", user.id, "file", fileId, {
      size: uploadInput.size,
      parts: expectedParts,
      direct:
        storageNode === null &&
        config.uploadMode !== "proxy" &&
        directR2Configured(),
      uploadMode: config.uploadMode,
      storageNodeId: storageNode?.id ?? null,
    });
    return json(
      {
        fileId,
        uploadId,
        partSize,
        expectedParts,
        direct:
          storageNode === null &&
          config.uploadMode !== "proxy" &&
          directR2Configured(),
        storageFallback,
        expiresAt: expiresAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}

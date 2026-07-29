import { audit, ensureDatabase, getFileBucket } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import {
  completeNodeMultipartUpload,
  deleteNodeObjects,
  getStorageNode,
  releaseStorageNodeReservationStatement,
  releaseUserStorageReservationStatement,
  settleUserStorageReservationStatement,
  settleStorageNodeReservationStatement,
} from "@/lib/storage";
import { z } from "zod";

const schema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(256) }))
    .min(1)
    .max(10_000),
});

type RouteContext = { params: Promise<{ id: string }> };

function isNoSuchUpload(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  const name = Reflect.get(error, "name");
  return code === 10024 || name === "NoSuchUpload";
}

function completedObjectMatches(
  object: R2Object | null,
  expected: { size: number; ownerId: string; fileId: string },
): object is R2Object {
  if (!object || object.size !== expected.size) return false;
  const ownerId = object.customMetadata?.ownerId;
  const fileId = object.customMetadata?.fileId;
  const legacyMetadataMissing = ownerId === undefined && fileId === undefined;
  return (
    legacyMetadataMissing ||
    (ownerId === expected.ownerId && fileId === expected.fileId)
  );
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const { id } = await context.params;
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "分片清单无效。", "invalid_parts");
    const db = await ensureDatabase();
    const upload = await db
      .prepare(
        `SELECT m.upload_id, m.storage_key, m.storage_node_id, m.reserved_bytes,
                m.expected_parts, m.expires_at, f.size
         FROM multipart_uploads m JOIN files f ON f.id = m.file_id
         WHERE m.file_id = ? AND m.owner_id = ?`,
      )
      .bind(id, user.id)
      .first<{
        upload_id: string;
        storage_key: string;
        storage_node_id: string | null;
        reserved_bytes: number;
        expected_parts: number;
        expires_at: string;
        size: number;
      }>();
    if (!upload) {
      const ready = await db
        .prepare(
          `SELECT size, etag
           FROM files
           WHERE id = ? AND owner_id = ? AND kind = 'file' AND status = 'ready'`,
        )
        .bind(id, user.id)
        .first<{ size: number; etag: string | null }>();
      if (ready?.etag) {
        return json({
          fileId: id,
          size: ready.size,
          etag: ready.etag,
          status: "ready",
        });
      }
      throw new HttpError(404, "上传任务不存在。", "upload_not_found");
    }
    if (upload.expires_at <= new Date().toISOString()) {
      throw new HttpError(410, "上传任务已过期，请重新上传。", "upload_expired");
    }
    const sortedParts = [...input.data.parts].sort((a, b) => a.partNumber - b.partNumber);
    if (
      sortedParts.length !== upload.expected_parts ||
      sortedParts.some((part, index) => part.partNumber !== index + 1)
    ) {
      throw new HttpError(400, "分片不完整。", "parts_incomplete");
    }
    const node = upload.storage_node_id
      ? await getStorageNode(db, upload.storage_node_id)
      : null;
    if (upload.storage_node_id && !node) {
      throw new HttpError(503, "上传所属的存储节点不存在。", "storage_node_missing");
    }
    const deleteCompletedObject = async (): Promise<void> => {
      if (node) await deleteNodeObjects(node, [upload.storage_key]);
      else await getFileBucket().delete(upload.storage_key);
    };
    let object: { size: number; httpEtag: string };
    if (node) {
      object = await completeNodeMultipartUpload(
        node,
        upload.storage_key,
        upload.upload_id,
        sortedParts,
        {
          ownerId: user.id,
          fileId: id,
          expectedSize: upload.size,
        },
      );
    } else {
      const bucket = getFileBucket();
      try {
        object = await bucket
          .resumeMultipartUpload(upload.storage_key, upload.upload_id)
          .complete(sortedParts);
      } catch (error) {
        if (!isNoSuchUpload(error)) throw error;
        const completed = await bucket.head(upload.storage_key);
        if (
          !completedObjectMatches(completed, {
            size: upload.size,
            ownerId: user.id,
            fileId: id,
          })
        ) {
          throw error;
        }
        object = completed;
      }
    }
    if (object.size !== upload.size) {
      await deleteCompletedObject();
      const failedAt = new Date().toISOString();
      const failedStatements = [
        releaseUserStorageReservationStatement(
          db,
          user.id,
          upload.reserved_bytes,
          failedAt,
          id,
        ),
      ];
      if (node) {
        failedStatements.push(
          releaseStorageNodeReservationStatement(
            db,
            node.id,
            upload.reserved_bytes,
            failedAt,
            id,
            user.id,
          ),
        );
      }
      failedStatements.push(
        db
          .prepare(
            "DELETE FROM multipart_uploads WHERE file_id = ? AND owner_id = ?",
          )
          .bind(id, user.id),
        db
          .prepare(
            "DELETE FROM files WHERE id = ? AND owner_id = ? AND status = 'uploading'",
          )
          .bind(id, user.id),
      );
      await db.batch(failedStatements);
      throw new HttpError(409, "上传后的文件大小校验失败，已删除异常对象。", "size_mismatch");
    }
    const now = new Date().toISOString();
    const completedStatements = [
      db
        .prepare(
          `UPDATE files
           SET status = 'ready', etag = ?, updated_at = ?
           WHERE id = ? AND owner_id = ? AND kind = 'file' AND status = 'uploading'
             AND EXISTS (
               SELECT 1 FROM multipart_uploads
               WHERE file_id = files.id AND owner_id = files.owner_id
                 AND upload_id = ? AND storage_key = ?
             )`,
        )
        .bind(
          object.httpEtag,
          now,
          id,
          user.id,
          upload.upload_id,
          upload.storage_key,
        ),
      settleUserStorageReservationStatement(
        db,
        user.id,
        upload.reserved_bytes,
        object.size,
        now,
        id,
      ),
    ];
    if (node) {
      completedStatements.push(
        settleStorageNodeReservationStatement(
          db,
          node.id,
          upload.reserved_bytes,
          object.size,
          now,
          id,
          user.id,
        ),
      );
    }
    completedStatements.push(
      db
        .prepare(
          `DELETE FROM multipart_uploads
           WHERE file_id = ? AND owner_id = ? AND changes() = 1`,
        )
        .bind(id, user.id),
    );
    const completed = await db.batch(completedStatements);
    if (Number(completed[0].meta.changes ?? 0) !== 1) {
      const finalFile = await db
        .prepare(
          `SELECT status, size, etag
           FROM files
           WHERE id = ? AND owner_id = ? AND kind = 'file'`,
        )
        .bind(id, user.id)
        .first<{
          status: "uploading" | "ready" | "failed" | "deleted" | "purging";
          size: number;
          etag: string | null;
        }>();
      if (finalFile?.status === "ready" && finalFile.etag) {
        return json({
          fileId: id,
          size: finalFile.size,
          etag: finalFile.etag,
          status: "ready",
        });
      }
      // Expiry cleanup may have won after R2 completed but before D1 could
      // settle the reservation. Remove that now-unaccounted object. A
      // concurrent complete winner is detected above and must never be deleted.
      await deleteCompletedObject();
      throw new HttpError(
        finalFile ? 409 : 410,
        finalFile
          ? "上传状态已经变化，完成结果未保存。"
          : "上传在完成时已过期，异常对象已删除。",
        finalFile ? "upload_state_changed" : "upload_expired",
      );
    }
    await audit("upload.completed", user.id, "file", id, {
      size: object.size,
      parts: sortedParts.length,
      storageNodeId: node?.id ?? null,
    });
    return json({ fileId: id, size: object.size, etag: object.httpEtag, status: "ready" });
  } catch (error) {
    return apiError(error);
  }
}

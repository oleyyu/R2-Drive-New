import { audit, ensureDatabase, getFileBucket } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import {
  abortNodeMultipartUpload,
  getStorageNode,
  releaseStorageNodeReservationStatement,
  releaseUserStorageReservationStatement,
} from "@/lib/storage";

type RouteContext = { params: Promise<{ id: string }> };

function isNoSuchUpload(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (
    Reflect.get(error, "code") === 10024 ||
    Reflect.get(error, "name") === "NoSuchUpload"
  );
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
    const db = await ensureDatabase();
    const upload = await db
      .prepare(
        `SELECT m.upload_id, m.storage_key, m.storage_node_id, m.reserved_bytes,
                f.size
         FROM multipart_uploads m
         JOIN files f ON f.id = m.file_id
         WHERE m.file_id = ? AND m.owner_id = ?`,
      )
      .bind(id, user.id)
      .first<{
        upload_id: string;
        storage_key: string;
        storage_node_id: string | null;
        reserved_bytes: number;
        size: number;
      }>();
    if (!upload) throw new HttpError(404, "上传任务不存在。", "upload_not_found");
    const node = upload.storage_node_id
      ? await getStorageNode(db, upload.storage_node_id)
      : null;
    if (upload.storage_node_id && !node) {
      throw new HttpError(503, "上传所属的存储节点不存在。", "storage_node_missing");
    }
    if (node) {
      await abortNodeMultipartUpload(
        node,
        upload.storage_key,
        upload.upload_id,
        { ownerId: user.id, fileId: id },
      );
    } else {
      const bucket = getFileBucket();
      try {
        await bucket
          .resumeMultipartUpload(upload.storage_key, upload.upload_id)
          .abort();
      } catch (error) {
        if (!isNoSuchUpload(error)) throw error;
        const completed = await bucket.head(upload.storage_key);
        if (completedObjectMatches(completed, {
          size: upload.size,
          ownerId: user.id,
          fileId: id,
        })) {
          throw new HttpError(
            409,
            "上传已经完成，请刷新文件列表。",
            "upload_already_completed",
          );
        }
        if (completed) throw error;
      }
    }
    const now = new Date().toISOString();
    const statements = [
      releaseUserStorageReservationStatement(
        db,
        user.id,
        upload.reserved_bytes,
        now,
        id,
      ),
    ];
    if (node) {
      statements.push(
        releaseStorageNodeReservationStatement(
          db,
          node.id,
          upload.reserved_bytes,
          now,
          id,
          user.id,
        ),
      );
    }
    statements.push(
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
    await db.batch(statements);
    await audit("upload.aborted", user.id, "file", id, {
      storageNodeId: node?.id ?? null,
    });
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

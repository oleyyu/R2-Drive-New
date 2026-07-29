import { ensureDatabase, getFileBucket } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { getStorageNode, uploadNodePart } from "@/lib/storage";

type RouteContext = { params: Promise<{ id: string; partNumber: string }> };

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const { id, partNumber: partNumberValue } = await context.params;
    const partNumber = Number(partNumberValue);
    const db = await ensureDatabase();
    const upload = await db
      .prepare(
        `SELECT upload_id, storage_key, storage_node_id, expected_parts, expires_at
         FROM multipart_uploads WHERE file_id = ? AND owner_id = ?`,
      )
      .bind(id, user.id)
      .first<{
        upload_id: string;
        storage_key: string;
        storage_node_id: string | null;
        expected_parts: number;
        expires_at: string;
      }>();
    if (!upload || upload.expires_at <= new Date().toISOString()) {
      throw new HttpError(404, "上传任务不存在或已过期。", "upload_not_found");
    }
    const body = request.body;
    if (!body) throw new HttpError(400, "分片内容为空。", "empty_part");
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > upload.expected_parts) {
      throw new HttpError(400, "分片编号无效。", "invalid_part");
    }
    const storageNodeId = upload.storage_node_id;
    const part = storageNodeId
      ? await (async () => {
          const node = await getStorageNode(db, storageNodeId);
          if (!node) {
            throw new HttpError(503, "上传所属的存储节点不存在。", "storage_node_missing");
          }
          return uploadNodePart(
            node,
            upload.storage_key,
            upload.upload_id,
            partNumber,
            body,
          );
        })()
      : await getFileBucket()
          .resumeMultipartUpload(upload.storage_key, upload.upload_id)
          .uploadPart(partNumber, body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  } catch (error) {
    return apiError(error);
  }
}

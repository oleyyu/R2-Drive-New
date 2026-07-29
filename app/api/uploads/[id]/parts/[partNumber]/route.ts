import { ensureDatabase, getFileBucket } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";

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
        `SELECT upload_id, storage_key, expected_parts, expires_at
         FROM multipart_uploads WHERE file_id = ? AND owner_id = ?`,
      )
      .bind(id, user.id)
      .first<{
        upload_id: string;
        storage_key: string;
        expected_parts: number;
        expires_at: string;
      }>();
    if (!upload || upload.expires_at <= new Date().toISOString()) {
      throw new HttpError(404, "上传任务不存在或已过期。", "upload_not_found");
    }
    if (!request.body) throw new HttpError(400, "分片内容为空。", "empty_part");
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > upload.expected_parts) {
      throw new HttpError(400, "分片编号无效。", "invalid_part");
    }
    const multipart = getFileBucket().resumeMultipartUpload(upload.storage_key, upload.upload_id);
    const part = await multipart.uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  } catch (error) {
    return apiError(error);
  }
}

import { audit, ensureDatabase, getFileBucket } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(256) }))
    .min(1)
    .max(10_000),
});

type RouteContext = { params: Promise<{ id: string }> };

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
        `SELECT m.upload_id, m.storage_key, m.expected_parts, f.size
         FROM multipart_uploads m JOIN files f ON f.id = m.file_id
         WHERE m.file_id = ? AND m.owner_id = ?`,
      )
      .bind(id, user.id)
      .first<{ upload_id: string; storage_key: string; expected_parts: number; size: number }>();
    if (!upload) throw new HttpError(404, "上传任务不存在。", "upload_not_found");
    const sortedParts = [...input.data.parts].sort((a, b) => a.partNumber - b.partNumber);
    if (
      sortedParts.length !== upload.expected_parts ||
      sortedParts.some((part, index) => part.partNumber !== index + 1)
    ) {
      throw new HttpError(400, "分片不完整。", "parts_incomplete");
    }
    const multipart = getFileBucket().resumeMultipartUpload(upload.storage_key, upload.upload_id);
    const object = await multipart.complete(sortedParts);
    if (object.size !== upload.size) {
      await getFileBucket().delete(upload.storage_key);
      await db.prepare("UPDATE files SET status = 'failed', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
      throw new HttpError(409, "上传后的文件大小校验失败，已删除异常对象。", "size_mismatch");
    }
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare("UPDATE files SET status = 'ready', etag = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
        .bind(object.httpEtag, now, id, user.id),
      db.prepare("DELETE FROM multipart_uploads WHERE file_id = ? AND owner_id = ?").bind(id, user.id),
      db.prepare("UPDATE users SET storage_used = storage_used + ?, updated_at = ? WHERE id = ?").bind(object.size, now, user.id),
    ]);
    await audit("upload.completed", user.id, "file", id, { size: object.size, parts: sortedParts.length });
    return json({ fileId: id, size: object.size, etag: object.httpEtag, status: "ready" });
  } catch (error) {
    return apiError(error);
  }
}

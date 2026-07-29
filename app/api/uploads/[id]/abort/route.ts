import { audit, ensureDatabase, getFileBucket } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    const { id } = await context.params;
    const db = await ensureDatabase();
    const upload = await db
      .prepare("SELECT upload_id, storage_key FROM multipart_uploads WHERE file_id = ? AND owner_id = ?")
      .bind(id, user.id)
      .first<{ upload_id: string; storage_key: string }>();
    if (!upload) throw new HttpError(404, "上传任务不存在。", "upload_not_found");
    await getFileBucket().resumeMultipartUpload(upload.storage_key, upload.upload_id).abort();
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("DELETE FROM multipart_uploads WHERE file_id = ? AND owner_id = ?").bind(id, user.id),
      db.prepare("UPDATE files SET status = 'failed', updated_at = ? WHERE id = ? AND owner_id = ?").bind(now, id, user.id),
    ]);
    await audit("upload.aborted", user.id, "file", id);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

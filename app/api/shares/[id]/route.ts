import { audit, ensureDatabase } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "shares:write");
    const { id } = await context.params;
    const db = await ensureDatabase();
    const result = await db
      .prepare("DELETE FROM shares WHERE id = ? AND owner_id = ?")
      .bind(id, user.id)
      .run();
    if (!result.meta.changes) {
      throw new HttpError(404, "分享不存在。", "not_found");
    }
    await audit("share.revoked", user.id, "share", id);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

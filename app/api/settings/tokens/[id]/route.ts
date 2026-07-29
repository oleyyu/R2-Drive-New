import { audit, ensureDatabase } from "@/db/runtime";
import { requireSessionUser } from "@/lib/auth";
import { apiError, assertSameOrigin, json } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireSessionUser(request);
    const { id } = await context.params;
    const db = await ensureDatabase();
    await db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").bind(id, user.id).run();
    await audit("api_token.deleted", user.id, "api_token", id);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

import { audit, ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { apiError, assertSameOrigin, json } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const admin = await requireAdmin(request);
    const { id } = await context.params;
    const db = await ensureDatabase();
    await db.prepare("DELETE FROM invitations WHERE id = ?").bind(id).run();
    await audit("invitation.revoked", admin.id, "invitation", id);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

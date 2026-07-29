import { audit, ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  storageQuota: z.number().int().min(1024 ** 2).max(5_492_064_911_360).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const admin = await requireAdmin(request);
    const { id } = await context.params;
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "用户设置无效。", "invalid_input");
    if (id === admin.id && (input.data.role === "user" || input.data.status === "suspended")) {
      throw new HttpError(409, "不能移除或停用当前管理员。", "self_lockout");
    }
    const db = await ensureDatabase();
    const existing = await db
      .prepare("SELECT role, status, storage_quota FROM users WHERE id = ?")
      .bind(id)
      .first<{ role: "admin" | "user"; status: "active" | "suspended"; storage_quota: number }>();
    if (!existing) throw new HttpError(404, "用户不存在。", "not_found");
    await db
      .prepare("UPDATE users SET role = ?, status = ?, storage_quota = ?, updated_at = ? WHERE id = ?")
      .bind(
        input.data.role ?? existing.role,
        input.data.status ?? existing.status,
        input.data.storageQuota ?? existing.storage_quota,
        new Date().toISOString(),
        id,
      )
      .run();
    await audit("user.admin_updated", admin.id, "user", id, input.data);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

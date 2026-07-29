import { audit, ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  storageQuota: z
    .number()
    .int()
    .min(1024 ** 2)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
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
      .prepare(
        `SELECT role, status, storage_quota, storage_used, storage_reserved
         FROM users WHERE id = ?`,
      )
      .bind(id)
      .first<{
        role: "admin" | "user";
        status: "active" | "suspended";
        storage_quota: number;
        storage_used: number;
        storage_reserved: number;
      }>();
    if (!existing) throw new HttpError(404, "用户不存在。", "not_found");
    if (
      input.data.storageQuota !== undefined &&
      input.data.storageQuota <
        existing.storage_used + existing.storage_reserved
    ) {
      throw new HttpError(
        409,
        "用户配额不能小于已用和上传中容量。",
        "quota_below_usage",
      );
    }
    const updated = await db
      .prepare(
        `UPDATE users
         SET role = ?, status = ?, storage_quota = ?, updated_at = ?
         WHERE id = ?
           AND (? IS NULL OR ? >= storage_used + storage_reserved)`,
      )
      .bind(
        input.data.role ?? existing.role,
        input.data.status ?? existing.status,
        input.data.storageQuota ?? existing.storage_quota,
        new Date().toISOString(),
        id,
        input.data.storageQuota ?? null,
        input.data.storageQuota ?? null,
      )
      .run();
    if (Number(updated.meta.changes ?? 0) !== 1) {
      throw new HttpError(
        409,
        "用户配额不能小于已用和上传中容量。",
        "quota_below_usage",
      );
    }
    await audit("user.admin_updated", admin.id, "user", id, input.data);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

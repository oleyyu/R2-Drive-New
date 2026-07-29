import { audit, ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  registrationMode: z.enum(["open", "invite", "closed"]).optional(),
  defaultUserQuotaBytes: z.number().int().min(1024 ** 2).max(5_492_064_911_360).optional(),
  siteName: z.string().trim().min(1).max(80).optional(),
});

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const admin = await requireAdmin(request);
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "系统设置无效。", "invalid_input");
    const entries = [
      input.data.registrationMode && ["registration_mode", input.data.registrationMode],
      input.data.defaultUserQuotaBytes && ["default_user_quota_bytes", String(input.data.defaultUserQuotaBytes)],
      input.data.siteName && ["site_name", input.data.siteName],
    ].filter((entry): entry is [string, string] => Array.isArray(entry));
    const db = await ensureDatabase();
    const now = new Date().toISOString();
    if (entries.length) {
      await db.batch(
        entries.map(([key, value]) =>
          db
            .prepare(
              `INSERT INTO system_settings (key, value, updated_at, updated_by)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
            )
            .bind(key, value, now, admin.id),
        ),
      );
    }
    await audit("system.settings_updated", admin.id, "system", "settings", { keys: entries.map(([key]) => key) });
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

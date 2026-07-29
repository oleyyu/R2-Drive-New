import { audit, ensureDatabase } from "@/db/runtime";
import { requireSessionUser } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  preferences: z
    .object({
      theme: z.enum(["system", "light", "dark"]).optional(),
      density: z.enum(["comfortable", "compact"]).optional(),
      defaultView: z.enum(["list", "grid"]).optional(),
      uploadConcurrency: z.number().int().min(1).max(8).optional(),
      networkProfile: z.enum(["stable", "balanced", "throughput"]).optional(),
    })
    .optional(),
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().min(12).max(128).optional(),
});

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireSessionUser(request);
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "设置内容无效。", "invalid_input");
    const db = await ensureDatabase();
    const current = await db
      .prepare("SELECT display_name, preferences, password_hash FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ display_name: string; preferences: string; password_hash: string }>();
    if (!current) throw new HttpError(404, "账号不存在。", "not_found");
    let passwordHash = current.password_hash;
    if (input.data.newPassword) {
      if (!input.data.currentPassword || !(await verifyPassword(input.data.currentPassword, current.password_hash))) {
        throw new HttpError(401, "当前密码不正确。", "invalid_password");
      }
      passwordHash = await hashPassword(input.data.newPassword);
    }
    let currentPreferences: Record<string, unknown> = {};
    try {
      currentPreferences = JSON.parse(current.preferences) as Record<string, unknown>;
    } catch {
      currentPreferences = {};
    }
    const preferences = { ...currentPreferences, ...input.data.preferences };
    const displayName = input.data.displayName ?? current.display_name;
    await db
      .prepare(
        "UPDATE users SET display_name = ?, preferences = ?, password_hash = ?, updated_at = ? WHERE id = ?",
      )
      .bind(displayName, JSON.stringify(preferences), passwordHash, new Date().toISOString(), user.id)
      .run();
    await audit("user.settings_updated", user.id, "user", user.id, {
      profile: Boolean(input.data.displayName),
      preferences: Boolean(input.data.preferences),
      password: Boolean(input.data.newPassword),
    });
    return json({ user: { ...user, displayName, preferences } });
  } catch (error) {
    return apiError(error);
  }
}

import { appConfig } from "@/lib/config";
import { hashPassword, sha256 } from "@/lib/crypto";
import { audit, ensureDatabase } from "@/db/runtime";
import { createSession, registrationMode } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  displayName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
  inviteCode: z.string().trim().min(16).max(256).optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const input = schema.safeParse(await request.json());
    if (!input.success) {
      throw new HttpError(400, "请检查姓名、邮箱和密码。密码至少 12 位。", "invalid_input");
    }
    const db = await ensureDatabase();
    const count = await db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
    const isFirstUser = Number(count?.count ?? 0) === 0;
    const mode = await registrationMode();
    if (mode === "closed" && !isFirstUser) {
      throw new HttpError(403, "这是私人网盘，主人账号已经创建。", "registration_closed");
    }
    if (mode === "invite" && !isFirstUser) {
      if (!input.data.inviteCode) {
        throw new HttpError(403, "当前仅允许受邀注册，请填写邀请码。", "invite_required");
      }
      const invitation = await db
        .prepare(
          `SELECT id, email FROM invitations
           WHERE token_hash = ? AND expires_at > ? AND use_count < max_uses`,
        )
        .bind(await sha256(input.data.inviteCode), new Date().toISOString())
        .first<{ id: string; email: string | null }>();
      if (!invitation || (invitation.email && invitation.email.toLowerCase() !== input.data.email)) {
        throw new HttpError(403, "邀请码无效、已过期或与邮箱不匹配。", "invalid_invite");
      }
      const claimed = await db
        .prepare("UPDATE invitations SET use_count = use_count + 1 WHERE id = ? AND use_count < max_uses")
        .bind(invitation.id)
        .run();
      if (!claimed.meta.changes) {
        throw new HttpError(409, "邀请码已被使用完。", "invite_exhausted");
      }
    }
    const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(input.data.email).first();
    if (existing) throw new HttpError(409, "该邮箱已经注册。", "email_exists");

    const config = appConfig();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const role =
      isFirstUser || config.bootstrapAdminEmails.has(input.data.email)
        ? "admin"
        : "user";
    const insertUser =
      mode === "closed"
        ? db.prepare(
            `INSERT INTO users (
              id, email, display_name, password_hash, role, status,
              storage_quota, storage_used, preferences, created_at, updated_at
            )
            SELECT ?, ?, ?, ?, ?, 'active', ?, 0, '{}', ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM users)`,
          )
        : db.prepare(
            `INSERT INTO users (
              id, email, display_name, password_hash, role, status,
              storage_quota, storage_used, preferences, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?, 0, '{}', ?, ?)`,
          );
    const created = await insertUser
      .bind(
        id,
        input.data.email,
        input.data.displayName,
        await hashPassword(input.data.password),
        role,
        config.defaultQuotaBytes,
        now,
        now,
      )
      .run();
    if (mode === "closed" && !created.meta.changes) {
      throw new HttpError(403, "这是私人网盘，主人账号已经创建。", "registration_closed");
    }
    await audit("user.registered", id, "user", id, { role });
    const cookie = await createSession(id, request);
    return json(
      { user: { id, email: input.data.email, displayName: input.data.displayName, role } },
      { status: 201, headers: { "set-cookie": cookie } },
    );
  } catch (error) {
    return apiError(error);
  }
}

import { audit, ensureDatabase } from "@/db/runtime";
import { createSession } from "@/lib/auth";
import { verifyPassword } from "@/lib/crypto";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

type LoginRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: "admin" | "user";
  status: "active" | "suspended";
};

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "邮箱或密码格式不正确。", "invalid_input");
    const db = await ensureDatabase();
    const user = await db
      .prepare(
        "SELECT id, email, display_name, password_hash, role, status FROM users WHERE email = ?",
      )
      .bind(input.data.email)
      .first<LoginRow>();
    if (!user || !(await verifyPassword(input.data.password, user.password_hash))) {
      throw new HttpError(401, "邮箱或密码不正确。", "invalid_credentials");
    }
    if (user.status !== "active") {
      throw new HttpError(403, "该账号已被停用。", "account_suspended");
    }
    const cookie = await createSession(user.id, request);
    await audit("user.logged_in", user.id, "user", user.id);
    return json(
      {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
        },
      },
      { headers: { "set-cookie": cookie } },
    );
  } catch (error) {
    return apiError(error);
  }
}

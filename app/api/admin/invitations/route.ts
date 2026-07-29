import { audit, ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { secureToken, sha256 } from "@/lib/crypto";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(365),
  maxUses: z.number().int().min(1).max(10_000),
});

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const db = await ensureDatabase();
    const result = await db
      .prepare(
        `SELECT id, email, max_uses, use_count, expires_at, created_at
         FROM invitations ORDER BY created_at DESC LIMIT 100`,
      )
      .all<{
        id: string;
        email: string | null;
        max_uses: number;
        use_count: number;
        expires_at: string;
        created_at: string;
      }>();
    return json({
      invitations: result.results.map((invite) => ({
        id: invite.id,
        email: invite.email,
        maxUses: invite.max_uses,
        useCount: invite.use_count,
        expiresAt: invite.expires_at,
        createdAt: invite.created_at,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const admin = await requireAdmin(request);
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "邀请设置无效。", "invalid_input");
    const token = `invite_${secureToken(24)}`;
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + input.data.expiresInDays * 24 * 60 * 60 * 1000);
    const db = await ensureDatabase();
    await db
      .prepare(
        `INSERT INTO invitations (
          id, email, token_hash, max_uses, use_count, expires_at, created_by, created_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        id,
        input.data.email || null,
        await sha256(token),
        input.data.maxUses,
        expiresAt.toISOString(),
        admin.id,
        createdAt.toISOString(),
      )
      .run();
    await audit("invitation.created", admin.id, "invitation", id, {
      email: input.data.email || null,
      maxUses: input.data.maxUses,
    });
    return json({ id, token, expiresAt: expiresAt.toISOString() }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

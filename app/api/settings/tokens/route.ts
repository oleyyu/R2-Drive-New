import { audit, ensureDatabase } from "@/db/runtime";
import { requireSessionUser } from "@/lib/auth";
import { secureToken, sha256 } from "@/lib/crypto";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { z } from "zod";

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  scopes: z.array(z.enum(["files:read", "files:write", "shares:write"])).min(1).max(3),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireSessionUser(request);
    const db = await ensureDatabase();
    const result = await db
      .prepare(
        `SELECT id, name, prefix, scopes, expires_at, last_used_at, created_at
         FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .bind(user.id)
      .all<{
        id: string;
        name: string;
        prefix: string;
        scopes: string;
        expires_at: string | null;
        last_used_at: string | null;
        created_at: string;
      }>();
    return json({
      tokens: result.results.map((token) => ({
        id: token.id,
        name: token.name,
        prefix: token.prefix,
        scopes: JSON.parse(token.scopes) as string[],
        expiresAt: token.expires_at,
        lastUsedAt: token.last_used_at,
        createdAt: token.created_at,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireSessionUser(request);
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "令牌设置无效。", "invalid_input");
    const rawToken = `r2d_${secureToken(32)}`;
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = input.data.expiresInDays
      ? new Date(createdAt.getTime() + input.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const db = await ensureDatabase();
    await db
      .prepare(
        `INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        user.id,
        input.data.name,
        rawToken.slice(0, 12),
        await sha256(rawToken),
        JSON.stringify(input.data.scopes),
        expiresAt,
        createdAt.toISOString(),
      )
      .run();
    await audit("api_token.created", user.id, "api_token", id, { scopes: input.data.scopes });
    return json({ token: rawToken, id, expiresAt }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

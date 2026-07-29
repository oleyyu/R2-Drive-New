import { audit, ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { sha256, secureToken } from "@/lib/crypto";
import { apiError, assertSameOrigin, json } from "@/lib/http";

const ENROLLMENT_TTL_MS = 60 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const admin = await requireAdmin(request);
    const token = secureToken(36);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
    const db = await ensureDatabase();
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO storage_node_enrollments
           (id, token_hash, created_by, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        id,
        await sha256(token),
        admin.id,
        expiresAt.toISOString(),
        now.toISOString(),
      )
      .run();
    await audit("storage_node.enrollment_created", admin.id, "storage_node_enrollment", id);
    return json(
      {
        id,
        token,
        expiresAt: expiresAt.toISOString(),
        origin: new URL(request.url).origin,
      },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}

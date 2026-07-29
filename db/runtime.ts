import { env } from "cloudflare:workers";

export function getDatabase(): D1Database {
  if (!env.DB) {
    throw new Error("D1 binding DB is not configured.");
  }
  return env.DB;
}

export function getFileBucket(): R2Bucket {
  if (!env.FILES) {
    throw new Error("R2 binding FILES is not configured.");
  }
  return env.FILES;
}

export async function ensureDatabase(): Promise<D1Database> {
  return getDatabase();
}

export async function audit(
  action: string,
  actorId: string | null,
  targetType?: string,
  targetId?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const db = await ensureDatabase();
  await db
    .prepare(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      actorId,
      action,
      targetType ?? null,
      targetId ?? null,
      JSON.stringify(metadata),
      new Date().toISOString(),
    )
    .run();
}

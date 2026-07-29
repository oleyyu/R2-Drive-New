import { audit, ensureDatabase } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { secureToken, sha256 } from "@/lib/crypto";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { SHARING_DISABLED_MESSAGE } from "@/lib/public-sharing";
import { z } from "zod";

const schema = z.object({
  fileId: z.string().uuid(),
  expiresInHours: z.number().int().min(1).max(24 * 30).nullable().optional(),
  maxDownloads: z.number().int().min(1).max(1_000_000).nullable().optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, "shares:write");
    const db = await ensureDatabase();
    const result = await db
      .prepare(
        `SELECT s.id, s.file_id, s.expires_at, s.max_downloads, s.download_count,
                s.created_at, f.name, f.size, f.content_type
         FROM shares s
         JOIN files f ON f.id = s.file_id
         WHERE s.owner_id = ? AND f.status = 'ready'
         ORDER BY s.created_at DESC
         LIMIT 500`,
      )
      .bind(user.id)
      .all<{
        id: string;
        file_id: string;
        expires_at: string | null;
        max_downloads: number | null;
        download_count: number;
        created_at: string;
        name: string;
        size: number;
        content_type: string | null;
      }>();
    const now = new Date().toISOString();
    return json({
      shares: result.results.map((share) => ({
        id: share.id,
        fileId: share.file_id,
        fileName: share.name,
        size: share.size,
        contentType: share.content_type,
        expiresAt: share.expires_at,
        maxDownloads: share.max_downloads,
        downloadCount: share.download_count,
        createdAt: share.created_at,
        status:
          share.expires_at && share.expires_at <= now
            ? "expired"
            : share.max_downloads !== null &&
                share.download_count >= share.max_downloads
              ? "exhausted"
              : "active",
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "shares:write");
    const config = appConfig();
    if (!config.sharingEnabled) {
      throw new HttpError(409, SHARING_DISABLED_MESSAGE, "sharing_disabled");
    }
    const input = schema.safeParse(await request.json());
    if (!input.success) throw new HttpError(400, "分享设置无效。", "invalid_input");
    const db = await ensureDatabase();
    const file = await db
      .prepare("SELECT id FROM files WHERE id = ? AND owner_id = ? AND kind = 'file' AND status = 'ready'")
      .bind(input.data.fileId, user.id)
      .first();
    if (!file) throw new HttpError(404, "文件不存在。", "not_found");
    const token = secureToken(24);
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = input.data.expiresInHours
      ? new Date(createdAt.getTime() + input.data.expiresInHours * 60 * 60 * 1000).toISOString()
      : null;
    await db
      .prepare(
        `INSERT INTO shares (id, owner_id, file_id, token_hash, expires_at, max_downloads, download_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(id, user.id, input.data.fileId, await sha256(token), expiresAt, input.data.maxDownloads ?? null, createdAt.toISOString())
      .run();
    await audit("share.created", user.id, "share", id, { fileId: input.data.fileId, expiresAt });
    return json(
      {
        id,
        token,
        url: `${config.publicShareOrigin}/s/${token}`,
        expiresAt,
      },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}

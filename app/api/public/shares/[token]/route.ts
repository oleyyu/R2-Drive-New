import { ensureDatabase } from "@/db/runtime";
import { sha256 } from "@/lib/crypto";
import { appConfig } from "@/lib/config";
import { apiError, HttpError, json } from "@/lib/http";
import { SHARING_DISABLED_MESSAGE } from "@/lib/public-sharing";

type RouteContext = { params: Promise<{ token: string }> };

type ShareRow = {
  id: string;
  file_id: string;
  name: string;
  size: number;
  content_type: string | null;
  storage_key: string;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
};

async function getShare(token: string): Promise<ShareRow> {
  const db = await ensureDatabase();
  const share = await db
    .prepare(
      `SELECT s.id, s.file_id, s.expires_at, s.max_downloads, s.download_count,
              f.name, f.size, f.content_type, f.storage_key
       FROM shares s JOIN files f ON f.id = s.file_id
       WHERE s.token_hash = ? AND f.status = 'ready'`,
    )
    .bind(await sha256(token))
    .first<ShareRow>();
  if (!share) throw new HttpError(404, "分享不存在。", "not_found");
  if (share.expires_at && share.expires_at <= new Date().toISOString()) {
    throw new HttpError(410, "分享已过期。", "share_expired");
  }
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    throw new HttpError(410, "分享已达到下载次数上限。", "share_limit_reached");
  }
  return share;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    if (!appConfig().sharingEnabled) {
      throw new HttpError(503, SHARING_DISABLED_MESSAGE, "sharing_disabled");
    }
    const { token } = await context.params;
    const share = await getShare(token);
    return json({
      file: { id: share.file_id, name: share.name, size: share.size, contentType: share.content_type },
      expiresAt: share.expires_at,
      remainingDownloads:
        share.max_downloads === null ? null : Math.max(share.max_downloads - share.download_count, 0),
    });
  } catch (error) {
    return apiError(error);
  }
}

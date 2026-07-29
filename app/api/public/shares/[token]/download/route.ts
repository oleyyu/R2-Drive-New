import { ensureDatabase, getFileBucket } from "@/db/runtime";
import { sha256 } from "@/lib/crypto";
import { appConfig } from "@/lib/config";
import { apiError, contentDisposition, HttpError } from "@/lib/http";
import { SHARING_DISABLED_MESSAGE } from "@/lib/public-sharing";

type RouteContext = { params: Promise<{ token: string }> };

type ShareDownloadRow = {
  id: string;
  name: string;
  size: number;
  storage_key: string;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const config = appConfig();
    if (!config.sharingEnabled) {
      throw new HttpError(503, SHARING_DISABLED_MESSAGE, "sharing_disabled");
    }
    const { token } = await context.params;
    const db = await ensureDatabase();
    const share = await db
      .prepare(
        `SELECT s.id, s.expires_at, s.max_downloads, s.download_count,
                f.name, f.size, f.storage_key
         FROM shares s JOIN files f ON f.id = s.file_id
         WHERE s.token_hash = ? AND f.status = 'ready'`,
      )
      .bind(await sha256(token))
      .first<ShareDownloadRow>();
    if (!share) throw new HttpError(404, "分享不存在。", "not_found");
    if (share.expires_at && share.expires_at <= new Date().toISOString()) {
      throw new HttpError(410, "分享已过期。", "share_expired");
    }
    const rangeHeader = request.headers.get("range");
    const startsDownload = !rangeHeader || /^bytes=0-/i.test(rangeHeader);
    if (
      startsDownload &&
      share.max_downloads !== null &&
      share.download_count >= share.max_downloads
    ) {
      throw new HttpError(410, "分享已达到下载次数上限。", "share_limit_reached");
    }
    const object = await getFileBucket().get(share.storage_key, { range: request.headers });
    if (!object) throw new HttpError(404, "存储对象不存在。", "object_not_found");
    if (startsDownload) {
      const claimed = await db
        .prepare(
          `UPDATE shares SET download_count = download_count + 1
           WHERE id = ? AND (max_downloads IS NULL OR download_count < max_downloads)`,
        )
        .bind(share.id)
        .run();
      if (!claimed.meta.changes) {
        throw new HttpError(410, "分享已达到下载次数上限。", "share_limit_reached");
      }
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("content-disposition", contentDisposition(share.name));
    const configuredCacheSeconds = config.publicShareCacheSeconds;
    const cacheSeconds = share.expires_at
      ? Math.max(
          Math.min(
            configuredCacheSeconds,
            Math.floor((new Date(share.expires_at).getTime() - Date.now()) / 1000),
          ),
          0,
        )
      : configuredCacheSeconds;
    const cacheable = cacheSeconds > 0 && share.max_downloads === null;
    headers.set(
      "cache-control",
      cacheable
        ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`
        : "private, no-store",
    );
    if (cacheable) headers.set("x-r2drive-cacheable", "1");
    if (object.range) {
      const suffix = "suffix" in object.range ? object.range.suffix : null;
      const offset = suffix === null
        ? ("offset" in object.range ? object.range.offset ?? 0 : 0)
        : Math.max(share.size - suffix, 0);
      const length = suffix === null
        ? ("length" in object.range ? object.range.length ?? share.size - offset : share.size - offset)
        : Math.min(suffix, share.size);
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${share.size}`);
      headers.set("content-length", String(length));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  } catch (error) {
    return apiError(error);
  }
}

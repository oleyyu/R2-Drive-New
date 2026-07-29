import { ensureDatabase, getFileBucket } from "@/db/runtime";
import { sha256 } from "@/lib/crypto";
import { appConfig } from "@/lib/config";
import { apiError, contentDisposition, HttpError } from "@/lib/http";
import { SHARING_DISABLED_MESSAGE } from "@/lib/public-sharing";
import {
  getNodeObject,
  getStorageNode,
  nodeObjectResponseHeaders,
} from "@/lib/storage";

type RouteContext = { params: Promise<{ token: string }> };

function isInvalidRange(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (
    Reflect.get(error, "code") === 10039 ||
    Reflect.get(error, "name") === "InvalidRange"
  );
}

type ShareDownloadRow = {
  id: string;
  name: string;
  size: number;
  storage_key: string;
  storage_node_id: string | null;
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
                f.name, f.size, f.storage_key, f.storage_node_id
         FROM shares s JOIN files f ON f.id = s.file_id
         WHERE s.token_hash = ? AND f.status = 'ready'`,
      )
      .bind(await sha256(token))
      .first<ShareDownloadRow>();
    if (!share) throw new HttpError(404, "分享不存在。", "not_found");
    if (share.expires_at && share.expires_at <= new Date().toISOString()) {
      throw new HttpError(410, "分享已过期。", "share_expired");
    }
    if (
      share.max_downloads !== null &&
      share.download_count >= share.max_downloads
    ) {
      throw new HttpError(410, "分享已达到下载次数上限。", "share_limit_reached");
    }
    const headers = new Headers();
    let body: ReadableStream<Uint8Array> | null;
    let responseStatus = 200;
    if (share.storage_node_id) {
      const node = await getStorageNode(db, share.storage_node_id);
      if (!node) {
        throw new HttpError(503, "文件所属的存储节点不存在。", "storage_node_missing");
      }
      const object = await getNodeObject(
        node,
        share.storage_key,
        request.headers.get("range"),
      );
      if (object.status === 404) {
        await object.body?.cancel();
        throw new HttpError(404, "存储对象不存在。", "object_not_found");
      }
      if (object.status === 416) {
        await object.body?.cancel();
        throw new HttpError(416, "Range 请求无法满足。", "invalid_range");
      }
      if (object.status !== 200 && object.status !== 206) {
        await object.body?.cancel();
        throw new HttpError(
          502,
          `存储节点读取失败（HTTP ${object.status}）。`,
          "storage_node_error",
        );
      }
      body = object.body;
      responseStatus = object.status;
      nodeObjectResponseHeaders(object).forEach((value, name) => {
        headers.set(name, value);
      });
    } else {
      const object = await getFileBucket().get(share.storage_key, {
        range: request.headers,
      });
      if (!object) throw new HttpError(404, "存储对象不存在。", "object_not_found");
      body = object.body;
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
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
        responseStatus = 206;
      } else {
        headers.set("content-length", String(object.size));
      }
    }
    const claimed = await db
      .prepare(
        `UPDATE shares SET download_count = download_count + 1
         WHERE id = ? AND (max_downloads IS NULL OR download_count < max_downloads)`,
      )
      .bind(share.id)
      .run();
    if (!claimed.meta.changes) {
      await body?.cancel();
      throw new HttpError(410, "分享已达到下载次数上限。", "share_limit_reached");
    }
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
    return new Response(body, { status: responseStatus, headers });
  } catch (error) {
    if (isInvalidRange(error)) {
      return apiError(
        new HttpError(416, "Range 请求无法满足。", "invalid_range"),
      );
    }
    return apiError(error);
  }
}

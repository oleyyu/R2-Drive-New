import { AwsClient } from "aws4fetch";
import { env } from "cloudflare:workers";
import { ensureDatabase, getFileBucket } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { appConfig, directR2Configured } from "@/lib/config";
import { apiError, contentDisposition, HttpError } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireUser(request, "files:read");
    const { id } = await context.params;
    const db = await ensureDatabase();
    const file = await db
      .prepare(
        `SELECT storage_key, name, content_type, size
         FROM files WHERE id = ? AND owner_id = ? AND kind = 'file' AND status = 'ready'`,
      )
      .bind(id, user.id)
      .first<{ storage_key: string; name: string; content_type: string | null; size: number }>();
    if (!file) throw new HttpError(404, "文件不存在。", "not_found");
    const config = appConfig();
    if (
      config.downloadMode === "direct" &&
      directR2Configured() &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY
    ) {
      const keyPath = file.storage_key.split("/").map(encodeURIComponent).join("/");
      const url = new URL(
        `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucketName)}/${keyPath}`,
      );
      url.searchParams.set("X-Amz-Expires", "900");
      url.searchParams.set("response-content-disposition", contentDisposition(file.name));
      const client = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        service: "s3",
        region: "auto",
      });
      const signed = await client.sign(new Request(url), { aws: { signQuery: true } });
      return Response.redirect(signed.url, 302);
    }

    const object = await getFileBucket().get(file.storage_key, { range: request.headers });
    if (!object) throw new HttpError(404, "存储对象不存在。", "object_not_found");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("content-disposition", contentDisposition(file.name));
    headers.set("cache-control", "private, no-store");
    if (object.range) {
      const suffix = "suffix" in object.range ? object.range.suffix : null;
      const offset = suffix === null
        ? ("offset" in object.range ? object.range.offset ?? 0 : 0)
        : Math.max(file.size - suffix, 0);
      const length = suffix === null
        ? ("length" in object.range ? object.range.length ?? file.size - offset : file.size - offset)
        : Math.min(suffix, file.size);
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${file.size}`);
      headers.set("content-length", String(length));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  } catch (error) {
    return apiError(error);
  }
}

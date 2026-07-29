import { AwsClient } from "aws4fetch";
import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/runtime";
import { requireUser } from "@/lib/auth";
import { appConfig, directR2Configured } from "@/lib/config";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string; partNumber: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request, "files:write");
    if (
      appConfig().uploadMode === "proxy" ||
      !directR2Configured() ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY
    ) {
      throw new HttpError(503, "直传凭据尚未配置，请使用代理上传。", "direct_upload_unavailable");
    }
    const { id, partNumber: partNumberValue } = await context.params;
    const partNumber = Number(partNumberValue);
    const db = await ensureDatabase();
    const upload = await db
      .prepare(
        `SELECT m.upload_id, m.storage_key, m.storage_node_id, m.expected_parts,
                m.expires_at, f.content_type
         FROM multipart_uploads m JOIN files f ON f.id = m.file_id
         WHERE m.file_id = ? AND m.owner_id = ?`,
      )
      .bind(id, user.id)
      .first<{
        upload_id: string;
        storage_key: string;
        storage_node_id: string | null;
        expected_parts: number;
        expires_at: string;
        content_type: string | null;
      }>();
    if (!upload || upload.expires_at <= new Date().toISOString()) {
      throw new HttpError(404, "上传任务不存在或已过期。", "upload_not_found");
    }
    if (upload.storage_node_id) {
      throw new HttpError(
        503,
        "这个上传任务由远端存储节点代理，不提供 R2 直传签名。",
        "direct_upload_unavailable",
      );
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > upload.expected_parts) {
      throw new HttpError(400, "分片编号无效。", "invalid_part");
    }
    const config = appConfig();
    const keyPath = upload.storage_key.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucketName)}/${keyPath}`,
    );
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", upload.upload_id);
    url.searchParams.set("X-Amz-Expires", String(config.uploadUrlTtlSeconds));
    const client = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    });
    const signed = await client.sign(new Request(url, { method: "PUT" }), {
      aws: { signQuery: true },
    });
    return json({
      url: signed.url,
      expiresAt: new Date(Date.now() + config.uploadUrlTtlSeconds * 1000).toISOString(),
    });
  } catch (error) {
    return apiError(error);
  }
}

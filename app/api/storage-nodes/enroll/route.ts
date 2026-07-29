import { audit, ensureDatabase } from "@/db/runtime";
import { appConfig } from "@/lib/config";
import { sha256 } from "@/lib/crypto";
import { apiError, HttpError, json } from "@/lib/http";
import { readStorageNodeJson } from "@/lib/storage";
import { signedNodeFetch } from "@/lib/storage-capability";
import { z } from "zod";

const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const bucketNamePattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

const schema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(80),
  accountId: z.string().regex(/^[0-9a-f]{32}$/i),
  bucketName: z.string().regex(bucketNamePattern),
  workerName: z.string().regex(workerNamePattern),
  endpoint: z
    .string()
    .url()
    .max(500)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname.endsWith(".workers.dev") &&
        url.hostname.length > ".workers.dev".length &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    }, "节点地址必须是无路径的 HTTPS Origin。"),
  softLimitBytes: z.number().int().min(1024 ** 3).max(Number.MAX_SAFE_INTEGER),
  managedBucket: z.boolean(),
  managedWorker: z.boolean(),
});

type RegisteredNode = {
  id: string;
  account_id: string;
  bucket_name: string;
  worker_name: string;
  endpoint: string;
  soft_limit_bytes: number;
  managed_bucket: number;
  managed_worker: number;
};

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "节点连接凭证缺失。", "enrollment_required");
  }
  const token = authorization.slice(7).trim();
  if (token.length < 32 || token.length > 256) {
    throw new HttpError(401, "节点连接凭证无效。", "invalid_enrollment");
  }
  return token;
}

export async function POST(request: Request): Promise<Response> {
  let claimedEnrollment:
    | { id: string; created_by: string; claimed_at: string }
    | undefined;
  try {
    const rawToken = bearerToken(request);
    const db = await ensureDatabase();
    const now = new Date().toISOString();
    const tokenHash = await sha256(rawToken);
    const enrollment = await db
      .prepare(
        `SELECT id, created_by
         FROM storage_node_enrollments
         WHERE token_hash = ? AND used_at IS NULL
           AND completed_node_id IS NULL AND expires_at > ?`,
      )
      .bind(tokenHash, now)
      .first<{ id: string; created_by: string }>();
    if (!enrollment) {
      throw new HttpError(401, "节点连接凭证已过期或已使用。", "invalid_enrollment");
    }
    const input = schema.safeParse(await request.json());
    if (!input.success) {
      throw new HttpError(400, "存储节点信息无效。", "invalid_node");
    }
    const endpointHostname = new URL(input.data.endpoint).hostname;
    if (endpointHostname.split(".")[0] !== input.data.workerName) {
      throw new HttpError(
        400,
        "节点地址与 Wrangler 部署的 Worker 名称不匹配。",
        "invalid_node_endpoint",
      );
    }
    const primary = appConfig();
    if (
      primary.accountId.toLowerCase() === input.data.accountId.toLowerCase() &&
      primary.bucketName === input.data.bucketName
    ) {
      throw new HttpError(
        409,
        "主账号 R2 存储桶已由网盘直接使用，不能再作为附加节点连接。",
        "primary_storage_node_conflict",
      );
    }
    const claim = await db
      .prepare(
        `UPDATE storage_node_enrollments
         SET used_at = ?
         WHERE id = ? AND used_at IS NULL
           AND completed_node_id IS NULL AND expires_at > ?`,
      )
      .bind(now, enrollment.id, now)
      .run();
    if (Number(claim.meta.changes ?? 0) !== 1) {
      throw new HttpError(409, "这个节点连接凭证已经使用。", "enrollment_used");
    }
    claimedEnrollment = {
      id: enrollment.id,
      created_by: enrollment.created_by,
      claimed_at: now,
    };

    const node = {
      id: input.data.id,
      endpoint: input.data.endpoint.replace(/\/$/, ""),
    };
    const healthResponse = await signedNodeFetch(node, "/v1/health", {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthResponse.ok) {
      throw new HttpError(502, "新节点没有通过安全健康检查。", "node_unhealthy");
    }
    const health = await readStorageNodeJson(healthResponse, "健康检查");
    if (
      typeof health !== "object" ||
      health === null ||
      !("ok" in health) ||
      !("nodeId" in health) ||
      !("protocol" in health) ||
      health.ok !== true ||
      health.nodeId !== input.data.id ||
      health.protocol !== "r2drive-storage-node-v1"
    ) {
      throw new HttpError(502, "新节点返回了不匹配的身份。", "node_identity_mismatch");
    }

    const findExisting = () =>
      db
        .prepare(
          `SELECT id, account_id, bucket_name, worker_name, endpoint, soft_limit_bytes,
                  managed_bucket, managed_worker
           FROM storage_nodes
           WHERE id = ? OR (account_id = ? AND bucket_name = ?)
           LIMIT 1`,
        )
        .bind(
          input.data.id,
          input.data.accountId.toLowerCase(),
          input.data.bucketName,
        )
        .first<RegisteredNode>();
    const completeEnrollment = async (): Promise<void> => {
      const completed = await db
        .prepare(
          `UPDATE storage_node_enrollments
           SET completed_node_id = ?
           WHERE id = ? AND used_at = ? AND completed_node_id IS NULL`,
        )
        .bind(input.data.id, enrollment.id, now)
        .run();
      if (Number(completed.meta.changes ?? 0) !== 1) {
        throw new HttpError(
          409,
          "节点已经登记，但连接结果未能安全确认；请使用同一连接凭证重试。",
          "enrollment_completion_changed",
        );
      }
      claimedEnrollment = undefined;
    };
    const reconnectExisting = async (
      existing: RegisteredNode,
    ): Promise<Response> => {
      if (existing.id !== input.data.id) {
        throw new HttpError(
          409,
          "这个 R2 存储桶已经连接到网盘，请勿重复添加。",
          "storage_node_exists",
        );
      }
      const sameNode =
        existing.account_id === input.data.accountId.toLowerCase() &&
        existing.bucket_name === input.data.bucketName &&
        existing.worker_name === input.data.workerName &&
        existing.endpoint === node.endpoint &&
        existing.soft_limit_bytes === input.data.softLimitBytes &&
        Boolean(existing.managed_bucket) === input.data.managedBucket &&
        Boolean(existing.managed_worker) === input.data.managedWorker;
      if (!sameNode) {
        throw new HttpError(
          409,
          "同一节点 ID 已登记为其他资源，已停止以避免覆盖。",
          "storage_node_conflict",
        );
      }
      const reconnected = await db
        .prepare(
          `UPDATE storage_nodes
           SET label = ?, status = 'active', last_health_at = ?,
               last_error = NULL, updated_at = ?
           WHERE id = ?
             AND account_id = ? AND bucket_name = ?
             AND worker_name = ? AND endpoint = ?
             AND soft_limit_bytes = ?
             AND managed_bucket = ? AND managed_worker = ?`,
        )
        .bind(
          input.data.label,
          now,
          now,
          input.data.id,
          input.data.accountId.toLowerCase(),
          input.data.bucketName,
          input.data.workerName,
          node.endpoint,
          input.data.softLimitBytes,
          input.data.managedBucket ? 1 : 0,
          input.data.managedWorker ? 1 : 0,
        )
        .run();
      if (Number(reconnected.meta.changes ?? 0) !== 1) {
        throw new HttpError(
          409,
          "节点登记状态刚刚发生变化，请使用同一连接凭证重试。",
          "storage_node_changed",
        );
      }
      await completeEnrollment();
      try {
        await audit(
          "storage_node.reconnected",
          enrollment.created_by,
          "storage_node",
          input.data.id,
        );
      } catch {
        console.error(
          JSON.stringify({
            event: "storage_node_reconnected_audit_failed",
            nodeId: input.data.id,
          }),
        );
      }
      return json({
        node: {
          id: input.data.id,
          label: input.data.label,
          endpoint: node.endpoint,
          status: "active",
        },
      });
    };

    const existing = await findExisting();
    if (existing) {
      return await reconnectExisting(existing);
    }

    const inserted = await db.batch([
      db
        .prepare(
          `INSERT INTO storage_nodes (
             id, quota_owner_id, label, kind, account_id, bucket_name, worker_name, endpoint, status,
             soft_limit_bytes, used_bytes, reserved_bytes, managed_bucket, managed_worker,
             last_health_at, last_error, created_at, updated_at
           )
           SELECT ?, id, ?, 'worker_proxy', ?, ?, ?, ?, 'active', ?, 0, 0,
                  ?, ?, ?, NULL, ?, ?
           FROM users
           WHERE id = ? AND storage_quota <= ? - ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          input.data.id,
          input.data.label,
          input.data.accountId.toLowerCase(),
          input.data.bucketName,
          input.data.workerName,
          node.endpoint,
          input.data.softLimitBytes,
          input.data.managedBucket ? 1 : 0,
          input.data.managedWorker ? 1 : 0,
          now,
          now,
          now,
          enrollment.created_by,
          Number.MAX_SAFE_INTEGER,
          input.data.softLimitBytes,
        ),
      db
        .prepare(
          `UPDATE users
           SET storage_quota = storage_quota + ?, updated_at = ?
           WHERE changes() = 1
             AND id = ?
             AND EXISTS (
               SELECT 1 FROM storage_nodes
               WHERE id = ? AND quota_owner_id = users.id
             )`,
        )
        .bind(
          input.data.softLimitBytes,
          now,
          enrollment.created_by,
          input.data.id,
        ),
    ]);
    if (Number(inserted[0].meta.changes ?? 0) !== 1) {
      // Another serialized D1 transaction may have inserted this unique node
      // after our preflight read. ON CONFLICT makes that retry idempotent, and
      // changes() above ensures this request cannot charge quota for its row.
      const racedExisting = await findExisting();
      if (racedExisting) {
        return await reconnectExisting(racedExisting);
      }
      throw new HttpError(
        409,
        "节点软容量会超过网盘可安全表示的总配额，请降低软容量。",
        "storage_quota_too_large",
      );
    }
    // From this point the node and its quota adjustment are committed. Never
    // make the one-time token reusable if a non-critical audit write fails.
    await completeEnrollment();
    try {
      await audit(
        "storage_node.connected",
        enrollment.created_by,
        "storage_node",
        input.data.id,
        {
          accountId: input.data.accountId,
          bucketName: input.data.bucketName,
          softLimitBytes: input.data.softLimitBytes,
        },
      );
    } catch {
      console.error(
        JSON.stringify({
          event: "storage_node_connected_audit_failed",
          nodeId: input.data.id,
        }),
      );
    }
    return json(
      {
        node: {
          id: input.data.id,
          label: input.data.label,
          endpoint: node.endpoint,
          status: "active",
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (claimedEnrollment) {
      try {
        const db = await ensureDatabase();
        await db
          .prepare(
            `UPDATE storage_node_enrollments
             SET used_at = NULL
             WHERE id = ? AND used_at = ? AND completed_node_id IS NULL`,
          )
          .bind(claimedEnrollment.id, claimedEnrollment.claimed_at)
          .run();
      } catch {
        // The enrollment is intentionally left consumed if recovery itself fails.
      }
    }
    return apiError(error);
  }
}

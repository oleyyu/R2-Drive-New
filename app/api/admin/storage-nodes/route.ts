import { ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { apiError, json } from "@/lib/http";
import { cleanupExpiredMultipartMetadata } from "@/lib/storage";

type NodeRow = {
  id: string;
  label: string;
  kind: "worker_proxy";
  account_id: string;
  bucket_name: string;
  worker_name: string;
  endpoint: string;
  status: "active" | "draining" | "offline";
  soft_limit_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
  managed_bucket: number;
  managed_worker: number;
  last_health_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const db = await ensureDatabase();
    await cleanupExpiredMultipartMetadata(db);
    const [nodes, primaryUsage] = await Promise.all([
      db
        .prepare(
          `SELECT id, label, kind, account_id, bucket_name, worker_name, endpoint, status,
                  soft_limit_bytes, used_bytes, reserved_bytes, managed_bucket, managed_worker,
                  last_health_at, last_error, created_at, updated_at
           FROM storage_nodes
           ORDER BY created_at ASC`,
        )
        .all<NodeRow>(),
      db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN status IN ('ready', 'deleted') THEN size ELSE 0 END), 0) AS used,
             COALESCE(SUM(CASE WHEN status = 'uploading' THEN size ELSE 0 END), 0) AS reserved
           FROM files
           WHERE kind = 'file' AND storage_node_id IS NULL`,
        )
        .first<{ used: number; reserved: number }>(),
    ]);
    const config = appConfig();
    return json({
      primary: {
        id: null,
        label: "主账号 R2",
        kind: "primary_binding",
        accountId: config.accountId,
        bucketName: config.bucketName,
        status: "active",
        softLimitBytes: null,
        usedBytes: Number(primaryUsage?.used ?? 0),
        reservedBytes: Number(primaryUsage?.reserved ?? 0),
      },
      nodes: nodes.results.map((node) => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        accountId: node.account_id,
        bucketName: node.bucket_name,
        workerName: node.worker_name,
        endpoint: node.endpoint,
        status: node.status,
        softLimitBytes: node.soft_limit_bytes,
        usedBytes: node.used_bytes,
        reservedBytes: node.reserved_bytes,
        managedBucket: Boolean(node.managed_bucket),
        managedWorker: Boolean(node.managed_worker),
        lastHealthAt: node.last_health_at,
        lastError: node.last_error,
        createdAt: node.created_at,
        updatedAt: node.updated_at,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

import { signedNodeFetch } from "@/lib/storage-capability";

export type StorageNodeStatus = "active" | "draining" | "offline";

export type StorageNode = {
  id: string;
  label: string;
  kind: "worker_proxy";
  accountId: string;
  bucketName: string;
  workerName: string;
  endpoint: string;
  status: StorageNodeStatus;
  softLimitBytes: number | null;
  usedBytes: number;
  reservedBytes: number;
};

type StorageNodeRow = {
  id: string;
  label: string;
  kind: "worker_proxy";
  account_id: string;
  bucket_name: string;
  worker_name: string;
  endpoint: string;
  status: StorageNodeStatus;
  soft_limit_bytes: number | null;
  used_bytes: number;
  reserved_bytes: number;
};

export type UploadedStoragePart = {
  partNumber: number;
  etag: string;
};

export type CompletedStorageObject = {
  size: number;
  httpEtag: string;
};

function rowToStorageNode(row: StorageNodeRow): StorageNode {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    accountId: row.account_id,
    bucketName: row.bucket_name,
    workerName: row.worker_name,
    endpoint: row.endpoint,
    status: row.status,
    softLimitBytes: row.soft_limit_bytes,
    usedBytes: row.used_bytes,
    reservedBytes: row.reserved_bytes,
  };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const MAX_NODE_CONTROL_RESPONSE_BYTES = 64 * 1024;
const NODE_OBJECT_RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "content-language",
  "content-length",
  "content-range",
  "etag",
  "last-modified",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class StorageNodeRequestError extends Error {
  constructor(
    public readonly status: number,
    operation: string,
  ) {
    super(`存储节点${operation}失败（HTTP ${status}）。`);
    this.name = "StorageNodeRequestError";
  }
}

export async function readStorageNodeJson(
  response: Response,
  operation: string,
): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new StorageNodeRequestError(response.status, operation);
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^[0-9]+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_NODE_CONTROL_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error(`存储节点${operation}返回内容过大。`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error(`存储节点${operation}返回了空响应。`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_NODE_CONTROL_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`存储节点${operation}返回内容过大。`);
      }
      chunks.push(chunk.value);
    }
  } catch {
    throw new Error(`存储节点${operation}返回了无效响应。`);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`存储节点${operation}返回了无效响应。`);
  }
}

export async function getStorageNode(
  db: D1Database,
  nodeId: string,
): Promise<StorageNode | null> {
  const row = await db
    .prepare(
      `SELECT id, label, kind, account_id, bucket_name, worker_name, endpoint,
              status, soft_limit_bytes, used_bytes, reserved_bytes
       FROM storage_nodes WHERE id = ?`,
    )
    .bind(nodeId)
    .first<StorageNodeRow>();
  return row ? rowToStorageNode(row) : null;
}

export async function reserveStorageNode(
  db: D1Database,
  bytes: number,
): Promise<StorageNode | null> {
  const retryAfter = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const candidates = await db
    .prepare(
      `SELECT id, label, kind, account_id, bucket_name, worker_name, endpoint,
              status, soft_limit_bytes, used_bytes, reserved_bytes
       FROM storage_nodes
       WHERE kind = 'worker_proxy'
         AND status = 'active'
         AND (last_error IS NULL OR updated_at <= ?)
         AND (soft_limit_bytes IS NULL OR used_bytes + reserved_bytes + ? <= soft_limit_bytes)
       ORDER BY
         CASE
           WHEN soft_limit_bytes IS NULL OR soft_limit_bytes <= 0
             THEN CAST(used_bytes + reserved_bytes AS REAL) / 9007199254740991.0
           ELSE CAST(used_bytes + reserved_bytes AS REAL) / soft_limit_bytes
         END ASC,
         used_bytes + reserved_bytes ASC,
         created_at ASC
       LIMIT 20`,
    )
    .bind(retryAfter, bytes)
    .all<StorageNodeRow>();

  for (const row of candidates.results) {
    const reserved = await db
      .prepare(
        `UPDATE storage_nodes
         SET reserved_bytes = reserved_bytes + ?, updated_at = ?
         WHERE id = ?
           AND status = 'active'
           AND (soft_limit_bytes IS NULL OR used_bytes + reserved_bytes + ? <= soft_limit_bytes)`,
      )
      .bind(bytes, new Date().toISOString(), row.id, bytes)
      .run();
    if (reserved.meta.changes) {
      return {
        ...rowToStorageNode(row),
        reservedBytes: row.reserved_bytes + bytes,
      };
    }
  }
  return null;
}

export async function releaseStorageNodeReservation(
  db: D1Database,
  nodeId: string,
  bytes: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE storage_nodes
       SET reserved_bytes = MAX(0, reserved_bytes - ?), updated_at = ?
       WHERE id = ?`,
    )
    .bind(bytes, new Date().toISOString(), nodeId)
    .run();
}

export async function reserveUserStorage(
  db: D1Database,
  userId: string,
  bytes: number,
): Promise<boolean> {
  const reserved = await db
    .prepare(
      `UPDATE users
       SET storage_reserved = storage_reserved + ?, updated_at = ?
       WHERE id = ?
         AND storage_used + storage_reserved + ? <= storage_quota`,
    )
    .bind(bytes, new Date().toISOString(), userId, bytes)
    .run();
  return Number(reserved.meta.changes ?? 0) === 1;
}

export async function releaseUserStorageReservation(
  db: D1Database,
  userId: string,
  bytes: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET storage_reserved = MAX(0, storage_reserved - ?), updated_at = ?
       WHERE id = ?`,
    )
    .bind(bytes, new Date().toISOString(), userId)
    .run();
}

export function releaseUserStorageReservationStatement(
  db: D1Database,
  userId: string,
  reservedBytes: number,
  now: string,
  fileId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users
       SET storage_reserved = MAX(0, storage_reserved - ?), updated_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM multipart_uploads
           WHERE file_id = ? AND owner_id = ?
         )`,
    )
    .bind(reservedBytes, now, userId, fileId, userId);
}

export function settleUserStorageReservationStatement(
  db: D1Database,
  userId: string,
  reservedBytes: number,
  objectBytes: number,
  now: string,
  fileId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users
       SET storage_reserved = MAX(0, storage_reserved - ?),
           storage_used = storage_used + ?,
           updated_at = ?
       WHERE changes() = 1
         AND id = ?
         AND EXISTS (
           SELECT 1 FROM multipart_uploads
           WHERE file_id = ? AND owner_id = ?
         )`,
    )
    .bind(reservedBytes, objectBytes, now, userId, fileId, userId);
}

export function settleStorageNodeReservationStatement(
  db: D1Database,
  nodeId: string,
  reservedBytes: number,
  objectBytes: number,
  now: string,
  fileId: string,
  ownerId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE storage_nodes
       SET reserved_bytes = MAX(0, reserved_bytes - ?),
           used_bytes = used_bytes + ?,
           last_health_at = ?,
           last_error = NULL,
           updated_at = ?
       WHERE changes() = 1
         AND id = ?
         AND EXISTS (
           SELECT 1 FROM multipart_uploads
           WHERE file_id = ? AND owner_id = ? AND storage_node_id = ?
         )`,
    )
    .bind(
      reservedBytes,
      objectBytes,
      now,
      now,
      nodeId,
      fileId,
      ownerId,
      nodeId,
    );
}

export function releaseStorageNodeReservationStatement(
  db: D1Database,
  nodeId: string,
  reservedBytes: number,
  now: string,
  fileId: string,
  ownerId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE storage_nodes
       SET reserved_bytes = MAX(0, reserved_bytes - ?), updated_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM multipart_uploads
           WHERE file_id = ? AND owner_id = ? AND storage_node_id = ?
         )`,
    )
    .bind(reservedBytes, now, nodeId, fileId, ownerId, nodeId);
}

export async function cleanupExpiredMultipartMetadata(
  db: D1Database,
  now = new Date().toISOString(),
): Promise<number> {
  const count = await db
    .prepare(
      "SELECT COUNT(*) AS total FROM multipart_uploads WHERE expires_at <= ?",
    )
    .bind(now)
    .first<{ total: number }>();
  const expiredCount = Number(count?.total ?? 0);
  if (expiredCount === 0) return 0;

  await db.batch([
    db
      .prepare(
        `UPDATE storage_nodes
         SET reserved_bytes = MAX(
               0,
               reserved_bytes - COALESCE(
                 (
                   SELECT SUM(expired.reserved_bytes)
                   FROM multipart_uploads expired
                   WHERE expired.storage_node_id = storage_nodes.id
                     AND expired.expires_at <= ?
                 ),
                 0
               )
             ),
             updated_at = ?
         WHERE EXISTS (
           SELECT 1
           FROM multipart_uploads expired
           WHERE expired.storage_node_id = storage_nodes.id
             AND expired.expires_at <= ?
         )`,
      )
      .bind(now, now, now),
    db
      .prepare(
        `UPDATE users
         SET storage_reserved = MAX(
               0,
               storage_reserved - COALESCE(
                 (
                   SELECT SUM(expired.reserved_bytes)
                   FROM multipart_uploads expired
                   WHERE expired.owner_id = users.id
                     AND expired.expires_at <= ?
                 ),
                 0
               )
             ),
             updated_at = ?
         WHERE EXISTS (
           SELECT 1
           FROM multipart_uploads expired
           WHERE expired.owner_id = users.id
             AND expired.expires_at <= ?
         )`,
      )
      .bind(now, now, now),
    db
      .prepare(
        `DELETE FROM files
         WHERE status = 'uploading'
           AND id IN (
             SELECT file_id FROM multipart_uploads WHERE expires_at <= ?
           )`,
      )
      .bind(now),
    db
      .prepare("DELETE FROM multipart_uploads WHERE expires_at <= ?")
      .bind(now),
  ]);
  return expiredCount;
}

export async function releaseStorageNodeUsage(
  db: D1Database,
  nodeId: string,
  bytes: number,
): Promise<void> {
  if (bytes <= 0) return;
  await db
    .prepare(
      `UPDATE storage_nodes
       SET used_bytes = MAX(0, used_bytes - ?), updated_at = ?
       WHERE id = ?`,
    )
    .bind(bytes, new Date().toISOString(), nodeId)
    .run();
}

export function releaseStorageNodeUsageStatement(
  db: D1Database,
  nodeId: string,
  bytes: number,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE storage_nodes
       SET used_bytes = MAX(0, used_bytes - ?), updated_at = ?
       WHERE id = ?`,
    )
    .bind(bytes, now, nodeId);
}

export async function recordStorageNodeError(
  db: D1Database,
  nodeId: string,
  error: unknown,
  offline = false,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .prepare(
      `UPDATE storage_nodes
       SET last_error = ?,
           status = CASE WHEN ? THEN 'offline' ELSE status END,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      message.slice(0, 500),
      offline ? 1 : 0,
      new Date().toISOString(),
      nodeId,
    )
    .run();
}

export async function createNodeMultipartUpload(
  node: StorageNode,
  storageKey: string,
  options: {
    contentType: string;
    ownerId: string;
    fileId: string;
  },
): Promise<string> {
  const response = await signedNodeFetch(node, "/v1/multipart/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: storageKey,
      contentType: options.contentType,
      ownerId: options.ownerId,
      fileId: options.fileId,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await readStorageNodeJson(response, "创建上传任务");
  if (
    !isRecord(result) ||
    typeof result.uploadId !== "string" ||
    !result.uploadId ||
    new TextEncoder().encode(result.uploadId).byteLength > 1_024
  ) {
    throw new Error("存储节点没有返回有效的上传任务编号。");
  }
  return result.uploadId;
}

export async function uploadNodePart(
  node: StorageNode,
  storageKey: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream<Uint8Array>,
): Promise<UploadedStoragePart> {
  const query = new URLSearchParams({ key: storageKey });
  const response = await signedNodeFetch(
    node,
    `/v1/multipart/${encodeURIComponent(uploadId)}/parts/${partNumber}?${query}`,
    {
      method: "PUT",
      body,
    },
  );
  const result = await readStorageNodeJson(response, "上传分片");
  if (
    !isRecord(result) ||
    typeof result.etag !== "string" ||
    !result.etag ||
    result.etag.length > 512 ||
    result.partNumber !== partNumber
  ) {
    throw new Error("存储节点没有返回有效的分片编号。");
  }
  return { partNumber, etag: result.etag };
}

export async function completeNodeMultipartUpload(
  node: StorageNode,
  storageKey: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  options: {
    ownerId: string;
    fileId: string;
    expectedSize: number;
  },
): Promise<CompletedStorageObject> {
  const response = await signedNodeFetch(
    node,
    `/v1/multipart/${encodeURIComponent(uploadId)}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: storageKey,
        ownerId: options.ownerId,
        fileId: options.fileId,
        expectedSize: options.expectedSize,
        parts,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const result = await readStorageNodeJson(response, "完成上传");
  if (
    !isRecord(result) ||
    !Number.isSafeInteger(result.size) ||
    Number(result.size) < 0 ||
    typeof result.httpEtag !== "string" ||
    !result.httpEtag ||
    result.httpEtag.length > 512
  ) {
    throw new Error("存储节点没有返回有效的对象信息。");
  }
  return { size: Number(result.size), httpEtag: result.httpEtag };
}

export async function abortNodeMultipartUpload(
  node: StorageNode,
  storageKey: string,
  uploadId: string,
  options: {
    ownerId: string;
    fileId: string;
  },
): Promise<void> {
  const response = await signedNodeFetch(
    node,
    `/v1/multipart/${encodeURIComponent(uploadId)}/abort`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: storageKey,
        ownerId: options.ownerId,
        fileId: options.fileId,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`存储节点中止上传失败（HTTP ${response.status}）。`);
  }
  await response.body?.cancel();
}

export async function getNodeObject(
  node: StorageNode,
  storageKey: string,
  range: string | null,
): Promise<Response> {
  return signedNodeFetch(node, `/v1/objects/${base64UrlEncode(storageKey)}`, {
    method: "GET",
    headers: range ? { range } : undefined,
  });
}

export function nodeObjectResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of NODE_OBJECT_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export async function deleteNodeObjects(
  node: StorageNode,
  keys: string[],
): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += 1_000) {
    const response = await signedNodeFetch(node, "/v1/objects/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: keys.slice(offset, offset + 1_000) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`存储节点删除对象失败（HTTP ${response.status}）。`);
    }
    await response.body?.cancel();
  }
}

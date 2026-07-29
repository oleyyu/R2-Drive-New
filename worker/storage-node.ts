import {
  decodeBase64Url,
  isStorageNodeCapabilityTarget,
  STORAGE_CAPABILITY_TTL_SECONDS,
  StorageCapabilityConfigurationError,
  verifyStorageCapabilityRequest,
} from "../lib/storage-capability";

const MAX_KEY_BYTES = 1_024;
const MAX_UPLOAD_ID_BYTES = 1_024;
const MAX_CONTENT_TYPE_BYTES = 255;
const MAX_ACTOR_ID_BYTES = 128;
const MAX_CREATE_JSON_BYTES = 8 * 1_024;
const MAX_ACTION_JSON_BYTES = 4 * 1_024 * 1_024;
const MAX_DELETE_JSON_BYTES = 2 * 1_024 * 1_024;
const MAX_PART_BYTES = 5 * 1_024 ** 3 - 5 * 1_024 ** 2;
const MAX_PARTS = 10_000;
const MAX_DELETE_KEYS = 1_000;
const MAX_ETAG_BYTES = 512;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PART_ROUTE =
  /^\/v1\/multipart\/([^/]{1,1536})\/parts\/([1-9][0-9]{0,4})$/;
const ACTION_ROUTE =
  /^\/v1\/multipart\/([^/]{1,1536})\/(complete|abort)$/;
const OBJECT_ROUTE = /^\/v1\/objects\/([A-Za-z0-9_-]{1,1366})$/;

type JsonObject = Record<string, unknown>;

type UploadedPart = {
  partNumber: number;
  etag: string;
};

class NodeHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "NodeHttpError";
    this.status = status;
    this.code = code;
  }
}

function json(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function errorResponse(error: NodeHttpError): Response {
  const headers = new Headers();
  if (error.status === 401) {
    headers.set("www-authenticate", 'Signature realm="r2drive-storage-node"');
  }
  return json(
    { error: { code: error.code, message: error.message } },
    { status: error.status, headers },
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: JsonObject,
  required: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requiredRuntimeString(
  env: Env,
  name: string,
  maxBytes: number,
): string {
  const value: unknown = Reflect.get(env, name);
  if (
    typeof value !== "string" ||
    !value ||
    utf8Length(value) > maxBytes ||
    value.includes("\0")
  ) {
    throw new StorageCapabilityConfigurationError(
      `Storage node binding ${name} is invalid.`,
    );
  }
  return value;
}

function storageKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    utf8Length(value) > MAX_KEY_BYTES ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new NodeHttpError(400, "invalid_key", "存储对象 key 无效。");
  }
  return value;
}

function actorId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    utf8Length(value) > MAX_ACTOR_ID_BYTES ||
    !ACTOR_ID_PATTERN.test(value)
  ) {
    throw new NodeHttpError(400, "invalid_input", `${field} 无效。`);
  }
  return value;
}

function contentType(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    utf8Length(value) > MAX_CONTENT_TYPE_BYTES ||
    !/^[\x20-\x7E]+$/.test(value) ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new NodeHttpError(400, "invalid_input", "contentType 无效。");
  }
  return value;
}

function decodeUploadId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new NodeHttpError(400, "invalid_upload_id", "上传 ID 无效。");
  }
  if (
    !decoded ||
    utf8Length(decoded) > MAX_UPLOAD_ID_BYTES ||
    decoded.includes("\0") ||
    decoded.includes("\r") ||
    decoded.includes("\n")
  ) {
    throw new NodeHttpError(400, "invalid_upload_id", "上传 ID 无效。");
  }
  return decoded;
}

function requireJsonContentType(request: Request): void {
  const value = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(value)) {
    throw new NodeHttpError(
      415,
      "unsupported_media_type",
      "请求必须使用 application/json。",
    );
  }
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  requireJsonContentType(request);
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new NodeHttpError(413, "payload_too_large", "请求内容过大。");
  }
  if (!request.body) {
    throw new NodeHttpError(400, "invalid_json", "请求 JSON 为空。");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new NodeHttpError(413, "payload_too_large", "请求内容过大。");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NodeHttpError(400, "invalid_json", "请求 JSON 编码无效。");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NodeHttpError(400, "invalid_json", "请求 JSON 无效。");
  }
}

function parseCreateInput(value: unknown): {
  key: string;
  contentType: string;
  ownerId: string;
  fileId: string;
} {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["key", "contentType", "ownerId", "fileId"])
  ) {
    throw new NodeHttpError(400, "invalid_input", "创建上传参数无效。");
  }
  return {
    key: storageKey(value.key),
    contentType: contentType(value.contentType),
    ownerId: actorId(value.ownerId, "ownerId"),
    fileId: actorId(value.fileId, "fileId"),
  };
}

function parseAbortInput(value: unknown): {
  key: string;
  ownerId: string;
  fileId: string;
} {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["key", "ownerId", "fileId"])
  ) {
    throw new NodeHttpError(400, "invalid_input", "上传操作参数无效。");
  }
  return {
    key: storageKey(value.key),
    ownerId: actorId(value.ownerId, "ownerId"),
    fileId: actorId(value.fileId, "fileId"),
  };
}

function parseCompleteInput(value: unknown): {
  key: string;
  ownerId: string;
  fileId: string;
  expectedSize: number;
  parts: UploadedPart[];
} {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, [
      "key",
      "ownerId",
      "fileId",
      "expectedSize",
      "parts",
    ]) ||
    !Number.isSafeInteger(value.expectedSize) ||
    Number(value.expectedSize) < 1 ||
    !Array.isArray(value.parts) ||
    value.parts.length < 1 ||
    value.parts.length > MAX_PARTS
  ) {
    throw new NodeHttpError(400, "invalid_parts", "分片清单无效。");
  }

  const parts: UploadedPart[] = value.parts.map((part) => {
    if (
      !isJsonObject(part) ||
      !hasOnlyKeys(part, ["partNumber", "etag"]) ||
      !Number.isInteger(part.partNumber) ||
      Number(part.partNumber) < 1 ||
      Number(part.partNumber) > MAX_PARTS ||
      typeof part.etag !== "string" ||
      !part.etag ||
      utf8Length(part.etag) > MAX_ETAG_BYTES ||
      part.etag.includes("\0") ||
      part.etag.includes("\r") ||
      part.etag.includes("\n")
    ) {
      throw new NodeHttpError(400, "invalid_parts", "分片清单无效。");
    }
    return {
      partNumber: Number(part.partNumber),
      etag: part.etag,
    };
  });
  parts.sort((left, right) => left.partNumber - right.partNumber);
  if (parts.some((part, index) => part.partNumber !== index + 1)) {
    throw new NodeHttpError(
      400,
      "invalid_parts",
      "分片编号必须从 1 开始且连续。",
    );
  }
  return {
    key: storageKey(value.key),
    ownerId: actorId(value.ownerId, "ownerId"),
    fileId: actorId(value.fileId, "fileId"),
    expectedSize: Number(value.expectedSize),
    parts,
  };
}

function matchesCompletedObject(
  object: R2Object | null,
  input: {
    ownerId: string;
    fileId: string;
    expectedSize?: number;
  },
): object is R2Object {
  return Boolean(
    object &&
      object.customMetadata?.ownerId === input.ownerId &&
      object.customMetadata?.fileId === input.fileId &&
      (input.expectedSize === undefined || object.size === input.expectedSize),
  );
}

function parseDeleteInput(value: unknown): string[] {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["keys"]) ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > MAX_DELETE_KEYS
  ) {
    throw new NodeHttpError(400, "invalid_keys", "删除对象清单无效。");
  }
  const keys = value.keys.map(storageKey);
  if (new Set(keys).size !== keys.length) {
    throw new NodeHttpError(400, "invalid_keys", "删除对象 key 不得重复。");
  }
  return keys;
}

function validatePartBody(request: Request): ReadableStream {
  if (!request.body) {
    throw new NodeHttpError(400, "empty_part", "分片内容为空。");
  }
  const lengthValue = request.headers.get("content-length");
  if (lengthValue) {
    if (!/^[0-9]+$/.test(lengthValue)) {
      throw new NodeHttpError(400, "invalid_part", "分片长度无效。");
    }
    const length = Number(lengthValue);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_PART_BYTES) {
      throw new NodeHttpError(413, "invalid_part_size", "分片大小无效。");
    }
  }
  return request.body;
}

function validateRange(value: string | null): string | null {
  if (!value) return null;
  if (value.length > 128) {
    throw new NodeHttpError(416, "invalid_range", "Range 请求无效。");
  }
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) {
    throw new NodeHttpError(416, "invalid_range", "仅支持单段 Range 请求。");
  }
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if (
    (start !== null && !Number.isSafeInteger(start)) ||
    (end !== null && !Number.isSafeInteger(end)) ||
    (start === null && end === 0) ||
    (start !== null && end !== null && start > end)
  ) {
    throw new NodeHttpError(416, "invalid_range", "Range 请求无效。");
  }
  return value;
}

function decodeObjectKey(encoded: string): string {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(encoded, MAX_KEY_BYTES);
  } catch {
    throw new NodeHttpError(400, "invalid_key", "存储对象 key 无效。");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NodeHttpError(400, "invalid_key", "存储对象 key 无效。");
  }
  return storageKey(decoded);
}

function rangedResponse(object: R2ObjectBody): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  if (!object.range) {
    headers.set("content-length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }

  const suffix = "suffix" in object.range ? object.range.suffix : null;
  const offset =
    suffix === null
      ? "offset" in object.range
        ? object.range.offset ?? 0
        : 0
      : Math.max(object.size - suffix, 0);
  const length =
    suffix === null
      ? "length" in object.range
        ? object.range.length ?? object.size - offset
        : object.size - offset
      : Math.min(suffix, object.size);
  headers.set(
    "content-range",
    `bytes ${offset}-${offset + length - 1}/${object.size}`,
  );
  headers.set("content-length", String(length));
  return new Response(object.body, { status: 206, headers });
}

function reflectedNumber(error: unknown, name: string): number | null {
  if (typeof error !== "object" || error === null) return null;
  const value: unknown = Reflect.get(error, name);
  return typeof value === "number" ? value : null;
}

function reflectedString(error: unknown, name: string): string {
  if (typeof error !== "object" || error === null) return "";
  const value: unknown = Reflect.get(error, name);
  return typeof value === "string" ? value : "";
}

function mapStorageError(error: unknown): NodeHttpError {
  const code = reflectedNumber(error, "code");
  const name = reflectedString(error, "name");
  if (code === 10024 || name === "NoSuchUpload") {
    return new NodeHttpError(404, "upload_not_found", "上传任务不存在。");
  }
  if (code === 10007 || name === "NoSuchKey") {
    return new NodeHttpError(404, "object_not_found", "存储对象不存在。");
  }
  if (code === 10020 || name === "InvalidObjectName") {
    return new NodeHttpError(400, "invalid_key", "存储对象 key 无效。");
  }
  if (code === 10039 || name === "InvalidRange") {
    return new NodeHttpError(416, "invalid_range", "Range 请求无法满足。");
  }
  if (code === 10025 || code === 10048 || name === "InvalidPart") {
    return new NodeHttpError(409, "invalid_parts", "R2 拒绝了分片清单。");
  }
  if (code === 10011 || name === "EntityTooSmall") {
    return new NodeHttpError(400, "invalid_part_size", "R2 拒绝了分片大小。");
  }
  if (code === 100100 || name === "EntityTooLarge") {
    return new NodeHttpError(413, "invalid_part_size", "分片或对象过大。");
  }
  if (
    code === 10043 ||
    code === 10058 ||
    name === "ServiceUnavailable" ||
    name === "TooManyRequests"
  ) {
    return new NodeHttpError(503, "storage_busy", "存储节点繁忙，请稍后重试。");
  }
  return new NodeHttpError(502, "storage_failure", "存储节点操作失败。");
}

async function handleAuthorized(
  request: Request,
  env: Env,
  nodeId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/health") {
    return json({
      ok: true,
      nodeId,
      protocol: "r2drive-storage-node-v1",
      capabilityTtlSeconds: STORAGE_CAPABILITY_TTL_SECONDS,
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/multipart/create") {
    const input = parseCreateInput(
      await readBoundedJson(request, MAX_CREATE_JSON_BYTES),
    );
    const multipart = await env.FILES.createMultipartUpload(input.key, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: {
        ownerId: input.ownerId,
        fileId: input.fileId,
      },
    });
    return json({ uploadId: multipart.uploadId }, { status: 201 });
  }

  const partMatch = PART_ROUTE.exec(url.pathname);
  if (request.method === "PUT" && partMatch) {
    const uploadId = decodeUploadId(partMatch[1]);
    const partNumber = Number(partMatch[2]);
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > MAX_PARTS
    ) {
      throw new NodeHttpError(400, "invalid_part", "分片编号无效。");
    }
    const key = storageKey(url.searchParams.get("key"));
    const multipart = env.FILES.resumeMultipartUpload(key, uploadId);
    const part = await multipart.uploadPart(
      partNumber,
      validatePartBody(request),
    );
    return json({ partNumber: part.partNumber, etag: part.etag });
  }

  const actionMatch = ACTION_ROUTE.exec(url.pathname);
  if (request.method === "POST" && actionMatch) {
    const uploadId = decodeUploadId(actionMatch[1]);
    if (actionMatch[2] === "complete") {
      const input = parseCompleteInput(
        await readBoundedJson(request, MAX_ACTION_JSON_BYTES),
      );
      const multipart = env.FILES.resumeMultipartUpload(input.key, uploadId);
      let object: R2Object;
      try {
        object = await multipart.complete(input.parts);
      } catch (error) {
        const code = reflectedNumber(error, "code");
        const name = reflectedString(error, "name");
        if (code !== 10024 && name !== "NoSuchUpload") throw error;
        const completed = await env.FILES.head(input.key);
        if (!matchesCompletedObject(completed, input)) throw error;
        object = completed;
      }
      return json({ size: object.size, httpEtag: object.httpEtag });
    }
    const input = parseAbortInput(
      await readBoundedJson(request, MAX_CREATE_JSON_BYTES),
    );
    try {
      await env.FILES.resumeMultipartUpload(input.key, uploadId).abort();
    } catch (error) {
      const code = reflectedNumber(error, "code");
      const name = reflectedString(error, "name");
      if (code !== 10024 && name !== "NoSuchUpload") throw error;
      const completed = await env.FILES.head(input.key);
      if (matchesCompletedObject(completed, input)) {
        throw new NodeHttpError(
          409,
          "upload_already_completed",
          "上传已经完成，不能按未完成任务中止。",
        );
      }
    }
    return json({ ok: true });
  }

  const objectMatch = OBJECT_ROUTE.exec(url.pathname);
  if (request.method === "GET" && objectMatch) {
    const key = decodeObjectKey(objectMatch[1]);
    const range = validateRange(request.headers.get("range"));
    let object: R2ObjectBody | null;
    if (range) {
      const rangeHeaders = new Headers({ range });
      object = await env.FILES.get(key, { range: rangeHeaders });
    } else {
      object = await env.FILES.get(key);
    }
    if (!object) {
      throw new NodeHttpError(404, "object_not_found", "存储对象不存在。");
    }
    return rangedResponse(object);
  }

  if (request.method === "POST" && url.pathname === "/v1/objects/delete") {
    const keys = parseDeleteInput(
      await readBoundedJson(request, MAX_DELETE_JSON_BYTES),
    );
    await env.FILES.delete(keys);
    return json({ ok: true, deleted: keys.length });
  }

  throw new NodeHttpError(404, "not_found", "节点接口不存在。");
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathnameAndSearch = `${url.pathname}${url.search}`;
    if (!isStorageNodeCapabilityTarget(request.method, pathnameAndSearch)) {
      return errorResponse(
        new NodeHttpError(404, "not_found", "节点接口不存在。"),
      );
    }

    try {
      const nodeId = requiredRuntimeString(env, "NODE_ID", MAX_ACTOR_ID_BYTES);
      if (!ACTOR_ID_PATTERN.test(nodeId)) {
        throw new StorageCapabilityConfigurationError(
          "Storage node ID is invalid.",
        );
      }
      const publicKeyJwk = requiredRuntimeString(
        env,
        "CONTROL_PUBLIC_KEY_JWK",
        4 * 1_024,
      );
      const authorized = await verifyStorageCapabilityRequest(request, {
        nodeId,
        publicKeyJwk,
      });
      if (!authorized) {
        throw new NodeHttpError(
          401,
          "invalid_capability",
          "存储节点授权无效或已过期。",
        );
      }
      return await handleAuthorized(request, env, nodeId);
    } catch (error) {
      if (error instanceof NodeHttpError) return errorResponse(error);
      if (error instanceof StorageCapabilityConfigurationError) {
        console.error(
          JSON.stringify({
            event: "storage_node_misconfigured",
            path: url.pathname,
          }),
        );
        return errorResponse(
          new NodeHttpError(
            500,
            "node_misconfigured",
            "存储节点配置不完整。",
          ),
        );
      }

      const mapped = mapStorageError(error);
      console.error(
        JSON.stringify({
          event: "storage_node_operation_failed",
          path: url.pathname,
          errorName: reflectedString(error, "name") || "UnknownError",
          r2Code: reflectedNumber(error, "code"),
        }),
      );
      return errorResponse(mapped);
    }
  },
};

export default worker satisfies ExportedHandler<Env>;

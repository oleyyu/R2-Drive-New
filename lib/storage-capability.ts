import { env } from "cloudflare:workers";

export const STORAGE_CAPABILITY_VERSION = "2";
export const STORAGE_CAPABILITY_TTL_SECONDS = 60;

export const STORAGE_CAPABILITY_HEADERS = {
  version: "x-r2drive-capability-version",
  nodeId: "x-r2drive-node-id",
  timestamp: "x-r2drive-timestamp",
  nonce: "x-r2drive-nonce",
  bodySha256: "x-r2drive-body-sha256",
  signature: "x-r2drive-signature",
} as const;

const CANONICAL_PREFIX = "r2drive-storage-capability-v2";
const MAX_CANONICAL_PATH_BYTES = 8 * 1024;
const MAX_JWK_BYTES = 4 * 1024;
const MAX_RANGE_BYTES = 128;
const MAX_CREATE_JSON_BYTES = 8 * 1024;
const MAX_ACTION_JSON_BYTES = 4 * 1024 * 1024;
const MAX_DELETE_JSON_BYTES = 2 * 1024 * 1024;
const UNSIGNED_BODY = "UNSIGNED-PAYLOAD";
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HTTP_METHOD_PATTERN = /^(GET|POST|PUT)$/;
const PART_PATH_PATTERN =
  /^\/v1\/multipart\/([^/]{1,1536})\/parts\/([1-9][0-9]{0,4})$/;
const MULTIPART_ACTION_PATH_PATTERN =
  /^\/v1\/multipart\/([^/]{1,1536})\/(complete|abort)$/;
const OBJECT_PATH_PATTERN = /^\/v1\/objects\/([A-Za-z0-9_-]{1,1366})$/;

type JsonObject = Record<string, unknown>;

export type StorageNodeTarget = Readonly<{
  id: string;
  endpoint: string;
}>;

export type StorageCapabilityClaims = Readonly<{
  nodeId: string;
  method: string;
  pathnameAndSearch: string;
  timestamp: number;
  nonce: string;
  bodySha256: string;
  range: string;
}>;

export type StorageCapabilityVerificationOptions = Readonly<{
  nodeId: string;
  publicKeyJwk: string | JsonWebKey;
  nowSeconds?: number;
}>;

export class StorageCapabilityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageCapabilityConfigurationError";
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertNodeId(nodeId: string): void {
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new TypeError("Storage node ID is invalid.");
  }
}

function normalizeMethod(method: string | undefined): string {
  const normalized = (method || "GET").toUpperCase();
  if (!HTTP_METHOD_PATTERN.test(normalized)) {
    throw new TypeError("Storage node method is not supported.");
  }
  return normalized;
}

function assertCanonicalPath(pathnameAndSearch: string): void {
  if (
    !pathnameAndSearch.startsWith("/") ||
    pathnameAndSearch.includes("\n") ||
    pathnameAndSearch.includes("\r") ||
    utf8Length(pathnameAndSearch) > MAX_CANONICAL_PATH_BYTES
  ) {
    throw new TypeError("Storage node path is invalid.");
  }
}

function normalizeRange(value: string | null | undefined): string {
  const range = value || "";
  if (
    utf8Length(range) > MAX_RANGE_BYTES ||
    range.includes("\n") ||
    range.includes("\r")
  ) {
    throw new TypeError("Storage node Range is invalid.");
  }
  return range;
}

function assertBodySha256(value: string): void {
  if (value === UNSIGNED_BODY) return;
  const digest = decodeBase64Url(value, 32);
  if (digest.byteLength !== 32) {
    throw new TypeError("Storage capability body digest is invalid.");
  }
}

function postBodyLimit(pathnameAndSearch: string): number | null {
  let url: URL;
  try {
    url = new URL(pathnameAndSearch, "https://storage-node.invalid");
  } catch {
    return null;
  }
  if (url.pathname === "/v1/multipart/create") {
    return MAX_CREATE_JSON_BYTES;
  }
  const action = MULTIPART_ACTION_PATH_PATTERN.exec(url.pathname)?.[2];
  if (action === "complete") return MAX_ACTION_JSON_BYTES;
  if (action === "abort") return MAX_CREATE_JSON_BYTES;
  if (url.pathname === "/v1/objects/delete") {
    return MAX_DELETE_JSON_BYTES;
  }
  return null;
}

function canonicalRangeForTarget(
  method: string,
  pathnameAndSearch: string,
  value: string | null | undefined,
): string {
  const range = normalizeRange(value);
  if (!range) return "";
  let url: URL;
  try {
    url = new URL(pathnameAndSearch, "https://storage-node.invalid");
  } catch {
    throw new TypeError("Storage node path is invalid.");
  }
  if (method !== "GET" || !OBJECT_PATH_PATTERN.test(url.pathname)) {
    throw new TypeError("Storage node Range is not allowed for this route.");
  }
  return range;
}

function isExactQuery(url: URL, requiredName?: string): boolean {
  const names = [...url.searchParams.keys()];
  if (!requiredName) return names.length === 0;
  return (
    names.length === 1 &&
    names[0] === requiredName &&
    url.searchParams.getAll(requiredName).length === 1 &&
    Boolean(url.searchParams.get(requiredName))
  );
}

export function isStorageNodeCapabilityTarget(
  methodValue: string,
  pathnameAndSearch: string,
): boolean {
  let method: string;
  try {
    method = normalizeMethod(methodValue);
    assertCanonicalPath(pathnameAndSearch);
  } catch {
    return false;
  }

  let url: URL;
  try {
    url = new URL(pathnameAndSearch, "https://storage-node.invalid");
  } catch {
    return false;
  }
  if (
    url.origin !== "https://storage-node.invalid" ||
    url.hash ||
    `${url.pathname}${url.search}` !== pathnameAndSearch
  ) {
    return false;
  }

  if (method === "GET" && url.pathname === "/v1/health") {
    return isExactQuery(url);
  }
  if (method === "POST" && url.pathname === "/v1/multipart/create") {
    return isExactQuery(url);
  }
  if (method === "PUT" && PART_PATH_PATTERN.test(url.pathname)) {
    return isExactQuery(url, "key");
  }
  if (method === "POST" && MULTIPART_ACTION_PATH_PATTERN.test(url.pathname)) {
    return isExactQuery(url);
  }
  if (method === "GET" && OBJECT_PATH_PATTERN.test(url.pathname)) {
    return isExactQuery(url);
  }
  return (
    method === "POST" &&
    url.pathname === "/v1/objects/delete" &&
    isExactQuery(url)
  );
}

export function canonicalStorageCapability(
  claims: StorageCapabilityClaims,
): string {
  assertNodeId(claims.nodeId);
  const method = normalizeMethod(claims.method);
  assertCanonicalPath(claims.pathnameAndSearch);
  if (!Number.isSafeInteger(claims.timestamp) || claims.timestamp < 0) {
    throw new TypeError("Storage capability timestamp is invalid.");
  }
  const nonceBytes = decodeBase64Url(claims.nonce, 16);
  if (nonceBytes.byteLength !== 16) {
    throw new TypeError("Storage capability nonce is invalid.");
  }
  assertBodySha256(claims.bodySha256);
  const range = canonicalRangeForTarget(
    method,
    claims.pathnameAndSearch,
    claims.range,
  );
  if (method === "POST") {
    if (
      claims.bodySha256 === UNSIGNED_BODY ||
      postBodyLimit(claims.pathnameAndSearch) === null
    ) {
      throw new TypeError("Storage capability POST body digest is required.");
    }
  } else if (claims.bodySha256 !== UNSIGNED_BODY) {
    throw new TypeError("Storage capability body digest is not allowed.");
  }
  return [
    CANONICAL_PREFIX,
    claims.nodeId,
    method,
    claims.pathnameAndSearch,
    String(claims.timestamp),
    claims.nonce,
    claims.bodySha256,
    range,
  ].join("\n");
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeBase64Url(value: string, maxBytes: number): Uint8Array {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1 ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 2
  ) {
    throw new TypeError("Invalid base64url value.");
  }
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new TypeError("Invalid base64url value.");
  }
  if (decoded.length > maxBytes) {
    throw new TypeError("Invalid base64url value.");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  if (encodeBase64Url(bytes) !== value) {
    throw new TypeError("Invalid base64url value.");
  }
  return bytes;
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return encodeBase64Url(new Uint8Array(digest));
}

async function replayableBodyBytes(
  body: BodyInit | null | undefined,
): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array();
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
    return bytes;
  }
  throw new TypeError(
    "Storage capability POST body must be a replayable byte source.",
  );
}

async function signedBodySha256(
  method: string,
  pathnameAndSearch: string,
  body: BodyInit | null | undefined,
): Promise<string> {
  if (method !== "POST") return UNSIGNED_BODY;
  const limit = postBodyLimit(pathnameAndSearch);
  if (limit === null) {
    throw new TypeError("Storage node POST route is not allowed.");
  }
  const bytes = await replayableBodyBytes(body);
  if (bytes.byteLength > limit) {
    throw new TypeError("Storage node POST body is too large.");
  }
  return sha256Base64Url(bytes);
}

async function boundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    (!/^[0-9]+$/.test(declaredLength) ||
      Number(declaredLength) > maxBytes)
  ) {
    return null;
  }

  let body: ReadableStream<Uint8Array> | null;
  try {
    body = request.clone().body;
  } catch {
    return null;
  }
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJwk(value: string | JsonWebKey): JsonObject {
  if (typeof value !== "string") {
    if (!isJsonObject(value)) {
      throw new StorageCapabilityConfigurationError(
        "Storage capability JWK is invalid.",
      );
    }
    return value;
  }
  if (!value || utf8Length(value) > MAX_JWK_BYTES) {
    throw new StorageCapabilityConfigurationError(
      "Storage capability JWK is invalid.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isJsonObject(parsed)) {
      throw new Error("JWK must be an object.");
    }
    return parsed;
  } catch {
    throw new StorageCapabilityConfigurationError(
      "Storage capability JWK is invalid.",
    );
  }
}

function p256Coordinate(value: unknown): string {
  if (typeof value !== "string") {
    throw new StorageCapabilityConfigurationError(
      "Storage capability JWK is invalid.",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(value, 32);
  } catch {
    throw new StorageCapabilityConfigurationError(
      "Storage capability JWK is invalid.",
    );
  }
  if (bytes.byteLength !== 32) {
    throw new StorageCapabilityConfigurationError(
      "Storage capability JWK is invalid.",
    );
  }
  return value;
}

function privateP256Jwk(value: string | JsonWebKey): JsonWebKey {
  const parsed = parseJwk(value);
  if (
    parsed.kty !== "EC" ||
    parsed.crv !== "P-256" ||
    (parsed.alg !== undefined && parsed.alg !== "ES256")
  ) {
    throw new StorageCapabilityConfigurationError(
      "Storage capability private JWK must use P-256.",
    );
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: p256Coordinate(parsed.x),
    y: p256Coordinate(parsed.y),
    d: p256Coordinate(parsed.d),
    key_ops: ["sign"],
  };
}

function publicP256Jwk(value: string | JsonWebKey): JsonWebKey {
  const parsed = parseJwk(value);
  if (
    parsed.kty !== "EC" ||
    parsed.crv !== "P-256" ||
    parsed.d !== undefined ||
    (parsed.alg !== undefined && parsed.alg !== "ES256")
  ) {
    throw new StorageCapabilityConfigurationError(
      "Storage capability public JWK must use P-256.",
    );
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: p256Coordinate(parsed.x),
    y: p256Coordinate(parsed.y),
    key_ops: ["verify"],
  };
}

async function importPrivateKey(value: string | JsonWebKey): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      privateP256Jwk(value),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof StorageCapabilityConfigurationError) throw error;
    throw new StorageCapabilityConfigurationError(
      "Storage capability private JWK could not be imported.",
    );
  }
}

async function importPublicKey(value: string | JsonWebKey): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      publicP256Jwk(value),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (error) {
    if (error instanceof StorageCapabilityConfigurationError) throw error;
    throw new StorageCapabilityConfigurationError(
      "Storage capability public JWK could not be imported.",
    );
  }
}

export async function signStorageCapability(
  claims: StorageCapabilityClaims,
  privateKeyJwk: string | JsonWebKey,
): Promise<string> {
  const key = await importPrivateKey(privateKeyJwk);
  const canonical = canonicalStorageCapability(claims);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(canonical),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

function runtimeSecret(name: string): string {
  const value: unknown = Reflect.get(env, name);
  if (typeof value !== "string" || !value.trim()) {
    throw new StorageCapabilityConfigurationError(
      "Storage federation signing key is not configured.",
    );
  }
  return value;
}

function storageNodeUrl(node: StorageNodeTarget, path: string): URL {
  assertNodeId(node.id);
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("Storage node path must be origin-relative.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(node.endpoint);
  } catch {
    throw new TypeError("Storage node endpoint is invalid.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new TypeError("Storage node endpoint must be an HTTPS origin.");
  }

  const target = new URL(path, endpoint);
  if (target.origin !== endpoint.origin || target.hash) {
    throw new TypeError("Storage node target is invalid.");
  }
  const pathnameAndSearch = `${target.pathname}${target.search}`;
  assertCanonicalPath(pathnameAndSearch);
  return target;
}

export async function signedNodeFetch(
  node: StorageNodeTarget,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = normalizeMethod(init.method);
  const target = storageNodeUrl(node, path);
  const pathnameAndSearch = `${target.pathname}${target.search}`;
  if (!isStorageNodeCapabilityTarget(method, pathnameAndSearch)) {
    throw new TypeError("Storage node route is not allowed.");
  }
  if (init.redirect && init.redirect !== "manual") {
    throw new TypeError("Storage node redirects must not be followed.");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = encodeBase64Url(nonceBytes);
  const headers = new Headers(init.headers);
  const range = canonicalRangeForTarget(
    method,
    pathnameAndSearch,
    headers.get("range"),
  );
  const bodySha256 = await signedBodySha256(
    method,
    pathnameAndSearch,
    init.body,
  );
  const signature = await signStorageCapability(
    {
      nodeId: node.id,
      method,
      pathnameAndSearch,
      timestamp,
      nonce,
      bodySha256,
      range,
    },
    runtimeSecret("STORAGE_FEDERATION_PRIVATE_KEY"),
  );

  headers.set(STORAGE_CAPABILITY_HEADERS.version, STORAGE_CAPABILITY_VERSION);
  headers.set(STORAGE_CAPABILITY_HEADERS.nodeId, node.id);
  headers.set(STORAGE_CAPABILITY_HEADERS.timestamp, String(timestamp));
  headers.set(STORAGE_CAPABILITY_HEADERS.nonce, nonce);
  headers.set(STORAGE_CAPABILITY_HEADERS.bodySha256, bodySha256);
  headers.set(STORAGE_CAPABILITY_HEADERS.signature, signature);

  return fetch(target, {
    ...init,
    method,
    headers,
    redirect: "manual",
  });
}

function headerValue(headers: Headers, name: string, maxLength: number): string | null {
  const value = headers.get(name);
  return value && value.length <= maxLength ? value : null;
}

export async function verifyStorageCapabilityRequest(
  request: Request,
  options: StorageCapabilityVerificationOptions,
): Promise<boolean> {
  assertNodeId(options.nodeId);
  const url = new URL(request.url);
  const pathnameAndSearch = `${url.pathname}${url.search}`;
  if (!isStorageNodeCapabilityTarget(request.method, pathnameAndSearch)) {
    return false;
  }

  const version = headerValue(
    request.headers,
    STORAGE_CAPABILITY_HEADERS.version,
    8,
  );
  const suppliedNodeId = headerValue(
    request.headers,
    STORAGE_CAPABILITY_HEADERS.nodeId,
    128,
  );
  const timestampValue = headerValue(
    request.headers,
    STORAGE_CAPABILITY_HEADERS.timestamp,
    16,
  );
  const nonce = headerValue(
    request.headers,
    STORAGE_CAPABILITY_HEADERS.nonce,
    32,
  );
  const bodySha256 = headerValue(
    request.headers,
    STORAGE_CAPABILITY_HEADERS.bodySha256,
    64,
  );
  const signatureValue = headerValue(
    request.headers,
    STORAGE_CAPABILITY_HEADERS.signature,
    128,
  );
  if (
    version !== STORAGE_CAPABILITY_VERSION ||
    suppliedNodeId !== options.nodeId ||
    !timestampValue ||
    !/^(0|[1-9][0-9]{0,15})$/.test(timestampValue) ||
    !nonce ||
    !bodySha256 ||
    !signatureValue
  ) {
    return false;
  }

  const timestamp = Number(timestampValue);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(timestamp) ||
    !Number.isSafeInteger(nowSeconds) ||
    Math.abs(nowSeconds - timestamp) > STORAGE_CAPABILITY_TTL_SECONDS
  ) {
    return false;
  }

  let signature: Uint8Array;
  let range: string;
  try {
    if (decodeBase64Url(nonce, 16).byteLength !== 16) return false;
    assertBodySha256(bodySha256);
    range = canonicalRangeForTarget(
      request.method,
      pathnameAndSearch,
      request.headers.get("range"),
    );
    signature = decodeBase64Url(signatureValue, 64);
    if (signature.byteLength !== 64) return false;
  } catch {
    return false;
  }

  let canonical: string;
  try {
    canonical = canonicalStorageCapability({
      nodeId: options.nodeId,
      method: request.method,
      pathnameAndSearch,
      timestamp,
      nonce,
      bodySha256,
      range,
    });
  } catch {
    return false;
  }
  const publicKey = await importPublicKey(options.publicKeyJwk);
  const verificationSignature = new Uint8Array(signature.byteLength);
  verificationSignature.set(signature);
  const authorized = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    verificationSignature,
    new TextEncoder().encode(canonical),
  );
  if (!authorized) return false;

  if (request.method !== "POST") return true;
  const limit = postBodyLimit(pathnameAndSearch);
  if (limit === null || bodySha256 === UNSIGNED_BODY) return false;
  const body = await boundedRequestBody(request, limit);
  if (!body) return false;
  return (await sha256Base64Url(body)) === bodySha256;
}

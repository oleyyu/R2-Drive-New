import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const PRIMARY_OWNERSHIP_VERSION = 1;
export const PRIMARY_OWNERSHIP_PROTOCOL = "r2drive-primary-install-v1";
export const PRIMARY_BUCKET_PROTOCOL = "r2drive-primary-bucket-v1";
export const PRIMARY_WORKER_PROTOCOL = "r2drive-primary-worker-v1";
export const PRIMARY_WORKER_SECRET_NAME = "R2_DRIVE_INSTALL_SECRET";
export const PRIMARY_WORKER_ID_VAR = "R2_DRIVE_INSTALL_ID";
export const PRIMARY_WORKER_IDENTITY_PATH =
  "/.well-known/r2-drive/installation";

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const D1_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function assertResourceName(value, label) {
  if (typeof value !== "string" || !RESOURCE_NAME_PATTERN.test(value)) {
    throw new Error(`${label}无效，已停止资源归属操作。`);
  }
  return value;
}

function optionalDate(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new Error(`${label}无效，已停止资源归属操作。`);
  }
  return value;
}

function markerKeyFor(installId, suffix) {
  return `.r2-drive-installation/${installId}/${suffix}.json`;
}

export function createPrimaryOwnershipIntent({
  accountId,
  r2Name,
  now = new Date().toISOString(),
}) {
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("Cloudflare Account ID 无效，未创建主资源归属凭证。");
  }
  assertResourceName(r2Name, "主 R2 存储桶名称");
  const installId = randomUUID();
  return {
    version: PRIMARY_OWNERSHIP_VERSION,
    protocol: PRIMARY_OWNERSHIP_PROTOCOL,
    installId,
    accountId: accountId.toLowerCase(),
    r2Name,
    workerName: null,
    d1Id: null,
    bucketMarkerKey: markerKeyFor(
      installId,
      randomBytes(16).toString("hex"),
    ),
    bucketMarkerToken: randomBytes(32).toString("base64url"),
    workerIdentitySecret: randomBytes(32).toString("base64url"),
    managedBucket: null,
    bucketCreationDate: null,
    bucketMarkerVerifiedAt: null,
    workerIdentityVerifiedAt: null,
    legacyMigration: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function validatePrimaryOwnershipIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("本机主资源归属凭证无效，已停止以防误删。");
  }
  const installId = String(value.installId || "").toLowerCase();
  const accountId = String(value.accountId || "").toLowerCase();
  const r2Name = String(value.r2Name || "");
  const workerName =
    value.workerName === null || value.workerName === undefined
      ? null
      : String(value.workerName);
  const d1Id =
    value.d1Id === null || value.d1Id === undefined
      ? null
      : String(value.d1Id).toLowerCase();
  const expectedMarkerPrefix = `.r2-drive-installation/${installId}/`;
  const markerSuffix =
    typeof value.bucketMarkerKey === "string" &&
    value.bucketMarkerKey.startsWith(expectedMarkerPrefix)
      ? value.bucketMarkerKey.slice(expectedMarkerPrefix.length)
      : "";

  if (
    value.version !== PRIMARY_OWNERSHIP_VERSION ||
    value.protocol !== PRIMARY_OWNERSHIP_PROTOCOL ||
    !INSTALL_ID_PATTERN.test(installId) ||
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    !RESOURCE_NAME_PATTERN.test(r2Name) ||
    (workerName !== null && !RESOURCE_NAME_PATTERN.test(workerName)) ||
    (d1Id !== null && !D1_ID_PATTERN.test(d1Id)) ||
    !/^[a-f0-9]{32}\.json$/.test(markerSuffix) ||
    !TOKEN_PATTERN.test(String(value.bucketMarkerToken || "")) ||
    !TOKEN_PATTERN.test(String(value.workerIdentitySecret || "")) ||
    !(
      value.managedBucket === null ||
      value.managedBucket === true ||
      value.managedBucket === false
    ) ||
    typeof value.legacyMigration !== "boolean" ||
    typeof value.createdAt !== "string" ||
    !ISO_DATE_PATTERN.test(value.createdAt) ||
    typeof value.updatedAt !== "string" ||
    !ISO_DATE_PATTERN.test(value.updatedAt)
  ) {
    throw new Error("本机主资源归属凭证内容异常，已停止以防误删同名资源。");
  }

  return {
    version: PRIMARY_OWNERSHIP_VERSION,
    protocol: PRIMARY_OWNERSHIP_PROTOCOL,
    installId,
    accountId,
    r2Name,
    workerName,
    d1Id,
    bucketMarkerKey: value.bucketMarkerKey,
    bucketMarkerToken: value.bucketMarkerToken,
    workerIdentitySecret: value.workerIdentitySecret,
    managedBucket: value.managedBucket,
    bucketCreationDate: optionalDate(
      value.bucketCreationDate,
      "R2 创建时间",
    ),
    bucketMarkerVerifiedAt: optionalDate(
      value.bucketMarkerVerifiedAt,
      "R2 归属复核时间",
    ),
    workerIdentityVerifiedAt: optionalDate(
      value.workerIdentityVerifiedAt,
      "Worker 归属复核时间",
    ),
    legacyMigration: value.legacyMigration,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function setPrimaryBucketManagement(
  source,
  managedBucket,
  now = new Date().toISOString(),
) {
  const intent = validatePrimaryOwnershipIntent(source);
  if (typeof managedBucket !== "boolean") {
    throw new Error("主 R2 管理边界无效。");
  }
  if (
    intent.managedBucket !== null &&
    intent.managedBucket !== managedBucket
  ) {
    throw new Error(
      "主 R2 的创建/复用边界与本机原始记录不一致，已停止资源操作。",
    );
  }
  return validatePrimaryOwnershipIntent({
    ...intent,
    managedBucket,
    updatedAt: now,
  });
}

export function recordPrimaryBucketObservation(
  source,
  creationDate,
  now = new Date().toISOString(),
) {
  const intent = validatePrimaryOwnershipIntent(source);
  const observed = optionalDate(creationDate, "Wrangler R2 创建时间");
  if (!observed) {
    throw new Error(
      "Wrangler 没有返回 R2 创建时间，无法建立可防同名重建的归属凭证。",
    );
  }
  if (intent.bucketCreationDate && intent.bucketCreationDate !== observed) {
    throw new Error(
      "主 R2 存储桶的创建时间已变化，可能发生同名重建；未继续连接或写入标记。",
    );
  }
  return validatePrimaryOwnershipIntent({
    ...intent,
    bucketCreationDate: observed,
    updatedAt: now,
  });
}

export function bindPrimaryOwnershipIntent(
  source,
  { accountId, r2Name, workerName, d1Id, now = new Date().toISOString() },
) {
  const intent = validatePrimaryOwnershipIntent(source);
  const normalizedAccount = String(accountId || "").toLowerCase();
  const normalizedD1 = String(d1Id || "").toLowerCase();
  if (
    normalizedAccount !== intent.accountId ||
    r2Name !== intent.r2Name ||
    (intent.workerName && intent.workerName !== workerName) ||
    (intent.d1Id && intent.d1Id !== normalizedD1)
  ) {
    throw new Error(
      "本机已有另一套主资源归属凭证。为避免覆盖或认领同名 Cloudflare 资源，已停止配置。",
    );
  }
  assertResourceName(workerName, "主 Worker 名称");
  if (!D1_ID_PATTERN.test(normalizedD1)) {
    throw new Error("D1 database_id 无效，未绑定主资源归属凭证。");
  }
  return validatePrimaryOwnershipIntent({
    ...intent,
    workerName,
    d1Id: normalizedD1,
    updatedAt: now,
  });
}

export async function readPrimaryOwnershipIntent(filePath, options = {}) {
  try {
    return validatePrimaryOwnershipIntent(
      JSON.parse(await readFile(filePath, "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT" && options.allowMissing === true) return null;
    if (error instanceof SyntaxError) {
      throw new Error("本机主资源归属凭证不是有效 JSON，已停止以防误删。");
    }
    throw error;
  }
}

export async function writePrimaryOwnershipIntent(filePath, source) {
  const intent = validatePrimaryOwnershipIntent({
    ...source,
    updatedAt: new Date().toISOString(),
  });
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
  return intent;
}

export async function ensurePrimaryOwnershipIntent(
  filePath,
  { accountId, r2Name },
) {
  const existing = await readPrimaryOwnershipIntent(filePath, {
    allowMissing: true,
  });
  if (existing) {
    if (
      existing.accountId !== String(accountId).toLowerCase() ||
      existing.r2Name !== r2Name
    ) {
      throw new Error(
        "本机已有另一套主 R2 归属凭证。请先完成或人工处理原实例，不能按名称覆盖。",
      );
    }
    return existing;
  }
  return writePrimaryOwnershipIntent(
    filePath,
    createPrimaryOwnershipIntent({ accountId, r2Name }),
  );
}

export function primaryBucketOwnershipBody(source) {
  const intent = validatePrimaryOwnershipIntent(source);
  return `${JSON.stringify({
    protocol: PRIMARY_BUCKET_PROTOCOL,
    installId: intent.installId,
    accountId: intent.accountId,
    bucketName: intent.r2Name,
    token: intent.bucketMarkerToken,
  })}\n`;
}

export function assertPrimaryBucketOwnership(source, markerBody) {
  const expected = Buffer.from(primaryBucketOwnershipBody(source), "utf8");
  const actual = Buffer.from(String(markerBody), "utf8");
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error(
      "主 R2 存储桶归属标记缺失或不匹配；它可能已被同名重建，未执行任何删除。",
    );
  }
}

export function createPrimaryWorkerChallenge() {
  return randomBytes(32).toString("base64url");
}

export function primaryWorkerProofMessage(installId, challenge) {
  if (!INSTALL_ID_PATTERN.test(String(installId))) {
    throw new Error("主安装 ID 无效。");
  }
  if (!TOKEN_PATTERN.test(String(challenge))) {
    throw new Error("主 Worker 身份挑战无效。");
  }
  return `${PRIMARY_WORKER_PROTOCOL}\n${String(installId).toLowerCase()}\n${challenge}`;
}

export function createPrimaryWorkerProof(secret, installId, challenge) {
  if (!TOKEN_PATTERN.test(String(secret))) {
    throw new Error("主 Worker 身份密钥无效。");
  }
  return createHmac("sha256", secret)
    .update(primaryWorkerProofMessage(installId, challenge))
    .digest("base64url");
}

export function assertPrimaryWorkerOwnership(source, challenge, response) {
  const intent = validatePrimaryOwnershipIntent(source);
  const proof = createPrimaryWorkerProof(
    intent.workerIdentitySecret,
    intent.installId,
    challenge,
  );
  const expected = Buffer.from(proof, "utf8");
  const actual = Buffer.from(String(response?.proof || ""), "utf8");
  if (
    response?.ok !== true ||
    response?.protocol !== PRIMARY_WORKER_PROTOCOL ||
    response?.installId !== intent.installId ||
    response?.challenge !== challenge ||
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error(
      "主 Worker 身份响应不匹配；它可能已被同名重建，未执行任何删除。",
    );
  }
}

function bindingName(binding) {
  return String(binding?.name ?? binding?.binding ?? "");
}

export function assertLegacyWorkerVersionBindings(
  version,
  { d1Id, r2Name },
) {
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("Wrangler 未返回可验证的 Worker bindings，不能迁移旧版归属。");
  }
  const d1 = bindings.filter(
    (binding) => binding?.type === "d1" && bindingName(binding) === "DB",
  );
  const r2 = bindings.filter(
    (binding) =>
      binding?.type === "r2_bucket" && bindingName(binding) === "FILES",
  );
  const remoteD1 = String(
    d1[0]?.id ?? d1[0]?.database_id ?? d1[0]?.databaseId ?? "",
  ).toLowerCase();
  const remoteR2 = String(
    r2[0]?.bucket_name ?? r2[0]?.bucketName ?? r2[0]?.bucket ?? "",
  );
  if (
    d1.length !== 1 ||
    r2.length !== 1 ||
    remoteD1 !== String(d1Id).toLowerCase() ||
    remoteR2 !== r2Name
  ) {
    throw new Error(
      "线上 Worker 的 exact D1/R2 binding 与本机实例不一致，不能迁移旧版归属。",
    );
  }
  return true;
}

export function assertWorkerVersionInstallationBinding(version, installId) {
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("Wrangler 未返回可验证的 Worker bindings。");
  }
  const identity = bindings.filter(
    (binding) =>
      binding?.type === "plain_text" &&
      bindingName(binding) === PRIMARY_WORKER_ID_VAR,
  );
  const remoteId = String(
    identity[0]?.text ?? identity[0]?.value ?? identity[0]?.plain_text ?? "",
  ).toLowerCase();
  if (identity.length !== 1 || remoteId !== String(installId).toLowerCase()) {
    throw new Error(
      "线上 Worker 不含本机随机安装 ID；它可能是同名资源，已停止发布或删除。",
    );
  }
  return true;
}

function normalizedEtag(value) {
  return String(value ?? "")
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"|"$/g, "");
}

export function assertLegacyBucketEvidence({
  samples,
  objects,
  bucketCreationDate,
  databaseCreationDate,
  clockSkewMs = 5 * 60 * 1_000,
}) {
  const sourceSamples = Array.isArray(samples) ? samples : [];
  const sourceObjects = Array.isArray(objects) ? objects : [];
  for (const sample of sourceSamples) {
    const key = String(sample?.storage_key ?? sample?.storageKey ?? "");
    const size = Number(sample?.size);
    const etag = normalizedEtag(sample?.etag);
    if (!key || !Number.isSafeInteger(size) || size < 0 || !etag) continue;
    const match = sourceObjects.find(
      (object) =>
        String(object?.key ?? "") === key &&
        Number(object?.size) === size &&
        normalizedEtag(object?.etag) === etag,
    );
    if (match) return { kind: "ready-object", key };
  }

  if (sourceSamples.length > 0) {
    throw new Error(
      "exact D1 中的 ready 文件与当前主 R2 对象不一致，不能认领或迁移该桶。",
    );
  }
  const bucketTime = Date.parse(String(bucketCreationDate ?? ""));
  const databaseTime = Date.parse(String(databaseCreationDate ?? ""));
  if (
    !Number.isFinite(bucketTime) ||
    !Number.isFinite(databaseTime) ||
    bucketTime > databaseTime + clockSkewMs
  ) {
    throw new Error(
      "空的旧版主 R2 缺少足够的创建时间证据，可能已被同名重建；未写入归属标记。",
    );
  }
  return { kind: "creation-order" };
}

export function primaryProvisioningCleanupPlan(source) {
  const intent = validatePrimaryOwnershipIntent(source);
  if (
    intent.workerName !== null ||
    intent.d1Id !== null ||
    typeof intent.managedBucket !== "boolean"
  ) {
    throw new Error(
      "该归属凭证已进入 Worker/D1 配置阶段，不能按仅 R2 的中断流程清理。",
    );
  }
  return {
    accountId: intent.accountId,
    bucketName: intent.r2Name,
    deleteBucket: intent.managedBucket,
    markerKey: intent.bucketMarkerKey,
  };
}

export function r2ObjectsFromApiPayload(payload) {
  return Array.isArray(payload?.result) ? payload.result : [];
}

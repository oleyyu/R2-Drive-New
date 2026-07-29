// Temporary Worker deployed by the uninstaller to abort leftover multipart
// uploads and delete ordinary objects through an R2 binding. R2 refuses to
// delete a bucket while either kind of data remains.
//
// It runs from a cron trigger rather than an HTTP request on purpose: reaching
// a Worker over HTTP needs workers.dev or a custom domain, and `wrangler dev`
// needs a direct connection to Cloudflare's edge preview. Both are unreachable
// on networks that only allow api.cloudflare.com through a proxy. A cron
// trigger runs entirely on the edge, so the uninstaller only has to deploy the
// Worker and poll a short-lived completion marker with Wrangler.

const ABORT_CONCURRENCY = 20;
const DELETE_BATCH_SIZE = 1_000;
const UUID_PREFIX_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/i;
const PROTECTED_KEY_PATTERN =
  /^(?:\.r2-drive-storage-node\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\.r2-drive-installation\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/[a-f0-9]{32}\.json$/i;
const HELPER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BUCKET_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingMultipartUpload(error) {
  return /NoSuchUpload|does not exist|not found|10024/i.test(errorMessage(error));
}

function isRetryableMultipartError(error) {
  return /Unspecified error|\(0\)|InternalError|ServiceUnavailable|TooManyRequests|10001|10043|10058|429|500|503/i.test(
    errorMessage(error),
  );
}

function readUploads(value, strict = false) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    return strict ? null : [];
  }
  if (!Array.isArray(parsed)) return strict ? null : [];
  const uploads = parsed.filter(
    (upload) =>
      upload &&
      typeof upload.storageKey === "string" &&
      typeof upload.uploadId === "string" &&
      upload.storageKey.length > 0 &&
      upload.uploadId.length > 0 &&
      upload.storageKey.length <= 1_024 &&
      upload.uploadId.length <= 1_024 &&
      !/[\u0000\r\n]/.test(upload.storageKey) &&
      !/[\u0000\r\n]/.test(upload.uploadId),
  );
  return strict && uploads.length !== parsed.length ? null : uploads;
}

function readPrefixes(value) {
  if (value === undefined || value === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const prefixes = parsed.filter(
    (prefix) =>
      typeof prefix === "string" &&
      UUID_PREFIX_PATTERN.test(prefix),
  );
  if (prefixes.length !== parsed.length) return null;
  return [...new Set(prefixes.map((prefix) => prefix.toLowerCase()))];
}

function readProtectedKeys(value, purgeAll) {
  if (value === undefined || value === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 2 ||
    (!purgeAll && parsed.length > 0)
  ) {
    return null;
  }
  const protectedKeys = parsed.filter(
    (key) => typeof key === "string" && PROTECTED_KEY_PATTERN.test(key),
  );
  if (protectedKeys.length !== parsed.length) return null;
  return [...new Set(protectedKeys)];
}

function markerSettings(env, purgeAll, prefixes) {
  const key =
    typeof env.PURGE_MARKER_KEY === "string" ? env.PURGE_MARKER_KEY : "";
  const value =
    typeof env.PURGE_MARKER_VALUE === "string"
      ? env.PURGE_MARKER_VALUE
      : "";
  if (!key && !value) return null;
  if (
    !key ||
    !value ||
    key.length > 1_024 ||
    value.length > 256 ||
    /[\u0000\r\n]/.test(key) ||
    /[\u0000\r\n]/.test(value) ||
    (!purgeAll && !prefixes.some((prefix) => key.startsWith(prefix)))
  ) {
    throw new Error("Invalid purge completion marker.");
  }
  return { key, value, lockKey: `${key}.lock` };
}

function validateHelperIdentity(env, marker) {
  if (!marker) return;
  const token =
    typeof env.PURGE_HELPER_TOKEN === "string"
      ? env.PURGE_HELPER_TOKEN
      : "";
  const bucketName =
    typeof env.PURGE_EXPECTED_BUCKET === "string"
      ? env.PURGE_EXPECTED_BUCKET
      : "";
  const planHash =
    typeof env.PURGE_PLAN_HASH === "string" ? env.PURGE_PLAN_HASH : "";
  if (
    !HELPER_TOKEN_PATTERN.test(token) ||
    token !== marker.value ||
    !BUCKET_NAME_PATTERN.test(bucketName) ||
    !PLAN_HASH_PATTERN.test(planHash)
  ) {
    throw new Error("Invalid purge helper identity.");
  }
}

async function abortMultipartUpload(bucket, storageKey, uploadId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await bucket.resumeMultipartUpload(storageKey, uploadId).abort();
      return "aborted";
    } catch (error) {
      if (isMissingMultipartUpload(error)) return "missing";
      if (!isRetryableMultipartError(error) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  return "missing";
}

export async function abortMultipartUploads(bucket, uploads) {
  let aborted = 0;
  let alreadyMissing = 0;
  let failed = 0;
  for (let index = 0; index < uploads.length; index += ABORT_CONCURRENCY) {
    const batch = uploads.slice(index, index + ABORT_CONCURRENCY);
    const results = await Promise.all(
      batch.map(({ storageKey, uploadId }) =>
        // One unabortable upload must not strand the rest of the bucket; the
        // uninstaller reports whatever is still listed once this finishes.
        abortMultipartUpload(bucket, storageKey, uploadId).catch(() => "failed"),
      ),
    );
    aborted += results.filter((result) => result === "aborted").length;
    alreadyMissing += results.filter((result) => result === "missing").length;
    failed += results.filter((result) => result === "failed").length;
  }
  return { aborted, alreadyMissing, failed };
}

async function deleteObjectBatch(bucket, keys) {
  if (keys.length === 1) {
    await bucket.delete(keys[0]);
    return;
  }
  await bucket.delete(keys);
}

export async function purgeObjects(bucket, options) {
  const prefixes = options.purgeAll ? [null] : options.prefixes;
  const protectedKeys = new Set(options.protectedKeys ?? []);
  let deleted = 0;
  for (const prefix of prefixes) {
    while (true) {
      const listed = await bucket.list(
        prefix === null
          ? { limit: DELETE_BATCH_SIZE }
          : { prefix, limit: DELETE_BATCH_SIZE },
      );
      const keys = Array.isArray(listed?.objects)
        ? listed.objects
            .map((object) => object?.key)
            .filter(
              (key) =>
                typeof key === "string" &&
                !protectedKeys.has(key) &&
                (prefix === null || key.startsWith(prefix)),
            )
        : [];
      if (keys.length === 0) break;
      await deleteObjectBatch(bucket, keys);
      deleted += keys.length;
    }
  }
  return deleted;
}

const purgeWorker = {
  async scheduled(event, env) {
    const purgeAll = env.PURGE_ALL === "true";
    const prefixes = readPrefixes(env.PURGE_PREFIXES);
    const protectedKeys = readProtectedKeys(
      env.PURGE_PROTECTED_KEYS,
      purgeAll,
    );
    const marker = markerSettings(env, purgeAll, prefixes ?? []);
    validateHelperIdentity(env, marker);
    if (prefixes === null || protectedKeys === null) {
      if (marker) throw new Error("Invalid purge scope.");
      return;
    }
    const uploads = readUploads(env.PURGE_UPLOADS, Boolean(marker));
    if (uploads === null) {
      throw new Error("Invalid multipart upload list.");
    }
    let lockAcquired = false;
    if (marker) {
      const lock = await env.FILES.put(marker.lockKey, marker.value, {
        onlyIf: new Headers({ "if-none-match": "*" }),
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
      if (lock === null) return;
      lockAcquired = true;
    }
    try {
      const abortResult = await abortMultipartUploads(env.FILES, uploads);
      if (marker && abortResult.failed > 0) {
        throw new Error("One or more multipart uploads could not be aborted.");
      }
      if (purgeAll || prefixes.length > 0) {
        await purgeObjects(env.FILES, {
          purgeAll,
          prefixes,
          protectedKeys: [
            ...(marker ? [marker.key, marker.lockKey] : []),
            ...protectedKeys,
          ],
        });
      }
      if (marker) {
        await env.FILES.put(marker.key, marker.value, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
      }
    } catch (error) {
      if (lockAcquired && marker) {
        await env.FILES.delete(marker.lockKey).catch(() => undefined);
      }
      throw error;
    }
  },
};

export default purgeWorker;

// Temporary Worker deployed by the uninstaller to abort leftover multipart
// uploads. R2 refuses to delete a bucket while they exist, and neither the
// Cloudflare REST API nor Wrangler can abort one — only an R2 binding can.
//
// It runs from a cron trigger rather than an HTTP request on purpose: reaching
// a Worker over HTTP needs workers.dev or a custom domain, and `wrangler dev`
// needs a direct connection to Cloudflare's edge preview. Both are unreachable
// on networks that only allow api.cloudflare.com through a proxy. A cron
// trigger runs entirely on the edge, so the uninstaller only has to deploy the
// Worker and watch the bucket drain through the REST API.

const ABORT_CONCURRENCY = 20;

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

function readUploads(value) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (upload) =>
      upload &&
      typeof upload.storageKey === "string" &&
      typeof upload.uploadId === "string" &&
      upload.storageKey.length > 0 &&
      upload.uploadId.length > 0,
  );
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

const purgeWorker = {
  async scheduled(event, env) {
    await abortMultipartUploads(env.FILES, readUploads(env.PURGE_UPLOADS));
  },
};

export default purgeWorker;

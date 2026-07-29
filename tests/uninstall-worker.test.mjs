import assert from "node:assert/strict";
import test from "node:test";
import purgeWorker from "../scripts/uninstall-worker.mjs";

function fakeBucket() {
  const aborted = [];
  const abortAttempts = new Map();
  return {
    aborted,
    abortAttempts,
    resumeMultipartUpload(storageKey, uploadId) {
      return {
        async abort() {
          if (uploadId === "already-missing") {
            throw new Error("NoSuchUpload: code 10024");
          }
          if (uploadId === "never-works") {
            throw new Error("AccessDenied: not permitted");
          }
          const attempts = (abortAttempts.get(uploadId) || 0) + 1;
          abortAttempts.set(uploadId, attempts);
          if (attempts === 1) {
            throw new Error("abortMultipartUpload: Unspecified error (0)");
          }
          aborted.push([storageKey, uploadId]);
        },
      };
    },
  };
}

test("scheduled run aborts every leftover multipart upload, retrying transient errors", async () => {
  const bucket = fakeBucket();

  await purgeWorker.scheduled(
    { cron: "* * * * *" },
    {
      FILES: bucket,
      PURGE_UPLOADS: JSON.stringify([
        { storageKey: "unfinished.bin", uploadId: "active-upload" },
        { storageKey: "old.bin", uploadId: "already-missing" },
      ]),
    },
  );

  assert.deepEqual(bucket.aborted, [["unfinished.bin", "active-upload"]]);
  assert.equal(bucket.abortAttempts.get("active-upload"), 2);
});

test("one unabortable upload does not strand the rest of the bucket", async () => {
  const bucket = fakeBucket();

  await purgeWorker.scheduled(
    { cron: "* * * * *" },
    {
      FILES: bucket,
      PURGE_UPLOADS: JSON.stringify([
        { storageKey: "blocked.bin", uploadId: "never-works" },
        { storageKey: "unfinished.bin", uploadId: "active-upload" },
      ]),
    },
  );

  assert.deepEqual(bucket.aborted, [["unfinished.bin", "active-upload"]]);
});

test("a malformed or missing upload list is ignored instead of throwing", async () => {
  const bucket = fakeBucket();

  for (const PURGE_UPLOADS of [
    undefined,
    "",
    "not json",
    JSON.stringify({ uploads: [] }),
    JSON.stringify([{ storageKey: "", uploadId: "" }, null, { storageKey: "a" }]),
  ]) {
    await purgeWorker.scheduled({ cron: "* * * * *" }, { FILES: bucket, PURGE_UPLOADS });
  }

  assert.deepEqual(bucket.aborted, []);
});

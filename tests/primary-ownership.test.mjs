import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertPrimaryOwnershipMatchesInstance,
} from "../scripts/launcher.mjs";
import {
  assertLegacyBucketEvidence,
  assertLegacyWorkerVersionBindings,
  assertPrimaryBucketOwnership,
  assertPrimaryWorkerOwnership,
  assertWorkerVersionInstallationBinding,
  bindPrimaryOwnershipIntent,
  createPrimaryOwnershipIntent,
  createPrimaryWorkerChallenge,
  createPrimaryWorkerProof,
  ensurePrimaryOwnershipIntent,
  PRIMARY_WORKER_ID_VAR,
  primaryBucketOwnershipBody,
  primaryProvisioningCleanupPlan,
  readPrimaryOwnershipIntent,
  recordPrimaryBucketObservation,
  r2ObjectsFromApiPayload,
  setPrimaryBucketManagement,
  writePrimaryOwnershipIntent,
} from "../scripts/primary-ownership.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountId = "a".repeat(32);
const d1Id = "123e4567-e89b-42d3-a456-426614174000";

function boundIntent() {
  let intent = createPrimaryOwnershipIntent({
    accountId,
    r2Name: "r2-drive-files",
    now: "2026-07-29T01:00:00.000Z",
  });
  intent = setPrimaryBucketManagement(
    intent,
    true,
    "2026-07-29T01:00:01.000Z",
  );
  intent = recordPrimaryBucketObservation(
    intent,
    "2026-07-29T00:59:59.000Z",
    "2026-07-29T01:00:02.000Z",
  );
  return bindPrimaryOwnershipIntent(intent, {
    accountId,
    r2Name: "r2-drive-files",
    workerName: "r2-drive",
    d1Id,
    now: "2026-07-29T01:00:03.000Z",
  });
}

function workerVersion(intent, overrides = {}) {
  return {
    resources: {
      bindings: [
        { type: "d1", name: "DB", id: d1Id },
        {
          type: "r2_bucket",
          name: "FILES",
          bucket_name: "r2-drive-files",
        },
        {
          type: "plain_text",
          name: PRIMARY_WORKER_ID_VAR,
          text: intent.installId,
        },
      ],
    },
    ...overrides,
  };
}

test("primary intent is private, stable across retry, and binds exact resources", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "r2drive-primary-"));
  const filePath = path.join(workspace, ".wrangler", "primary-ownership.json");
  try {
    const first = await ensurePrimaryOwnershipIntent(filePath, {
      accountId,
      r2Name: "r2-drive-files",
    });
    const retry = await ensurePrimaryOwnershipIntent(filePath, {
      accountId,
      r2Name: "r2-drive-files",
    });
    assert.deepEqual(retry, first);
    assert.equal(first.managedBucket, null);
    assert.match(first.bucketMarkerToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(first.workerIdentitySecret, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.bucketMarkerToken, first.workerIdentitySecret);
    await assert.rejects(() =>
      ensurePrimaryOwnershipIntent(filePath, {
        accountId,
        r2Name: "different-bucket",
      }),
    );

    let managed = setPrimaryBucketManagement(first, true);
    managed = recordPrimaryBucketObservation(
      managed,
      "2026-07-29T01:00:00.000Z",
    );
    managed = bindPrimaryOwnershipIntent(managed, {
      accountId,
      r2Name: "r2-drive-files",
      workerName: "r2-drive",
      d1Id,
    });
    await writePrimaryOwnershipIntent(filePath, managed);
    const stored = await readPrimaryOwnershipIntent(filePath);
    assert.equal(stored.managedBucket, true);
    assert.equal(stored.d1Id, d1Id);
    assert.equal((await stat(filePath)).mode & 0o077, 0);
    assert.throws(() =>
      recordPrimaryBucketObservation(
        stored,
        "2026-07-29T01:00:01.000Z",
      ),
    );
    assert.throws(() => setPrimaryBucketManagement(stored, false));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("interrupted setup deletes only a created bucket and preserves a reused bucket", () => {
  const pending = createPrimaryOwnershipIntent({
    accountId,
    r2Name: "r2-drive-files",
  });
  assert.deepEqual(
    primaryProvisioningCleanupPlan(
      setPrimaryBucketManagement(pending, true),
    ),
    {
      accountId,
      bucketName: "r2-drive-files",
      deleteBucket: true,
      markerKey: pending.bucketMarkerKey,
    },
  );
  assert.equal(
    primaryProvisioningCleanupPlan(
      setPrimaryBucketManagement(pending, false),
    ).deleteBucket,
    false,
  );
  assert.throws(() => primaryProvisioningCleanupPlan(boundIntent()));
});

test("primary R2 marker and Worker challenge reject same-name replacements", async () => {
  const intent = boundIntent();
  const marker = primaryBucketOwnershipBody(intent);
  assert.doesNotThrow(() => assertPrimaryBucketOwnership(intent, marker));
  assert.throws(
    () =>
      assertPrimaryBucketOwnership(
        { ...intent, bucketMarkerToken: "B".repeat(43) },
        marker,
      ),
    /同名重建/,
  );
  assert.doesNotThrow(() =>
    assertPrimaryOwnershipMatchesInstance(intent, {
      accountId,
      r2Name: "r2-drive-files",
      workerName: "r2-drive",
      d1Id,
    }),
  );
  assert.throws(() =>
    assertPrimaryOwnershipMatchesInstance(intent, {
      accountId,
      r2Name: "r2-drive-files",
      workerName: "same-name-recreated",
      d1Id,
    }),
  );

  const challenge = createPrimaryWorkerChallenge();
  const response = {
    ok: true,
    protocol: "r2drive-primary-worker-v1",
    installId: intent.installId,
    challenge,
    proof: createPrimaryWorkerProof(
      intent.workerIdentitySecret,
      intent.installId,
      challenge,
    ),
  };
  assert.doesNotThrow(() =>
    assertPrimaryWorkerOwnership(intent, challenge, response),
  );
  const runtimeKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(intent.workerIdentitySecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const runtimeSignature = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      runtimeKey,
      new TextEncoder().encode(
        `r2drive-primary-worker-v1\n${intent.installId}\n${challenge}`,
      ),
    ),
  ).toString("base64url");
  assert.equal(runtimeSignature, response.proof);
  assert.throws(
    () =>
      assertPrimaryWorkerOwnership(intent, challenge, {
        ...response,
        proof: "B".repeat(43),
      }),
    /同名重建/,
  );
});

test("legacy Worker migration requires exact DB/R2 bindings and install retry ID", () => {
  const intent = boundIntent();
  const version = workerVersion(intent);
  assert.doesNotThrow(() =>
    assertLegacyWorkerVersionBindings(version, {
      d1Id,
      r2Name: "r2-drive-files",
    }),
  );
  assert.doesNotThrow(() =>
    assertWorkerVersionInstallationBinding(version, intent.installId),
  );
  assert.throws(() =>
    assertLegacyWorkerVersionBindings(
      workerVersion(intent, {
        resources: {
          bindings: [
            { type: "d1", name: "DB", id: d1Id },
            {
              type: "r2_bucket",
              name: "FILES",
              bucket_name: "same-name-recreated",
            },
          ],
        },
      }),
      { d1Id, r2Name: "r2-drive-files" },
    ),
  );
  assert.throws(() =>
    assertWorkerVersionInstallationBinding(
      workerVersion(intent, {
        resources: {
          bindings: workerVersion(intent).resources.bindings.filter(
            (binding) => binding.name !== PRIMARY_WORKER_ID_VAR,
          ),
        },
      }),
      intent.installId,
    ),
  );
});

test("legacy R2 migration needs an exact ready object or safe creation order", () => {
  const sample = {
    storage_key: "owner/file/blob",
    size: 123,
    etag: '"abc123"',
  };
  assert.deepEqual(
    assertLegacyBucketEvidence({
      samples: [sample],
      objects: [{ key: sample.storage_key, size: 123, etag: "abc123" }],
    }),
    { kind: "ready-object", key: sample.storage_key },
  );
  assert.throws(() =>
    assertLegacyBucketEvidence({
      samples: [sample],
      objects: [{ key: sample.storage_key, size: 124, etag: "abc123" }],
    }),
  );
  const listedObjects = [{ key: "owner/file/blob", size: 123 }];
  assert.equal(
    r2ObjectsFromApiPayload({ result: listedObjects }),
    listedObjects,
  );
  assert.deepEqual(
    r2ObjectsFromApiPayload({ result: { objects: listedObjects } }),
    [],
  );
  assert.deepEqual(
    assertLegacyBucketEvidence({
      samples: [],
      objects: [],
      bucketCreationDate: "2026-07-29T00:00:00.000Z",
      databaseCreationDate: "2026-07-29T00:01:00.000Z",
    }),
    { kind: "creation-order" },
  );
  assert.throws(() =>
    assertLegacyBucketEvidence({
      samples: [],
      objects: [],
      bucketCreationDate: "2026-07-29T01:00:00.000Z",
      databaseCreationDate: "2026-07-29T00:00:00.000Z",
    }),
  );
});

test("setup records ownership before primary mutations and reads list result arrays", async () => {
  const [setup, worker, launcher] = await Promise.all([
    readFile(path.join(root, "scripts", "setup.mjs"), "utf8"),
    readFile(path.join(root, "worker", "index.ts"), "utf8"),
    readFile(path.join(root, "scripts", "launcher.mjs"), "utf8"),
  ]);
  const create = setup.match(
    /async function createR2Bucket[\s\S]+?\n}\n\nasync function findExistingD1Database/,
  )?.[0];
  assert.ok(create);
  assert.ok(
    create.indexOf("ensurePrimarySetupIntent") <
      create.indexOf('"r2", "bucket", "create"'),
  );
  assert.ok(
    create.indexOf("setPrimaryBucketManagement(ownership, true)") <
      create.indexOf('"r2", "bucket", "create"'),
  );
  assert.match(setup, /const candidates = r2ObjectsFromApiPayload\(listed\)/);
  assert.doesNotMatch(setup, /listed\.result\?\.objects/);
  assert.match(worker, /r2drive-primary-worker-v1/);
  assert.match(worker, /crypto\.subtle\.sign/);
  assert.match(worker, /cache-control": "no-store"/);
  const preflight = launcher.match(
    /async function preflightUninstall[\s\S]+?\n}\n\nasync function deleteStorageNodeWorker/,
  )?.[0];
  assert.ok(preflight);
  assert.ok(
    preflight.indexOf("readPrimaryOwnershipIntent") <
      preflight.indexOf("inspectD1ForUninstall"),
  );
  assert.match(preflight, /verifyPrimaryBucketForUninstall\(ownership\)/);
  assert.match(preflight, /verifyPrimaryWorkerForUninstall\(ownership, instance\)/);
  assert.match(launcher, /purgeProtectedKeys: \[ownership\.bucketMarkerKey\]/);
  assert.match(
    launcher,
    /removePrimaryBucketOwnershipMarker\(ownership\)[\s\S]+restorePrimaryBucketOwnershipMarker\(ownership\)/,
  );
  assert.match(launcher, /uninstallProvisioningPrimary/);
});

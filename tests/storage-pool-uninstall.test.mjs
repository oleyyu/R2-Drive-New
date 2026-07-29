import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertManagedBucketOwnership,
  assertStorageNodeWorkerIdentity,
  assertTemporaryPurgeWorkerIdentity,
  createPurgeHelperJournalEntry,
  reconcileStorageNodeInventory,
  storageBucketOwnershipBody as launcherBucketOwnershipBody,
  validatePurgeHelperJournalEntry,
  validateStoragePoolInventory,
  validateWranglerProfile,
  waitForTemporaryPurgeWorkerIdentity,
} from "../scripts/launcher.mjs";
import {
  createStorageBucketOwnershipIntent,
  storageBucketOwnershipBody as setupBucketOwnershipBody,
} from "../scripts/storage-pool.mjs";
import purgeWorker from "../scripts/uninstall-worker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerA = "123e4567-e89b-42d3-a456-426614174000";
const ownerB = "223e4567-e89b-42d3-a456-426614174000";
const purgeToken = "p".repeat(43);

function purgeIdentityEnvironment(bucketName) {
  return {
    PURGE_HELPER_TOKEN: purgeToken,
    PURGE_EXPECTED_BUCKET: bucketName,
    PURGE_PLAN_HASH: "a".repeat(64),
  };
}

function inventoryNode(overrides = {}) {
  return {
    id: "323e4567-e89b-42d3-a456-426614174000",
    label: "附加节点",
    profile: "r2drive-node-a1b2c3d4",
    accountId: "a".repeat(32),
    bucketName: "r2-drive-node-a",
    workerName: "r2-drive-storage-a",
    endpoint:
      "https://r2-drive-storage-a.account-subdomain.workers.dev",
    managedBucket: true,
    managedWorker: true,
    bucketOwnershipMarkerKey:
      ".r2-drive-storage-node/323e4567-e89b-42d3-a456-426614174000/0123456789abcdef0123456789abcdef.json",
    bucketOwnershipMarkerToken: "A".repeat(43),
    status: "active",
    ...overrides,
  };
}

function memoryBucket(initialObjects = []) {
  const objects = new Map(
    initialObjects.map((key) => [key, `body:${key}`]),
  );
  const aborted = [];
  return {
    objects,
    aborted,
    resumeMultipartUpload(storageKey, uploadId) {
      return {
        async abort() {
          aborted.push([storageKey, uploadId]);
        },
      };
    },
    async list(options = {}) {
      const prefix = options.prefix ?? "";
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .slice(0, options.limit ?? 1_000)
          .map((key) => ({ key })),
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
    },
    async put(key, value, options = {}) {
      const ifNoneMatch =
        options.onlyIf instanceof Headers
          ? options.onlyIf.get("if-none-match")
          : "";
      if (ifNoneMatch === "*" && objects.has(key)) return null;
      objects.set(key, value);
      return { key };
    },
  };
}

test("inventory and Wrangler profiles reject argv injection before uninstall", () => {
  assert.equal(validateWranglerProfile("default"), "default");
  assert.equal(
    validateWranglerProfile("r2drive-node-a1b2c3d4e5f6"),
    "r2drive-node-a1b2c3d4e5f6",
  );
  for (const profile of [
    "--profile",
    "r2drive-node-a;rm",
    "other-login",
    "r2drive-node-ABCDEF12",
  ]) {
    assert.throws(() => validateWranglerProfile(profile));
  }

  const valid = validateStoragePoolInventory({
    version: 1,
    nodes: [inventoryNode()],
  });
  assert.equal(valid.nodes[0].accountId, "a".repeat(32));
  assert.equal(valid.nodes[0].managedBucket, true);
  assert.throws(() =>
    validateStoragePoolInventory({
      version: 1,
      nodes: [inventoryNode({ profile: "--profile=stolen" })],
    }),
  );
  assert.throws(() =>
    validateStoragePoolInventory({
      version: 1,
      nodes: [
        inventoryNode(),
        inventoryNode({ workerName: "another-worker" }),
      ],
    }),
  );
  assert.throws(() =>
    validateStoragePoolInventory({
      version: 1,
      nodes: [inventoryNode({ managedBucket: undefined })],
    }),
  );
  assert.throws(() =>
    validateStoragePoolInventory({
      version: 1,
      nodes: [inventoryNode({ status: "unknown" })],
    }),
  );
});

test("D1 storage_nodes must exactly match the local uninstall inventory", () => {
  const node = inventoryNode();
  const remoteNode = {
    id: node.id,
    account_id: node.accountId,
    bucket_name: node.bucketName,
    worker_name: node.workerName,
    managed_bucket: 1,
    managed_worker: 1,
  };
  assert.deepEqual(
    reconcileStorageNodeInventory(
      { version: 1, nodes: [node] },
      [remoteNode],
    ),
    [
      {
        id: node.id,
        accountId: node.accountId,
        bucketName: node.bucketName,
        workerName: node.workerName,
        managedBucket: true,
        managedWorker: true,
      },
    ],
  );
  assert.throws(() =>
    reconcileStorageNodeInventory({ version: 1, nodes: [] }, [remoteNode]),
  );
  assert.throws(() =>
    reconcileStorageNodeInventory(
      { version: 1, nodes: [node] },
      [],
    ),
  );
  for (const status of ["provisioning", "pending"]) {
    assert.deepEqual(
      reconcileStorageNodeInventory(
        { version: 1, nodes: [inventoryNode({ status })] },
        [],
      ),
      [],
    );
  }
  assert.throws(() =>
    reconcileStorageNodeInventory(
      { version: 1, nodes: [node] },
      [{ ...remoteNode, bucket_name: "different-bucket" }],
    ),
  );
  assert.throws(() =>
    reconcileStorageNodeInventory(
      { version: 1, nodes: [node] },
      [{ ...remoteNode, managed_bucket: 0 }],
    ),
  );
});

test("managed resources require their original random marker and signed node identity", () => {
  const node = validateStoragePoolInventory({
    version: 1,
    nodes: [inventoryNode()],
  }).nodes[0];
  const expected = setupBucketOwnershipBody(node);
  assert.equal(launcherBucketOwnershipBody(node), expected);
  assert.doesNotThrow(() => assertManagedBucketOwnership(node, expected));
  assert.doesNotThrow(() =>
    assertStorageNodeWorkerIdentity(node, {
      ok: true,
      nodeId: node.id,
      protocol: "r2drive-storage-node-v1",
    }),
  );

  const sameNamesButRecreated = {
    ...node,
    bucketOwnershipMarkerToken: "B".repeat(43),
  };
  assert.throws(
    () =>
      assertManagedBucketOwnership(
        sameNamesButRecreated,
        expected,
      ),
    /同名重建/,
  );
  assert.throws(
    () =>
      assertStorageNodeWorkerIdentity(node, {
        ok: true,
        nodeId: "423e4567-e89b-42d3-a456-426614174000",
        protocol: "r2drive-storage-node-v1",
      }),
    /同名重建/,
  );

  assert.throws(() =>
    validateStoragePoolInventory({
      version: 1,
      nodes: [
        inventoryNode({
          bucketOwnershipMarkerKey: undefined,
          bucketOwnershipMarkerToken: undefined,
        }),
      ],
    }),
  );
  assert.throws(() =>
    validateStoragePoolInventory({
      version: 1,
      nodes: [inventoryNode({ endpoint: "" })],
    }),
  );
});

test("provisioning retry preserves the first bucket ownership intent", () => {
  const nodeId = "523e4567-e89b-42d3-a456-426614174000";
  const first = createStorageBucketOwnershipIntent(nodeId);
  const retry = createStorageBucketOwnershipIntent(nodeId, {
    bucketOwnershipMarkerKey: first.markerKey,
    bucketOwnershipMarkerToken: first.markerToken,
  });
  assert.deepEqual(retry, first);
  assert.match(
    first.markerKey,
    /^\.r2-drive-storage-node\/523e4567-e89b-42d3-a456-426614174000\/[a-f0-9]{32}\.json$/,
  );
  assert.match(first.markerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() =>
    createStorageBucketOwnershipIntent(nodeId, {
      bucketOwnershipMarkerKey: first.markerKey,
    }),
  );
});

test("purge helper retries only accept the journal token and exact R2 binding", () => {
  const target = {
    id: "623e4567-e89b-42d3-a456-426614174000",
    accountId: "b".repeat(32),
    bucketName: "r2-drive-purge-target",
  };
  const profile = "r2drive-node-a1b2c3d4";
  const round = {
    uploads: [
      { storageKey: `${ownerA}/pending.bin`, uploadId: "upload-1" },
    ],
    prefixes: [`${ownerA}/`],
    purgeAll: false,
  };
  const operation = createPurgeHelperJournalEntry(target, profile, round);
  const anotherOperation = createPurgeHelperJournalEntry(target, profile, round);
  assert.deepEqual(validatePurgeHelperJournalEntry(operation), operation);
  assert.match(operation.workerName, /^r2-drive-purge-[a-f0-9]{32}$/);
  assert.match(operation.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(operation.planHash, /^[a-f0-9]{64}$/);
  assert.notEqual(operation.workerName, anotherOperation.workerName);
  assert.notEqual(operation.token, anotherOperation.token);

  const versionId = "723e4567-e89b-42d3-a456-426614174000";
  const deployment = {
    versions: [{ version_id: versionId, percentage: 100 }],
  };
  const plainBindings = {
    PURGE_UPLOADS: JSON.stringify(round.uploads),
    PURGE_ALL: "false",
    PURGE_PREFIXES: JSON.stringify(round.prefixes),
    PURGE_PROTECTED_KEYS: "[]",
    PURGE_MARKER_KEY: operation.markerKey,
    PURGE_MARKER_VALUE: operation.token,
    PURGE_HELPER_TOKEN: operation.token,
    PURGE_EXPECTED_BUCKET: target.bucketName,
    PURGE_PLAN_HASH: operation.planHash,
  };
  const version = {
    id: versionId,
    resources: {
      script: { handlers: ["scheduled"] },
      bindings: [
        ...Object.entries(plainBindings).map(([name, text]) => ({
          type: "plain_text",
          name,
          text,
        })),
        {
          type: "r2_bucket",
          name: "FILES",
          bucket_name: target.bucketName,
        },
      ],
    },
  };
  assert.doesNotThrow(() =>
    assertTemporaryPurgeWorkerIdentity(
      operation,
      target,
      profile,
      round,
      deployment,
      version,
    ),
  );

  const sameNameDifferentToken = structuredClone(version);
  sameNameDifferentToken.resources.bindings.find(
    (binding) => binding.name === "PURGE_HELPER_TOKEN",
  ).text = "x".repeat(43);
  assert.throws(
    () =>
      assertTemporaryPurgeWorkerIdentity(
        operation,
        target,
        profile,
        round,
        deployment,
        sameNameDifferentToken,
      ),
    /拒绝覆盖或删除/,
  );

  const sameNameDifferentBucket = structuredClone(version);
  sameNameDifferentBucket.resources.bindings.find(
    (binding) => binding.type === "r2_bucket",
  ).bucket_name = "someone-elses-bucket";
  assert.throws(
    () =>
      assertTemporaryPurgeWorkerIdentity(
        operation,
        target,
        profile,
        round,
        deployment,
        sameNameDifferentBucket,
      ),
    /拒绝覆盖或删除/,
  );

  assert.throws(
    () =>
      assertTemporaryPurgeWorkerIdentity(
        operation,
        target,
        profile,
        { ...round, uploads: [] },
        deployment,
        version,
      ),
    /另一项未完成/,
  );
});

test("post-deploy identity wait preserves arguments and retries only missing helpers", async () => {
  const target = {
    id: "823e4567-e89b-42d3-a456-426614174000",
    accountId: "c".repeat(32),
    bucketName: "r2-drive-wait-target",
  };
  const profile = "r2drive-node-b1c2d3e4";
  const round = { uploads: [], prefixes: [], purgeAll: true };
  const operation = createPurgeHelperJournalEntry(target, profile, round);
  const configPath = "/tmp/r2-drive-test-wrangler.jsonc";
  const calls = [];
  const waits = [];
  const result = await waitForTemporaryPurgeWorkerIdentity(
    target,
    profile,
    operation,
    round,
    configPath,
    {
      inspect: async (...args) => {
        calls.push(args);
        return { missing: calls.length < 3 };
      },
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    },
  );
  assert.deepEqual(result, { missing: false });
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert.deepEqual(args, [
      target,
      profile,
      operation,
      round,
      configPath,
    ]);
  }
  assert.deepEqual(waits, [500, 1_000]);
});

test("launcher preflights every profile and preserves D1 plus inventory until all nodes finish", async () => {
  const launcher = await readFile(
    path.join(root, "scripts", "launcher.mjs"),
    "utf8",
  );
  assert.match(launcher, /\.wrangler",\s+"storage-pool",\s+"nodes\.json"/);
  assert.match(launcher, /\["--no-install", "wrangler", \.\.\.args, "--profile", profile\]/);
  assert.match(launcher, /CLOUDFLARE_ACCOUNT_ID: validateAccountId\(accountId\)/);
  assert.match(launcher, /env: wranglerEnvironment\(target\.accountId\),\s+replaceEnv: true/);
  assert.match(launcher, /inspectBucketForUninstall\([\s\S]+node\.profile/);
  assert.match(launcher, /inspectWorkerForUninstall\([\s\S]+node\.profile/);
  assert.match(
    launcher,
    /if \(!bucketMissing && node\.managedBucket\)[\s\S]+readManagedBucketOwnershipMarker\(node\)/,
  );
  assert.match(
    launcher,
    /if \(!workerMissing && node\.managedWorker\)[\s\S]+verifyStorageNodeWorkerForUninstall\(node\)/,
  );
  assert.match(
    launcher,
    /if \(node\.uninstallCompletedAt\)[\s\S]+bucketMissing: true[\s\S]+workerMissing: true[\s\S]+continue;/,
    "a retry must not require a deleted Wrangler profile for a node that already completed",
  );
  assert.match(
    launcher,
    /SELECT id, account_id, bucket_name, worker_name,[\s\S]+FROM storage_nodes/,
  );
  assert.match(
    launcher,
    /reconcileStorageNodeInventory\([\s\S]+registeredNodes/,
  );
  assert.match(launcher, /WHERE storage_node_id \$\{predicate\}/);
  assert.match(launcher, /owner UUID/);
  assert.match(
    launcher,
    /purgeAllR2Data\(node, node\.cleanup, node\.managedBucket\)/,
  );
  assert.match(launcher, /if \(node\.managedBucket\)[\s\S]+deleteManagedStorageNodeBucket/);
  assert.match(launcher, /if \(!node\.managedWorker\)[\s\S]+保留非受管 Worker/);
  assert.match(launcher, /markStorageNodeUninstalled\(inventory, node\.id\)/);
  assert.match(
    launcher,
    /inventory\.nodes\.some\(\(node\) => !node\.uninstallCompletedAt\)/,
  );
  assert.match(
    launcher,
    /open\(PURGE_HELPER_JOURNAL_PATH, "wx", 0o600\)/,
    "the random helper identity must be persisted atomically before deploy",
  );
  assert.match(launcher, /"deployments",\s+"status"/);
  assert.match(launcher, /"versions",\s+"view"/);
  assert.match(
    launcher,
    /const inspected = await inspectTemporaryPurgeWorker[\s\S]+const deployed = await runWrangler/,
    "deployment must follow a name-absence or exact-identity probe",
  );
  assert.match(
    launcher,
    /async function removeTemporaryPurgeWorker[\s\S]+inspectTemporaryPurgeWorker[\s\S]+runWrangler\(\s*\["delete"/,
    "helper identity must be checked again immediately before deletion",
  );
  assert.doesNotMatch(
    launcher,
    /helperIdentity = createHash[\s\S]+r2-drive-purge-/,
    "helper names must not be derived deterministically from account resources",
  );
  assert.match(
    launcher,
    /protectedKeys = purgeAll[\s\S]+target\.bucketOwnershipMarkerKey/,
    "a managed bucket marker must survive an interrupted purge helper",
  );
  assert.match(
    launcher,
    /async function deleteManagedStorageNodeBucket[\s\S]+readManagedBucketOwnershipMarker\(node\)[\s\S]+bucketOwnershipMarkerKey[\s\S]+r2",\s+"bucket",\s+"delete"/,
    "the ownership marker is removed only in the final bucket-delete window",
  );
  assert.doesNotMatch(launcher, /cloudflareApi|oauth_token|auth", "token/);
  assert.doesNotMatch(launcher, /wrangler logout|Cloudflare 控制台/);

  const uninstall = launcher.match(
    /async function uninstallInstance[\s\S]+?\n}\n\nexport function formatMenu/,
  )?.[0];
  assert.ok(uninstall);
  const order = [
    "readStoragePoolInventory",
    "请输入 DELETE",
    "await preflightUninstall",
    "await deleteWorker",
    "await deleteStorageNodes",
    "await deleteR2",
    "await deleteD1",
    "await clearLocalInstance",
  ].map((marker) => uninstall.indexOf(marker));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});

test("PURGE_ALL removes every ordinary object and writes completion only after aborts", async () => {
  const ownershipMarker =
    `.r2-drive-storage-node/${ownerA}/0123456789abcdef0123456789abcdef.json`;
  const bucket = memoryBucket([
    `${ownerA}/one.bin`,
    `${ownerB}/two.bin`,
    "unrelated/data.bin",
    ownershipMarker,
  ]);
  const markerKey = ".r2-drive-uninstall/done.json";
  await purgeWorker.scheduled(
    { cron: "* * * * *" },
    {
      FILES: bucket,
      PURGE_ALL: "true",
      PURGE_PREFIXES: "[]",
      PURGE_PROTECTED_KEYS: JSON.stringify([ownershipMarker]),
      PURGE_UPLOADS: JSON.stringify([
        {
          storageKey: `${ownerA}/unfinished.bin`,
          uploadId: "upload-1",
        },
      ]),
      PURGE_MARKER_KEY: markerKey,
      PURGE_MARKER_VALUE: purgeToken,
      ...purgeIdentityEnvironment("test-managed-bucket"),
    },
  );

  assert.deepEqual(bucket.aborted, [
    [`${ownerA}/unfinished.bin`, "upload-1"],
  ]);
  assert.deepEqual(
    [...bucket.objects.entries()].sort(),
    [
      [markerKey, purgeToken],
      [`${markerKey}.lock`, purgeToken],
      [ownershipMarker, `body:${ownershipMarker}`],
    ].sort(),
  );
});

test("shared-bucket purge is confined to validated owner UUID prefixes", async () => {
  const bucket = memoryBucket([
    `${ownerA}/one.bin`,
    `${ownerA}/folder/two.bin`,
    `${ownerB}/keep.bin`,
    "shared/keep.bin",
  ]);
  const markerKey = `${ownerA}/purge-complete.json`;
  await purgeWorker.scheduled(
    { cron: "* * * * *" },
    {
      FILES: bucket,
      PURGE_ALL: "false",
      PURGE_PREFIXES: JSON.stringify([`${ownerA}/`]),
      PURGE_UPLOADS: "[]",
      PURGE_MARKER_KEY: markerKey,
      PURGE_MARKER_VALUE: purgeToken,
      ...purgeIdentityEnvironment("test-shared-bucket"),
    },
  );

  assert.deepEqual(
    [...bucket.objects.keys()].sort(),
    [
      `${ownerB}/keep.bin`,
      markerKey,
      `${markerKey}.lock`,
      "shared/keep.bin",
    ].sort(),
  );

  await assert.rejects(() =>
    purgeWorker.scheduled(
      { cron: "* * * * *" },
      {
        FILES: bucket,
        PURGE_ALL: "false",
        PURGE_PREFIXES: JSON.stringify([`${ownerA}/`]),
        PURGE_UPLOADS: "[]",
        PURGE_MARKER_KEY: "shared/outside-boundary.json",
        PURGE_MARKER_VALUE: purgeToken,
        ...purgeIdentityEnvironment("test-shared-bucket"),
      },
    ),
  );
  assert.equal(bucket.objects.has(`${ownerB}/keep.bin`), true);
  assert.equal(bucket.objects.has("shared/keep.bin"), true);
});

test("completion marker is withheld when a multipart abort fails", async () => {
  const bucket = memoryBucket([]);
  bucket.resumeMultipartUpload = () => ({
    async abort() {
      throw new Error("AccessDenied");
    },
  });
  const markerKey = ".r2-drive-uninstall/must-not-exist.json";
  await assert.rejects(() =>
    purgeWorker.scheduled(
      { cron: "* * * * *" },
      {
        FILES: bucket,
        PURGE_ALL: "true",
        PURGE_PREFIXES: "[]",
        PURGE_UPLOADS: JSON.stringify([
          { storageKey: `${ownerA}/blocked.bin`, uploadId: "blocked" },
        ]),
        PURGE_MARKER_KEY: markerKey,
        PURGE_MARKER_VALUE: purgeToken,
        ...purgeIdentityEnvironment("test-managed-bucket"),
      },
    ),
  );
  assert.equal(bucket.objects.has(markerKey), false);
});

test("journal-backed purge refuses to run without its helper identity", async () => {
  const bucket = memoryBucket([`${ownerA}/keep.bin`]);
  const markerKey = ".r2-drive-uninstall/identity-required.json";
  await assert.rejects(
    () =>
      purgeWorker.scheduled(
        { cron: "* * * * *" },
        {
          FILES: bucket,
          PURGE_ALL: "true",
          PURGE_PREFIXES: "[]",
          PURGE_UPLOADS: "[]",
          PURGE_MARKER_KEY: markerKey,
          PURGE_MARKER_VALUE: purgeToken,
        },
      ),
    /Invalid purge helper identity/,
  );
  assert.equal(bucket.objects.has(`${ownerA}/keep.bin`), true);
  assert.equal(bucket.objects.has(markerKey), false);
});

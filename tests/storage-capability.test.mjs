import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledRoot = await mkdtemp(
  path.join(tmpdir(), "r2-drive-storage-capability-"),
);
const testRuntimeEnv = {};
globalThis.__r2DriveCapabilityTestEnv = testRuntimeEnv;

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;
}

async function compileTestModules() {
  const [capabilitySource, workerSource] = await Promise.all([
    readFile(path.join(root, "lib", "storage-capability.ts"), "utf8"),
    readFile(path.join(root, "worker", "storage-node.ts"), "utf8"),
  ]);
  const libDirectory = path.join(compiledRoot, "lib");
  const workerDirectory = path.join(compiledRoot, "worker");
  await Promise.all([
    mkdir(libDirectory, { recursive: true }),
    mkdir(workerDirectory, { recursive: true }),
  ]);

  const testableCapability = capabilitySource.replace(
    'import { env } from "cloudflare:workers";',
    "const env = globalThis.__r2DriveCapabilityTestEnv;",
  );
  const testableWorker = workerSource.replace(
    '"../lib/storage-capability"',
    '"../lib/storage-capability.mjs"',
  );
  await Promise.all([
    writeFile(
      path.join(libDirectory, "storage-capability.mjs"),
      transpile(testableCapability),
    ),
    writeFile(
      path.join(workerDirectory, "storage-node.mjs"),
      transpile(testableWorker),
    ),
  ]);

  const capability = await import(
    pathToFileURL(path.join(libDirectory, "storage-capability.mjs")).href
  );
  const nodeWorker = await import(
    pathToFileURL(path.join(workerDirectory, "storage-node.mjs")).href
  );
  return { capability, nodeWorker: nodeWorker.default };
}

const modulesPromise = compileTestModules();

after(async () => {
  delete globalThis.__r2DriveCapabilityTestEnv;
  await rm(compiledRoot, { recursive: true, force: true });
});

async function generateKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const [privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.privateKey),
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ]);
  return { privateJwk, publicJwk };
}

async function captureSignedRequest(capability, node, pathValue, init) {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, requestInit) => {
    captured = new Request(input, requestInit);
    return Response.json({ captured: true });
  };
  try {
    await capability.signedNodeFetch(node, pathValue, init);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, "signedNodeFetch must issue one fetch request");
  return captured;
}

test("P-256 capability binds routing claims and has an explicit replay window", async () => {
  const { capability } = await modulesPromise;
  const { privateJwk, publicJwk } = await generateKeys();
  testRuntimeEnv.STORAGE_FEDERATION_PRIVATE_KEY = JSON.stringify(privateJwk);
  const node = { id: "node-east-1", endpoint: "https://node.example" };
  const request = await captureSignedRequest(
    capability,
    node,
    "/v1/health",
    { method: "GET", headers: { "x-test-header": "preserved" } },
  );
  const timestamp = Number(
    request.headers.get(capability.STORAGE_CAPABILITY_HEADERS.timestamp),
  );

  assert.equal(request.url, "https://node.example/v1/health");
  assert.equal(request.headers.get("x-test-header"), "preserved");
  assert.equal(
    request.headers.get(capability.STORAGE_CAPABILITY_HEADERS.nodeId),
    node.id,
  );
  assert.equal(request.redirect, "manual");
  assert.equal(
    await capability.verifyStorageCapabilityRequest(request, {
      nodeId: node.id,
      publicKeyJwk: publicJwk,
      nowSeconds: timestamp,
    }),
    true,
  );
  assert.equal(
    await capability.verifyStorageCapabilityRequest(request, {
      nodeId: node.id,
      publicKeyJwk: publicJwk,
      nowSeconds: timestamp,
    }),
    true,
    "the stateless verifier intentionally permits an exact replay inside 60 seconds",
  );
  assert.equal(
    await capability.verifyStorageCapabilityRequest(request, {
      nodeId: node.id,
      publicKeyJwk: publicJwk,
      nowSeconds: timestamp + 60,
    }),
    true,
  );
  assert.equal(
    await capability.verifyStorageCapabilityRequest(request, {
      nodeId: node.id,
      publicKeyJwk: publicJwk,
      nowSeconds: timestamp + 61,
    }),
    false,
  );
  assert.equal(
    await capability.verifyStorageCapabilityRequest(request, {
      nodeId: "node-west-1",
      publicKeyJwk: publicJwk,
      nowSeconds: timestamp,
    }),
    false,
  );

  const tamperedPath = new Request(
    "https://node.example/v1/objects/YQ",
    request,
  );
  assert.equal(
    await capability.verifyStorageCapabilityRequest(tamperedPath, {
      nodeId: node.id,
      publicKeyJwk: publicJwk,
      nowSeconds: timestamp,
    }),
    false,
  );

  const tamperedNonceHeaders = new Headers(request.headers);
  tamperedNonceHeaders.set(
    capability.STORAGE_CAPABILITY_HEADERS.nonce,
    capability.encodeBase64Url(new Uint8Array(16).fill(7)),
  );
  const tamperedNonce = new Request(request, {
    headers: tamperedNonceHeaders,
  });
  assert.equal(
    await capability.verifyStorageCapabilityRequest(tamperedNonce, {
      nodeId: node.id,
      publicKeyJwk: publicJwk,
      nowSeconds: timestamp,
    }),
    false,
  );

  await assert.rejects(
    capability.signedNodeFetch(node, "/admin", { method: "GET" }),
    /route is not allowed/i,
  );
  await assert.rejects(
    capability.signedNodeFetch(node, "//attacker.example/v1/health", {
      method: "GET",
    }),
    /origin-relative/i,
  );
  await assert.rejects(
    capability.signedNodeFetch(
      { id: node.id, endpoint: "http://node.example" },
      "/v1/health",
      { method: "GET" },
    ),
    /HTTPS origin/i,
  );
  await assert.rejects(
    capability.signedNodeFetch(node, "/v1/health", {
      method: "GET",
      redirect: "follow",
    }),
    /redirects must not be followed/i,
  );
});

function fakeR2Bucket() {
  const uploads = new Map();
  const objects = new Map([
    ["owner/file/blob", new TextEncoder().encode("abcdefghij")],
  ]);
  const completedHeads = new Map();
  const deleted = [];
  let nextUpload = 1;

  function objectResult(key, data, range) {
    let body = data;
    let objectRange;
    if (range) {
      const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(range);
      assert.ok(match);
      if (match[1]) {
        const offset = Number(match[1]);
        const end = match[2] ? Number(match[2]) : data.byteLength - 1;
        body = data.slice(offset, end + 1);
        objectRange = { offset, length: body.byteLength };
      } else {
        const suffix = Number(match[2]);
        body = data.slice(Math.max(data.byteLength - suffix, 0));
        objectRange = { suffix };
      }
    }
    return {
      key,
      size: data.byteLength,
      etag: "object-etag",
      httpEtag: '"object-etag"',
      range: objectRange,
      body: new Blob([body]).stream(),
      writeHttpMetadata(headers) {
        headers.set("content-type", "application/octet-stream");
      },
    };
  }

  return {
    deleted,
    async createMultipartUpload(key, options) {
      const uploadId = `upload-${nextUpload}`;
      nextUpload += 1;
      uploads.set(uploadId, { key, options, parts: new Map() });
      return {
        key,
        uploadId,
      };
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        async uploadPart(partNumber, value) {
          const upload = uploads.get(uploadId);
          assert.ok(upload);
          assert.equal(upload.key, key);
          const bytes = new Uint8Array(await new Response(value).arrayBuffer());
          upload.parts.set(partNumber, bytes);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts) {
          const upload = uploads.get(uploadId);
          if (!upload) {
            const error = new Error("missing upload");
            error.name = "NoSuchUpload";
            error.code = 10024;
            throw error;
          }
          assert.deepEqual(
            parts.map((part) => part.partNumber),
            [...upload.parts.keys()],
          );
          const size = [...upload.parts.values()].reduce(
            (sum, value) => sum + value.byteLength,
            0,
          );
          const completed = {
            size,
            httpEtag: '"complete-etag"',
            customMetadata: upload.options.customMetadata,
          };
          completedHeads.set(key, completed);
          uploads.delete(uploadId);
          return completed;
        },
        async abort() {
          assert.ok(uploads.has(uploadId));
          uploads.delete(uploadId);
        },
      };
    },
    async get(key, options) {
      const data = objects.get(key);
      if (!data) return null;
      const range = options?.range instanceof Headers
        ? options.range.get("range")
        : null;
      return objectResult(key, data, range);
    },
    async head(key) {
      return completedHeads.get(key) ?? null;
    },
    async delete(keys) {
      deleted.push(...keys);
    },
  };
}

test("storage node exposes only signed, bounded R2 operations", async () => {
  const { capability, nodeWorker } = await modulesPromise;
  const { privateJwk, publicJwk } = await generateKeys();
  testRuntimeEnv.STORAGE_FEDERATION_PRIVATE_KEY = JSON.stringify(privateJwk);
  const node = { id: "node-storage-1", endpoint: "https://node.example" };
  const bucket = fakeR2Bucket();
  const nodeEnv = {
    NODE_ID: node.id,
    CONTROL_PUBLIC_KEY_JWK: JSON.stringify(publicJwk),
    FILES: bucket,
  };

  const rawUnknown = await nodeWorker.fetch(
    new Request("https://node.example/internal/config"),
    nodeEnv,
  );
  assert.equal(rawUnknown.status, 404);

  const unsignedHealth = await nodeWorker.fetch(
    new Request("https://node.example/v1/health"),
    nodeEnv,
  );
  assert.equal(unsignedHealth.status, 401);

  const healthRequest = await captureSignedRequest(
    capability,
    node,
    "/v1/health",
    { method: "GET" },
  );
  const health = await nodeWorker.fetch(healthRequest, nodeEnv);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    nodeId: node.id,
    protocol: "r2drive-storage-node-v1",
    capabilityTtlSeconds: 60,
  });

  const createRequest = await captureSignedRequest(
    capability,
    node,
    "/v1/multipart/create",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "owner/new-file/blob",
        contentType: "application/octet-stream",
        ownerId: "owner-1",
        fileId: "file-1",
      }),
    },
  );
  const tamperedCreateRequest = new Request(createRequest.url, {
    method: "POST",
    headers: createRequest.headers,
    body: JSON.stringify({
      key: "owner/other-file/blob",
      contentType: "application/octet-stream",
      ownerId: "owner-1",
      fileId: "other-file",
    }),
  });
  const tamperedCreate = await nodeWorker.fetch(
    tamperedCreateRequest,
    nodeEnv,
  );
  assert.equal(tamperedCreate.status, 401);
  assert.equal(
    (await tamperedCreate.json()).error.code,
    "invalid_capability",
  );
  const created = await nodeWorker.fetch(createRequest, nodeEnv);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { uploadId: "upload-1" });

  const partRequest = await captureSignedRequest(
    capability,
    node,
    "/v1/multipart/upload-1/parts/1?key=owner%2Fnew-file%2Fblob",
    {
      method: "PUT",
      body: "part-body",
    },
  );
  const part = await nodeWorker.fetch(partRequest, nodeEnv);
  assert.equal(part.status, 200);
  assert.deepEqual(await part.json(), { partNumber: 1, etag: "etag-1" });

  const completeRequest = await captureSignedRequest(
    capability,
    node,
    "/v1/multipart/upload-1/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "owner/new-file/blob",
        ownerId: "owner-1",
        fileId: "file-1",
        expectedSize: 9,
        parts: [{ partNumber: 1, etag: "etag-1" }],
      }),
    },
  );
  const completed = await nodeWorker.fetch(completeRequest, nodeEnv);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), {
    size: 9,
    httpEtag: '"complete-etag"',
  });
  const repeatedCompleteRequest = await captureSignedRequest(
    capability,
    node,
    "/v1/multipart/upload-1/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "owner/new-file/blob",
        ownerId: "owner-1",
        fileId: "file-1",
        expectedSize: 9,
        parts: [{ partNumber: 1, etag: "etag-1" }],
      }),
    },
  );
  const repeatedComplete = await nodeWorker.fetch(
    repeatedCompleteRequest,
    nodeEnv,
  );
  assert.equal(repeatedComplete.status, 200);
  assert.deepEqual(await repeatedComplete.json(), {
    size: 9,
    httpEtag: '"complete-etag"',
  });

  const encodedKey = capability.encodeBase64Url(
    new TextEncoder().encode("owner/file/blob"),
  );
  const getRequest = await captureSignedRequest(
    capability,
    node,
    `/v1/objects/${encodedKey}`,
    { method: "GET", headers: { range: "bytes=2-5" } },
  );
  const tamperedRangeHeaders = new Headers(getRequest.headers);
  tamperedRangeHeaders.set("range", "bytes=0-9");
  const tamperedRangeRequest = new Request(getRequest, {
    headers: tamperedRangeHeaders,
  });
  const tamperedRange = await nodeWorker.fetch(
    tamperedRangeRequest,
    nodeEnv,
  );
  assert.equal(tamperedRange.status, 401);
  assert.equal(
    (await tamperedRange.json()).error.code,
    "invalid_capability",
  );
  const object = await nodeWorker.fetch(getRequest, nodeEnv);
  assert.equal(object.status, 206);
  assert.equal(object.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(object.headers.get("content-length"), "4");
  assert.equal(await object.text(), "cdef");

  const invalidRangeRequest = await captureSignedRequest(
    capability,
    node,
    `/v1/objects/${encodedKey}`,
    { method: "GET", headers: { range: "bytes=-0" } },
  );
  const invalidRange = await nodeWorker.fetch(invalidRangeRequest, nodeEnv);
  assert.equal(invalidRange.status, 416);
  assert.equal((await invalidRange.json()).error.code, "invalid_range");

  const deleteRequest = await captureSignedRequest(
    capability,
    node,
    "/v1/objects/delete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["owner/file/blob"] }),
    },
  );
  const deleted = await nodeWorker.fetch(deleteRequest, nodeEnv);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true, deleted: 1 });
  assert.deepEqual(bucket.deleted, ["owner/file/blob"]);

  const badDeleteRequest = await captureSignedRequest(
    capability,
    node,
    "/v1/objects/delete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keys: ["owner/file/blob", "owner/file/blob"],
      }),
    },
  );
  const badDelete = await nodeWorker.fetch(badDeleteRequest, nodeEnv);
  assert.equal(badDelete.status, 400);
  assert.equal((await badDelete.json()).error.code, "invalid_keys");

  const originalConsoleError = console.error;
  const configurationLogs = [];
  console.error = (...values) => {
    configurationLogs.push(values.join(" "));
  };
  let malformedNode;
  try {
    malformedNode = await nodeWorker.fetch(healthRequest, {
      ...nodeEnv,
      CONTROL_PUBLIC_KEY_JWK: '{"kty":"oct","k":"secret-marker"}',
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(malformedNode.status, 500);
  assert.doesNotMatch(await malformedNode.text(), /secret-marker/);
  assert.doesNotMatch(configurationLogs.join("\n"), /secret-marker/);
});

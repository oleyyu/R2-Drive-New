import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(...segments) {
  return readFile(path.join(root, ...segments), "utf8");
}

class D1StatementShim {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new D1StatementShim(this.database, this.sql, parameters);
  }

  execute() {
    const statement = this.database.prepare(this.sql);
    const returnsRows =
      /^\s*SELECT\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
    if (returnsRows) {
      const results = statement.all(...this.parameters);
      const changes = Number(
        this.database.prepare("SELECT changes() AS value").get().value,
      );
      return { results, success: true, meta: { changes } };
    }
    const result = statement.run(...this.parameters);
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }

  async run() {
    return this.execute();
  }

  async all() {
    const results = this.database.prepare(this.sql).all(...this.parameters);
    return { results, success: true, meta: { changes: 0 } };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.parameters) ?? null;
  }
}

class D1DatabaseShim {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementShim(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const purgeHarness = {
  state: null,
  getFileBucket() {
    return purgeHarness.state.primaryBucket;
  },
  async getStorageNode(_db, nodeId) {
    return purgeHarness.state.nodes.get(nodeId) ?? null;
  },
  async deleteNodeObjects(node, keys) {
    if (purgeHarness.state.failRemote) {
      throw new Error("remote unavailable");
    }
    const objects = purgeHarness.state.remoteObjects.get(node.id);
    for (const key of keys) objects?.delete(key);
  },
};

let purgeModulePromise;

async function purgeModule() {
  if (!purgeModulePromise) {
    globalThis.__r2DrivePurgeHarness = purgeHarness;
    const fileOperations = await source("lib", "file-operations.ts");
    const transpiled = ts.transpileModule(fileOperations, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const withoutImports = transpiled.replace(/^import .*;\n/gm, "");
    const executable = `
      const {
        getFileBucket,
        getStorageNode,
        deleteNodeObjects
      } = globalThis.__r2DrivePurgeHarness;
      ${withoutImports}
    `;
    purgeModulePromise = import(
      `data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`
    );
  }
  return purgeModulePromise;
}

function createPurgeDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      storage_used INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE storage_nodes (
      id TEXT PRIMARY KEY NOT NULL,
      used_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL,
      parent_id TEXT,
      kind TEXT NOT NULL,
      storage_key TEXT,
      storage_node_id TEXT,
      size INTEGER NOT NULL,
      etag TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_operation_id TEXT,
      purge_root_id TEXT,
      purge_claim_token TEXT
    );
    CREATE INDEX files_owner_parent_idx
      ON files (owner_id, parent_id, status);
    CREATE INDEX files_owner_purge_idx
      ON files (
        owner_id,
        purge_operation_id,
        status,
        purge_claim_token
      );
  `);
  return { database, db: new D1DatabaseShim(database) };
}

function insertPurgeFile(
  database,
  {
    id,
    ownerId = "owner",
    parentId = null,
    kind = "file",
    storageKey = `${id}/blob`,
    storageNodeId = null,
    size = kind === "file" ? 1 : 0,
    etag = kind === "file" ? "etag" : null,
    status = "deleted",
    updatedAt = "2026-01-01T00:00:00.000Z",
    deletedAt = "2026-01-01T00:00:00.000Z",
    operationId = null,
    rootId = null,
    claimToken = null,
  },
) {
  database
    .prepare(
      `INSERT INTO files (
         id, owner_id, parent_id, kind, storage_key, storage_node_id,
         size, etag, status, updated_at, deleted_at,
         purge_operation_id, purge_root_id, purge_claim_token
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ownerId,
      parentId,
      kind,
      kind === "file" ? storageKey : null,
      storageNodeId,
      size,
      etag,
      status,
      updatedAt,
      deletedAt,
      operationId,
      rootId,
      claimToken,
    );
}

function installPurgeHarness({
  database,
  primaryObjects = new Set(),
  remoteObjects = new Map(),
  nodes = new Map(),
  failRemote = false,
  afterPrimaryDelete = null,
}) {
  let hook = afterPrimaryDelete;
  purgeHarness.state = {
    nodes,
    remoteObjects,
    failRemote,
    primaryBucket: {
      async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          primaryObjects.delete(key);
        }
        if (hook) {
          const current = hook;
          hook = null;
          await current(database);
        }
      },
    },
  };
  return { primaryObjects, remoteObjects };
}

function sqlTemplateContaining(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);
  assert.ok(markerIndex >= 0, `missing SQL marker: ${marker}`);
  const start = sourceText.lastIndexOf("`", markerIndex);
  const end = sourceText.indexOf("`", markerIndex);
  assert.ok(start >= 0 && end > markerIndex, `invalid SQL template: ${marker}`);
  return sourceText.slice(start + 1, end);
}

test("storage federation migration keeps legacy files on the primary bucket", async () => {
  const [migration, purgeMigration, schema] = await Promise.all([
    source("drizzle", "0004_parched_silver_surfer.sql"),
    source("drizzle", "0007_dashing_rawhide_kid.sql"),
    source("db", "schema.ts"),
  ]);

  assert.match(migration, /CREATE TABLE `storage_nodes`/);
  assert.match(migration, /CREATE TABLE `storage_node_enrollments`/);
  assert.match(
    migration,
    /ALTER TABLE `files` ADD `storage_node_id` text REFERENCES storage_nodes\(id\)/,
  );
  assert.match(
    migration,
    /ALTER TABLE `multipart_uploads` ADD `storage_node_id` text REFERENCES storage_nodes\(id\)/,
  );
  assert.match(
    migration,
    /ALTER TABLE `multipart_uploads` ADD `reserved_bytes` integer DEFAULT 0 NOT NULL/,
  );
  assert.match(migration, /UPDATE `multipart_uploads`[\s\S]+SELECT `size` FROM `files`/);
  assert.doesNotMatch(
    migration,
    /ALTER TABLE `files` ADD `storage_node_id`[^;]+DEFAULT/,
    "legacy rows must keep a NULL node ID so they continue using the primary binding",
  );
  assert.match(schema, /enum: \["active", "draining", "offline"\]/);
  assert.match(purgeMigration, /ADD `purge_operation_id` text/);
  assert.match(purgeMigration, /ADD `purge_root_id` text/);
  assert.match(purgeMigration, /ADD `purge_claim_token` text/);
  assert.match(purgeMigration, /CREATE INDEX `files_owner_purge_idx`/);
});

test("storage node enrollment charges quota only for its own successful insert", async () => {
  const [
    route,
    enrollmentRoute,
    enrollmentStatusRoute,
    settingsClient,
    completionMigration,
    securityDocs,
  ] =
    await Promise.all([
      source("app", "api", "storage-nodes", "enroll", "route.ts"),
      source(
        "app",
        "api",
        "admin",
        "storage-nodes",
        "enrollments",
        "route.ts",
      ),
      source(
        "app",
        "api",
        "admin",
        "storage-nodes",
        "enrollments",
        "[id]",
        "route.ts",
      ),
      source("components", "SettingsClient.tsx"),
      source("drizzle", "0008_unique_revanche.sql"),
      source("docs", "security.md"),
    ]);
  assert.match(enrollmentRoute, /ENROLLMENT_TTL_MS = 60 \* 60 \* 1000/);
  assert.match(enrollmentRoute, /\{\s*id,\s*token,/);
  assert.match(settingsClient, /helperDeadline = Date\.parse\(enrollment\.expiresAt\)/);
  assert.match(
    settingsClient,
    /\/api\/admin\/storage-nodes\/enrollments\/\$\{encodeURIComponent\(enrollment\.id\)\}/,
  );
  assert.match(settingsClient, /AbortSignal\.timeout\(15_000\)/);
  assert.match(settingsClient, /AbortSignal\.timeout\(8_000\)/);
  assert.doesNotMatch(settingsClient, /existingNodeIds/);
  assert.match(completionMigration, /ADD `completed_node_id` text/);
  assert.match(enrollmentStatusRoute, /completed_node_id/);
  assert.match(enrollmentStatusRoute, /"connected"/);
  assert.match(route, /SET completed_node_id = \?/);
  assert.match(
    route,
    /SET used_at = NULL[\s\S]+completed_node_id IS NULL/,
  );
  assert.match(securityDocs, /登记令牌 60 分钟到期、只使用一次/);
  const insertSql = route.match(
    /`(INSERT INTO storage_nodes \([\s\S]*?ON CONFLICT DO NOTHING)`/,
  )?.[1];
  const quotaSql = route.match(
    /`(UPDATE users\s+SET storage_quota = storage_quota \+ \?[\s\S]*?changes\(\) = 1[\s\S]*?)`/,
  )?.[1];
  assert.ok(insertSql, "the enrollment INSERT must be idempotent");
  assert.ok(quotaSql, "the quota UPDATE must be gated by SQLite changes()");
  assert.match(route, /const racedExisting = await findExisting\(\)/);
  assert.match(route, /const reconnected = await db/);
  assert.match(route, /Number\(reconnected\.meta\.changes \?\? 0\) !== 1/);
  assert.match(route, /"storage_node_changed"/);
  assert.match(route, /primary_storage_node_conflict/);
  assert.ok(
    route.indexOf("primary_storage_node_conflict") <
      route.indexOf("const claim ="),
    "the primary-bucket rejection must not consume the one-time enrollment",
  );

  const directory = await mkdtemp(path.join(tmpdir(), "r2drive-enrollment-"));
  const filename = path.join(directory, "enrollment.sqlite");
  const firstConnection = new DatabaseSync(filename);
  let secondConnection;
  try {
    firstConnection.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL,
        storage_quota INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE storage_nodes (
        id TEXT PRIMARY KEY NOT NULL,
        quota_owner_id TEXT NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        account_id TEXT NOT NULL,
        bucket_name TEXT NOT NULL,
        worker_name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status TEXT NOT NULL,
        soft_limit_bytes INTEGER NOT NULL,
        used_bytes INTEGER NOT NULL,
        reserved_bytes INTEGER NOT NULL,
        managed_bucket INTEGER NOT NULL,
        managed_worker INTEGER NOT NULL,
        last_health_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX storage_nodes_account_bucket_idx
        ON storage_nodes (account_id, bucket_name);
      INSERT INTO users (id, storage_quota, updated_at)
        VALUES ('owner', 5000, 'initial');
    `);
    secondConnection = new DatabaseSync(filename);

    const enroll = (database, { id, bucketName, now }) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const inserted = database.prepare(insertSql).run(
          id,
          "Attached R2",
          "0123456789abcdef0123456789abcdef",
          bucketName,
          "r2drive-node",
          "https://r2drive-node.example.workers.dev",
          1000,
          1,
          1,
          now,
          now,
          now,
          "owner",
          Number.MAX_SAFE_INTEGER,
          1000,
        );
        const adjusted = database.prepare(quotaSql).run(
          1000,
          now,
          "owner",
          id,
        );
        database.exec("COMMIT");
        return { inserted: inserted.changes, adjusted: adjusted.changes };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };

    assert.deepEqual(
      enroll(firstConnection, {
        id: "node-a",
        bucketName: "shared-bucket",
        now: "first",
      }),
      { inserted: 1, adjusted: 1 },
    );
    assert.deepEqual(
      enroll(secondConnection, {
        id: "node-a",
        bucketName: "shared-bucket",
        now: "duplicate",
      }),
      { inserted: 0, adjusted: 0 },
      "a serialized duplicate request must not charge quota",
    );
    assert.deepEqual(
      enroll(secondConnection, {
        id: "node-b",
        bucketName: "shared-bucket",
        now: "unique-index-race",
      }),
      { inserted: 0, adjusted: 0 },
      "a competing node ID for the same physical bucket must not charge quota",
    );
    assert.equal(
      firstConnection
        .prepare(
          "SELECT storage_quota AS quota FROM users WHERE id = 'owner'",
        )
        .get().quota,
      6000,
    );
    assert.equal(
      firstConnection
        .prepare("SELECT COUNT(*) AS count FROM storage_nodes")
        .get().count,
      1,
    );
  } finally {
    secondConnection?.close();
    firstConnection.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("new uploads reserve the least-used active node and fall back before persistence", async () => {
  const [storage, upload] = await Promise.all([
    source("lib", "storage.ts"),
    source("app", "api", "uploads", "route.ts"),
  ]);

  assert.match(storage, /WHERE kind = 'worker_proxy'\s+AND status = 'active'/);
  assert.match(
    storage,
    /CAST\(used_bytes \+ reserved_bytes AS REAL\) \/ soft_limit_bytes/,
  );
  assert.match(
    storage,
    /UPDATE storage_nodes[\s\S]+reserved_bytes = reserved_bytes \+ \?[\s\S]+status = 'active'/,
  );
  assert.match(upload, /reserveStorageNode\(db, uploadInput\.size\)/);
  assert.match(
    upload,
    /createNodeMultipartUpload[\s\S]+catch \(nodeError\)[\s\S]+releaseStorageNodeReservation[\s\S]+storageNode = null/,
  );
  assert.match(upload, /storage_node_id, size, content_type/);
  assert.match(upload, /storage_node_id,\s+reserved_bytes, part_size/);
  assert.match(
    upload,
    /INSERT INTO files[\s\S]+WHERE \([\s\S]+\? IS NULL[\s\S]+kind = 'folder' AND status = 'ready'[\s\S]+NOT EXISTS[\s\S]+sibling\.normalized_name = \?/,
  );
  assert.match(upload, /cleanupPersistenceFailure\(fileInserted\)/);
  assert.match(upload, /releaseUserStorageReservation\(db, user\.id, uploadInput\.size\)/);
  assert.match(upload, /"parent_not_found"/);
  assert.match(upload, /"name_exists"/);
  assert.match(
    upload,
    /direct:\s+storageNode === null[\s\S]+directR2Configured\(\)/,
    "remote uploads must never request primary-account direct-upload signatures",
  );
});

test("multipart operations remain pinned to their originally selected node", async () => {
  const [part, sign, complete, abort] = await Promise.all([
    source(
      "app",
      "api",
      "uploads",
      "[id]",
      "parts",
      "[partNumber]",
      "route.ts",
    ),
    source(
      "app",
      "api",
      "uploads",
      "[id]",
      "parts",
      "[partNumber]",
      "sign",
      "route.ts",
    ),
    source("app", "api", "uploads", "[id]", "complete", "route.ts"),
    source("app", "api", "uploads", "[id]", "abort", "route.ts"),
  ]);

  assert.match(part, /SELECT upload_id, storage_key, storage_node_id/);
  assert.match(part, /getStorageNode\(db, storageNodeId\)/);
  assert.match(part, /uploadNodePart\(/);
  assert.match(sign, /if \(upload\.storage_node_id\)/);
  assert.match(sign, /direct_upload_unavailable/);
  assert.match(complete, /completeNodeMultipartUpload\(/);
  assert.match(complete, /settleStorageNodeReservationStatement\(/);
  assert.match(complete, /releaseStorageNodeReservationStatement\(/);
  assert.match(complete, /legacyMetadataMissing/);
  assert.match(complete, /ownerId === undefined && fileId === undefined/);
  assert.match(complete, /object\.size !== expected\.size/);
  assert.match(abort, /abortNodeMultipartUpload\(/);
  assert.match(abort, /releaseStorageNodeReservationStatement\(/);
  assert.match(
    abort,
    /FROM multipart_uploads m\s+JOIN files f ON f\.id = m\.file_id/,
  );
  assert.match(abort, /f\.size/);
  assert.match(abort, /legacyMetadataMissing/);
  assert.match(abort, /if \(completed\) throw error/);
});

test("multipart completion settles quota only after its upload CAS wins", async () => {
  const [storage, complete, abort] = await Promise.all([
    source("lib", "storage.ts"),
    source("app", "api", "uploads", "[id]", "complete", "route.ts"),
    source("app", "api", "uploads", "[id]", "abort", "route.ts"),
  ]);

  assert.match(
    complete,
    /SET status = 'ready'[\s\S]+status = 'uploading'[\s\S]+EXISTS \([\s\S]+FROM multipart_uploads[\s\S]+upload_id = \? AND storage_key = \?/,
  );
  assert.match(complete, /const completed = await db\.batch\(completedStatements\)/);
  assert.match(complete, /Number\(completed\[0\]\.meta\.changes \?\? 0\) !== 1/);
  assert.match(
    complete,
    /if \(finalFile\?\.status === "ready" && finalFile\.etag\)[\s\S]+await deleteCompletedObject\(\)/,
    "a concurrent completion winner must be returned before loser cleanup",
  );
  assert.match(
    storage,
    /storage_used = storage_used \+ \?[\s\S]+WHERE changes\(\) = 1/,
  );
  assert.match(
    storage,
    /used_bytes = used_bytes \+ \?[\s\S]+WHERE changes\(\) = 1/,
  );
  assert.doesNotMatch(complete, /SET status = 'failed'/);
  assert.doesNotMatch(abort, /SET status = 'failed'/);

  const abortBatch = abort.slice(abort.indexOf("const statements ="));
  assert.ok(
    abortBatch.indexOf("releaseUserStorageReservationStatement") <
      abortBatch.indexOf("DELETE FROM multipart_uploads"),
    "abort must release quota while multipart metadata still exists",
  );
  assert.ok(
    abortBatch.indexOf("DELETE FROM multipart_uploads") <
      abortBatch.indexOf("DELETE FROM files"),
    "abort must remove the unbilled file after releasing its reservation",
  );

  const expiredCleanup = storage.slice(
    storage.indexOf("export async function cleanupExpiredMultipartMetadata"),
    storage.indexOf("export async function releaseStorageNodeUsage"),
  );
  assert.doesNotMatch(expiredCleanup, /SELECT DISTINCT/);
  assert.doesNotMatch(expiredCleanup, /for \(const row/);
  assert.match(expiredCleanup, /await db\.batch\(\[/);
  assert.match(
    expiredCleanup,
    /DELETE FROM files[\s\S]+status = 'uploading'[\s\S]+SELECT file_id FROM multipart_uploads WHERE expires_at <= \?/,
  );
  assert.ok(
    expiredCleanup.indexOf("DELETE FROM files") <
      expiredCleanup.indexOf(
        'prepare("DELETE FROM multipart_uploads WHERE expires_at <= ?")',
      ),
    "expiry cleanup must release quota, delete the uploading file, then fall back to multipart deletion",
  );
  assert.doesNotMatch(expiredCleanup, /status = 'failed'/);

  const fileTransitionSql = sqlTemplateContaining(
    complete,
    "SET status = 'ready'",
  );
  const userSettlementSql = sqlTemplateContaining(
    storage,
    "storage_used = storage_used + ?",
  );
  const nodeSettlementSql = sqlTemplateContaining(
    storage,
    "used_bytes = used_bytes + ?",
  );
  const multipartDeleteSql = sqlTemplateContaining(
    complete,
    "WHERE file_id = ? AND owner_id = ? AND changes() = 1",
  );
  const expiredNodeSql = sqlTemplateContaining(
    storage,
    "reserved_bytes - COALESCE",
  );
  const expiredUserSql = sqlTemplateContaining(
    storage,
    "storage_reserved - COALESCE",
  );
  const expiredFileSql = sqlTemplateContaining(
    storage,
    "SELECT file_id FROM multipart_uploads WHERE expires_at <= ?",
  );

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        storage_reserved INTEGER NOT NULL,
        storage_used INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE storage_nodes (
        id TEXT PRIMARY KEY,
        reserved_bytes INTEGER NOT NULL,
        used_bytes INTEGER NOT NULL,
        last_health_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        etag TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE multipart_uploads (
        file_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        upload_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        storage_node_id TEXT,
        reserved_bytes INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      );
      INSERT INTO users
        VALUES ('owner', 10, 0, 'initial');
      INSERT INTO storage_nodes
        VALUES ('node', 10, 0, NULL, 'old error', 'initial');
      INSERT INTO files
        VALUES ('file', 'owner', 'file', 10, NULL, 'uploading', 'initial');
      INSERT INTO multipart_uploads
        VALUES ('file', 'owner', 'upload', 'owner/file/blob', 'node', 10, 'later');
    `);

    const finalize = (fileId) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const changes = [
          database
            .prepare(fileTransitionSql)
            .run(
              '"etag"',
              "now",
              fileId,
              "owner",
              "upload",
              "owner/file/blob",
            ).changes,
          database
            .prepare(userSettlementSql)
            .run(10, 10, "now", "owner", fileId, "owner").changes,
          database
            .prepare(nodeSettlementSql)
            .run(10, 10, "now", "now", "node", fileId, "owner", "node")
            .changes,
          database
            .prepare(multipartDeleteSql)
            .run(fileId, "owner").changes,
        ];
        database.exec("COMMIT");
        return changes;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };

    assert.deepEqual(finalize("file"), [1, 1, 1, 1]);
    assert.deepEqual(finalize("file"), [0, 0, 0, 0]);
    assert.equal(
      database
        .prepare(
          "SELECT storage_reserved, storage_used FROM users WHERE id = 'owner'",
        )
        .get().storage_used,
      10,
      "an idempotent completion retry must not bill storage twice",
    );
    assert.equal(
      database
        .prepare(
          "SELECT reserved_bytes, used_bytes FROM storage_nodes WHERE id = 'node'",
        )
        .get().used_bytes,
      10,
    );

    database.exec(`
      UPDATE users SET storage_reserved = 10, storage_used = 0;
      UPDATE storage_nodes SET reserved_bytes = 10, used_bytes = 0;
      DELETE FROM files;
      DELETE FROM multipart_uploads;
    `);
    assert.deepEqual(
      finalize("expired-file"),
      [0, 0, 0, 0],
      "expiry cleanup winning the race must prevent an untracked object from being billed or published",
    );
    assert.equal(
      database
        .prepare(
          "SELECT storage_reserved, storage_used FROM users WHERE id = 'owner'",
        )
        .get().storage_used,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT reserved_bytes, used_bytes FROM storage_nodes WHERE id = 'node'",
        )
        .get().used_bytes,
      0,
    );

    const expiredRows = 200;
    database.exec("BEGIN IMMEDIATE");
    try {
      const insertUser = database.prepare(
        "INSERT INTO users VALUES (?, 1, 0, 'initial')",
      );
      const insertNode = database.prepare(
        "INSERT INTO storage_nodes VALUES (?, 1, 0, NULL, NULL, 'initial')",
      );
      const insertFile = database.prepare(
        "INSERT INTO files VALUES (?, ?, 'file', 1, NULL, 'uploading', 'initial')",
      );
      const insertUpload = database.prepare(
        "INSERT INTO multipart_uploads VALUES (?, ?, ?, ?, ?, 1, 'expired')",
      );
      for (let index = 0; index < expiredRows; index += 1) {
        const ownerId = `owner-${index}`;
        const nodeId = `node-${index}`;
        const fileId = `expired-${index}`;
        insertUser.run(ownerId);
        insertNode.run(nodeId);
        insertFile.run(fileId, ownerId);
        insertUpload.run(
          fileId,
          ownerId,
          `upload-${index}`,
          `${ownerId}/${fileId}/blob`,
          nodeId,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const cleanupChanges = [
        database
          .prepare(expiredNodeSql)
          .run("zzzz", "cleanup", "zzzz").changes,
        database
          .prepare(expiredUserSql)
          .run("zzzz", "cleanup", "zzzz").changes,
        database.prepare(expiredFileSql).run("zzzz").changes,
        database
          .prepare("DELETE FROM multipart_uploads WHERE expires_at <= ?")
          .run("zzzz").changes,
      ];
      database.exec("COMMIT");
      assert.deepEqual(
        cleanupChanges,
        [expiredRows, expiredRows, expiredRows, expiredRows],
        "many accounts and nodes must still be cleaned with four set-based statements",
      );
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(
      database
        .prepare(
          "SELECT SUM(storage_reserved) AS total FROM users WHERE id LIKE 'owner-%'",
        )
        .get().total,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT SUM(reserved_bytes) AS total FROM storage_nodes WHERE id LIKE 'node-%'",
        )
        .get().total,
      0,
    );
  } finally {
    database.close();
  }
});

test("web admin cannot disconnect a node without the local inventory helper", async () => {
  const route = await source(
    "app",
    "api",
    "admin",
    "storage-nodes",
    "[id]",
    "route.ts",
  );
  const deleteHandler = route.slice(route.indexOf("export async function DELETE"));

  assert.match(deleteHandler, /"local_helper_required"/);
  assert.match(deleteHandler, /暂停新写入/);
  assert.match(deleteHandler, /本机启动器使用“一键卸载”/);
  assert.doesNotMatch(deleteHandler, /DELETE FROM storage_nodes/);
  assert.doesNotMatch(deleteHandler, /storage_quota = storage_quota -/);
  assert.doesNotMatch(deleteHandler, /storage_node\.disconnected/);
});

test("file tree writes enforce final status, parent, and sibling-name CAS", async () => {
  const [restore, item, files, upload] = await Promise.all([
    source("app", "api", "files", "[id]", "restore", "route.ts"),
    source("app", "api", "files", "[id]", "route.ts"),
    source("app", "api", "files", "route.ts"),
    source("app", "api", "uploads", "route.ts"),
  ]);

  assert.match(
    restore,
    /target_parent\(parent_id\)[\s\S]+parent\.status = 'ready'[\s\S]+root\.status = 'deleted'/,
  );
  assert.match(
    restore,
    /sibling\.normalized_name = root\.normalized_name[\s\S]+sibling\.status != 'deleted'/,
  );
  assert.match(
    restore,
    /WHERE owner_id = \? AND status = 'deleted'[\s\S]+id IN \(SELECT id FROM tree\)/,
  );
  assert.match(item, /file\.status !== "deleted" && file\.status !== "purging"/);
  assert.match(
    item,
    /WITH RECURSIVE\s+subtree\(id\)[\s\S]+child\.status = 'ready'[\s\S]+WHERE owner_id = \? AND status = 'ready'/,
  );
  assert.match(item, /Number\(results\[0\]\.meta\.changes \?\? 0\) === 0/);
  assert.match(
    item,
    /UPDATE files[\s\S]+WHERE id = \? AND owner_id = \? AND status = 'ready'[\s\S]+parent\.status = 'ready'[\s\S]+sibling\.normalized_name = \?/,
  );
  assert.match(
    item,
    /UPDATE files[\s\S]+WITH RECURSIVE descendants\(id\)[\s\S]+SELECT 1 FROM descendants WHERE id = \?/,
  );
  const updateConflictBranch = item.slice(
    item.indexOf("if (Number(updated.meta.changes"),
  );
  assert.match(
    updateConflictBranch,
    /current\.kind === "folder" && parentId[\s\S]+invalid_parent/,
  );
  assert.match(
    files,
    /INSERT INTO files[\s\S]+kind = 'folder' AND status = 'ready'[\s\S]+sibling\.normalized_name = \?/,
  );

  const restoreSql = sqlTemplateContaining(
    restore,
    "target_parent(parent_id) AS",
  );
  const trashSql = sqlTemplateContaining(item, "subtree(id) AS");
  const updateSql = sqlTemplateContaining(item, "SET name = ?");
  const folderSql = sqlTemplateContaining(files, "SELECT ?, ?, ?, 'folder'");
  const uploadSql = sqlTemplateContaining(upload, "SELECT ?, ?, ?, 'file'");

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        parent_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        storage_key TEXT,
        storage_node_id TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        content_type TEXT,
        etag TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE multipart_uploads (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        upload_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        storage_node_id TEXT,
        reserved_bytes INTEGER NOT NULL DEFAULT 0,
        part_size INTEGER NOT NULL,
        expected_parts INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE shares (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        file_id TEXT NOT NULL
      );
    `);
    const addFile = database.prepare(
      `INSERT INTO files (
         id, owner_id, parent_id, kind, name, normalized_name,
         status, created_at, updated_at, deleted_at
       ) VALUES (?, 'owner', ?, ?, ?, ?, ?, 'created', 'updated', ?)`,
    );
    addFile.run(
      "ready-parent",
      null,
      "folder",
      "Ready",
      "ready",
      "ready",
      null,
    );
    addFile.run(
      "deleted-parent",
      null,
      "folder",
      "Deleted",
      "deleted",
      "deleted",
      "deleted-at",
    );
    addFile.run(
      "purging-restore",
      "ready-parent",
      "file",
      "Purging",
      "purging",
      "purging",
      "purge:claim",
    );
    assert.equal(
      database
        .prepare(restoreSql)
        .run(
          "ready-parent",
          "ready-parent",
          "owner",
          "ready-parent",
          "purging-restore",
          "owner",
          "owner",
          "purging-restore",
          "now",
          "owner",
        ).changes,
      0,
      "a purge claim must not be restored",
    );
    assert.equal(
      database
        .prepare("SELECT status FROM files WHERE id = 'purging-restore'")
        .get().status,
      "purging",
    );

    addFile.run(
      "restore-root",
      "deleted-parent",
      "folder",
      "Restore",
      "restore",
      "deleted",
      "deleted-at",
    );
    addFile.run(
      "restore-purging-child",
      "restore-root",
      "file",
      "Claimed",
      "claimed",
      "purging",
      "purge:child",
    );
    assert.equal(
      database
        .prepare(restoreSql)
        .run(
          "deleted-parent",
          "deleted-parent",
          "owner",
          "deleted-parent",
          "restore-root",
          "owner",
          "owner",
          "restore-root",
          "now",
          "owner",
        ).changes,
      1,
    );
    const restoredRoot = database
      .prepare("SELECT parent_id, status FROM files WHERE id = 'restore-root'")
      .get();
    assert.equal(
      restoredRoot.parent_id,
      null,
      "a deleted parent must atomically fall back to the root",
    );
    assert.equal(restoredRoot.status, "ready");
    assert.equal(
      database
        .prepare(
          "SELECT status FROM files WHERE id = 'restore-purging-child'",
        )
        .get().status,
      "purging",
    );

    addFile.run(
      "restore-name-conflict",
      null,
      "file",
      "Conflict",
      "conflict",
      "ready",
      null,
    );
    addFile.run(
      "restore-conflicted-root",
      "deleted-parent",
      "file",
      "Conflict",
      "conflict",
      "deleted",
      "deleted-at",
    );
    assert.equal(
      database
        .prepare(restoreSql)
        .run(
          "deleted-parent",
          "deleted-parent",
          "owner",
          "deleted-parent",
          "restore-conflicted-root",
          "owner",
          "owner",
          "restore-conflicted-root",
          "now",
          "owner",
        ).changes,
      0,
      "restore must reject a sibling name at its final fallback parent",
    );
    assert.equal(
      database
        .prepare(
          "SELECT status FROM files WHERE id = 'restore-conflicted-root'",
        )
        .get().status,
      "deleted",
    );

    addFile.run(
      "trash-root",
      null,
      "folder",
      "Trash",
      "trash",
      "ready",
      null,
    );
    addFile.run(
      "trash-ready-child",
      "trash-root",
      "file",
      "Ready child",
      "ready-child",
      "ready",
      null,
    );
    addFile.run(
      "trash-purging-child",
      "trash-root",
      "file",
      "Purging child",
      "purging-child",
      "purging",
      "purge:child",
    );
    assert.equal(
      database
        .prepare(trashSql)
        .run(
          "trash-root",
          "owner",
          "owner",
          "trash-root",
          "owner",
          "owner",
          "now",
          "trash:claim",
          "owner",
        ).changes,
      2,
      "only ready rows in the tree may be claimed",
    );
    assert.equal(
      database
        .prepare(
          "SELECT status FROM files WHERE id = 'trash-purging-child'",
        )
        .get().status,
      "purging",
    );

    addFile.run(
      "busy-root",
      null,
      "folder",
      "Busy",
      "busy",
      "ready",
      null,
    );
    addFile.run(
      "busy-upload",
      "busy-root",
      "file",
      "Uploading",
      "uploading",
      "uploading",
      null,
    );
    database
      .prepare(
        `INSERT INTO multipart_uploads (
           id, owner_id, file_id, upload_id, storage_key, reserved_bytes,
           part_size, expected_parts, expires_at, created_at
         ) VALUES ('multipart', 'owner', 'busy-upload', 'upload', 'key',
                   1, 5, 1, 'later', 'now')`,
      )
      .run();
    assert.equal(
      database
        .prepare(trashSql)
        .run(
          "busy-root",
          "owner",
          "owner",
          "busy-root",
          "owner",
          "owner",
          "now",
          "trash:busy",
          "owner",
        ).changes,
      0,
      "a newly persisted multipart must block the final trash claim",
    );

    addFile.run(
      "rename-target",
      null,
      "file",
      "Target",
      "target",
      "purging",
      "purge:rename",
    );
    assert.equal(
      database
        .prepare(updateSql)
        .run(
          "Renamed",
          "renamed",
          null,
          0,
          "now",
          "rename-target",
          "owner",
          null,
          null,
          "owner",
          null,
          "rename-target",
          "owner",
          "owner",
          null,
          "owner",
          null,
          "renamed",
          "rename-target",
        ).changes,
      0,
      "rename/move must not mutate a purging row",
    );

    addFile.run(
      "duplicate-folder",
      "ready-parent",
      "folder",
      "Duplicate",
      "duplicate",
      "ready",
      null,
    );
    addFile.run(
      "rename-ready",
      null,
      "file",
      "Rename ready",
      "rename-ready",
      "ready",
      null,
    );
    assert.equal(
      database
        .prepare(updateSql)
        .run(
          "Duplicate",
          "duplicate",
          "ready-parent",
          0,
          "now",
          "rename-ready",
          "owner",
          "ready-parent",
          "ready-parent",
          "owner",
          "ready-parent",
          "rename-ready",
          "owner",
          "owner",
          "ready-parent",
          "owner",
          "ready-parent",
          "duplicate",
          "rename-ready",
        ).changes,
      0,
      "rename/move must atomically reject a sibling name",
    );
    assert.equal(
      database
        .prepare(updateSql)
        .run(
          "Rename ready",
          "rename-ready",
          "deleted-parent",
          0,
          "now",
          "rename-ready",
          "owner",
          "deleted-parent",
          "deleted-parent",
          "owner",
          "deleted-parent",
          "rename-ready",
          "owner",
          "owner",
          "deleted-parent",
          "owner",
          "deleted-parent",
          "rename-ready",
          "rename-ready",
        ).changes,
      0,
      "rename/move must atomically reject a non-ready parent",
    );
    assert.equal(
      database
        .prepare(folderSql)
        .run(
          "new-folder",
          "owner",
          "ready-parent",
          "Duplicate",
          "duplicate",
          "now",
          "now",
          "ready-parent",
          "ready-parent",
          "owner",
          "owner",
          "ready-parent",
          "duplicate",
        ).changes,
      0,
      "folder creation must atomically reject a sibling name",
    );
    assert.equal(
      database
        .prepare(uploadSql)
        .run(
          "new-upload",
          "owner",
          "deleted-parent",
          "Upload",
          "upload",
          "owner/new-upload/blob",
          null,
          10,
          "application/octet-stream",
          "now",
          "now",
          "deleted-parent",
          "deleted-parent",
          "owner",
          "owner",
          "deleted-parent",
          "upload",
        ).changes,
      0,
      "upload persistence must atomically reject a non-ready parent",
    );
  } finally {
    database.close();
  }
});

test("permanent purge discovers and settles a tree in fixed-size batches", async () => {
  const { permanentlyDeleteTree } = await purgeModule();
  const { database, db } = createPurgeDatabase();
  const rootId = "123e4567-e89b-42d3-a456-426614174000";
  const childCount = 1_201;
  const primaryObjects = new Set();
  try {
    database
      .prepare(
        "INSERT INTO users (id, storage_used, updated_at) VALUES (?, ?, ?)",
      )
      .run("owner", childCount, "initial");
    insertPurgeFile(database, {
      id: rootId,
      kind: "folder",
      storageKey: null,
    });
    database.exec("BEGIN");
    for (let index = 0; index < childCount; index += 1) {
      const id = `file-${String(index).padStart(4, "0")}`;
      const storageKey = `owner/${id}/blob`;
      insertPurgeFile(database, { id, parentId: rootId, storageKey });
      primaryObjects.add(storageKey);
    }
    database.exec("COMMIT");
    installPurgeHarness({ database, primaryObjects });

    const result = await permanentlyDeleteTree(db, "owner", rootId);

    assert.deepEqual(result, {
      deletedItems: childCount + 1,
      releasedBytes: childCount,
    });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM files").get().count,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT storage_used FROM users WHERE id = 'owner'")
        .get().storage_used,
      0,
    );
    assert.equal(primaryObjects.size, 0);
  } finally {
    database.close();
  }
});

test("a partial R2 failure stays purging and emptyTrash safely takes it over", async () => {
  const { emptyTrash, permanentlyDeleteTree } = await purgeModule();
  const { database, db } = createPurgeDatabase();
  const rootId = "223e4567-e89b-42d3-a456-426614174000";
  const nodeId = "323e4567-e89b-42d3-a456-426614174000";
  const primaryKey = "owner/primary/blob";
  const remoteKey = "owner/remote/blob";
  const primaryObjects = new Set([primaryKey]);
  const remoteObjects = new Map([[nodeId, new Set([remoteKey])]]);
  try {
    database
      .prepare(
        "INSERT INTO users (id, storage_used, updated_at) VALUES (?, ?, ?)",
      )
      .run("owner", 2, "initial");
    database
      .prepare(
        "INSERT INTO storage_nodes (id, used_bytes, updated_at) VALUES (?, ?, ?)",
      )
      .run(nodeId, 1, "initial");
    insertPurgeFile(database, {
      id: rootId,
      kind: "folder",
      storageKey: null,
    });
    insertPurgeFile(database, {
      id: "primary-file",
      parentId: rootId,
      storageKey: primaryKey,
    });
    insertPurgeFile(database, {
      id: "remote-file",
      parentId: rootId,
      storageKey: remoteKey,
      storageNodeId: nodeId,
    });
    installPurgeHarness({
      database,
      primaryObjects,
      remoteObjects,
      nodes: new Map([[nodeId, { id: nodeId }]]),
      failRemote: true,
    });

    await assert.rejects(() =>
      permanentlyDeleteTree(db, "owner", rootId),
    );
    const failedRows = database
      .prepare(
        `SELECT status, purge_operation_id, purge_root_id, purge_claim_token
         FROM files ORDER BY id`,
      )
      .all();
    assert.equal(failedRows.length, 3);
    assert.ok(failedRows.every((row) => row.status === "purging"));
    assert.ok(failedRows.every((row) => row.purge_operation_id));
    assert.ok(failedRows.every((row) => row.purge_root_id === rootId));
    assert.ok(failedRows.every((row) => row.purge_claim_token === null));
    assert.equal(primaryObjects.has(primaryKey), false);
    assert.equal(remoteObjects.get(nodeId).has(remoteKey), true);
    assert.equal(
      database
        .prepare("SELECT storage_used FROM users WHERE id = 'owner'")
        .get().storage_used,
      2,
    );

    purgeHarness.state.failRemote = false;
    const retried = await emptyTrash(db, "owner");
    assert.deepEqual(retried, { deletedItems: 3, releasedBytes: 2 });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM files").get().count,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT storage_used FROM users WHERE id = 'owner'")
        .get().storage_used,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT used_bytes FROM storage_nodes WHERE id = ?")
        .get(nodeId).used_bytes,
      0,
    );
    assert.equal(remoteObjects.get(nodeId).size, 0);
  } finally {
    database.close();
  }
});

test("a stale purging lease is taken over without returning rows to deleted", async () => {
  const { permanentlyDeleteTree } = await purgeModule();
  const { database, db } = createPurgeDatabase();
  const rootId = "423e4567-e89b-42d3-a456-426614174000";
  const operationId = "523e4567-e89b-42d3-a456-426614174000";
  const oldClaim = "623e4567-e89b-42d3-a456-426614174000";
  const storageKey = "owner/stale/blob";
  const primaryObjects = new Set([storageKey]);
  try {
    database
      .prepare(
        "INSERT INTO users (id, storage_used, updated_at) VALUES (?, ?, ?)",
      )
      .run("owner", 1, "initial");
    insertPurgeFile(database, {
      id: rootId,
      kind: "folder",
      status: "purging",
      operationId,
      rootId,
      claimToken: oldClaim,
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
    insertPurgeFile(database, {
      id: "stale-child",
      parentId: rootId,
      storageKey,
      status: "purging",
      operationId,
      rootId,
      claimToken: oldClaim,
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
    installPurgeHarness({ database, primaryObjects });

    const result = await permanentlyDeleteTree(db, "owner", rootId);

    assert.deepEqual(result, { deletedItems: 2, releasedBytes: 1 });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM files").get().count,
      0,
    );
    assert.equal(primaryObjects.size, 0);
  } finally {
    database.close();
  }
});

test("settlement charges only rows still owned by the current purge token", async () => {
  const { permanentlyDeleteTree } = await purgeModule();
  const { database, db } = createPurgeDatabase();
  const rootId = "723e4567-e89b-42d3-a456-426614174000";
  const firstKey = "owner/first/blob";
  const secondKey = "owner/second/blob";
  const primaryObjects = new Set([firstKey, secondKey]);
  try {
    database
      .prepare(
        "INSERT INTO users (id, storage_used, updated_at) VALUES (?, ?, ?)",
      )
      .run("owner", 2, "initial");
    insertPurgeFile(database, {
      id: rootId,
      kind: "folder",
      storageKey: null,
    });
    insertPurgeFile(database, {
      id: "first-file",
      parentId: rootId,
      storageKey: firstKey,
    });
    insertPurgeFile(database, {
      id: "second-file",
      parentId: rootId,
      storageKey: secondKey,
    });
    installPurgeHarness({
      database,
      primaryObjects,
      afterPrimaryDelete(currentDatabase) {
        currentDatabase
          .prepare(
            `UPDATE files
             SET status = 'ready',
                 purge_operation_id = NULL,
                 purge_root_id = NULL,
                 purge_claim_token = NULL
             WHERE id = 'first-file'`,
          )
          .run();
      },
    });

    const result = await permanentlyDeleteTree(db, "owner", rootId);

    assert.deepEqual(result, { deletedItems: 2, releasedBytes: 1 });
    const survivor = database
      .prepare(
        "SELECT status, purge_operation_id FROM files WHERE id = 'first-file'",
      )
      .get();
    assert.deepEqual(
      { status: survivor.status, operationId: survivor.purge_operation_id },
      { status: "ready", operationId: null },
    );
    assert.equal(
      database
        .prepare("SELECT storage_used FROM users WHERE id = 'owner'")
        .get().storage_used,
      1,
    );
  } finally {
    database.close();
  }
});

test("folder move CAS prevents a two-connection A-B cycle", async () => {
  const item = await source("app", "api", "files", "[id]", "route.ts");
  const updateSql = sqlTemplateContaining(item, "SET name = ?");
  const directory = await mkdtemp(path.join(tmpdir(), "r2-drive-cycle-"));
  const databasePath = path.join(directory, "cycle.sqlite");
  const first = new DatabaseSync(databasePath);
  const second = new DatabaseSync(databasePath);
  try {
    first.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        parent_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO files (
        id, owner_id, parent_id, kind, name, normalized_name, status, updated_at
      ) VALUES
        ('a', 'owner', NULL, 'folder', 'A', 'a', 'ready', 'initial'),
        ('b', 'owner', NULL, 'folder', 'B', 'b', 'ready', 'initial');
    `);

    const precheck = (database, id, parentId) =>
      database
        .prepare(
          `WITH RECURSIVE descendants(id) AS (
             SELECT id
             FROM files
             WHERE parent_id = ? AND owner_id = ? AND status = 'ready'
             UNION ALL
             SELECT child.id
             FROM files child
             JOIN descendants parent ON child.parent_id = parent.id
             WHERE child.owner_id = ? AND child.status = 'ready'
           )
           SELECT id FROM descendants WHERE id = ? LIMIT 1`,
        )
        .get(id, "owner", "owner", parentId);
    const move = (database, id, parentId, name) =>
      database
        .prepare(updateSql)
        .run(
          name,
          name.toLocaleLowerCase(),
          parentId,
          0,
          "moved",
          id,
          "owner",
          parentId,
          parentId,
          "owner",
          parentId,
          id,
          "owner",
          "owner",
          parentId,
          "owner",
          parentId,
          name.toLocaleLowerCase(),
          id,
        ).changes;

    assert.equal(precheck(first, "a", "b"), undefined);
    assert.equal(precheck(second, "b", "a"), undefined);
    assert.equal(move(first, "a", "b", "A"), 1);
    assert.equal(
      move(second, "b", "a", "B"),
      0,
      "the second connection must observe the first move in its final CAS",
    );
    assert.equal(
      second.prepare("SELECT parent_id FROM files WHERE id = 'b'").get()
        .parent_id,
      null,
    );

    first.exec("UPDATE files SET parent_id = NULL, updated_at = 'reset'");
    assert.equal(precheck(first, "a", "b"), undefined);
    assert.equal(precheck(second, "b", "a"), undefined);
    assert.equal(move(second, "b", "a", "B"), 1);
    assert.equal(
      move(first, "a", "b", "A"),
      0,
      "the opposite write order must also reject the second move",
    );
    assert.equal(
      first.prepare("SELECT parent_id FROM files WHERE id = 'a'").get()
        .parent_id,
      null,
    );
  } finally {
    second.close();
    first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloads and deletes route by file node without primary-bucket fallback", async () => {
  const [privateDownload, shareDownload, operations] = await Promise.all([
    source("app", "api", "files", "[id]", "download", "route.ts"),
    source(
      "app",
      "api",
      "public",
      "shares",
      "[token]",
      "download",
      "route.ts",
    ),
    source("lib", "file-operations.ts"),
  ]);

  for (const download of [privateDownload, shareDownload]) {
    assert.match(download, /storage_node_id/);
    assert.match(download, /getStorageNode\(/);
    assert.match(download, /getNodeObject\(/);
    assert.match(download, /storage_node_missing/);
  }
  assert.match(privateDownload, /nodeObjectResponseHeaders\(object\)/);
  assert.match(shareDownload, /nodeObjectResponseHeaders\(object\)/);
  assert.doesNotMatch(
    shareDownload,
    /startsDownload|bytes=0-/,
    "non-zero Range requests must not bypass a limited share download count",
  );
  assert.match(
    shareDownload,
    /UPDATE shares SET download_count = download_count \+ 1/,
  );
  assert.match(operations, /const remoteKeys = new Map<string, string\[\]>\(\)/);
  assert.match(operations, /deleteNodeObjects\([\s\S]+keys\.slice/);
  assert.match(operations, /status = 'purging'/);
  assert.match(operations, /const PURGE_BATCH_SIZE = 500/);
  assert.match(operations, /purge_operation_id/);
  assert.match(operations, /purge_root_id/);
  assert.match(operations, /purge_claim_token/);
  assert.match(
    operations,
    /const claimWhere = `[\s\S]+purge_claim_token = \?4/,
  );
  assert.match(
    operations,
    /SET used_bytes = MAX\([\s\S]+SELECT SUM\(size\)[\s\S]+WHERE \$\{claimWhere\}/,
  );
  assert.doesNotMatch(
    operations,
    /SET status = 'deleted'[\s\S]+status = 'purging'/,
    "failed irreversible deletion must never become restorable again",
  );
});

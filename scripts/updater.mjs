import { createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

export const UPDATE_REPOSITORY = "oleyyu/R2-Drive-New";
export const UPDATE_RELEASE_API_URL =
  `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;

const MAX_RELEASE_JSON_BYTES = 512 * 1024;
const MAX_RELEASE_ARCHIVE_BYTES = 100 * 1024 * 1024;
const PROTECTED_TOP_LEVEL = new Set([
  ".dev.vars",
  ".git",
  ".vinext",
  ".wrangler",
  "dist",
  "node_modules",
  "outputs",
  "work",
  "worker-configuration.d.ts",
  "wrangler.jsonc",
]);

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.update-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

export function normalizeVersion(value) {
  const match = String(value || "")
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${
      match[4] ? `-${match[4]}` : ""
    }`,
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || "",
  };
}

export function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) throw new Error("版本号格式无效。");
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return a.numbers[index] > b.numbers[index] ? 1 : -1;
    }
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function safeReleaseUrl(value, allowedHosts) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
    throw new Error("GitHub Release 返回了不受信任的下载地址。");
  }
  return url.toString();
}

export async function fetchLatestRelease(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(UPDATE_RELEASE_API_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "R2-Drive-Updater",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub 暂时无法检查更新（HTTP ${response.status}）。`);
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_RELEASE_JSON_BYTES) {
    throw new Error("GitHub 更新信息异常，已停止处理。");
  }
  const source = await response.text();
  if (Buffer.byteLength(source) > MAX_RELEASE_JSON_BYTES) {
    throw new Error("GitHub 更新信息过大，已停止处理。");
  }
  const payload = JSON.parse(source);
  const normalized = normalizeVersion(payload?.tag_name);
  if (
    !normalized ||
    typeof payload?.html_url !== "string" ||
    typeof payload?.tarball_url !== "string"
  ) {
    throw new Error("GitHub 最新 Release 信息不完整。");
  }
  return {
    version: normalized.text,
    tagName: `v${normalized.text}`,
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim().slice(0, 120)
        : `R2 Drive v${normalized.text}`,
    url: safeReleaseUrl(payload.html_url, new Set(["github.com"])),
    tarballUrl: safeReleaseUrl(
      payload.tarball_url,
      new Set(["api.github.com", "github.com"]),
    ),
    publishedAt:
      typeof payload.published_at === "string" ? payload.published_at : "",
  };
}

export async function downloadReleaseArchive(
  release,
  destination,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
) {
  const response = await fetchImpl(release.tarballUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "R2-Drive-Updater",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载更新包失败（HTTP ${response.status}）。`);
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_RELEASE_ARCHIVE_BYTES) {
    throw new Error("更新包超过 100 MiB 安全上限，已停止下载。");
  }

  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_RELEASE_ARCHIVE_BYTES) {
        callback(new Error("更新包超过 100 MiB 安全上限，已停止下载。"));
        return;
      }
      onProgress({
        received,
        total: declaredLength,
        percent: declaredLength ? Math.min(100, (received / declaredLength) * 100) : 0,
      });
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    meter,
    createWriteStream(destination, { mode: 0o600 }),
  );
  return { bytes: received };
}

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`更新包包含不允许的符号链接：${entry.name}`);
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(path.join(directory, entry.name));
    }
  }
}

function validateManagedName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    PROTECTED_TOP_LEVEL.has(name)
  ) {
    throw new Error(`更新清单包含不安全路径：${String(name)}`);
  }
  return name;
}

async function readReleaseManifest(root) {
  try {
    const manifest = await readJson(path.join(root, ".r2-drive-release.json"));
    if (!Array.isArray(manifest.managedTopLevel)) return [];
    return manifest.managedTopLevel.map(validateManagedName);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function validateReleaseTree(releaseRoot, expectedVersion) {
  await assertNoSymlinks(releaseRoot);
  const packageMetadata = await readJson(path.join(releaseRoot, "package.json"));
  const manifest = await readJson(path.join(releaseRoot, ".r2-drive-release.json"));
  const packageVersion = normalizeVersion(packageMetadata.version)?.text;
  const manifestVersion = normalizeVersion(manifest.version)?.text;
  const expected = normalizeVersion(expectedVersion)?.text;
  if (
    packageMetadata.name !== "r2-drive" ||
    !expected ||
    packageVersion !== expected ||
    manifestVersion !== expected
  ) {
    throw new Error("更新包身份或版本校验失败。");
  }
  for (const required of [
    "LICENSE",
    "scripts/setup.mjs",
    "worker/index.ts",
    "config/wrangler.default.jsonc",
    "wrangler.jsonc",
  ]) {
    if (!(await exists(path.join(releaseRoot, required)))) {
      throw new Error(`更新包缺少必要文件：${required}`);
    }
  }
  await readReleaseManifest(releaseRoot);
  return { version: expected };
}

export async function extractReleaseArchive(archivePath, releaseRoot, expectedVersion) {
  await mkdir(releaseRoot, { recursive: true });
  await tar.x({
    file: archivePath,
    cwd: releaseRoot,
    strip: 1,
    strict: true,
    preservePaths: false,
  });
  return validateReleaseTree(releaseRoot, expectedVersion);
}

export function mergeInstanceConfig(releaseDefaults, currentConfig) {
  const merged = {
    ...releaseDefaults,
    ...currentConfig,
    vars: {
      ...(releaseDefaults.vars || {}),
      ...(currentConfig.vars || {}),
    },
  };
  for (const key of [
    "$schema",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "placement",
    "observability",
  ]) {
    if (releaseDefaults[key] !== undefined) merged[key] = releaseDefaults[key];
  }
  return merged;
}

export async function createUpdateWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), "r2-drive-update-"));
  return {
    workspace,
    archivePath: path.join(workspace, "release.tar.gz"),
    releaseRoot: path.join(workspace, "release"),
    backupRoot: path.join(workspace, "backup"),
  };
}

export async function applyReleaseTree({ root, releaseRoot, backupRoot }) {
  const currentManifest = await readReleaseManifest(root);
  const releaseManifest = await readReleaseManifest(releaseRoot);
  const releaseEntries = (await readdir(releaseRoot))
    .filter((name) => !PROTECTED_TOP_LEVEL.has(name))
    .map(validateManagedName);
  const managed = [
    ...new Set([...currentManifest, ...releaseManifest, ...releaseEntries]),
  ].sort();
  const transaction = {
    root,
    releaseRoot,
    backupRoot,
    managed,
    processed: [],
    existed: new Set(),
  };
  await mkdir(path.join(backupRoot, "managed"), { recursive: true });
  await cp(path.join(root, "wrangler.jsonc"), path.join(backupRoot, "wrangler.jsonc"));

  try {
    for (const name of managed) {
      const target = path.join(root, name);
      const backup = path.join(backupRoot, "managed", name);
      const source = path.join(releaseRoot, name);
      if (await exists(target)) {
        transaction.existed.add(name);
        await mkdir(path.dirname(backup), { recursive: true });
        await cp(target, backup, { recursive: true });
      }
      transaction.processed.push(name);
      await rm(target, { recursive: true, force: true });
      if (await exists(source)) {
        await cp(source, target, { recursive: true });
      }
    }

    const [releaseDefaults, currentConfig] = await Promise.all([
      readJson(path.join(releaseRoot, "wrangler.jsonc")),
      readJson(path.join(backupRoot, "wrangler.jsonc")),
    ]);
    await writeJsonAtomic(
      path.join(root, "wrangler.jsonc"),
      mergeInstanceConfig(releaseDefaults, currentConfig),
    );

    const backedUpCors = path.join(
      backupRoot,
      "managed",
      "config",
      "r2-cors.local.json",
    );
    if (await exists(backedUpCors)) {
      const targetCors = path.join(root, "config", "r2-cors.local.json");
      await mkdir(path.dirname(targetCors), { recursive: true });
      await cp(backedUpCors, targetCors);
    }
    return transaction;
  } catch (error) {
    await rollbackReleaseTree(transaction).catch(() => {});
    throw error;
  }
}

export async function rollbackReleaseTree(transaction) {
  for (const name of [...transaction.processed].reverse()) {
    const target = path.join(transaction.root, name);
    const backup = path.join(transaction.backupRoot, "managed", name);
    await rm(target, { recursive: true, force: true });
    if (transaction.existed.has(name) && (await exists(backup))) {
      await cp(backup, target, { recursive: true });
    }
  }
  await cp(
    path.join(transaction.backupRoot, "wrangler.jsonc"),
    path.join(transaction.root, "wrangler.jsonc"),
  );
}

export async function removeUpdateWorkspace(workspace) {
  await rm(workspace, { recursive: true, force: true });
}

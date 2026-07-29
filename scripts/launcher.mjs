#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  randomBytes,
  sign as signBytes,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findD1DatabaseByName, parseWranglerJson } from "./wrangler-output.mjs";
import {
  assertPrimaryBucketOwnership,
  assertPrimaryWorkerOwnership,
  createPrimaryWorkerChallenge,
  PRIMARY_WORKER_IDENTITY_PATH,
  primaryProvisioningCleanupPlan,
  primaryBucketOwnershipBody,
  readPrimaryOwnershipIntent,
  validatePrimaryOwnershipIntent,
} from "./primary-ownership.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "config", "wrangler.default.jsonc");
const PRIMARY_OWNERSHIP_PATH = path.join(
  ROOT,
  ".wrangler",
  "primary-ownership.json",
);
const STORAGE_POOL_INVENTORY_PATH = path.join(
  ROOT,
  ".wrangler",
  "storage-pool",
  "nodes.json",
);
const STORAGE_POOL_PRIVATE_JWK_PATH = path.join(
  ROOT,
  ".wrangler",
  "storage-pool",
  "private-jwk.json",
);
const PURGE_HELPER_JOURNAL_PATH = path.join(
  ROOT,
  ".wrangler",
  "uninstall",
  "purge-helper.json",
);
const SETUP_URL = "http://127.0.0.1:8788/";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const D1_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_PATTERN = /^(?:default|r2drive-node-[a-f0-9]{8,20})$/;
const RESOURCE_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const BUCKET_OWNERSHIP_PROTOCOL = "r2drive-storage-bucket-v1";
const BUCKET_OWNERSHIP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STORAGE_CAPABILITY_VERSION = "2";
const STORAGE_CAPABILITY_PREFIX = "r2drive-storage-capability-v2";
const STORAGE_CAPABILITY_UNSIGNED_BODY = "UNSIGNED-PAYLOAD";
const PURGE_HELPER_JOURNAL_VERSION = 1;
const PURGE_HELPER_NAME_PATTERN = /^r2-drive-purge-[a-f0-9]{32}$/;
const PURGE_HELPER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
// A "* * * * *" trigger fires at the next minute boundary, so one round has to
// tolerate roughly a minute of waiting before the helper runs at all.
const PURGE_ROUND_TIMEOUT_MS = 240_000;
const MAX_PURGE_ROUNDS = 10;
const MAX_UPLOADS_PER_ROUND = 40;
const MAX_PREFIXES_PER_ROUND = 75;
const AUTH_ENVIRONMENT_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_EMAIL",
];
let dependenciesChecked = false;
let setupHelperProcess;

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function cleanOutput(value) {
  return String(value).replace(
    new RegExp(
      String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
      "g",
    ),
    "",
  );
}

async function readConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

export function describeInstance(config) {
  const d1 = config.d1_databases?.[0] ?? {};
  const r2 = config.r2_buckets?.[0] ?? {};
  const accountId = String(config.account_id || config.vars?.R2_ACCOUNT_ID || "");
  const d1Id = String(d1.database_id || "");
  const r2Name = String(r2.bucket_name || config.vars?.R2_BUCKET_NAME || "");
  const workerName = String(config.name || "r2-drive");
  const customHostname = String(
    config.routes?.find((route) => route?.custom_domain)?.pattern || "",
  );
  return {
    configured:
      ACCOUNT_ID_PATTERN.test(accountId) &&
      D1_ID_PATTERN.test(d1Id) &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(r2Name),
    accountId,
    d1Id,
    d1Name: String(d1.database_name || "r2-drive-db"),
    r2Name,
    workerName,
    customHostname,
  };
}

export function driveEntryUrl(instance) {
  return instance.customHostname ? `https://${instance.customHostname}/start` : "";
}

export function assertPrimaryOwnershipMatchesInstance(source, instance) {
  const ownership = validatePrimaryOwnershipIntent(source);
  if (
    ownership.accountId !== String(instance.accountId).toLowerCase() ||
    ownership.r2Name !== instance.r2Name ||
    ownership.workerName !== instance.workerName ||
    ownership.d1Id !== String(instance.d1Id).toLowerCase() ||
    typeof ownership.managedBucket !== "boolean"
  ) {
    throw new Error(
      "本机主资源归属凭证与 account、Worker、R2 或 exact D1 database_id 不一致；未执行任何删除。",
    );
  }
  return ownership;
}

function runProcess(program, args, options = {}) {
  return new Promise((resolve) => {
    const hasInput = options.input !== undefined;
    const child = spawn(program, args, {
      cwd: options.cwd ?? ROOT,
      env: options.replaceEnv
        ? options.env
        : { ...process.env, ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: options.capture
        ? [hasInput ? "pipe" : "ignore", "pipe", "pipe"]
        : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += cleanOutput(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += cleanOutput(chunk);
      });
    }
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (hasInput) {
      // Wrangler can fail validation before reading stdin. Swallow the
      // resulting EPIPE here; its exit code and stderr remain the real error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
  });
}

async function ensureDependencies() {
  if (dependenciesChecked) return;
  console.log("\n正在检查项目组件，第一次运行可能需要几分钟…");
  const result = await runProcess(executable("npm"), [
    "install",
    "--no-audit",
    "--no-fund",
  ]);
  if (result.code !== 0) {
    throw new Error("项目组件安装失败。请检查网络、磁盘空间或 Node.js 版本。");
  }
  dependenciesChecked = true;
}

async function openBrowser(url) {
  let child;
  if (process.platform === "darwin") {
    child = spawn("open", [url], { stdio: "ignore", detached: true });
  } else if (process.platform === "win32") {
    child = spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`], {
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    });
  } else {
    child = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  }
  child.unref();
}

async function pageContains(url, marker, timeoutMs = 2_000) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return response.ok && text.includes(marker);
  } catch {
    return false;
  }
}

async function setupHelperIsCurrent() {
  try {
    const [response, packageMetadata] = await Promise.all([
      fetch(`${SETUP_URL}api/status`, {
        redirect: "follow",
        signal: AbortSignal.timeout(2_000),
      }),
      readFile(path.join(ROOT, "package.json"), "utf8").then(JSON.parse),
    ]);
    const status = await response.json();
    return response.ok && status.runtimeVersion === packageMetadata.version;
  } catch {
    return false;
  }
}

async function ensureSetupHelper() {
  if (await setupHelperIsCurrent()) return;
  await stopOwnedService(8788, "setup");
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "scripts", "setup.mjs"), "--no-open"],
    {
      cwd: ROOT,
      env: process.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  let startError = "";
  child.once("error", (error) => {
    startError = error.message;
  });
  setupHelperProcess = child;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (startError) {
      throw new Error(`本地域名配置助手没有成功启动：${startError}`);
    }
    if (child.exitCode !== null) {
      throw new Error("本地域名配置助手没有成功启动。请改选菜单 2 后重试。");
    }
    if (await pageContains(SETUP_URL, "R2 Drive · 本地安装向导")) {
      console.log("✓ 域名配置助手已在管理页面待命。");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill("SIGTERM");
  throw new Error("本地域名配置助手启动超时。请改选菜单 2 后重试。");
}

async function captureProcess(program, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: ROOT,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += cleanOutput(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += cleanOutput(chunk);
    });
    child.on("error", (error) =>
      finish({ code: null, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

async function listeningProcessIds(port) {
  let result;
  if (process.platform === "win32") {
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
      `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    ].join("; ");
    result = await captureProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
    );
  } else {
    result = await captureProcess("lsof", [
      "-nP",
      "-t",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
    ]);
  }
  return [
    ...new Set(
      result.stdout
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

async function processMetadata(pid) {
  if (process.platform === "win32") {
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
      `$item = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      "if ($item) { $item.CommandLine }",
    ].join("; ");
    const result = await captureProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
    );
    return { command: result.stdout.trim(), cwd: "" };
  }
  const [commandResult, cwdResult] = await Promise.all([
    captureProcess("ps", ["-p", String(pid), "-o", "command="]),
    captureProcess("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
  ]);
  const cwdLine = cwdResult.stdout.split("\n").find((line) => line.startsWith("n"));
  return {
    command: commandResult.stdout.trim(),
    cwd: cwdLine ? cwdLine.slice(1).trim() : "",
  };
}

function normalizedPath(value) {
  return String(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function isOwnedProcess(metadata, kind) {
  const command = normalizedPath(metadata.command);
  const root = normalizedPath(path.resolve(ROOT));
  const cwdMatches = normalizedPath(metadata.cwd) === root;
  const projectCommand = command.includes(root);
  const matchesKind =
    kind === "drive"
      ? command.includes("vinext") && /(?:^|\s)dev(?:\s|$)/i.test(metadata.command)
      : command.includes("scripts/setup.mjs");
  return matchesKind && (process.platform === "win32" ? projectCommand : cwdMatches);
}

async function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await processIsRunning(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await processIsRunning(pid));
}

async function stopOwnedService(port, kind) {
  const pids = await listeningProcessIds(port);
  if (pids.length === 0) return;
  const owned = [];
  for (const pid of pids) {
    if (isOwnedProcess(await processMetadata(pid), kind)) owned.push(pid);
  }
  if (owned.length !== pids.length) {
    throw new Error(`本地端口 ${port} 被其他软件占用。请先关闭该软件再继续。`);
  }
  for (const pid of owned) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  for (const pid of owned) {
    if (await waitForProcessExit(pid, 2_500)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await waitForProcessExit(pid, 1_500);
  }
}

async function openDrive(instance) {
  if (!instance.configured) {
    console.log("\n尚未完成配置。请先选择 2，跟着安装助手完成设置。");
    return;
  }
  if (!instance.customHostname) {
    console.log("\n当前实例没有绑定域名，因此不能发布或使用 R2 Drive。");
    await ensureDependencies();
    await ensureSetupHelper();
    await openBrowser(`${SETUP_URL}?step=domain`);
    console.log("✓ 已打开域名配置页；没有付费域名时可按 DPDNS 免费域名教程继续。");
    return;
  }
  const url = driveEntryUrl(instance);
  console.log(`\n正在检查域名网盘 ${instance.customHostname}…`);
  if (!(await pageContains(url, "R2 Drive", 15_000))) {
    throw new Error(
      `域名网盘 ${instance.customHostname} 暂时没有正常响应。请先选择 2 查看域名发布状态。`,
    );
  }
  await ensureSetupHelper();
  await openBrowser(url);
  console.log("\n✓ 已打开域名网盘。主人账号和密码只保存在这一份线上网盘中。");
}

async function openSetup() {
  await ensureDependencies();
  await ensureSetupHelper();
  await openBrowser(SETUP_URL);
  console.log("\n✓ 已使用当前版本打开配置助手。");
}

async function openUpdater() {
  await ensureDependencies();
  await ensureSetupHelper();
  await openBrowser(`${SETUP_URL}?step=update`);
  console.log("\n✓ 已打开程序更新页面。检查版本不会修改任何文件；安装前会再次要求确认。");
}

export function encodeR2ObjectKey(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}

export function validateWranglerProfile(value) {
  const profile = String(value || "");
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error("Wrangler 登录配置名称无效，已停止以避免使用错误账号。");
  }
  return profile;
}

function validateAccountId(value) {
  const accountId = String(value || "");
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("Cloudflare Account ID 无效，已停止以避免误删。");
  }
  return accountId.toLowerCase();
}

function validateResourceName(value, label) {
  const name = String(value || "");
  if (!RESOURCE_NAME_PATTERN.test(name)) {
    throw new Error(`${label}名称无效，已停止以避免误删。`);
  }
  return name;
}

function validateStorageNodeEndpoint(value, workerName, allowEmpty = false) {
  if (allowEmpty && (value === undefined || value === null || value === "")) {
    return "";
  }
  let endpoint;
  try {
    endpoint = new URL(String(value || ""));
  } catch {
    throw new Error("存储节点 workers.dev 地址无效，已停止以避免删除错误 Worker。");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.hostname.endsWith(".workers.dev") ||
    endpoint.hostname.split(".")[0] !== workerName
  ) {
    throw new Error("存储节点 workers.dev 地址与 Worker 名称不匹配，已停止卸载。");
  }
  return endpoint.origin;
}

function validateBucketOwnershipFields(nodeId, markerKey, markerToken) {
  const expectedPrefix = `.r2-drive-storage-node/${nodeId}/`;
  const suffix =
    typeof markerKey === "string" && markerKey.startsWith(expectedPrefix)
      ? markerKey.slice(expectedPrefix.length)
      : "";
  if (
    !UUID_PATTERN.test(nodeId) ||
    !/^[a-f0-9]{32}\.json$/.test(suffix) ||
    typeof markerToken !== "string" ||
    !BUCKET_OWNERSHIP_TOKEN_PATTERN.test(markerToken)
  ) {
    throw new Error("受管 R2 存储桶缺少有效归属标记，已停止卸载以保护现有数据。");
  }
  return { markerKey, markerToken };
}

export function storageBucketOwnershipBody(node) {
  const { markerToken } = validateBucketOwnershipFields(
    node.id,
    node.bucketOwnershipMarkerKey,
    node.bucketOwnershipMarkerToken,
  );
  return `${JSON.stringify({
    protocol: BUCKET_OWNERSHIP_PROTOCOL,
    nodeId: node.id,
    accountId: validateAccountId(node.accountId),
    bucketName: validateResourceName(node.bucketName, "节点 R2 存储桶"),
    workerName: validateResourceName(node.workerName, "节点 Worker"),
    token: markerToken,
  })}\n`;
}

export function assertManagedBucketOwnership(node, markerBody) {
  if (markerBody !== storageBucketOwnershipBody(node)) {
    throw new Error(
      `受管 R2 存储桶 ${node.bucketName} 的随机归属标记不匹配；它可能已被同名重建，未删除任何内容。`,
    );
  }
}

export function assertStorageNodeWorkerIdentity(node, health) {
  if (
    !health ||
    typeof health !== "object" ||
    health.ok !== true ||
    health.nodeId !== node.id ||
    health.protocol !== "r2drive-storage-node-v1"
  ) {
    throw new Error(
      `节点 Worker ${node.workerName} 没有返回原安装身份；它可能已被同名重建，已停止卸载。`,
    );
  }
}

function wranglerEnvironment(accountId) {
  const environment = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: validateAccountId(accountId),
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  // Every uninstall command is tied to an explicit Wrangler profile. Removing
  // token-style overrides prevents a shell variable from silently selecting a
  // different login than the inventory records.
  for (const name of AUTH_ENVIRONMENT_NAMES) delete environment[name];
  return environment;
}

async function runWrangler(args, target, options = {}) {
  if (
    args.some(
      (argument) =>
        argument === "--profile" || String(argument).startsWith("--profile="),
    )
  ) {
    throw new Error("Wrangler profile 必须通过已验证的独立参数传入。");
  }
  const profile = validateWranglerProfile(options.profile ?? "default");
  const result = await runProcess(
    executable("npx"),
    ["--no-install", "wrangler", ...args, "--profile", profile],
    {
      capture: true,
      env: wranglerEnvironment(target.accountId),
      replaceEnv: true,
      input: options.input,
    },
  );
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

export function validateStoragePoolInventory(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !Array.isArray(value.nodes)
  ) {
    throw new Error("本机存储节点清单无效，已停止以避免遗漏其他账号的数据。");
  }
  const nodeIds = new Set();
  const buckets = new Set();
  const workers = new Set();
  const nodes = value.nodes.map((rawNode) => {
    if (!rawNode || typeof rawNode !== "object") {
      throw new Error("本机存储节点清单含有无效记录，已停止卸载。");
    }
    const id = String(rawNode.id || "").toLowerCase();
    if (!UUID_PATTERN.test(id) || nodeIds.has(id)) {
      throw new Error("本机存储节点清单的 Node ID 无效或重复，已停止卸载。");
    }
    nodeIds.add(id);
    const profile = validateWranglerProfile(rawNode.profile);
    const accountId = validateAccountId(rawNode.accountId);
    const bucketName = validateResourceName(rawNode.bucketName, "节点 R2 存储桶");
    const workerName = validateResourceName(rawNode.workerName, "节点 Worker");
    if (
      typeof rawNode.managedBucket !== "boolean" ||
      typeof rawNode.managedWorker !== "boolean"
    ) {
      throw new Error("本机存储节点清单缺少资源归属信息，已停止卸载。");
    }
    const bucketKey = `${accountId}\u0000${bucketName}`;
    const workerKey = `${accountId}\u0000${workerName}`;
    if (buckets.has(bucketKey) || workers.has(workerKey)) {
      throw new Error("本机存储节点清单含有重复远端资源，已停止卸载。");
    }
    buckets.add(bucketKey);
    workers.add(workerKey);
    const suppliedLabel =
      typeof rawNode.label === "string" ? rawNode.label.trim() : "";
    if (
      suppliedLabel.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(suppliedLabel)
    ) {
      throw new Error("本机存储节点清单含有无效显示名称，已停止卸载。");
    }
    const status =
      rawNode.status === undefined ? "active" : String(rawNode.status);
    if (!["provisioning", "pending", "active"].includes(status)) {
      throw new Error("本机存储节点清单含有无效状态，已停止卸载。");
    }
    const uninstallCompletedAt =
      typeof rawNode.uninstallCompletedAt === "string" &&
      Number.isFinite(Date.parse(rawNode.uninstallCompletedAt))
        ? rawNode.uninstallCompletedAt
        : null;
    const endpoint = validateStorageNodeEndpoint(
      rawNode.endpoint,
      workerName,
      status === "provisioning" || Boolean(uninstallCompletedAt),
    );
    let bucketOwnershipMarkerKey = rawNode.bucketOwnershipMarkerKey;
    let bucketOwnershipMarkerToken = rawNode.bucketOwnershipMarkerToken;
    if (
      rawNode.managedBucket &&
      !uninstallCompletedAt
    ) {
      const marker = validateBucketOwnershipFields(
        id,
        bucketOwnershipMarkerKey,
        bucketOwnershipMarkerToken,
      );
      bucketOwnershipMarkerKey = marker.markerKey;
      bucketOwnershipMarkerToken = marker.markerToken;
    } else if (
      bucketOwnershipMarkerKey !== undefined ||
      bucketOwnershipMarkerToken !== undefined
    ) {
      const marker = validateBucketOwnershipFields(
        id,
        bucketOwnershipMarkerKey,
        bucketOwnershipMarkerToken,
      );
      bucketOwnershipMarkerKey = marker.markerKey;
      bucketOwnershipMarkerToken = marker.markerToken;
    }
    return {
      ...rawNode,
      id,
      label: suppliedLabel || workerName,
      profile,
      accountId,
      bucketName,
      workerName,
      endpoint,
      managedBucket: rawNode.managedBucket,
      managedWorker: rawNode.managedWorker,
      bucketOwnershipMarkerKey,
      bucketOwnershipMarkerToken,
      status,
      uninstallCompletedAt,
    };
  });
  return { ...value, version: 1, nodes };
}

async function readStoragePoolInventory() {
  try {
    return validateStoragePoolInventory(
      JSON.parse(await readFile(STORAGE_POOL_INVENTORY_PATH, "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: 1, nodes: [], updatedAt: new Date().toISOString() };
    }
    if (error instanceof SyntaxError) {
      throw new Error("本机存储节点清单不是有效 JSON，已停止卸载。");
    }
    throw error;
  }
}

async function writeStoragePoolInventory(inventory) {
  const temporary = `${STORAGE_POOL_INVENTORY_PATH}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          ...inventory,
          version: 1,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, STORAGE_POOL_INVENTORY_PATH);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function markStorageNodeUninstalled(inventory, nodeId) {
  const node = inventory.nodes.find((item) => item.id === nodeId);
  if (!node) {
    throw new Error("卸载进度无法写回存储节点清单，已保留 D1 供重试。");
  }
  node.uninstallCompletedAt = new Date().toISOString();
  await writeStoragePoolInventory(inventory);
}

function isMissingCloudflareResource(output) {
  return /does not exist|not found|NoSuchBucket|has no deployments|No deployments? (?:are|is) available|code:\s*1000[67]/i.test(
    output,
  );
}

function isR2BucketNotEmpty(output) {
  return /code:\s*10008|bucket.+not empty|bucket.+isn.t empty/i.test(output);
}

function d1ResultRows(output) {
  const payload = parseWranglerJson(output, "Wrangler D1");
  return Array.isArray(payload)
    ? payload.flatMap((entry) =>
        Array.isArray(entry?.results) ? entry.results : [],
      )
    : [];
}

async function executeD1UninstallQuery(instance, sql) {
  const result = await runWrangler(
    [
      "d1",
      "execute",
      instance.d1Name,
      "--remote",
      "--command",
      sql,
      "--json",
      "--config",
      CONFIG_PATH,
    ],
    instance,
  );
  if (result.code !== 0) {
    const error = new Error(
      `无法读取卸载所需的 D1 记录：${result.output.trim().slice(-500)}`,
    );
    error.cloudflareOutput = result.output;
    throw error;
  }
  return d1ResultRows(result.output);
}

function d1ManagedFlag(value, label) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new Error(`D1 存储节点的 ${label} 标记无效，已停止卸载。`);
}

export function reconcileStorageNodeInventory(inventoryValue, d1Rows) {
  const inventory = validateStoragePoolInventory(inventoryValue);
  if (!Array.isArray(d1Rows)) {
    throw new Error("D1 存储节点清单无效，已停止卸载。");
  }

  const remoteIds = new Set();
  const remoteBuckets = new Set();
  const remoteWorkers = new Set();
  const remoteNodes = d1Rows.map((row) => {
    if (!row || typeof row !== "object") {
      throw new Error("D1 存储节点清单含有无效记录，已停止卸载。");
    }
    const id = String(row.id || "").toLowerCase();
    const accountId = validateAccountId(row.account_id);
    const bucketName = validateResourceName(row.bucket_name, "D1 R2 存储桶");
    const workerName = validateResourceName(row.worker_name, "D1 Worker");
    const bucketKey = `${accountId}\u0000${bucketName}`;
    const workerKey = `${accountId}\u0000${workerName}`;
    if (
      !UUID_PATTERN.test(id) ||
      remoteIds.has(id) ||
      remoteBuckets.has(bucketKey) ||
      remoteWorkers.has(workerKey)
    ) {
      throw new Error("D1 存储节点清单含有重复或无效资源，已停止卸载。");
    }
    remoteIds.add(id);
    remoteBuckets.add(bucketKey);
    remoteWorkers.add(workerKey);
    return {
      id,
      accountId,
      bucketName,
      workerName,
      managedBucket: d1ManagedFlag(row.managed_bucket, "managed_bucket"),
      managedWorker: d1ManagedFlag(row.managed_worker, "managed_worker"),
    };
  });

  const localById = new Map(inventory.nodes.map((node) => [node.id, node]));
  const remoteById = new Map(remoteNodes.map((node) => [node.id, node]));
  const missingLocally = remoteNodes.filter((node) => !localById.has(node.id));
  const missingRemotely = inventory.nodes.filter(
    (node) => !remoteById.has(node.id) && node.status === "active",
  );
  if (missingLocally.length || missingRemotely.length) {
    throw new Error(
      "本机节点清单与主 D1 的 storage_nodes 不一致；为避免遗漏其他账号资源，已停止卸载。",
    );
  }

  for (const local of inventory.nodes) {
    const remote = remoteById.get(local.id);
    if (!remote) {
      // Provisioning intent is deliberately written before the first remote
      // mutation. A crash before enrollment leaves a local-only record that
      // uninstall must be able to recover. Active nodes never get this escape.
      continue;
    }
    if (
      remote.accountId !== local.accountId ||
      remote.bucketName !== local.bucketName ||
      remote.workerName !== local.workerName ||
      remote.managedBucket !== local.managedBucket ||
      remote.managedWorker !== local.managedWorker
    ) {
      throw new Error(
        `附加节点 ${local.label} 的本机清单与主 D1 资源归属不一致，已停止卸载。`,
      );
    }
  }
  return remoteNodes;
}

async function readD1StorageNodesForUninstall(instance) {
  try {
    return await executeD1UninstallQuery(
      instance,
      `
        SELECT id, account_id, bucket_name, worker_name,
               managed_bucket, managed_worker
        FROM storage_nodes
        ORDER BY id
      `,
    );
  } catch (error) {
    const detail = String(error?.cloudflareOutput || error?.message || "");
    if (/no such table:\s*storage_nodes/i.test(detail)) return [];
    throw error;
  }
}

function validatedCleanupRows(rows, requireUuidPrefixes) {
  const uploads = [];
  const prefixes = new Set();
  for (const row of rows) {
    const ownerId = String(row?.owner_id || "").toLowerCase();
    if (ownerId) {
      if (!UUID_PATTERN.test(ownerId)) {
        if (requireUuidPrefixes) {
          throw new Error("D1 中存在无效 owner UUID，已停止以保护共用 R2 存储桶。");
        }
      } else {
        prefixes.add(`${ownerId}/`);
      }
    }
    if (row?.record_type !== "upload") continue;
    const uploadId =
      typeof row.upload_id === "string" ? row.upload_id : "";
    const storageKey =
      typeof row.storage_key === "string" ? row.storage_key : "";
    if (
      !uploadId ||
      !storageKey ||
      uploadId.length > 1_024 ||
      storageKey.length > 1_024 ||
      /[\u0000\r\n]/.test(uploadId) ||
      /[\u0000\r\n]/.test(storageKey)
    ) {
      throw new Error("D1 中存在无效分片上传记录，已停止以避免清理错误对象。");
    }
    if (requireUuidPrefixes) {
      const ownerPrefix = storageKey.split("/", 1)[0].toLowerCase();
      if (!UUID_PATTERN.test(ownerPrefix)) {
        throw new Error("共用 R2 的分片 key 不以 owner UUID 开头，已停止卸载。");
      }
      prefixes.add(`${ownerPrefix}/`);
    }
    uploads.push({ storageKey, uploadId });
  }
  return {
    uploads: [
      ...new Map(
        uploads.map((upload) => [
          `${upload.storageKey}\u0000${upload.uploadId}`,
          upload,
        ]),
      ).values(),
    ].sort((left, right) => {
      const leftKey = `${left.storageKey}\u0000${left.uploadId}`;
      const rightKey = `${right.storageKey}\u0000${right.uploadId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
    prefixes: [...prefixes].sort(),
  };
}

async function storageCleanupPlan(instance, storageNodeId, managedBucket) {
  const predicate = storageNodeId
    ? `= '${storageNodeId}'`
    : "IS NULL";
  const modernSql = `
    SELECT 'upload' AS record_type, owner_id, storage_key, upload_id
    FROM multipart_uploads
    WHERE storage_node_id ${predicate}
    UNION ALL
    SELECT 'owner' AS record_type, owner_id, '' AS storage_key, '' AS upload_id
    FROM files
    WHERE storage_node_id ${predicate} AND storage_key IS NOT NULL
  `;
  let rows;
  try {
    rows = await executeD1UninstallQuery(instance, modernSql);
  } catch (error) {
    if (storageNodeId || !/no such column:\s*storage_node_id/i.test(error.message)) {
      throw error;
    }
    // Instances created before storage federation have no storage_node_id
    // column; every object in those versions belongs to the primary bucket.
    rows = await executeD1UninstallQuery(
      instance,
      `
        SELECT 'upload' AS record_type, owner_id, storage_key, upload_id
        FROM multipart_uploads
        UNION ALL
        SELECT 'owner' AS record_type, owner_id, '' AS storage_key, '' AS upload_id
        FROM files
        WHERE storage_key IS NOT NULL
      `,
    );
  }
  return validatedCleanupRows(rows, !managedBucket);
}

function purgeRoundCount(plan) {
  const uploadRounds = Math.ceil(
    plan.uploads.length / MAX_UPLOADS_PER_ROUND,
  );
  const prefixRounds = Math.ceil(
    plan.prefixes.length / MAX_PREFIXES_PER_ROUND,
  );
  return Math.max(uploadRounds, prefixRounds, plan.purgeAll ? 1 : 0);
}

function assertPurgePlanFits(plan, label) {
  const rounds = purgeRoundCount(plan);
  if (rounds > MAX_PURGE_ROUNDS) {
    throw new Error(
      `${label} 需要 ${rounds} 轮边缘清理，超过本次安全上限。请先在网盘内清理部分文件后重试。`,
    );
  }
}

function purgeMarkerPrefix(prefixes, uploads) {
  if (prefixes.length) return prefixes[0];
  for (const upload of uploads) {
    const ownerId = upload.storageKey.split("/", 1)[0].toLowerCase();
    if (UUID_PATTERN.test(ownerId)) return `${ownerId}/`;
  }
  return "";
}

async function waitForPurgeMarker(
  target,
  profile,
  configPath,
  markerKey,
  markerValue,
) {
  const startedAt = Date.now();
  let progressWidth = 0;
  while (Date.now() - startedAt < PURGE_ROUND_TIMEOUT_MS) {
    const marker = await runWrangler(
      [
        "r2",
        "object",
        "get",
        `${target.bucketName}/${markerKey}`,
        "--pipe",
        "--remote",
        "--config",
        configPath,
      ],
      target,
      { profile },
    );
    if (marker.code === 0 && marker.stdout.trim() === markerValue) {
      if (progressWidth > 0) {
        process.stdout.write(`\r${" ".repeat(progressWidth)}\r`);
      }
      return;
    }
    if (
      marker.code !== 0 &&
      !isMissingCloudflareResource(marker.output)
    ) {
      throw new Error(
        `无法检查边缘清理进度：${marker.output.trim().slice(-500)}`,
      );
    }
    const waited = Math.round((Date.now() - startedAt) / 1_000);
    const line = `等待 Cloudflare 边缘清理完成…（已等待 ${waited} 秒）`;
    progressWidth = Math.max(progressWidth, line.length);
    process.stdout.write(`\r${line}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (progressWidth > 0) process.stdout.write(`\r${" ".repeat(progressWidth)}\r`);
  throw new Error("Cloudflare 边缘清理助手启动超时；资源清单已保留，可稍后重试。");
}

function normalizePurgeRound(target, profileValue, round) {
  const accountId = validateAccountId(target.accountId);
  const bucketName = validateResourceName(target.bucketName, "清理目标 R2 存储桶");
  const targetId = String(target.id || "").toLowerCase();
  const profile = validateWranglerProfile(profileValue);
  if (!UUID_PATTERN.test(targetId)) {
    throw new Error("边缘清理目标 ID 无效，已停止以避免清理错误存储桶。");
  }
  if (
    !round ||
    typeof round !== "object" ||
    typeof round.purgeAll !== "boolean" ||
    !Array.isArray(round.uploads) ||
    !Array.isArray(round.prefixes) ||
    !Array.isArray(round.protectedKeys ?? [])
  ) {
    throw new Error("边缘清理计划无效，已停止。");
  }
  const uploads = round.uploads
    .map((upload) => {
      const storageKey =
        typeof upload?.storageKey === "string" ? upload.storageKey : "";
      const uploadId =
        typeof upload?.uploadId === "string" ? upload.uploadId : "";
      if (
        !storageKey ||
        !uploadId ||
        storageKey.length > 1_024 ||
        uploadId.length > 1_024 ||
        /[\u0000\r\n]/.test(storageKey) ||
        /[\u0000\r\n]/.test(uploadId)
      ) {
        throw new Error("边缘清理计划含有无效分片记录，已停止。");
      }
      return { storageKey, uploadId };
    })
    .sort((left, right) => {
      const leftKey = `${left.storageKey}\u0000${left.uploadId}`;
      const rightKey = `${right.storageKey}\u0000${right.uploadId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const prefixes = [
    ...new Set(
      round.prefixes.map((prefix) => {
        const normalized = String(prefix || "").toLowerCase();
        if (
          !UUID_PATTERN.test(normalized.slice(0, -1)) ||
          !normalized.endsWith("/")
        ) {
          throw new Error("边缘清理计划含有无效 owner UUID 前缀，已停止。");
        }
        return normalized;
      }),
    ),
  ].sort();
  const protectedKeys = [...new Set(round.protectedKeys ?? [])].map((key) => {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 1_024 ||
      /[\u0000\r\n]/.test(key)
    ) {
      throw new Error("边缘清理计划含有无效保护对象，已停止。");
    }
    return key;
  });
  if (uploads.length > MAX_UPLOADS_PER_ROUND) {
    throw new Error("单轮分片清理数量超过安全上限，已停止。");
  }
  if (prefixes.length > MAX_PREFIXES_PER_ROUND) {
    throw new Error("单轮前缀清理数量超过安全上限，已停止。");
  }
  if (round.purgeAll && prefixes.length) {
    throw new Error("全量清理计划不能同时带有共用桶前缀，已停止。");
  }
  if (!round.purgeAll && protectedKeys.length) {
    throw new Error("共用桶前缀清理不能带有桶级保护对象，已停止。");
  }
  if (!round.purgeAll && !purgeMarkerPrefix(prefixes, uploads)) {
    throw new Error("共用 R2 清理缺少 owner UUID 前缀，已停止以保护其他数据。");
  }
  return {
    accountId,
    bucketName,
    targetId,
    profile,
    purgeAll: round.purgeAll,
    uploads,
    prefixes,
    protectedKeys,
  };
}

function purgeRoundPlanHash(scope) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accountId: scope.accountId,
        bucketName: scope.bucketName,
        targetId: scope.targetId,
        profile: scope.profile,
        purgeAll: scope.purgeAll,
        uploads: scope.uploads,
        prefixes: scope.prefixes,
        protectedKeys: scope.protectedKeys,
      }),
    )
    .digest("hex");
}

export function createPurgeHelperJournalEntry(target, profile, round) {
  const scope = normalizePurgeRound(target, profile, round);
  const markerPrefix = scope.purgeAll
    ? ".r2-drive-uninstall/"
    : purgeMarkerPrefix(scope.prefixes, scope.uploads);
  return {
    version: PURGE_HELPER_JOURNAL_VERSION,
    operationId: randomBytes(16).toString("hex"),
    accountId: scope.accountId,
    bucketName: scope.bucketName,
    targetId: scope.targetId,
    profile: scope.profile,
    planHash: purgeRoundPlanHash(scope),
    workerName: `r2-drive-purge-${randomBytes(16).toString("hex")}`,
    token: randomBytes(32).toString("base64url"),
    markerKey: `${markerPrefix}purge-${randomBytes(12).toString("hex")}.json`,
    createdAt: new Date().toISOString(),
  };
}

export function validatePurgeHelperJournalEntry(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== PURGE_HELPER_JOURNAL_VERSION ||
    !/^[a-f0-9]{32}$/.test(value.operationId) ||
    !ACCOUNT_ID_PATTERN.test(value.accountId) ||
    !RESOURCE_NAME_PATTERN.test(value.bucketName) ||
    !UUID_PATTERN.test(value.targetId) ||
    !PROFILE_PATTERN.test(value.profile) ||
    !SHA256_HEX_PATTERN.test(value.planHash) ||
    !PURGE_HELPER_NAME_PATTERN.test(value.workerName) ||
    !PURGE_HELPER_TOKEN_PATTERN.test(value.token) ||
    !/^(?:\.r2-drive-uninstall\/|[0-9a-f-]{36}\/)purge-[a-f0-9]{24}\.json$/.test(
      value.markerKey,
    ) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("本机边缘清理 journal 无效，已停止以避免覆盖其他 Worker。");
  }
  return {
    version: PURGE_HELPER_JOURNAL_VERSION,
    operationId: value.operationId,
    accountId: value.accountId.toLowerCase(),
    bucketName: value.bucketName,
    targetId: value.targetId.toLowerCase(),
    profile: value.profile,
    planHash: value.planHash,
    workerName: value.workerName,
    token: value.token,
    markerKey: value.markerKey.toLowerCase(),
    createdAt: value.createdAt,
  };
}

function assertPurgeJournalMatches(operationValue, target, profile, round) {
  const operation = validatePurgeHelperJournalEntry(operationValue);
  const scope = normalizePurgeRound(target, profile, round);
  const expectedMarkerPrefix = scope.purgeAll
    ? ".r2-drive-uninstall/"
    : purgeMarkerPrefix(scope.prefixes, scope.uploads);
  if (
    operation.accountId !== scope.accountId ||
    operation.bucketName !== scope.bucketName ||
    operation.targetId !== scope.targetId ||
    operation.profile !== scope.profile ||
    operation.planHash !== purgeRoundPlanHash(scope) ||
    !operation.markerKey.startsWith(expectedMarkerPrefix)
  ) {
    throw new Error(
      "本机仍有另一项未完成的边缘清理 journal；为避免接管错误 Worker，已停止卸载。",
    );
  }
  return { operation, scope };
}

async function readPurgeHelperJournal() {
  try {
    return validatePurgeHelperJournalEntry(
      JSON.parse(await readFile(PURGE_HELPER_JOURNAL_PATH, "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(
        "本机边缘清理 journal 已损坏，已停止以避免覆盖其他 Worker。",
      );
    }
    throw error;
  }
}

async function loadOrCreatePurgeHelperOperation(target, profile, round) {
  const existing = await readPurgeHelperJournal();
  if (existing) {
    return {
      ...assertPurgeJournalMatches(existing, target, profile, round),
      resumed: true,
    };
  }
  const proposed = createPurgeHelperJournalEntry(target, profile, round);
  await mkdir(path.dirname(PURGE_HELPER_JOURNAL_PATH), {
    recursive: true,
    mode: 0o700,
  });
  let file;
  try {
    file = await open(PURGE_HELPER_JOURNAL_PATH, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(proposed, null, 2)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    await file?.close();
  }
  const stored = await readPurgeHelperJournal();
  if (!stored) {
    throw new Error("本机边缘清理 journal 未能持久化，尚未修改 Cloudflare。");
  }
  return {
    ...assertPurgeJournalMatches(stored, target, profile, round),
    resumed: stored.operationId !== proposed.operationId,
  };
}

async function clearPurgeHelperJournal(operation) {
  const stored = await readPurgeHelperJournal();
  if (!stored) return;
  if (
    stored.operationId !== operation.operationId ||
    stored.token !== operation.token
  ) {
    throw new Error("边缘清理 journal 已被另一进程更改，未删除本机记录。");
  }
  await rm(PURGE_HELPER_JOURNAL_PATH);
}

function purgeHelperVariables(operation, scope) {
  return {
    PURGE_UPLOADS: JSON.stringify(scope.uploads),
    PURGE_ALL: scope.purgeAll ? "true" : "false",
    PURGE_PREFIXES: JSON.stringify(scope.prefixes),
    PURGE_PROTECTED_KEYS: JSON.stringify(scope.protectedKeys),
    PURGE_MARKER_KEY: operation.markerKey,
    PURGE_MARKER_VALUE: operation.token,
    PURGE_HELPER_TOKEN: operation.token,
    PURGE_EXPECTED_BUCKET: scope.bucketName,
    PURGE_PLAN_HASH: operation.planHash,
  };
}

function purgeHelperIdentityError(workerName) {
  return new Error(
    `同名 Worker ${workerName} 无法通过原随机 token 和 R2 绑定验证；已拒绝覆盖或删除。`,
  );
}

export function assertTemporaryPurgeWorkerIdentity(
  operationValue,
  target,
  profile,
  round,
  deployment,
  version,
) {
  const { operation, scope } = assertPurgeJournalMatches(
    operationValue,
    target,
    profile,
    round,
  );
  const activeVersions = Array.isArray(deployment?.versions)
    ? deployment.versions
    : [];
  if (
    activeVersions.length !== 1 ||
    Number(activeVersions[0]?.percentage) !== 100 ||
    !UUID_PATTERN.test(String(activeVersions[0]?.version_id || ""))
  ) {
    throw purgeHelperIdentityError(operation.workerName);
  }
  const versionId = String(activeVersions[0].version_id).toLowerCase();
  const bindings = Array.isArray(version?.resources?.bindings)
    ? version.resources.bindings
    : [];
  const handlers = Array.isArray(version?.resources?.script?.handlers)
    ? version.resources.script.handlers
    : [];
  if (
    String(version?.id || "").toLowerCase() !== versionId ||
    !handlers.includes("scheduled")
  ) {
    throw purgeHelperIdentityError(operation.workerName);
  }
  const expectedVariables = purgeHelperVariables(operation, scope);
  for (const [name, expected] of Object.entries(expectedVariables)) {
    const matches = bindings.filter(
      (binding) => binding?.type === "plain_text" && binding.name === name,
    );
    if (matches.length !== 1 || matches[0].text !== expected) {
      throw purgeHelperIdentityError(operation.workerName);
    }
  }
  const r2Bindings = bindings.filter(
    (binding) => binding?.type === "r2_bucket",
  );
  if (
    r2Bindings.length !== 1 ||
    r2Bindings[0].name !== "FILES" ||
    r2Bindings[0].bucket_name !== scope.bucketName
  ) {
    throw purgeHelperIdentityError(operation.workerName);
  }
  return { operation, scope, versionId };
}

async function inspectTemporaryPurgeWorker(
  target,
  profile,
  operation,
  round,
  configPath,
) {
  const status = await runWrangler(
    [
      "deployments",
      "status",
      "--name",
      operation.workerName,
      "--json",
      "--config",
      configPath,
    ],
    target,
    { profile },
  );
  if (status.code !== 0) {
    if (isMissingCloudflareResource(status.output)) return { missing: true };
    throw new Error(
      `无法核对临时边缘清理 Worker：${status.output.trim().slice(-400)}`,
    );
  }
  let deployment;
  try {
    deployment = parseWranglerJson(status.output, "Wrangler Worker deployment");
  } catch {
    throw purgeHelperIdentityError(operation.workerName);
  }
  const activeVersions = Array.isArray(deployment?.versions)
    ? deployment.versions
    : [];
  const versionId =
    activeVersions.length === 1
      ? String(activeVersions[0]?.version_id || "")
      : "";
  if (!UUID_PATTERN.test(versionId)) {
    throw purgeHelperIdentityError(operation.workerName);
  }
  const viewed = await runWrangler(
    [
      "versions",
      "view",
      versionId,
      "--name",
      operation.workerName,
      "--json",
      "--config",
      configPath,
    ],
    target,
    { profile },
  );
  if (viewed.code !== 0) {
    throw new Error("无法读取临时边缘清理 Worker 的版本身份，已停止。");
  }
  let version;
  try {
    version = parseWranglerJson(viewed.output, "Wrangler Worker version");
  } catch {
    throw purgeHelperIdentityError(operation.workerName);
  }
  assertTemporaryPurgeWorkerIdentity(
    operation,
    target,
    profile,
    round,
    deployment,
    version,
  );
  return { missing: false };
}

export async function waitForTemporaryPurgeWorkerIdentity(
  target,
  profile,
  operation,
  round,
  configPath,
  hooks = {},
) {
  const inspect = hooks.inspect ?? inspectTemporaryPurgeWorker;
  const wait =
    hooks.wait ??
    ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const inspected = await inspect(
      target,
      profile,
      operation,
      round,
      configPath,
    );
    if (!inspected.missing || attempt === 5) return inspected;
    await wait(500 * 2 ** attempt);
  }
  return { missing: true };
}

async function readPurgeArtifact(
  target,
  profile,
  configPath,
  objectKey,
  expectedValue,
) {
  const result = await runWrangler(
    [
      "r2",
      "object",
      "get",
      `${target.bucketName}/${objectKey}`,
      "--pipe",
      "--remote",
      "--config",
      configPath,
    ],
    target,
    { profile },
  );
  if (result.code !== 0) {
    if (isMissingCloudflareResource(result.output)) return false;
    throw new Error(
      `无法核对边缘清理标记：${result.output.trim().slice(-400)}`,
    );
  }
  if (result.stdout.trim() !== expectedValue) {
    throw new Error("边缘清理标记内容与本机 journal 不匹配，已停止。");
  }
  return true;
}

async function readPurgeArtifactState(
  target,
  profile,
  operation,
  configPath,
) {
  const [completed, locked] = await Promise.all([
    readPurgeArtifact(
      target,
      profile,
      configPath,
      operation.markerKey,
      operation.token,
    ),
    readPurgeArtifact(
      target,
      profile,
      configPath,
      `${operation.markerKey}.lock`,
      operation.token,
    ),
  ]);
  return { completed, locked };
}

async function cleanupTemporaryPurgeArtifacts(
  target,
  profile,
  operation,
  configPath,
) {
  const state = await readPurgeArtifactState(
    target,
    profile,
    operation,
    configPath,
  );
  for (const [cleanupKey, exists] of [
    [operation.markerKey, state.completed],
    [`${operation.markerKey}.lock`, state.locked],
  ]) {
    if (!exists) continue;
    const markerRemoved = await runWrangler(
      [
        "r2",
        "object",
        "delete",
        `${target.bucketName}/${cleanupKey}`,
        "--remote",
        "--force",
        "--config",
        configPath,
      ],
      target,
      { profile },
    );
    if (
      markerRemoved.code !== 0 &&
      !isMissingCloudflareResource(markerRemoved.output)
    ) {
      throw new Error(
        `边缘清理标记未能删除：${markerRemoved.output.trim().slice(-400)}`,
      );
    }
  }
}

async function removeTemporaryPurgeWorker(
  target,
  profile,
  operation,
  round,
  configPath,
) {
  let lastOutput = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inspected = await inspectTemporaryPurgeWorker(
      target,
      profile,
      operation,
      round,
      configPath,
    );
    if (inspected.missing) return;
    const removed = await runWrangler(
      ["delete", operation.workerName, "--force", "--config", configPath],
      target,
      { profile },
    );
    if (
      removed.code === 0 ||
      isMissingCloudflareResource(removed.output)
    ) {
      return;
    }
    lastOutput = removed.output;
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw new Error(
    `临时边缘清理 Worker 未能删除：${lastOutput.trim().slice(-400)}`,
  );
}

function redactPurgeHelperOutput(output, operation) {
  return String(output).split(operation.token).join("[已隐藏随机 token]");
}

// The temporary helper runs from a cron trigger entirely at Cloudflare's edge.
// Its random name and identity token are persisted before deployment. A retry
// never overwrites an existing name: it first proves that the active version
// has the journal token and the exact intended R2 binding.
async function purgeR2Round(target, profile, round) {
  const { operation, scope, resumed } =
    await loadOrCreatePurgeHelperOperation(target, profile, round);
  const workspace = await mkdtemp(path.join(tmpdir(), "r2-drive-purge-"));
  const configPath = path.join(workspace, "wrangler.jsonc");
  const helperPath = path.join(workspace, "uninstall-worker.mjs");
  const variables = purgeHelperVariables(operation, scope);
  let trustedWorker = false;
  let purgeCompleted = false;
  let primaryError;

  try {
    await Promise.all([
      writeFile(
        configPath,
        `${JSON.stringify(
          {
            name: operation.workerName,
            main: helperPath,
            compatibility_date: "2025-01-01",
            account_id: scope.accountId,
            workers_dev: false,
            preview_urls: false,
            triggers: { crons: ["* * * * *"] },
            vars: variables,
            r2_buckets: [
              { binding: "FILES", bucket_name: scope.bucketName },
            ],
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        helperPath,
        await readFile(
          path.join(ROOT, "scripts", "uninstall-worker.mjs"),
          "utf8",
        ),
        { mode: 0o600 },
      ),
    ]);

    const artifacts = await readPurgeArtifactState(
      target,
      profile,
      operation,
      configPath,
    );
    const inspected = await inspectTemporaryPurgeWorker(
      target,
      profile,
      operation,
      round,
      configPath,
    );
    if (artifacts.completed) {
      purgeCompleted = true;
      trustedWorker = !inspected.missing;
    } else if (!inspected.missing) {
      trustedWorker = true;
      if (resumed) {
        console.log(
          `继续等待已验证的边缘清理助手 ${operation.workerName}…`,
        );
      }
    } else {
      // A prior verified helper may have been removed after an interrupted
      // invocation. Only journal-token artifacts are cleared before retrying.
      await cleanupTemporaryPurgeArtifacts(
        target,
        profile,
        operation,
        configPath,
      );
      // Recheck immediately after artifact cleanup so even two concurrent
      // local retries cannot use deploy as an overwrite operation.
      const beforeDeploy = await inspectTemporaryPurgeWorker(
        target,
        profile,
        operation,
        round,
        configPath,
      );
      if (!beforeDeploy.missing) {
        trustedWorker = true;
        console.log(
          `继续使用另一卸载进程已部署并验证的边缘清理助手 ${operation.workerName}…`,
        );
      } else {
        const deployed = await runWrangler(
          ["deploy", "--config", configPath],
          target,
          { profile },
        );
        const afterDeploy = await waitForTemporaryPurgeWorkerIdentity(
          target,
          profile,
          operation,
          round,
          configPath,
        );
        if (afterDeploy.missing) {
          throw new Error(
            `Cloudflare 清理助手部署失败：${redactPurgeHelperOutput(
              deployed.output,
              operation,
            )
              .trim()
              .slice(-400)}`,
          );
        }
        trustedWorker = true;
        if (deployed.code !== 0) {
          console.log("Wrangler 返回中断，但已验证云端清理助手部署成功，继续执行。");
        }
      }
    }

    if (!purgeCompleted) {
      await waitForPurgeMarker(
        target,
        profile,
        configPath,
        operation.markerKey,
        operation.token,
      );
      purgeCompleted = true;
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    if (trustedWorker) {
      await removeTemporaryPurgeWorker(
        target,
        profile,
        operation,
        round,
        configPath,
      );
    }
    if (trustedWorker || purgeCompleted) {
      await cleanupTemporaryPurgeArtifacts(
        target,
        profile,
        operation,
        configPath,
      );
    }
    if (purgeCompleted && !primaryError) {
      await clearPurgeHelperJournal(operation);
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  if (primaryError && cleanupError) {
    throw new Error(
      `${primaryError instanceof Error ? primaryError.message : String(primaryError)}；${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function purgeAllR2Data(target, cleanup, purgeAll = true) {
  const protectedKeys = purgeAll
    ? Array.isArray(target.purgeProtectedKeys)
      ? target.purgeProtectedKeys
      : target.bucketOwnershipMarkerKey
        ? [target.bucketOwnershipMarkerKey]
        : []
    : [];
  const plan = {
    uploads: cleanup.uploads,
    prefixes: purgeAll ? [] : cleanup.prefixes,
    purgeAll,
  };
  const rounds = purgeRoundCount(plan);
  if (rounds === 0) return;
  assertPurgePlanFits(plan, target.bucketName);
  console.log(
    purgeAll
      ? `正在执行清除 all：${target.bucketName} 的普通对象和 ${cleanup.uploads.length} 个分片任务…`
      : `正在清理共用桶中 ${cleanup.prefixes.length} 个本实例 owner UUID 前缀和 ${cleanup.uploads.length} 个分片任务…`,
  );
  console.log(
    "云端清理由定时任务触发，第一次通常需要等待约 1 分钟，请不要关闭窗口。",
  );

  for (let round = 0; round < rounds; round += 1) {
    const uploads = plan.uploads.slice(
      round * MAX_UPLOADS_PER_ROUND,
      (round + 1) * MAX_UPLOADS_PER_ROUND,
    );
    const prefixes = plan.prefixes.slice(
      round * MAX_PREFIXES_PER_ROUND,
      (round + 1) * MAX_PREFIXES_PER_ROUND,
    );
    if (!purgeAll && prefixes.length === 0 && uploads.length > 0) {
      const uploadPrefix = purgeMarkerPrefix([], uploads);
      if (uploadPrefix) prefixes.push(uploadPrefix);
    }
    await purgeR2Round(target, target.profile ?? "default", {
      uploads,
      prefixes,
      purgeAll,
      protectedKeys,
    });
  }
  console.log("✓ 边缘清理完成：目标范围内的普通对象和分片任务均已处理。");
}

async function deleteR2(
  instance,
  ownership,
  alreadyMissing = false,
  cleanup = { uploads: [], prefixes: [] },
) {
  console.log(
    ownership.managedBucket
      ? `正在清空并删除主 R2 存储桶 ${instance.r2Name}…`
      : `正在清理复用的主 R2 存储桶 ${instance.r2Name} 中本实例的数据…`,
  );
  if (alreadyMissing) {
    console.log("✓ 主 R2 存储桶已经不存在。");
    return;
  }
  const target = {
    id: ownership.installId,
    accountId: instance.accountId,
    bucketName: instance.r2Name,
    profile: "default",
    purgeProtectedKeys: [ownership.bucketMarkerKey],
  };

  if (!ownership.managedBucket) {
    await purgeAllR2Data(target, cleanup, false);
    console.log(
      "✓ 已清除复用桶中的本实例 owner UUID 前缀；随机归属标记会在 exact D1 删除成功后移除，存储桶和其他配置均保留。",
    );
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await purgeAllR2Data(target, cleanup, true);
    await removePrimaryBucketOwnershipMarker(ownership);
    const result = await runWrangler(
      ["r2", "bucket", "delete", instance.r2Name],
      instance,
    );
    if (result.code === 0 || isMissingCloudflareResource(result.output)) {
      console.log("✓ 主 R2 存储桶及其中所有文件已删除。");
      return;
    }

    try {
      await restorePrimaryBucketOwnershipMarker(ownership);
    } catch (restoreError) {
      throw new Error(
        `R2 存储桶未能删除：${result.output.trim().slice(-400)}；${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      );
    }
    if (attempt === 0 && isR2BucketNotEmpty(result.output)) {
      console.log("主 R2 在最终删除窗口仍有对象，已恢复归属标记并重新清理。");
      continue;
    }
    throw new Error(
      `R2 存储桶未能删除，归属标记已恢复，可安全重试：${result.output.trim().slice(-500)}`,
    );
  }
}

async function finalizeReusedPrimaryBucket(
  ownership,
  alreadyMissing = false,
) {
  if (ownership.managedBucket || alreadyMissing) return;
  await removePrimaryBucketOwnershipMarker(ownership);
  console.log("✓ 复用主 R2 的随机归属标记已删除，其他数据和桶级配置保持不变。");
}

let storageFederationPrivateKey;
let storageIdentityDispatcher;

async function readStorageFederationPrivateKey() {
  if (storageFederationPrivateKey) return storageFederationPrivateKey;
  let parsed;
  try {
    parsed = JSON.parse(
      await readFile(STORAGE_POOL_PRIVATE_JWK_PATH, "utf8"),
    );
  } catch {
    throw new Error(
      "本机联合存储私钥缺失或损坏，无法验证节点 Worker 身份；已停止卸载。",
    );
  }
  if (
    parsed?.kty !== "EC" ||
    parsed?.crv !== "P-256" ||
    typeof parsed.x !== "string" ||
    typeof parsed.y !== "string" ||
    typeof parsed.d !== "string"
  ) {
    throw new Error(
      "本机联合存储私钥格式无效，无法验证节点 Worker 身份；已停止卸载。",
    );
  }
  try {
    storageFederationPrivateKey = createPrivateKey({
      key: parsed,
      format: "jwk",
    });
  } catch {
    throw new Error(
      "本机联合存储私钥无法载入，无法验证节点 Worker 身份；已停止卸载。",
    );
  }
  return storageFederationPrivateKey;
}

async function fetchStorageNodeIdentity(url, options) {
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  storageIdentityDispatcher ??= new EnvHttpProxyAgent();
  return undiciFetch(url, {
    ...options,
    dispatcher: storageIdentityDispatcher,
  });
}

async function readBoundedIdentityJson(response) {
  const maxBytes = 64 * 1024;
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^[0-9]+$/.test(declaredLength) ||
      Number(declaredLength) > maxBytes)
  ) {
    await response.body?.cancel();
    throw new Error("节点 Worker 身份响应过大。");
  }
  if (!response.body) throw new Error("节点 Worker 身份响应为空。");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("节点 Worker 身份响应过大。");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("节点 Worker 身份响应不是有效 JSON。");
  }
}

async function readPrimaryBucketOwnershipMarker(ownership) {
  const outputPath = path.join(
    ROOT,
    ".wrangler",
    "uninstall",
    `primary-bucket-${ownership.installId}.json`,
  );
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await rm(outputPath, { force: true });
  try {
    const result = await runWrangler(
      [
        "r2",
        "object",
        "get",
        `${ownership.r2Name}/${encodeR2ObjectKey(ownership.bucketMarkerKey)}`,
        "--file",
        outputPath,
        "--remote",
        "--config",
        CONFIG_PATH,
      ],
      {
        accountId: ownership.accountId,
        bucketName: ownership.r2Name,
      },
    );
    if (result.code !== 0) {
      throw new Error(
        `主 R2 存储桶 ${ownership.r2Name} 缺少原随机归属标记；它可能已被同名重建，未执行任何删除。`,
      );
    }
    const markerStat = await stat(outputPath);
    if (!markerStat.isFile() || markerStat.size > 4 * 1024) {
      throw new Error("主 R2 归属标记内容异常，未执行任何删除。");
    }
    const markerBody = await readFile(outputPath, "utf8");
    assertPrimaryBucketOwnership(ownership, markerBody);
    return markerBody;
  } finally {
    await rm(outputPath, { force: true });
  }
}

async function assertPrimaryBucketCreationDate(ownership) {
  if (!ownership.bucketCreationDate) {
    throw new Error(
      "本机主 R2 归属凭证缺少创建时间，不能排除同名重建；未执行任何删除。",
    );
  }
  const result = await runWrangler(
    [
      "r2",
      "bucket",
      "info",
      ownership.r2Name,
      "--json",
      "--config",
      CONFIG_PATH,
    ],
    {
      accountId: ownership.accountId,
      bucketName: ownership.r2Name,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `无法复核主 R2 创建时间：${result.output.trim().slice(-400)}`,
    );
  }
  const payload = parseWranglerJson(result.output, "Wrangler R2 bucket");
  const observed = String(
    payload?.creation_date ?? payload?.result?.creation_date ?? "",
  );
  if (
    !observed ||
    !Number.isFinite(Date.parse(observed)) ||
    Date.parse(observed) !== Date.parse(ownership.bucketCreationDate)
  ) {
    throw new Error(
      "主 R2 创建时间与原安装记录不一致；它可能已被同名重建，未执行任何删除。",
    );
  }
}

async function verifyPrimaryBucketForUninstall(ownership) {
  await readPrimaryBucketOwnershipMarker(ownership);
  await assertPrimaryBucketCreationDate(ownership);
}

async function verifyPrimaryWorkerForUninstall(ownership, instance) {
  if (!instance.customHostname) {
    throw new Error(
      "本机配置缺少原 Worker 域名，无法完成随机挑战身份验证；未执行任何删除。",
    );
  }
  const challenge = createPrimaryWorkerChallenge();
  const endpoint = new URL(
    PRIMARY_WORKER_IDENTITY_PATH,
    `https://${instance.customHostname}`,
  );
  endpoint.searchParams.set("challenge", challenge);
  let response;
  try {
    response = await fetchStorageNodeIdentity(endpoint, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(
      `无法连接主 Worker ${instance.workerName} 完成随机挑战；未执行任何删除。`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `主 Worker ${instance.workerName} 未接受原安装随机挑战（HTTP ${response.status}）；未执行任何删除。`,
    );
  }
  assertPrimaryWorkerOwnership(
    ownership,
    challenge,
    await readBoundedIdentityJson(response),
  );
}

async function restorePrimaryBucketOwnershipMarker(ownership) {
  const result = await runWrangler(
    [
      "r2",
      "object",
      "put",
      `${ownership.r2Name}/${encodeR2ObjectKey(ownership.bucketMarkerKey)}`,
      "--pipe",
      "--remote",
      "--force",
      "--config",
      CONFIG_PATH,
    ],
    {
      accountId: ownership.accountId,
      bucketName: ownership.r2Name,
    },
    { input: primaryBucketOwnershipBody(ownership) },
  );
  if (result.code !== 0) {
    throw new Error(
      `主 R2 清理失败后，归属标记也未能恢复：${result.output.trim().slice(-400)}`,
    );
  }
  await verifyPrimaryBucketForUninstall(ownership);
}

async function removePrimaryBucketOwnershipMarker(ownership) {
  await verifyPrimaryBucketForUninstall(ownership);
  const result = await runWrangler(
    [
      "r2",
      "object",
      "delete",
      `${ownership.r2Name}/${encodeR2ObjectKey(ownership.bucketMarkerKey)}`,
      "--remote",
      "--force",
      "--config",
      CONFIG_PATH,
    ],
    {
      accountId: ownership.accountId,
      bucketName: ownership.r2Name,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `主 R2 归属标记未能删除：${result.output.trim().slice(-400)}`,
    );
  }
}

async function verifyStorageNodeWorkerForUninstall(node) {
  if (!node.endpoint) {
    throw new Error(
      `节点 Worker ${node.workerName} 缺少已登记 workers.dev 地址，无法证明资源归属；已停止卸载。`,
    );
  }
  const timestamp = Math.floor(Date.now() / 1_000);
  const nonce = randomBytes(16).toString("base64url");
  const canonical = [
    STORAGE_CAPABILITY_PREFIX,
    node.id,
    "GET",
    "/v1/health",
    String(timestamp),
    nonce,
    STORAGE_CAPABILITY_UNSIGNED_BODY,
    "",
  ].join("\n");
  const signature = signBytes(
    "sha256",
    Buffer.from(canonical, "utf8"),
    {
      key: await readStorageFederationPrivateKey(),
      dsaEncoding: "ieee-p1363",
    },
  ).toString("base64url");
  let response;
  try {
    response = await fetchStorageNodeIdentity(
      new URL("/v1/health", node.endpoint),
      {
        method: "GET",
        redirect: "manual",
        headers: {
          "x-r2drive-capability-version": STORAGE_CAPABILITY_VERSION,
          "x-r2drive-node-id": node.id,
          "x-r2drive-timestamp": String(timestamp),
          "x-r2drive-nonce": nonce,
          "x-r2drive-body-sha256": STORAGE_CAPABILITY_UNSIGNED_BODY,
          "x-r2drive-signature": signature,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new Error(
      `无法连接节点 Worker ${node.workerName} 完成安装身份验证；已停止卸载。`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `节点 Worker ${node.workerName} 未接受原安装签名（HTTP ${response.status}）；已停止卸载。`,
    );
  }
  assertStorageNodeWorkerIdentity(
    node,
    await readBoundedIdentityJson(response),
  );
}

async function readManagedBucketOwnershipMarker(node) {
  const outputPath = path.join(
    path.dirname(node.configPath),
    `${node.id}.bucket-ownership`,
  );
  await rm(outputPath, { force: true });
  try {
    const result = await runWrangler(
      [
        "r2",
        "object",
        "get",
        `${node.bucketName}/${encodeR2ObjectKey(node.bucketOwnershipMarkerKey)}`,
        "--file",
        outputPath,
        "--remote",
        "--config",
        node.configPath,
      ],
      node,
      { profile: node.profile },
    );
    if (result.code !== 0) {
      throw new Error(
        `受管 R2 存储桶 ${node.bucketName} 缺少可验证的随机归属标记；它可能已被同名重建，已停止卸载。`,
      );
    }
    const markerStat = await stat(outputPath);
    if (!markerStat.isFile() || markerStat.size > 4 * 1024) {
      throw new Error(
        `受管 R2 存储桶 ${node.bucketName} 的归属标记内容异常，已停止卸载。`,
      );
    }
    const markerBody = await readFile(outputPath, "utf8");
    assertManagedBucketOwnership(node, markerBody);
    return markerBody;
  } finally {
    await rm(outputPath, { force: true });
  }
}

async function restoreManagedBucketOwnershipMarker(node) {
  const markerBody = storageBucketOwnershipBody(node);
  const result = await runWrangler(
    [
      "r2",
      "object",
      "put",
      `${node.bucketName}/${encodeR2ObjectKey(node.bucketOwnershipMarkerKey)}`,
      "--pipe",
      "--remote",
      "--force",
      "--config",
      node.configPath,
    ],
    node,
    { profile: node.profile, input: markerBody },
  );
  if (result.code !== 0) {
    throw new Error(
      `受管 R2 存储桶 ${node.bucketName} 清理失败后，归属标记也未能恢复：${result.output.trim().slice(-400)}`,
    );
  }
  await readManagedBucketOwnershipMarker(node);
}

async function inspectBucketForUninstall(target, profile, configPath) {
  const loginProbe = await runWrangler(
    ["r2", "bucket", "list", "--config", configPath],
    target,
    { profile },
  );
  if (loginProbe.code !== 0) {
    throw new Error(
      `Wrangler 登录 ${profile} 无法访问账号 ${target.accountId} 的 R2：${loginProbe.output.trim().slice(-400)}`,
    );
  }
  const info = await runWrangler(
    [
      "r2",
      "bucket",
      "info",
      target.bucketName,
      "--json",
      "--config",
      configPath,
    ],
    target,
    { profile },
  );
  if (info.code === 0) return false;
  if (isMissingCloudflareResource(info.output)) return true;
  throw new Error(
    `无法核对 R2 存储桶 ${target.bucketName}：${info.output.trim().slice(-400)}`,
  );
}

async function inspectWorkerForUninstall(target, profile, configPath) {
  const status = await runWrangler(
    [
      "deployments",
      "status",
      "--name",
      target.workerName,
      "--json",
      "--config",
      configPath,
    ],
    target,
    { profile },
  );
  if (status.code === 0) return false;
  if (isMissingCloudflareResource(status.output)) return true;
  throw new Error(
    `Wrangler 登录 ${profile} 无法核对 Worker ${target.workerName}：${status.output.trim().slice(-400)}`,
  );
}

async function inspectD1ForUninstall(instance) {
  const listed = await runWrangler(["d1", "list", "--json"], instance);
  if (listed.code !== 0) {
    throw new Error(`无法检查资料数据库：${listed.output.trim().slice(-500)}`);
  }
  const existing = findD1DatabaseByName(
    parseWranglerJson(listed.output, "Wrangler D1"),
    instance.d1Name,
  );
  if (!existing) {
    return null;
  }
  if (existing.id !== instance.d1Id) {
    throw new Error(
      `同名资料数据库的编号与本实例不一致。为避免误删，已停止；没有删除 ${instance.d1Name}。`,
    );
  }
  return existing;
}

async function writeNodeUninstallConfigs(inventory, workspace) {
  const placeholderPath = path.join(workspace, "uninstall-placeholder.mjs");
  await writeFile(
    placeholderPath,
    "export default { fetch() { return new Response(null, { status: 404 }); } };",
    { mode: 0o600 },
  );
  return Promise.all(
    inventory.nodes.map(async (node) => {
      const configPath = path.join(workspace, `${node.id}.wrangler.jsonc`);
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            name: node.workerName,
            main: "./uninstall-placeholder.mjs",
            account_id: node.accountId,
            compatibility_date: "2025-01-01",
            workers_dev: false,
            preview_urls: false,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return { ...node, configPath };
    }),
  );
}

async function preflightUninstall(instance, nodeTargets) {
  console.log("\n正在核对当前 Cloudflare 账号和卸载目标，不会在这一步删除数据…");
  const localOwnership = await readPrimaryOwnershipIntent(
    PRIMARY_OWNERSHIP_PATH,
    { allowMissing: true },
  );
  if (!localOwnership) {
    throw new Error(
      "当前实例没有 v0.3 随机主资源归属凭证。旧版同名 Worker/R2 不能在卸载时临时认领；已整体停止，D1 和本机配置均保留。请先通过更新助手完成安全迁移。",
    );
  }
  const ownership = assertPrimaryOwnershipMatchesInstance(
    localOwnership,
    instance,
  );
  const database = await inspectD1ForUninstall(instance);
  const primaryTarget = {
    accountId: instance.accountId,
    bucketName: instance.r2Name,
    workerName: instance.workerName,
  };
  const r2Missing = await inspectBucketForUninstall(
    primaryTarget,
    "default",
    CONFIG_PATH,
  );
  const workerMissing = await inspectWorkerForUninstall(
    primaryTarget,
    "default",
    CONFIG_PATH,
  );
  if (!r2Missing) {
    await verifyPrimaryBucketForUninstall(ownership);
  }
  if (!workerMissing) {
    await verifyPrimaryWorkerForUninstall(ownership, instance);
  }

  const checkedNodes = [];
  for (const node of nodeTargets) {
    if (node.uninstallCompletedAt) {
      checkedNodes.push({
        ...node,
        bucketMissing: true,
        workerMissing: true,
      });
      console.log(
        `✓ 附加节点 ${node.label} 此前已完成清理；本轮只核对卸载清单。`,
      );
      continue;
    }
    const bucketMissing = await inspectBucketForUninstall(
      node,
      node.profile,
      node.configPath,
    );
    const workerMissing = await inspectWorkerForUninstall(
      node,
      node.profile,
      node.configPath,
    );
    if (!bucketMissing && node.managedBucket) {
      await readManagedBucketOwnershipMarker(node);
    }
    if (!workerMissing && node.managedWorker) {
      await verifyStorageNodeWorkerForUninstall(node);
    }
    checkedNodes.push({ ...node, bucketMissing, workerMissing });
    console.log(
      `✓ 已核对附加节点 ${node.label}：profile ${node.profile}、账号 ${node.accountId}、资源归属边界。`,
    );
  }

  if (database) {
    const registeredNodes = await readD1StorageNodesForUninstall(instance);
    reconcileStorageNodeInventory(
      { version: 1, nodes: nodeTargets },
      registeredNodes,
    );
    console.log(
      `✓ 本机节点清单与主 D1 登记已通过安全核对（${registeredNodes.length} 个已登记节点）。`,
    );
  }

  const nodesNeedingD1 = checkedNodes.filter(
    (node) =>
      !node.uninstallCompletedAt &&
      node.status !== "provisioning",
  );
  if (!database && nodesNeedingD1.length) {
    throw new Error(
      "主 D1 已不存在，无法安全取得附加节点的 owner UUID 清理边界；节点清单已保留。",
    );
  }
  const primaryCleanup = database
    ? await storageCleanupPlan(
        instance,
        null,
        ownership.managedBucket,
      )
    : { uploads: [], prefixes: [] };
  if (!r2Missing) {
    assertPurgePlanFits(
      {
        uploads: primaryCleanup.uploads,
        prefixes: ownership.managedBucket
          ? []
          : primaryCleanup.prefixes,
        purgeAll: ownership.managedBucket,
      },
      instance.r2Name,
    );
  }
  for (const node of checkedNodes) {
    node.cleanup =
      database && !node.uninstallCompletedAt && !node.bucketMissing
        ? await storageCleanupPlan(instance, node.id, node.managedBucket)
        : { uploads: [], prefixes: [] };
    if (!node.uninstallCompletedAt && !node.bucketMissing) {
      assertPurgePlanFits(
        {
          uploads: node.cleanup.uploads,
          prefixes: node.managedBucket ? [] : node.cleanup.prefixes,
          purgeAll: node.managedBucket,
        },
        node.bucketName,
      );
    }
  }
  console.log(
    `✓ 卸载目标已核对：主 Worker ${instance.workerName}、主 R2 ${instance.r2Name}、D1 ${instance.d1Name}、${checkedNodes.length} 个附加节点。`,
  );
  return {
    database,
    r2Missing,
    workerMissing,
    ownership,
    primaryCleanup,
    nodes: checkedNodes,
  };
}

async function deleteStorageNodeWorker(node) {
  if (!node.managedWorker) {
    console.log(`  保留非受管 Worker ${node.workerName}。`);
    return;
  }
  if (node.workerMissing) {
    console.log(`  ✓ 节点 Worker ${node.workerName} 已经不存在。`);
    return;
  }
  const removed = await runWrangler(
    ["delete", node.workerName, "--force", "--config", node.configPath],
    node,
    { profile: node.profile },
  );
  if (removed.code !== 0 && !isMissingCloudflareResource(removed.output)) {
    throw new Error(
      `节点 Worker ${node.workerName} 未能删除：${removed.output.trim().slice(-500)}`,
    );
  }
  console.log(`  ✓ 受管节点 Worker ${node.workerName} 已删除。`);
}

async function deleteManagedStorageNodeBucket(node) {
  // The purge helper deliberately protects this marker so a killed launcher
  // can still prove bucket ownership on its next preflight. Remove it only in
  // the narrow final-delete window, after one last exact comparison.
  await readManagedBucketOwnershipMarker(node);
  const markerRemoved = await runWrangler(
    [
      "r2",
      "object",
      "delete",
      `${node.bucketName}/${encodeR2ObjectKey(node.bucketOwnershipMarkerKey)}`,
      "--remote",
      "--force",
      "--config",
      node.configPath,
    ],
    node,
    { profile: node.profile },
  );
  if (markerRemoved.code !== 0) {
    throw new Error(
      `节点 R2 存储桶 ${node.bucketName} 的归属标记未能进入最终删除阶段：${markerRemoved.output.trim().slice(-400)}`,
    );
  }
  const removed = await runWrangler(
    ["r2", "bucket", "delete", node.bucketName],
    node,
    { profile: node.profile },
  );
  if (removed.code !== 0 && !isMissingCloudflareResource(removed.output)) {
    throw new Error(
      `节点 R2 存储桶 ${node.bucketName} 未能删除：${removed.output.trim().slice(-500)}`,
    );
  }
  console.log(`  ✓ 受管 R2 存储桶 ${node.bucketName} 已删除。`);
}

async function deleteStorageNodes(inventory, nodes) {
  if (!nodes.length) return;
  console.log(`\n正在清理 ${nodes.length} 个附加存储节点…`);
  for (const node of nodes) {
    if (node.uninstallCompletedAt) {
      console.log(`- ${node.label}：此前已完成，跳过远端修改。`);
      continue;
    }
    console.log(
      `- ${node.label}（${node.accountId} / profile ${node.profile}）`,
    );
    await deleteStorageNodeWorker(node);
    if (node.bucketMissing) {
      console.log(`  ✓ R2 存储桶 ${node.bucketName} 已经不存在。`);
    } else {
      try {
        await purgeAllR2Data(node, node.cleanup, node.managedBucket);
        if (node.managedBucket) {
          await deleteManagedStorageNodeBucket(node);
        } else {
          console.log(
            `  ✓ 共用桶 ${node.bucketName} 只清除了本实例 owner UUID 前缀；存储桶和其他配置已保留。`,
          );
        }
      } catch (error) {
        if (node.managedBucket) {
          try {
            await restoreManagedBucketOwnershipMarker(node);
          } catch (restoreError) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}；${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            );
          }
        }
        throw error;
      }
    }
    await markStorageNodeUninstalled(inventory, node.id);
  }
  if (inventory.nodes.some((node) => !node.uninstallCompletedAt)) {
    throw new Error("仍有附加存储节点未完成；D1 和节点清单均已保留。");
  }
}

async function deleteD1(instance, existing) {
  console.log(`[3/3] 正在删除资料数据库 ${instance.d1Name}…`);
  if (!existing) {
    console.log("✓ 资料数据库已经不存在。");
    return;
  }
  const removed = await runWrangler(
    [
      "d1",
      "delete",
      instance.d1Name,
      "--skip-confirmation",
      "--config",
      CONFIG_PATH,
    ],
    instance,
  );
  if (removed.code !== 0 && !isMissingCloudflareResource(removed.output)) {
    throw new Error(`资料数据库未能删除：${removed.output.trim().slice(-500)}`);
  }
  console.log("✓ 资料数据库和主人账号信息已删除。");
}

async function deleteWorker(instance) {
  console.log(`\n[1/3] 正在删除云端 Worker ${instance.workerName}，阻止新的文件写入…`);
  const removed = await runWrangler(
    ["delete", instance.workerName, "--force", "--config", CONFIG_PATH],
    instance,
  );
  if (removed.code !== 0 && !isMissingCloudflareResource(removed.output)) {
    throw new Error(`云端服务未能删除：${removed.output.trim().slice(-500)}`);
  }
  console.log(
    instance.customHostname
      ? `✓ Worker、Worker Secret 和域名绑定 ${instance.customHostname} 已删除。`
      : "✓ Worker 和 Worker Secret 已删除或原本没有发布。",
  );
}

async function writeDefaultConfig() {
  const temporary = `${CONFIG_PATH}.reset-${process.pid}.tmp`;
  await writeFile(temporary, await readFile(DEFAULT_CONFIG_PATH, "utf8"), "utf8");
  await rename(temporary, CONFIG_PATH);
}

async function clearLocalInstance() {
  const targets = [
    path.join(ROOT, ".dev.vars"),
    path.join(ROOT, "config", "r2-cors.local.json"),
    path.join(ROOT, ".wrangler"),
    path.join(ROOT, ".vinext"),
    path.join(ROOT, ".next"),
    path.join(ROOT, "dist"),
    path.join(ROOT, "tsconfig.tsbuildinfo"),
  ];
  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
  }
  await writeDefaultConfig();
}

async function uninstallProvisioningPrimary(ownership, prompt) {
  let cleanupPlan;
  try {
    cleanupPlan = primaryProvisioningCleanupPlan(ownership);
  } catch {
    console.log(
      "\n本机配置不完整，但归属凭证显示 Worker/D1 配置曾经开始。为避免漏删或误删，已整体停止；请先从备份恢复 wrangler.jsonc 或重新打开更新助手。",
    );
    return;
  }
  console.log("\n检测到尚未完成配置的主 R2 资源：");
  console.log(`- Cloudflare 账号：${ownership.accountId}`);
  console.log(
    cleanupPlan.deleteBucket
      ? `- 受管 R2 存储桶：${ownership.r2Name}（删除桶及其中全部内容）`
      : `- 复用 R2 存储桶：${ownership.r2Name}（只删除本次配置写入的随机归属标记，保留桶和其他数据）`,
  );
  console.log("- 本机未登记主 Worker 或 D1，不会按名称猜测这些资源。");
  const confirmation = (
    await prompt.question('\n确定处理这项中断配置。请输入 DELETE 后回车：')
  ).trim();
  if (confirmation !== "DELETE") {
    console.log("\n已取消，没有删除任何信息。");
    return;
  }

  await ensureDependencies();
  await stopOwnedService(3000, "drive");
  await stopOwnedService(8788, "setup");
  const target = {
    accountId: ownership.accountId,
    bucketName: ownership.r2Name,
  };
  const r2Missing = await inspectBucketForUninstall(
    target,
    "default",
    CONFIG_PATH,
  );
  if (!r2Missing) {
    await verifyPrimaryBucketForUninstall(ownership);
  }
  await deleteR2(
    {
      accountId: ownership.accountId,
      r2Name: ownership.r2Name,
    },
    ownership,
    r2Missing,
    { uploads: [], prefixes: [] },
  );
  await finalizeReusedPrimaryBucket(ownership, r2Missing);
  await clearLocalInstance();
  console.log("\n✓ 中断的主 R2 配置已按随机归属凭证安全清理。");
}

async function uninstallInstance(instance, prompt) {
  if (!instance.configured) {
    const ownership = await readPrimaryOwnershipIntent(
      PRIMARY_OWNERSHIP_PATH,
      { allowMissing: true },
    );
    if (ownership) {
      await uninstallProvisioningPrimary(ownership, prompt);
      return;
    }
    console.log(
      "\n当前没有可安全识别的实例配置或随机归属凭证，无法按资源名称一键卸载。可以选择 2 重新配置。",
    );
    return;
  }
  const localOwnership = await readPrimaryOwnershipIntent(
    PRIMARY_OWNERSHIP_PATH,
    { allowMissing: true },
  );
  if (!localOwnership) {
    console.log(
      "\n当前实例缺少 v0.3 随机主资源归属凭证。旧版同名 Worker/R2 不会在卸载时临时认领；没有删除 Worker、R2、D1 或本机配置。请先用更新助手完成安全迁移。",
    );
    return;
  }
  const primaryOwnership = assertPrimaryOwnershipMatchesInstance(
    localOwnership,
    instance,
  );
  const inventory = await readStoragePoolInventory();
  console.log("\n一键卸载将永久删除以下当前 R2 Drive 实例：");
  console.log(`- Cloudflare Worker：${instance.workerName}（含版本、Secret 和路由）`);
  if (instance.customHostname) console.log(`- Worker 域名绑定：${instance.customHostname}`);
  console.log(
    primaryOwnership.managedBucket
      ? `- 受管 R2 存储桶：${instance.r2Name}（全部文件、CORS、生命周期和桶级配置）`
      : `- 复用 R2 存储桶：${instance.r2Name}（只清理本实例 owner UUID 前缀与归属标记，保留桶和其他配置）`,
  );
  console.log(`- D1 资料数据库：${instance.d1Name}（主人账号、目录、分享和审计信息）`);
  if (inventory.nodes.length) {
    console.log(`- 附加存储节点：${inventory.nodes.length} 个`);
    for (const node of inventory.nodes) {
      const bucketAction = node.managedBucket
        ? `删除受管桶 ${node.bucketName}`
        : `仅清理共用桶 ${node.bucketName} 的本实例 UUID 前缀`;
      const workerAction = node.managedWorker
        ? `删除受管 Worker ${node.workerName}`
        : `保留非受管 Worker ${node.workerName}`;
      const progress = node.uninstallCompletedAt ? "（此前已清理）" : "";
      const provisioning =
        node.status === "active" ? "" : `（${node.status}，连接未完成）`;
      console.log(
        `  · ${node.label}${progress}${provisioning}：账号 ${node.accountId} / profile ${node.profile}；${bucketAction}；${workerAction}`,
      );
    }
  }
  console.log("- 本机 Secret、缓存和实例配置");
  console.log(
    "\n不会退出或删除任何 Wrangler profile；非受管共用桶中的其他数据和配置会保留。",
  );
  const confirmation = (await prompt.question('\n确定不可恢复。请输入 DELETE 后回车：')).trim();
  if (confirmation !== "DELETE") {
    console.log("\n已取消卸载，没有删除任何信息。");
    return;
  }

  await ensureDependencies();
  console.log("\n正在停止本机 R2 Drive…");
  await stopOwnedService(3000, "drive");
  await stopOwnedService(8788, "setup");
  const workspace = await mkdtemp(path.join(tmpdir(), "r2-drive-uninstall-"));
  try {
    const nodeTargets = await writeNodeUninstallConfigs(inventory, workspace);
    const targets = await preflightUninstall(instance, nodeTargets);
    await deleteWorker(instance);
    await deleteStorageNodes(inventory, targets.nodes);
    await deleteR2(
      instance,
      targets.ownership,
      targets.r2Missing,
      targets.primaryCleanup,
    );
    await deleteD1(instance, targets.database);
    await finalizeReusedPrimaryBucket(
      targets.ownership,
      targets.r2Missing,
    );
    await clearLocalInstance();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  console.log("\n✓ R2 Drive 已一键卸载完成。源代码仍保留，可选择 2 重新配置。");
}

export function formatMenu(instance) {
  const status =
    instance.configured && instance.customHostname
      ? "已配置完毕"
      : instance.configured
        ? "缺少域名"
        : "尚未配置";
  return [
    "====================================================",
    ` R2 Drive 小白启动器 · ${status}`,
    "====================================================",
    `1. 打开网盘【${status}】`,
    "2. 配置／重新配置",
    "3. 一键卸载（遇到 R2 10008 自动清除 all）",
    "4. 检查更新／一键升级",
    "0. 退出",
  ].join("\n");
}

function printMenu(instance) {
  console.log(`\n${formatMenu(instance)}`);
}

async function main() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const instance = describeInstance(await readConfig());
      printMenu(instance);
      const choice = (await prompt.question("\n请输入 1、2、3、4 或 0：")).trim();
      try {
        if (choice === "1") await openDrive(instance);
        else if (choice === "2") await openSetup();
        else if (choice === "3") await uninstallInstance(instance, prompt);
        else if (choice === "4") await openUpdater();
        else if (choice === "0") break;
        else console.log("\n请输入菜单中的数字。");
      } catch (error) {
        console.error(`\n✕ ${error instanceof Error ? error.message : String(error)}`);
        console.error("没有完成的资源会保留，请处理提示后重新选择相同操作。");
      }
    }
  } finally {
    if (
      setupHelperProcess &&
      setupHelperProcess.pid &&
      setupHelperProcess.exitCode === null
    ) {
      setupHelperProcess.kill("SIGTERM");
      await waitForProcessExit(setupHelperProcess.pid, 1_500);
    }
    prompt.close();
    process.stdin.pause();
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`\n✕ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

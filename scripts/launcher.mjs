#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findD1DatabaseByName, parseWranglerJson } from "./wrangler-output.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "config", "wrangler.default.jsonc");
const SETUP_URL = "http://127.0.0.1:8788/";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const D1_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUDFLARE_API_MAX_ATTEMPTS = 8;
// A "* * * * *" trigger fires at the next minute boundary, so one round has to
// tolerate roughly a minute of waiting before the helper runs at all.
const PURGE_ROUND_TIMEOUT_MS = 240_000;
const MAX_PURGE_ROUNDS = 10;
const MAX_UPLOADS_PER_ROUND = 500;
let dependenciesChecked = false;
let cloudflareDispatcher;
let cloudflareFetch;
let cloudflareRetryNoticeShown = false;
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

function runProcess(program, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
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

async function ensureSetupHelper() {
  if (await pageContains(SETUP_URL, "R2 Drive · 本地安装向导")) return;
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
  if (await pageContains(SETUP_URL, "R2 Drive · 本地安装向导")) {
    await openBrowser(SETUP_URL);
    console.log("\n✓ 配置助手已经在运行，已为你打开。");
    return;
  }
  await stopOwnedService(8788, "setup");
  await ensureDependencies();
  console.log("\n正在打开配置助手…\n");
  await runProcess(process.execPath, [path.join(ROOT, "scripts", "setup.mjs")]);
}

async function openUpdater() {
  await ensureDependencies();
  await ensureSetupHelper();
  await openBrowser(`${SETUP_URL}?step=update`);
  console.log("\n✓ 已打开程序更新页面。检查版本不会修改任何文件；安装前会再次要求确认。");
}

function wranglerAuthFileCandidates() {
  const environment = process.env.CLOUDFLARE_API_ENVIRONMENT ?? "production";
  const filename = environment === "production" ? "default.toml" : `${environment}.toml`;
  const home = homedir();
  return [
    path.join(home, ".wrangler", "config", filename),
    path.join(home, "Library", "Preferences", ".wrangler", "config", filename),
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
      ".wrangler",
      "config",
      filename,
    ),
    process.env.APPDATA
      ? path.join(process.env.APPDATA, ".wrangler", "config", filename)
      : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, ".wrangler", "config", filename)
      : "",
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function readTomlString(source, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`^${escapedKey}\\s*=\\s*("(?:\\\\.|[^"])*")`, "m"),
  );
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return "";
  }
}

async function cloudflareAuthHeaders() {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  const apiKey = process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY;
  const apiEmail = process.env.CLOUDFLARE_EMAIL || process.env.CF_API_EMAIL;
  if (apiKey && apiEmail) {
    return { "X-Auth-Key": apiKey, "X-Auth-Email": apiEmail };
  }
  for (const authPath of wranglerAuthFileCandidates()) {
    try {
      const source = await readFile(authPath, "utf8");
      const oauthToken = readTomlString(source, "oauth_token");
      if (oauthToken) return { Authorization: `Bearer ${oauthToken}` };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("没有找到 Wrangler 登录授权。请先选择 2 重新连接 Cloudflare。");
}

async function initializeCloudflareFetch() {
  if (cloudflareFetch) return;
  const undici = await import("undici");
  cloudflareFetch = undici.fetch;
  cloudflareDispatcher = new undici.EnvHttpProxyAgent();
}

function cloudflareRetryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(seconds * 1_000, 1_000), 60_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 1_000), 60_000);
    }
  }
  return Math.min(2 ** attempt * 1_000, 30_000);
}

async function cloudflareApi(pathname, options = {}) {
  await initializeCloudflareFetch();
  const url = new URL(`https://api.cloudflare.com/client/v4${pathname}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = await cloudflareAuthHeaders();
  for (let attempt = 0; attempt < CLOUDFLARE_API_MAX_ATTEMPTS; attempt += 1) {
    const response = await cloudflareFetch(url, {
      method: options.method ?? "GET",
      headers,
      dispatcher: cloudflareDispatcher,
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 404) return { missing: true, result: null };
    if (response.ok && payload?.success) return { missing: false, ...payload };
    const retryable =
      response.status === 429 ||
      response.status === 500 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504;
    if (retryable && attempt + 1 < CLOUDFLARE_API_MAX_ATTEMPTS) {
      const delayMs = cloudflareRetryDelay(response, attempt);
      if (!cloudflareRetryNoticeShown) {
        cloudflareRetryNoticeShown = true;
        console.log(
          `\nCloudflare 正在限流或暂时繁忙，将等待 ${Math.ceil(delayMs / 1_000)} 秒后继续…`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    const message = Array.isArray(payload?.errors)
      ? payload.errors.map((item) => item?.message).filter(Boolean).join("；")
      : "";
    throw new Error(
      message
        ? `Cloudflare 删除失败：${message.slice(0, 300)}`
        : `Cloudflare 删除失败（HTTP ${response.status}）。`,
    );
  }
  throw new Error("Cloudflare 删除失败：重试次数已用完。");
}

export function encodeR2ObjectKey(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}

async function emptyR2Bucket(instance) {
  let deleted = 0;
  while (true) {
    const listed = await cloudflareApi(
      `/accounts/${instance.accountId}/r2/buckets/${encodeURIComponent(instance.r2Name)}/objects`,
      { query: { per_page: 1000 } },
    );
    if (listed.missing) return { missing: true, deleted };
    const keys = Array.isArray(listed.result)
      ? listed.result
          .map((item) => item?.key)
          .filter((key) => typeof key === "string")
      : [];
    if (keys.length === 0) return { missing: false, deleted };
    for (let index = 0; index < keys.length; index += 20) {
      const batch = keys.slice(index, index + 20);
      await Promise.all(
        batch.map((key) =>
          cloudflareApi(
            `/accounts/${instance.accountId}/r2/buckets/${encodeURIComponent(instance.r2Name)}/objects/${encodeR2ObjectKey(key)}`,
            { method: "DELETE" },
          ),
        ),
      );
      deleted += batch.length;
      process.stdout.write(`\r已永久删除 R2 文件：${deleted}`);
    }
  }
}

async function runWrangler(args, instance) {
  const result = await runProcess(
    executable("npx"),
    ["--no-install", "wrangler", ...args],
    {
      capture: true,
      env: {
        CLOUDFLARE_ACCOUNT_ID: instance.accountId,
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

function isMissingCloudflareResource(output) {
  return /does not exist|not found|NoSuchBucket|code:\s*1000[67]/i.test(output);
}

function isR2BucketNotEmpty(output) {
  return /code:\s*10008|bucket.+not empty|bucket.+isn.t empty/i.test(output);
}

async function pendingMultipartUploads(instance) {
  const result = await runWrangler(
    [
      "d1",
      "execute",
      instance.d1Name,
      "--remote",
      "--command",
      "SELECT upload_id, storage_key FROM multipart_uploads",
      "--json",
      "--config",
      CONFIG_PATH,
    ],
    instance,
  );
  if (result.code !== 0) {
    if (/no such table|does not exist|not found/i.test(result.output)) return [];
    throw new Error(`无法检查残留分片上传：${result.output.trim().slice(-500)}`);
  }
  const payload = parseWranglerJson(result.output, "Wrangler D1");
  const rows = Array.isArray(payload)
    ? payload.flatMap((entry) => (Array.isArray(entry?.results) ? entry.results : []))
    : [];
  const uploads = rows
    .map((row) => ({
      uploadId: typeof row?.upload_id === "string" ? row.upload_id : "",
      storageKey: typeof row?.storage_key === "string" ? row.storage_key : "",
    }))
    .filter((upload) => upload.uploadId && upload.storageKey);
  return [
    ...new Map(
      uploads.map((upload) => [`${upload.storageKey}\u0000${upload.uploadId}`, upload]),
    ).values(),
  ];
}

async function listIncompleteMultipartUploads(instance) {
  const listed = await cloudflareApi(
    `/accounts/${instance.accountId}/r2/buckets/${encodeURIComponent(instance.r2Name)}/uploads`,
  );
  if (listed.missing) return [];
  const uploads = (Array.isArray(listed.result) ? listed.result : [])
    .map((item) => ({
      storageKey: typeof item?.key === "string" ? item.key : "",
      uploadId: typeof item?.uploadId === "string" ? item.uploadId : "",
    }))
    .filter((upload) => upload.storageKey && upload.uploadId);
  return [
    ...new Map(
      uploads.map((upload) => [`${upload.storageKey}\u0000${upload.uploadId}`, upload]),
    ).values(),
  ];
}

// R2 lists what is really in the bucket; the app's own table is the fallback
// for when that endpoint is unavailable.
async function leftoverMultipartUploads(instance) {
  try {
    return await listIncompleteMultipartUploads(instance);
  } catch {
    return await pendingMultipartUploads(instance);
  }
}

async function waitForMultipartUploadsToDrain(instance, startedAt) {
  let remaining = await leftoverMultipartUploads(instance);
  let progressWidth = 0;
  while (remaining.length > 0 && Date.now() - startedAt < PURGE_ROUND_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const waited = Math.round((Date.now() - startedAt) / 1000);
    const line = `清除 all：等待云端清理残留分片…（已等待 ${waited} 秒）`;
    progressWidth = Math.max(progressWidth, line.length);
    process.stdout.write(`\r${line}`);
    remaining = await leftoverMultipartUploads(instance);
  }
  if (progressWidth > 0) process.stdout.write(`\r${" ".repeat(progressWidth)}\r`);
  return remaining;
}

// The temporary helper runs from a cron trigger entirely at Cloudflare's edge.
// This avoids `wrangler dev --remote`, whose local preview connection cannot
// start on proxy-only networks.
async function abortMultipartUploadsOnEdge(instance, uploads) {
  const workspace = await mkdtemp(path.join(tmpdir(), "r2-drive-purge-"));
  const configPath = path.join(workspace, "wrangler.jsonc");
  const helperPath = path.join(workspace, "uninstall-worker.mjs");
  const workerName = `r2-drive-purge-${randomBytes(6).toString("hex")}`;

  try {
    await Promise.all([
      writeFile(
        configPath,
        `${JSON.stringify(
          {
            name: workerName,
            main: helperPath,
            compatibility_date: "2025-01-01",
            account_id: instance.accountId,
            workers_dev: false,
            preview_urls: false,
            triggers: { crons: ["* * * * *"] },
            vars: { PURGE_UPLOADS: JSON.stringify(uploads) },
            r2_buckets: [{ binding: "FILES", bucket_name: instance.r2Name }],
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        helperPath,
        await readFile(path.join(ROOT, "scripts", "uninstall-worker.mjs"), "utf8"),
        { mode: 0o600 },
      ),
    ]);

    const deployed = await runWrangler(["deploy", "--config", configPath], instance);
    if (deployed.code !== 0) {
      throw new Error(
        `Cloudflare 清理助手部署失败：${deployed.output.trim().slice(-500)}`,
      );
    }
    return await waitForMultipartUploadsToDrain(instance, Date.now());
  } finally {
    const removed = await runWrangler(
      ["delete", workerName, "--force", "--config", configPath],
      instance,
    );
    if (removed.code !== 0 && !isMissingCloudflareResource(removed.output)) {
      console.log(
        `⚠ 临时清理助手 ${workerName} 没能自动删除，请在 Cloudflare 控制台的 Workers 列表里手动删除它。`,
      );
    }
    await rm(workspace, { recursive: true, force: true });
  }
}

async function purgeAllR2Data(instance) {
  let remaining = await leftoverMultipartUploads(instance);
  if (remaining.length === 0) return;

  console.log(
    `检测到 R2 桶仍非空，正在执行清除 all（${remaining.length} 个残留分片上传）…`,
  );
  console.log(
    "云端清理由定时任务触发，第一次通常需要等待约 1 分钟，请不要关闭窗口。",
  );

  for (let round = 0; round < MAX_PURGE_ROUNDS && remaining.length > 0; round += 1) {
    const before = remaining.length;
    remaining = await abortMultipartUploadsOnEdge(
      instance,
      remaining.slice(0, MAX_UPLOADS_PER_ROUND),
    );
    if (remaining.length >= before) break;
  }

  if (remaining.length > 0) {
    throw new Error(
      `Cloudflare 仍有 ${remaining.length} 个残留分片上传没有清除，R2 存储桶暂时无法删除。请稍后重新选择相同操作；若一直失败，可在 Cloudflare 控制台手动删除存储桶 ${instance.r2Name}。`,
    );
  }
  console.log("✓ 清除 all 完成：残留分片上传已全部 abort。");
}

async function deleteR2(instance, alreadyMissing = false) {
  console.log(`[2/3] 正在清空并删除 R2 存储桶 ${instance.r2Name}…`);
  if (alreadyMissing) {
    console.log("✓ R2 存储桶已经不存在。");
    return;
  }
  const emptied = await emptyR2Bucket(instance);
  if (emptied.deleted > 0) process.stdout.write("\n");
  if (emptied.missing) {
    console.log("✓ R2 存储桶已经不存在。");
    return;
  }
  let result = await runWrangler(
    ["r2", "bucket", "delete", instance.r2Name],
    instance,
  );
  if (result.code !== 0 && isR2BucketNotEmpty(result.output)) {
    await purgeAllR2Data(instance);
    const finalEmpty = await emptyR2Bucket(instance);
    if (finalEmpty.deleted > 0) process.stdout.write("\n");
    result = await runWrangler(["r2", "bucket", "delete", instance.r2Name], instance);
  }
  if (result.code !== 0 && !isMissingCloudflareResource(result.output)) {
    throw new Error(`R2 存储桶未能删除：${result.output.trim().slice(-500)}`);
  }
  console.log("✓ R2 存储桶及其中所有文件已删除。");
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

async function preflightUninstall(instance) {
  console.log("\n正在核对当前 Cloudflare 账号和卸载目标，不会在这一步删除数据…");
  const [database, r2] = await Promise.all([
    inspectD1ForUninstall(instance),
    cloudflareApi(
      `/accounts/${instance.accountId}/r2/buckets/${encodeURIComponent(instance.r2Name)}/objects`,
      { query: { per_page: 1 } },
    ),
  ]);
  console.log(
    `✓ 卸载目标已核对：Worker ${instance.workerName}、R2 ${instance.r2Name}、D1 ${instance.d1Name}。`,
  );
  return { database, r2Missing: r2.missing };
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

async function uninstallInstance(instance, prompt) {
  if (!instance.configured) {
    console.log("\n当前没有可安全识别的一整套实例配置，无法一键卸载。可以选择 2 重新配置。");
    return;
  }
  console.log("\n一键卸载将永久删除以下当前 R2 Drive 实例：");
  console.log(`- Cloudflare Worker：${instance.workerName}（含版本、Secret 和路由）`);
  if (instance.customHostname) console.log(`- Worker 域名绑定：${instance.customHostname}`);
  console.log(
    `- R2 存储桶：${instance.r2Name}（全部文件、CORS、生命周期和桶级配置）`,
  );
  console.log(`- D1 资料数据库：${instance.d1Name}（主人账号、目录、分享和审计信息）`);
  console.log("- 本机 Secret、缓存和实例配置");
  console.log("\n不会删除 Wrangler 登录，也不会碰 Cloudflare 账号中的其他项目。");
  const confirmation = (await prompt.question('\n确定不可恢复。请输入 DELETE 后回车：')).trim();
  if (confirmation !== "DELETE") {
    console.log("\n已取消卸载，没有删除任何信息。");
    return;
  }

  await ensureDependencies();
  console.log("\n正在停止本机 R2 Drive…");
  await stopOwnedService(3000, "drive");
  await stopOwnedService(8788, "setup");
  const targets = await preflightUninstall(instance);
  await deleteWorker(instance);
  await deleteR2(instance, targets.r2Missing);
  await deleteD1(instance, targets.database);
  await clearLocalInstance();
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

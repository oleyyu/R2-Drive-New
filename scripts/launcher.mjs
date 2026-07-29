#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findD1DatabaseByName, parseWranglerJson } from "./wrangler-output.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "config", "wrangler.default.jsonc");
const LOCAL_DRIVE_URL = "http://localhost:3000/start";
const SETUP_URL = "http://127.0.0.1:8788/";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const D1_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let dependenciesChecked = false;
let cloudflareDispatcher;
let cloudflareFetch;
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
  return instance.customHostname
    ? `https://${instance.customHostname}/start`
    : LOCAL_DRIVE_URL;
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

async function waitForDrive(child, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`网盘启动失败，进程状态码为 ${child.exitCode}。`);
    }
    if (await pageContains(LOCAL_DRIVE_URL, "R2 Drive")) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGTERM");
  throw new Error("网盘启动超过两分钟。请重新打开启动器后再试。");
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
  if (instance.customHostname) {
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
    return;
  }
  if (await pageContains(LOCAL_DRIVE_URL, "R2 Drive")) {
    await ensureSetupHelper();
    await openBrowser(LOCAL_DRIVE_URL);
    console.log("\n✓ 网盘已经在运行，已为你打开。");
    return;
  }

  await stopOwnedService(3000, "drive");
  await ensureDependencies();
  await ensureSetupHelper();
  console.log("\n正在启动网盘。第一次编译可能需要几十秒，请保留这个窗口…\n");
  const child = spawn(
    executable("npm"),
    ["run", "dev", "--", "--port", "3000", "--hostname", "localhost"],
    { cwd: ROOT, env: process.env, shell: false, stdio: "inherit", windowsHide: true },
  );
  await waitForDrive(child);
  await openBrowser(LOCAL_DRIVE_URL);
  console.log("\n✓ 网盘已打开。关闭这个终端或按 Ctrl+C 即可停止网盘。\n");
  await new Promise((resolve) => child.once("close", resolve));
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

async function cloudflareApi(pathname, options = {}) {
  await initializeCloudflareFetch();
  const url = new URL(`https://api.cloudflare.com/client/v4${pathname}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await cloudflareFetch(url, {
    method: options.method ?? "GET",
    headers: await cloudflareAuthHeaders(),
    dispatcher: cloudflareDispatcher,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 404) return { missing: true, result: null };
  if (!response.ok || !payload?.success) {
    const message = Array.isArray(payload?.errors)
      ? payload.errors.map((item) => item?.message).filter(Boolean).join("；")
      : "";
    throw new Error(
      message
        ? `Cloudflare 删除失败：${message.slice(0, 300)}`
        : `Cloudflare 删除失败（HTTP ${response.status}）。`,
    );
  }
  return { missing: false, ...payload };
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

async function deleteR2(instance) {
  console.log(`\n[1/3] 正在清空并删除 R2 存储桶 ${instance.r2Name}…`);
  const emptied = await emptyR2Bucket(instance);
  if (emptied.deleted > 0) process.stdout.write("\n");
  if (emptied.missing) {
    console.log("✓ R2 存储桶已经不存在。");
    return;
  }
  const result = await runWrangler(
    ["r2", "bucket", "delete", instance.r2Name],
    instance,
  );
  if (result.code !== 0 && !isMissingCloudflareResource(result.output)) {
    throw new Error(`R2 存储桶未能删除：${result.output.trim().slice(-500)}`);
  }
  console.log("✓ R2 存储桶及其中所有文件已删除。");
}

async function deleteD1(instance) {
  console.log(`[2/3] 正在删除资料数据库 ${instance.d1Name}…`);
  const listed = await runWrangler(["d1", "list", "--json"], instance);
  if (listed.code !== 0) {
    throw new Error(`无法检查资料数据库：${listed.output.trim().slice(-500)}`);
  }
  const existing = findD1DatabaseByName(
    parseWranglerJson(listed.output, "Wrangler D1"),
    instance.d1Name,
  );
  if (!existing) {
    console.log("✓ 资料数据库已经不存在。");
    return;
  }
  if (existing.id !== instance.d1Id) {
    throw new Error(
      `同名资料数据库的编号与本实例不一致。为避免误删，已停止；没有删除 ${instance.d1Name}。`,
    );
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
  console.log(`[3/3] 正在删除云端服务 ${instance.workerName}…`);
  const removed = await runWrangler(
    ["delete", instance.workerName, "--force", "--config", CONFIG_PATH],
    instance,
  );
  if (removed.code !== 0 && !isMissingCloudflareResource(removed.output)) {
    throw new Error(`云端服务未能删除：${removed.output.trim().slice(-500)}`);
  }
  console.log(
    instance.customHostname
      ? `✓ 云端服务和域名绑定 ${instance.customHostname} 已删除。`
      : "✓ 云端服务已经删除或原本没有发布。",
  );
}

async function writeDefaultConfig() {
  const temporary = `${CONFIG_PATH}.reset-${process.pid}.tmp`;
  await writeFile(temporary, await readFile(DEFAULT_CONFIG_PATH, "utf8"), "utf8");
  await rename(temporary, CONFIG_PATH);
}

async function clearLocalInstance() {
  await writeDefaultConfig();
  const targets = [
    path.join(ROOT, ".dev.vars"),
    path.join(ROOT, "config", "r2-cors.local.json"),
    path.join(ROOT, ".wrangler"),
    path.join(ROOT, ".vinext"),
    path.join(ROOT, "dist"),
    path.join(ROOT, "tsconfig.tsbuildinfo"),
  ];
  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
  }
}

async function deleteEverything(instance, prompt) {
  if (!instance.configured) {
    console.log("\n当前没有完整的实例配置。可以选择 2 重新配置。");
    return;
  }
  console.log("\n将永久删除以下当前 R2 Drive 实例：");
  console.log(`- R2 存储桶：${instance.r2Name}（其中所有文件）`);
  console.log(`- 资料数据库：${instance.d1Name}（主人账号、目录和分享）`);
  console.log(`- 云端服务：${instance.workerName}`);
  if (instance.customHostname) console.log(`- 域名绑定：${instance.customHostname}`);
  console.log("- 本机账号、缓存、Secret 和实例配置");
  console.log("\n不会删除 Wrangler 登录，也不会碰 Cloudflare 账号中的其他项目。");
  const confirmation = (await prompt.question('\n确定不可恢复。请输入 DELETE 后回车：')).trim();
  if (confirmation !== "DELETE") {
    console.log("\n已取消，没有删除任何信息。");
    return;
  }

  await ensureDependencies();
  console.log("\n正在停止本机 R2 Drive…");
  await stopOwnedService(3000, "drive");
  await stopOwnedService(8788, "setup");
  await deleteR2(instance);
  await deleteD1(instance);
  await deleteWorker(instance);
  await clearLocalInstance();
  console.log("\n✓ 当前 R2 Drive 实例已全部删除。源代码仍保留，可选择 2 重新配置。");
}

export function formatMenu(instance) {
  const status = instance.configured ? "已配置完毕" : "尚未配置";
  return [
    "====================================================",
    ` R2 Drive 小白启动器 · ${status}`,
    "====================================================",
    `1. 打开网盘【${status}】`,
    "2. 配置／重新配置",
    "3. 删除所有信息（本机 + 当前 Cloudflare R2 Drive）",
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
      const choice = (await prompt.question("\n请输入 1、2、3 或 0：")).trim();
      try {
        if (choice === "1") await openDrive(instance);
        else if (choice === "2") await openSetup();
        else if (choice === "3") await deleteEverything(instance, prompt);
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

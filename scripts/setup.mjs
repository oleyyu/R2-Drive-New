#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import {
  classifyWorkersPlan,
  R2_STANDARD_FREE_TIER,
} from "./cloudflare-plan.mjs";
import {
  applyReleaseTree,
  compareVersions,
  createUpdateWorkspace,
  downloadReleaseArchive,
  extractReleaseArchive,
  fetchLatestRelease,
  removeUpdateWorkspace,
  rollbackReleaseTree,
} from "./updater.mjs";
import { findD1DatabaseByName, parseWranglerJson } from "./wrangler-output.mjs";
import { createStoragePoolService } from "./storage-pool.mjs";
import {
  assertLegacyWorkerVersionBindings,
  assertLegacyBucketEvidence,
  assertPrimaryBucketOwnership,
  assertPrimaryWorkerOwnership,
  assertWorkerVersionInstallationBinding,
  bindPrimaryOwnershipIntent,
  createPrimaryOwnershipIntent,
  createPrimaryWorkerChallenge,
  ensurePrimaryOwnershipIntent,
  PRIMARY_WORKER_IDENTITY_PATH,
  PRIMARY_WORKER_ID_VAR,
  PRIMARY_WORKER_SECRET_NAME,
  primaryBucketOwnershipBody,
  readPrimaryOwnershipIntent,
  recordPrimaryBucketObservation,
  r2ObjectsFromApiPayload,
  setPrimaryBucketManagement,
  validatePrimaryOwnershipIntent,
  writePrimaryOwnershipIntent,
} from "./primary-ownership.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_PATH = path.join(ROOT, "package.json");
const CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");
const DEV_VARS_PATH = path.join(ROOT, ".dev.vars");
const CORS_PATH = path.join(ROOT, "config", "r2-cors.local.json");
const ACCELERATION_STATE_PATH = path.join(ROOT, ".wrangler", "upload-acceleration.json");
const PRIMARY_OWNERSHIP_PATH = path.join(
  ROOT,
  ".wrangler",
  "primary-ownership.json",
);
const UI_PATH = path.join(ROOT, "scripts", "setup-ui.html");
const HOST = "127.0.0.1";
const requestedPort = Number.parseInt(process.env.R2_DRIVE_SETUP_PORT ?? "8788", 10);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
  ? requestedPort
  : 8788;
const requestedLocalPort = Number.parseInt(process.env.R2_DRIVE_LOCAL_PORT ?? "3000", 10);
const LOCAL_PORT =
  Number.isInteger(requestedLocalPort) && requestedLocalPort > 0 && requestedLocalPort < 65536
    ? requestedLocalPort
    : 3000;
const LOCAL_ORIGIN = `http://localhost:${LOCAL_PORT}`;
const LOCAL_ENTRY_URL = `${LOCAL_ORIGIN}/start`;
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const COMMAND_TERMINATION_GRACE_MS = 2_000;
const COMMAND_FORCE_SETTLE_MS = 1_000;
const csrfToken = randomBytes(32).toString("hex");
const cloudflareDispatcher = new EnvHttpProxyAgent();
const runtimeVersion = JSON.parse(await readFile(PACKAGE_PATH, "utf8")).version;
const jobs = new Map();
let currentJobId = null;
let localDevProcess = null;
let localDevUrl = null;
let setupRestartScheduled = false;

const ANSI_PATTERN = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);

function cleanOutput(value) {
  return String(value).replace(ANSI_PATTERN, "").replaceAll("\r", "");
}

function addLog(job, message) {
  const cleaned = cleanOutput(message);
  if (!cleaned) return;
  job.logs.push(cleaned);
  let size = job.logs.reduce((total, entry) => total + entry.length, 0);
  while (size > 160_000 && job.logs.length > 1) {
    size -= job.logs.shift().length;
  }
}

function setJobProgress(job, percent, stage, message) {
  job.progress = {
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    stage,
    message,
    updatedAt: new Date().toISOString(),
  };
}

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function captureProcess(program, args, options = {}) {
  return new Promise((resolve) => {
    let timer;
    const child = spawn(program, args, {
      cwd: options.cwd ?? ROOT,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs ?? 3_000);
    child.stdout.on("data", (chunk) => {
      stdout += cleanOutput(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += cleanOutput(chunk);
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut: false });
    });
  });
}

async function listeningProcessIds() {
  if (process.platform === "win32") {
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
      `Get-NetTCPConnection -State Listen -LocalPort ${LOCAL_PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    ].join("; ");
    const result = await captureProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeoutMs: 5_000 },
    );
    return [
      ...new Set(
        result.stdout
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      ),
    ];
  }

  const result = await captureProcess("lsof", [
    "-nP",
    "-t",
    `-iTCP:${LOCAL_PORT}`,
    "-sTCP:LISTEN",
  ]);
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
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      "if ($process) { $process.CommandLine }",
    ].join("; ");
    const result = await captureProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeoutMs: 5_000 },
    );
    return { command: result.stdout.trim(), cwd: "" };
  }

  const [commandResult, cwdResult] = await Promise.all([
    captureProcess("ps", ["-p", String(pid), "-o", "command="]),
    captureProcess("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
  ]);
  const cwdLine = cwdResult.stdout
    .split("\n")
    .find((line) => line.startsWith("n"));
  return {
    command: commandResult.stdout.trim(),
    cwd: cwdLine ? cwdLine.slice(1).trim() : "",
  };
}

function normalizeProcessPath(value) {
  return String(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function isOwnedLocalDriveProcess(metadata) {
  const command = normalizeProcessPath(metadata.command);
  const root = normalizeProcessPath(path.resolve(ROOT));
  const cwd = normalizeProcessPath(metadata.cwd);
  const runsProjectVinext =
    command.includes(`${root}/node_modules/`) &&
    command.includes("vinext") &&
    /(?:^|\s)dev(?:\s|$)/i.test(metadata.command);
  const cwdMatches = cwd === root;
  return runsProjectVinext && (process.platform === "win32" || cwdMatches);
}

function processIsRunning(pid) {
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
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processIsRunning(pid);
}

async function stopPreviousLocalDrive(job) {
  const pids = await listeningProcessIds();
  if (pids.length === 0) return { stopped: false, occupiedByAnotherApp: false };

  const ownedPids = [];
  for (const pid of pids) {
    const metadata = await processMetadata(pid);
    if (isOwnedLocalDriveProcess(metadata)) ownedPids.push(pid);
  }
  if (ownedPids.length === 0) {
    return { stopped: false, occupiedByAnotherApp: true };
  }

  addLog(job, `\n检测到以前启动的 R2 Drive（进程 ${ownedPids.join(", ")}），正在关闭。\n`);
  for (const pid of ownedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  for (const pid of ownedPids) {
    if (await waitForProcessExit(pid, 2_500)) continue;
    addLog(job, `旧进程 ${pid} 没有正常退出，正在强制关闭。\n`);
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await waitForProcessExit(pid, 1_500);
  }

  if (localDevProcess && localDevProcess.exitCode === null) {
    localDevProcess.kill("SIGTERM");
  }
  const remainingOwnedPids = [];
  for (const pid of await listeningProcessIds()) {
    if (isOwnedLocalDriveProcess(await processMetadata(pid))) remainingOwnedPids.push(pid);
  }
  if (remainingOwnedPids.length > 0) {
    throw new Error("旧的 R2 Drive 进程无法关闭。请重启电脑后再试。");
  }

  addLog(job, "✓ 旧的 R2 Drive 已关闭。\n");
  return { stopped: true, occupiedByAnotherApp: false };
}

function redact(value, secrets = []) {
  return secrets.reduce(
    (output, secret) => (secret ? output.replaceAll(secret, "••••••••") : output),
    String(value),
  );
}

function runProcess(job, program, args, options = {}) {
  const label = options.label ?? `${program} ${args.join(" ")}`;
  addLog(job, `\n$ ${label}\n`);

  return new Promise((resolve, reject) => {
    const environment = {
      ...process.env,
      ...(options.env ?? {}),
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: path.join(ROOT, ".wrangler", "setup.log"),
    };
    for (const name of options.unsetEnv ?? []) delete environment[name];
    if (options.ci) environment.CI = "1";
    const child = spawn(executable(program), args, {
      cwd: ROOT,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timeoutError = null;
    let timeoutTimer;
    let forceKillTimer;
    let forceSettleTimer;
    const append = (chunk) => {
      const safe = redact(cleanOutput(chunk), options.redactions);
      output += safe;
      if (output.length > 220_000) output = output.slice(-220_000);
      addLog(job, safe);
    };
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(forceSettleTimer);
      child.stdout.off("data", append);
      child.stderr.off("data", append);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(output);
    };
    const onError = (error) => {
      if (timeoutError) {
        timeoutError.commandOutput = output;
        finish(timeoutError);
        return;
      }
      finish(error);
    };
    const onClose = (code) => {
      if (timeoutError) {
        timeoutError.commandOutput = output;
        finish(timeoutError);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(`${label} 退出，状态码 ${code}。`);
      error.commandOutput = output;
      finish(error);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", onError);
    child.on("close", onClose);

    const timeoutMs =
      options.timeoutMs === 0
        ? 0
        : Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? options.timeoutMs
          : DEFAULT_COMMAND_TIMEOUT_MS;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timeoutError = new Error(
          `${label} 超过 ${Math.ceil(timeoutMs / 1_000)} 秒仍未完成，已停止这个阶段。请检查网络后重试。`,
        );
        timeoutError.commandOutput = output;
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between the timer and the signal.
        }
        forceKillTimer = setTimeout(() => {
          if (settled) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // The close/error listener, or the fallback below, will settle it.
          }
          forceSettleTimer = setTimeout(() => {
            timeoutError.commandOutput = output;
            finish(timeoutError);
          }, COMMAND_FORCE_SETTLE_MS);
        }, COMMAND_TERMINATION_GRACE_MS);
      }, timeoutMs);
    }
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function isInteractiveWranglerCommand(args) {
  return (
    args[0] === "login" ||
    (args[0] === "auth" && args[1] === "create")
  );
}

function runWrangler(job, args, options = {}) {
  return runProcess(
    job,
    "npx",
    ["--no-install", "wrangler", ...args],
    isInteractiveWranglerCommand(args)
      ? { ...options, timeoutMs: 0 }
      : options,
  );
}

function runNpm(job, args, options = {}) {
  return runProcess(job, "npm", args, options);
}

function externalFetch(url, options = {}) {
  return undiciFetch(url, {
    ...options,
    dispatcher: cloudflareDispatcher,
  });
}

function githubFetch(url, options = {}) {
  return externalFetch(url, options);
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    logs: job.logs.join(""),
    error: job.error,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function startJob(kind, action) {
  if (currentJobId && jobs.get(currentJobId)?.status === "running") {
    throw new Error("已有任务正在运行，请等待当前任务完成。");
  }
  const job = {
    id: randomBytes(10).toString("hex"),
    kind,
    status: "running",
    progress: null,
    logs: [],
    error: null,
    result: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  currentJobId = job.id;

  Promise.resolve()
    .then(() => action(job))
    .then((result) => {
      job.status = "success";
      job.result = result ?? null;
      addLog(job, "\n✓ 完成\n");
    })
    .catch((error) => {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      if (job.progress) {
        setJobProgress(job, job.progress.percent, "error", job.error);
      }
      addLog(job, `\n✕ ${job.error}\n`);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });

  return publicJob(job);
}

function assertName(value, label, min = 1) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  ) {
    throw new Error(`${label} 只能使用小写字母、数字和连字符，开头和结尾不能是连字符。`);
  }
  return value;
}

function assertD1Id(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error("已有 D1 的 database_id 格式不正确。");
  }
  return value;
}

function assertAccountId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/i.test(value)) {
    throw new Error("请先连接 Cloudflare 账号，再继续设置网盘。");
  }
  return value;
}

function assertOrigin(value, productionOnly = false) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("APP_ORIGIN 必须是完整地址，例如 http://localhost:3000。");
  }
  const localHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("APP_ORIGIN 只能是 HTTPS Origin，或本机的 http://localhost 地址，不能带路径。");
  }
  if (productionOnly && localHost) {
    throw new Error("生产 Origin 必须是最终 HTTPS 地址，不能使用 localhost。");
  }
  return parsed.origin;
}

function assertCustomHostname(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error("请填写你自己的域名，例如 drive.example.com。");
  }
  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("域名格式不正确，例如 drive.example.com。");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".workers.dev") ||
    hostname.endsWith(".pages.dev") ||
    hostname.includes("*") ||
    !hostname.includes(".")
  ) {
    throw new Error("请填写已接入当前 Cloudflare 账号的自有域名，例如 drive.example.com。");
  }
  return hostname;
}

function assertChoice(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} 的值无效。`);
  return value;
}

function readPositiveInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} 必须是 ${min}-${max} 的整数。`);
  }
  return parsed;
}

async function readConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

function isMissingPrimaryR2Object(error) {
  const output = String(error?.commandOutput || error?.message || "");
  return /NoSuchKey|object.+not found|does not exist|code:\s*10007/i.test(output);
}

function isMissingPrimaryCloudflareResource(error) {
  const output = String(error?.commandOutput || error?.message || "");
  return /does not exist|not found|NoSuchBucket|no deployments|code:\s*1000[67]/i.test(
    output,
  );
}

async function observePrimaryBucket(intent) {
  const response = await cloudflareApi(
    `/accounts/${encodeURIComponent(intent.accountId)}/r2/buckets/${encodeURIComponent(intent.r2Name)}`,
    undefined,
    { errorLabel: `读取 R2 存储桶 ${intent.r2Name} 创建时间` },
  );
  const observed = recordPrimaryBucketObservation(
    intent,
    response.result?.creation_date,
  );
  return writePrimaryOwnershipIntent(PRIMARY_OWNERSHIP_PATH, observed);
}

async function readPrimaryBucketMarker(job, intent) {
  const outputPath = path.join(
    ROOT,
    ".wrangler",
    `primary-marker-${process.pid}-${randomBytes(6).toString("hex")}.json`,
  );
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  try {
    await runWrangler(
      job,
      [
        "r2",
        "object",
        "get",
        `${intent.r2Name}/${intent.bucketMarkerKey}`,
        "--file",
        outputPath,
        "--remote",
      ],
      {
        label: `核对 ${intent.r2Name} 的 R2 Drive 归属标记`,
        env: { CLOUDFLARE_ACCOUNT_ID: intent.accountId },
      },
    );
    const info = await stat(outputPath);
    if (!info.isFile() || info.size > 4 * 1024) {
      throw new Error("主 R2 归属标记内容异常，已停止以保护现有数据。");
    }
    return readFile(outputPath, "utf8");
  } catch (error) {
    if (isMissingPrimaryR2Object(error)) return null;
    throw error;
  } finally {
    await rm(outputPath, { force: true });
  }
}

async function ensurePrimaryBucketOwnership(job, source, options = {}) {
  let intent = validatePrimaryOwnershipIntent(source);
  let marker = await readPrimaryBucketMarker(job, intent);
  if (marker !== null) {
    assertPrimaryBucketOwnership(intent, marker);
    intent = await observePrimaryBucket(intent);
  } else {
    if (options.allowMarkerCreation !== true) {
      throw new Error(
        "主 R2 缺少原随机归属标记；可能是中断操作或同名重建。为避免认领现有桶，未写入新标记。",
      );
    }
    intent = await observePrimaryBucket(intent);
  }
  if (marker === null) {
    const body = primaryBucketOwnershipBody(intent);
    await runWrangler(
      job,
      [
        "r2",
        "object",
        "put",
        `${intent.r2Name}/${intent.bucketMarkerKey}`,
        "--pipe",
        "--remote",
        "--force",
        "--content-type",
        "application/json",
      ],
      {
        label: `写入 ${intent.r2Name} 的 R2 Drive 归属标记`,
        env: { CLOUDFLARE_ACCOUNT_ID: intent.accountId },
        input: body,
        redactions: [intent.bucketMarkerToken],
      },
    );
    marker = await readPrimaryBucketMarker(job, intent);
  }
  if (marker === null) {
    throw new Error("主 R2 归属标记写入后仍无法读取，已停止配置。");
  }
  assertPrimaryBucketOwnership(intent, marker);
  intent = await writePrimaryOwnershipIntent(PRIMARY_OWNERSHIP_PATH, {
    ...intent,
    bucketMarkerVerifiedAt: new Date().toISOString(),
  });
  return intent;
}

function primaryTargetFromConfig(config) {
  const accountId = String(
    config.account_id ?? config.vars?.R2_ACCOUNT_ID ?? "",
  ).toLowerCase();
  const d1 = config.d1_databases?.[0] ?? {};
  const r2Name = String(
    config.r2_buckets?.[0]?.bucket_name ?? config.vars?.R2_BUCKET_NAME ?? "",
  );
  const workerName = String(config.name ?? "");
  const d1Id = String(d1.database_id ?? "").toLowerCase();
  if (
    !/^[0-9a-f]{32}$/.test(accountId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      d1Id,
    ) ||
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(r2Name) ||
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(workerName)
  ) {
    return null;
  }
  return {
    accountId,
    d1Id,
    d1Name: String(d1.database_name || ""),
    r2Name,
    workerName,
  };
}

async function readActiveWorkerVersions(job, target, options = {}) {
  let deployment;
  try {
    const output = await runWrangler(
      job,
      [
        "deployments",
        "status",
        "--name",
        target.workerName,
        "--json",
        "--config",
        CONFIG_PATH,
      ],
      {
        label: `核对 Worker ${target.workerName} 当前版本`,
        env: { CLOUDFLARE_ACCOUNT_ID: target.accountId },
      },
    );
    deployment = parseWranglerJson(output, "Wrangler Worker deployment");
  } catch (error) {
    if (options.allowMissing && isMissingPrimaryCloudflareResource(error)) {
      return null;
    }
    throw error;
  }
  const active = Array.isArray(deployment?.versions)
    ? deployment.versions.filter((entry) => Number(entry?.percentage) > 0)
    : [];
  if (!active.length) {
    throw new Error("线上 Worker 没有可核对的生效版本，已停止归属操作。");
  }
  const versions = [];
  for (const entry of active) {
    const id = String(entry.version_id ?? entry.versionId ?? "");
    if (!/^[0-9a-f-]{32,64}$/i.test(id)) {
      throw new Error("Wrangler 返回的 Worker version_id 无效。");
    }
    const output = await runWrangler(
      job,
      [
        "versions",
        "view",
        id,
        "--name",
        target.workerName,
        "--json",
        "--config",
        CONFIG_PATH,
      ],
      {
        label: `核对 Worker 版本 ${id}`,
        env: { CLOUDFLARE_ACCOUNT_ID: target.accountId },
      },
    );
    versions.push(parseWranglerJson(output, "Wrangler Worker version"));
  }
  return versions;
}

function databaseIdFromListEntry(entry) {
  return String(
    entry?.uuid ?? entry?.database_id ?? entry?.databaseId ?? entry?.id ?? "",
  ).toLowerCase();
}

async function legacyPrimaryBucketEvidence(job, target) {
  const d1Output = await runWrangler(job, ["d1", "list", "--json"], {
    label: `核对旧版 D1 ${target.d1Name} 的 exact database_id`,
    env: { CLOUDFLARE_ACCOUNT_ID: target.accountId },
  });
  const databases = parseWranglerJson(d1Output, "Wrangler D1");
  const database = Array.isArray(databases)
    ? databases.find(
        (entry) =>
          databaseIdFromListEntry(entry) === target.d1Id &&
          String(entry?.name ?? "") === target.d1Name,
      )
    : null;
  if (!database) {
    throw new Error("旧版 D1 的 exact database_id 无法复核，不能迁移资源归属。");
  }

  const sampleOutput = await runWrangler(
    job,
    [
      "d1",
      "execute",
      target.d1Name,
      "--remote",
      "--command",
      "SELECT storage_key, size, etag FROM files WHERE kind = 'file' AND status = 'ready' AND storage_key IS NOT NULL ORDER BY id LIMIT 3",
      "--json",
      "--config",
      CONFIG_PATH,
    ],
    {
      label: "抽样核对旧版 D1 与主 R2 文件",
      env: { CLOUDFLARE_ACCOUNT_ID: target.accountId },
      ci: true,
    },
  );
  const samplePayload = parseWranglerJson(sampleOutput, "Wrangler D1 sample");
  const samples = Array.isArray(samplePayload)
    ? samplePayload.flatMap((entry) =>
        Array.isArray(entry?.results) ? entry.results : [],
      )
    : [];
  const objects = [];
  for (const sample of samples) {
    const key = String(sample?.storage_key ?? "");
    if (!key) continue;
    const listed = await cloudflareApi(
      `/accounts/${encodeURIComponent(target.accountId)}/r2/buckets/${encodeURIComponent(target.r2Name)}/objects`,
      { prefix: key, per_page: 10 },
      { errorLabel: `核对旧版 R2 对象 ${key}` },
    );
    const candidates = r2ObjectsFromApiPayload(listed);
    objects.push(...candidates.filter((object) => object?.key === key));
  }
  const bucket = await cloudflareApi(
    `/accounts/${encodeURIComponent(target.accountId)}/r2/buckets/${encodeURIComponent(target.r2Name)}`,
    undefined,
    { errorLabel: `核对旧版 R2 ${target.r2Name}` },
  );
  const result = assertLegacyBucketEvidence({
    samples,
    objects,
    bucketCreationDate: bucket.result?.creation_date,
    databaseCreationDate:
      database.created_at ?? database.created_on ?? database.createdAt,
  });
  return {
    ...result,
    bucketCreationDate: bucket.result?.creation_date,
  };
}

async function migrateLegacyPrimaryOwnership(job, config) {
  const target = primaryTargetFromConfig(config);
  if (!target) {
    throw new Error("旧版实例配置不完整，不能安全迁移主资源归属。");
  }
  const versions = await readActiveWorkerVersions(job, target);
  for (const version of versions) {
    assertLegacyWorkerVersionBindings(version, target);
  }
  const evidence = await legacyPrimaryBucketEvidence(job, target);

  let intent = createPrimaryOwnershipIntent(target);
  intent = setPrimaryBucketManagement(
    {
      ...intent,
      legacyMigration: true,
    },
    false,
  );
  intent = recordPrimaryBucketObservation(
    intent,
    evidence.bucketCreationDate,
  );
  intent = bindPrimaryOwnershipIntent(intent, target);
  intent = await writePrimaryOwnershipIntent(
    PRIMARY_OWNERSHIP_PATH,
    intent,
  );
  intent = await ensurePrimaryBucketOwnership(job, intent, {
    allowMarkerCreation: true,
  });
  config.vars = {
    ...config.vars,
    [PRIMARY_WORKER_ID_VAR]: intent.installId,
  };
  await writeJsonAtomic(CONFIG_PATH, config);
  addLog(
    job,
    `\n✓ 旧版主资源已通过 exact D1/Worker binding 与 ${evidence.kind === "ready-object" ? "R2 文件抽样" : "资源创建顺序"}复核，并建立随机归属凭证。\n`,
  );
  return intent;
}

async function ensurePrimarySetupIntent(job, target) {
  const existing = await readPrimaryOwnershipIntent(PRIMARY_OWNERSHIP_PATH, {
    allowMissing: true,
  });
  if (existing) {
    return ensurePrimaryOwnershipIntent(PRIMARY_OWNERSHIP_PATH, target);
  }
  const config = await readConfig();
  const configured = primaryTargetFromConfig(config);
  if (configured) {
    if (
      configured.accountId !== String(target.accountId).toLowerCase() ||
      configured.r2Name !== target.r2Name
    ) {
      throw new Error(
        "当前目录已有未迁移的旧版实例，不能用新的账号或桶覆盖；请先检查更新以建立安全归属凭证。",
      );
    }
    return migrateLegacyPrimaryOwnership(job, config);
  }
  return ensurePrimaryOwnershipIntent(PRIMARY_OWNERSHIP_PATH, target);
}

function makeCors(origin) {
  return {
    rules: [
      {
        allowed: {
          origins: [origin],
          methods: ["PUT"],
          headers: ["Content-Type"],
        },
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3600,
      },
    ],
  };
}

async function updateProjectConfig(values) {
  const config = await readConfig();
  config.name = values.workerName;
  if (values.accountId) config.account_id = values.accountId;
  config.vars = {
    ...config.vars,
    APP_NAME: values.appName,
    APP_ORIGIN: values.appOrigin,
    REGISTRATION_MODE: values.registrationMode,
    DEFAULT_USER_QUOTA_BYTES: String(values.quotaGB * 1_000_000_000),
    UPLOAD_MODE: values.uploadMode,
    DOWNLOAD_MODE: values.downloadMode,
    PUBLIC_SHARE_CACHE_SECONDS: String(values.publicShareCacheSeconds),
    R2_BUCKET_NAME: values.r2Name,
    R2_ACCOUNT_ID: values.accountId,
    [PRIMARY_WORKER_ID_VAR]: values.installId,
  };
  config.d1_databases = [
    {
      binding: "DB",
      database_name: values.d1Name,
      database_id: values.d1Id,
      migrations_dir: "drizzle",
    },
  ];
  config.r2_buckets = [
    {
      binding: "FILES",
      bucket_name: values.r2Name,
    },
  ];
  await writeJsonAtomic(CONFIG_PATH, config);
  await writeJsonAtomic(CORS_PATH, makeCors(values.appOrigin));
}

async function setProjectCustomDomain(hostname) {
  const origin = `https://${hostname}`;
  const config = await readConfig();
  config.vars = { ...config.vars, APP_ORIGIN: origin };
  config.routes = [{ pattern: hostname, custom_domain: true }];
  config.workers_dev = false;
  config.preview_urls = false;
  await writeJsonAtomic(CONFIG_PATH, config);
  await writeJsonAtomic(CORS_PATH, makeCors(origin));
  return { config, origin };
}

function normalizeConfiguration(body) {
  const quotaGB = readPositiveInteger(body.quotaGB, "默认配额", 1, 1_000_000);
  const appName = typeof body.appName === "string" ? body.appName.trim() : "";
  if (!appName || appName.length > 60) throw new Error("网盘名称必须是 1-60 个字符。");
  const d1Mode = assertChoice(body.d1Mode, ["create", "existing"], "D1 模式");

  return {
    appName,
    workerName: assertName(body.workerName, "Worker 名称"),
    d1Name: assertName(body.d1Name, "D1 名称"),
    d1Mode,
    d1Id: d1Mode === "existing" ? assertD1Id(body.d1Id) : "",
    r2Name: assertName(body.r2Name, "R2 桶名称", 3),
    r2Mode: "existing",
    accountId: assertAccountId(typeof body.accountId === "string" ? body.accountId.trim() : ""),
    appOrigin: assertOrigin(body.appOrigin),
    registrationMode: "closed",
    quotaGB,
    uploadMode: assertChoice(body.uploadMode, ["auto", "direct", "proxy"], "上传模式"),
    downloadMode: assertChoice(body.downloadMode, ["proxy", "direct"], "下载模式"),
    publicShareCacheSeconds: readPositiveInteger(
      body.publicShareCacheSeconds,
      "公开分享边缘缓存时间",
      0,
      604_800,
    ),
    enableLocalUploads: body.enableLocalUploads === true,
    applyCors: body.applyCors === true,
  };
}

function normalizeR2Creation(body) {
  return {
    accountId: assertAccountId(typeof body.accountId === "string" ? body.accountId.trim() : ""),
    r2Name: assertName(
      typeof body.r2Name === "string" ? body.r2Name.trim() : "",
      "R2 桶名称",
      3,
    ),
  };
}

async function createR2Bucket(job, body) {
  const values = normalizeR2Creation(body);
  const accountEnvironment = { CLOUDFLARE_ACCOUNT_ID: values.accountId };
  let ownership = await ensurePrimarySetupIntent(job, values);

  try {
    await runWrangler(
      job,
      ["r2", "bucket", "info", values.r2Name, "--json"],
      {
        label: `检查 R2 存储桶 ${values.r2Name}`,
        env: accountEnvironment,
      },
    );
    const establishingExistingOwnership = ownership.managedBucket === null;
    if (ownership.managedBucket === null) {
      ownership = await writePrimaryOwnershipIntent(
        PRIMARY_OWNERSHIP_PATH,
        setPrimaryBucketManagement(ownership, false),
      );
    }
    ownership = await ensurePrimaryBucketOwnership(job, ownership, {
      allowMarkerCreation: establishingExistingOwnership,
    });
    addLog(job, `\n✓ ${values.r2Name} 已经存在，将直接使用，不会重复创建。\n`);
    return { r2Name: values.r2Name, created: false, location: "existing" };
  } catch (error) {
    if (!isMissingPrimaryCloudflareResource(error)) throw error;
    addLog(job, `\n未找到 ${values.r2Name}，开始在当前账号中创建私人 R2 存储桶。\n`);
  }

  if (ownership.managedBucket === false) {
    throw new Error(
      "原先复用的主 R2 已不存在，不能用同名新桶替换。请保留本机归属记录并人工核对。",
    );
  }
  if (ownership.managedBucket === null) {
    ownership = await writePrimaryOwnershipIntent(
      PRIMARY_OWNERSHIP_PATH,
      setPrimaryBucketManagement(ownership, true),
    );
  }
  try {
    await runWrangler(
      job,
      ["r2", "bucket", "create", values.r2Name, "--location", "apac"],
      {
        label: `创建私人 R2 存储桶 ${values.r2Name}（APAC）`,
        env: accountEnvironment,
        ci: true,
      },
    );
  } catch {
    throw new Error(
      `未能创建 ${values.r2Name}。请确认 Cloudflare 授权仍然有效、桶名称没有被占用，然后重试。`,
    );
  }

  await runWrangler(
    job,
    ["r2", "bucket", "info", values.r2Name, "--json"],
    {
      label: `确认 R2 存储桶 ${values.r2Name} 已创建`,
      env: accountEnvironment,
    },
  );
  ownership = await ensurePrimaryBucketOwnership(job, ownership, {
    allowMarkerCreation: true,
  });
  addLog(job, `\n✓ 私人 R2 存储桶 ${values.r2Name} 已创建，位置提示为 APAC。\n`);
  return { r2Name: values.r2Name, created: true, location: "apac" };
}

async function findExistingD1Database(job, name, accountEnvironment) {
  const output = await runWrangler(job, ["d1", "list", "--json"], {
    label: `检查资料数据库 ${name}`,
    env: accountEnvironment,
  });
  return findD1DatabaseByName(
    parseWranglerJson(output, "Wrangler D1"),
    name,
  );
}

async function configureCloudflare(job, body) {
  const values = normalizeConfiguration(body);
  let d1Id = values.d1Id;
  let d1Created = false;
  const accountEnvironment = { CLOUDFLARE_ACCOUNT_ID: values.accountId };
  let ownership = await ensurePrimarySetupIntent(job, values);

  try {
    await runWrangler(
      job,
      ["r2", "bucket", "info", values.r2Name, "--json"],
      {
        label: `检查 R2 存储桶 ${values.r2Name}`,
        env: accountEnvironment,
      },
    );
    const establishingExistingOwnership = ownership.managedBucket === null;
    if (ownership.managedBucket === null) {
      ownership = await writePrimaryOwnershipIntent(
        PRIMARY_OWNERSHIP_PATH,
        setPrimaryBucketManagement(ownership, false),
      );
    }
    ownership = await ensurePrimaryBucketOwnership(job, ownership, {
      allowMarkerCreation: establishingExistingOwnership,
    });
  } catch (error) {
    if (!isMissingPrimaryCloudflareResource(error)) throw error;
    throw new Error(
      `当前 Cloudflare 账号中没有找到名为 ${values.r2Name} 的 R2 存储桶。请检查名称，或点击“一键创建 R2 桶（网盘）”。`,
    );
  }

  if (values.d1Mode === "create") {
    let existing = await findExistingD1Database(
      job,
      values.d1Name,
      accountEnvironment,
    );
    if (existing) {
      d1Id = existing.id;
      addLog(
        job,
        `\n✓ 资料数据库 ${values.d1Name} 已经存在，将直接使用，不会重复创建。\n`,
      );
    } else {
      try {
        await runWrangler(
          job,
          ["d1", "create", values.d1Name, "--location", "apac"],
          {
            label: `创建资料数据库 ${values.d1Name}`,
            env: accountEnvironment,
          },
        );
        d1Created = true;
      } catch (createError) {
        addLog(job, "\n创建没有完成，正在重新检查是否已有同名资料数据库。\n");
        try {
          existing = await findExistingD1Database(
            job,
            values.d1Name,
            accountEnvironment,
          );
        } catch {
          throw createError;
        }
        if (!existing) throw createError;
        addLog(
          job,
          `\n✓ 已找到资料数据库 ${values.d1Name}，将继续使用，不需要手动复制编号。\n`,
        );
      }

      existing ??= await findExistingD1Database(
        job,
        values.d1Name,
        accountEnvironment,
      );
      if (!existing) {
        throw new Error(
          `资料数据库 ${values.d1Name} 已创建，但暂时无法读取。请稍后重新点击“检查并连接存储”。`,
        );
      }
      d1Id = existing.id;
    }
  }

  ownership = bindPrimaryOwnershipIntent(ownership, {
    ...values,
    d1Id,
  });
  ownership = await writePrimaryOwnershipIntent(
    PRIMARY_OWNERSHIP_PATH,
    ownership,
  );
  await updateProjectConfig({
    ...values,
    d1Id,
    installId: ownership.installId,
  });
  addLog(job, "\n✓ 已写入 wrangler.jsonc 与本实例 CORS 文件。\n");

  if (values.enableLocalUploads) {
    await runWrangler(
      job,
      ["r2", "bucket", "local-uploads", "enable", values.r2Name, "--force"],
      {
        label: `wrangler r2 bucket local-uploads enable ${values.r2Name}`,
        env: accountEnvironment,
      },
    );
  }

  if (values.applyCors) {
    await runWrangler(
      job,
      ["r2", "bucket", "cors", "set", values.r2Name, "--file", CORS_PATH, "--force"],
      {
        label: `wrangler r2 bucket cors set ${values.r2Name} --file config/r2-cors.local.json`,
        env: accountEnvironment,
      },
    );
  }

  await runWrangler(
    job,
    ["d1", "migrations", "apply", values.d1Name, "--remote", "--config", CONFIG_PATH],
    { label: `wrangler d1 migrations apply ${values.d1Name} --remote`, ci: true },
  );
  await runWrangler(
    job,
    ["d1", "migrations", "apply", values.d1Name, "--local", "--config", CONFIG_PATH],
    { label: `wrangler d1 migrations apply ${values.d1Name} --local`, ci: true },
  );

  return {
    d1Id,
    d1Created,
    d1Reused: values.d1Mode === "create" && !d1Created,
    r2Name: values.r2Name,
    appOrigin: values.appOrigin,
  };
}

async function enableUploadAcceleration(job) {
  const config = await readConfig();
  const accountId = assertAccountId(
    String(config.account_id ?? config.vars?.R2_ACCOUNT_ID ?? "").trim(),
  );
  const bucket = assertName(
    String(config.r2_buckets?.[0]?.bucket_name ?? config.vars?.R2_BUCKET_NAME ?? "").trim(),
    "R2 桶名称",
    3,
  );
  const customHostname =
    config.routes?.find((route) => route?.custom_domain)?.pattern ?? "";
  if (!customHostname) {
    throw new Error("请先完成域名绑定，再开启上传加速。");
  }
  await preparePrimaryOwnershipForDeploy(job, config);
  const accountEnvironment = { CLOUDFLARE_ACCOUNT_ID: accountId };

  setJobProgress(job, 8, "checking", "正在确认 Wrangler 登录和当前网盘");
  const account = await checkWranglerAccount(job);
  if (!account.accounts.some((item) => item.id === accountId)) {
    throw new Error("当前 Wrangler 登录不属于这个网盘的 Cloudflare 账号。");
  }
  await runWrangler(
    job,
    ["r2", "bucket", "info", bucket, "--json", "--config", CONFIG_PATH],
    {
      label: `确认 R2 存储桶 ${bucket}`,
      env: accountEnvironment,
    },
  );

  setJobProgress(job, 38, "local-uploads", "正在开启就近写入");
  await runWrangler(
    job,
    [
      "r2",
      "bucket",
      "local-uploads",
      "enable",
      bucket,
      "--force",
      "--config",
      CONFIG_PATH,
    ],
    {
      label: `wrangler r2 bucket local-uploads enable ${bucket}`,
      env: accountEnvironment,
    },
  );

  setJobProgress(job, 64, "cors", "正在同步浏览器上传规则");
  await runWrangler(
    job,
    [
      "r2",
      "bucket",
      "cors",
      "set",
      bucket,
      "--file",
      CORS_PATH,
      "--force",
      "--config",
      CONFIG_PATH,
    ],
    {
      label: `wrangler r2 bucket cors set ${bucket}`,
      env: accountEnvironment,
    },
  );

  setJobProgress(job, 84, "verifying", "正在复核 Cloudflare 配置");
  const [localUploadsOutput, secretsOutput] = await Promise.all([
    runWrangler(
      job,
      ["r2", "bucket", "local-uploads", "get", bucket, "--config", CONFIG_PATH],
      {
        label: `复核 ${bucket} 的 Local Uploads`,
        env: accountEnvironment,
      },
    ),
    runWrangler(
      job,
      ["secret", "list", "--format", "json", "--config", CONFIG_PATH],
      { label: "检查现有直传配置" },
    ),
  ]);
  if (!/local uploads are enabled/i.test(localUploadsOutput)) {
    throw new Error("Wrangler 没有确认 Local Uploads 已开启，请稍后重试。");
  }
  const secrets = parseWranglerJson(secretsOutput, "Wrangler Secret");
  const secretNames = new Set(
    Array.isArray(secrets)
      ? secrets.map((secret) => secret?.name).filter((name) => typeof name === "string")
      : [],
  );
  const directUploadReady =
    secretNames.has("R2_ACCESS_KEY_ID") && secretNames.has("R2_SECRET_ACCESS_KEY");

  const result = {
    enabled: true,
    directUploadReady,
    bucket,
    url: `https://${customHostname}/start`,
  };
  await saveUploadAccelerationState(result, customHostname);
  setJobProgress(job, 100, "done", "上传加速已经开启");
  addLog(
    job,
    directUploadReady
      ? "\n✓ Local Uploads 已开启；已有 R2 直传凭据，网盘会优先直传并自动回退。\n"
      : "\n✓ Local Uploads 已开启；网盘会使用流式分片和就近 R2 写入。\n",
  );
  return result;
}

async function writeLocalSecrets(accessKeyId, secretAccessKey) {
  validateSecretPair(accessKeyId, secretAccessKey);
  await writeFile(
    DEV_VARS_PATH,
    `R2_ACCESS_KEY_ID=${accessKeyId}\nR2_SECRET_ACCESS_KEY=${secretAccessKey}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function validateSecretPair(accessKeyId, secretAccessKey) {
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("必须同时填写 Access Key ID 和 Secret Access Key。");
  }
  if (/[\r\n]/.test(accessKeyId) || /[\r\n]/.test(secretAccessKey)) {
    throw new Error("凭据不能包含换行符。");
  }
  if (accessKeyId.length > 256 || secretAccessKey.length > 512) {
    throw new Error("凭据长度异常。");
  }
}

async function preparePrimaryOwnershipForDeploy(job, config) {
  const target = primaryTargetFromConfig(config);
  if (!target) {
    throw new Error("当前主资源配置不完整，不能建立安全的 Worker 归属。");
  }
  let intent = await readPrimaryOwnershipIntent(PRIMARY_OWNERSHIP_PATH, {
    allowMissing: true,
  });
  if (!intent) {
    intent = await migrateLegacyPrimaryOwnership(job, config);
  }
  intent = bindPrimaryOwnershipIntent(intent, target);
  if (intent.managedBucket === null) {
    throw new Error("主 R2 缺少创建/复用边界，不能发布 Worker。");
  }
  intent = await writePrimaryOwnershipIntent(
    PRIMARY_OWNERSHIP_PATH,
    intent,
  );
  intent = await ensurePrimaryBucketOwnership(job, intent);

  if (config.vars?.[PRIMARY_WORKER_ID_VAR] !== intent.installId) {
    config.vars = {
      ...config.vars,
      [PRIMARY_WORKER_ID_VAR]: intent.installId,
    };
    await writeJsonAtomic(CONFIG_PATH, config);
  }

  const versions = await readActiveWorkerVersions(job, target, {
    allowMissing: true,
  });
  if (versions) {
    for (const version of versions) {
      assertLegacyWorkerVersionBindings(version, target);
      if (!intent.legacyMigration || intent.workerIdentityVerifiedAt) {
        assertWorkerVersionInstallationBinding(version, intent.installId);
      }
    }
  }
  return intent;
}

async function putPrimaryWorkerIdentitySecret(job, intent) {
  await runWrangler(
    job,
    [
      "secret",
      "put",
      PRIMARY_WORKER_SECRET_NAME,
      "--config",
      CONFIG_PATH,
    ],
    {
      label: `写入主 Worker 归属 Secret ${PRIMARY_WORKER_SECRET_NAME}`,
      input: `${intent.workerIdentitySecret}\n`,
      redactions: [intent.workerIdentitySecret],
    },
  );
}

async function verifyPrimaryWorkerIdentity(job, source, origin) {
  let intent = validatePrimaryOwnershipIntent(source);
  const challenge = createPrimaryWorkerChallenge();
  const url = new URL(PRIMARY_WORKER_IDENTITY_PATH, origin);
  url.searchParams.set("challenge", challenge);
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await externalFetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json" },
      });
      const text = await response.text();
      if (text.length > 4 * 1024) {
        throw new Error("主 Worker 身份响应过大。");
      }
      const payload = JSON.parse(text);
      if (!response.ok) {
        throw new Error(`主 Worker 身份端点返回 HTTP ${response.status}。`);
      }
      assertPrimaryWorkerOwnership(intent, challenge, payload);
      intent = await writePrimaryOwnershipIntent(PRIMARY_OWNERSHIP_PATH, {
        ...intent,
        workerIdentityVerifiedAt: new Date().toISOString(),
      });
      addLog(job, "\n✓ 主 Worker 随机挑战身份已复核。\n");
      return intent;
    } catch (error) {
      lastError = error;
      if (attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
  throw new Error(
    `主 Worker 已发布但随机身份复核失败：${lastError instanceof Error ? lastError.message : String(lastError)} 请保留本机归属文件并重试，卸载不会按名称猜测。`,
  );
}

async function deployToOwnAccount(job, body) {
  if (body.confirm !== true) throw new Error("部署必须由当前用户明确确认。");
  const config = await readConfig();
  const database = config.d1_databases?.[0]?.database_name;
  const bucket = config.r2_buckets?.[0]?.bucket_name;
  if (!database || !config.d1_databases?.[0]?.database_id || !bucket) {
    throw new Error("请先完成资源配置，再部署。");
  }
  let ownership = await preparePrimaryOwnershipForDeploy(job, config);
  const customHostname = assertCustomHostname(body.customHostname);
  const { origin } = await setProjectCustomDomain(customHostname);
  addLog(job, `\n✓ 将只发布到自定义域名 ${origin}，workers.dev 已关闭。\n`);
  await runWrangler(
    job,
    ["r2", "bucket", "cors", "set", bucket, "--file", CORS_PATH, "--force"],
    { label: `更新 ${bucket} 的生产 CORS` },
  );

  await runNpm(job, ["run", "check"], { label: "npm run check" });
  await runWrangler(
    job,
    ["d1", "migrations", "apply", database, "--remote", "--config", CONFIG_PATH],
    { label: `wrangler d1 migrations apply ${database} --remote`, ci: true },
  );
  await runNpm(job, ["run", "deploy"], {
    label: `部署并绑定 ${customHostname}`,
  });
  await putPrimaryWorkerIdentitySecret(job, ownership);
  ownership = await verifyPrimaryWorkerIdentity(job, ownership, origin);

  const accessKeyId = typeof body.accessKeyId === "string" ? body.accessKeyId : "";
  const secretAccessKey =
    typeof body.secretAccessKey === "string" ? body.secretAccessKey : "";
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    throw new Error("生产 R2 凭据必须同时填写两项；当前部署已完成，但尚未设置直传凭据。");
  }
  if (accessKeyId && secretAccessKey) {
    validateSecretPair(accessKeyId, secretAccessKey);
    await runWrangler(
      job,
      ["secret", "put", "R2_ACCESS_KEY_ID", "--config", CONFIG_PATH],
      {
        label: "wrangler secret put R2_ACCESS_KEY_ID",
        input: `${accessKeyId}\n`,
        redactions: [accessKeyId],
      },
    );
    await runWrangler(
      job,
      ["secret", "put", "R2_SECRET_ACCESS_KEY", "--config", CONFIG_PATH],
      {
        label: "wrangler secret put R2_SECRET_ACCESS_KEY",
        input: `${secretAccessKey}\n`,
        redactions: [secretAccessKey],
      },
    );
  }

  return { url: origin, hostname: customHostname };
}

function extractLocalPageError(html, status) {
  const marker = "const error = ";
  const markerIndex = html.indexOf(marker);
  if (markerIndex >= 0) {
    const lineEnd = html.indexOf("\n", markerIndex);
    const raw = html.slice(markerIndex + marker.length, lineEnd >= 0 ? lineEnd : undefined).trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // Fall through to the generic HTTP message.
    }
  }
  return `账号页面返回 HTTP ${status}`;
}

async function inspectLocalDrive(timeoutMs = 2_000) {
  try {
    const response = await fetch(LOCAL_ENTRY_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = await response.text();
    if (response.ok && html.includes("R2 Drive")) {
      return { state: "ready", status: response.status, message: "账号页面已经可以访问" };
    }
    return {
      state: "error",
      status: response.status,
      message: extractLocalPageError(html, response.status),
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { state: "starting", status: null, message: "服务已响应，仍在编译页面" };
    }
    return { state: "offline", status: null, message: "本地端口尚未开始监听" };
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readUploadAccelerationState(config) {
  try {
    const state = JSON.parse(await readFile(ACCELERATION_STATE_PATH, "utf8"));
    const bucket = config.r2_buckets?.[0]?.bucket_name ?? "";
    const customHostname =
      config.routes?.find((route) => route?.custom_domain)?.pattern ?? "";
    if (
      state?.enabled === true &&
      state.bucket === bucket &&
      state.customHostname === customHostname
    ) {
      return {
        enabled: true,
        directUploadReady: state.directUploadReady === true,
        bucket,
        url: `https://${customHostname}/start`,
        configuredAt: state.configuredAt ?? "",
      };
    }
  } catch {
    // Missing or stale local state simply means the wizard may offer the action again.
  }
  return null;
}

async function saveUploadAccelerationState(result, customHostname) {
  await mkdir(path.dirname(ACCELERATION_STATE_PATH), { recursive: true });
  const temporary = `${ACCELERATION_STATE_PATH}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        enabled: true,
        directUploadReady: result.directUploadReady === true,
        bucket: result.bucket,
        customHostname,
        configuredAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporary, ACCELERATION_STATE_PATH);
}

async function getStatus() {
  const config = await readConfig();
  const localHealth = await inspectLocalDrive(800);
  if (localHealth.state === "ready") {
    localDevUrl = LOCAL_ENTRY_URL;
  } else if (!localDevProcess || localDevProcess.exitCode !== null) {
    localDevUrl = null;
  }
  const installedVersion = JSON.parse(await readFile(PACKAGE_PATH, "utf8")).version;
  return {
    node: process.version,
    version: installedVersion,
    runtimeVersion,
    config: {
      appName: config.vars?.APP_NAME ?? "R2 Drive",
      workerName: config.name ?? "r2-drive",
      appOrigin: config.vars?.APP_ORIGIN ?? "http://localhost:3000",
      registrationMode: config.vars?.REGISTRATION_MODE ?? "closed",
      quotaGB: Math.round(
        Number(config.vars?.DEFAULT_USER_QUOTA_BYTES ?? 10_000_000_000) / 1_000_000_000,
      ),
      uploadMode: config.vars?.UPLOAD_MODE ?? "auto",
      downloadMode: config.vars?.DOWNLOAD_MODE ?? "proxy",
      publicShareCacheSeconds: Number(config.vars?.PUBLIC_SHARE_CACHE_SECONDS ?? 0),
      accountId: config.vars?.R2_ACCOUNT_ID ?? "",
      d1Name: config.d1_databases?.[0]?.database_name ?? "r2-drive-db",
      d1Id: config.d1_databases?.[0]?.database_id ?? "",
      r2Name: config.r2_buckets?.[0]?.bucket_name ?? "r2-drive-files",
      customHostname:
        config.routes?.find((route) => route?.custom_domain)?.pattern ?? "",
    },
    hasLocalSecrets: await fileExists(DEV_VARS_PATH),
    uploadAcceleration: await readUploadAccelerationState(config),
    localDrive: {
      running:
        localHealth.state === "ready" ||
        Boolean(localDevProcess && localDevProcess.exitCode === null),
      url: localDevUrl,
      state: localHealth.state,
      message:
        localHealth.state === "error"
          ? "以前启动的本地网盘没有正常运行"
          : localHealth.message,
      status: localHealth.status,
    },
    currentJob: currentJobId ? publicJob(jobs.get(currentJobId)) : null,
  };
}

async function checkForUpdates(job) {
  setJobProgress(job, 15, "checking", "正在连接 GitHub Releases");
  const packageMetadata = JSON.parse(
    await readFile(PACKAGE_PATH, "utf8"),
  );
  const release = await fetchLatestRelease(githubFetch);
  const available = compareVersions(release.version, packageMetadata.version) > 0;
  setJobProgress(
    job,
    100,
    available ? "available" : "current",
    available ? `发现新版本 v${release.version}` : "当前已经是最新版",
  );
  return {
    currentVersion: packageMetadata.version,
    latestVersion: release.version,
    available,
    releaseName: release.name,
    releaseUrl: release.url,
    publishedAt: release.publishedAt,
  };
}

async function installLatestUpdate(job, body) {
  if (body.confirm !== true) {
    throw new Error("安装更新需要当前用户明确确认。");
  }

  setJobProgress(job, 5, "checking", "正在确认当前版本和 Cloudflare 登录");
  const packageMetadata = JSON.parse(
    await readFile(PACKAGE_PATH, "utf8"),
  );
  const release = await fetchLatestRelease(githubFetch);
  if (
    typeof body.version === "string" &&
    body.version &&
    body.version !== release.version
  ) {
    throw new Error("最新版本已经变化，请重新检查后再安装。");
  }
  if (compareVersions(release.version, packageMetadata.version) <= 0) {
    setJobProgress(job, 100, "current", "当前已经是最新版");
    return {
      alreadyCurrent: true,
      version: packageMetadata.version,
      releaseUrl: release.url,
    };
  }

  const currentConfig = await readConfig();
  const database = currentConfig.d1_databases?.[0]?.database_name;
  const databaseId = currentConfig.d1_databases?.[0]?.database_id;
  const customHostname =
    currentConfig.routes?.find((route) => route?.custom_domain)?.pattern ?? "";
  if (!database || !databaseId) {
    throw new Error("当前网盘缺少 D1 配置，请先完成网盘配置再更新。");
  }
  await checkWranglerAccount(job);
  const occupied = await stopPreviousLocalDrive(job);
  if (occupied.occupiedByAnotherApp) {
    throw new Error(`本地端口 ${LOCAL_PORT} 被其他软件占用，请先关闭该软件。`);
  }

  const update = await createUpdateWorkspace();
  let transaction = null;
  let rollbackCompleted = false;
  try {
    setJobProgress(job, 15, "downloading", `正在下载 v${release.version}`);
    await downloadReleaseArchive(
      release,
      update.archivePath,
      githubFetch,
      ({ percent }) => {
        const scaled = percent > 0 ? 15 + percent * 0.12 : 18;
        setJobProgress(job, scaled, "downloading", `正在下载 v${release.version}`);
      },
    );

    setJobProgress(job, 30, "verifying", "正在校验官方更新包");
    await extractReleaseArchive(
      update.archivePath,
      update.releaseRoot,
      release.version,
    );

    setJobProgress(job, 38, "backup", "正在备份当前程序和实例配置");
    transaction = await applyReleaseTree({
      root: ROOT,
      releaseRoot: update.releaseRoot,
      backupRoot: update.backupRoot,
    });

    setJobProgress(job, 50, "dependencies", "正在安装新版组件");
    await runNpm(job, ["install", "--no-audit", "--no-fund"], {
      label: "安装新版组件",
    });

    setJobProgress(job, 64, "testing", "正在检查新版页面和代码");
    await runNpm(job, ["run", "check"], { label: "检查新版" });

    setJobProgress(job, 72, "ownership", "正在复核主 Worker 与 R2 归属");
    let primaryOwnership = await preparePrimaryOwnershipForDeploy(
      job,
      await readConfig(),
    );

    setJobProgress(job, 76, "migrating", "正在升级本机资料数据库");
    await runWrangler(
      job,
      ["d1", "migrations", "apply", database, "--local", "--config", CONFIG_PATH],
      { label: `升级本机资料数据库 ${database}`, ci: true },
    );

    setJobProgress(job, 84, "migrating", "正在安全升级线上资料数据库");
    await runWrangler(
      job,
      ["d1", "migrations", "apply", database, "--remote", "--config", CONFIG_PATH],
      { label: `升级资料数据库 ${database}`, ci: true },
    );

    if (customHostname) {
      setJobProgress(job, 90, "deploying", `正在更新 ${customHostname}`);
      await runNpm(job, ["run", "deploy"], {
        label: `发布 v${release.version} 到 ${customHostname}`,
      });
      await putPrimaryWorkerIdentitySecret(job, primaryOwnership);
      primaryOwnership = await verifyPrimaryWorkerIdentity(
        job,
        primaryOwnership,
        `https://${customHostname}`,
      );
    }

    setJobProgress(job, 100, "ready", `v${release.version} 已安装完成`);
    await removeUpdateWorkspace(update.workspace);
    return {
      version: release.version,
      releaseUrl: release.url,
      deployed: Boolean(customHostname),
      url: customHostname ? `https://${customHostname}/admin` : "",
      restartHelper: true,
    };
  } catch (error) {
    if (transaction) {
      addLog(job, "\n更新没有完成，正在恢复更新前的程序和配置。\n");
      try {
        await rollbackReleaseTree(transaction);
        await runNpm(job, ["install", "--no-audit", "--no-fund"], {
          label: "恢复旧版组件",
        });
        await runNpm(job, ["run", "types"], {
          label: "恢复旧版类型配置",
        });
        rollbackCompleted = true;
        addLog(job, "✓ 已恢复更新前的本地版本。\n");
      } catch (rollbackError) {
        addLog(
          job,
          `✕ 自动恢复没有完成：${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }\n`,
        );
      }
    }
    if (rollbackCompleted) {
      await removeUpdateWorkspace(update.workspace);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      rollbackCompleted
        ? `${reason} 已恢复更新前的本地程序；Cloudflare 中的 R2 文件不会受影响。`
        : `${reason} 备份保留在 ${update.backupRoot}，请勿删除并查看处理日志。`,
    );
  }
}

async function checkWranglerAccount(job) {
  const output = await runWrangler(job, ["whoami", "--json"], {
    label: "wrangler whoami --json",
  });
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Wrangler 已响应，但返回内容不是有效 JSON。");
  const parsed = JSON.parse(output.slice(start, end + 1));
  const sourceAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  const accounts = await Promise.all(
    sourceAccounts.map(async (account) => {
      const id = account.id ?? account.account_id ?? "";
      let workersPlan = classifyWorkersPlan(account.type, "");
      if (id) {
        try {
          const settings = await cloudflareApi(
            `/accounts/${encodeURIComponent(id)}/workers/account-settings`,
          );
          workersPlan = classifyWorkersPlan(
            account.type,
            settings.result?.default_usage_model,
          );
        } catch {
          // Wrangler's normal OAuth grant may not expose billing/account settings.
          // Keep setup usable and report an honest "unknown" result in the UI.
        }
      }
      return {
        id,
        name: account.name ?? account.account_name ?? "",
        workersPlan,
      };
    }),
  );
  return {
    email: parsed.email ?? parsed.user?.email ?? "",
    accounts,
    r2FreeTier: R2_STANDARD_FREE_TIER,
  };
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
  throw new Error("没有找到 Wrangler 登录授权。请返回第一步，重新连接 Cloudflare 账号。");
}

async function cloudflareApi(pathname, query, options = {}) {
  const url = new URL(`${CLOUDFLARE_API_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = new Headers(options.headers ?? (await cloudflareAuthHeaders()));
  if (options.body !== undefined) headers.set("content-type", "application/json");
  let response;
  try {
    response = await undiciFetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      dispatcher: cloudflareDispatcher,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      `${options.errorLabel || "连接 Cloudflare"}失败。请检查网络或代理设置后重试。`,
    );
  }
  const payload = await response.json().catch(() => null);
  if (options.allowFailure && (!response.ok || !payload?.success)) {
    return {
      ...(payload && typeof payload === "object" ? payload : {}),
      success: false,
      httpStatus: response.status,
    };
  }
  if (!response.ok || !payload?.success) {
    const apiMessage = Array.isArray(payload?.errors)
      ? payload.errors
          .map((error) => error?.message)
          .filter(Boolean)
          .join("；")
      : "";
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Cloudflare 授权没有${options.errorLabel || "执行此操作"}的权限，请重新连接账号。`,
      );
    }
    throw new Error(
      apiMessage
        ? `${options.errorLabel || "Cloudflare 操作"}失败：${apiMessage.slice(0, 240)}`
        : `${options.errorLabel || "Cloudflare 操作"}失败（HTTP ${response.status}）。`,
    );
  }
  return { ...payload, httpStatus: response.status };
}

const storagePoolService = createStoragePoolService({
  root: ROOT,
  configPath: CONFIG_PATH,
  runWrangler,
  cloudflareApi,
  externalFetch,
  addLog,
  setJobProgress,
});

async function prepareStoragePool(job, body) {
  await preparePrimaryOwnershipForDeploy(job, await readConfig());
  return storagePoolService.prepare(job, body);
}

async function connectStoragePool(job, body) {
  await preparePrimaryOwnershipForDeploy(job, await readConfig());
  return storagePoolService.connect(job, body);
}

async function listCloudflareZones(job, body) {
  const accountId = assertAccountId(
    typeof body.accountId === "string" ? body.accountId.trim() : "",
  );
  setJobProgress(job, 10, "checking", "正在确认 Cloudflare 登录");
  const account = await checkWranglerAccount(job);
  if (!account.accounts.some((item) => item.id === accountId)) {
    throw new Error("当前登录中没有找到所选 Cloudflare 账号，请返回第一步重新选择。");
  }

  setJobProgress(job, 55, "checking", "正在自动查找有效域名");
  const zones = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await cloudflareApi("/zones", {
      "account.id": accountId,
      status: "active",
      page,
      per_page: 50,
      order: "name",
      direction: "asc",
    });
    if (Array.isArray(payload.result)) {
      for (const zone of payload.result) {
        if (
          typeof zone?.id === "string" &&
          typeof zone?.name === "string" &&
          zone.status === "active" &&
          zone.account?.id === accountId
        ) {
          zones.push({
            id: zone.id,
            name: zone.name.toLowerCase(),
            status: zone.status,
          });
        }
      }
    }
    totalPages = Math.min(
      20,
      Math.max(1, Number(payload.result_info?.total_pages) || 1),
    );
    page += 1;
  } while (page <= totalPages);

  const uniqueZones = [...new Map(zones.map((zone) => [zone.id, zone])).values()].sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  setJobProgress(
    job,
    100,
    "ready",
    uniqueZones.length > 0 ? `找到 ${uniqueZones.length} 个有效域名` : "没有有效域名",
  );
  addLog(job, `\n✓ 自动识别到 ${uniqueZones.length} 个 Active 域名。\n`);
  return { zones: uniqueZones };
}

function isLocalRequest(request) {
  const remote = request.socket.remoteAddress;
  const localAddress =
    remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const host = String(request.headers.host || "").toLowerCase();
  const localHost =
    host === `${HOST}:${PORT}` ||
    host === `localhost:${PORT}` ||
    host === `[::1]:${PORT}`;
  return localAddress && localHost;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64_000) throw new Error("请求内容过大。");
  }
  if (!body) return {};
  return JSON.parse(body);
}

function requireToken(request) {
  if (request.headers["x-r2-drive-setup-token"] !== csrfToken) {
    throw new Error("本地向导安全令牌无效，请刷新页面。");
  }
}

async function route(request, response) {
  if (!isLocalRequest(request)) {
    sendJson(response, 403, { error: "安装向导只接受本机请求。" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (request.method === "GET" && url.pathname === "/") {
    const template = await readFile(UI_PATH, "utf8");
    const html = template.replaceAll("__SETUP_TOKEN__", csrfToken);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(html);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, await getStatus());
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const job = jobs.get(url.pathname.split("/").at(-1));
    sendJson(response, job ? 200 : 404, job ? publicJob(job) : { error: "任务不存在。" });
    if (
      job?.kind === "update-install" &&
      job.status === "success" &&
      job.result?.restartHelper
    ) {
      scheduleSetupRestart();
    }
    return;
  }

  requireToken(request);

  if (request.method === "POST" && url.pathname === "/api/account/check") {
    sendJson(response, 202, startJob("account-check", checkWranglerAccount));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/login") {
    sendJson(
      response,
      202,
      startJob("account-login", (job) =>
        runWrangler(job, ["login"], { label: "wrangler login" }),
      ),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/configure") {
    const body = await readJson(request);
    sendJson(
      response,
      202,
      startJob("configure", (job) => configureCloudflare(job, body)),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/r2/create") {
    const body = await readJson(request);
    sendJson(
      response,
      202,
      startJob("r2-create", (job) => createR2Bucket(job, body)),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/upload-acceleration/enable") {
    sendJson(
      response,
      202,
      startJob("upload-acceleration", enableUploadAcceleration),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/storage-pool/prepare") {
    const body = await readJson(request);
    sendJson(
      response,
      202,
      startJob("storage-pool-prepare", (job) =>
        prepareStoragePool(job, body),
      ),
    );
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/storage-pool/profile/create"
  ) {
    const body = await readJson(request);
    sendJson(
      response,
      202,
      startJob("storage-pool-profile", (job) =>
        storagePoolService.createProfile(job, body),
      ),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/storage-pool/connect") {
    const body = await readJson(request);
    sendJson(
      response,
      202,
      startJob("storage-pool-connect", (job) =>
        connectStoragePool(job, body),
      ),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/local-secrets") {
    const body = await readJson(request);
    await writeLocalSecrets(body.accessKeyId, body.secretAccessKey);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/local/start") {
    sendJson(response, 400, {
      error: "R2 Drive 必须先绑定 Active 域名；不再提供无域名本机版。",
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/zones/list") {
    const body = await readJson(request);
    sendJson(
      response,
      202,
      startJob("zone-list", (job) => listCloudflareZones(job, body)),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/deploy") {
    const body = await readJson(request);
    sendJson(
      response,
      202,
      startJob("deploy", (job) => deployToOwnAccount(job, body)),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/update/check") {
    sendJson(response, 202, startJob("update-check", checkForUpdates));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/update/install") {
    const body = await readJson(request);
    sendJson(
      response,
      202,
      startJob("update-install", (job) => installLatestUpdate(job, body)),
    );
    return;
  }

  sendJson(response, 404, { error: "未找到。" });
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 400, { error: message });
  });
});

function stopLocalDrive() {
  if (localDevProcess && localDevProcess.exitCode === null) {
    localDevProcess.kill("SIGTERM");
  }
}

function scheduleSetupRestart() {
  if (setupRestartScheduled) return;
  setupRestartScheduled = true;
  const timer = setTimeout(() => {
    stopLocalDrive();
    const restarter = spawn(
      process.execPath,
      [
        path.join(ROOT, "scripts", "restart-stale-setup.mjs"),
        "--restart-after-exit",
        String(process.pid),
      ],
      {
        cwd: ROOT,
        env: process.env,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      },
    );
    restarter.unref();
    server.close(() => process.exit(0));
    const forceExit = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, 4_000);
    forceExit.unref();
  }, 750);
  timer.unref();
}

process.once("exit", stopLocalDrive);
process.once("SIGINT", () => {
  stopLocalDrive();
  server.close(() => process.exit(0));
});
process.once("SIGTERM", () => {
  stopLocalDrive();
  server.close(() => process.exit(0));
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\nR2 Drive 本地安装向导：${url}`);
  console.log("仅监听 127.0.0.1；按 Ctrl+C 退出。\n");
  if (!process.argv.includes("--no-open")) {
    const command =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    const opener = spawn(command[0], command[1], {
      detached: true,
      stdio: "ignore",
    });
    opener.unref();
  }
});

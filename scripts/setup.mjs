#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import {
  classifyWorkersPlan,
  R2_STANDARD_FREE_TIER,
} from "./cloudflare-plan.mjs";
import { findD1DatabaseByName, parseWranglerJson } from "./wrangler-output.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");
const DEV_VARS_PATH = path.join(ROOT, ".dev.vars");
const CORS_PATH = path.join(ROOT, "config", "r2-cors.local.json");
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
const LOCAL_START_TIMEOUT_MS = 120_000;
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const csrfToken = randomBytes(32).toString("hex");
const cloudflareDispatcher = new EnvHttpProxyAgent();
const jobs = new Map();
let currentJobId = null;
let localDevProcess = null;
let localDevUrl = null;

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
    if (options.ci) environment.CI = "1";
    const child = spawn(executable(program), args, {
      cwd: ROOT,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => {
      const safe = redact(cleanOutput(chunk), options.redactions);
      output += safe;
      if (output.length > 220_000) output = output.slice(-220_000);
      addLog(job, safe);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${label} 退出，状态码 ${code}。`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function runWrangler(job, args, options = {}) {
  return runProcess(job, "npx", ["--no-install", "wrangler", ...args], options);
}

function runNpm(job, args, options = {}) {
  return runProcess(job, "npm", args, options);
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

  try {
    await runWrangler(
      job,
      ["r2", "bucket", "info", values.r2Name, "--json"],
      {
        label: `检查 R2 存储桶 ${values.r2Name}`,
        env: accountEnvironment,
      },
    );
    addLog(job, `\n✓ ${values.r2Name} 已经存在，将直接使用，不会重复创建。\n`);
    return { r2Name: values.r2Name, created: false, location: "existing" };
  } catch {
    addLog(job, `\n未找到 ${values.r2Name}，开始在当前账号中创建私人 R2 存储桶。\n`);
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

  try {
    await runWrangler(
      job,
      ["r2", "bucket", "info", values.r2Name, "--json"],
      {
        label: `检查 R2 存储桶 ${values.r2Name}`,
        env: accountEnvironment,
      },
    );
  } catch {
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

  await updateProjectConfig({ ...values, d1Id });
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

async function deployToOwnAccount(job, body) {
  if (body.confirm !== true) throw new Error("部署必须由当前用户明确确认。");
  const config = await readConfig();
  const database = config.d1_databases?.[0]?.database_name;
  const bucket = config.r2_buckets?.[0]?.bucket_name;
  if (!database || !config.d1_databases?.[0]?.database_id || !bucket) {
    throw new Error("请先完成资源配置，再部署。");
  }
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

async function startLocalDrive(job) {
  setJobProgress(job, 5, "checking", "正在检查本地端口");
  let initialHealth = await inspectLocalDrive();
  if (initialHealth.state === "ready") {
    localDevUrl = LOCAL_ENTRY_URL;
    setJobProgress(job, 100, "ready", "网盘已经可以打开");
    addLog(job, "\n✓ 本地网盘已经在运行。\n");
    return { url: localDevUrl, alreadyRunning: true };
  }

  if (initialHealth.state === "error" || initialHealth.state === "starting") {
    if (initialHealth.state === "error") {
      addLog(
        job,
        `\n旧网盘账号页面诊断：HTTP ${initialHealth.status}，${initialHealth.message}\n`,
      );
    } else {
      addLog(job, `\n${LOCAL_PORT} 端口已有程序，但账号页面在检查时间内没有响应。\n`);
    }
    setJobProgress(job, 10, "stopping", "检测到旧网盘，正在自动关闭");
    const cleanup = await stopPreviousLocalDrive(job);
    if (cleanup.occupiedByAnotherApp) {
      throw new Error(
        `本地地址被其他软件占用。为了保护你的其他程序，安装助手没有强制关闭它。请关闭占用 ${LOCAL_PORT} 端口的软件后重试。`,
      );
    }
    if (!cleanup.stopped) {
      throw new Error(
        "检测到旧网盘异常，但无法确认对应进程。请关闭以前打开的 R2 Drive 终端窗口后重试。",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    initialHealth = await inspectLocalDrive(800);
    if (initialHealth.state !== "offline") {
      throw new Error("旧网盘已经关闭，但本地地址还没有释放。请稍等几秒后重试。");
    }
  }

  if (localDevProcess && localDevProcess.exitCode === null) {
    const previousProcess = localDevProcess;
    previousProcess.kill("SIGTERM");
    if (!(await waitForProcessExit(previousProcess.pid, 1_500))) {
      previousProcess.kill("SIGKILL");
      await waitForProcessExit(previousProcess.pid, 1_000);
    }
    if (localDevProcess === previousProcess) localDevProcess = null;
  }

  setJobProgress(job, 16, "starting", "正在启动本地服务");
  addLog(job, "\n正在启动本地网盘，第一次编译可能需要几十秒。\n");
  const child = spawn(
    executable("npm"),
    ["run", "dev", "--", "--port", String(LOCAL_PORT), "--hostname", "localhost"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: path.join(ROOT, ".wrangler", "setup-local.log"),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  localDevProcess = child;
  let childFailure = null;
  let serverAnnounced = false;
  let consecutivePageErrors = 0;
  const appendLocalOutput = (chunk) => {
    const output = cleanOutput(chunk);
    addLog(job, output);
    if (output.includes("[optimizer]") || output.includes("transforming")) {
      setJobProgress(job, 48, "compiling", "正在编译网盘页面");
    }
    if (output.includes("Local:")) {
      serverAnnounced = true;
      setJobProgress(job, 58, "verifying", "本地服务已启动，正在检查账号页面");
    }
  };
  child.stdout.on("data", appendLocalOutput);
  child.stderr.on("data", appendLocalOutput);
  child.on("error", (error) => {
    childFailure = error;
    addLog(job, `\n本地网盘进程错误：${error.message}\n`);
  });
  child.on("close", (code) => {
    addLog(job, `\n本地网盘已停止（状态码 ${code ?? "unknown"}）。\n`);
    if (localDevProcess === child) {
      localDevProcess = null;
      localDevUrl = null;
    }
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCAL_START_TIMEOUT_MS) {
    if (childFailure) {
      throw new Error(`无法启动本地网盘进程：${childFailure.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`本地网盘启动失败，进程状态码为 ${child.exitCode}。请查看处理日志。`);
    }

    const health = await inspectLocalDrive();
    if (health.state === "ready") {
      localDevUrl = LOCAL_ENTRY_URL;
      setJobProgress(job, 100, "ready", "账号页面已经准备好，正在打开");
      addLog(job, `\n✓ 本地网盘已就绪：${localDevUrl}\n`);
      return { url: localDevUrl, alreadyRunning: false };
    }
    if (health.state === "error") {
      consecutivePageErrors += 1;
      if (consecutivePageErrors >= 2) {
        addLog(job, `\n账号页面诊断：HTTP ${health.status}，${health.message}\n`);
        child.kill("SIGTERM");
        throw new Error(
          "本地服务已经启动，但账号页面没有正常显示。请点击“查看错误详情”，然后重新启动。",
        );
      }
    } else {
      consecutivePageErrors = 0;
    }

    const elapsedRatio = Math.min(1, (Date.now() - startedAt) / LOCAL_START_TIMEOUT_MS);
    const percent = 24 + elapsedRatio * 66;
    setJobProgress(
      job,
      percent,
      health.state === "starting" || serverAnnounced ? "compiling" : "starting",
      health.state === "starting" || serverAnnounced
        ? "正在编译并检查账号页面"
        : "正在等待本地服务响应",
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  child.kill("SIGTERM");
  throw new Error(
    `本地网盘启动超过 ${Math.round(LOCAL_START_TIMEOUT_MS / 1000)} 秒。请查看处理日志，关闭占用 ${LOCAL_PORT} 端口的旧程序后重试。`,
  );
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getStatus() {
  const config = await readConfig();
  const localHealth = await inspectLocalDrive(800);
  if (localHealth.state === "ready") {
    localDevUrl = LOCAL_ENTRY_URL;
  } else if (!localDevProcess || localDevProcess.exitCode !== null) {
    localDevUrl = null;
  }
  return {
    node: process.version,
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

async function cloudflareApi(pathname, query) {
  const url = new URL(`${CLOUDFLARE_API_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = await cloudflareAuthHeaders();
  let response;
  try {
    response = await undiciFetch(url, {
      headers,
      dispatcher: cloudflareDispatcher,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("连接 Cloudflare 获取域名失败。请检查网络或代理设置后重试。");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const apiMessage = Array.isArray(payload?.errors)
      ? payload.errors
          .map((error) => error?.message)
          .filter(Boolean)
          .join("；")
      : "";
    if (response.status === 401 || response.status === 403) {
      throw new Error("Cloudflare 授权没有读取域名的权限。请返回第一步重新连接账号。");
    }
    throw new Error(
      apiMessage
        ? `Cloudflare 暂时无法读取域名：${apiMessage.slice(0, 240)}`
        : `Cloudflare 暂时无法读取域名（HTTP ${response.status}）。`,
    );
  }
  return payload;
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
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
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
  if (request.method === "POST" && url.pathname === "/api/local-secrets") {
    const body = await readJson(request);
    await writeLocalSecrets(body.accessKeyId, body.secretAccessKey);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/local/start") {
    sendJson(
      response,
      202,
      startJob("local-start", startLocalDrive),
    );
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

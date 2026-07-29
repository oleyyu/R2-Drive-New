import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const POOL_VERSION = 1;
const FEDERATION_SECRET_NAME = "STORAGE_FEDERATION_PRIVATE_KEY";
const PROFILE_PATTERN = /^(?:default|r2drive-node-[a-f0-9]{8,20})$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GIB = 1024 ** 3;
const MAX_SOFT_LIMIT_BYTES = Number.MAX_SAFE_INTEGER;
const PROFILE_CREDENTIAL_TIMEOUT_MS = 180_000;
const PROFILE_CREDENTIAL_TERMINATION_GRACE_MS = 2_000;
const PROFILE_CREDENTIAL_FORCE_SETTLE_MS = 1_000;
const BUCKET_OWNERSHIP_PROTOCOL = "r2drive-storage-bucket-v1";
const BUCKET_OWNERSHIP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function cleanAnsi(value) {
  return String(value).replace(
    new RegExp(
      String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
      "g",
    ),
    "",
  );
}

function parseJsonOutput(output, label) {
  const cleaned = cleanAnsi(output);
  for (const match of cleaned.matchAll(/^[ \t]*([{\[])/gm)) {
    const first = match[1];
    const start = match.index + match[0].length - 1;
    const end = first === "{" ? cleaned.lastIndexOf("}") : cleaned.lastIndexOf("]");
    if (end >= start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // A warning can contain brackets. Continue to the next candidate.
      }
    }
  }
  throw new Error(`${label} 返回的内容不是有效 JSON。`);
}

function validateProfile(value) {
  const profile = String(value || "");
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error("Wrangler 登录配置名称无效，请重新连接账号。");
  }
  return profile;
}

function validateAccountId(value) {
  const accountId = String(value || "").trim();
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("请选择要连接的 Cloudflare 账号。");
  }
  return accountId;
}

function validateResourceName(value, label) {
  const name = String(value || "").trim().toLowerCase();
  if (
    name.length < 3 ||
    name.length > 63 ||
    !RESOURCE_NAME_PATTERN.test(name)
  ) {
    throw new Error(`${label} 只能使用 3-63 个小写字母、数字和连字符。`);
  }
  return name;
}

function validateLabel(value) {
  const label = String(value || "").trim();
  if (!label || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error("节点名称必须是 1-60 个可见字符。");
  }
  return label;
}

function validateSoftLimit(value) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < GIB ||
    parsed > MAX_SOFT_LIMIT_BYTES
  ) {
    throw new Error("软容量必须至少为 1 GiB。");
  }
  return parsed;
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
    throw new Error("受管 R2 存储桶的本机归属标记无效，已停止以避免认领错误资源。");
  }
  return { markerKey, markerToken };
}

export function createStorageBucketOwnershipIntent(nodeId, previous = undefined) {
  const previousKey = previous?.bucketOwnershipMarkerKey;
  const previousToken = previous?.bucketOwnershipMarkerToken;
  if (previousKey !== undefined || previousToken !== undefined) {
    return validateBucketOwnershipFields(nodeId, previousKey, previousToken);
  }
  return {
    markerKey: `.r2-drive-storage-node/${nodeId}/${randomBytes(16).toString("hex")}.json`,
    markerToken: randomBytes(32).toString("base64url"),
  };
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
    accountId: validateAccountId(node.accountId).toLowerCase(),
    bucketName: validateResourceName(node.bucketName, "R2 存储桶名称"),
    workerName: validateResourceName(node.workerName, "Worker 名称"),
    token: markerToken,
  })}\n`;
}

function validateEnrollment(value, configuredOrigin) {
  if (!value || typeof value !== "object") {
    throw new Error("缺少网盘发出的存储节点连接凭证，请从网盘设置重新打开。");
  }
  let origin;
  try {
    const parsed = new URL(String(value.origin || ""));
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid");
    }
    origin = parsed.origin;
  } catch {
    throw new Error("存储节点连接来源无效，请从网盘设置重新打开。");
  }
  if (origin !== configuredOrigin) {
    throw new Error("连接凭证不属于当前 R2 Drive 域名，请从当前网盘设置重新打开。");
  }
  const token = typeof value.token === "string" ? value.token : "";
  if (
    token.length < 20 ||
    token.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(token)
  ) {
    throw new Error("存储节点连接凭证无效或已损坏，请重新生成。");
  }
  return { origin, token };
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

function publicJwkFromPrivate(privateJwk) {
  if (
    privateJwk?.kty !== "EC" ||
    privateJwk?.crv !== "P-256" ||
    typeof privateJwk.x !== "string" ||
    typeof privateJwk.y !== "string" ||
    typeof privateJwk.d !== "string"
  ) {
    throw new Error("本机联合存储私钥文件无效，已停止以避免覆盖现有节点密钥。");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x,
    y: privateJwk.y,
    ext: true,
    key_ops: ["verify"],
  };
}

function generateFederationKey() {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const exported = privateKey.export({ format: "jwk" });
  return {
    ...exported,
    ext: true,
    key_ops: ["sign"],
  };
}

function authEnvironment(profile) {
  const environment = {
    ...process.env,
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  if (profile !== "default") {
    for (const name of [
      "CLOUDFLARE_API_TOKEN",
      "CF_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CF_API_KEY",
      "CLOUDFLARE_EMAIL",
      "CF_API_EMAIL",
    ]) {
      delete environment[name];
    }
  }
  return environment;
}

function captureProfileCredentials(root, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable("npx"),
      [
        "--no-install",
        "wrangler",
        "auth",
        "token",
        "--json",
        "--profile",
        validateProfile(profile),
      ],
      {
        cwd: root,
        env: authEnvironment(profile),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer;
    let forceKillTimer;
    let forceSettleTimer;
    const collectStdout = (chunk) => {
      stdout += cleanAnsi(chunk);
      if (stdout.length > 32_000) stdout = stdout.slice(-32_000);
    };
    const discardStderr = () => {
      // Authentication command output can contain sensitive diagnostics.
      // Never forward it to the setup job log.
    };
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(forceSettleTimer);
      child.stdout.off("data", collectStdout);
      child.stderr.off("data", discardStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const timeoutError = () =>
      new Error(
        `读取 Wrangler 登录超过 ${Math.ceil(PROFILE_CREDENTIAL_TIMEOUT_MS / 1_000)} 秒，已停止这个阶段。请检查网络后重试。`,
      );
    const onError = () => {
      finish(
        timedOut
          ? timeoutError()
          : new Error("无法读取所选 Wrangler 登录，请重新连接 Cloudflare。"),
      );
    };
    const onClose = (code) => {
      if (timedOut) {
        finish(timeoutError());
        return;
      }
      if (code !== 0) {
        finish(new Error("所选 Wrangler 登录已经失效，请重新完成官方授权。"));
        return;
      }
      try {
        const parsed = parseJsonOutput(stdout, "Wrangler 授权");
        if (
          (parsed.type === "oauth" || parsed.type === "api_token") &&
          typeof parsed.token === "string" &&
          parsed.token
        ) {
          finish(undefined, { Authorization: `Bearer ${parsed.token}` });
          return;
        }
        if (
          parsed.type === "api_key" &&
          typeof parsed.key === "string" &&
          typeof parsed.email === "string"
        ) {
          finish(undefined, {
            "X-Auth-Key": parsed.key,
            "X-Auth-Email": parsed.email,
          });
          return;
        }
      } catch {
        // Fall through to a deliberately generic error that cannot expose a token.
      }
      finish(new Error("Wrangler 没有返回可用授权，请重新连接 Cloudflare。"));
    };
    child.stdout.on("data", collectStdout);
    child.stderr.on("data", discardStderr);
    child.on("error", onError);
    child.on("close", onClose);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may have exited between the timer and the signal.
      }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The close/error listener, or the fallback below, will settle it.
        }
        forceSettleTimer = setTimeout(() => {
          finish(timeoutError());
        }, PROFILE_CREDENTIAL_FORCE_SETTLE_MS);
      }, PROFILE_CREDENTIAL_TERMINATION_GRACE_MS);
    }, PROFILE_CREDENTIAL_TIMEOUT_MS);
  });
}

function normalizeWorkerEndpoint(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname.endsWith(".workers.dev") ||
      parsed.username ||
      parsed.password
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function deploymentTargetFromNdjson(source) {
  const lines = String(source).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "deploy" || !Array.isArray(record.targets)) continue;
    for (const target of record.targets) {
      const endpoint = normalizeWorkerEndpoint(target);
      if (endpoint) return endpoint;
    }
  }
  throw new Error("Wrangler 已部署节点，但没有在结构化输出中返回 workers.dev 地址。");
}

function isMissingR2BucketError(error) {
  const output =
    typeof error?.commandOutput === "string" ? error.commandOutput : "";
  return /does not exist|not found|NoSuchBucket|code:\s*10006/i.test(output);
}

function isR2ActivationOrBillingError(error) {
  const output =
    typeof error?.commandOutput === "string"
      ? error.commandOutput
      : error instanceof Error
        ? error.message
        : "";
  return /code:\s*10042|please enable R2|R2.+not enabled|payment method|billing|付款|账单/i.test(
    output,
  );
}

function r2ActivationOrBillingError() {
  return new Error(
    "这个 Cloudflare 账号尚未启用 R2，或尚未完成付款方式设置。请先为该账号启用 R2/完成付款设置后重试；Wrangler 无法代办账单。",
  );
}

function isMissingR2ObjectError(error) {
  const output =
    typeof error?.commandOutput === "string" ? error.commandOutput : "";
  return /NoSuchKey|object.+not found|code:\s*10007/i.test(output);
}

function encodeR2ObjectKey(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}

function defaultInventory() {
  return {
    version: POOL_VERSION,
    nodes: [],
    updatedAt: new Date().toISOString(),
  };
}

export function createStoragePoolService({
  root,
  configPath,
  runWrangler,
  cloudflareApi,
  externalFetch,
  addLog,
  setJobProgress,
}) {
  const poolDirectory = path.join(root, ".wrangler", "storage-pool");
  const privateJwkPath = path.join(poolDirectory, "private-jwk.json");
  const inventoryPath = path.join(poolDirectory, "nodes.json");
  const storageWorkerPath = path.join(root, "worker", "storage-node.ts");

  async function readConfig() {
    return JSON.parse(await readFile(configPath, "utf8"));
  }

  async function configuredOriginAndAccount() {
    const config = await readConfig();
    let origin;
    try {
      origin = new URL(String(config.vars?.APP_ORIGIN || "")).origin;
    } catch {
      throw new Error("当前网盘 APP_ORIGIN 无效，无法安全接收节点登记。");
    }
    if (
      !origin.startsWith("https://") ||
      String(config.vars?.APP_ORIGIN || "") !== origin
    ) {
      throw new Error("请先完成 HTTPS 域名发布，再连接其他 Cloudflare 账号。");
    }
    const accountId = validateAccountId(
      config.account_id || config.vars?.R2_ACCOUNT_ID,
    );
    return { config, origin, accountId };
  }

  async function readInventory() {
    try {
      const parsed = JSON.parse(await readFile(inventoryPath, "utf8"));
      if (parsed?.version !== POOL_VERSION || !Array.isArray(parsed.nodes)) {
        throw new Error("invalid");
      }
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return defaultInventory();
      throw new Error("本机存储节点清单无效，已停止以避免覆盖卸载信息。");
    }
  }

  async function saveInventory(inventory) {
    inventory.version = POOL_VERSION;
    inventory.updatedAt = new Date().toISOString();
    await writePrivateJson(inventoryPath, inventory);
  }

  async function listAccounts(profile) {
    const headers = await captureProfileCredentials(root, profile);
    const accounts = [];
    let page = 1;
    let totalPages = 1;
    do {
      const payload = await cloudflareApi(
        "/accounts",
        {
          page,
          per_page: 50,
          order: "name",
          direction: "asc",
        },
        {
          headers,
          errorLabel: "读取 Cloudflare 账号",
        },
      );
      if (Array.isArray(payload.result)) {
        for (const account of payload.result) {
          if (
            ACCOUNT_ID_PATTERN.test(String(account?.id || "")) &&
            !accounts.some((item) => item.id === account.id)
          ) {
            accounts.push({
              id: account.id,
              name: String(account.name || "Cloudflare 账号"),
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
    if (!accounts.length) {
      throw new Error("这个 Wrangler 登录中没有可用的 Cloudflare 账号。");
    }
    return accounts;
  }

  async function existingSecretNames(job, mainAccountId) {
    const output = await runWrangler(
      job,
      [
        "secret",
        "list",
        "--format",
        "json",
        "--config",
        configPath,
        "--profile",
        "default",
      ],
      {
        label: "检查主网盘联合存储密钥",
        env: { CLOUDFLARE_ACCOUNT_ID: mainAccountId },
      },
    );
    const parsed = parseJsonOutput(output, "Wrangler Secret");
    return new Set(
      Array.isArray(parsed)
        ? parsed
            .map((secret) => secret?.name)
            .filter((name) => typeof name === "string")
        : [],
    );
  }

  async function ensureFederationKey(job, mainAccountId) {
    const secretNames = await existingSecretNames(job, mainAccountId);
    const hasLocalKey = await exists(privateJwkPath);
    let privateJwk;
    if (hasLocalKey) {
      privateJwk = JSON.parse(await readFile(privateJwkPath, "utf8"));
      await chmod(privateJwkPath, 0o600);
    } else {
      if (secretNames.has(FEDERATION_SECRET_NAME)) {
        throw new Error(
          "主网盘已有联合存储 Secret，但本机私钥文件缺失。为避免现有节点失效，未自动覆盖。",
        );
      }
      privateJwk = generateFederationKey();
      await writePrivateJson(privateJwkPath, privateJwk);
      addLog(job, "✓ 已在本机生成联合存储签名密钥；文件权限为 600。\n");
    }
    const publicJwk = publicJwkFromPrivate(privateJwk);
    if (!secretNames.has(FEDERATION_SECRET_NAME)) {
      const serialized = JSON.stringify(privateJwk);
      await runWrangler(
        job,
        [
          "secret",
          "put",
          FEDERATION_SECRET_NAME,
          "--config",
          configPath,
          "--profile",
          "default",
        ],
        {
          label: `wrangler secret put ${FEDERATION_SECRET_NAME}`,
          env: { CLOUDFLARE_ACCOUNT_ID: mainAccountId },
          input: `${serialized}\n`,
          redactions: [serialized, privateJwk.d],
        },
      );
      addLog(job, "✓ 联合存储私钥已写入主网盘 Worker Secret。\n");
    }
    return publicJwk;
  }

  async function prepare(job, body) {
    setJobProgress(job, 10, "checking", "正在验证当前网盘");
    const { origin, accountId } = await configuredOriginAndAccount();
    validateEnrollment(body?.enrollment, origin);

    setJobProgress(job, 35, "key", "正在准备主网盘签名密钥");
    await ensureFederationKey(job, accountId);

    setJobProgress(job, 70, "accounts", "正在读取当前 Wrangler 账号");
    const accounts = await listAccounts("default");
    if (!accounts.some((account) => account.id === accountId)) {
      throw new Error(
        "默认 Wrangler 登录不包含主网盘账号，无法先安全配置主网盘 Secret。",
      );
    }
    const short = randomBytes(5).toString("hex");
    const inventory = await readInventory();
    setJobProgress(job, 100, "done", "可以连接存储节点");
    return {
      profile: "default",
      accounts,
      defaultBucket: `r2-drive-node-${short}`,
      defaultLabel: `R2 节点 ${inventory.nodes.length + 1}`,
      nodeCount: inventory.nodes.length,
    };
  }

  async function createProfile(job, body) {
    setJobProgress(job, 5, "checking", "正在验证当前网盘");
    const { origin, accountId } = await configuredOriginAndAccount();
    validateEnrollment(body?.enrollment, origin);

    // This intentionally runs before auth create. It ensures the primary
    // Worker secret is always written with the original/default login.
    setJobProgress(job, 15, "key", "正在确认主网盘签名密钥");
    await ensureFederationKey(job, accountId);

    const profile = `r2drive-node-${randomBytes(6).toString("hex")}`;
    setJobProgress(job, 30, "login", "请在 Cloudflare 官方页面完成授权");
    await runWrangler(job, ["auth", "create", profile], {
      label: `wrangler auth create ${profile}`,
      unsetEnv: [
        "CLOUDFLARE_API_TOKEN",
        "CF_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CF_API_KEY",
        "CLOUDFLARE_EMAIL",
        "CF_API_EMAIL",
      ],
    });

    setJobProgress(job, 80, "accounts", "正在读取新登录中的账号");
    const accounts = await listAccounts(profile);
    setJobProgress(job, 100, "done", "新 Cloudflare 登录已经连接");
    return { profile, accounts };
  }

  async function ensureWorkersSubdomain(profile, accountId) {
    const headers = await captureProfileCredentials(root, profile);
    const pathname = `/accounts/${accountId}/workers/subdomain`;
    const current = await cloudflareApi(pathname, undefined, {
      headers,
      allowFailure: true,
      errorLabel: "检查 workers.dev 子域",
    });
    if (
      current.success === true &&
      typeof current.result?.subdomain === "string" &&
      current.result.subdomain
    ) {
      return current.result.subdomain;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const subdomain = `r2drive-${randomBytes(8).toString("hex")}`;
      const created = await cloudflareApi(pathname, undefined, {
        headers,
        method: "PUT",
        body: { subdomain },
        allowFailure: true,
        errorLabel: "创建 workers.dev 子域",
      });
      if (
        created.success === true &&
        typeof created.result?.subdomain === "string" &&
        created.result.subdomain
      ) {
        return created.result.subdomain;
      }
      if (created.httpStatus === 401 || created.httpStatus === 403) break;
    }
    throw new Error(
      "这个账号还没有 workers.dev 子域，Wrangler 自动创建也未完成。请重新授权后再试。",
    );
  }

  async function writeNodeConfig({
    nodeId,
    workerName,
    accountId,
    bucketName,
    origin,
    publicJwk,
    compatibilityDate,
  }) {
    const configPathForNode = path.join(
      poolDirectory,
      `${nodeId}.wrangler.jsonc`,
    );
    const relativeMain = path
      .relative(path.dirname(configPathForNode), storageWorkerPath)
      .replaceAll(path.sep, "/");
    await writePrivateJson(configPathForNode, {
      name: workerName,
      main: relativeMain,
      account_id: accountId,
      compatibility_date: compatibilityDate,
      compatibility_flags: ["nodejs_compat"],
      workers_dev: true,
      preview_urls: false,
      vars: {
        NODE_ID: nodeId,
        CONTROL_PUBLIC_KEY_JWK: JSON.stringify(publicJwk),
        CONTROL_ORIGIN: origin,
      },
      r2_buckets: [
        {
          binding: "FILES",
          bucket_name: bucketName,
        },
      ],
      observability: {
        enabled: true,
      },
    });
    return configPathForNode;
  }

  async function deployNode(job, values, nodeConfigPath) {
    const outputPath = path.join(
      poolDirectory,
      `${values.nodeId}.deploy-output.ndjson`,
    );
    await rm(outputPath, { force: true });
    try {
      await runWrangler(
        job,
        [
          "deploy",
          "--config",
          nodeConfigPath,
          "--profile",
          values.profile,
        ],
        {
          label: `部署存储节点 ${values.workerName}`,
          env: {
            CLOUDFLARE_ACCOUNT_ID: values.accountId,
            WRANGLER_OUTPUT_FILE_PATH: outputPath,
          },
          unsetEnv:
            values.profile === "default"
              ? []
              : [
                  "CLOUDFLARE_API_TOKEN",
                  "CF_API_TOKEN",
                  "CLOUDFLARE_API_KEY",
                  "CF_API_KEY",
                  "CLOUDFLARE_EMAIL",
                  "CF_API_EMAIL",
                ],
        },
      );
      const endpoint = deploymentTargetFromNdjson(
        await readFile(outputPath, "utf8"),
      );
      return endpoint;
    } finally {
      await rm(outputPath, { force: true });
    }
  }

  async function readBucketOwnershipMarker(
    job,
    node,
    nodeConfigPath,
    commandOptions,
  ) {
    const outputPath = path.join(
      poolDirectory,
      `${node.id}.bucket-ownership-read`,
    );
    await rm(outputPath, { force: true });
    try {
      await runWrangler(
        job,
        [
          "r2",
          "object",
          "get",
          `${node.bucketName}/${encodeR2ObjectKey(node.bucketOwnershipMarkerKey)}`,
          "--file",
          outputPath,
          "--remote",
          "--config",
          nodeConfigPath,
          "--profile",
          node.profile,
        ],
        {
          ...commandOptions,
          label: `核对 ${node.bucketName} 的 R2 Drive 归属标记`,
        },
      );
      const markerStat = await stat(outputPath);
      if (!markerStat.isFile() || markerStat.size > 4 * 1024) {
        throw new Error("受管 R2 存储桶的归属标记内容异常，已停止以保护现有数据。");
      }
      return await readFile(outputPath, "utf8");
    } catch (error) {
      if (isMissingR2ObjectError(error)) return null;
      throw error;
    } finally {
      await rm(outputPath, { force: true });
    }
  }

  async function ensureBucketOwnershipMarker(
    job,
    node,
    nodeConfigPath,
    commandOptions,
    allowCreate,
  ) {
    const expected = storageBucketOwnershipBody(node);
    const existing = await readBucketOwnershipMarker(
      job,
      node,
      nodeConfigPath,
      commandOptions,
    );
    if (existing !== null && existing !== expected) {
      throw new Error(
        `R2 存储桶 ${node.bucketName} 的归属标记不匹配。它可能已被同名重建，未继续连接或覆盖。`,
      );
    }
    if (existing === null) {
      if (!allowCreate) {
        throw new Error(
          `R2 存储桶 ${node.bucketName} 缺少原有归属标记。它可能已被同名重建，未继续连接或覆盖。`,
        );
      }
      await runWrangler(
        job,
        [
          "r2",
          "object",
          "put",
          `${node.bucketName}/${encodeR2ObjectKey(node.bucketOwnershipMarkerKey)}`,
          "--pipe",
          "--remote",
          "--force",
          "--config",
          nodeConfigPath,
          "--profile",
          node.profile,
        ],
        {
          ...commandOptions,
          label: `写入 ${node.bucketName} 的 R2 Drive 归属标记`,
          input: expected,
          redactions: [node.bucketOwnershipMarkerToken],
        },
      );
    }
    const verified = await readBucketOwnershipMarker(
      job,
      node,
      nodeConfigPath,
      commandOptions,
    );
    if (verified !== expected) {
      throw new Error(
        `R2 存储桶 ${node.bucketName} 的归属标记写入后未通过复核，已停止连接。`,
      );
    }
  }

  async function enrollNode(enrollment, payload) {
    let response;
    try {
      response = await externalFetch(
        new URL("/api/storage-nodes/enroll", enrollment.origin),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${enrollment.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new Error("存储节点已部署，但主网盘暂时无法完成登记，请检查网络后重试。");
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const rawMessage =
        typeof result?.error?.message === "string"
          ? result.error.message
          : typeof result?.error === "string"
            ? result.error
            : "";
      const message = rawMessage
        .replaceAll(enrollment.token, "••••••••")
        .slice(0, 240);
      throw new Error(
        message
          ? `存储节点已部署，但主网盘登记失败：${message}`
          : `存储节点已部署，但主网盘登记失败（HTTP ${response.status}）。`,
      );
    }
    return result;
  }

  async function connect(job, body) {
    const { config, origin, accountId: mainAccountId } =
      await configuredOriginAndAccount();
    const enrollment = validateEnrollment(body?.enrollment, origin);
    const profile = validateProfile(body?.profile);
    const accountId = validateAccountId(body?.accountId);
    const bucketName = validateResourceName(body?.bucketName, "R2 存储桶名称");
    const label = validateLabel(body?.label);
    const softLimitBytes = validateSoftLimit(body?.softLimitBytes);
    const primaryBucketName = String(
      config.r2_buckets?.find((binding) => binding?.binding === "FILES")
        ?.bucket_name ||
        config.vars?.R2_BUCKET_NAME ||
        "",
    )
      .trim()
      .toLowerCase();
    if (
      accountId.toLowerCase() === mainAccountId.toLowerCase() &&
      bucketName === primaryBucketName
    ) {
      throw new Error(
        "不能把主账号正在使用的同一个 R2 存储桶再次连接为附加节点。",
      );
    }

    setJobProgress(job, 5, "checking", "正在确认账号和主网盘密钥");
    const publicJwk = await ensureFederationKey(job, mainAccountId);
    const accounts = await listAccounts(profile);
    if (!accounts.some((account) => account.id === accountId)) {
      throw new Error("所选 Wrangler 登录中没有这个 Cloudflare 账号。");
    }
    if (!(await exists(storageWorkerPath))) {
      throw new Error("当前版本缺少 Storage Node Worker，请先更新 R2 Drive。");
    }

    const inventory = await readInventory();
    const activeDuplicate = inventory.nodes.find(
      (node) =>
        node.accountId === accountId &&
        node.bucketName === bucketName &&
        node.status === "active",
    );
    if (activeDuplicate) {
      throw new Error(
        `R2 存储桶 ${bucketName} 已作为 ${activeDuplicate.label || "存储节点"} 连接，请勿重复添加。`,
      );
    }
    const previous = inventory.nodes.find(
      (node) =>
        node.accountId === accountId &&
        node.bucketName === bucketName &&
        node.status !== "active",
    );
    const short = randomBytes(5).toString("hex");
    const nodeId =
      typeof previous?.id === "string" && UUID_PATTERN.test(previous.id)
        ? previous.id
        : randomUUID();
    const workerName =
      previous?.workerName || validateResourceName(`r2-drive-storage-${short}`, "Worker 名称");
    const bucketOwnership = createStorageBucketOwnershipIntent(nodeId, previous);
    const nodeConfigPath = await writeNodeConfig({
      nodeId,
      workerName,
      accountId,
      bucketName,
      origin,
      publicJwk,
      compatibilityDate: config.compatibility_date,
    });
    const now = new Date().toISOString();
    const localRecord = {
      id: nodeId,
      label,
      kind: "worker_proxy",
      accountId,
      bucketName,
      workerName,
      endpoint: previous?.endpoint || "",
      softLimitBytes,
      managedBucket: previous?.managedBucket === true,
      // The random Worker name is reserved for this setup attempt. Recording
      // ownership before deploy lets uninstall recover even if deploy returns
      // after the helper crashes.
      managedWorker: true,
      localUploadsConfigured: previous?.localUploadsConfigured === true,
      profile,
      bucketOwnershipMarkerKey: bucketOwnership.markerKey,
      bucketOwnershipMarkerToken: bucketOwnership.markerToken,
      status: "provisioning",
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    const previousIndex = previous
      ? inventory.nodes.indexOf(previous)
      : inventory.nodes.findIndex((node) => node.id === nodeId);
    if (previousIndex >= 0) inventory.nodes[previousIndex] = localRecord;
    else inventory.nodes.push(localRecord);
    // Provisioning intent must exist before the first Cloudflare mutation.
    await saveInventory(inventory);

    const commandOptions = {
      env: { CLOUDFLARE_ACCOUNT_ID: accountId },
      unsetEnv:
        profile === "default"
          ? []
          : [
              "CLOUDFLARE_API_TOKEN",
              "CF_API_TOKEN",
              "CLOUDFLARE_API_KEY",
              "CF_API_KEY",
              "CLOUDFLARE_EMAIL",
              "CF_API_EMAIL",
            ],
    };

    setJobProgress(job, 18, "bucket", "正在检查或创建 R2 存储桶");
    let bucketCreatedThisAttempt = false;
    try {
      await runWrangler(
        job,
        [
          "r2",
          "bucket",
          "info",
          bucketName,
          "--json",
          "--config",
          nodeConfigPath,
          "--profile",
          profile,
        ],
        {
          ...commandOptions,
          label: `检查节点 R2 存储桶 ${bucketName}`,
        },
      );
    } catch (error) {
      if (isR2ActivationOrBillingError(error)) {
        throw r2ActivationOrBillingError();
      }
      if (!isMissingR2BucketError(error)) throw error;
      localRecord.managedBucket = true;
      localRecord.updatedAt = new Date().toISOString();
      await saveInventory(inventory);
      try {
        await runWrangler(
          job,
          [
            "r2",
            "bucket",
            "create",
            bucketName,
            "--location",
            "apac",
            "--config",
            nodeConfigPath,
            "--profile",
            profile,
          ],
          {
            ...commandOptions,
            label: `创建节点 R2 存储桶 ${bucketName}（APAC）`,
            ci: true,
          },
        );
      } catch (createError) {
        if (isR2ActivationOrBillingError(createError)) {
          throw r2ActivationOrBillingError();
        }
        throw createError;
      }
      bucketCreatedThisAttempt = true;
      await runWrangler(
        job,
        [
          "r2",
          "bucket",
          "info",
          bucketName,
          "--json",
          "--config",
          nodeConfigPath,
          "--profile",
          profile,
        ],
        {
          ...commandOptions,
          label: `确认节点 R2 存储桶 ${bucketName}`,
        },
      );
    }

    if (localRecord.managedBucket) {
      await ensureBucketOwnershipMarker(
        job,
        localRecord,
        nodeConfigPath,
        commandOptions,
        bucketCreatedThisAttempt || previous?.status === "provisioning",
      );
      addLog(job, `✓ 已核对受管桶 ${bucketName} 的随机归属标记。\n`);
    }

    setJobProgress(job, 35, "local-uploads", "正在开启 R2 就近写入");
    localRecord.localUploadsConfigured = true;
    localRecord.updatedAt = new Date().toISOString();
    await saveInventory(inventory);
    await runWrangler(
      job,
      [
        "r2",
        "bucket",
        "local-uploads",
        "enable",
        bucketName,
        "--force",
        "--config",
        nodeConfigPath,
        "--profile",
        profile,
      ],
      {
        ...commandOptions,
        label: `开启 ${bucketName} 的 Local Uploads`,
      },
    );

    setJobProgress(job, 50, "subdomain", "正在确认 workers.dev 安全入口");
    await ensureWorkersSubdomain(profile, accountId);

    setJobProgress(job, 65, "deploying", "正在部署 Storage Node Worker");
    const endpoint = await deployNode(
      job,
      { nodeId, workerName, accountId, profile },
      nodeConfigPath,
    );

    localRecord.endpoint = endpoint;
    localRecord.status = "pending";
    localRecord.updatedAt = new Date().toISOString();
    await saveInventory(inventory);

    setJobProgress(job, 85, "enrolling", "正在由主网盘验证并登记节点");
    await enrollNode(enrollment, {
      id: nodeId,
      label,
      kind: "worker_proxy",
      accountId,
      bucketName,
      workerName,
      endpoint,
      softLimitBytes,
      managedBucket: localRecord.managedBucket,
      managedWorker: true,
    });

    localRecord.status = "active";
    localRecord.updatedAt = new Date().toISOString();
    inventory.nodes[inventory.nodes.findIndex((node) => node.id === nodeId)] =
      localRecord;
    await saveInventory(inventory);
    await rm(nodeConfigPath, { force: true });

    addLog(job, `✓ 存储节点 ${label} 已通过主网盘健康检查并加入容量池。\n`);
    setJobProgress(job, 100, "done", "存储节点已经连接");
    return {
      node: {
        id: nodeId,
        label,
        accountId,
        bucketName,
        workerName,
        endpoint,
        softLimitBytes,
        managedBucket: localRecord.managedBucket,
        managedWorker: true,
        status: "active",
      },
      nodeCount: inventory.nodes.length,
    };
  }

  return {
    prepare,
    createProfile,
    connect,
    readInventory,
  };
}

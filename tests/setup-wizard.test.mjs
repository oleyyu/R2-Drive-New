import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findD1DatabaseByName,
  parseWranglerJson,
} from "../scripts/wrangler-output.mjs";
import {
  classifyWorkersPlan,
  R2_STANDARD_FREE_TIER,
} from "../scripts/cloudflare-plan.mjs";
import {
  describeInstance,
  driveEntryUrl,
  encodeR2ObjectKey,
  formatMenu,
} from "../scripts/launcher.mjs";
import {
  applyReleaseTree,
  compareVersions,
  mergeInstanceConfig,
  rollbackReleaseTree,
} from "../scripts/updater.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ships a safe beginner launcher on macOS and Windows", async () => {
  const commandPath = path.join(root, "R2-Drive.command");
  const batchPath = path.join(root, "R2-Drive.bat");
  const launcherPath = path.join(root, "scripts", "launcher.mjs");
  const defaultConfigPath = path.join(root, "config", "wrangler.default.jsonc");
  const [command, batch, launcher, defaultConfig, commandStat] = await Promise.all([
    readFile(commandPath, "utf8"),
    readFile(batchPath, "utf8"),
    readFile(launcherPath, "utf8"),
    readFile(defaultConfigPath, "utf8"),
    stat(commandPath),
  ]);

  assert.ok(commandStat.mode & 0o100, "macOS launcher must be executable");
  assert.match(command, /node scripts\/launcher\.mjs/);
  assert.match(command, /一键卸载当前实例/);
  assert.match(batch, /node scripts\\launcher\.mjs/);
  assert.match(batch, /一键卸载当前实例/);
  assert.match(launcher, /1\. 打开网盘【\$\{status\}】/);
  assert.match(launcher, /2\. 配置／重新配置/);
  assert.match(launcher, /3\. 一键卸载/);
  assert.match(launcher, /4\. 检查更新／一键升级/);
  assert.match(launcher, /SETUP_URL}\?step=update/);
  assert.match(launcher, /setup\.mjs"\), "--no-open"/);
  assert.match(launcher, /status\.runtimeVersion === packageMetadata\.version/);
  assert.match(launcher, /请输入 DELETE 后回车/);
  assert.match(launcher, /preflightUninstall/);
  assert.match(launcher, /正在删除云端 Worker/);
  assert.match(launcher, /全部文件、CORS、生命周期和桶级配置/);
  assert.match(launcher, /r2", "bucket", "delete"/);
  assert.match(launcher, /code:\\s\*10008/);
  assert.match(launcher, /purgeAllR2Data/);
  assert.match(launcher, /uninstall-worker\.mjs/);
  // The purge helper runs entirely on the edge. `wrangler dev --remote`
  // cannot start through a proxy-only network.
  assert.match(launcher, /triggers: \{ crons: \["\* \* \* \* \*"\] \}/);
  assert.match(launcher, /\["deploy", "--config", configPath\]/);
  assert.doesNotMatch(launcher, /"dev",\s+"--remote"/);
  assert.match(launcher, /d1",\s+"delete"/);
  assert.match(launcher, /\["delete", instance\.workerName, "--force"/);
  assert.doesNotMatch(launcher, /wrangler logout/);
  const uninstallSource = launcher.match(
    /async function uninstallInstance[\s\S]+?\n}\n\nexport function formatMenu/,
  )?.[0];
  assert.ok(uninstallSource);
  const uninstallOrder = [
    "await preflightUninstall",
    "await deleteWorker",
    "await deleteR2",
    "await deleteD1",
    "await clearLocalInstance",
  ].map((marker) => uninstallSource.indexOf(marker));
  assert.ok(uninstallOrder.every((index) => index >= 0));
  assert.deepEqual(
    uninstallOrder,
    [...uninstallOrder].sort((left, right) => left - right),
    "uninstall must preflight, stop remote writes, delete storage, then clear local targets",
  );
  assert.equal(describeInstance(JSON.parse(defaultConfig)).configured, false);

  const configured = describeInstance({
    name: "r2-drive",
    account_id: "a".repeat(32),
    d1_databases: [
      {
        database_name: "r2-drive-db",
        database_id: "123e4567-e89b-42d3-a456-426614174000",
      },
    ],
    r2_buckets: [{ bucket_name: "r2-drive-files" }],
  });
  assert.equal(configured.configured, true);
  assert.equal(driveEntryUrl(configured), "");
  const domainInstance = describeInstance({
    name: "r2-drive",
    account_id: "a".repeat(32),
    routes: [{ pattern: "drive.example.com", custom_domain: true }],
    d1_databases: [
      {
        database_name: "r2-drive-db",
        database_id: "123e4567-e89b-42d3-a456-426614174000",
      },
    ],
    r2_buckets: [{ bucket_name: "r2-drive-files" }],
  });
  assert.equal(driveEntryUrl(domainInstance), "https://drive.example.com/start");
  assert.match(launcher, /if \(!instance\.customHostname\)/);
  assert.match(launcher, /不能发布或使用 R2 Drive/);
  assert.match(launcher, /主人账号和密码只保存在这一份线上网盘中/);
  assert.equal(
    encodeR2ObjectKey("资料/2026 年/a+b?#.txt"),
    "%E8%B5%84%E6%96%99/2026%20%E5%B9%B4/a%2Bb%3F%23.txt",
  );
  const menuOutput = formatMenu(configured);
  assert.match(menuOutput, /1\. 打开网盘【缺少域名】/);
  assert.match(menuOutput, /2\. 配置／重新配置/);
  assert.match(menuOutput, /3\. 一键卸载/);
  assert.match(menuOutput, /4\. 检查更新／一键升级/);
});

test("updater preserves instance data and can roll local source back", async () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.2.0-beta.1", "0.2.0"), -1);

  const merged = mergeInstanceConfig(
    {
      main: "dist/server/index.js",
      compatibility_date: "2026-07-29",
      vars: { NEW_SAFE_DEFAULT: "yes", APP_NAME: "默认网盘" },
    },
    {
      account_id: "a".repeat(32),
      compatibility_date: "2025-01-01",
      vars: { APP_NAME: "我的私人网盘" },
      routes: [{ pattern: "drive.example.com", custom_domain: true }],
    },
  );
  assert.equal(merged.compatibility_date, "2026-07-29");
  assert.equal(merged.account_id, "a".repeat(32));
  assert.equal(merged.vars.APP_NAME, "我的私人网盘");
  assert.equal(merged.vars.NEW_SAFE_DEFAULT, "yes");
  assert.equal(merged.routes[0].pattern, "drive.example.com");

  const temporary = await mkdtemp(path.join(tmpdir(), "r2-drive-updater-test-"));
  const instanceRoot = path.join(temporary, "instance");
  const releaseRoot = path.join(temporary, "release");
  const backupRoot = path.join(temporary, "backup");
  const oldConfig = {
    name: "r2-drive-personal",
    account_id: "b".repeat(32),
    compatibility_date: "2025-01-01",
    vars: { APP_NAME: "我的私人网盘", QUOTA_BYTES: "123456" },
    d1_databases: [
      {
        binding: "DB",
        database_name: "my-drive-db",
        database_id: "123e4567-e89b-42d3-a456-426614174000",
      },
    ],
    r2_buckets: [{ binding: "FILES", bucket_name: "my-drive-files" }],
    routes: [{ pattern: "drive.example.com", custom_domain: true }],
  };

  try {
    await Promise.all([
      mkdir(path.join(instanceRoot, "config"), { recursive: true }),
      mkdir(path.join(releaseRoot, "config"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(instanceRoot, ".r2-drive-release.json"),
        JSON.stringify({
          version: "0.1.0",
          managedTopLevel: [
            ".r2-drive-release.json",
            "config",
            "obsolete.txt",
            "package.json",
          ],
        }),
      ),
      writeFile(
        path.join(instanceRoot, "package.json"),
        JSON.stringify({ name: "r2-drive", version: "0.1.0" }),
      ),
      writeFile(path.join(instanceRoot, "obsolete.txt"), "old source"),
      writeFile(path.join(instanceRoot, "wrangler.jsonc"), JSON.stringify(oldConfig)),
      writeFile(
        path.join(instanceRoot, "config", "r2-cors.local.json"),
        '{"rules":["personal"]}',
      ),
      writeFile(
        path.join(releaseRoot, ".r2-drive-release.json"),
        JSON.stringify({
          version: "0.2.0",
          managedTopLevel: [".r2-drive-release.json", "config", "package.json"],
        }),
      ),
      writeFile(
        path.join(releaseRoot, "package.json"),
        JSON.stringify({ name: "r2-drive", version: "0.2.0" }),
      ),
      writeFile(
        path.join(releaseRoot, "wrangler.jsonc"),
        JSON.stringify({
          name: "r2-drive",
          main: "dist/server/index.js",
          compatibility_date: "2026-07-29",
          vars: { NEW_SAFE_DEFAULT: "yes", APP_NAME: "默认网盘" },
        }),
      ),
      writeFile(
        path.join(releaseRoot, "config", "r2-cors.local.json"),
        '{"rules":["release-default"]}',
      ),
      writeFile(path.join(releaseRoot, "config", "new-default.txt"), "new source"),
    ]);

    const transaction = await applyReleaseTree({
      root: instanceRoot,
      releaseRoot,
      backupRoot,
    });
    const updatedPackage = JSON.parse(
      await readFile(path.join(instanceRoot, "package.json"), "utf8"),
    );
    const updatedConfig = JSON.parse(
      await readFile(path.join(instanceRoot, "wrangler.jsonc"), "utf8"),
    );
    assert.equal(updatedPackage.version, "0.2.0");
    assert.equal(updatedConfig.compatibility_date, "2026-07-29");
    assert.equal(updatedConfig.account_id, oldConfig.account_id);
    assert.equal(updatedConfig.d1_databases[0].database_id, oldConfig.d1_databases[0].database_id);
    assert.equal(updatedConfig.r2_buckets[0].bucket_name, "my-drive-files");
    assert.equal(updatedConfig.routes[0].pattern, "drive.example.com");
    assert.equal(updatedConfig.vars.APP_NAME, "我的私人网盘");
    assert.equal(updatedConfig.vars.NEW_SAFE_DEFAULT, "yes");
    assert.equal(
      await readFile(path.join(instanceRoot, "config", "r2-cors.local.json"), "utf8"),
      '{"rules":["personal"]}',
    );
    await assert.rejects(readFile(path.join(instanceRoot, "obsolete.txt"), "utf8"));

    await rollbackReleaseTree(transaction);
    assert.equal(
      JSON.parse(await readFile(path.join(instanceRoot, "package.json"), "utf8")).version,
      "0.1.0",
    );
    assert.equal(await readFile(path.join(instanceRoot, "obsolete.txt"), "utf8"), "old source");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(instanceRoot, "wrangler.jsonc"), "utf8")),
      oldConfig,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("private mode keeps first-owner registration available", async () => {
  const [registerRoute, publicConfig, authForm, startRoute] = await Promise.all([
    readFile(path.join(root, "app", "api", "auth", "register", "route.ts"), "utf8"),
    readFile(path.join(root, "app", "api", "config", "route.ts"), "utf8"),
    readFile(path.join(root, "components", "AuthForm.tsx"), "utf8"),
    readFile(path.join(root, "app", "start", "route.ts"), "utf8"),
  ]);
  assert.match(registerRoute, /mode === "closed" && !isFirstUser/);
  assert.match(registerRoute, /WHERE NOT EXISTS \(SELECT 1 FROM users\)/);
  assert.match(registerRoute, /主人账号已经创建/);
  assert.match(publicConfig, /firstOwnerPending/);
  assert.match(publicConfig, /canRegister/);
  assert.match(authForm, /创建主人账号并进入/);
  assert.match(authForm, /confirmPassword/);
  assert.match(startRoute, /firstOwnerPending \? "\/register" : "\/login"/);
});

test("recognizes and reuses an existing D1 database from Wrangler JSON", () => {
  const output = `▲ [WARNING] Proxy environment variables detected.

[
  {
    "uuid": "123e4567-e89b-42d3-a456-426614174000",
    "name": "r2-drive-db"
  }
]
`;
  const databases = parseWranglerJson(output, "Wrangler D1");
  assert.deepEqual(findD1DatabaseByName(databases, "r2-drive-db"), {
    id: "123e4567-e89b-42d3-a456-426614174000",
    name: "r2-drive-db",
  });
  assert.equal(findD1DatabaseByName(databases, "another-db"), null);
});

test("classifies Workers plans without confusing them with the R2 free tier", () => {
  assert.deepEqual(classifyWorkersPlan("standard", "standard"), {
    kind: "paid",
    label: "Workers 付费版（Standard）",
    usageModel: "standard",
    certain: true,
  });
  assert.equal(classifyWorkersPlan("standard", "bundled").kind, "legacy");
  assert.equal(classifyWorkersPlan("enterprise", "").kind, "enterprise");
  assert.equal(classifyWorkersPlan("standard", "").kind, "unknown");
  assert.equal(R2_STANDARD_FREE_TIER.storageGBMonth, 10);
  assert.equal(R2_STANDARD_FREE_TIER.classAOperations, 1_000_000);
  assert.equal(R2_STANDARD_FREE_TIER.classBOperations, 10_000_000);
});

test("setup migrates local and remote databases without runtime schema writes", async () => {
  const [setup, defaultConfigSource, databaseRuntime] = await Promise.all([
    readFile(path.join(root, "scripts", "setup.mjs"), "utf8"),
    readFile(path.join(root, "config", "wrangler.default.jsonc"), "utf8"),
    readFile(path.join(root, "db", "runtime.ts"), "utf8"),
  ]);
  const defaultConfig = JSON.parse(defaultConfigSource);
  assert.match(setup, /\["d1", "migrations", "apply", values\.d1Name, "--remote"/);
  assert.match(setup, /\["d1", "migrations", "apply", values\.d1Name, "--local"/);
  assert.equal(defaultConfig.d1_databases[0].remote, undefined);
  assert.equal(defaultConfig.r2_buckets[0].remote, undefined);
  assert.doesNotMatch(databaseRuntime, /CREATE TABLE|ALTER TABLE/);
});

test("admin settings exposes one-click Wrangler upload acceleration", async () => {
  const [settings, setup] = await Promise.all([
    readFile(path.join(root, "components", "SettingsClient.tsx"), "utf8"),
    readFile(path.join(root, "scripts", "setup.mjs"), "utf8"),
  ]);
  assert.match(settings, /user\.role === "admin"/);
  assert.match(settings, /开启上传加速/);
  assert.match(settings, /127\.0\.0\.1:8788\/\?step=upload-acceleration&autostart=1/);
  assert.doesNotMatch(settings, /postMessage/);
  assert.match(settings, /uploadConcurrency: 6/);
  assert.match(settings, /networkProfile: "throughput"/);
  assert.match(setup, /async function enableUploadAcceleration/);
  assert.match(setup, /"local-uploads",\s+"enable"/);
  assert.match(setup, /"local-uploads", "get"/);
  assert.match(setup, /"cors",\s+"set"/);
  assert.match(setup, /url\.pathname === "\/api\/upload-acceleration\/enable"/);
  assert.match(setup, /upload-acceleration\.json/);
  assert.match(setup, /saveUploadAccelerationState/);
  assert.doesNotMatch(setup, /oauth\.pipelines\.cloudflare\.com/);
});

test("updates restart a stale setup helper instead of mixing UI and API versions", async () => {
  const [packageMetadata, setup, watchdog] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "scripts", "setup.mjs"), "utf8"),
    readFile(path.join(root, "scripts", "restart-stale-setup.mjs"), "utf8"),
  ]);
  assert.equal(packageMetadata.scripts.postinstall, "node scripts/restart-stale-setup.mjs");
  assert.match(setup, /runtimeVersion/);
  assert.match(setup, /restartHelper: true/);
  assert.match(setup, /scheduleSetupRestart/);
  assert.match(watchdog, /status\?\.runtimeVersion/);
  assert.match(watchdog, /currentJob\?\.kind !== "update-install"/);
  assert.match(watchdog, /process\.kill\(setupPid, "SIGTERM"\)/);
  assert.match(watchdog, /scripts", "setup\.mjs"\), "--no-open"/);
});

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

test("local setup wizard is loopback-only and protects write routes", async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["scripts/setup.mjs", "--no-open"], {
    cwd: root,
    env: {
      ...process.env,
      R2_DRIVE_SETUP_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`setup server did not start:\n${output}`)),
        5_000,
      );
      const inspect = (chunk) => {
        if (chunk.toString().includes(`127.0.0.1:${port}`)) {
          clearTimeout(timer);
          child.stdout.off("data", inspect);
          resolve();
        }
      };
      child.stdout.on("data", inspect);
    });

    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(base);
    const html = await page.text();
    const token = html.match(
      /name="r2-drive-setup-token" content="([a-f0-9]+)"/,
    )?.[1];
    assert.equal(page.status, 200);
    assert.match(html, /R2 Drive · 本地安装向导/);
    assert.match(html, /先确认你有什么/);
    assert.match(html, /data-choice-group="cloudflare"/);
    assert.match(html, /data-choice-group="r2"/);
    assert.match(html, /R2 是否已绑定付款卡/);
    assert.match(html, /已经绑定/);
    assert.match(html, /还未绑定/);
    assert.match(html, /请先在 R2 控制台绑定付款卡/);
    assert.match(html, /state\.r2Choice === "yes"/);
    assert.doesNotMatch(html, /我有 R2 存储桶/);
    assert.doesNotMatch(html, /是否已经创建 R2 存储桶/);
    assert.match(html, /developers\.cloudflare\.com\/r2\/buckets\/create-buckets/);
    assert.match(html, /一键创建 R2 桶（网盘）/);
    assert.match(html, /id="account-plan-card"/);
    assert.match(html, /R2 Standard 免费层目前是每月 10 GB-month/);
    assert.match(html, /name="quotaGB"/);
    assert.doesNotMatch(html, /name="quotaGiB"/);
    assert.doesNotMatch(html, /value="102400"/);
    assert.match(html, /\/api\/r2\/create/);
    assert.match(html, /自动查找或创建（推荐）/);
    assert.match(html, /检查并连接存储/);
    assert.match(html, /发布和使用前必须有域名/);
    assert.match(html, /没有域名不能发布/);
    assert.match(html, /没有域名不能使用/);
    assert.doesNotMatch(html, /没有域名：打开本机版/);
    assert.doesNotMatch(html, /暂时只在本机用/);
    assert.match(html, /name="customHostname"/);
    assert.match(html, /id="zone-choice"/);
    assert.match(html, /自动识别并发布域名/);
    assert.match(html, /一键发布并自动绑定/);
    assert.match(html, /id="domain-setup-body"/);
    assert.match(html, /id="domain-progress"/);
    assert.match(html, /id="open-production"[\s\S]*打开网盘/);
    assert.match(html, /byId\("publish-drive"\)\.classList\.add\("hidden"\)/);
    assert.match(html, /byId\("publish-status"\)\.classList\.add\("hidden"\)/);
    assert.match(html, /byId\("domain-progress"\)\.classList\.add\("hidden"\)/);
    assert.match(html, /!state\.configuredHostname/);
    assert.doesNotMatch(html, /打开线上网盘/);
    assert.match(html, /requestedStep === "domain"/);
    assert.match(html, /requestedStep === "update"/);
    assert.match(html, /requestedStep === "upload-acceleration"/);
    assert.match(html, /requestedAutostart/);
    assert.match(html, /waitForHelperVersion/);
    assert.match(html, /showAccelerationEnabled/);
    assert.match(html, /一键开启上传加速/);
    assert.match(html, /不打开 Cloudflare 页面，也不要求复制密钥/);
    assert.match(html, /\/api\/upload-acceleration\/enable/);
    assert.match(html, /event\.origin !== expectedOrigin/);
    assert.match(html, /r2-drive:enable-upload-acceleration/);
    assert.match(html, /检查与安装更新/);
    assert.match(html, /\/api\/update\/check/);
    assert.match(html, /\/api\/update\/install/);
    assert.match(html, /更新前自动备份当前程序和实例配置/);
    assert.match(html, /保留 R2 文件、D1 账号资料、域名与本机密钥/);
    const browserScript = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
    assert.ok(browserScript);
    assert.doesNotThrow(() => new Function(browserScript));
    assert.match(html, /这不一定是域名或 DNS 问题/);
    assert.match(html, /只有日志明确提示同名 CNAME 冲突时/);
    assert.match(html, /domain\.digitalplat\.org/);
    assert.match(html, /你的名字\.dpdns\.org/);
    assert.match(html, /把两条 NS 填进 Nameservers/);
    assert.match(html, /free-domain-dpdns\.md/);
    assert.doesNotMatch(html, /window\.confirm/);
    assert.doesNotMatch(html, /id="start-local"/);
    assert.doesNotMatch(html, /id="local-progress"/);
    assert.doesNotMatch(html, /HTTP Origin/);
    assert.doesNotMatch(html, /Worker 代理/);
    assert.ok(token);

    const status = await fetch(`${base}/api/status`);
    const statusBody = await status.json();
    assert.equal(status.status, 200);
    assert.equal(statusBody.config.workerName, "r2-drive");
    assert.equal(statusBody.runtimeVersion, statusBody.version);

    const blocked = await fetch(`${base}/api/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(blocked.status, 400);

    const blockedAcceleration = await fetch(`${base}/api/upload-acceleration/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(blockedAcceleration.status, 400);

    const authenticatedUnknownRoute = await fetch(`${base}/api/unknown`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-r2-drive-setup-token": token,
      },
      body: "{}",
    });
    assert.equal(authenticatedUnknownRoute.status, 404);

    const invalidCreate = await fetch(`${base}/api/r2/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-r2-drive-setup-token": token,
      },
      body: JSON.stringify({ accountId: "", r2Name: "r2-drive-test" }),
    });
    assert.equal(invalidCreate.status, 202);
    const invalidCreateJob = await invalidCreate.json();
    let finalCreateJob;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const jobResponse = await fetch(`${base}/api/jobs/${invalidCreateJob.id}`);
      finalCreateJob = await jobResponse.json();
      if (finalCreateJob.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(finalCreateJob.status, "error");
    assert.match(finalCreateJob.error, /连接 Cloudflare 账号/);

    const blockedLocalStart = await fetch(`${base}/api/local/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-r2-drive-setup-token": token,
      },
      body: "{}",
    });
    assert.equal(blockedLocalStart.status, 400);
    assert.match((await blockedLocalStart.json()).error, /必须先绑定 Active 域名/);

    const unconfirmedDeploy = await fetch(`${base}/api/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-r2-drive-setup-token": token,
      },
      body: JSON.stringify({ confirm: false }),
    });
    assert.equal(unconfirmedDeploy.status, 202);
    const unconfirmedJob = await unconfirmedDeploy.json();
    let finalJob;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const jobResponse = await fetch(`${base}/api/jobs/${unconfirmedJob.id}`);
      finalJob = await jobResponse.json();
      if (finalJob.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(finalJob.status, "error");
    assert.match(finalJob.error, /明确确认/);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close");
    }
  }
});

test("setup can create or reuse a private R2 bucket and binds only a custom domain", async () => {
  const source = await readFile(path.join(root, "scripts", "setup.mjs"), "utf8");
  assert.match(source, /\["r2", "bucket", "info", values\.r2Name, "--json"\]/);
  assert.match(
    source,
    /\["r2", "bucket", "create", values\.r2Name, "--location", "apac"\]/,
  );
  assert.match(source, /url\.pathname === "\/api\/r2\/create"/);
  assert.match(source, /url\.pathname === "\/api\/zones\/list"/);
  assert.match(source, /async function listCloudflareZones/);
  assert.match(source, /"account\.id": accountId/);
  assert.match(source, /new EnvHttpProxyAgent\(\)/);
  assert.match(source, /registrationMode: "closed"/);
  assert.match(source, /\["d1", "list", "--json"\]/);
  assert.match(source, /已经存在，将直接使用，不会重复创建/);
  assert.match(source, /async function inspectLocalDrive/);
  assert.match(source, /async function stopPreviousLocalDrive/);
  assert.match(source, /function isOwnedLocalDriveProcess/);
  assert.match(source, /process\.kill\(pid, "SIGKILL"\)/);
  assert.match(source, /不再提供无域名本机版/);
  assert.match(source, /custom_domain: true/);
  assert.match(source, /config\.workers_dev = false/);
  assert.match(source, /config\.preview_urls = false/);
  assert.match(source, /url\.pathname === "\/api\/update\/check"/);
  assert.match(source, /url\.pathname === "\/api\/update\/install"/);
  assert.match(source, /await applyReleaseTree/);
  assert.match(source, /await rollbackReleaseTree/);
  assert.match(source, /d1", "migrations", "apply", database, "--local"/);
  assert.match(source, /d1", "migrations", "apply", database, "--remote"/);
  assert.match(source, /localAddress && localHost/);
});

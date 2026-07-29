#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SETUP_STATUS_URL = "http://127.0.0.1:8788/api/status";
const WATCH_ARGUMENT = "--watch";
const RESTART_ARGUMENT = "--restart-after-exit";
const MAX_WATCH_MS = 45 * 60 * 1_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalized(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

async function readStatus() {
  const response = await fetch(SETUP_STATUS_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) return null;
  return response.json();
}

function unixProcess(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "command="], {
    encoding: "utf8",
    windowsHide: true,
  });
  const match = String(result.stdout || "").trim().match(/^(\d+)\s+([\s\S]+)$/);
  return match ? { pid, parentPid: Number(match[1]), command: match[2] } : null;
}

function windowsProcess(pid) {
  const script =
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";` +
    `if($p){Write-Output ($p.ParentProcessId.ToString() + [char]9 + $p.CommandLine)}`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  const match = String(result.stdout || "").trim().match(/^(\d+)\t([\s\S]+)$/);
  return match ? { pid, parentPid: Number(match[1]), command: match[2] } : null;
}

function inspectProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return process.platform === "win32" ? windowsProcess(pid) : unixProcess(pid);
}

function isOwnedSetupProcess(metadata) {
  const command = normalized(metadata?.command);
  return command.includes("scripts/setup.mjs");
}

function findSetupAncestor() {
  let pid = process.ppid;
  for (let depth = 0; depth < 12; depth += 1) {
    const metadata = inspectProcess(pid);
    if (!metadata) return null;
    if (isOwnedSetupProcess(metadata)) return metadata;
    if (metadata.parentPid === pid) return null;
    pid = metadata.parentPid;
  }
  return null;
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function setupIsResponding() {
  try {
    return Boolean(await readStatus());
  } catch {
    return false;
  }
}

function launchSetupHelper() {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "scripts", "setup.mjs"), "--no-open"],
    {
      cwd: ROOT,
      env: process.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    },
  );
  child.unref();
}

async function restartAfterExit(setupPid) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!processIsRunning(setupPid) && !(await setupIsResponding())) {
      launchSetupHelper();
      return;
    }
    await sleep(250);
  }
}

async function watchAndRestart(setupPid) {
  const metadata = inspectProcess(setupPid);
  if (!isOwnedSetupProcess(metadata)) return;

  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_WATCH_MS) {
    let status = null;
    try {
      status = await readStatus();
    } catch {
      if (!processIsRunning(setupPid)) return;
    }
    const job = status?.currentJob;
    if (job?.kind === "update-install" && job.status === "error") return;
    if (job?.kind === "update-install" && job.status === "success") {
      await sleep(1_500);
      const latest = inspectProcess(setupPid);
      if (!isOwnedSetupProcess(latest)) return;
      process.kill(setupPid, "SIGTERM");
      for (let attempt = 0; attempt < 40 && (await setupIsResponding()); attempt += 1) {
        await sleep(250);
      }
      if (await setupIsResponding()) {
        const remaining = inspectProcess(setupPid);
        if (!isOwnedSetupProcess(remaining)) return;
        process.kill(setupPid, "SIGKILL");
        for (let attempt = 0; attempt < 20 && (await setupIsResponding()); attempt += 1) {
          await sleep(250);
        }
      }
      if (await setupIsResponding()) return;
      launchSetupHelper();
      return;
    }
    await sleep(750);
  }
}

async function scheduleMigrationRestart() {
  let status;
  try {
    status = await readStatus();
  } catch {
    return;
  }
  if (
    status?.runtimeVersion ||
    status?.currentJob?.kind !== "update-install" ||
    status.currentJob.status !== "running"
  ) {
    return;
  }
  const setup = findSetupAncestor();
  if (!setup) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), WATCH_ARGUMENT, String(setup.pid)], {
    cwd: ROOT,
    env: process.env,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  child.unref();
  console.log("✓ 更新完成后将自动重启本机助手。");
}

if (process.argv[2] === WATCH_ARGUMENT) {
  await watchAndRestart(Number(process.argv[3]));
} else if (process.argv[2] === RESTART_ARGUMENT) {
  await restartAfterExit(Number(process.argv[3]));
} else {
  await scheduleMigrationRestart();
}

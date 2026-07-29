"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  Check,
  Clipboard,
  CloudArrowUp,
  Code,
  Key,
  Lightning,
  LockKey,
  Monitor,
  Palette,
  Pause,
  Play,
  Plus,
  Trash,
  User,
} from "@phosphor-icons/react";
import { AppShell, applyPreferences, ShellUser } from "@/components/AppShell";

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type ApiFailure = { error?: { message?: string } };

type StorageNode = {
  id: string;
  label: string;
  accountId: string;
  bucketName: string;
  endpoint: string;
  status: "active" | "draining" | "offline";
  softLimitBytes: number;
  usedBytes: number;
  reservedBytes: number;
  lastHealthAt: string | null;
  lastError: string | null;
};

type PrimaryStorage = {
  label: string;
  accountId: string;
  bucketName: string;
  status: "active";
  usedBytes: number;
  reservedBytes: number;
};

async function messageFrom(response: Response): Promise<string> {
  try {
    return ((await response.json()) as ApiFailure).error?.message || "保存失败。";
  } catch {
    return "保存失败。";
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const order = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** order).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
  })} ${units[order]}`;
}

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function SettingsClient() {
  return (
    <AppShell title="个人设置" detail="账号、界面偏好与开发者访问">
      {(user) => <SettingsContent user={user} />}
    </AppShell>
  );
}

function SettingsContent({ user }: { user: ShellUser }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [notice, setNotice] = useState("");
  const [createdToken, setCreatedToken] = useState("");
  const [accelerationBusy, setAccelerationBusy] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageNodes, setStorageNodes] = useState<StorageNode[]>([]);
  const [primaryStorage, setPrimaryStorage] = useState<PrimaryStorage | null>(null);
  const storageHelperWatcher = useRef<number | null>(null);

  const loadTokens = useCallback(async () => {
    const response = await fetch("/api/settings/tokens");
    if (response.ok) {
      setTokens(((await response.json()) as { tokens: TokenRow[] }).tokens);
    }
  }, []);

  const loadStorageNodes = useCallback(async () => {
    if (user.role !== "admin") return;
    const response = await fetch("/api/admin/storage-nodes");
    if (!response.ok) return;
    const result = (await response.json()) as {
      primary: PrimaryStorage;
      nodes: StorageNode[];
    };
    setPrimaryStorage(result.primary);
    setStorageNodes(result.nodes);
  }, [user.role]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadTokens();
      void loadStorageNodes();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadStorageNodes, loadTokens]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin === "http://127.0.0.1:8788" &&
        event.data?.type === "r2-drive:storage-node-connected"
      ) {
        if (storageHelperWatcher.current !== null) {
          window.clearInterval(storageHelperWatcher.current);
          storageHelperWatcher.current = null;
        }
        setStorageBusy(false);
        setNotice("新的 Cloudflare R2 存储节点已经连接。");
        void loadStorageNodes();
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (storageHelperWatcher.current !== null) {
        window.clearInterval(storageHelperWatcher.current);
        storageHelperWatcher.current = null;
      }
    };
  }, [loadStorageNodes]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const preferences = {
      theme: data.get("theme"),
      density: data.get("density"),
      defaultView: data.get("defaultView"),
      uploadConcurrency: Number(data.get("uploadConcurrency") || 3),
      networkProfile: data.get("networkProfile"),
    };
    const response = await fetch("/api/settings/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: String(data.get("displayName") || ""),
        preferences,
      }),
    });
    setNotice(response.ok ? "个人设置已保存。" : await messageFrom(response));
    if (response.ok) applyPreferences(preferences);
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/settings/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: String(data.get("currentPassword") || ""),
        newPassword: String(data.get("newPassword") || ""),
      }),
    });
    setNotice(response.ok ? "密码已更新。" : await messageFrom(response));
    if (response.ok) form.reset();
  }

  async function enableUploadAcceleration() {
    const helper = window.open(
      "http://127.0.0.1:8788/?step=upload-acceleration&autostart=1",
      "_blank",
    );
    if (!helper) {
      setNotice("浏览器阻止了本机助手窗口，请允许弹出窗口后重试。");
      return;
    }
    setAccelerationBusy(true);
    const acceleratedPreferences = {
      ...preferences,
      uploadConcurrency: 6,
      networkProfile: "throughput",
    };
    const response = await fetch("/api/settings/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferences: acceleratedPreferences }),
    });
    setAccelerationBusy(false);
    if (!response.ok) {
      setNotice(await messageFrom(response));
      return;
    }
    applyPreferences(acceleratedPreferences);
    setNotice("已切换到高吞吐上传；本机助手正在自动完成 Wrangler 配置。");
  }

  async function connectStorageNode() {
    const helper = window.open("about:blank", "_blank");
    if (!helper) {
      setNotice("浏览器阻止了本机助手窗口，请允许弹出窗口后重试。");
      return;
    }
    helper.document.title = "正在打开 R2 Drive 本机助手…";
    helper.document.body.textContent = "正在准备安全的一次性连接…";
    setStorageBusy(true);
    try {
      const response = await fetch("/api/admin/storage-nodes/enrollments", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const enrollment = (await response.json()) as {
        id: string;
        token: string;
        origin: string;
        expiresAt: string;
      };
      const fragment = base64UrlJson({
        origin: enrollment.origin,
        token: enrollment.token,
        expiresAt: enrollment.expiresAt,
      });
      helper.location.href =
        `http://127.0.0.1:8788/?step=storage-pool#storage-enrollment=${fragment}`;
      if (storageHelperWatcher.current !== null) {
        window.clearInterval(storageHelperWatcher.current);
        storageHelperWatcher.current = null;
      }
      const helperDeadline = Date.parse(enrollment.expiresAt);
      let checkingResult = false;
      const stopWatching = (timedOut = false) => {
        if (storageHelperWatcher.current !== null) {
          window.clearInterval(storageHelperWatcher.current);
          storageHelperWatcher.current = null;
        }
        setStorageBusy(false);
        if (timedOut) {
          setNotice("本次安全连接已过期，请确认本机助手状态后重新点击连接。");
        }
      };
      const checkResult = async () => {
        if (Date.now() >= helperDeadline) {
          stopWatching(true);
          return;
        }
        if (checkingResult) return;
        checkingResult = true;
        try {
          const statusResponse = await fetch(
            `/api/admin/storage-nodes/enrollments/${encodeURIComponent(enrollment.id)}`,
            { signal: AbortSignal.timeout(8_000) },
          );
          if (statusResponse.ok) {
            const result = (await statusResponse.json()) as {
              status: "pending" | "connected" | "expired";
              nodeId: string | null;
            };
            if (result.status === "connected" && result.nodeId) {
              stopWatching();
              setNotice("新的 Cloudflare R2 存储节点已经连接。");
              void loadStorageNodes();
            } else if (result.status === "expired") {
              stopWatching(true);
            }
          }
        } catch {
          // OAuth/Wrangler 仍可能在进行；单次请求会在 8 秒后中止，下一轮继续。
        } finally {
          checkingResult = false;
        }
      };
      storageHelperWatcher.current = window.setInterval(() => {
        void checkResult();
      }, 5_000);
      void checkResult();
      setNotice(
        "本机助手已打开。选择你拥有的 Cloudflare 账号后，它会用 Wrangler 自动完成连接。",
      );
    } catch (error) {
      helper.close();
      setStorageBusy(false);
      setNotice(
        error instanceof Error
          ? `无法创建安全连接：${error.message}`
          : "无法创建安全连接，请检查网络后重试。",
      );
    }
  }

  async function updateStorageNode(
    id: string,
    update: {
      status?: "active" | "draining";
      checkHealth?: boolean;
    },
  ) {
    const response = await fetch(`/api/admin/storage-nodes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!response.ok) {
      setNotice(await messageFrom(response));
      return;
    }
    await loadStorageNodes();
    setNotice(update.checkHealth ? "节点健康检查完成。" : "存储节点设置已更新。");
  }

  async function createToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scopes = ["files:read", "files:write", "shares:write"].filter((scope) => data.get(scope));
    const response = await fetch("/api/settings/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: String(data.get("name") || ""),
        expiresInDays: Number(data.get("expiresInDays") || 365),
        scopes,
      }),
    });
    if (!response.ok) {
      setNotice(await messageFrom(response));
      return;
    }
    const result = (await response.json()) as { token: string };
    setCreatedToken(result.token);
    form.reset();
    await loadTokens();
  }

  async function deleteToken(id: string) {
    const response = await fetch(`/api/settings/tokens/${id}`, { method: "DELETE" });
    if (response.ok) await loadTokens();
    else setNotice(await messageFrom(response));
  }

  const preferences = user.preferences || {};
  return (
    <div className="settings-layout">
      {notice && <div className="notice-bar settings-notice"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}

      <section className="settings-section">
        <div className="settings-section-title">
          <User />
          <div><h2>账号资料</h2><p>用于界面显示与审计记录。</p></div>
        </div>
        <form className="settings-form" onSubmit={saveProfile}>
          <label><span>显示名称</span><input name="displayName" defaultValue={user.displayName} required maxLength={80} /></label>
          <label><span>登录邮箱</span><input value={user.email} disabled /></label>
          <div className="form-grid-2">
            <label>
              <span><Palette /> 主题</span>
              <select name="theme" defaultValue={String(preferences.theme || "system")}>
                <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
              </select>
            </label>
            <label>
              <span><Monitor /> 内容密度</span>
              <select name="density" defaultValue={String(preferences.density || "comfortable")}>
                <option value="comfortable">舒适</option><option value="compact">紧凑</option>
              </select>
            </label>
            <label>
              <span>默认视图</span>
              <select name="defaultView" defaultValue={String(preferences.defaultView || "list")}>
                <option value="list">列表</option><option value="grid">网格</option>
              </select>
            </label>
            <label>
              <span>并行上传分片</span>
              <select name="uploadConcurrency" defaultValue={String(preferences.uploadConcurrency || 3)}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <span>网络分片策略</span>
              <select name="networkProfile" defaultValue={String(preferences.networkProfile || "balanced")}>
                <option value="stable">弱网稳定（16 MiB）</option>
                <option value="balanced">均衡（64 MiB）</option>
                <option value="throughput">高吞吐（80 MiB）</option>
              </select>
            </label>
          </div>
          <button className="button button-primary form-submit"><Check /> 保存设置</button>
        </form>
      </section>

      {user.role === "admin" && (
        <section className="settings-section">
          <div className="settings-section-title">
            <Lightning />
            <div>
              <h2>上传加速</h2>
              <p>自动开启 R2 就近写入，并使用 80 MiB 分片与 6 路并发；不需要打开 Cloudflare 页面。</p>
            </div>
          </div>
          <div className="settings-form">
            <button
              className="button button-primary form-submit"
              type="button"
              disabled={accelerationBusy}
              onClick={() => void enableUploadAcceleration()}
            >
              <Lightning /> {accelerationBusy ? "正在准备…" : "开启上传加速"}
            </button>
            <small className="muted">
              需通过 R2-Drive 启动器打开网盘；点击后新窗口会自动配置并复核，不需要再操作。
            </small>
          </div>
        </section>
      )}

      {user.role === "admin" && (
        <section className="settings-section">
          <div className="settings-section-title">
            <CloudArrowUp />
            <div>
              <h2>多账号存储池</h2>
              <p>
                把你拥有并授权的 Cloudflare R2 账号接入同一个网盘；每个文件固定存放在一个节点。
              </p>
            </div>
          </div>
          <div className="storage-pool-summary">
            <div>
              <span>已连接节点</span>
              <strong>{1 + storageNodes.length}</strong>
            </div>
            <div>
              <span>全池已用</span>
              <strong>
                {formatBytes(
                  (primaryStorage?.usedBytes ?? 0) +
                    storageNodes.reduce((total, node) => total + node.usedBytes, 0),
                )}
              </strong>
            </div>
            <div>
              <span>附加节点软容量</span>
              <strong>
                {formatBytes(
                  storageNodes.reduce(
                    (total, node) => total + node.softLimitBytes,
                    0,
                  ),
                )}
              </strong>
            </div>
          </div>
          <div className="storage-pool-notice">
            <strong>软容量是 R2 Drive 的写入预算，不是 Cloudflare 的真实剩余空间。</strong>
            <span>
              R2 单桶没有固定容量上限，免费额度与超额计费仍由各 Cloudflare
              账号分别计算；连接后会按软容量同步增加当前主人的网盘配额。请按
              Cloudflare 条款使用，不能用于规避用量限制。
            </span>
          </div>
          <div className="storage-node-list">
            {primaryStorage && (
              <div className="storage-node-row">
                <span className="storage-node-icon"><CloudArrowUp /></span>
                <div>
                  <strong>{primaryStorage.label}</strong>
                  <small>
                    {primaryStorage.bucketName} · {primaryStorage.accountId.slice(0, 8)}…
                  </small>
                </div>
                <div>
                  <strong>{formatBytes(primaryStorage.usedBytes)}</strong>
                  <small>主节点 · 始终保留</small>
                </div>
                <span className="node-status active">正常</span>
              </div>
            )}
            {storageNodes.map((node) => (
              <div className="storage-node-row" key={node.id}>
                <span className="storage-node-icon"><CloudArrowUp /></span>
                <div>
                  <strong>{node.label}</strong>
                  <small>
                    {node.bucketName} · {node.accountId.slice(0, 8)}…
                  </small>
                </div>
                <div>
                  <strong>
                    {formatBytes(node.usedBytes + node.reservedBytes)} /{" "}
                    {formatBytes(node.softLimitBytes)}
                  </strong>
                  <small>
                    {node.reservedBytes > 0
                      ? `${formatBytes(node.reservedBytes)} 上传中`
                      : node.lastError || "软容量预算"}
                  </small>
                </div>
                <span className={`node-status ${node.status}`}>
                  {node.status === "active"
                    ? "正常"
                    : node.status === "draining"
                      ? "暂停写入"
                      : "离线"}
                </span>
                <div className="storage-node-actions">
                  <button
                    type="button"
                    title="健康检查"
                    onClick={() =>
                      void updateStorageNode(node.id, { checkHealth: true })
                    }
                  >
                    <ArrowClockwise />
                  </button>
                  <button
                    type="button"
                    title={node.status === "active" ? "暂停新写入" : "恢复写入"}
                    onClick={() =>
                      void updateStorageNode(node.id, {
                        status: node.status === "active" ? "draining" : "active",
                      })
                    }
                  >
                    {node.status === "active" ? <Pause /> : <Play />}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="settings-form storage-pool-actions">
            <button
              className="button button-primary form-submit"
              type="button"
              disabled={storageBusy}
              onClick={() => void connectStorageNode()}
            >
              <Plus /> {storageBusy ? "等待本机助手…" : "连接另一个 Cloudflare 账号"}
            </button>
            <small className="muted">
              要连接的账号须先启用 R2 并完成 Cloudflare 要求的付款设置；Wrangler
              无法代办账单。在此前提下，桶、私有存储节点和安全登记都由本机自动完成，
              连接过程中无需打开 Cloudflare 控制台；新登录仍需在官方授权页完成
              OAuth 或 MFA。
            </small>
          </div>
        </section>
      )}

      <section className="settings-section">
        <div className="settings-section-title">
          <LockKey />
          <div><h2>修改密码</h2><p>修改后现有会话继续有效，其他设备可在数据库中撤销。</p></div>
        </div>
        <form className="settings-form" onSubmit={updatePassword}>
          <div className="form-grid-2">
            <label><span>当前密码</span><input name="currentPassword" type="password" required /></label>
            <label><span>新密码</span><input name="newPassword" type="password" minLength={12} required placeholder="至少 12 位" /></label>
          </div>
          <button className="button button-secondary form-submit"><Key /> 更新密码</button>
        </form>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Code />
          <div><h2>开发者 API 令牌</h2><p>令牌只在创建时显示一次；服务端只保存 SHA-256 摘要。</p></div>
        </div>
        {createdToken && (
          <div className="token-reveal">
            <div><strong>立即保存此令牌</strong><span>关闭后无法再次查看。</span></div>
            <code>{createdToken}</code>
            <button onClick={() => navigator.clipboard.writeText(createdToken)}><Clipboard /> 复制</button>
          </div>
        )}
        <form className="token-create-form" onSubmit={createToken}>
          <label><span>名称</span><input name="name" required placeholder="例如：备份脚本" /></label>
          <label><span>有效天数</span><input name="expiresInDays" type="number" min={1} max={3650} defaultValue={365} required /></label>
          <fieldset>
            <legend>权限范围</legend>
            <label><input type="checkbox" name="files:read" defaultChecked /> files:read</label>
            <label><input type="checkbox" name="files:write" defaultChecked /> files:write</label>
            <label><input type="checkbox" name="shares:write" /> shares:write</label>
          </fieldset>
          <button className="button button-primary"><Key /> 创建令牌</button>
        </form>
        <div className="token-list">
          {tokens.length === 0 ? <p className="muted">还没有 API 令牌。</p> : tokens.map((token) => (
            <div key={token.id}>
              <span className="token-icon"><Key /></span>
              <div><strong>{token.name}</strong><small>{token.prefix}… · {token.scopes.join(", ")}</small></div>
              <span>{token.expiresAt ? new Date(token.expiresAt).toLocaleDateString("zh-CN") : "永不过期"}</span>
              <button onClick={() => deleteToken(token.id)} aria-label={`删除 ${token.name}`}><Trash /></button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

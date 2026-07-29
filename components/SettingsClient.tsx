"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Check,
  Clipboard,
  Code,
  Key,
  Lightning,
  LockKey,
  Monitor,
  Palette,
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

async function messageFrom(response: Response): Promise<string> {
  try {
    return ((await response.json()) as ApiFailure).error?.message || "保存失败。";
  } catch {
    return "保存失败。";
  }
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

  const loadTokens = useCallback(async () => {
    const response = await fetch("/api/settings/tokens");
    if (response.ok) {
      setTokens(((await response.json()) as { tokens: TokenRow[] }).tokens);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadTokens(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadTokens]);

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

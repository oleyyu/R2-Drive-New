"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise,
  Check,
  Clipboard,
  Cloud,
  Database,
  File,
  Gauge,
  GlobeHemisphereWest,
  HardDrives,
  Key,
  Pulse,
  ShieldCheck,
  SlidersHorizontal,
  Trash,
  Users,
  Warning,
} from "@phosphor-icons/react";
import { AppShell } from "@/components/AppShell";

type Overview = {
  metrics: { users: number; storage: number; files: number; activeUploads: number };
  runtime: {
    directUpload: boolean;
    uploadMode: "auto" | "direct" | "proxy";
    downloadMode: "direct" | "proxy";
    maxFileSizeBytes: number;
    r2AccountConfigured: boolean;
    sharingEnabled: boolean;
    publicHostname: string;
  };
  settings: {
    registrationMode: "open" | "invite" | "closed";
    defaultUserQuotaBytes: number;
    siteName: string;
  };
  users: Array<{
    id: string;
    email: string;
    displayName: string;
    role: "admin" | "user";
    status: "active" | "suspended";
    storageQuota: number;
    storageUsed: number;
    createdAt: string;
  }>;
  audit: Array<{
    id: string;
    action: string;
    target_type: string;
    actor_email?: string;
    created_at: string;
  }>;
};

type Invitation = {
  id: string;
  email: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: string;
  createdAt: string;
};

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${units[index]}`;
}

export function AdminClient() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [createdInvite, setCreatedInvite] = useState("");

  const load = useCallback(async () => {
    setError("");
    const response = await fetch("/api/admin/overview");
    if (response.status === 403) {
      setError("当前账号没有管理员权限。");
      return;
    }
    if (!response.ok) {
      setError("无法读取管理数据，请检查 D1 绑定。");
      return;
    }
    setOverview((await response.json()) as Overview);
    const invitationResponse = await fetch("/api/admin/invitations");
    if (invitationResponse.ok) {
      setInvitations(((await invitationResponse.json()) as { invitations: Invitation[] }).invitations);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const quotaGB = Number(data.get("defaultQuotaGB"));
    const response = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: String(data.get("siteName") || ""),
        registrationMode: data.get("registrationMode"),
        defaultUserQuotaBytes: Math.round(quotaGB * 1_000_000_000),
      }),
    });
    setNotice(response.ok ? "系统设置已保存。" : "系统设置保存失败。");
    if (response.ok) await load();
  }

  async function updateUser(
    id: string,
    update: { role?: "admin" | "user"; status?: "active" | "suspended"; storageQuota?: number },
  ) {
    const response = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    setNotice(response.ok ? "用户设置已更新。" : "用户设置更新失败；请避免锁定当前管理员。");
    if (response.ok) await load();
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/admin/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: String(data.get("email") || "") || null,
        expiresInDays: Number(data.get("expiresInDays") || 7),
        maxUses: Number(data.get("maxUses") || 1),
      }),
    });
    if (!response.ok) {
      setNotice("邀请码创建失败。");
      return;
    }
    setCreatedInvite(((await response.json()) as { token: string }).token);
    form.reset();
    await load();
  }

  async function revokeInvitation(id: string) {
    const response = await fetch(`/api/admin/invitations/${id}`, { method: "DELETE" });
    setNotice(response.ok ? "邀请码已撤销。" : "邀请码撤销失败。");
    if (response.ok) await load();
  }

  return (
    <AppShell title="管理控制台" detail="实例运行状态、用户策略与交付配置">
      {error ? (
        <div className="admin-error"><Warning weight="fill" /><h2>无法进入管理控制台</h2><p>{error}</p></div>
      ) : !overview ? (
        <div className="table-state"><ArrowClockwise className="spin" /> 正在汇总实例数据…</div>
      ) : (
        <div className="admin-layout">
          {notice && <div className="notice-bar"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
          <section className="metric-grid">
            <article><Users /><span>用户</span><strong>{overview.metrics.users}</strong><small>已注册账号</small></article>
            <article><HardDrives /><span>已用空间</span><strong>{formatBytes(overview.metrics.storage)}</strong><small>所有用户合计</small></article>
            <article><File /><span>文件</span><strong>{overview.metrics.files}</strong><small>已完成对象</small></article>
            <article><Pulse /><span>上传中</span><strong>{overview.metrics.activeUploads}</strong><small>有效分片任务</small></article>
          </section>

          <section className="runtime-panel">
            <div className="settings-section-title">
              <Gauge /><div><h2>运行时检查</h2><p>来自当前 Worker 环境变量与 Secret。</p></div>
            </div>
            <div className="runtime-checks">
              <div className={overview.runtime.directUpload ? "ok" : "warn"}>
                {overview.runtime.directUpload ? <ShieldCheck weight="fill" /> : <Warning weight="fill" />}
                <span><strong>R2 S3 直传</strong><small>{overview.runtime.directUpload ? `可用 · 当前 ${overview.runtime.uploadMode} 模式` : "未配置或已强制代理"}</small></span>
              </div>
              <div className={overview.runtime.r2AccountConfigured ? "ok" : "warn"}>
                <Database weight="fill" />
                <span><strong>R2 账号配置</strong><small>{overview.runtime.r2AccountConfigured ? "Account ID 与桶名已设置" : "缺少 Account ID 或桶名"}</small></span>
              </div>
              <div className="ok">
                <Cloud weight="fill" />
                <span><strong>下载模式</strong><small>{overview.runtime.downloadMode === "direct" ? "S3 短期签名跳转" : "Worker 流式代理（支持 Range）"}</small></span>
              </div>
              <div className="ok">
                <SlidersHorizontal weight="fill" />
                <span><strong>单文件上限</strong><small>{formatBytes(overview.runtime.maxFileSizeBytes)}</small></span>
              </div>
            </div>
            <div className={`domain-binding-panel ${overview.runtime.sharingEnabled ? "ready" : "missing"}`}>
              <span><GlobeHemisphereWest weight="duotone" /></span>
              <div>
                <strong>{overview.runtime.sharingEnabled ? "公开分享已开启" : "公开分享已关闭"}</strong>
                <p>
                  {overview.runtime.sharingEnabled
                    ? `当前分享域名：${overview.runtime.publicHostname}`
                    : "未绑定自己的域名时，不会创建或提供公开下载链接。"}
                </p>
                <small>请保持 R2 Drive 启动器窗口开启；若助手没有打开，请在启动器选择“2. 配置／重新配置”。</small>
              </div>
              <a
                className="button button-primary"
                href="http://127.0.0.1:8788/?step=domain"
                target="_blank"
                rel="noreferrer"
              >
                <GlobeHemisphereWest />
                {overview.runtime.sharingEnabled ? "更换绑定域名" : "绑定域名"}
              </a>
            </div>
          </section>

          <section className="admin-section">
            <div className="settings-section-title">
              <SlidersHorizontal /><div><h2>系统策略</h2><p>数据库设置覆盖环境变量默认值。</p></div>
            </div>
            <form className="settings-form" onSubmit={saveSettings}>
              <div className="form-grid-2">
                <label><span>站点名称</span><input name="siteName" defaultValue={overview.settings.siteName} required /></label>
                <label>
                  <span>注册策略</span>
                  <select name="registrationMode" defaultValue={overview.settings.registrationMode}>
                    <option value="open">开放注册</option>
                    <option value="invite">仅邀请（预留）</option>
                    <option value="closed">关闭注册</option>
                  </select>
                </label>
                <label>
                  <span>新用户默认配额（GB）</span>
                  <input name="defaultQuotaGB" type="number" min={0.001} step={1} defaultValue={Math.round(overview.settings.defaultUserQuotaBytes / 1_000_000_000)} required />
                </label>
              </div>
              <button className="button button-primary form-submit"><Check /> 保存系统策略</button>
            </form>
          </section>

          <section className="admin-section">
            <div className="settings-section-title">
              <Users /><div><h2>用户管理</h2><p>角色、状态和配额均按用户独立设置。</p></div>
            </div>
            <div className="admin-user-table">
              <div className="admin-user-head"><span>用户</span><span>空间</span><span>角色</span><span>状态</span></div>
              {overview.users.map((user) => (
                <div className="admin-user-row" key={user.id}>
                  <div><strong>{user.displayName}</strong><small>{user.email}</small></div>
                  <label>
                    <input
                      type="number"
                      aria-label={`${user.displayName} 配额 GB`}
                      defaultValue={Math.round(user.storageQuota / 1_000_000_000)}
                      min={0.001}
                      onBlur={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (value > 0) void updateUser(user.id, { storageQuota: Math.round(value * 1_000_000_000) });
                      }}
                    />
                    <small>{formatBytes(user.storageUsed)} 已用</small>
                  </label>
                  <select value={user.role} onChange={(event) => void updateUser(user.id, { role: event.target.value as "admin" | "user" })}>
                    <option value="user">普通用户</option><option value="admin">管理员</option>
                  </select>
                  <select value={user.status} onChange={(event) => void updateUser(user.id, { status: event.target.value as "active" | "suspended" })}>
                    <option value="active">正常</option><option value="suspended">已停用</option>
                  </select>
                </div>
              ))}
            </div>
          </section>

          <section className="admin-section">
            <div className="settings-section-title">
              <Key /><div><h2>注册邀请</h2><p>使用“仅邀请”注册策略时，通过这里创建可撤销、可过期的注册码。</p></div>
            </div>
            {createdInvite && (
              <div className="token-reveal">
                <div><strong>邀请码只显示一次</strong><span>请通过安全渠道发给受邀者。</span></div>
                <code>{createdInvite}</code>
                <button onClick={() => navigator.clipboard.writeText(createdInvite)}><Clipboard /> 复制</button>
              </div>
            )}
            <form className="invite-create-form" onSubmit={createInvitation}>
              <label><span>限制邮箱（可选）</span><input name="email" type="email" placeholder="person@example.com" /></label>
              <label><span>有效天数</span><input name="expiresInDays" type="number" min={1} max={365} defaultValue={7} required /></label>
              <label><span>可用次数</span><input name="maxUses" type="number" min={1} max={10000} defaultValue={1} required /></label>
              <button className="button button-primary"><Key /> 创建邀请码</button>
            </form>
            <div className="invitation-list">
              {invitations.length === 0 ? <p className="muted">还没有邀请码。</p> : invitations.map((invite) => (
                <div key={invite.id}>
                  <span className="token-icon"><Key /></span>
                  <div><strong>{invite.email || "任何邮箱"}</strong><small>已用 {invite.useCount} / {invite.maxUses}</small></div>
                  <time>{new Date(invite.expiresAt).toLocaleDateString("zh-CN")} 到期</time>
                  <button onClick={() => revokeInvitation(invite.id)} aria-label="撤销邀请码"><Trash /></button>
                </div>
              ))}
            </div>
          </section>

          <section className="admin-section">
            <div className="settings-section-title">
              <Cloud /><div><h2>个人网络优化清单</h2><p>全部使用普通 Cloudflare 账号可启用的能力。</p></div>
            </div>
            <div className="china-readiness">
              <article><span>01</span><div><strong>开启 R2 Local Uploads</strong><p>上传先写入靠近客户端的位置，再异步复制到桶；Cloudflare 当前不额外收费。</p></div></article>
              <article><span>02</span><div><strong>选择 APAC 新桶</strong><p>Location Hint 只在建桶时设置，是尽力而为的亚洲位置偏好。</p></div></article>
              <article><span>03</span><div><strong>按网络选择路由</strong><p>auto 优先 R2 直传并在失败时回退 Worker；proxy 可强制所有分片走应用域名。</p></div></article>
              <article><span>04</span><div><strong>开启 HTTP/3</strong><p>Cloudflare 所有套餐可用，QUIC 在高丢包网络上通常比 TCP 更稳定。</p></div></article>
            </div>
          </section>

          <section className="admin-section">
            <div className="settings-section-title">
              <Pulse /><div><h2>最近审计事件</h2><p>记录关键账号、文件、分享与系统操作。</p></div>
            </div>
            <div className="audit-list">
              {overview.audit.map((event) => (
                <div key={event.id}>
                  <span className="audit-dot" />
                  <div><strong>{event.action}</strong><small>{event.actor_email || "system"} · {event.target_type}</small></div>
                  <time>{new Date(event.created_at).toLocaleString("zh-CN")}</time>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}

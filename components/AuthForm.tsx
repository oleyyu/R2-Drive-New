"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { ArrowRight, CircleNotch, LockKey, ShieldCheck } from "@phosphor-icons/react";

type AuthFormProps = {
  mode: "login" | "register";
};

type ApiError = { error?: { message?: string } };

type PublicConfig = {
  registrationMode: "open" | "invite" | "closed";
  firstOwnerPending: boolean;
  canRegister: boolean;
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [registration, setRegistration] = useState<PublicConfig>({
    registrationMode: "open",
    firstOwnerPending: false,
    canRegister: true,
  });

  useEffect(() => {
    fetch("/api/config")
      .then((response) => {
        if (!response.ok) throw new Error("无法读取账号状态。");
        return response.json() as Promise<PublicConfig>;
      })
      .then((config) => {
        setRegistration(config);
        if (mode === "login" && config.firstOwnerPending) {
          router.replace("/register");
        }
      })
      .catch(() => {
        // Keep the form usable. The auth API remains the final authority.
      })
      .finally(() => setConfigLoading(false));
  }, [mode, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    if (mode === "register" && password !== String(form.get("confirmPassword") || "")) {
      setError("两次输入的密码不一致，请重新确认。");
      return;
    }
    setLoading(true);
    const payload =
      mode === "register"
        ? {
            displayName: String(form.get("displayName") || ""),
            email: String(form.get("email") || ""),
            password,
            inviteCode: String(form.get("inviteCode") || "") || undefined,
          }
        : {
            email: String(form.get("email") || ""),
            password,
          };
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as ApiError;
      if (!response.ok) throw new Error(data.error?.message || "操作失败，请稍后重试。");
      window.location.assign("/drive");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  const registering = mode === "register";
  const creatingFirstOwner = registering && registration.firstOwnerPending;
  const registrationClosed =
    registering && !configLoading && !registration.canRegister;
  return (
    <div className="auth-page">
      <Link href="/" className="brand auth-brand">
        <span className="brand-mark">R2</span>
        <span>R2 Drive</span>
      </Link>
      <div className="auth-layout">
        <aside className="auth-context">
          <p className="eyebrow">SELF-HOSTED STORAGE</p>
          <h1>{registering ? "建立属于你的存储边界。" : "欢迎回来。"}</h1>
          <p>
            {registering
              ? creatingFirstOwner
                ? "这是第一次打开。请自己设置登录邮箱和密码，这个账号会自动成为唯一的主人账号。"
                : "使用此网盘管理员允许的方式创建账号。"
              : "登录后管理文件、分享、个人偏好与开发者令牌。"}
          </p>
          <div className="auth-security-note">
            <ShieldCheck weight="fill" />
            <span>密码只保存加密后的校验值，安装助手和项目作者都看不到明文。</span>
          </div>
        </aside>
        <section className="auth-panel">
          <div className="auth-panel-heading">
            <LockKey />
            <div>
              <h2>{creatingFirstOwner ? "创建主人账号" : registering ? "创建账号" : "登录 R2 Drive"}</h2>
              <p>
                {creatingFirstOwner
                  ? "邮箱和密码都由你自己设置"
                  : registering
                    ? "密码至少 12 位"
                    : "使用你第一次打开时创建的账号"}
              </p>
            </div>
          </div>
          <form onSubmit={submit} className="form-stack">
            {registering && (
              <label>
                <span>显示名称</span>
                <input name="displayName" autoComplete="name" required maxLength={80} placeholder="例如：王小明" />
              </label>
            )}
            <label>
              <span>{creatingFirstOwner ? "登录邮箱（自己填写）" : "邮箱"}</span>
              <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
              {creatingFirstOwner && (
                <small>这里只把邮箱当作登录名，不会发送验证码。</small>
              )}
            </label>
            {registering && !creatingFirstOwner && registration.registrationMode === "invite" && (
              <label>
                <span>邀请码</span>
                <input name="inviteCode" required minLength={16} placeholder="invite_…" />
              </label>
            )}
            <label>
              <span>密码</span>
              <input
                name="password"
                type="password"
                autoComplete={registering ? "new-password" : "current-password"}
                required
                minLength={registering ? 12 : 1}
                placeholder={registering ? "至少 12 位" : "输入密码"}
              />
            </label>
            {registering && (
              <label>
                <span>再次输入密码</span>
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  placeholder="再输入一次，防止输错"
                />
              </label>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            {registrationClosed && (
              <p className="form-error" role="alert">主人账号已经创建，此私人网盘不再接受新账号。</p>
            )}
            <button
              className="button button-primary button-block"
              disabled={loading || (registering && configLoading) || registrationClosed}
            >
              {loading || (registering && configLoading)
                ? <CircleNotch className="spin" />
                : <>{creatingFirstOwner ? "创建主人账号并进入" : registering ? "创建并进入" : "登录"} <ArrowRight /></>}
            </button>
          </form>
          <p className="auth-switch">
            {registering ? "已有账号？" : "还没有账号？"}{" "}
            <Link href={registering ? "/login" : "/register"}>
              {registering ? "去登录" : "创建账号"}
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}

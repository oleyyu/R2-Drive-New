"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import {
  ArrowsClockwise,
  ClockCounterClockwise,
  FolderOpen,
  Gear,
  HardDrives,
  ShareNetwork,
  SignOut,
  SlidersHorizontal,
  Trash,
  User,
} from "@phosphor-icons/react";

export type ShellUser = {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  storageQuota: number;
  storageUsed: number;
  preferences: Record<string, unknown>;
};

export function applyPreferences(preferences: Record<string, unknown>) {
  const root = document.documentElement;
  const theme = String(preferences.theme || "system");
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  root.dataset.density = String(preferences.density || "comfortable");
  localStorage.setItem(
    "r2drive-upload-concurrency",
    String(preferences.uploadConcurrency || 3),
  );
  localStorage.setItem("r2drive-default-view", String(preferences.defaultView || "list"));
  localStorage.setItem("r2drive-network-profile", String(preferences.networkProfile || "balanced"));
}

type AppShellProps = {
  children: ReactNode | ((user: ShellUser) => ReactNode);
  title: string;
  detail?: string;
  actions?: ReactNode;
  activeNav?: "files" | "recent" | "shares" | "trash" | "settings" | "admin";
  hideHeader?: boolean;
  contentClassName?: string;
  showStorageMeter?: boolean;
};

function formatBytes(value: number): string {
  if (value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ${units[index]}`;
}

export function AppShell({
  children,
  title,
  detail,
  actions,
  activeNav,
  hideHeader = false,
  contentClassName = "",
  showStorageMeter = true,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<ShellUser | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me")
      .then(async (response) => {
        if (response.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return null;
        }
        if (!response.ok) throw new Error("account");
        const data = (await response.json()) as { user: ShellUser | null };
        if (!data.user) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return null;
        }
        return data.user;
      })
      .then((sessionUser) => {
        if (active && sessionUser) {
          setUser(sessionUser);
          applyPreferences(sessionUser.preferences || {});
        }
      })
      .catch(() => active && setFailed(true));
    return () => { active = false; };
  }, [pathname, router]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  if (failed) {
    return (
      <main className="state-page">
        <h1>无法连接到实例</h1>
        <p>请检查 D1 与 Worker 绑定，然后刷新页面。</p>
        <button className="button button-primary" onClick={() => location.reload()}><ArrowsClockwise /> 重试</button>
      </main>
    );
  }

  if (!user) {
    return <main className="state-page"><ArrowsClockwise className="spin state-spinner" /><p>正在验证会话…</p></main>;
  }

  const usedPercent = user.storageQuota > 0
    ? Math.min((user.storageUsed / user.storageQuota) * 100, 100)
    : 0;

  const navigation = [
    { key: "files", href: "/drive", label: "文件", icon: FolderOpen },
    { key: "recent", href: "/drive?scope=recent", label: "最近", icon: ClockCounterClockwise },
    { key: "shares", href: "/drive?scope=shared", label: "分享", icon: ShareNetwork },
    { key: "trash", href: "/drive?scope=trash", label: "回收站", icon: Trash },
    { key: "settings", href: "/settings", label: "设置", icon: Gear },
    ...(user.role === "admin"
      ? [{ key: "admin", href: "/admin", label: "管理", icon: SlidersHorizontal }]
      : []),
  ];

  return (
    <div className="app-frame">
      <a className="skip-link" href="#app-main">跳至内容</a>
      <aside className="app-sidebar">
        <Link href="/drive" className="brand">
          <span className="brand-mark">R2</span>
          <span>R2 Drive</span>
        </Link>
        <nav className="sidebar-nav" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            const isActive = activeNav
              ? activeNav === item.key
              : pathname === item.href;
            return (
              <Link key={item.href} href={item.href} className={isActive ? "active" : ""}>
                <Icon weight={isActive ? "fill" : "regular"} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        {showStorageMeter && <div className="storage-meter">
          <div><span><HardDrives /> 存储空间</span><strong>{usedPercent.toFixed(0)}%</strong></div>
          <div className="meter-track"><i style={{ width: `${usedPercent}%` }} /></div>
          <p>{formatBytes(user.storageUsed)} / {formatBytes(user.storageQuota)}</p>
        </div>}
        <div className="sidebar-account">
          <div className="avatar"><User weight="fill" /></div>
          <div><strong>{user.displayName}</strong><span>{user.role === "admin" ? "管理员" : user.email}</span></div>
          <button onClick={logout} aria-label="退出登录" title="退出登录"><SignOut /></button>
        </div>
      </aside>
      <main className="app-main" id="app-main">
        {!hideHeader && <header className="app-header">
          <div><h1>{title}</h1>{detail && <p>{detail}</p>}</div>
          {actions && <div className="app-header-actions">{actions}</div>}
        </header>}
        <div className={`app-content ${contentClassName}`.trim()}>
          {typeof children === "function" ? children(user) : children}
        </div>
      </main>
    </div>
  );
}

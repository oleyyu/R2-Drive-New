import { ensureDatabase } from "@/db/runtime";
import { appConfig } from "@/lib/config";
import { sha256, secureToken } from "@/lib/crypto";
import { HttpError, parseCookies } from "@/lib/http";

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  status: "active" | "suspended";
  storageQuota: number;
  storageUsed: number;
  preferences: Record<string, unknown>;
  authType: "session" | "token";
  tokenScopes: string[];
};

type SessionRow = {
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "user";
  status: "active" | "suspended";
  storage_quota: number;
  storage_used: number;
  preferences: string;
};

const SESSION_COOKIE = "r2drive_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

function sessionCookieSecurity(request: Request): string {
  const url = new URL(request.url);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  return url.protocol === "https:" || !localHttp ? "; Secure" : "";
}

export async function createSession(userId: string, request: Request): Promise<string> {
  const token = secureToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
  const db = await ensureDatabase();
  await db
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, expires_at, created_at, last_seen_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256(token),
      userId,
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
      request.headers.get("user-agent")?.slice(0, 400) ?? null,
    )
    .run();
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly${sessionCookieSecurity(request)}; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie(request: Request): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly${sessionCookieSecurity(request)}; SameSite=Lax; Max-Age=0`;
}

export async function destroySession(request: Request): Promise<void> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return;
  const db = await ensureDatabase();
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const bearer = request.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    return getApiTokenUser(bearer.slice(7));
  }

  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const db = await ensureDatabase();
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.storage_quota, u.storage_used, u.preferences
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256(token), new Date().toISOString())
    .first<SessionRow>();
  if (!row || row.status !== "active") return null;
  return rowToUser(row, "session");
}

async function getApiTokenUser(token: string): Promise<SessionUser | null> {
  if (!token.startsWith("r2d_")) return null;
  const db = await ensureDatabase();
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.storage_quota, u.storage_used, u.preferences,
              t.scopes
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    )
    .bind(await sha256(token), now)
    .first<SessionRow & { scopes: string }>();
  if (!row || row.status !== "active") return null;
  await db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?").bind(now, await sha256(token)).run();
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(row.scopes) as string[];
  } catch {
    scopes = [];
  }
  return rowToUser(row, "token", scopes);
}

export async function requireUser(request: Request, scope?: "files:read" | "files:write" | "shares:write"): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (!user) throw new HttpError(401, "请先登录。", "unauthorized");
  if (scope && user.authType === "token" && !user.tokenScopes.includes(scope)) {
    throw new HttpError(403, `API 令牌缺少 ${scope} 权限。`, "insufficient_scope");
  }
  return user;
}

export async function requireAdmin(request: Request): Promise<SessionUser> {
  const user = await requireUser(request);
  if (user.authType !== "session") {
    throw new HttpError(403, "管理操作只能使用浏览器会话。", "session_required");
  }
  if (user.role !== "admin") throw new HttpError(403, "需要管理员权限。", "forbidden");
  return user;
}

export async function requireSessionUser(request: Request): Promise<SessionUser> {
  const user = await requireUser(request);
  if (user.authType !== "session") {
    throw new HttpError(403, "账号设置只能使用浏览器会话。", "session_required");
  }
  return user;
}

export async function registrationMode(): Promise<"open" | "invite" | "closed"> {
  const db = await ensureDatabase();
  const stored = await db
    .prepare("SELECT value FROM system_settings WHERE key = 'registration_mode'")
    .first<{ value: string }>();
  if (stored?.value === "closed" || stored?.value === "invite") return stored.value;
  return appConfig().registrationMode;
}

export async function registrationStatus(): Promise<{
  mode: "open" | "invite" | "closed";
  firstOwnerPending: boolean;
  canRegister: boolean;
}> {
  const db = await ensureDatabase();
  const [mode, existingUser] = await Promise.all([
    registrationMode(),
    db.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>(),
  ]);
  const firstOwnerPending = !existingUser;
  return {
    mode,
    firstOwnerPending,
    canRegister: firstOwnerPending || mode !== "closed",
  };
}

function rowToUser(
  row: SessionRow,
  authType: "session" | "token",
  tokenScopes: string[] = [],
): SessionUser {
  let preferences: Record<string, unknown> = {};
  try {
    preferences = JSON.parse(row.preferences) as Record<string, unknown>;
  } catch {
    preferences = {};
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    storageQuota: row.storage_quota,
    storageUsed: row.storage_used,
    preferences,
    authType,
    tokenScopes,
  };
}

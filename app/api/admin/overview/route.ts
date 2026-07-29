import { ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { appConfig, directR2Configured } from "@/lib/config";
import { apiError, json } from "@/lib/http";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const db = await ensureDatabase();
    const [users, storage, files, activeUploads, settings, auditResult] = await db.batch([
      db.prepare("SELECT COUNT(*) AS value FROM users"),
      db.prepare("SELECT COALESCE(SUM(storage_used), 0) AS value FROM users"),
      db.prepare("SELECT COUNT(*) AS value FROM files WHERE kind = 'file' AND status = 'ready'"),
      db.prepare("SELECT COUNT(*) AS value FROM multipart_uploads WHERE expires_at > ?").bind(new Date().toISOString()),
      db.prepare("SELECT key, value FROM system_settings"),
      db.prepare(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.created_at,
                u.email AS actor_email
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT 30`,
      ),
    ]);
    const userResult = await db
      .prepare(
        `SELECT id, email, display_name, role, status, storage_quota, storage_used, created_at
         FROM users ORDER BY created_at DESC LIMIT 100`,
      )
      .all<{
        id: string;
        email: string;
        display_name: string;
        role: "admin" | "user";
        status: "active" | "suspended";
        storage_quota: number;
        storage_used: number;
        created_at: string;
      }>();
    const settingMap = Object.fromEntries(
      (settings.results as Array<{ key: string; value: string }>).map((setting) => [setting.key, setting.value]),
    );
    const config = appConfig();
    return json({
      metrics: {
        users: Number((users.results[0] as { value?: number })?.value ?? 0),
        storage: Number((storage.results[0] as { value?: number })?.value ?? 0),
        files: Number((files.results[0] as { value?: number })?.value ?? 0),
        activeUploads: Number((activeUploads.results[0] as { value?: number })?.value ?? 0),
      },
      runtime: {
        directUpload: config.uploadMode !== "proxy" && directR2Configured(),
        uploadMode: config.uploadMode,
        downloadMode: config.downloadMode,
        maxFileSizeBytes: config.maxFileSizeBytes,
        r2AccountConfigured: Boolean(config.accountId),
        sharingEnabled: config.sharingEnabled,
        publicHostname: config.publicHostname,
      },
      settings: {
        registrationMode: settingMap.registration_mode ?? config.registrationMode,
        defaultUserQuotaBytes: Number(settingMap.default_user_quota_bytes ?? config.defaultQuotaBytes),
        siteName: settingMap.site_name ?? config.appName,
      },
      users: userResult.results.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        status: user.status,
        storageQuota: user.storage_quota,
        storageUsed: user.storage_used,
        createdAt: user.created_at,
      })),
      audit: (auditResult.results as Array<Record<string, unknown>>).map((event) => ({
        ...event,
        metadata: JSON.parse(String(event.metadata || "{}")) as Record<string, unknown>,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

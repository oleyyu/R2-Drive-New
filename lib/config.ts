import { env } from "cloudflare:workers";
import { publicShareOriginInfo } from "@/lib/public-sharing";

export const MAX_R2_OBJECT_BYTES = 5_492_064_911_360;
export const MIN_R2_PART_BYTES = 5 * 1024 * 1024;
export const MAX_R2_PART_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_R2_PARTS = 10_000;

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function appConfig() {
  const registrationMode = String(env.REGISTRATION_MODE);
  const downloadMode = String(env.DOWNLOAD_MODE);
  const uploadMode = String(env.UPLOAD_MODE);
  const appOrigin = env.APP_ORIGIN?.trim() || "http://localhost:3000";
  const shareOrigin = publicShareOriginInfo(appOrigin);
  return {
    appName: env.APP_NAME?.trim() || "R2 Drive",
    appOrigin,
    sharingEnabled: shareOrigin.enabled,
    publicHostname: shareOrigin.hostname,
    publicShareOrigin: shareOrigin.origin,
    registrationMode: registrationMode === "closed" || registrationMode === "invite"
      ? registrationMode
      : "open",
    defaultQuotaBytes: numberFromEnv(env.DEFAULT_USER_QUOTA_BYTES, 10_000_000_000),
    maxFileSizeBytes: Math.min(
      numberFromEnv(env.MAX_FILE_SIZE_BYTES, MAX_R2_OBJECT_BYTES),
      MAX_R2_OBJECT_BYTES,
    ),
    preferredPartSizeBytes: Math.min(
      Math.max(numberFromEnv(env.UPLOAD_PART_SIZE_BYTES, 64 * 1024 ** 2), MIN_R2_PART_BYTES),
      MAX_R2_PART_BYTES,
    ),
    uploadUrlTtlSeconds: Math.min(
      numberFromEnv(env.UPLOAD_URL_TTL_SECONDS, 900),
      604_800,
    ),
    publicShareCacheSeconds: Math.min(
      numberFromEnv(env.PUBLIC_SHARE_CACHE_SECONDS, 0),
      31 * 24 * 60 * 60,
    ),
    uploadMode: uploadMode === "proxy" || uploadMode === "direct" ? uploadMode : "auto",
    downloadMode: downloadMode === "direct" ? "direct" : "proxy",
    bucketName: env.R2_BUCKET_NAME?.trim() || "",
    accountId: env.R2_ACCOUNT_ID?.trim() || "",
    bootstrapAdminEmails: new Set(
      (env.BOOTSTRAP_ADMIN_EMAILS || "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  } as const;
}

export function directR2Configured(): boolean {
  const config = appConfig();
  return Boolean(
    config.accountId &&
      config.bucketName &&
      env.R2_ACCESS_KEY_ID?.trim() &&
      env.R2_SECRET_ACCESS_KEY?.trim(),
  );
}

export function calculatePartSize(fileSize: number, preferredOverride?: number): number {
  const preferred = preferredOverride
    ? Math.min(Math.max(preferredOverride, MIN_R2_PART_BYTES), MAX_R2_PART_BYTES)
    : appConfig().preferredPartSizeBytes;
  const minimumForPartCount = Math.ceil(fileSize / MAX_R2_PARTS);
  const oneMiB = 1024 * 1024;
  const rounded = Math.ceil(Math.max(preferred, minimumForPartCount) / oneMiB) * oneMiB;
  return Math.min(Math.max(rounded, MIN_R2_PART_BYTES), MAX_R2_PART_BYTES);
}

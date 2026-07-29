export const SHARING_DISABLED_MESSAGE =
  "分享尚未开启。请先在管理页面绑定自己的域名并完成发布。";

const NON_CUSTOM_DOMAIN_SUFFIXES = [
  ".workers.dev",
  ".pages.dev",
  ".trycloudflare.com",
  ".r2.dev",
];

export function publicShareOriginInfo(value: string): {
  enabled: boolean;
  hostname: string;
  origin: string;
} {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const isIpAddress =
      hostname.includes(":") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
    const isLocal =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      isIpAddress;
    const isTemporaryDomain = NON_CUSTOM_DOMAIN_SUFFIXES.some(
      (suffix) => hostname.endsWith(suffix),
    );
    const enabled =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      hostname.includes(".") &&
      !isLocal &&
      !isTemporaryDomain;
    return {
      enabled,
      hostname: enabled ? hostname : "",
      origin: enabled ? url.origin : "",
    };
  } catch {
    return { enabled: false, hostname: "", origin: "" };
  }
}

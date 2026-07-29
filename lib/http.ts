export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "request_error",
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function apiError(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { message: error.message, code: error.code } }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ message: "api request failed", error: message }));
  return json(
    { error: { message: "服务器暂时无法处理请求。", code: "internal_error" } },
    { status: 500 },
  );
}

export function assertSameOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.get("authorization")?.startsWith("Bearer r2d_")) return;
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, "请求来源校验失败。", "invalid_origin");
  }
}

export function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (request.headers.get("cookie") || "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    cookies.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim()));
  }
  return cookies;
}

export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new HttpError(400, "文件名无效。", "invalid_name");
  }
  return cleaned.slice(0, 255);
}

export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

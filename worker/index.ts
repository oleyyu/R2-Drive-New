/** Cloudflare Worker entry point for R2 Drive. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

const PRIMARY_WORKER_PROTOCOL = "r2drive-primary-worker-v1";
const PRIMARY_WORKER_IDENTITY_PATH = "/.well-known/r2-drive/installation";
const INSTALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function primaryWorkerIdentity(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET", "cache-control": "no-store" },
    });
  }
  const installId = env.R2_DRIVE_INSTALL_ID;
  const secret = env.R2_DRIVE_INSTALL_SECRET;
  const challenge = url.searchParams.get("challenge") ?? "";
  if (
    !installId ||
    !secret ||
    !INSTALL_ID_PATTERN.test(installId) ||
    !IDENTITY_TOKEN_PATTERN.test(secret)
  ) {
    return Response.json(
      { ok: false, code: "identity_not_configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  if (!IDENTITY_TOKEN_PATTERN.test(challenge)) {
    return Response.json(
      { ok: false, code: "invalid_challenge" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `${PRIMARY_WORKER_PROTOCOL}\n${installId.toLowerCase()}\n${challenge}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Response.json(
    {
      ok: true,
      protocol: PRIMARY_WORKER_PROTOCOL,
      installId: installId.toLowerCase(),
      challenge,
      proof: base64Url(new Uint8Array(signature)),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

function secureResponse(response: Response, url: URL): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("x-frame-options", "DENY");
  secured.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  secured.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  secured.headers.set("cross-origin-opener-policy", "same-origin");
  if (url.protocol === "https:") {
    secured.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (secured.headers.get("content-type")?.includes("text/html")) {
      secured.headers.set(
        "content-security-policy",
        "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com",
      );
    }
  }
  return secured;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === PRIMARY_WORKER_IDENTITY_PATH) {
      return secureResponse(
        await primaryWorkerIdentity(request, env, url),
        url,
      );
    }
    const shareDownload =
      request.method === "GET" &&
      /^\/api\/public\/shares\/[^/]+\/download$/.test(url.pathname) &&
      Number(env.PUBLIC_SHARE_CACHE_SECONDS) > 0;
    const edgeCache = (caches as CacheStorage & { default: Cache }).default;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (shareDownload) {
      const cached = await edgeCache.match(request);
      if (cached) {
        const response = secureResponse(cached, url);
        response.headers.set("x-r2drive-cache", "HIT");
        return response;
      }
    }

    const response = await handler.fetch(request, env, ctx);
    const secured = secureResponse(response, url);
    if (
      shareDownload &&
      secured.status === 200 &&
      secured.headers.get("x-r2drive-cacheable") === "1"
    ) {
      secured.headers.delete("x-r2drive-cacheable");
      secured.headers.set("x-r2drive-cache", "MISS");
      ctx.waitUntil(edgeCache.put(request, secured.clone()));
    }
    return secured;
  },
};

export default worker satisfies ExportedHandler<Env>;

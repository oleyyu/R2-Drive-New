// Secret bindings are managed with `wrangler secret put` and are intentionally
// absent from wrangler.jsonc. This augments the generated Cloudflare.Env only
// for those secret values and for platform-injected asset bindings.
declare namespace Cloudflare {
  interface Env {
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    R2_DRIVE_INSTALL_ID?: string;
    R2_DRIVE_INSTALL_SECRET?: string;
    STORAGE_FEDERATION_PRIVATE_KEY?: string;
    NODE_ID?: string;
    CONTROL_PUBLIC_KEY_JWK?: string;
    ASSETS: Fetcher;
    IMAGES: {
      input(stream: ReadableStream): {
        transform(options: Record<string, unknown>): {
          output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
        };
      };
    };
  }
}

interface Env extends Cloudflare.Env {
  ASSETS: Fetcher;
  IMAGES: Cloudflare.Env["IMAGES"];
}

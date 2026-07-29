import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Run `npm run setup` or configure the DB binding in wrangler.jsonc."
    );
  }

  return drizzle(env.DB, { schema });
}

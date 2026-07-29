import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("local HTTP sessions omit Secure while deployed HTTPS sessions keep it", async () => {
  const source = await readFile(path.join(root, "lib", "auth.ts"), "utf8");
  assert.match(source, /url\.protocol === "http:"/);
  assert.match(source, /url\.hostname === "localhost"/);
  assert.match(source, /url\.hostname === "127\.0\.0\.1"/);
  assert.match(source, /url\.protocol === "https:" \|\| !localHttp \? "; Secure" : ""/);
  assert.match(source, /HttpOnly\$\{sessionCookieSecurity\(request\)\}/);
});

test("missing sessions return to login and successful auth performs a full navigation", async () => {
  const [meRoute, appShell, authForm, logoutRoute] = await Promise.all([
    readFile(path.join(root, "app", "api", "auth", "me", "route.ts"), "utf8"),
    readFile(path.join(root, "components", "AppShell.tsx"), "utf8"),
    readFile(path.join(root, "components", "AuthForm.tsx"), "utf8"),
    readFile(path.join(root, "app", "api", "auth", "logout", "route.ts"), "utf8"),
  ]);
  assert.match(meRoute, /json\(\{ user: null \}, \{ status: 401 \}\)/);
  assert.match(appShell, /if \(!data\.user\)/);
  assert.match(authForm, /window\.location\.assign\("\/drive"\)/);
  assert.match(logoutRoute, /clearSessionCookie\(request\)/);
});

test("password hashing stays within the Cloudflare Workers PBKDF2 limit", async () => {
  const source = await readFile(path.join(root, "lib", "crypto.ts"), "utf8");
  assert.match(source, /PASSWORD_ITERATIONS = 100_000/);
  assert.match(source, /MAX_WORKERS_PBKDF2_ITERATIONS = 100_000/);
  assert.match(source, /iterations > MAX_WORKERS_PBKDF2_ITERATIONS/);
  assert.doesNotMatch(source, /210_000/);
});

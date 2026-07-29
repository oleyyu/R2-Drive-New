import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("build emits a Worker entry and complete product routes", async () => {
  await access(new URL("dist/server/index.js", root));
  const [routes, deploymentSource] = await Promise.all([
    readFile(new URL("dist/server/index.js", root), "utf8"),
    readFile(new URL("dist/server/wrangler.json", root), "utf8"),
  ]);
  const deployment = JSON.parse(deploymentSource);
  assert.match(routes, /api\/uploads/);
  assert.match(routes, /api\/admin/);
  assert.match(routes, /api\/public\/shares/);
  assert.equal(
    deployment.d1_databases.filter((binding) => binding.binding === "DB").length,
    1,
  );
  assert.equal(
    deployment.r2_buckets.filter((binding) => binding.binding === "FILES").length,
    1,
  );
});

test("landing and product source contain the expected real surfaces", async () => {
  const [home, drive, admin, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("components/DriveClient.tsx", root), "utf8"),
    readFile(new URL("components/AdminClient.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  assert.match(home, /你的对象存储/);
  assert.match(home, /UploadPlanner/);
  assert.match(drive, /expectedParts/);
  assert.match(drive, /parts\/\$\{partNumber\}\/sign/);
  assert.match(drive, /new XMLHttpRequest\(\)/);
  assert.match(drive, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(drive, /uploadedBytes: file\.size/);
  assert.match(drive, /bytesPerSecond/);
  assert.match(drive, /公开分享尚未开启/);
  assert.match(admin, /个人网络优化清单/);
  assert.match(admin, /绑定域名/);
  assert.match(layout, /R2 Drive/);
  assert.doesNotMatch(home + layout, /SkeletonPreview|Your site is taking shape/);
});

test("ships the generated Open Graph card at the declared dimensions", async () => {
  const image = await stat(new URL("public/og.png", root));
  assert.ok(image.size > 20_000);
  const layout = await readFile(new URL("app/layout.tsx", root), "utf8");
  assert.match(layout, /width:\s*1200/);
  assert.match(layout, /height:\s*630/);
});

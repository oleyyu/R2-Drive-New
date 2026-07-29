import packageMetadata from "@/package.json";

export const CURRENT_VERSION = packageMetadata.version;
export const UPDATE_REPOSITORY = "oleyyu/R2-Drive-New";
const UPDATE_RELEASE_API_URL =
  `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const MAX_RELEASE_JSON_BYTES = 512 * 1024;

type ParsedVersion = {
  text: string;
  numbers: [number, number, number];
  prerelease: string;
};

export type UpdateInformation = {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  releaseName: string;
  releaseUrl: string;
  publishedAt: string;
};

export function normalizeVersion(value: unknown): ParsedVersion | null {
  const match = String(value || "")
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  const numbers: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const prerelease = match[4] || "";
  return {
    text: `${numbers.join(".")}${prerelease ? `-${prerelease}` : ""}`,
    numbers,
    prerelease,
  };
}

export function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) throw new Error("版本号格式无效。");
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return a.numbers[index] > b.numbers[index] ? 1 : -1;
    }
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", {
    numeric: true,
    sensitivity: "base",
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_RELEASE_JSON_BYTES) {
    throw new Error("GitHub 更新信息异常，已停止处理。");
  }
  if (!response.body) throw new Error("GitHub 更新信息为空。");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RELEASE_JSON_BYTES) {
      await reader.cancel();
      throw new Error("GitHub 更新信息过大，已停止处理。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function releaseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub 最新 Release 信息格式无效。");
  }
  return value as Record<string, unknown>;
}

function trustedReleaseUrl(value: unknown): string {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("GitHub 返回了不受信任的 Release 地址。");
  }
  return url.toString();
}

export async function checkLatestRelease(): Promise<UpdateInformation> {
  const response = await fetch(UPDATE_RELEASE_API_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "R2-Drive-Worker",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub 暂时无法检查更新（HTTP ${response.status}）。`);
  }
  const release = releaseRecord(await readBoundedJson(response));
  const latest = normalizeVersion(release.tag_name);
  if (!latest) throw new Error("GitHub 最新 Release 版本号无效。");
  return {
    currentVersion: CURRENT_VERSION,
    latestVersion: latest.text,
    available: compareVersions(latest.text, CURRENT_VERSION) > 0,
    releaseName:
      typeof release.name === "string" && release.name.trim()
        ? release.name.trim().slice(0, 120)
        : `R2 Drive v${latest.text}`,
    releaseUrl: trustedReleaseUrl(release.html_url),
    publishedAt:
      typeof release.published_at === "string" ? release.published_at : "",
  };
}

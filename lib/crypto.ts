const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 100_000;
const MAX_WORKERS_PBKDF2_ITERATIONS = 100_000;

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

export function secureToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2-sha256:${PASSWORD_ITERATIONS}:${bytesToBase64(salt)}:${bytesToBase64(new Uint8Array(derived))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, iterationsValue, saltValue, hashValue] = stored.split(":");
  const iterations = Number(iterationsValue);
  if (
    algorithm !== "pbkdf2-sha256" ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_WORKERS_PBKDF2_ITERATIONS ||
    !saltValue ||
    !hashValue
  ) {
    return false;
  }
  const expected = base64ToBytes(hashValue);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(base64ToBytes(saltValue)), iterations },
      key,
      expected.byteLength * 8,
    ),
  );
  if (derived.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < derived.byteLength; index += 1) {
    difference |= derived[index] ^ expected[index];
  }
  return difference === 0;
}

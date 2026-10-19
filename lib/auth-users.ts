import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_PARAMS = { n: 16384, r: 8, p: 1, keylen: 64 };

export type UserRecord = { email: string; password: string; name: string };

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

export function hashAuthPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.n,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  }).toString("hex");
  return `${SCRYPT_PREFIX}$${SCRYPT_PARAMS.n}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith(`${SCRYPT_PREFIX}$`)) {
    const parts = stored.split("$");
    if (parts.length !== 6) return false;
    const [, nText, rText, pText, salt, expected] = parts;
    const n = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (!salt || !expected || !Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
      return false;
    }
    const derived = scryptSync(password, salt, expected.length / 2, { N: n, r, p }).toString("hex");
    return timingSafeStringEqual(derived, expected);
  }

  // Temporary fallback for legacy envs that have not been migrated yet.
  return timingSafeStringEqual(password, stored);
}

export function loadUsers(): UserRecord[] {
  const raw = process.env.AUTH_USERS;
  if (!raw) return [];
  return raw
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [email, password, name] = entry.split(":");
      return {
        email: (email ?? "").trim().toLowerCase(),
        password: (password ?? "").trim(),
        name: (name ?? email ?? "").trim(),
      };
    });
}

export function findUser(email: string, password: string): UserRecord | null {
  const target = email.trim().toLowerCase();
  const match = loadUsers().find((u) => u.email === target && verifyPassword(password, u.password));
  return match ?? null;
}

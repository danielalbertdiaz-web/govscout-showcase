import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "gs_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 14;
const JWT_ISSUER = "govscout-v5";
const JWT_AUDIENCE = "govscout-session";

export function resolveJwtSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET ?? process.env.AUTH_SECRET;
  if (!raw) throw new Error("JWT_SECRET (or AUTH_SECRET) not set");
  return new TextEncoder().encode(raw);
}

export type SessionPayload = {
  sub: string;
  email: string;
  name?: string;
};

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_MAX_AGE}s`)
    .sign(resolveJwtSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, resolveJwtSecret(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ""),
      name: payload.name ? String(payload.name) : undefined,
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export const SESSION_COOKIE = COOKIE_NAME;

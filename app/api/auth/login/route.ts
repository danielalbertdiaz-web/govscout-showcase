import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { findUser } from "@/lib/auth-users";

export const runtime = "nodejs";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();

function getRateLimitKey(req: NextRequest, email: string): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || "unknown";
  return `${email.toLowerCase()}|${ip}`;
}

function getRateLimitState(key: string, now: number) {
  const current = attempts.get(key);
  if (!current || now - current.windowStartedAt > WINDOW_MS) {
    const fresh = { count: 0, windowStartedAt: now, blockedUntil: 0 };
    attempts.set(key, fresh);
    return fresh;
  }
  return current;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = String(body?.email ?? "").trim();
  const password = String(body?.password ?? "");
  if (!email || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const now = Date.now();
  const rateKey = getRateLimitKey(req, email);
  const rateState = getRateLimitState(rateKey, now);
  if (rateState.blockedUntil > now) {
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  }

  const user = findUser(email, password);
  if (!user) {
    rateState.count += 1;
    if (rateState.count >= MAX_ATTEMPTS) {
      rateState.blockedUntil = now + BLOCK_MS;
    }
    attempts.set(rateKey, rateState);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  attempts.delete(rateKey);
  const token = await createSessionToken({ sub: user.email, email: user.email, name: user.name });
  await setSessionCookie(token);
  return NextResponse.json({ ok: true, user: { email: user.email, name: user.name } });
}

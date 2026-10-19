import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";

// /assets is public brand art (the login hero renders BEFORE auth) — without
// it the middleware redirects the <img> request itself to /login (broken image).
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/health", "/_next", "/favicon.ico", "/assets"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  // Watcher observability ingest authenticates with a shared secret, not a
  // session (crons carry no cookie). The middleware blocked these BEFORE the
  // route's secret check could run, so the endpoint 401'd even with the
  // secret configured — found 2026-08-13 wiring WATCHER_INGEST_SECRET. Pass
  // through only when the header is PRESENT; the route compares the value
  // and still 401s a wrong secret, so this loosens nothing else.
  if (pathname === "/api/activity/watcher-event" && req.headers.get("x-watcher-secret")) {
    return NextResponse.next();
  }

  // Same failure mode, same fix (2026-08-26, pools-refresh cron): /api/cron/*
  // authenticates with `Authorization: Bearer $CRON_SECRET` inside the route,
  // but the middleware 401'd it BEFORE that check could run. Pass through only
  // when an Authorization header is PRESENT — each route still compares the
  // value and 401s a wrong secret, so this loosens nothing else.
  if (pathname.startsWith("/api/cron/") && req.headers.get("authorization")) {
    return NextResponse.next();
  }

  const token = req.cookies.get("gs_session")?.value;
  const valid = token ? (await verifySessionToken(token)) !== null : false;

  if (!valid) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

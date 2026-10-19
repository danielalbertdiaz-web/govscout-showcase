// P7 — GET /api/calendar/ics: an iCalendar feed of every funding deadline
// (saved-opportunity deadlines + pool period-end dates). Google Calendar (or
// Apple/Outlook) subscribes to this URL and deadlines sync automatically.
//
// Auth: calendar clients can't send session cookies, so the feed accepts
// ?key=<CALENDAR_FEED_KEY> (a private random string in .env.local). A logged-in
// session also works for in-browser testing. No key configured → 503.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listSavedOpportunities, listPools } from "@/lib/db";
import { loadUsers } from "@/lib/auth-users";

export const runtime = "nodejs";

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const configuredKey = process.env.CALENDAR_FEED_KEY?.trim();
  const givenKey = req.nextUrl.searchParams.get("key")?.trim();
  const session = await getSession();
  if (!session) {
    if (!configuredKey) return new Response("feed key not configured", { status: 503 });
    if (givenKey !== configuredKey) return new Response("forbidden", { status: 403 });
  }
  const owner = session?.email ?? loadUsers()[0]?.email;
  if (!owner) return new Response("no owner", { status: 400 });

  type Ev = { uid: string; date: number; title: string; description: string };
  const events: Ev[] = [];

  for (const o of listSavedOpportunities(owner, 500)) {
    if (!o.deadline) continue;
    const t = Date.parse(o.deadline);
    if (!Number.isFinite(t)) continue;
    events.push({
      uid: `opp-${o.id}@govscout`,
      date: t,
      title: `DUE: ${o.title.slice(0, 80)}`,
      description: `${o.agency ?? o.source} — GovScout opportunity deadline. ${o.url ?? ""}`,
    });
  }
  for (const p of listPools(owner)) {
    if (!p.deadlineDate) continue;
    const t = Date.parse(p.deadlineDate);
    if (!Number.isFinite(t)) continue;
    events.push({
      uid: `pool-${p.id}@govscout`,
      date: t,
      title: `POOL: ${p.name.slice(0, 80)}`,
      description: `${p.deadlineLabel ?? "Pool deadline"} — ${p.unspentAmount ?? ""}`,
    });
  }

  const now = new Date();
  const stamp = `${icsDate(now.getTime())}T000000Z`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GovScout//Funding Deadlines//EN",
    "X-WR-CALNAME:GovScout deadlines",
    "X-WR-CALDESC:Funding deadlines from GovScout (opportunities + pools)",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(e.date)}`,
      `SUMMARY:${icsEscape(e.title)}`,
      `DESCRIPTION:${icsEscape(e.description)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="govscout.ics"',
    },
  });
}

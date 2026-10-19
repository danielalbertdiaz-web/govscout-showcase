// Server-side aggregator for the B2 Calendar pane. Read-only — reads
// scout_items, funding_pools, nofos, drafts, and saved_opportunities for any
// rows with a deadline-shaped field, normalizes into a single list.

import { listAllItems } from "./scouts";
import {
  getNofo,
  getPool,
  listDrafts,
  listNofos,
  listPools,
  listSavedOpportunities,
} from "./db";

export type CalendarKind = "scout" | "pool" | "nofo" | "draft" | "opportunity";

export type CalendarEvent = {
  kind: CalendarKind;
  id: string;
  title: string;
  agency: string | null;
  // Free-form rendering. Always shown.
  dateText: string;
  // ms-since-epoch when we could parse the date. null when only free-form.
  dateMs: number | null;
  detailHref: string;
  url: string | null;
};

// Loose Date.parse — accepts ISO, "Aug 14, 2026", "2026-08-14", "12/31/2025".
// Returns null if the string doesn't yield a finite date.
function tryParse(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) return ms;
  // Pull the first YYYY-MM-DD or M/D/YYYY out of the string as a fallback.
  const isoMatch = trimmed.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const ms2 = Date.parse(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00Z`);
    if (Number.isFinite(ms2)) return ms2;
  }
  const usMatch = trimmed.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) {
    const ms3 = Date.parse(`${usMatch[3]}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}T00:00:00Z`);
    if (Number.isFinite(ms3)) return ms3;
  }
  return null;
}

export function listCalendarEvents(userEmail: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  // --- Scout items: deadlineText only ---
  for (const it of listAllItems(userEmail, { limit: 500 })) {
    if (!it.deadlineText) continue;
    events.push({
      kind: "scout",
      id: it.id,
      title: it.title,
      agency: it.agency,
      dateText: it.deadlineText,
      dateMs: tryParse(it.deadlineText),
      detailHref: `/scouts/${it.digestId}`,
      url: it.url,
    });
  }

  // --- Funding pools: deadlineDate + deadlineLabel ---
  for (const p of listPools(userEmail, { limit: 500 })) {
    if (!p.deadlineDate && !p.deadlineLabel) continue;
    events.push({
      kind: "pool",
      id: p.id,
      title: p.name,
      agency: p.agency,
      dateText: p.deadlineLabel ?? p.deadlineDate ?? "",
      dateMs: tryParse(p.deadlineDate) ?? tryParse(p.deadlineLabel),
      detailHref: `/pools/${p.id}`,
      url: null,
    });
  }

  // --- NOFOs: key_dates.{loi|full_proposal|award} ---
  for (const n of listNofos(userEmail, { limit: 500 })) {
    const kd = n.keyDates;
    if (!kd) continue;
    const title =
      [n.agency, n.program].filter(Boolean).join(" — ") ||
      n.originalFilename ||
      "NOFO";
    const candidates: { label: string; value: string | null | undefined }[] = [
      { label: "LOI due", value: kd.loi },
      { label: "Full proposal due", value: kd.full_proposal },
      { label: "Award", value: kd.award },
      { label: "Other", value: kd.other },
    ];
    for (const c of candidates) {
      if (!c.value) continue;
      events.push({
        kind: "nofo",
        id: n.id,
        title: `${title} — ${c.label}`,
        agency: n.agency,
        dateText: c.value,
        dateMs: tryParse(c.value),
        detailHref: `/nofos`,
        url: null,
      });
    }
  }

  // --- Saved opportunities: deadline string ---
  for (const o of listSavedOpportunities(userEmail, 500)) {
    if (!o.deadline) continue;
    events.push({
      kind: "opportunity",
      id: o.id,
      title: o.title,
      agency: o.agency,
      dateText: o.deadline,
      dateMs: tryParse(o.deadline),
      detailHref: `/opportunities/${o.id}`,
      url: o.url,
    });
  }

  // --- Drafts: pull deadline through linked NOFO/Pool ---
  for (const d of listDrafts(userEmail, 200)) {
    let dateText: string | null = null;
    let dateMs: number | null = null;
    if (d.nofoId) {
      const linkedNofo = getNofo(d.nofoId, userEmail);
      const due =
        linkedNofo?.keyDates?.full_proposal ??
        linkedNofo?.keyDates?.loi ??
        linkedNofo?.keyDates?.other ??
        null;
      if (due) {
        dateText = `via NOFO: ${due}`;
        dateMs = tryParse(due);
      }
    }
    if (!dateText && d.poolId) {
      const linkedPool = getPool(d.poolId, userEmail);
      if (linkedPool?.deadlineDate || linkedPool?.deadlineLabel) {
        dateText = `via Pool: ${linkedPool.deadlineLabel ?? linkedPool.deadlineDate ?? ""}`;
        dateMs = tryParse(linkedPool.deadlineDate) ?? tryParse(linkedPool.deadlineLabel);
      }
    }
    if (!dateText) continue;
    events.push({
      kind: "draft",
      id: d.id,
      title: d.title,
      agency: null,
      dateText,
      dateMs,
      detailHref: `/drafts/${d.id}`,
      url: null,
    });
  }

  // Sort: dated events ASC, undated last (alphabetical by title for stability).
  events.sort((a, b) => {
    if (a.dateMs != null && b.dateMs != null) return a.dateMs - b.dateMs;
    if (a.dateMs != null) return -1;
    if (b.dateMs != null) return 1;
    return a.title.localeCompare(b.title);
  });
  return events;
}

// Group key for the UI: "YYYY-MM-DD" of the Monday of the event's week, or
// "undated" when dateMs is null.
export function weekKey(dateMs: number | null): string {
  if (dateMs == null) return "undated";
  const d = new Date(dateMs);
  // Compute Monday of this week (ISO week start).
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1)));
  return monday.toISOString().slice(0, 10);
}

export function weekLabel(key: string): string {
  if (key === "undated") return "Undated";
  const start = new Date(key + "T00:00:00Z");
  const end = new Date(start.getTime() + 6 * 24 * 3600 * 1000);
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  return `${fmt(start)} – ${fmt(end)}`;
}

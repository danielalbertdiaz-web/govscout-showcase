/**
 * Federal Pipeline — SAM.gov amendment watcher. Cron-able one-shot, no daemon.
 *
 * For every fp_opportunity in an active status (submitted / qa_open /
 * triaged_bid / drafting / awaiting_approval) with source=sam, poll the SAM
 * Opportunities API v2 by solicitation number (fallback: notice id), detect
 * new notice versions / amendments / response-deadline changes, append
 * `amendment_posted` events, and print a JSON summary for Alfred to relay.
 *
 * Idempotent: previously-seen notice ids and deadlines are reconstructed from
 * the event trail, so re-runs against unchanged SAM data write nothing.
 * Rate-limit tolerant: exponential backoff on 429, generous timeouts (SAM is
 * slow).
 *
 * Run: npm run fp:watch            (requires SAM_API_KEY or SAM_GOV_API_KEY)
 *      npm run fp:watch -- --dry   (report changes, write no events)
 */

import {
  listFpOpportunities,
  listFpEvents,
  logFpEvent,
  upsertFpOpportunity,
  type FpOpportunity,
} from "../lib/federal-pipeline";
import type { FpStatus } from "../lib/federal-pipeline-types";

const SAM_SEARCH = "https://api.sam.gov/opportunities/v2/search";
const WATCH_STATUSES: FpStatus[] = [
  "submitted",
  "qa_open",
  "triaged_bid",
  "drafting",
  "awaiting_approval",
];
const TIMEOUT_MS = 45_000; // SAM is slow; be generous.
const BACKOFF_MS = [5_000, 15_000, 45_000];

const DRY_RUN = process.argv.includes("--dry");

type SamNotice = {
  noticeId: string;
  solicitationNumber: string | null;
  title: string | null;
  type: string | null;
  postedDate: string | null;
  responseDeadLine: string | null;
  uiLink: string | null;
};

function apiKey(): string | null {
  return process.env.SAM_API_KEY?.trim() || process.env.SAM_GOV_API_KEY?.trim() || null;
}

function fmtSamDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET with timeout + 429/5xx backoff. Throws on persistent failure. */
async function samFetch(url: string): Promise<unknown> {
  let lastErr = "";
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        lastErr = `timeout after ${TIMEOUT_MS}ms`;
        if (attempt < BACKOFF_MS.length) {
          await sleep(BACKOFF_MS[attempt]);
          continue;
        }
      } else {
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`SAM request failed after retries (${lastErr})`);
}

function parseNotices(body: unknown): SamNotice[] {
  const data = (body as { opportunitiesData?: unknown[] })?.opportunitiesData;
  if (!Array.isArray(data)) return [];
  const out: SamNotice[] = [];
  for (const raw of data) {
    const n = raw as Record<string, unknown>;
    if (typeof n.noticeId !== "string" || !n.noticeId) continue;
    out.push({
      noticeId: n.noticeId,
      solicitationNumber: typeof n.solicitationNumber === "string" ? n.solicitationNumber : null,
      title: typeof n.title === "string" ? n.title : null,
      type: typeof n.type === "string" ? n.type : null,
      postedDate: typeof n.postedDate === "string" ? n.postedDate : null,
      responseDeadLine: typeof n.responseDeadLine === "string" ? n.responseDeadLine : null,
      uiLink: typeof n.uiLink === "string" ? n.uiLink : null,
    });
  }
  return out;
}

async function querySam(opp: FpOpportunity, key: string): Promise<SamNotice[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 364 * 24 * 3600 * 1000); // API max window: 1 year
  const base = new URLSearchParams({
    api_key: key,
    postedFrom: fmtSamDate(from),
    postedTo: fmtSamDate(to),
    limit: "50",
  });
  if (opp.solNumber) {
    base.set("solnum", opp.solNumber);
  } else if (opp.noticeId) {
    base.set("noticeid", opp.noticeId);
  } else {
    return [];
  }
  return parseNotices(await samFetch(`${SAM_SEARCH}?${base.toString()}`));
}

/** Millisecond timestamp for deadline comparison; null when unparseable. */
function ts(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

type Change = {
  oppId: string;
  solNumber: string | null;
  title: string;
  kind: "new_notice_version" | "deadline_change";
  detail: Record<string, unknown>;
};

async function checkOpportunity(opp: FpOpportunity): Promise<{ changes: Change[]; polled: number }> {
  const key = apiKey()!;
  const notices = await querySam(opp, key);
  if (notices.length === 0) return { changes: [], polled: 0 };

  // Reconstruct what we already know from the audit trail (idempotency).
  const seenNoticeIds = new Set<string>(opp.noticeId ? [opp.noticeId] : []);
  let knownDeadlineTs = ts(opp.responseDeadline);
  for (const ev of listFpEvents(opp.id, 500)) {
    if (ev.kind !== "amendment_posted" || !ev.detail) continue;
    const ids = ev.detail.noticeIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") seenNoticeIds.add(id);
    const nd = ev.detail.newDeadline;
    if (typeof nd === "string" && ts(nd) != null) knownDeadlineTs = Math.max(knownDeadlineTs ?? 0, ts(nd)!) || ts(nd);
  }

  const changes: Change[] = [];

  const freshIds = notices.filter((n) => !seenNoticeIds.has(n.noticeId));
  if (freshIds.length > 0) {
    changes.push({
      oppId: opp.id,
      solNumber: opp.solNumber,
      title: opp.title,
      kind: "new_notice_version",
      detail: {
        noticeIds: freshIds.map((n) => n.noticeId),
        notices: freshIds.map((n) => ({
          noticeId: n.noticeId,
          type: n.type,
          postedDate: n.postedDate,
          responseDeadLine: n.responseDeadLine,
          title: n.title,
          uiLink: n.uiLink,
        })),
      },
    });
  }

  // Deadline: compare the latest deadline SAM reports against what we know.
  const samDeadlines = notices.map((n) => ts(n.responseDeadLine)).filter((t): t is number => t != null);
  if (samDeadlines.length > 0) {
    const latest = Math.max(...samDeadlines);
    const latestIso = notices.find((n) => ts(n.responseDeadLine) === latest)?.responseDeadLine ?? null;
    if (latestIso && latest !== knownDeadlineTs) {
      changes.push({
        oppId: opp.id,
        solNumber: opp.solNumber,
        title: opp.title,
        kind: "deadline_change",
        detail: {
          oldDeadline: opp.responseDeadline,
          newDeadline: latestIso,
          noticeIds: notices.map((n) => n.noticeId),
        },
      });
    }
  }

  if (!DRY_RUN) {
    for (const ch of changes) {
      logFpEvent(opp.id, "amendment_posted", { watch: ch.kind, ...ch.detail });
      if (ch.kind === "deadline_change" && typeof ch.detail.newDeadline === "string") {
        // Keep the row's deadline current so the Bid Board countdowns are live.
        upsertFpOpportunity({
          // The row being refreshed already knows whose panel it is on —
          // scoped dedupe (migration 043) then re-finds exactly that row.
          clientId: opp.clientId,
          noticeId: opp.noticeId ?? undefined,
          solNumber: opp.solNumber ?? undefined,
          title: opp.title,
          responseDeadline: ch.detail.newDeadline,
        });
      }
    }
  }

  return { changes, polled: notices.length };
}

async function main() {
  const key = apiKey();
  if (!key) {
    process.stderr.write(JSON.stringify({ ok: false, error: "SAM_API_KEY (or SAM_GOV_API_KEY) not set" }) + "\n");
    process.exit(1);
  }

  const targets = WATCH_STATUSES.flatMap((status) => listFpOpportunities({ status, source: "sam" })).filter(
    (o) => o.noticeId || o.solNumber,
  );

  const summary = {
    ok: true,
    dryRun: DRY_RUN,
    checkedAt: new Date().toISOString(),
    watched: targets.length,
    changes: [] as Change[],
    errors: [] as Array<{ oppId: string; solNumber: string | null; error: string }>,
  };

  for (const opp of targets) {
    try {
      const { changes } = await checkOpportunity(opp);
      summary.changes.push(...changes);
    } catch (e) {
      summary.errors.push({
        oppId: opp.id,
        solNumber: opp.solNumber,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    // Be polite between opportunities; SAM rate limits are per-key.
    await sleep(1_500);
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(summary.errors.length > 0 && summary.changes.length === 0 && summary.watched > 0 ? 2 : 0);
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n");
  process.exit(1);
});

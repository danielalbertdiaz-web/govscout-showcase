/**
 * Sprint 8 — Apify client.
 *
 * Single entry point: `runApifyActor({ actorId, input, label })` →
 *   resolves to { items, runId, computeUnits, costUsd, status }.
 *
 * Responsibilities:
 *   - Resolve token from env (APIFY_TOKEN). Reject cleanly if missing —
 *     callers should surface this as a 503 from the API route, NOT crash.
 *   - Use the synchronous run-sync-get-dataset-items endpoint so the HTTP
 *     handler doesn't have to poll or webhook. Apify caps these at ~5 min.
 *   - Exponential backoff on 429 (up to 3 retries: 1s, 2s, 4s).
 *   - Budget guard: enforces a per-run hard cap of $1.25 USD (one quarter of
 *     the free-tier ~$5/mo). The cap is enforced AFTER the run completes
 *     because Apify only reports compute usage at end-of-run; if a single
 *     actor invocation exceeds the cap, the run still finishes (we can't
 *     pre-cancel a sync request) but a budget-exceeded event is emitted and
 *     subsequent runs in the same batch can be skipped by the caller.
 *   - Detects Cloudflare/captcha output → returns `needsHumanReview: true`
 *     so the caller can surface it to the Suggestion Inbox.
 *
 * No new external integration beyond Apify itself per C7 — the brief
 * explicitly approves Apify as the Sprint 8 source. No webhooks, no
 * SDK; raw fetch only.
 */

import { tryLogActivity } from "./activity";

export const APIFY_BUDGET_PER_RUN_USD = 1.25;
export const APIFY_MAX_RETRIES = 3;
export const APIFY_BASE = "https://api.apify.com/v2";

export type ApifyRunOptions = {
  actorId: string;        // e.g. "apify/website-content-crawler"
  input: Record<string, unknown>;
  label: string;          // human-readable for activity log, e.g. "Foundation watcher (RWJF)"
  userEmail: string;
  timeoutMs?: number;     // override the default 300s sync cap
  signal?: AbortSignal;
};

export type ApifyRunResult<T = unknown> = {
  ok: boolean;
  status: "completed" | "failed" | "budget_exceeded" | "timeout" | "missing_token" | "rate_limited" | "needs_human_review";
  items: T[];
  runId: string | null;
  computeUnits: number;
  costUsd: number;
  durationMs: number;
  error: string | null;
  needsHumanReview: boolean;
};

function emptyResult<T>(status: ApifyRunResult["status"], error: string | null = null): ApifyRunResult<T> {
  return {
    ok: false,
    status,
    items: [] as T[],
    runId: null,
    computeUnits: 0,
    costUsd: 0,
    durationMs: 0,
    error,
    needsHumanReview: status === "needs_human_review",
  };
}

export function getApifyToken(): string | null {
  const t = process.env.APIFY_TOKEN?.trim();
  return t && t.length > 8 ? t : null;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

// Apify's sync endpoint returns the dataset directly as JSON array.
// On 429 we get back JSON { error: { type: "rate-limited", ... } }; we
// retry with exponential backoff. Other 4xx is fatal (bad input / bad
// actor). 5xx we retry once.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries: number,
  signal?: AbortSignal,
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: init.signal ?? signal });
      if (res.status === 429) {
        const waitMs = 1000 * Math.pow(2, attempt);
        if (attempt < retries) {
          await sleep(waitMs, signal);
          continue;
        }
        return res;
      }
      if (res.status >= 500 && res.status < 600 && attempt < retries) {
        await sleep(1500 * Math.pow(2, attempt), signal);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        await sleep(1000 * Math.pow(2, attempt), signal);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("unreachable");
}

// Sniff the dataset items for Cloudflare/captcha markers. If a non-trivial
// fraction of items contain these tokens, the actor likely got blocked
// and the operator should manually investigate. Used to fan out a
// Suggestion Inbox entry per failed source.
const BLOCK_MARKERS = [
  "cloudflare",
  "captcha",
  "attention required",
  "checking your browser",
  "just a moment",
  "request unsuccessful",
  "access denied",
  "verify you are human",
];

export function detectBlockedOutput(items: unknown[]): boolean {
  if (items.length === 0) return false;
  let blockedHits = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const text = JSON.stringify(item).toLowerCase();
    if (BLOCK_MARKERS.some((m) => text.includes(m))) {
      blockedHits += 1;
    }
  }
  // If more than half look blocked, treat the whole run as blocked.
  return blockedHits > 0 && blockedHits >= Math.ceil(items.length / 2);
}

// Pull the run metadata after a sync run to read compute usage + cost.
async function fetchRunMeta(token: string, runId: string, signal?: AbortSignal): Promise<{
  computeUnits: number;
  costUsd: number;
  status: string;
}> {
  try {
    const r = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${encodeURIComponent(token)}`, {
      signal,
    });
    if (!r.ok) return { computeUnits: 0, costUsd: 0, status: "unknown" };
    const json = (await r.json()) as {
      data?: {
        usage?: { COMPUTE_UNITS?: number };
        usageTotalUsd?: number;
        status?: string;
      };
    };
    const data = json.data ?? {};
    return {
      computeUnits: Number(data.usage?.COMPUTE_UNITS ?? 0),
      costUsd: Number(data.usageTotalUsd ?? 0),
      status: String(data.status ?? "unknown"),
    };
  } catch {
    return { computeUnits: 0, costUsd: 0, status: "unknown" };
  }
}

// Public — single sync run of an Apify actor. Returns the dataset items
// untyped; the per-source parsers shape them.
export async function runApifyActor<T = unknown>(opts: ApifyRunOptions): Promise<ApifyRunResult<T>> {
  const started = Date.now();
  const token = getApifyToken();
  if (!token) {
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_failed_run",
      targetType: "apify",
      targetId: opts.actorId,
      summary: `Apify run rejected — APIFY_TOKEN missing. Label="${opts.label}".`,
    });
    return emptyResult<T>("missing_token", "APIFY_TOKEN not set");
  }

  const timeoutMs = Math.max(10_000, Math.min(opts.timeoutMs ?? 300_000, 300_000));
  // Apify accepts the timeout in seconds via query param.
  const timeoutS = Math.floor(timeoutMs / 1000);
  // memory cap of 512 MB on free tier; well within $1.25/run for short
  // scrapes. memoryMbytes is just a hint for the actor scheduler.
  const url =
    `${APIFY_BASE}/acts/${encodeURIComponent(opts.actorId)}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}` +
    `&timeout=${timeoutS}` +
    `&memory=512`;

  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts.input),
      },
      APIFY_MAX_RETRIES,
      opts.signal,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_failed_run",
      targetType: "apify",
      targetId: opts.actorId,
      summary: `Apify network failure: ${msg}. Label="${opts.label}".`,
    });
    return { ...emptyResult<T>("failed", msg), durationMs: Date.now() - started };
  }

  if (res.status === 429) {
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_failed_run",
      targetType: "apify",
      targetId: opts.actorId,
      summary: `Apify rate-limited after ${APIFY_MAX_RETRIES} retries. Label="${opts.label}".`,
    });
    return { ...emptyResult<T>("rate_limited", `HTTP 429 after ${APIFY_MAX_RETRIES} retries`), durationMs: Date.now() - started };
  }
  if (res.status === 408 || res.status === 504) {
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_failed_run",
      targetType: "apify",
      targetId: opts.actorId,
      summary: `Apify timeout (HTTP ${res.status}). Label="${opts.label}".`,
    });
    return { ...emptyResult<T>("timeout", `HTTP ${res.status}`), durationMs: Date.now() - started };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_failed_run",
      targetType: "apify",
      targetId: opts.actorId,
      summary: `Apify HTTP ${res.status}: ${body.slice(0, 200)}. Label="${opts.label}".`,
    });
    return { ...emptyResult<T>("failed", `HTTP ${res.status}: ${body.slice(0, 200)}`), durationMs: Date.now() - started };
  }

  // The sync endpoint returns the dataset JSON array. Apify exposes the
  // runId in response header `X-Apify-Pagination-Run-Id` or similar; the
  // current API puts it in `x-apify-run-id`. Fall back to "unknown".
  const runId =
    res.headers.get("x-apify-run-id") ??
    res.headers.get("x-apify-pagination-run-id") ??
    null;

  let items: T[] = [];
  try {
    const parsed = (await res.json()) as unknown;
    items = Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    items = [];
  }

  // Compute usage is only available via the run metadata endpoint. Best-
  // effort lookup — if it fails, we record 0 (under-counting is safer
  // than crashing on a free tier hit).
  let computeUnits = 0;
  let costUsd = 0;
  if (runId) {
    const meta = await fetchRunMeta(token, runId, opts.signal);
    computeUnits = meta.computeUnits;
    costUsd = meta.costUsd;
  }

  const durationMs = Date.now() - started;
  const blocked = detectBlockedOutput(items);

  // Budget enforcement is post-hoc: we can't pre-cancel a sync run, but
  // we record the breach so the orchestrator can stop dispatching further
  // runs in the same batch (see lib/sources/*-watcher).
  const budgetExceeded = costUsd > APIFY_BUDGET_PER_RUN_USD;

  if (budgetExceeded) {
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_budget_exceeded",
      targetType: "apify",
      targetId: opts.actorId,
      summary: `Apify run "${opts.label}" cost $${costUsd.toFixed(3)} — exceeds per-run cap $${APIFY_BUDGET_PER_RUN_USD}.`,
    });
  } else if (items.length === 0) {
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_empty_run",
      targetType: "apify",
      targetId: opts.actorId,
      summary: `Apify run "${opts.label}" returned 0 items. cost=$${costUsd.toFixed(3)}.`,
    });
  } else {
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_run",
      targetType: "apify",
      targetId: opts.actorId,
      summary: `Apify run "${opts.label}" → ${items.length} items, ${computeUnits.toFixed(2)} CU, $${costUsd.toFixed(3)} (${(durationMs / 1000).toFixed(1)}s).`,
    });
  }

  return {
    ok: !budgetExceeded && !blocked,
    status: budgetExceeded ? "budget_exceeded" : blocked ? "needs_human_review" : "completed",
    items,
    runId,
    computeUnits,
    costUsd,
    durationMs,
    error: null,
    needsHumanReview: blocked,
  };
}

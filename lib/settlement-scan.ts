/**
 * Item 5.3 — opioid-settlement board scan + quarterly health review.
 *
 * Two operations, both reusing established infrastructure:
 *
 *   1. runSettlementScan() — discovery. Delegates straight to the Apify
 *      watcher (`runWatcher`, family "settlement"). The 31 boards from the
 *      catalogue are crawled in one run; new listings land as `scout_items`
 *      tagged source=county|state and notes={funding_source:opioid_settlement,…}
 *      so they flow through the same Decision-Queue triage as every other
 *      scout. Nothing is sent — discovery + persistence only.
 *
 *   2. reviewSettlementBoards() — the QUARTERLY review cron. Probes each
 *      board's dashboard URL to answer "are monitored boards still active? any
 *      moved/dead?" and files a Suggestion-Inbox entry for any board that has
 *      gone dark, mirroring the watcher's `maybeFileNeedsHumanReview` pattern.
 *
 * Pure classification (`classifyBoardProbe`) is split from the network shell so
 * it can be unit-tested without hitting the wire.
 */

import { runWatcher, type WatcherRunResult } from "./sources/apify-watcher";
import { createSuggestion, listSuggestions } from "./suggestions";
import { tryLogActivity } from "./activity";
import { ALL_SETTLEMENT_BOARDS, orderedBoards, type SettlementBoard } from "./settlement-boards/catalogue";

// ---- Discovery -------------------------------------------------------------

export async function runSettlementScan(
  userEmail: string,
  opts: { signal?: AbortSignal } = {},
): Promise<WatcherRunResult> {
  return runWatcher({ userEmail, family: "settlement", signal: opts.signal });
}

// ---- Quarterly review ------------------------------------------------------

export type BoardProbeStatus = "active" | "moved" | "dead";

export type BoardProbe = {
  boardId: string;
  url: string;
  httpStatus: number | null;
  status: BoardProbeStatus;
};

/**
 * Pure: map an HTTP probe result to a board health status.
 *   - 2xx                      → active
 *   - 3xx (redirect)           → moved   (URL likely needs updating)
 *   - 4xx/5xx or no response   → dead     (needs human review)
 */
export function classifyBoardProbe(input: {
  ok: boolean;
  httpStatus: number | null;
}): BoardProbeStatus {
  const code = input.httpStatus;
  if (code == null) return "dead";
  if (code >= 200 && code < 300) return "active";
  if (code >= 300 && code < 400) return "moved";
  return "dead";
}

export type SettlementReviewResult = {
  checked: number;
  active: number;
  moved: number;
  dead: number;
  flagged: string[]; // board ids that got a suggestion filed
  probes: BoardProbe[];
};

const PROBE_CONTEXT = "settlement_board_review";

async function probeBoard(board: SettlementBoard, timeoutMs: number): Promise<BoardProbe> {
  const url = board.dashboardUrl;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // HEAD first; some gov hosts reject HEAD, so fall back to a ranged GET.
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", redirect: "manual", signal: ctrl.signal });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, { method: "GET", redirect: "manual", signal: ctrl.signal });
      }
    } catch {
      res = await fetch(url, { method: "GET", redirect: "manual", signal: ctrl.signal });
    }
    const httpStatus = res.status;
    return { boardId: board.id, url, httpStatus, status: classifyBoardProbe({ ok: res.ok, httpStatus }) };
  } catch {
    return { boardId: board.id, url, httpStatus: null, status: "dead" };
  } finally {
    clearTimeout(timer);
  }
}

function maybeFlagBoard(userEmail: string, board: SettlementBoard, probe: BoardProbe): boolean {
  const open = listSuggestions({
    userEmail,
    status: "open",
    paneContextType: PROBE_CONTEXT,
    paneContextId: board.id,
  });
  if (open.length > 0) return false;
  const verb = probe.status === "moved" ? "appears to have moved" : "appears dead";
  createSuggestion({
    userEmail,
    paneContextType: PROBE_CONTEXT,
    paneContextId: board.id,
    body:
      `Opioid-settlement board "${board.name}" ${verb} ` +
      `(HTTP ${probe.httpStatus ?? "no response"} at ${probe.url}). ` +
      `Verify the dashboard URL / find the new ${board.cadence.toLowerCase()} page, ` +
      `or retire this board from the catalogue.`,
  });
  tryLogActivity({
    actor: userEmail,
    actionType: "settlement_board_review",
    targetType: "settlement_board",
    targetId: board.id,
    summary: `Settlement board needs review: ${board.name} (${probe.status})`,
  });
  return true;
}

export type ReviewOptions = {
  // Test hook — supply probe results instead of hitting the network.
  probeOverride?: (board: SettlementBoard) => BoardProbe;
  timeoutMs?: number;
  fileSuggestions?: boolean;
};

export async function reviewSettlementBoards(
  userEmail: string,
  opts: ReviewOptions = {},
): Promise<SettlementReviewResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const fileSuggestions = opts.fileSuggestions ?? true;
  const probes: BoardProbe[] = [];
  const flagged: string[] = [];

  for (const board of orderedBoards(ALL_SETTLEMENT_BOARDS)) {
    const probe = opts.probeOverride
      ? opts.probeOverride(board)
      : await probeBoard(board, timeoutMs);
    probes.push(probe);
    if (probe.status !== "active" && fileSuggestions) {
      if (maybeFlagBoard(userEmail, board, probe)) flagged.push(board.id);
    } else if (probe.status !== "active") {
      flagged.push(board.id);
    }
  }

  return {
    checked: probes.length,
    active: probes.filter((p) => p.status === "active").length,
    moved: probes.filter((p) => p.status === "moved").length,
    dead: probes.filter((p) => p.status === "dead").length,
    flagged,
    probes,
  };
}

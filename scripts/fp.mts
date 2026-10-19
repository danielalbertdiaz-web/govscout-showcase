/**
 * Federal Pipeline CLI — the contract boundary between Alfred (OpenClaw crons,
 * Telegram approval flows) and the Bid Board state store. JSON in, JSON out,
 * non-zero exit on bad input. Spec: FEDERAL_PIPELINE_PHASE1_SPEC.md.
 *
 * Run: npm run fp -- <command> [args]
 *
 * Client panels (migration 043, PANEL_ISOLATION_SPEC.md): --client <el|riverside|northstar>
 * is REQUIRED on ingest / set-status / show / list — every discovery cron says
 * whose panel it writes to, and handle lookups never cross panels. On the
 * remaining commands it is an optional scope for handle resolution.
 *
 *   ingest --client <id> <json-file|->   upsert opportunities (dedupe per client: notice_id, then sol_number)
 *   set-status --client <id> <id|sol> <status> [--note "..."]
 *   log-event <id|sol> <kind> [--detail-json '{...}'] [--client <id>]
 *   list --client <id> [--status X] [--due-within Nd] [--tier micro|mid|vehicle] [--source sam]
 *   pending-approvals [--client <id>]    everything awaiting_approval, with price + deadline
 *   record-outcome <id|sol> won|lost|no_award [--amount N] [--awardee S] [--notes S] [--client <id>]
 *   flag <id|sol> --by <who> [--off] [--note "..."] [--client <id>]   priority flag; --off unflags
 *   show --client <id> <id|sol>          one opportunity + its full event trail
 */

import fs from "fs";
import { parseArgs } from "util";
import {
  upsertFpOpportunity,
  setFpStatus,
  setFpFlag,
  logFpEvent,
  listFpOpportunities,
  listFpEvents,
  pendingFpApprovals,
  recordFpOutcome,
  findFpOpportunity,
  type FpOpportunityInput,
  type FpOutcome,
} from "../lib/federal-pipeline";
import {
  CLIENT_IDS,
  FP_STATUSES,
  FP_EVENT_KINDS,
  isClientId,
  isFpStatus,
  isFpEventKind,
  type ClientId,
} from "../lib/federal-pipeline-types";

function ok(payload: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + "\n");
  process.exit(0);
}

function fail(error: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(JSON.stringify({ ok: false, error, ...extra }) + "\n");
  process.exit(1);
}

function readInput(pathArg: string | undefined): string {
  if (!pathArg || pathArg === "-") {
    try {
      return fs.readFileSync(0, "utf8"); // stdin
    } catch {
      fail("no input on stdin (pass a JSON file path or pipe JSON)");
    }
  }
  if (!fs.existsSync(pathArg)) fail(`file not found: ${pathArg}`);
  return fs.readFileSync(pathArg, "utf8");
}

/**
 * The commands that write or resolve rows by panel refuse to run without
 * --client; there is deliberately no default. A cron that forgets the flag
 * fails here with the valid list, instead of landing rows on someone else's
 * panel (the COI failure the isolation spec exists to prevent).
 */
function requireClientFlag(client: string | undefined): ClientId {
  if (!client) fail("--client <id> is required", { valid: CLIENT_IDS });
  if (!isClientId(client)) fail(`invalid --client: ${client}`, { valid: CLIENT_IDS });
  return client;
}

function optionalClientFlag(client: string | undefined): ClientId | undefined {
  if (client === undefined) return undefined;
  return requireClientFlag(client);
}

function parseDueWithin(v: string): number {
  const m = /^(\d+)d?$/.exec(v.trim());
  if (!m) fail(`invalid --due-within value: ${v} (expected e.g. 14 or 14d)`);
  return Number(m[1]);
}

/**
 * Alfred's cron JSON sometimes arrives with snake_case keys (sol_number,
 * notice_id, ...) which the camelCase FpOpportunityInput used to drop
 * silently — the opp then landed with sol_number NULL and later
 * log-event/set-status by sol failed with "no opportunity matches"
 * (operator-reported on HT003826SC004). Accept both spellings.
 */
function camelizeOppInput(item: Record<string, unknown>): FpOpportunityInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    const camel = k.includes("_") ? k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()) : k;
    // camelCase spelling wins if both are present
    if (!(camel in out) || out[camel] == null) out[camel] = v;
  }
  return out as FpOpportunityInput;
}

function cmdIngest(positionals: string[], clientFlag: string | undefined) {
  const client = requireClientFlag(clientFlag);
  const raw = readInput(positionals[0]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { opportunities?: unknown }).opportunities)
      ? (parsed as { opportunities: unknown[] }).opportunities
      : null;
  if (!items) fail("expected a JSON array of opportunities, or {\"opportunities\": [...]}");
  const results: Array<{
    id: string;
    solNumber: string | null;
    noticeId: string | null;
    title: string;
    created: boolean;
    reopenBlocked?: { from: string; attempted: string };
    skippedDeleted?: boolean;
    scoreWithheld?: { reason: string; evidence: string; withheldScore: number };
    scoreCapped?: { rawScore: number; cappedTo: number; signals: string[] };
  }> = [];
  for (const [i, item] of items.entries()) {
    if (!item || typeof item !== "object") fail(`item ${i} is not an object`);
    // The flag owns the panel. A payload may repeat it (clientId/client_id)
    // but a MISMATCH is refused outright rather than letting either side win
    // silently — a cron pasting another client's export must fail loudly.
    const input = camelizeOppInput(item as Record<string, unknown>);
    if (input.clientId !== undefined && input.clientId !== client) {
      fail(
        `item ${i} carries client_id ${JSON.stringify(input.clientId)} but --client is ${client} — refusing to guess which is right`,
      );
    }
    input.clientId = client;
    let res;
    try {
      res = upsertFpOpportunity(input);
    } catch (e) {
      fail(`item ${i} (${JSON.stringify((item as { title?: unknown }).title ?? "?")}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.created) {
      logFpEvent(res.opp.id, "discovered", { via: "fp ingest", status: res.opp.status });
    }
    if (res.statusChangeBlocked) {
      // Record the blocked attempt on the opportunity's own event trail too,
      // not just in this command's stdout, so it's visible from `fp show`.
      logFpEvent(res.opp.id, "note", {
        via: "fp ingest",
        reopenBlocked: true,
        from: res.statusChangeBlocked.from,
        attempted: res.statusChangeBlocked.attempted,
        note: "Ingest tried to change status on a non-discovered opportunity; blocked by the reopen guard. If this is a deliberate reopen, use `fp set-status <id|sol> <status>` directly (unaffected by this guard), or pass forceReopen:true in the ingest payload.",
      });
    }
    results.push({
      id: res.opp.id,
      solNumber: res.opp.solNumber,
      noticeId: res.opp.noticeId,
      title: res.opp.title,
      created: res.created,
      ...(res.statusChangeBlocked
        ? { reopenBlocked: { from: res.statusChangeBlocked.from, attempted: res.statusChangeBlocked.attempted } }
        : {}),
      // Permanent-delete tombstone (migration 036): NOTHING was written for
      // this item — flagged so it is never counted as an update below.
      ...(res.skippedDeleted ? { skippedDeleted: true } : {}),
      // Scanner scoring gates (migration 042, lib/scan-gates.ts): the score
      // was withheld (Tier 1 disqualifier) or capped (Tier 2 scale signals).
      // The opportunity itself was written either way — never removed.
      ...(res.scoreWithheld ? { scoreWithheld: res.scoreWithheld } : {}),
      ...(res.scoreCapped ? { scoreCapped: res.scoreCapped } : {}),
    });
  }
  const blocked = results.filter((r) => r.reopenBlocked);
  const skippedDeleted = results.filter((r) => r.skippedDeleted).length;
  const scoreWithheld = results.filter((r) => r.scoreWithheld).length;
  const scoreCapped = results.filter((r) => r.scoreCapped).length;
  ok({
    created: results.filter((r) => r.created).length,
    updated: results.filter((r) => !r.created && !r.skippedDeleted).length,
    skippedDeleted,
    scoreWithheld,
    scoreCapped,
    reopenBlocked: blocked.length,
    ...(scoreWithheld > 0
      ? {
          scoreWithheldWarning:
            "One or more notices carry a positively matched sole-source/brand-name or authorized-reseller-only clause; their AI-deliverability scores were NOT stored (the rows themselves were written and stay visible). Check scoreWithheld entries in `results` — these are almost certainly not biddable by Acme.",
        }
      : {}),
    ...(scoreCapped > 0
      ? {
          scoreCappedWarning:
            "One or more notices carry enterprise-scale signals (IL-4/5/6, CSO, staffed labor hours, multi-year T&M, ...); their scores were capped and the signal names stored on the row. They remain in the candidate list — a large program can contain a small Acme-shaped carve-out, so give each a human glance.",
        }
      : {}),
    ...(blocked.length > 0
      ? {
          reopenBlockedWarning:
            "One or more opportunities already had a non-discovered status (e.g. a prior no-bid) and a re-ingest tried to change it. The status was left untouched -- check reopenBlocked entries in `results` before treating this run as routine.",
        }
      : {}),
    ...(skippedDeleted > 0
      ? {
          skippedDeletedWarning: `${skippedDeleted} opportunit${skippedDeleted === 1 ? "y" : "ies"} matched a permanent-delete tombstone and ${skippedDeleted === 1 ? "was" : "were"} skipped -- nothing was written for ${skippedDeleted === 1 ? "it" : "them"}. Check skippedDeleted entries in \`results\` before treating this run as routine.`,
        }
      : {}),
    results,
  });
}

function cmdSetStatus(positionals: string[], note: string | undefined, clientFlag: string | undefined) {
  const client = requireClientFlag(clientFlag);
  const [handle, status] = positionals;
  if (!handle || !status) fail("usage: fp set-status --client <id> <id|sol|notice> <status> [--note ...]");
  if (!isFpStatus(status)) fail(`invalid status: ${status}`, { valid: FP_STATUSES });
  try {
    const { opp, event } = setFpStatus(handle, status, note ?? null, client);
    ok({ opportunity: opp, event });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function cmdLogEvent(positionals: string[], detailJson: string | undefined, clientFlag: string | undefined) {
  const [handle, kind] = positionals;
  if (!handle || !kind) fail("usage: fp log-event <id|sol|notice> <kind> [--detail-json '{...}'] [--client <id>]");
  if (!isFpEventKind(kind)) fail(`invalid event kind: ${kind}`, { valid: FP_EVENT_KINDS });
  let detail: Record<string, unknown> | null = null;
  if (detailJson) {
    try {
      const d = JSON.parse(detailJson);
      if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("must be a JSON object");
      detail = d as Record<string, unknown>;
    } catch (e) {
      fail(`--detail-json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const opp = findFpOpportunity(handle, optionalClientFlag(clientFlag));
  if (!opp) fail(`no opportunity matches: ${handle}`);
  const event = logFpEvent(opp.id, kind, detail);
  ok({ event, opportunity: { id: opp.id, solNumber: opp.solNumber, title: opp.title } });
}

function cmdList(values: { status?: string; "due-within"?: string; tier?: string; source?: string; client?: string }) {
  const client = requireClientFlag(values.client);
  try {
    const opportunities = listFpOpportunities({
      clientId: client,
      status: values.status as never,
      tier: values.tier as never,
      source: values.source as never,
      dueWithinDays: values["due-within"] != null ? parseDueWithin(values["due-within"]) : undefined,
    });
    ok({ count: opportunities.length, opportunities });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function cmdPendingApprovals(clientFlag: string | undefined) {
  const pending = pendingFpApprovals(optionalClientFlag(clientFlag)).map((o) => ({
    id: o.id,
    solNumber: o.solNumber,
    noticeId: o.noticeId,
    title: o.title,
    agency: o.agency,
    priceQuoted: o.priceQuoted,
    priceBasis: o.priceBasis,
    responseDeadline: o.responseDeadline,
    submissionMethod: o.submissionMethod,
    submissionTarget: o.submissionTarget,
    url: o.url,
  }));
  ok({ count: pending.length, pending });
}

function cmdRecordOutcome(
  positionals: string[],
  values: { amount?: string; awardee?: string; notes?: string; client?: string },
) {
  const [handle, outcome] = positionals;
  if (!handle || !outcome) {
    fail("usage: fp record-outcome <id|sol|notice> won|lost|no_award [--amount N] [--awardee S] [--notes S]");
  }
  if (!["won", "lost", "no_award"].includes(outcome)) {
    fail(`invalid outcome: ${outcome} (won|lost|no_award)`);
  }
  let amount: number | null = null;
  if (values.amount != null) {
    amount = Number(values.amount);
    if (!Number.isFinite(amount) || amount < 0) fail(`invalid --amount: ${values.amount}`);
  }
  try {
    const { opp, event } = recordFpOutcome(handle, outcome as FpOutcome, {
      amount,
      awardee: values.awardee ?? null,
      notes: values.notes ?? null,
      clientId: optionalClientFlag(values.client),
    });
    ok({ opportunity: opp, event });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

// Priority flag (migration 041). Applies immediately, like set-status — this
// IS the canonical write path for flagged_at; nothing else may write it.
// --by is required: a priority call is a human judgement and the event trail
// records who made it. Re-running with the state already set is a reported
// no-op (changed: false), not a duplicate event.
function cmdFlag(
  positionals: string[],
  values: { off?: boolean; by?: string; note?: string; client?: string },
) {
  const [handle] = positionals;
  if (!handle || !values.by) {
    fail("usage: fp flag <id|sol|notice> --by <who> [--off] [--note ...] [--client <id>]");
  }
  try {
    const { opp, event, changed } = setFpFlag(handle, !values.off, {
      by: values.by,
      note: values.note ?? null,
      clientId: optionalClientFlag(values.client),
    });
    ok({
      changed,
      flaggedAt: opp.flaggedAt,
      opportunity: { id: opp.id, solNumber: opp.solNumber, title: opp.title },
      event,
    });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function cmdShow(positionals: string[], clientFlag: string | undefined) {
  const client = requireClientFlag(clientFlag);
  const [handle] = positionals;
  if (!handle) fail("usage: fp show --client <id> <id|sol|notice>");
  const opp = findFpOpportunity(handle, client);
  if (!opp) fail(`no opportunity matches: ${handle} (client: ${client})`);
  ok({ opportunity: opp, events: listFpEvents(opp.id) });
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    fail("usage: fp <ingest|set-status|log-event|list|pending-approvals|record-outcome|flag|show>");
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      client: { type: "string" },
      note: { type: "string" },
      "detail-json": { type: "string" },
      status: { type: "string" },
      "due-within": { type: "string" },
      tier: { type: "string" },
      source: { type: "string" },
      amount: { type: "string" },
      awardee: { type: "string" },
      notes: { type: "string" },
      off: { type: "boolean" },
      by: { type: "string" },
    },
  });

  switch (cmd) {
    case "ingest":
      return cmdIngest(positionals, values.client);
    case "set-status":
      return cmdSetStatus(positionals, values.note, values.client);
    case "log-event":
      return cmdLogEvent(positionals, values["detail-json"], values.client);
    case "list":
      return cmdList(values);
    case "pending-approvals":
      return cmdPendingApprovals(values.client);
    case "record-outcome":
      return cmdRecordOutcome(positionals, values);
    case "flag":
      return cmdFlag(positionals, values);
    case "show":
      return cmdShow(positionals, values.client);
    default:
      fail(`unknown command: ${cmd}`);
  }
}

try {
  main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

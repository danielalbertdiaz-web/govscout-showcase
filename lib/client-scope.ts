// Client-scope chokepoint — tracking/ingest layer (PANEL_ISOLATION_SPEC.md §3).
//
// Why this file exists: "we filtered by client_id in most places" is a leak,
// not a mitigation — the same make-it-impossible-to-forget principle as the
// set-status/log-event fix. Every write into a client-scoped tracking table
// validates its client through requireClientId; there is NO silent fallback to
// 'el' past this point. A missing client_id is a bug, not a default.
//
// Scope of this build (deliberate): the tracking tables only —
// fp_opportunities via lib/federal-pipeline.ts, which is already the single
// write path for opportunity state (doctrine: never raw SQL against
// fp_opportunities). The drafting-side call sites the spec also names —
// buildDispositionContext() in lib/council.ts, boilerplate_blocks /
// boilerplate_pins — are NOT wired yet: no client other than Acme is drafting,
// and that half stays deferred until the Riverside agreement gates it in (spec
// §6). If Riverside/Northstar drafting comes up, that is a separate build: the full
// §3 chokepoint (scopedSelect/scopedInsert over every corpus table + the CI
// grep gate) plus the §6.2 boilerplate reclassification pass — flag it to
// the operator/Alfred, don't bolt it on here.

import { CLIENT_IDS, isClientId, type ClientId } from "./federal-pipeline-types";

export { CLIENT_IDS, CLIENT_LABELS, isClientId, type ClientId } from "./federal-pipeline-types";

/**
 * The only way a client id enters a write path. Throws on anything not in the
 * canonical list — including undefined/null, so "forgot to pass it" fails
 * loudly at the write, never lands as somebody else's row.
 */
export function requireClientId(value: unknown): ClientId {
  if (typeof value === "string" && isClientId(value)) return value;
  throw new Error(
    `invalid client_id: ${JSON.stringify(value ?? null)} (valid: ${CLIENT_IDS.join(", ")})`,
  );
}

/**
 * Tables carrying client_id as of migration 043. The fp_* write path is wired
 * through requireClientId now; the drafting-side tables rely on the SQL
 * DEFAULT 'el' until their chokepoint lands (see header). Exported so a future
 * CI grep gate (spec §3) has one list to check against.
 */
export const CLIENT_SCOPED_TABLES = [
  "fp_opportunities",
  "nofos",
  "drafts",
  "decision_queue",
  "auto_draft_log",
  "auto_draft_queue",
] as const;

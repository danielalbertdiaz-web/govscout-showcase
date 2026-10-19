// Promote micro_contracts staging rows onto the Bid Board (fp_opportunities)
// on a human's explicit decision — the authorised path OUT of a sweep kill.
//
// Born 2026-08-04: the sweep's foreign-pop-* verdict had auto-killed five
// State Dept solicitations, two of which had actually been bid. The scanner
// rule is fixed, but the wrongly-killed live ones still need a way into the
// pipeline that (a) goes through upsertFpOpportunity — GovScout is canon and
// the write-path freeze exists precisely so importers cannot invent state —
// (b) honours tombstones, because resurrection-by-import is a defect already
// fixed once (migration 036), and (c) never clobbers a row a human touched.
//
// This module owns the decision + mapping logic so it is testable against a
// temp database; scripts/promote-micro-contract.mts is the thin CLI.

import {
  getDb,
  listMicroContracts,
  setMicroContractDisposition,
  type MicroContractRecord,
} from "./db";
import type { MicroContractDisposition } from "./micro-contracts-types";
import { normalizeSolNumber } from "./opportunity-identity";
import { parseDeadlineMs } from "./pipeline-summary";
import {
  findFpOpportunity,
  findFpTombstone,
  upsertFpOpportunity,
  listFpEvents,
  logFpEvent,
  type FpOpportunityInput,
  type FpOpportunityRecord,
  type FpSource,
  type FpTombstone,
} from "./federal-pipeline";

/**
 * Entry state for a promoted opportunity: "discovered" — the FpStatus triage
 * state (Bid Board "Triage" column, and the only status the reopen guard
 * treats as pre-decision). NOT drafting, NOT submitted: promotion surfaces an
 * opportunity for triage; it does not fabricate work that never happened.
 */
export const PROMOTION_ENTRY_STATUS = "discovered" as const;

/**
 * Where the STAGING row lands when its sweep kill is overridden by promotion.
 * "reviewing" mirrors fp "discovered" in the R-1 stance map (working vs
 * untouched = agree); leaving the row at "passed" would make every promotion
 * permanently manufacture a state conflict (dead vs untouched) on the R-1
 * conflict list — a list that exists to surface GENUINE disagreements, and
 * that fills with resolved ones trains people to ignore it. Found live on
 * 2026-08-04: the first two promotions took the conflict count 14 -> 16.
 */
export const PROMOTED_STAGING_DISPOSITION: MicroContractDisposition = "reviewing";

/**
 * Did this promoter create the fp row? Answered from the provenance event it
 * always logs — the record exists precisely so this question is answerable.
 */
function wasPromotedByThisTool(oppId: string): boolean {
  return listFpEvents(oppId).some((e) => e.detail?.source === "promote-micro-contract");
}

/** micro_contracts.source vocabulary -> FP source vocabulary. */
export function fpSourceForMicro(source: string): FpSource {
  return source === "sam_gov" ? "sam" : "other";
}

/**
 * Map a staging row to the canonical upsert input. The deadline string is
 * carried verbatim — parsing is parseDeadlineMs's job at read time (a bare
 * date means end-of-day local, fix 1b); re-formatting here would re-open that
 * bug. set_aside likewise rides through raw: upsertFpOpportunity derives the
 * canonical value, and NULL lands on "unknown", never "none".
 */
export function buildPromotionInput(micro: MicroContractRecord): FpOpportunityInput {
  return {
    // micro_contracts is Acme's own staging lane (no client column); everything
    // promoted from it is Acme pipeline by definition (migration 043).
    clientId: "el",
    solNumber: micro.solNumber,
    noticeId: micro.noticeId,
    title: micro.title,
    agency: micro.agency,
    naics: micro.naics,
    setAside: micro.setAside,
    noticeType: micro.noticeType,
    tier: "micro",
    source: fpSourceForMicro(micro.source),
    url: micro.url,
    responseDeadline: micro.responseDeadline,
    status: PROMOTION_ENTRY_STATUS,
  };
}

export type PromotionOutcome =
  /** No staging row matches the requested sol — caller must exit nonzero. */
  | { kind: "missing"; sol: string }
  /**
   * REFUSED: the natural key is tombstoned (permanent delete, migration 036).
   * Nothing was written. Overriding is a deliberate human act outside this
   * tool, never an import side effect.
   */
  | { kind: "tombstoned"; sol: string; micro: MicroContractRecord; tombstone: FpTombstone }
  /**
   * An fp_opportunity already exists for this key: left ENTIRELY alone (no
   * field, status, or deadline is touched — a human may own them). The only
   * writes are repairs of machine-manufactured state: a missing micro->fp
   * link (migration 040 bookkeeping, `linkRepair`), and — ONLY on rows this
   * promoter itself created — a staging row still carrying the superseded
   * sweep kill (`dispositionRepair`, e.g. a promotion that predates the
   * disposition fix). A pre-existing board row whose staging copy reads
   * "passed" is a GENUINE conflict and is never touched here.
   */
  | {
      kind: "exists";
      sol: string;
      micro: MicroContractRecord;
      existing: FpOpportunityRecord;
      linkRepair: boolean;
      dispositionRepair: boolean;
    }
  /** Promoted (or would be, in dry run — `oppId` is null then). */
  | {
      kind: "promoted";
      sol: string;
      micro: MicroContractRecord;
      input: FpOpportunityInput;
      deadlineMs: number | null;
      oppId: string | null;
      /** Set when the staging row is moved off the superseded sweep kill. */
      dispositionChange: { from: MicroContractDisposition; to: MicroContractDisposition } | null;
    };

export type PromotionOptions = {
  ownerEmail: string;
  /** False = dry run: decide and report everything, write nothing. */
  apply: boolean;
  /** The human who authorised pulling this out of the sweep's kill pile. */
  authorisedBy: string;
  /** Recorded in the provenance event (no first-class fp priority field exists). */
  priority?: string | null;
};

export function promoteMicroContracts(
  sols: string[],
  opts: PromotionOptions,
): { outcomes: PromotionOutcome[]; ok: boolean } {
  const db = getDb();
  const staged = listMicroContracts(opts.ownerEmail);

  // Dedupe requested sols on normalised identity, preserving order.
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const sol of sols) {
    const norm = normalizeSolNumber(sol);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    requested.push(sol);
  }

  const outcomes: PromotionOutcome[] = [];
  for (const sol of requested) {
    const norm = normalizeSolNumber(sol);
    // Loose sol matching, same reasoning as findFpOpportunity: SAM exports
    // and human notes format sol numbers inconsistently. Several notices can
    // share a sol (amendments); most recently updated is the row a human means.
    const matches = staged
      .filter((m) => m.solNumber && normalizeSolNumber(m.solNumber) === norm)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const micro = matches[0];
    if (!micro) {
      outcomes.push({ kind: "missing", sol });
      continue;
    }

    // Tombstone check BEFORE anything else. upsertFpOpportunity guards too,
    // but the refusal must be a first-class, loudly-reported outcome — not a
    // silently-skipped write.
    const tombstone = findFpTombstone(micro.noticeId, micro.solNumber ?? sol);
    if (tombstone) {
      outcomes.push({ kind: "tombstoned", sol, micro, tombstone });
      continue;
    }

    // Idempotency: an existing canonical row is never touched. This lookup is
    // strictly broader than upsert's (it also normalises sol), so "no match
    // here" guarantees the upsert below creates rather than updates.
    const existing =
      findFpOpportunity(micro.noticeId) ??
      (micro.solNumber ? findFpOpportunity(micro.solNumber) : null);
    if (existing) {
      const linkRepair = micro.fpOpportunityId == null;
      const dispositionRepair =
        micro.disposition === "passed" && wasPromotedByThisTool(existing.id);
      if (opts.apply && (linkRepair || dispositionRepair)) {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (linkRepair) {
            db.prepare("UPDATE micro_contracts SET fp_opportunity_id = ? WHERE id = ?").run(
              existing.id,
              micro.id,
            );
          }
          if (dispositionRepair) {
            setMicroContractDisposition(micro.id, opts.ownerEmail, PROMOTED_STAGING_DISPOSITION);
            logFpEvent(existing.id, "note", {
              source: "promote-micro-contract",
              note: "staging disposition repaired off the superseded sweep kill (pre-fix promotion)",
              microContractId: micro.id,
              stagingDisposition: { from: micro.disposition, to: PROMOTED_STAGING_DISPOSITION },
              authorisedBy: opts.authorisedBy,
            });
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }
      outcomes.push({ kind: "exists", sol, micro, existing, linkRepair, dispositionRepair });
      continue;
    }

    const input = buildPromotionInput(micro);
    const deadlineMs = parseDeadlineMs(micro.responseDeadline);
    // Promotion IS the human override of the sweep kill, so the staging row
    // must leave "passed" in the same stroke — otherwise every promotion
    // manufactures a permanent R-1 state conflict (dead vs untouched). Other
    // dispositions are left alone: "new" already agrees with "discovered",
    // and reviewing/drafting/submitted/won are human statements this tool
    // has no business rewriting.
    const dispositionChange =
      micro.disposition === "passed"
        ? { from: micro.disposition, to: PROMOTED_STAGING_DISPOSITION }
        : null;
    if (!opts.apply) {
      outcomes.push({ kind: "promoted", sol, micro, input, deadlineMs, oppId: null, dispositionChange });
      continue;
    }

    // One transaction per promotion: canonical row, backlink, provenance
    // event land together or not at all (same raw BEGIN IMMEDIATE discipline
    // as deleteFpOpportunity — AnyDb has no .transaction() helper).
    db.exec("BEGIN IMMEDIATE");
    try {
      const res = upsertFpOpportunity(input);
      if (res.skippedDeleted) {
        // Belt and braces: the pre-check above should have caught this.
        db.exec("ROLLBACK");
        outcomes.push({ kind: "tombstoned", sol, micro, tombstone: res.skippedDeleted });
        continue;
      }
      if (!res.created) {
        // Cannot happen (pre-check is broader than upsert's key lookup), but
        // if it ever does, refuse to have silently enriched an existing row.
        db.exec("ROLLBACK");
        throw new Error(
          `upsert matched an existing fp_opportunity for ${sol} that the pre-check missed — nothing written`,
        );
      }
      db.prepare("UPDATE micro_contracts SET fp_opportunity_id = ? WHERE id = ?").run(
        res.opp.id,
        micro.id,
      );
      if (dispositionChange) {
        // Same transaction as the fp row: an fp row whose staging counterpart
        // still reads "passed" must not be a reachable state. description is
        // NOT touched — the original kill verdict ("Sweep verdict: ...") is
        // the audit trail that made these exclusions findable at all.
        setMicroContractDisposition(micro.id, opts.ownerEmail, dispositionChange.to);
      }
      // The answer to "why is this in the pipeline when the sweep killed it?"
      logFpEvent(res.opp.id, "note", {
        source: "promote-micro-contract",
        note: "promoted from micro-sweep staging by human decision",
        microContractId: micro.id,
        microDisposition: micro.disposition,
        // e.g. "Sweep verdict: foreign-pop-nepal-kathmandu" — why it was excluded.
        previousExclusion: micro.description,
        authorisedBy: opts.authorisedBy,
        ...(dispositionChange ? { stagingDisposition: dispositionChange } : {}),
        ...(opts.priority ? { priority: opts.priority } : {}),
      });
      db.exec("COMMIT");
      outcomes.push({ kind: "promoted", sol, micro, input, deadlineMs, oppId: res.opp.id, dispositionChange });
    } catch (err) {
      // ROLLBACK unless this iteration already resolved the transaction.
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back or committed */
      }
      throw err;
    }
  }

  const ok = outcomes.every((o) => o.kind !== "missing" && o.kind !== "tombstoned");
  return { outcomes, ok };
}

// Cross-source opportunity identity (routing matrix R-1, phase 1).
//
// The same solicitation can exist as a micro_contracts staging row (Layer 1 —
// everything the sweep saw, including kills) AND an fp_opportunities canonical
// row (Layer 2). Nothing linked them, so the two records could disagree —
// live example: "VISN 16 Secure DICOM" fp:triaged_bid vs micro:passed —
// and whichever screen the operator opened determined what he believed.
//
// This module is the PURE matcher: it decides which rows are the same
// opportunity and whether their states disagree. It links and surfaces —
// it never resolves. Every conflict is two human/agent decisions
// disagreeing; picking a winner automatically would destroy one (same
// discipline as the Bid Board merge: 82 conflicts surfaced, none
// auto-adjudicated).
//
// No DB access, no clock. lib/db.ts uses resolveLink at ingest;
// scripts/link-opportunities.mts uses linkCandidates for the backfill.

/**
 * Punctuation/case-insensitive sol-number comparison — THE single definition
 * (moved here from lib/federal-pipeline.ts so both lib/db.ts and
 * lib/federal-pipeline.ts can share it without an import cycle). Sol numbers
 * arrive formatted inconsistently across SAM exports and human notes
 * (HT0038-26-SC-004 vs HT003826SC004); compare with punctuation stripped.
 */
export function normalizeSolNumber(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** The comparable identity of a record: exact notice id + normalised sol. */
export function matchKey(
  noticeId: string | null | undefined,
  solNumber: string | null | undefined,
): { notice: string | null; sol: string | null } {
  const notice = noticeId && noticeId.trim() ? noticeId.trim() : null;
  const sol = solNumber && solNumber.trim() ? normalizeSolNumber(solNumber) : null;
  return { notice, sol };
}

export type IdentityRow = {
  id: string;
  noticeId: string | null;
  solNumber: string | null;
};

export type LinkResolution =
  | { kind: "match"; fpId: string; matchedOn: "notice_id" | "sol_number" }
  | { kind: "ambiguous"; reason: string; fpIds: string[] }
  | { kind: "none" };

/**
 * Resolve one staging row against the canonical rows.
 *
 * notice_id is the stronger key and wins outright. A sol_number-only match is
 * accepted ONLY when it is unambiguous: exactly one canonical row matches the
 * normalised sol, and the two rows do not carry DIFFERENT non-null notice_ids
 * (two different notice_ids sharing a sol number are two different notices —
 * e.g. a base solicitation and its amendment — and guessing would link the
 * wrong record).
 */
export function resolveLink(
  micro: { noticeId: string | null; solNumber: string | null },
  fpRows: IdentityRow[],
): LinkResolution {
  const key = matchKey(micro.noticeId, micro.solNumber);

  if (key.notice) {
    const byNotice = fpRows.filter((r) => matchKey(r.noticeId, null).notice === key.notice);
    if (byNotice.length === 1) return { kind: "match", fpId: byNotice[0].id, matchedOn: "notice_id" };
    if (byNotice.length > 1) {
      // fp notice_id is unique-indexed, so this only happens on bad input.
      return { kind: "ambiguous", reason: `multiple canonical rows share notice_id ${key.notice}`, fpIds: byNotice.map((r) => r.id) };
    }
  }

  if (key.sol) {
    const bySol = fpRows.filter(
      (r) => r.solNumber != null && normalizeSolNumber(r.solNumber) === key.sol,
    );
    if (bySol.length === 0) return { kind: "none" };
    if (bySol.length > 1) {
      return {
        kind: "ambiguous",
        reason: `sol_number ${key.sol} matches ${bySol.length} canonical rows`,
        fpIds: bySol.map((r) => r.id),
      };
    }
    const fp = bySol[0];
    if (key.notice && fp.noticeId && matchKey(fp.noticeId, null).notice !== key.notice) {
      return {
        kind: "ambiguous",
        reason: `sol_number matches but notice_ids differ (${key.notice} vs ${fp.noticeId})`,
        fpIds: [fp.id],
      };
    }
    return { kind: "match", fpId: fp.id, matchedOn: "sol_number" };
  }

  return { kind: "none" };
}

export type LinkCandidate = { microId: string; fpId: string; matchedOn: "notice_id" | "sol_number" };
export type AmbiguousLink = { microId: string; reason: string; fpIds: string[] };

/** Batch resolveLink over the staging rows. Unmatched rows simply do not appear. */
export function linkCandidates(
  microRows: IdentityRow[],
  fpRows: IdentityRow[],
): { links: LinkCandidate[]; ambiguous: AmbiguousLink[] } {
  const links: LinkCandidate[] = [];
  const ambiguous: AmbiguousLink[] = [];
  for (const m of microRows) {
    const res = resolveLink(m, fpRows);
    if (res.kind === "match") links.push({ microId: m.id, fpId: res.fpId, matchedOn: res.matchedOn });
    else if (res.kind === "ambiguous") ambiguous.push({ microId: m.id, reason: res.reason, fpIds: res.fpIds });
  }
  return { links, ambiguous };
}

// --- State agreement ---------------------------------------------------------
//
// A linked pair "conflicts" when the two records give a human materially
// different answers. Each side maps to a coarse stance:
//   untouched — nobody has looked (fp discovered, micro new)
//   working   — being pursued but nothing sent (fp triage/drafting/awaiting,
//               micro reviewing/drafting)
//   committed — something went out the door (fp submitted/qa/closed_*,
//               micro submitted/won)
//   dead      — deliberately killed (fp triaged_nobid/withdrawn, micro passed)
//
// Conflict rules:
//   staging untouched vs ANY canon state
//                                -> agree — a staging row at "new" is the
//                                   sweep saying "I have not judged this";
//                                   the absence of an opinion cannot disagree
//                                   with a decision. This generalises the old
//                                   "normal promotion lag" carve-out (working
//                                   vs untouched) to every canon stance: the
//                                   sweep re-listing an already-resolved
//                                   solicitation is lag, not disagreement.
//                                   DIRECTIONAL on purpose — the reverse
//                                   (canon untouched vs a real staging
//                                   opinion) still conflicts below; that
//                                   asymmetry is how the two Nepal
//                                   submitted-vs-passed errors surfaced.
//   dead vs anything-not-dead    -> CONFLICT (pursue-vs-killed: VISN 16)
//   micro committed vs fp untouched
//                                -> CONFLICT (staging bid what canon never
//                                   triaged — the directional counterpart)
//   both dead                    -> agree (fp triaged_nobid / micro passed)
//   committed vs working         -> agree — both sides progressing
//   unknown status on either side-> CONFLICT (never silently classified —
//                                   checked FIRST, so an unrecognised canon
//                                   status is flagged even against staging
//                                   "new": we cannot classify what we cannot
//                                   read)

export type StateStance = "untouched" | "working" | "committed" | "dead" | "unknown";

const FP_STANCE: Record<string, StateStance> = {
  discovered: "untouched",
  triaged_bid: "working",
  triaged_watch: "working",
  drafting: "working",
  awaiting_approval: "working",
  submitted: "committed",
  qa_open: "committed",
  closed_won: "committed",
  closed_lost: "committed",
  closed_no_award: "committed",
  triaged_nobid: "dead",
  withdrawn: "dead",
};

const MICRO_STANCE: Record<string, StateStance> = {
  new: "untouched",
  reviewing: "working",
  drafting: "working",
  submitted: "committed",
  won: "committed",
  passed: "dead",
};

export function fpStance(status: string): StateStance {
  return FP_STANCE[status] ?? "unknown";
}

export function microStance(disposition: string): StateStance {
  return MICRO_STANCE[disposition] ?? "unknown";
}

export function statesConflict(fpStatus: string, microDisposition: string): boolean {
  const fp = fpStance(fpStatus);
  const micro = microStance(microDisposition);
  if (fp === "unknown" || micro === "unknown") return true;
  // Staging "untouched" is the absence of an opinion, not an opinion — it
  // agrees with everything. Deliberately NOT symmetric: fp "untouched" gets
  // no such pass, so a real staging opinion (committed/dead) against an
  // untriaged canon row still conflicts below.
  if (micro === "untouched") return false;
  if (fp === "dead" || micro === "dead") return fp !== micro;
  if (micro === "committed" && fp === "untouched") return true;
  return false;
}

// Proposal Memory reuse controls (V4.1 §14.9).
//
// "Raw drafts and model output must not become authoritative evidence
// automatically." A block in the library is not automatically safe to put in
// front of a funder: it can be unapproved, expired, marked DO_NOT_REUSE,
// superseded, restricted for that specific funder, or too confidential for an
// external document.
//
// Pure — no database, no clock beyond the `now` passed in — so every rule is
// unit-tested. lib/boilerplate.ts filters retrieval through eligibleForReuse().

export const APPROVAL_STATUSES = ["unreviewed", "needs_review", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const CONFIDENTIALITY_LEVELS = ["public", "internal", "confidential"] as const;
export type Confidentiality = (typeof CONFIDENTIALITY_LEVELS)[number];

export type ReuseCandidate = {
  key: string;
  approvalStatus: ApprovalStatus;
  effectiveFrom: number | null;
  expiresAt: number | null;
  confidentiality: Confidentiality;
  restrictedFunders: string[];
  doNotReuse: boolean;
  doNotReuseReason: string | null;
  supersededBy: string | null;
};

export type ReuseContext = {
  now: number;
  /** Funder/customer this draft is aimed at, when known. */
  funder?: string | null;
  /** True when the block will leave the building (a submitted proposal). */
  external?: boolean;
};

export type ReuseVerdict = { eligible: true } | { eligible: false; reason: string };

function normalizeFunder(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * May this block be reused in this context?
 *
 * Checks run worst-consequence first, so the reason a human sees is the most
 * serious one rather than whichever happened to be evaluated first.
 */
export function eligibleForReuse(block: ReuseCandidate, ctx: ReuseContext): ReuseVerdict {
  if (block.doNotReuse) {
    return {
      eligible: false,
      reason: block.doNotReuseReason
        ? `Marked DO_NOT_REUSE: ${block.doNotReuseReason}`
        : "Marked DO_NOT_REUSE.",
    };
  }

  if (block.supersededBy) {
    return { eligible: false, reason: `Superseded by "${block.supersededBy}".` };
  }

  if (block.approvalStatus === "rejected") {
    return { eligible: false, reason: "Rejected in review." };
  }
  if (block.approvalStatus !== "approved") {
    return { eligible: false, reason: `Not approved (${block.approvalStatus}).` };
  }

  if (block.expiresAt != null && ctx.now > block.expiresAt) {
    return { eligible: false, reason: `Expired — content is no longer current.` };
  }
  if (block.effectiveFrom != null && ctx.now < block.effectiveFrom) {
    return { eligible: false, reason: `Not yet effective.` };
  }

  if (ctx.funder && block.restrictedFunders.length) {
    const target = normalizeFunder(ctx.funder);
    const hit = block.restrictedFunders.find((f) => {
      const r = normalizeFunder(f);
      return r === target || target.includes(r) || r.includes(target);
    });
    if (hit) return { eligible: false, reason: `Restricted for this funder (${hit}).` };
  }

  if (ctx.external && block.confidentiality === "confidential") {
    return { eligible: false, reason: "Confidential — not permitted in an external document." };
  }

  return { eligible: true };
}

/** Split a candidate list into what may be used and what was withheld, with reasons. */
export function partitionForReuse<T extends ReuseCandidate>(
  blocks: T[],
  ctx: ReuseContext,
): { usable: T[]; withheld: Array<{ block: T; reason: string }> } {
  const usable: T[] = [];
  const withheld: Array<{ block: T; reason: string }> = [];
  for (const b of blocks) {
    const v = eligibleForReuse(b, ctx);
    if (v.eligible) usable.push(b);
    else withheld.push({ block: b, reason: v.reason });
  }
  return { usable, withheld };
}

/** Content hash for change detection and supersession bookkeeping. */
export function contentHash(body: string): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(body.replace(/\s+/g, " ").trim(), "utf8").digest("hex");
}

export function isApprovalStatus(s: unknown): s is ApprovalStatus {
  return typeof s === "string" && (APPROVAL_STATUSES as readonly string[]).includes(s);
}

export function isConfidentiality(s: unknown): s is Confidentiality {
  return typeof s === "string" && (CONFIDENTIALITY_LEVELS as readonly string[]).includes(s);
}

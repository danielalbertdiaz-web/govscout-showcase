// R2 — Pools activation (pure, 1.6-safe, DRAFT-only).
//
// A pool is money that already exists and ISN'T moving — an unspent federal
// balance, a settlement fund, an idle allocation. Unlike a grant there is no
// application to write; someone must DECIDE to spend it. So the plays are:
//
//   HOLDER PLAY  — write to the agency/municipality sitting on the balance:
//                  "this money exists, here is a program shape, we can help
//                  you design the solicitation." (Feeds the R3 RFP builder.)
//   PARTNER PLAY — write to an aligned non-profit: "this money exists in your
//                  county; you advocate for it locally — and are a natural
//                  recipient — while Acme handles program design + compliance."
//
// Both are sanitized DRAFTS for review. NOTHING here sends.

import { sanitizePartnerCopy, type Redaction } from "./partner-copy";
import type { FundingPool } from "./pools-types";

export type ComposedPoolOutreach = {
  subject: string;
  markdown: string;
  redactions: Redaction[];
  safe: boolean;
};

function moneyLine(pool: FundingPool): string {
  if (pool.unspentAmount) return `${pool.unspentAmount} in unspent funds`;
  if (pool.allocatedAmount) return `an allocation of ${pool.allocatedAmount}`;
  return "a significant unobligated balance";
}

function finish(subject: string, body: string): ComposedPoolOutreach {
  const sanitized = sanitizePartnerCopy(body);
  return {
    subject,
    markdown: sanitized.clean,
    redactions: sanitized.redactions,
    safe: sanitized.redactions.length === 0,
  };
}

/** HOLDER PLAY — to the agency/municipality holding the funds. */
export function composePoolHolderOutreach(
  pool: FundingPool,
  opts: { senderName?: string } = {},
): ComposedPoolOutreach {
  const sender = opts.senderName?.trim() || "the operator";
  const holder = pool.agency?.trim() || pool.jurisdiction?.trim() || "your office";
  const where = pool.jurisdiction?.trim() ? ` in ${pool.jurisdiction.trim()}` : "";
  const deadline = pool.deadlineLabel?.trim() || pool.deadlineDate?.trim();

  const body = [
    `Dear ${holder} team,`,
    ``,
    `I lead Acme Consulting, a New Jersey-based firm specializing in behavioral health, substance-use recovery, and public program delivery. We track public funding flows${where}, and our research shows ${moneyLine(pool)} associated with **${pool.name}**.`,
    ``,
    `Balances like this usually stay parked for one reason: standing up a compliant program — needs assessment, scope of services, a defensible solicitation, reporting structure — is real work for a lean public staff. That is exactly the work we do.`,
    ``,
    `We would welcome a brief conversation about how these funds could reach the community they were intended for. We can bring a draft program framework and a model scope of services to the first meeting, at no cost and no obligation — it is often easier to react to a document than to start from a blank page.`,
    deadline ? `\nWe are mindful that ${deadline} may bear on the timeline, so we wanted to reach out promptly.` : ``,
    ``,
    `Would 20 minutes in the next two weeks be possible?`,
    ``,
    `Respectfully,`,
    `${sender}`,
    `Acme Consulting`,
  ]
    .filter((l) => l !== ``  || true)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return finish(`${moneyLine(pool)} — ${pool.name}: program design support`, body);
}

/** PARTNER PLAY — to a non-profit that could receive the funds and advocate locally. */
export function composePoolPartnerOutreach(
  pool: FundingPool,
  org: { name: string; focusAreas?: string[] },
  opts: { senderName?: string; knownPartner?: boolean } = {},
): ComposedPoolOutreach {
  const sender = opts.senderName?.trim() || "the operator";
  const holder = pool.agency?.trim() || pool.jurisdiction?.trim() || "the administering agency";
  const focus = (org.focusAreas ?? []).map((f) => f.replace(/_/g, " ")).filter(Boolean).slice(0, 3);
  const opener = opts.knownPartner
    ? `I hope you're well — our funding research surfaced something I wanted to put in front of you while it is still quiet.`
    : `I lead Acme Consulting, a New Jersey-based firm focused on behavioral health and public program delivery. Our funding research surfaced something that looks tailor-made for ${org.name}.`;

  const body = [
    `Hi ${org.name} team,`,
    ``,
    opener,
    ``,
    `**${pool.name}** — ${holder} is holding ${moneyLine(pool)}${pool.jurisdiction ? ` (${pool.jurisdiction})` : ""}. This is not a posted opportunity yet; the money is allocated but not moving, which is the best possible time to engage.`,
    ``,
    `${focus.length ? `Given your work in ${focus.join(", ")}, ` : ``}organizations like ${org.name} are exactly who these funds are meant to reach — and a credible local voice asking "what is the plan for this balance?" is often what gets it moving. The shape we'd propose: ${org.name} engages ${holder} as the community partner and prospective program operator; Acme Consulting supports with program design, the funding case, and grant/contract compliance once dollars flow.`,
    ``,
    `Could we find 20 minutes to compare notes? We'll bring the funding detail and a one-page program concept.`,
    ``,
    `Best,`,
    `${sender}`,
    `Acme Consulting`,
  ].join("\n");

  return finish(`${moneyLine(pool)} sitting with ${holder} — a fit for ${org.name}`, body);
}

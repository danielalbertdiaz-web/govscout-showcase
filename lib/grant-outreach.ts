// S1 — grant-teaming outreach composer (pure, 1.6-safe, DRAFT-only).
//
// The third link in the search → partner → approach chain: given a grant and
// a recommended org, compose the "let's pursue this together" email. Mirrors
// composeTeamingOutreach: sanitized via 1.6, returned as a DRAFT — the
// operator copies it or opens their own mail client. NOTHING sends.

import { sanitizePartnerCopy, type Redaction } from "./partner-copy";

export type GrantOutreachInput = {
  orgName: string;
  /** Why they were recommended — matched focus areas, woven into the pitch. */
  focusAreas?: string[];
  grantTitle: string;
  agency?: string | null;
  deadline?: string | null;
  url?: string | null;
  senderName?: string;
  /** True when the org is an existing partner (warmer opener). */
  knownPartner?: boolean;
};

export type ComposedGrantOutreach = {
  subject: string;
  /** Partner-safe markdown DRAFT — review, then copy/send by hand. */
  markdown: string;
  redactions: Redaction[];
  safe: boolean;
};

// grants.gov titles carry HTML entities (&ndash;, &amp;) — decode the common
// ones so they never reach an email body.
function decodeEntities(text: string): string {
  return text
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

export function composeGrantOutreach(rawInput: GrantOutreachInput): ComposedGrantOutreach {
  const input = { ...rawInput, grantTitle: decodeEntities(rawInput.grantTitle) };
  const sender = input.senderName?.trim() || "the operator";
  const focus = (input.focusAreas ?? [])
    .map((f) => f.replace(/_/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  const agencyLine = input.agency?.trim() ? ` from ${input.agency.trim()}` : "";
  const deadlineLine = input.deadline?.trim()
    ? `Applications are due ${input.deadline.trim()}, so there is time to scope this properly if we move soon.`
    : "We are tracking the application window and there is time to scope this properly.";
  const opener = input.knownPartner
    ? `I hope you're well — reaching out because a funding opportunity crossed our radar that looks like a strong fit for what we've discussed working on together.`
    : `I lead Acme Consulting, a New Jersey-based firm focused on behavioral health, substance-use recovery, and program delivery. A funding opportunity crossed our radar that looks like a strong fit for ${input.orgName}.`;
  const fitLine = focus.length
    ? `Given ${input.orgName}'s work in ${focus.join(", ")}, this looks squarely in your lane — and it is exactly the kind of program Acme supports as a delivery partner: program management, evaluation and reporting, and grant administration.`
    : `It looks squarely in your lane — and it is exactly the kind of program Acme supports as a delivery partner: program management, evaluation and reporting, and grant administration.`;

  const body = [
    `Hi ${input.orgName} team,`,
    ``,
    opener,
    ``,
    `**${input.grantTitle}**${agencyLine}${input.url ? ` — ${input.url}` : ""}`,
    ``,
    fitLine,
    ``,
    `The shape we'd propose: ${input.orgName} applies as the lead applicant; Acme Consulting joins the application as the implementation and compliance partner, which strengthens the organizational-capacity and evaluation sections reviewers score hardest. ${deadlineLine}`,
    ``,
    `Would a 20-minute call this week or next make sense to pressure-test the fit? Happy to share a one-page capability summary beforehand.`,
    ``,
    `Best,`,
    `${sender}`,
    `Acme Consulting`,
  ].join("\n");

  const sanitized = sanitizePartnerCopy(body);
  return {
    subject: `Teaming on ${input.grantTitle}${agencyLine ? ` (${input.agency?.trim()})` : ""}`,
    markdown: sanitized.clean,
    redactions: sanitized.redactions,
    safe: sanitized.redactions.length === 0,
  };
}

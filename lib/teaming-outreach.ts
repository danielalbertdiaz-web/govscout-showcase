// Item 5.2 — teaming outreach template generator (pure, 1.6-safe).
//
// Composes a "we'd like to team with you on X" DRAFT email to a prime. Mirrors
// the 4.3 cold-intro composer: every body is routed through the 1.6 sanitizer
// and the output is a DRAFT for review only. NOTHING here sends anything — the
// caller saves it for the operator to read, edit, and send by hand.

import { sanitizePartnerCopy, type Redaction } from "./partner-copy";
import type { TeamingNotice } from "./teaming-sources/types";

export type TeamingOutreachContext = {
  senderName?: string;
  /** What Acme/TechPartners brings as a sub — the value proposition line. */
  capabilities?: string[];
  /** Optional named contact at the prime, if known. */
  primeContactName?: string | null;
};

export type ComposedTeamingOutreach = {
  /** Partner-safe markdown DRAFT — reviewed and sent by hand, never auto-sent. */
  markdown: string;
  redactions: Redaction[];
  safe: boolean;
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0]?.replace(/[,.\-]+$/, "") || name.trim() || "there";
}

function clip(text: string | null | undefined, max = 280): string | null {
  if (!text) return null;
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max).trim()}…` : t;
}

// Compose a teaming-interest draft for one notice. Greeting prefers a named
// contact, else the prime org, else a neutral opener. Whole body is sanitized.
export function composeTeamingOutreach(
  notice: TeamingNotice,
  ctx: TeamingOutreachContext = {},
): ComposedTeamingOutreach {
  const sender = ctx.senderName?.trim() || "Acme Consulting";
  const capabilities =
    (ctx.capabilities ?? [])
      .map((c) => c.trim().replace(/_/g, " "))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ") || "behavioral-health program delivery and management consulting";

  const greetTarget = ctx.primeContactName?.trim()
    ? firstName(ctx.primeContactName)
    : notice.prime?.trim() || "team";
  const opportunityRef = notice.prime
    ? `${notice.prime}'s pursuit of ${notice.title}`
    : notice.title;
  const scope = clip(notice.description);
  const deadlineLine = notice.responseDeadline
    ? `We understand responses are due by ${notice.responseDeadline}, so we wanted to reach out early.`
    : `We'd welcome the chance to connect before the response window closes.`;

  const lines: string[] = [
    `<!-- DRAFT — teaming outreach for review. NOTHING HAS BEEN SENT. -->`,
    `<!-- Notice: ${notice.noticeId}${notice.agency ? ` · ${notice.agency}` : ""} -->`,
    ``,
    `Hi ${greetTarget},`,
    ``,
    `I'm reaching out from ${sender} regarding ${opportunityRef}. We're a small firm specializing in ${capabilities}, and we'd be interested in teaming with you as a subcontractor on this effort.`,
    ``,
  ];
  if (scope) {
    lines.push(`From the notice, the scope around "${scope}" lines up closely with work we deliver.`, ``);
  }
  lines.push(
    deadlineLine,
    ``,
    `Would you be open to a brief call to explore whether our capabilities could strengthen your response?`,
    ``,
    `Best,`,
    sender,
  );

  const raw = lines.join("\n") + "\n";
  const result = sanitizePartnerCopy(raw);
  return { markdown: result.clean, redactions: result.redactions, safe: result.safe };
}

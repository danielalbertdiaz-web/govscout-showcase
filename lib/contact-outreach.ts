// Item 4.3 — cold-outreach pure core (enum, lead mapping, dedupe, intro draft).
//
// Pure + fully testable: no db, no fs, no model. The thin db/route/import shells
// import from here. Covers (a) the outreach pipeline status taxonomy, (b) mapping
// a LinkedIn connection record to a contact-create input, (c) a stable dedupe key
// so re-running the import doesn't duplicate leads, and (d) composing a cold-intro
// DRAFT that is always run through the 1.6 sanitizer. NOTHING here sends anything.

import { sanitizePartnerCopy, type Redaction } from "./partner-copy";
import type { Connection } from "./connections";

// Orthogonal to `relationship_quality` (CRM warmth). This is the outreach
// *pipeline* state: where a lead sits in the cold→partnered funnel.
export const OUTREACH_STATUSES = [
  "not_contacted",
  "contacted",
  "responded",
  "not_interested",
  "partnered",
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export function isOutreachStatus(s: unknown): s is OutreachStatus {
  return typeof s === "string" && (OUTREACH_STATUSES as readonly string[]).includes(s);
}

export const OUTREACH_STATUS_LABELS: Record<OutreachStatus, string> = {
  not_contacted: "Not contacted",
  contacted: "Contacted",
  responded: "Responded",
  not_interested: "Not interested",
  partnered: "Partnered",
};

export const DEFAULT_OUTREACH_STATUS: OutreachStatus = "not_contacted";

// --- LinkedIn lead -> contact mapping --------------------------------------

// The fields the importer produces for createContact (minus userEmail, which the
// impure shell injects). Kept structural so the mapping is unit-testable.
export type LinkedinContactDraft = {
  name: string;
  title: string | null;
  agency: string | null; // we map the connection's company here (CRM "org")
  linkedinUrl: string | null;
  tags: string[];
  notes: string | null;
  source: "linkedin";
  raw: Record<string, unknown>;
};

// Map one normalized Connection to a contact-create draft. Industry keywords +
// potential partnerships become tags so the /contacts filters can slice by them.
export function linkedinConnectionToContactDraft(conn: Connection): LinkedinContactDraft {
  const tags = Array.from(
    new Set([...(conn.industry_keywords ?? []), ...(conn.potential_partnerships ?? [])]),
  )
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    name: conn.name,
    title: conn.title || null,
    agency: conn.company || null,
    linkedinUrl: null, // the index carries no profile URL today
    tags,
    notes: conn.description || null,
    source: "linkedin",
    raw: { connectionId: conn.id, connectionDate: conn.connection_date },
  };
}

// A stable, case-insensitive identity for de-duping a lead against existing
// contacts. Prefer a LinkedIn URL; fall back to name+company. Re-running the
// import is therefore idempotent.
export function contactDedupeKey(input: {
  linkedinUrl?: string | null;
  name?: string | null;
  agency?: string | null;
}): string {
  const url = input.linkedinUrl?.trim().toLowerCase();
  if (url) return `url:${url}`;
  const name = (input.name ?? "").trim().toLowerCase();
  const org = (input.agency ?? "").trim().toLowerCase();
  return `nameorg:${name}|${org}`;
}

// --- Cold intro DRAFT (1.6-safe) -------------------------------------------

export type ColdIntroContext = {
  // Optional opportunity hook to anchor the intro; omitted => generic network note.
  opportunityTitle?: string | null;
  opportunitySummary?: string | null;
  senderName?: string;
};

export type ComposedColdIntro = {
  /** Partner-safe markdown DRAFT — reviewed and sent by hand, never auto-sent. */
  markdown: string;
  redactions: Redaction[];
  safe: boolean;
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0]?.replace(/[,.\-]+$/, "") || name.trim() || "there";
}

function firstSentence(text: string | null | undefined, max = 240): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^.*?[.!?](?:\s|$)/);
  const s = (m ? m[0] : t).trim();
  return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

// Compose a cold-outreach intro draft for one contact. Anchored on an
// opportunity when given, otherwise a relationship-opener. Whole body sanitized
// (1.6) — even though contacts carry no internal framing, the chokepoint is
// uniform across every partner/lead-facing emit.
export function composeColdIntro(
  contact: { name: string; title: string | null; agency: string | null; tags: string[] },
  ctx: ColdIntroContext = {},
): ComposedColdIntro {
  const sender = ctx.senderName?.trim() || "Acme Consulting";
  const who = firstName(contact.name);
  const focus =
    contact.tags.slice(0, 2).map((t) => t.replace(/_/g, " ")).join(" and ") ||
    (contact.title ? contact.title.toLowerCase() : "your work");

  const lines: string[] = [
    `<!-- DRAFT — cold intro for review. NOTHING HAS BEEN SENT. -->`,
    `<!-- Contact: ${contact.name}${contact.agency ? ` · ${contact.agency}` : ""} -->`,
    ``,
    `Hi ${who},`,
    ``,
  ];

  if (ctx.opportunityTitle || ctx.opportunitySummary) {
    const hook = firstSentence(ctx.opportunitySummary) ?? ctx.opportunityTitle ?? "a current funding opportunity";
    lines.push(
      `I'm reaching out from ${sender} — we're pulling together a response to ${ctx.opportunityTitle ?? "a federal opportunity"} and your background in ${focus} stood out as a strong fit.`,
      ``,
      hook,
      ``,
      `Would you be open to a quick call this week to see whether there's a fit to pursue it together?`,
    );
  } else {
    lines.push(
      `I'm with ${sender} — we help organizations win and deliver public-sector grants and RFPs, and your work in ${focus} looks closely aligned with the partners we team with.`,
      ``,
      `Would you be open to a short introductory call to compare notes and see where we might collaborate?`,
    );
  }

  lines.push(``, `Best,`, sender);

  const raw = lines.join("\n") + "\n";
  const result = sanitizePartnerCopy(raw);
  return { markdown: result.clean, redactions: result.redactions, safe: result.safe };
}

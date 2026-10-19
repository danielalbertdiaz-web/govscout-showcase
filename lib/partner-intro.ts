// Item 4.2 — pre-drafted partner intro (pure template + 1.6 sanitize).
//
// Composes a teaming-intro draft for the #1-ranked partner on an opportunity.
// NOTHING AUTO-SENDS: this returns markdown the operator reviews and sends by
// hand (the route saves it to outreach/{rfp_id}/{partner}-intro.md). The whole
// body is run through `sanitizePartnerCopy` so no internal framing can leak —
// and we only ever read the partner-FACING projection of the profile.

import { sanitizePartnerCopy, type Redaction } from "./partner-copy";
import { partnerFacingProfile, type PartnerProfile } from "./partner-profiles";
import type { PartnerFit } from "./partner-fit";

export type IntroOpportunity = {
  id: string;
  title: string;
  agency: string | null;
  deadline: string | null;
  summary: string | null;
};

export type ComposedIntro = {
  /** The cleaned, partner-safe markdown — ready to review (NOT auto-sent). */
  markdown: string;
  /** Anything the 1.6 sanitizer stripped — surfaced to the operator. */
  redactions: Redaction[];
  safe: boolean;
};

function firstSentence(text: string | null, max = 280): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^.*?[.!?](?:\s|$)/);
  const s = (m ? m[0] : trimmed).trim();
  return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

// Build the intro markdown from the partner-FACING profile only. The fit
// reasons explain (to the operator, in the draft preamble) why this partner was
// surfaced; the body itself is a partner-ready outreach note.
export function composePartnerIntro(
  profileFull: PartnerProfile,
  opp: IntroOpportunity,
  fit: PartnerFit,
): ComposedIntro {
  const p = partnerFacingProfile(profileFull); // sanitized, facing-only
  const contactName = p.contact.human ? p.contact.human.split(/\s+/)[0] : "team";

  const oppLine = [opp.agency, opp.title].filter(Boolean).join(" — ");
  const hook = firstSentence(opp.summary) ?? "a current funding opportunity that aligns with your work";

  const capLine = p.capabilities.length
    ? `Your team's strengths in ${p.capabilities.slice(0, 3).map((c) => c.replace(/_/g, " ")).join(", ")} map directly to what this opportunity calls for.`
    : "Your team's capabilities map well to what this opportunity calls for.";

  const ppLine = p.pastPerformance.length
    ? `Your past work${p.pastPerformance[0].client ? ` with ${p.pastPerformance[0].client}` : ""} is exactly the kind of track record this funder wants to see.`
    : "";

  const dealLine = p.dealStructure
    ? `On structure, we'd propose to continue our usual arrangement (${p.dealStructure}); happy to talk specifics.`
    : "Happy to talk through structure in a quick call.";

  const deadlineLine = opp.deadline
    ? `The submission deadline is ${opp.deadline}, so I wanted to reach out early.`
    : "I wanted to reach out early so we have room to shape a strong submission.";

  // Operator-only preamble (fenced, clearly labeled DRAFT / not sent). The fit
  // rationale lives here, not in the partner-facing body.
  const preamble = [
    `<!-- DRAFT — partner intro for review. NOTHING HAS BEEN SENT. -->`,
    `<!-- Opportunity: ${opp.id} · Partner: ${p.id} (${p.name}) · Fit: ${fit.fitScore}/100 -->`,
    fit.reasons.length ? `<!-- Why this partner: ${fit.reasons.join(" | ")} -->` : "",
    fit.risks.length ? `<!-- Watch-outs: ${fit.risks.join(" | ")} -->` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const subject = `Teaming on ${oppLine || opp.title}`;

  const body = [
    `**To:** ${p.contact.human ?? p.name}${p.contact.email ? ` <${p.contact.email}>` : ""}`,
    `**Subject:** ${subject}`,
    ``,
    `Hi ${contactName},`,
    ``,
    `I'm reaching out about ${oppLine || opp.title} — ${hook} I think this is a strong fit for a joint pursuit.`,
    ``,
    capLine,
    ppLine,
    ``,
    deadlineLine,
    ``,
    dealLine,
    ``,
    `Would you have time this week for a short call to decide whether to go after it together?`,
    ``,
    `Best,`,
    `Acme Consulting`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  const raw = `${preamble}\n\n${body}\n`;
  const result = sanitizePartnerCopy(raw);
  return { markdown: result.clean, redactions: result.redactions, safe: result.safe };
}

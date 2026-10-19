// R3 — RFP Builder: turn a parked funding pool into a solicitation the
// holder could actually issue.
//
// The operator's play: when a municipality or state agency is sitting on an
// unspent balance, the blocker is usually the SOLICITATION — somebody has to
// write the scope, the deliverables, the evaluation criteria. If Acme hands
// them a credible draft, the funds start moving, and Acme is the firm that
// understands the program best when the RFP posts.
//
// HONESTY GUARDRAIL (rendered with every RFP): many jurisdictions treat
// drafting a solicitation and then bidding on it as an organizational
// conflict of interest (OCI). The draft therefore positions Acme's help as
// "program design assistance," writes NEUTRAL evaluation criteria (no
// vendor-shaped requirements), and the UI tells the operator to disclose
// the assistance and check local procurement rules before bidding.
//
// Two tiers:
//   buildRfpSkeleton(pool)  — pure template, instant, works with no model.
//   buildRfpPrompt(pool)    — prompt for the local Claude CLI to write the
//                             full document (draft-pipeline pattern); the
//                             route falls back to the skeleton if the CLI
//                             is unavailable.

import type { FundingPool } from "./pools-types";

export const RFP_OCI_NOTICE =
  "Drafted with program-design assistance from Acme Consulting. NOTE TO OPERATOR: before Acme bids on any resulting solicitation, disclose this assistance to the issuing agency and confirm local organizational-conflict-of-interest (OCI) rules — some jurisdictions restrict or condition a drafter's participation.";

function money(pool: FundingPool): string {
  return pool.unspentAmount || pool.allocatedAmount || "[FUNDING AMOUNT — confirm with agency]";
}

function issuer(pool: FundingPool): string {
  return pool.agency?.trim() || pool.jurisdiction?.trim() || "[ISSUING AGENCY]";
}

/** Pure, instant draft — a credible starting document with no model call. */
export function buildRfpSkeleton(pool: FundingPool): string {
  const amt = money(pool);
  const agency = issuer(pool);
  const where = pool.jurisdiction?.trim() || "[JURISDICTION]";
  return [
    `# DRAFT REQUEST FOR PROPOSALS`,
    `## ${pool.name} — Program Implementation Services`,
    ``,
    `**Issuing agency:** ${agency}`,
    `**Funding source:** ${pool.name}${pool.source ? ` (${pool.source})` : ""}`,
    `**Available funding:** ${amt}`,
    `**Status:** DRAFT for agency review — not issued`,
    ``,
    `### 1. Background and purpose`,
    `${agency} administers ${amt} associated with ${pool.name}. These funds are currently unobligated. This Request for Proposals seeks qualified organizations to design and deliver programming that puts these funds to their intended use in ${where}.`,
    pool.fitSummary ? `\nProgram context: ${pool.fitSummary}` : ``,
    ``,
    `### 2. Scope of services`,
    `The selected respondent will:`,
    `- Conduct a needs assessment covering the affected population and service gaps`,
    `- Design a program plan with measurable objectives, staffing, and timeline`,
    `- Deliver services per the approved plan, with required licensures and insurance`,
    `- Stand up data collection, outcome reporting, and fiscal compliance consistent with the funding source's requirements`,
    ``,
    `### 3. Deliverables and timeline`,
    `- Month 1–2: needs assessment and finalized program plan`,
    `- Month 3: program launch`,
    `- Quarterly: outcome and expenditure reports to ${agency}`,
    `- [PERIOD OF PERFORMANCE — typically 12–36 months]`,
    ``,
    `### 4. Eligibility`,
    `Non-profit organizations, units of local government, and qualified for-profit firms with demonstrated experience in the program area. Teaming arrangements are permitted and must be disclosed.`,
    ``,
    `### 5. Evaluation criteria (100 points)`,
    `- Demonstrated experience and past performance — 30`,
    `- Program design quality and feasibility — 30`,
    `- Organizational capacity and key personnel — 20`,
    `- Budget reasonableness and cost effectiveness — 10`,
    `- Local presence and community partnerships — 10`,
    ``,
    `### 6. Submission`,
    `- [SUBMISSION DEADLINE — typically 30–45 days from issuance]`,
    `- [CONTACT / PORTAL]`,
    `- Questions period closes [DATE]; answers published as an addendum.`,
    ``,
    `---`,
    `*${RFP_OCI_NOTICE}*`,
  ].join("\n");
}

/**
 * The local CLI inherits the operator's output style and may wrap the
 * document in editorial chrome (★ Insight blocks, preamble). The RFP is a
 * deliverable for an AGENCY — keep only the document: everything from the
 * first markdown H1 onward, minus any trailing insight block.
 */
export function cleanRfpOutput(text: string): string {
  let t = text.trim();
  const h1 = t.search(/^#\s+/m);
  if (h1 > 0) t = t.slice(h1);
  // Drop any insight block that survived (start-of-doc or trailing).
  t = t.replace(/`?★ Insight ─+`?[\s\S]*?─{10,}`?/g, "").trim();
  return t;
}

/** Prompt pair for the local Claude CLI to write the full document. */
export function buildRfpPrompt(pool: FundingPool): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: [
      `You write municipal/state procurement documents. Produce a complete, professional DRAFT Request for Proposals in markdown that a public agency could review and issue with minimal editing.`,
      `Rules:`,
      `- Use ONLY the facts provided; mark anything unknown as [BRACKETED PLACEHOLDER] rather than inventing names, dates, statutes, or amounts.`,
      `- Evaluation criteria must be NEUTRAL and standard for public procurement — do not tailor requirements toward any particular vendor.`,
      `- Include: background citing the unspent balance, scope of services, deliverables and timeline, eligibility, evaluation criteria with point weights, budget guidance, submission instructions, and standard public-contract terms (insurance, non-discrimination, records access, termination).`,
      `- Tone: plain, formal, administrable. Length: 900–1400 words.`,
      `- End with this exact italicized line: *${RFP_OCI_NOTICE}*`,
    ].join("\n"),
    userPrompt: [
      `Funding pool facts:`,
      `- Name: ${pool.name}`,
      `- Issuing agency: ${issuer(pool)}`,
      `- Jurisdiction: ${pool.jurisdiction ?? "[unknown]"}`,
      `- Available funding: ${money(pool)}`,
      `- Source: ${pool.source ?? "[unknown]"}`,
      `- Deadline context: ${pool.deadlineLabel ?? pool.deadlineDate ?? "[none stated]"}`,
      `- Program context: ${pool.fitSummary ?? "[none]"}`,
      `- Strategic angle (INTERNAL — inform scope, do not quote): ${pool.wedge ?? "n/a"}`,
      ``,
      `Write the draft RFP now.`,
    ].join("\n"),
  };
}

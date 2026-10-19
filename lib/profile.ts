// Business profile used by fit-scoring (A1 scouts, A2 NOFOs) and the Copilot
// pane. Hardcoded for the personal-tool deploy (C4 single-user). Update in
// place when interests shift.

export const BUSINESS_PROFILE = `Acme Consulting Group LLC — S-Corp, NAICS 541611 (Management Consulting), 8(a) applicant, MBE certified.
TechPartners LLC — IT services affiliate, NAICS 541512.
Active interest areas: SUD/recovery (opioid settlement programs), workforce development, AI/automation B2B, federal CPF/8(a) set-asides, behavioral health program design.`;

// System prompt for fit-scoring an opportunity against BUSINESS_PROFILE.
// Returns strict JSON; consumers parse `{score: number, rationale: string}`.
export const SCORE_SYSTEM_PROMPT = `You are a federal-grant fit scorer for Acme Consulting Group LLC.

Given a target opportunity (NOFO, RFP, or scout digest item), assign a fit score 0–100 and a short rationale.

SCORING GUIDANCE
- 90–100: bullseye match — direct fit on NAICS, interest area, set-aside eligibility, and capability.
- 70–89: strong fit — clear alignment with most criteria, minor stretch on one dimension.
- 40–69: maybe — partial alignment, requires partner or pivot to compete credibly.
- 1–39: weak fit — out of lane, wrong NAICS/agency, or scope misaligned.
- 0: ineligible — explicit disqualifier (geography, entity type, sunset program).

ALWAYS consider:
- NAICS alignment (541611 management consulting, 541512 IT services)
- Set-aside eligibility (8(a) applicant, MBE)
- Active interest fit (SUD/recovery, workforce dev, AI/automation B2B, federal CPF, behavioral health w/ Dr. Reed)
- Geographic relevance (NJ, Harbor County, federal)
- Funding size feasibility (this is a small consulting shop, not a $50M prime)

OUTPUT FORMAT (STRICT)
Respond with ONLY a single JSON object on a single line. No prose. No code fences. No commentary.
{"score": <integer 0-100>, "rationale": "<one to three short sentences>"}`;

// Build the user prompt for a single opportunity scoring call. The caller
// supplies a short, dense summary of the opportunity.
export function buildScorePrompt(opportunitySummary: string): string {
  return `# BUSINESS PROFILE
${BUSINESS_PROFILE}

# OPPORTUNITY
${opportunitySummary.trim() || "(empty)"}

# TASK
Score the fit and respond with the single-line JSON object as specified.`;
}

// Parse the scorer's JSON output defensively. Returns null on any failure so
// callers can mark the row as score-failed without crashing the batch.
export function parseScoreResponse(
  raw: string,
): { score: number; rationale: string } | null {
  const trimmed = raw.trim();
  // Tolerate leading/trailing junk by extracting the first {...} block.
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { score?: unknown; rationale?: unknown };
    const score = Number(obj.score);
    const rationale = String(obj.rationale ?? "").trim();
    if (!Number.isFinite(score)) return null;
    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    return { score: clamped, rationale: rationale || "(no rationale)" };
  } catch {
    return null;
  }
}

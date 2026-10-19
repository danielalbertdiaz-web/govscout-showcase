// Strategic fit scoring engine — 6-criteria weighted matrix aligned with
// GOVSCOUT_ENHANCED_SPECIFICATION.md section 2.
//
// This is a rule-based fast scorer that runs without a model call. It reads
// opportunity fields directly and returns a 0–100 composite score plus a
// per-criterion breakdown that is stored in strategic_score_detail (JSON).
//
// Thresholds (spec §2 SCORING_CRITERIA.threshold):
//   pursue  ≥ 75
//   monitor ≥ 50
//   ignore  < 25
//
// The model-based scoreOpportunity() in lib/scoring.ts remains unchanged —
// strategic scoring is additive, not a replacement.

export type ScoringCriterion =
  | "naics_match"
  | "partner_capability"
  | "past_performance"
  | "certification_advantage"
  | "timeline_feasibility"
  | "renewal_probability";

export type CriterionResult = {
  criterion: ScoringCriterion;
  weight: number;
  rawScore: number; // 0–100 per criterion
  weightedScore: number; // rawScore * weight / 100
  rationale: string;
};

export type StrategicScoreResult = {
  score: number; // 0–100 composite
  recommendation: "pursue" | "monitor" | "ignore" | "ineligible";
  criteria: CriterionResult[];
  summary: string;
};

// Weights must sum to 100 (spec §2).
const WEIGHTS: Record<ScoringCriterion, number> = {
  naics_match: 25,
  partner_capability: 20,
  past_performance: 20,
  certification_advantage: 15,
  timeline_feasibility: 10,
  renewal_probability: 10,
};

import { SCOUT_PROFILES } from "./scout-profiles";

// Multi-vertical (P13): scoring used to know only Acme's consulting/IT codes and
// behavioral-health vocabulary, silently under-scoring perfect Atlas Insights (tech)
// or Brightline (awareness/marketing) opportunities. NAICS + keywords now derive from
// the scout profiles, so adding a vertical there widens scoring automatically.
const EL_NAICS = Array.from(
  new Set(["541611", "541512", ...SCOUT_PROFILES.filter((p) => p.enabled).flatMap((p) => p.naics)]),
);
const PROFILE_KEYWORDS = SCOUT_PROFILES.filter((p) => p.enabled).flatMap((p) =>
  p.keywords.map((k) => k.toLowerCase()),
);

// Keywords that suggest behavioral-health / SUD / workforce — Acme's core lanes.
const CORE_KEYWORDS = [
  "substance use",
  "sud",
  "opioid",
  "recovery",
  "behavioral health",
  "mental health",
  "workforce",
  "workforce development",
  "management consulting",
  "ai",
  "automation",
  "8(a)",
  "set-aside",
  "set aside",
  "mbe",
  "minority",
  "samhsa",
  "hrsa",
  "doj",
  "hud",
  "bja",
  "reentry",
  "drug court",
  "rural",
  "treatment",
  "prevention",
];

// Final scoring vocabulary = hand-tuned core list ∪ every enabled profile's
// keywords (tech_it adds "cybersecurity", "cloud migration", …; awareness adds
// "public awareness campaign", "media campaign", …).
const SCORING_KEYWORDS = Array.from(new Set([...CORE_KEYWORDS, ...PROFILE_KEYWORDS]));

// Agencies with strong partner alignment (Riverside / Lakeside / Atlas Insights / Brightline).
// Acronyms AND full names: grants.gov returns "Health Resources and Services
// Administration", not "HRSA" — acronym-only matching silently zeroed the
// partner signal for exactly the right agencies (found live on RCORP).
const PARTNER_ALIGNED_AGENCIES = [
  "samhsa",
  "substance abuse and mental health",
  "hrsa",
  "health resources and services",
  "doj",
  "department of justice",
  "office of justice",
  "bja",
  "bureau of justice assistance",
  "hud",
  "housing and urban development",
  "cdc",
  "centers for disease control",
  "dol",
  "department of labor",
  "employment and training administration",
];

// Programs historically associated with Harbor County / NJ track record.
const PAST_PERF_KEYWORDS = [
  "harbor county",
  "new jersey",
  "nj",
  "njdoh",
  "dmhas",
  "opioid",
  "recovery",
  "workforce",
  "management consulting",
];

// Set-aside / cert keywords.
const CERT_KEYWORDS = [
  "8(a)",
  "8a",
  "set-aside",
  "set aside",
  "mbe",
  "minority business",
  "small business",
  "disadvantaged",
  "wosb",
  "hubzone",
];

// Programs that renew annually / are known recurring.
const RECURRING_KEYWORDS = [
  "sor",
  "state opioid response",
  "ti-",
  "bhwet",
  "drug court",
  "reentry",
  "cdbg",
  "continuum of care",
  "coc",
  "workforce",
  "annual",
  "renewal",
  "recurring",
];

function normText(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function countKeywords(text: string, keywords: string[]): number {
  return keywords.filter((kw) => text.includes(kw.toLowerCase())).length;
}

// ---- Criterion scorers ----------------------------------------------------

function scoreNaicsMatch(opp: OpportunityInput): CriterionResult {
  const naicsText = normText(opp.naics);
  const body = normText(opp.title) + " " + normText(opp.summary) + " " + normText(opp.eligibility);

  // Exact NAICS match (any enabled vertical): 100.
  if (EL_NAICS.some((n) => naicsText.includes(n))) {
    return result("naics_match", 100, "Exact NAICS code match (Acme or partner vertical).");
  }
  // Core keyword hits in body: up to 80.
  const hits = countKeywords(body, SCORING_KEYWORDS);
  if (hits >= 4) return result("naics_match", 80, `Strong keyword alignment (${hits} core terms).`);
  if (hits >= 2) return result("naics_match", 60, `Moderate keyword alignment (${hits} core terms).`);
  if (hits === 1) return result("naics_match", 35, "Weak keyword alignment (1 core term).");
  return result("naics_match", 10, "No NAICS or keyword alignment found.");
}

function scorePartnerCapability(opp: OpportunityInput): CriterionResult {
  const body =
    normText(opp.title) +
    " " +
    normText(opp.agency) +
    " " +
    normText(opp.summary) +
    " " +
    normText(opp.eligibility);

  const agency = normText(opp.agency);
  const agencyMatch = PARTNER_ALIGNED_AGENCIES.some((a) => agency.includes(a));

  // Keywords requiring clinical / tech / creative partner strengths.
  const clinicalKws = ["clinical", "fqhc", "moud", "treatment", "behavioral", "health center"];
  const techKws = ["technology", "data", "telehealth", "platform", "software", "ai", "automation"];
  const marketingKws = ["outreach", "awareness", "multilingual", "media", "communication"];

  const clinHits = countKeywords(body, clinicalKws);
  const techHits = countKeywords(body, techKws);
  const mktHits = countKeywords(body, marketingKws);

  if (agencyMatch && (clinHits + techHits + mktHits) >= 2) {
    return result("partner_capability", 90, "Agency + multi-partner capability alignment.");
  }
  if (agencyMatch || (clinHits + techHits + mktHits) >= 2) {
    return result("partner_capability", 65, "Partial partner capability alignment.");
  }
  if (clinHits + techHits + mktHits >= 1) {
    return result("partner_capability", 40, "Weak partner capability signal.");
  }
  return result("partner_capability", 15, "No clear partner capability alignment.");
}

function scorePastPerformance(opp: OpportunityInput): CriterionResult {
  const body =
    normText(opp.title) +
    " " +
    normText(opp.agency) +
    " " +
    normText(opp.summary) +
    " " +
    normText(opp.eligibility);

  const hits = countKeywords(body, PAST_PERF_KEYWORDS);
  if (hits >= 3) return result("past_performance", 85, `Strong Harbor County / NJ track-record alignment (${hits} signals).`);
  if (hits >= 2) return result("past_performance", 60, `Moderate past-performance alignment (${hits} signals).`);
  if (hits === 1) return result("past_performance", 40, "Weak past-performance overlap (1 signal).");
  return result("past_performance", 15, "No past-performance overlap detected.");
}

function scoreCertificationAdvantage(opp: OpportunityInput): CriterionResult {
  const body =
    normText(opp.title) +
    " " +
    normText(opp.eligibility) +
    " " +
    normText(opp.summary);

  const hits = countKeywords(body, CERT_KEYWORDS);
  if (hits >= 2) return result("certification_advantage", 95, "Set-aside / MBE / 8(a) advantage confirmed.");
  if (hits === 1) return result("certification_advantage", 65, "Certification language present (single signal).");
  return result("certification_advantage", 25, "No set-aside or certification advantage.");
}

function scoreTimelineFeasibility(opp: OpportunityInput): CriterionResult {
  if (!opp.deadline) {
    return result("timeline_feasibility", 50, "No deadline provided — assumed feasible.");
  }
  // Parse deadline as date and compute days from now.
  const deadlineMs = Date.parse(opp.deadline);
  if (!Number.isFinite(deadlineMs)) {
    return result("timeline_feasibility", 50, "Deadline unparseable — assumed feasible.");
  }
  const daysLeft = (deadlineMs - Date.now()) / 86_400_000;
  if (daysLeft < 0) return result("timeline_feasibility", 0, "Deadline has already passed.");
  if (daysLeft < 7) return result("timeline_feasibility", 10, `Only ${Math.round(daysLeft)} days remaining — too tight.`);
  if (daysLeft < 14) return result("timeline_feasibility", 40, `${Math.round(daysLeft)} days remaining — very tight.`);
  if (daysLeft < 30) return result("timeline_feasibility", 65, `${Math.round(daysLeft)} days remaining — manageable.`);
  if (daysLeft < 60) return result("timeline_feasibility", 85, `${Math.round(daysLeft)} days remaining — comfortable.`);
  return result("timeline_feasibility", 100, `${Math.round(daysLeft)} days remaining — ample time.`);
}

function scoreRenewalProbability(opp: OpportunityInput): CriterionResult {
  const body =
    normText(opp.title) +
    " " +
    normText(opp.agency) +
    " " +
    normText(opp.summary);

  const hits = countKeywords(body, RECURRING_KEYWORDS);
  if (hits >= 2) return result("renewal_probability", 80, `Recurring program signals (${hits} keywords).`);
  if (hits === 1) return result("renewal_probability", 55, "Possible recurring program (1 signal).");
  return result("renewal_probability", 25, "No renewal / recurring signals detected.");
}

// ---- Helper ---------------------------------------------------------------

function result(criterion: ScoringCriterion, rawScore: number, rationale: string): CriterionResult {
  const weight = WEIGHTS[criterion];
  return {
    criterion,
    weight,
    rawScore,
    weightedScore: Math.round((rawScore * weight) / 100),
    rationale,
  };
}

// ---- Public API -----------------------------------------------------------

export type OpportunityInput = {
  title: string;
  agency: string | null | undefined;
  deadline: string | null | undefined;
  eligibility: string | null | undefined;
  summary: string | null | undefined;
  naics: string | null | undefined;
};

export function computeStrategicScore(opp: OpportunityInput): StrategicScoreResult {
  // Hard disqualifiers: expired deadline.
  if (opp.deadline) {
    const deadlineMs = Date.parse(opp.deadline);
    if (Number.isFinite(deadlineMs) && deadlineMs < Date.now()) {
      return {
        score: 0,
        recommendation: "ineligible",
        criteria: [],
        summary: "Opportunity deadline has already passed.",
      };
    }
  }

  const criteria: CriterionResult[] = [
    scoreNaicsMatch(opp),
    scorePartnerCapability(opp),
    scorePastPerformance(opp),
    scoreCertificationAdvantage(opp),
    scoreTimelineFeasibility(opp),
    scoreRenewalProbability(opp),
  ];

  const score = Math.round(criteria.reduce((sum, c) => sum + c.weightedScore, 0));
  const clamped = Math.max(0, Math.min(100, score));

  let recommendation: StrategicScoreResult["recommendation"];
  if (clamped >= 75) recommendation = "pursue";
  else if (clamped >= 50) recommendation = "monitor";
  else if (clamped >= 25) recommendation = "ignore";
  else recommendation = "ignore";

  const topCriteria = [...criteria]
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, 2)
    .map((c) => c.rationale)
    .join(" ");

  const summary = `Score ${clamped}/100 — ${recommendation.toUpperCase()}. ${topCriteria}`;

  return { score: clamped, recommendation, criteria, summary };
}

// Threshold labels for UI display.
export function recommendationLabel(score: number | null): string {
  if (score == null) return "Unscored";
  if (score >= 75) return "Pursue";
  if (score >= 50) return "Monitor";
  if (score >= 25) return "Low fit";
  return "Ignore";
}

export function recommendationColor(score: number | null): "green" | "yellow" | "orange" | "red" | "gray" {
  if (score == null) return "gray";
  if (score >= 75) return "green";
  if (score >= 50) return "yellow";
  if (score >= 25) return "orange";
  return "red";
}

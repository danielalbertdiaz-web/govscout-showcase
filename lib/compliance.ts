// Automated compliance validation for saved opportunities.
// Implements the VALIDATION PIPELINE from GOVSCOUT_ENHANCED_SPECIFICATION.md §3.
//
// All checks are rule-based and run synchronously without model calls.
// Results are stored as compliance_status + compliance_detail JSON on
// saved_opportunities (migration 008).

export type ComplianceCheckId =
  | "nofo_active"
  | "for_profit_eligible"
  | "deadline_sufficient"
  | "competition_feasibility";

export type CheckStatus = "pass" | "fail" | "warn" | "unknown";

export type ComplianceCheck = {
  id: ComplianceCheckId;
  label: string;
  status: CheckStatus;
  note: string;
};

export type ComplianceResult = {
  status: "pass" | "fail" | "warn" | "pending";
  checks: ComplianceCheck[];
  summary: string;
};

// ---- NOFO active check ----------------------------------------------------
// Heuristic: look for known sunset / closed language in eligibility + summary.
// A real implementation would fetch the NOFO URL to verify status; here we
// flag as 'warn' when we detect closed language vs 'pass' when open signals
// are present, and 'unknown' when there's no data to decide.

const CLOSED_SIGNALS = [
  "closed",
  "expired",
  "archived",
  "no longer accepting",
  "not accepting",
  "past deadline",
  "competition closed",
  "award made",
  "recipients announced",
];

const OPEN_SIGNALS = [
  "open",
  "accepting",
  "now accepting",
  "deadline",
  "apply by",
  "applications due",
  "solicitation",
  "nofo",
  "rfp",
  "rfa",
  "bpa",
  "forecast",
];

function checkNofoActive(opp: ComplianceInput): ComplianceCheck {
  const body = normalize(opp.summary) + " " + normalize(opp.eligibility) + " " + normalize(opp.title);

  if (CLOSED_SIGNALS.some((s) => body.includes(s))) {
    return {
      id: "nofo_active",
      label: "Funding opportunity active",
      status: "fail",
      note: "Closed / expired language detected. Verify before pursuing.",
    };
  }

  // Expired deadline check.
  if (opp.deadline) {
    const ms = Date.parse(opp.deadline);
    if (Number.isFinite(ms) && ms < Date.now()) {
      return {
        id: "nofo_active",
        label: "Funding opportunity active",
        status: "fail",
        note: `Deadline ${opp.deadline} has already passed.`,
      };
    }
  }

  if (OPEN_SIGNALS.some((s) => body.includes(s))) {
    return {
      id: "nofo_active",
      label: "Funding opportunity active",
      status: "pass",
      note: "Active opportunity signals present.",
    };
  }

  return {
    id: "nofo_active",
    label: "Funding opportunity active",
    status: "unknown",
    note: "Could not confirm active status. Verify the source URL.",
  };
}

// ---- For-profit eligibility check -----------------------------------------
// Acme Consulting is a for-profit LLC. Flag if eligibility explicitly excludes
// for-profits. Warn if it's non-profit-only. Pass if explicitly open to
// for-profits or consulting / small business.

const FP_EXCLUDE_SIGNALS = [
  "nonprofit only",
  "non-profit only",
  "501(c)(3)",
  "not for profit only",
  "must be a nonprofit",
  "must be nonprofit",
  "tax-exempt organizations only",
];

const FP_ALLOW_SIGNALS = [
  "for-profit",
  "for profit",
  "llc",
  "corporation",
  "small business",
  "sbir",
  "sttr",
  "8(a)",
  "consulting firm",
  "management consulting",
  "prime contractor",
  "prime or sub",
  "any eligible entity",
  "all applicants",
];

function checkForProfitEligible(opp: ComplianceInput): ComplianceCheck {
  const body = normalize(opp.eligibility) + " " + normalize(opp.summary);

  if (FP_EXCLUDE_SIGNALS.some((s) => body.includes(s))) {
    return {
      id: "for_profit_eligible",
      label: "For-profit entity eligible",
      status: "fail",
      note: "Eligibility language appears to exclude for-profit entities.",
    };
  }

  if (FP_ALLOW_SIGNALS.some((s) => body.includes(s))) {
    return {
      id: "for_profit_eligible",
      label: "For-profit entity eligible",
      status: "pass",
      note: "For-profit / small business language confirms eligibility.",
    };
  }

  return {
    id: "for_profit_eligible",
    label: "For-profit entity eligible",
    status: "warn",
    note: "Eligibility not confirmed for for-profit entities. Review NOFO.",
  };
}

// ---- Deadline sufficient check --------------------------------------------
// Require at least 14 calendar days for a credible proposal. Warn at 14–21.
// Pass at 21+. Fail if deadline passed or < 14 days.

const MIN_DAYS_FAIL = 14;
const MIN_DAYS_WARN = 21;

function checkDeadlineSufficient(opp: ComplianceInput): ComplianceCheck {
  if (!opp.deadline) {
    return {
      id: "deadline_sufficient",
      label: "Sufficient development time",
      status: "unknown",
      note: "No deadline provided. Cannot assess development time.",
    };
  }

  const deadlineMs = Date.parse(opp.deadline);
  if (!Number.isFinite(deadlineMs)) {
    return {
      id: "deadline_sufficient",
      label: "Sufficient development time",
      status: "unknown",
      note: `Deadline '${opp.deadline}' is not a parseable date.`,
    };
  }

  const daysLeft = (deadlineMs - Date.now()) / 86_400_000;

  if (daysLeft < 0) {
    return {
      id: "deadline_sufficient",
      label: "Sufficient development time",
      status: "fail",
      note: "Deadline has already passed.",
    };
  }

  if (daysLeft < MIN_DAYS_FAIL) {
    return {
      id: "deadline_sufficient",
      label: "Sufficient development time",
      status: "fail",
      note: `Only ${Math.round(daysLeft)} days remaining — insufficient for quality proposal.`,
    };
  }

  if (daysLeft < MIN_DAYS_WARN) {
    return {
      id: "deadline_sufficient",
      label: "Sufficient development time",
      status: "warn",
      note: `${Math.round(daysLeft)} days remaining — tight but possible with immediate start.`,
    };
  }

  return {
    id: "deadline_sufficient",
    label: "Sufficient development time",
    status: "pass",
    note: `${Math.round(daysLeft)} days remaining — adequate for proposal development.`,
  };
}

// ---- Competition feasibility check ----------------------------------------
// Detect signals that reduce win probability: large-incumbent language,
// very high award ceilings that suggest enterprise-scale prime required,
// or explicit sole-source for another entity.

const COMPETITION_RED_FLAGS = [
  "sole source award",
  "sole-source award",
  "directed award",
  "only one source",
  "not a competitive",
  "no competition",
  "incumbent only",
  "large business",
  "must be a university",
  "must be a hospital",
  "academic institution only",
];

const COMPETITION_FAVORABLE = [
  "small business",
  "set-aside",
  "set aside",
  "8(a)",
  "mbe",
  "minority",
  "competitive",
  "full and open",
  "open competition",
];

function checkCompetitionFeasibility(opp: ComplianceInput): ComplianceCheck {
  const body = normalize(opp.eligibility) + " " + normalize(opp.summary) + " " + normalize(opp.title);

  if (COMPETITION_RED_FLAGS.some((s) => body.includes(s))) {
    return {
      id: "competition_feasibility",
      label: "Competition feasibility",
      status: "warn",
      note: "Language suggests limited competition or incumbent advantage. Assess before committing resources.",
    };
  }

  if (COMPETITION_FAVORABLE.some((s) => body.includes(s))) {
    return {
      id: "competition_feasibility",
      label: "Competition feasibility",
      status: "pass",
      note: "Competitive or set-aside language favorable for Acme Consulting.",
    };
  }

  return {
    id: "competition_feasibility",
    label: "Competition feasibility",
    status: "unknown",
    note: "No competition signals found. Manual review recommended.",
  };
}

// ---- Aggregator -----------------------------------------------------------

function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

export type ComplianceInput = {
  title: string;
  agency: string | null | undefined;
  deadline: string | null | undefined;
  eligibility: string | null | undefined;
  summary: string | null | undefined;
};

export function runComplianceChecks(opp: ComplianceInput): ComplianceResult {
  const checks: ComplianceCheck[] = [
    checkNofoActive(opp),
    checkForProfitEligible(opp),
    checkDeadlineSufficient(opp),
    checkCompetitionFeasibility(opp),
  ];

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn" || c.status === "unknown");

  const status: ComplianceResult["status"] = hasFail ? "fail" : hasWarn ? "warn" : "pass";

  const failChecks = checks.filter((c) => c.status === "fail");
  const warnChecks = checks.filter((c) => c.status === "warn");

  let summary: string;
  if (hasFail) {
    summary = `FAIL — ${failChecks.map((c) => c.label).join(", ")} did not pass.`;
  } else if (hasWarn) {
    summary = `WARN — ${warnChecks.map((c) => c.label).join(", ")} need review.`;
  } else {
    summary = "All compliance checks passed.";
  }

  return { status, checks, summary };
}

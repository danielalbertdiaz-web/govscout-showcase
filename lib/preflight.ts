import { getDraft, type DraftRecord } from "./db";
import { listPinsForDraft } from "./boilerplate";

export type Severity = "green" | "yellow" | "red";

export type CheckResult = {
  id: string;
  label: string;
  severity: Severity;
  message: string;
  ruleNote?: string;
};

export type PreflightResult = {
  draftId: string;
  ranAt: number;
  results: CheckResult[];
  redCount: number;
  yellowCount: number;
  greenCount: number;
  canSubmit: boolean;
};

// Standard federal grant attachment template — what we always expect when a
// linked NOFO doesn't enumerate specifics. Keep dumb and concrete; no LLM.
const DEFAULT_FEDERAL_ATTACHMENTS = [
  "project_narrative",
  "budget_narrative",
  "sf_424",
  "key_personnel_resumes",
  "letters_of_support",
];

// DEI-coded terms that trigger 2026 federal rejection patterns per
// standing editorial guidance. Yellow flag only; we don't
// block — the operator might be intentionally using them.
const DEI_FLAGGED_TERMS = [
  "diversity, equity, and inclusion",
  "DEI",
  "anti-racism",
  "anti-racist",
  "white supremacy",
  "systemic racism",
  "marginalized populations",
  "intersectionality",
  "decolonize",
  "decolonization",
];

function fullDraftText(draft: DraftRecord): string {
  const sections = Object.values(draft.sections ?? {}).join("\n\n");
  return `${draft.title}\n\n${draft.opportunity}\n\n${draft.business}\n\n${sections}`;
}

// Looks for: $1,234,567 and similar inline figures, then totals them by
// matching a numeric pattern. Returns inferred sums per section name, plus
// the difference between the narrative max and the budget block max.
function checkBudgetTotals(draft: DraftRecord): CheckResult {
  const narrative = (draft.sections?.executive_summary ?? "") + "\n" +
    (draft.sections?.technical_approach ?? "");
  const budgetBlock = draft.sections?.capability_statement ?? "";

  function extractNumbers(text: string): number[] {
    const re = /\$[\s]*([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(?:\.[0-9]{1,2})?/g;
    const out: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1].replace(/,/g, ""));
      if (!Number.isNaN(n)) out.push(n);
    }
    return out;
  }
  const a = extractNumbers(narrative);
  const b = extractNumbers(budgetBlock);
  if (a.length === 0 || b.length === 0) {
    return {
      id: "budget_totals",
      label: "Budget totals: narrative ↔ budget",
      severity: "yellow",
      message: "Could not extract a clear dollar amount from both narrative and budget sections. Verify manually.",
    };
  }
  const aMax = Math.max(...a);
  const bMax = Math.max(...b);
  const tolerance = 0.05; // 5%
  const ratio = Math.abs(aMax - bMax) / Math.max(aMax, bMax);
  if (ratio <= tolerance) {
    return {
      id: "budget_totals",
      label: "Budget totals: narrative ↔ budget",
      severity: "green",
      message: `Narrative max $${aMax.toLocaleString()} aligns with budget $${bMax.toLocaleString()} (Δ ${(ratio * 100).toFixed(1)}%).`,
    };
  }
  return {
    id: "budget_totals",
    label: "Budget totals: narrative ↔ budget",
    severity: "red",
    message: `Mismatch: narrative max $${aMax.toLocaleString()} vs budget $${bMax.toLocaleString()} (Δ ${(ratio * 100).toFixed(1)}%, > 5% tolerance).`,
  };
}

export type PreflightProfile = {
  samGovLastRenewed?: string;   // ISO date
  ueiOnFile?: string;
  partnerLettersDates?: string[]; // ISO dates of dated partner letters
};

// Run the full deterministic checklist. The `profile` knobs are passed in
// by the route so we can let the route grab them from env/blocks today and
// move them into a settings table later without churning this function.
export function runPreflight(
  draft: DraftRecord,
  profile?: PreflightProfile,
): PreflightResult {
  const out: CheckResult[] = [];
  const fullText = fullDraftText(draft);
  const pins = listPinsForDraft(draft.id);
  const pinnedKeys = new Set(pins.map((p) => p.blockKey));

  // 1. Jane Barred name check — HARD BLOCK
  if (/jane\s*barred/i.test(fullText)) {
    out.push({
      id: "banned_name_check",
      label: 'String "Jane Barred" must not appear',
      severity: "red",
      message: 'Found "Jane Barred" in draft text. This name is permanently banned from any submission.',
      ruleNote: "[[banned-names-policy]]",
    });
  } else {
    out.push({
      id: "banned_name_check",
      label: 'String "Jane Barred" must not appear',
      severity: "green",
      message: "Not present.",
    });
  }

  // 2. SAM.gov registration
  const samDate = profile?.samGovLastRenewed;
  if (!samDate) {
    out.push({
      id: "sam_gov",
      label: "SAM.gov registration current (< 12 months)",
      severity: "red",
      message: "No SAM.gov renewal date on file. Set on Acme Consulting profile before submission.",
    });
  } else {
    const ageDays = (Date.now() - new Date(samDate).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 365) {
      out.push({
        id: "sam_gov",
        label: "SAM.gov registration current (< 12 months)",
        severity: "red",
        message: `SAM.gov last renewed ${samDate} — ${Math.round(ageDays)} days ago.`,
      });
    } else if (ageDays > 330) {
      out.push({
        id: "sam_gov",
        label: "SAM.gov registration current (< 12 months)",
        severity: "yellow",
        message: `SAM.gov renews soon (${Math.round(365 - ageDays)} days remaining).`,
      });
    } else {
      out.push({
        id: "sam_gov",
        label: "SAM.gov registration current (< 12 months)",
        severity: "green",
        message: `SAM.gov renewed ${samDate}.`,
      });
    }
  }

  // 3. UEI present and 12-char alphanumeric
  const ueiOnFile = profile?.ueiOnFile?.trim() ?? "";
  if (!ueiOnFile) {
    out.push({
      id: "uei_present",
      label: "UEI present (12-char alphanumeric)",
      severity: "red",
      message: "No UEI on file. Add to Acme Consulting profile.",
    });
  } else if (!/^[A-Z0-9]{12}$/i.test(ueiOnFile)) {
    out.push({
      id: "uei_present",
      label: "UEI present (12-char alphanumeric)",
      severity: "red",
      message: `UEI on file "${ueiOnFile}" is not 12-char alphanumeric.`,
    });
  } else {
    // Also check it appears somewhere in the draft (UEI block typically inserted)
    if (!fullText.includes(ueiOnFile)) {
      out.push({
        id: "uei_present",
        label: "UEI present (12-char alphanumeric)",
        severity: "yellow",
        message: "UEI is on file but not found in the draft text. Insert the acme-consulting-uei block.",
      });
    } else {
      out.push({
        id: "uei_present",
        label: "UEI present (12-char alphanumeric)",
        severity: "green",
        message: "UEI present and in narrative.",
      });
    }
  }

  // 4. Required attachments / blocks — uses boilerplate pins as a proxy
  const requiredBlocks = [
    "acme-consulting-capability-statement",
    "acme-consulting-naics-codes",
    "harbor-county-track-record",
  ];
  const missing = requiredBlocks.filter((k) => !pinnedKeys.has(k));
  if (missing.length === 0) {
    out.push({
      id: "required_blocks",
      label: "Required boilerplate blocks inserted",
      severity: "green",
      message: `All ${requiredBlocks.length} required blocks pinned.`,
    });
  } else {
    out.push({
      id: "required_blocks",
      label: "Required boilerplate blocks inserted",
      severity: "yellow",
      message: `Missing: ${missing.join(", ")}. Insert via /drafts/${draft.id}.`,
    });
  }

  // 5. Standard federal attachments stub — yellow reminder
  out.push({
    id: "attachments_template",
    label: "Standard federal attachments accounted for",
    severity: "yellow",
    message: `Verify these are uploaded outside this tool: ${DEFAULT_FEDERAL_ATTACHMENTS.join(", ")}.`,
  });

  // 6. Signature page check
  if (/signature page|signatory|signed:/i.test(fullText)) {
    out.push({
      id: "signature_page",
      label: "Signature page included",
      severity: "green",
      message: "Signature reference found in draft.",
    });
  } else {
    out.push({
      id: "signature_page",
      label: "Signature page included",
      severity: "red",
      message: "No signature page or signatory block detected.",
    });
  }

  // 7. Budget totals
  out.push(checkBudgetTotals(draft));

  // 8. Partner letters dated within 90 days
  const partnerDates = profile?.partnerLettersDates ?? [];
  if (partnerDates.length === 0) {
    out.push({
      id: "partner_letters",
      label: "Partner letters dated within 90 days",
      severity: "yellow",
      message: "No partner-letter dates on record. Verify manually before submission.",
    });
  } else {
    const stale = partnerDates.filter((d) => {
      const ageDays = (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24);
      return ageDays > 90;
    });
    if (stale.length > 0) {
      out.push({
        id: "partner_letters",
        label: "Partner letters dated within 90 days",
        severity: "red",
        message: `${stale.length} partner letter(s) older than 90 days: ${stale.join(", ")}.`,
      });
    } else {
      out.push({
        id: "partner_letters",
        label: "Partner letters dated within 90 days",
        severity: "green",
        message: `All ${partnerDates.length} letters within window.`,
      });
    }
  }

  // 9. DEI language scan
  const hits = DEI_FLAGGED_TERMS.filter((t) =>
    new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(fullText),
  );
  if (hits.length === 0) {
    out.push({
      id: "dei_scan",
      label: "DEI-language scan (2026 federal climate)",
      severity: "green",
      message: "No flagged terms detected.",
    });
  } else {
    out.push({
      id: "dei_scan",
      label: "DEI-language scan (2026 federal climate)",
      severity: "yellow",
      message: `Found: ${hits.join(", ")}. Consider DEI-scrubbed framings (see federal-political-climate-language block).`,
      ruleNote: "standing editorial guidance",
    });
  }

  const redCount = out.filter((r) => r.severity === "red").length;
  const yellowCount = out.filter((r) => r.severity === "yellow").length;
  const greenCount = out.filter((r) => r.severity === "green").length;

  return {
    draftId: draft.id,
    ranAt: Date.now(),
    results: out,
    redCount,
    yellowCount,
    greenCount,
    canSubmit: redCount === 0,
  };
}

export function runPreflightById(
  draftId: string,
  userEmail: string,
  profile?: PreflightProfile,
): PreflightResult | null {
  const d = getDraft(draftId, userEmail);
  if (!d) return null;
  return runPreflight(d, profile);
}

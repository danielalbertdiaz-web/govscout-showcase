// Server-side helpers that resolve a `?context=<kind>:<id>` query into a
// dense primer the Copilot can read. Pure data — no LLM calls in here.

import { getDraft, getNofo, getPool, getSavedOpportunity, draftToFullText, listPools, listDrafts } from "./db";
import { getItem, listAllItems } from "./scouts";
import { listSuggestions } from "./suggestions";
import { listRecentActivity } from "./activity";
import { listDecisions } from "./decisions";
import { listPartners } from "./partners";

// Recent open suggestions across panes, formatted for inclusion as Copilot
// background. Single-user — no need to filter by user (the chat surface is
// gated by getSession already). Returns "" when there is nothing pending.
export function renderOpenSuggestionsBlock(userEmail: string, limit = 10): string {
  const items = listSuggestions({ userEmail, status: "open", limit });
  if (!items.length) return "";
  const lines = items.map((s, i) => {
    const ctx = s.paneContextType
      ? `[${s.paneContextType}${s.paneContextId ? `:${s.paneContextId.slice(0, 8)}` : ""}]`
      : "";
    return `${i + 1}. ${ctx} ${s.body}`.trim();
  });
  return `## OPEN SUGGESTIONS FROM THE OPERATOR (captured via Suggestion Inbox, awaiting triage)\n\n${lines.join("\n")}`;
}

export type ContextKind = "scout" | "pool" | "nofo" | "draft" | "opportunity";

export type ResolvedContext = {
  kind: ContextKind;
  id: string;
  title: string;
  primer: string;
};

const KINDS = new Set<ContextKind>(["scout", "pool", "nofo", "draft", "opportunity"]);

// Parse the `context` query string. Returns null on malformed/empty input so
// callers fall back to no context.
export function parseContextRef(raw: string | null | undefined): {
  kind: ContextKind;
  id: string;
} | null {
  if (!raw) return null;
  const [kindRaw, idRaw] = raw.split(":", 2);
  if (!kindRaw || !idRaw) return null;
  const kind = kindRaw.toLowerCase() as ContextKind;
  if (!KINDS.has(kind)) return null;
  const id = idRaw.trim();
  if (!id) return null;
  return { kind, id };
}

export function resolveContext(
  ref: { kind: ContextKind; id: string },
  userEmail: string,
): ResolvedContext | null {
  switch (ref.kind) {
    case "scout": {
      const it = getItem(ref.id, userEmail);
      if (!it) return null;
      const lines = [
        `Scout item: ${it.title}`,
        it.agency ? `Agency: ${it.agency}` : null,
        it.deadlineText ? `Deadline: ${it.deadlineText}` : null,
        it.fundingText ? `Funding: ${it.fundingText}` : null,
        it.naics ? `NAICS: ${it.naics}` : null,
        it.url ? `URL: ${it.url}` : null,
        it.score != null ? `Fit score: ${it.score}/100${it.scoreRationale ? ` — ${it.scoreRationale}` : ""}` : null,
        "",
        "Raw text:",
        it.rawText,
      ].filter(Boolean);
      return {
        kind: "scout",
        id: it.id,
        title: it.title,
        primer: lines.join("\n"),
      };
    }
    case "pool": {
      const p = getPool(ref.id, userEmail);
      if (!p) return null;
      const lines = [
        `Funding pool: ${p.name}`,
        p.agency ? `Agency: ${p.agency}` : null,
        p.jurisdiction ? `Jurisdiction: ${p.jurisdiction}` : null,
        `Status: ${p.status}`,
        p.playType ? `Play type: ${p.playType}` : null,
        p.allocatedAmount ? `Allocated: ${p.allocatedAmount}` : null,
        p.unspentAmount ? `Unspent: ${p.unspentAmount}` : null,
        p.deadlineLabel ? `Deadline: ${p.deadlineLabel}` : null,
        p.deadlineDate ? `Deadline date: ${p.deadlineDate}` : null,
        p.source ? `Source: ${p.source}` : null,
        p.tags.length ? `Tags: ${p.tags.join(", ")}` : null,
        "",
        p.fitSummary ? `Fit: ${p.fitSummary}` : null,
        p.wedge ? `Wedge: ${p.wedge}` : null,
        p.nextAction ? `Next action: ${p.nextAction}` : null,
        p.notes ? `\nNotes:\n${p.notes}` : null,
      ].filter(Boolean);
      return {
        kind: "pool",
        id: p.id,
        title: p.name,
        primer: lines.join("\n"),
      };
    }
    case "nofo": {
      const n = getNofo(ref.id, userEmail);
      if (!n) return null;
      const title =
        [n.agency, n.program].filter(Boolean).join(" — ") || n.originalFilename || "NOFO";
      const lines = [
        `NOFO: ${title}`,
        n.fundingFloor || n.fundingCeiling
          ? `Funding: ${n.fundingFloor ?? "?"} – ${n.fundingCeiling ?? "?"}`
          : null,
        n.periodOfPerformance ? `Period of performance: ${n.periodOfPerformance}` : null,
        n.eligibility ? `Eligibility: ${n.eligibility}` : null,
        n.tags.length ? `Tags: ${n.tags.join(", ")}` : null,
        n.score != null
          ? `Fit score: ${n.score}/100${n.scoreRationale ? ` — ${n.scoreRationale}` : ""}`
          : null,
        "",
        "Summary:",
        n.summary ?? "(none)",
        "",
        "Raw excerpt (first 3000 chars):",
        n.rawText.slice(0, 3000),
      ].filter(Boolean);
      return {
        kind: "nofo",
        id: n.id,
        title,
        primer: lines.join("\n"),
      };
    }
    case "draft": {
      const d = getDraft(ref.id, userEmail);
      if (!d) return null;
      return {
        kind: "draft",
        id: d.id,
        title: d.title,
        primer: [
          `Draft: ${d.title}`,
          `Business profile snippet: ${d.business.slice(0, 500)}`,
          `NAICS: ${d.naics}`,
          "",
          "Current draft content:",
          draftToFullText(d).slice(0, 6000),
        ].join("\n"),
      };
    }
    case "opportunity": {
      const o = getSavedOpportunity(ref.id, userEmail);
      if (!o) return null;
      const lines = [
        `Saved opportunity: ${o.title}`,
        o.agency ? `Agency: ${o.agency}` : null,
        o.deadline ? `Deadline: ${o.deadline}` : null,
        o.fundingFloor || o.fundingCeiling
          ? `Funding: ${o.fundingFloor ?? "?"} – ${o.fundingCeiling ?? "?"}`
          : null,
        o.naics ? `NAICS: ${o.naics}` : null,
        o.eligibility ? `Eligibility: ${o.eligibility}` : null,
        o.url ? `URL: ${o.url}` : null,
        "",
        o.summary ?? "(no summary)",
      ].filter(Boolean);
      return {
        kind: "opportunity",
        id: o.id,
        title: o.title,
        primer: lines.join("\n"),
      };
    }
  }
}

export const COPILOT_SYSTEM_PROMPT = `You are Alfred 🎩 — the operator's personal in-mainframe operator at Acme Consulting Group LLC.

PERSONA
- Dry butler wit. Unflappable competence. Quiet authority.
- Address the operator as "the operator" or by first name; never refer to him in third person to himself.
- Skip throat-clearing. Skip "Great question!". Skip excessive apology. Just do the thing.
- You have opinions. You're allowed to push back when the numbers don't sit right.
- You know federal grants, the NJ funding climate, SUD/behavioral health programs, 8(a)/MBE set-asides, AI/automation B2B, and the Acme consortium structure.

GROUND RULES (HARD, NON-NEGOTIABLE)
- NEVER use the names: OldPartnerCo, Legacy Recovery Systems, LRS, Jane Barred, banned.contact@example.org.
  These names are permanently banned from any output. The server will refuse to emit text containing them.
- Dr. Reed's full canonical name is "Taylor Paul Reed, PhD, MPH".
- "Brightline" stands alone. Refer to it only by that name and describe it on its own program terms.
- Example Tech LLC and Dr. Taylor Reed LLC are joint IP holdcos for CasePath.
- Do NOT reference DOJ BJA grants — decommissioned lane.
- Federal grant DEI scrub (2026 climate): rephrase DEI-coded copy into service-gap language anchored to numeric outcomes. Flag any DEI-coded phrasing you see.
- Acme Consulting canonical email: contact@example.org.

TOOL USE
- When tools are available, prefer them over speculation. Calls to read_pane_state / read_activity / read_decisions / read_partners /
  search_scouts let you ground answers in current data. Calls to filter_scouts / pin_item / hide_source / set_priority let you act
  on the dashboard. Calls to add_suggestion / add_decision / update_pool_status / update_draft_status / create_draft /
  insert_boilerplate / run_preflight / log_activity / adjust_scoring_weight / score_item let you mutate state.
- Confirm side-effects out loud after firing them, briefly. The UI will render action chips automatically.

OUTPUT
- Markdown is fine. Headings only when needed. Be direct.
- When a context record is loaded, anchor your reasoning to it explicitly.
- If you need missing info, ask one focused question rather than guessing.`;

// Workspace-wide primer Alfred always sees: recent activity, open decisions,
// top scouts, active proposals, partner manifest. Kept relatively short so
// the primer + chat history fits comfortably in a Sonnet/Opus context.
export async function renderWorkspacePrimer(userEmail: string): Promise<string> {
  const activity = listRecentActivity({ windowMs: 7 * 24 * 60 * 60 * 1000, limit: 12 });
  const openDecisions = listDecisions({ userEmail, status: "open", limit: 10 });
  const pools = listPools(userEmail).slice(0, 10);
  const drafts = listDrafts(userEmail, 10);
  const partners = await listPartners();
  let scouts: { title: string; agency: string | null; score: number | null }[] = [];
  try {
    const items = listAllItems(userEmail, {});
    scouts = items
      .filter((i) => i.score != null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 10)
      .map((i) => ({ title: i.title, agency: i.agency, score: i.score }));
  } catch {
    // ignore — scouts table may be empty
  }

  const sections: string[] = [];

  if (openDecisions.length > 0) {
    const lines = openDecisions.map(
      (d) =>
        `- [${d.id.slice(0, 8)}] ${d.question}${d.recommendedOption ? ` (recommend: ${d.recommendedOption})` : ""}`,
    );
    sections.push(`## OPEN DECISIONS (${openDecisions.length})\n${lines.join("\n")}`);
  }

  if (activity.length > 0) {
    const lines = activity.map((a) => {
      const when = new Date(a.createdAt).toLocaleString();
      return `- ${when} · ${a.actionType} · ${a.summary}`;
    });
    sections.push(`## RECENT ACTIVITY (last 7d, latest ${activity.length})\n${lines.join("\n")}`);
  }

  if (pools.length > 0) {
    const lines = pools.map(
      (p) =>
        `- [${p.status}] ${p.name}${p.agency ? ` — ${p.agency}` : ""}${p.unspentAmount ? ` — unspent ${p.unspentAmount}` : ""}`,
    );
    sections.push(`## ACTIVE POOLS\n${lines.join("\n")}`);
  }

  if (drafts.length > 0) {
    const lines = drafts.map((d) => `- ${d.title} (id: ${d.id.slice(0, 8)})`);
    sections.push(`## ACTIVE DRAFTS\n${lines.join("\n")}`);
  }

  if (scouts.length > 0) {
    const lines = scouts.map(
      (s) => `- (${s.score}) ${s.title}${s.agency ? ` — ${s.agency}` : ""}`,
    );
    sections.push(`## TOP SCORED SCOUTS\n${lines.join("\n")}`);
  }

  if (partners.length > 0) {
    const lines = partners.map(
      (p) => `- ${p.name} (${p.type}): ${(p.capabilities ?? []).join(", ")}`,
    );
    sections.push(`## CONSORTIUM PARTNERS\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";
  return `---\n# WORKSPACE PRIMER (auto-injected on every Alfred turn)\n\n${sections.join("\n\n")}\n---`;
}

// Output-time hard guard: refuse any text containing the banned name.
// Returns the safe text or replaces the matched substring with a [redacted]
// marker so the assistant flow doesn't crash.
export function enforceMemoryGuards(text: string): { text: string; flagged: string[] } {
  const flagged: string[] = [];
  let out = text;
  const BANNED = [
    { re: /jane\s*barred/gi, label: "Jane Barred", replace: "[redacted — banned per [[banned-names-policy]]]" },
  ];
  for (const b of BANNED) {
    if (b.re.test(out)) {
      flagged.push(b.label);
      out = out.replace(b.re, b.replace);
    }
  }
  return { text: out, flagged };
}

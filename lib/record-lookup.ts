// Unified record status lookup — ONE answer to "is this actually on the
// record, and did we already act on it?"
//
// The recurring failure this exists to end: the truth about a solicitation is
// split across four stores (fp_opportunities canon, micro_contracts staging,
// decision_queue, trackl_contacts), and picking the wrong one — or the wrong
// query window — has produced real money errors twice (a $42,800 quote to
// NASA Glenn conflicting with an authorised $55,000 because the earlier
// submission was never ingested; two identical NIST quotations 18 seconds
// apart) and a false "not in GovScout" alarm. This module searches all the
// stores in one pass and returns one consolidated answer.
//
// Design rules (each one traces to an incident):
//   1. DUPLICATE RISK IS THE HEADLINE. gmail_sent_ids populated, or status
//      submitted/closed_*, must be impossible to miss when skimming.
//   2. "Not found" is explicit and says WHERE we looked. Absence-from-a-query
//      must never again be read as absence-from-the-system.
//   3. An unreadable store is REPORTED, never silently treated as empty.
//   4. Canon and staging disagreeing is surfaced, never resolved (same
//      discipline as lib/opportunity-identity.ts).
//
// This module is PURE — no DB, no clock, no I/O. scripts/lookup.mts opens the
// database strictly read-only and feeds rows in. Matching reuses
// normalizeSolNumber and the findFpOpportunity ladder (id → notice_id → sol →
// normalised sol); it does not invent a third scheme.

import { normalizeSolNumber, statesConflict } from "./opportunity-identity";
import { FP_STATUS_LABELS, isFpStatus } from "./federal-pipeline-types";

// --- Input row shapes --------------------------------------------------------
// Deliberately "lite": only the columns the lookup renders. The CLI maps raw
// SQL rows to these; tests construct them directly.

export type FpOppLite = {
  id: string;
  solNumber: string | null;
  noticeId: string | null;
  title: string;
  agency: string | null;
  status: string;
  nobidReason: string | null;
  responseDeadline: string | null;
  priceQuoted: number | null;
  priceBasis: string | null;
  submissionMethod: string | null;
  submissionTarget: string | null;
  gmailDraftId: string | null;
  gmailSentIds: string[];
  poc1Name: string | null;
  poc1Email: string | null;
  poc2Name: string | null;
  poc2Email: string | null;
  flaggedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type FpEventLite = {
  oppId: string;
  ts: number;
  kind: string;
  detail: Record<string, unknown> | null;
};

export type MicroLite = {
  id: string;
  noticeId: string;
  solNumber: string | null;
  title: string;
  agency: string | null;
  disposition: string;
  /** Sweep verdict lands here verbatim ("Sweep verdict: killed-naics:..."). */
  description: string | null;
  responseDeadline: string | null;
  fpOpportunityId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type DecisionLite = {
  id: string;
  question: string;
  contextType: string | null;
  contextId: string | null;
  status: string;
  decision: string | null;
  decisionNote: string | null;
  createdAt: number;
  decidedAt: number | null;
};

export type ContactLite = {
  id: string;
  name: string | null;
  title: string | null;
  email: string;
  priority: string;
  source: string;
  agencyName: string | null;
};

export type BlockLite = {
  id: string;
  key: string;
  title: string;
  version: number;
  updatedAt: number;
};

/** One store's read outcome. `ok: false` means UNREADABLE — never "empty". */
export type StoreRead<T> = { ok: true; rows: T[] } | { ok: false; error: string };

export const LOOKUP_STORES = [
  "fp_opportunities",
  "fp_events",
  "micro_contracts",
  "decision_queue",
  "trackl_contacts",
  "boilerplate_blocks",
] as const;
export type LookupStoreName = (typeof LOOKUP_STORES)[number];

export type LookupStores = {
  fp_opportunities: StoreRead<FpOppLite>;
  fp_events: StoreRead<FpEventLite>;
  micro_contracts: StoreRead<MicroLite>;
  decision_queue: StoreRead<DecisionLite>;
  trackl_contacts: StoreRead<ContactLite>;
  boilerplate_blocks: StoreRead<BlockLite>;
};

// --- Query classification ----------------------------------------------------

export type QueryKind = "email" | "handle";

export function classifyQuery(q: string): QueryKind {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.trim()) ? "email" : "handle";
}

// --- Report shape ------------------------------------------------------------

export type MatchedOn =
  | "id"
  | "notice_id"
  | "sol_number"
  | "title"
  | "email"
  | "poc_email"
  | "name"
  | "context_id"
  | "question"
  | "key";

export type CanonMatch = {
  matchedOn: MatchedOn;
  opp: FpOppLite;
  /** ts of the event that put the row into its current status, else null. */
  statusSince: number | null;
  /** Positive evidence we already acted (the duplicate-risk core). */
  actedReasons: string[];
  /** Newest-first provenance trail; null when fp_events was unreadable. */
  events: FpEventLite[] | null;
  eventsTotal: number | null;
};

export type StagingMatch = {
  matchedOn: MatchedOn;
  micro: MicroLite;
  actedReasons: string[];
};

export type ConflictEntry = {
  fpId: string;
  microId: string;
  fpStatus: string;
  microDisposition: string;
  note: string;
};

export type LookupVerdict =
  | "in-canon"
  | "staging-only"
  | "contact"
  | "decision-only"
  | "boilerplate"
  | "not-found";

export type DuplicateRiskLevel = "none" | "unknown" | "already-acted";

export type StoreSearchInfo = {
  store: LookupStoreName;
  ok: boolean;
  /** Rows scanned when ok; null when the store could not be read. */
  rowsScanned: number | null;
  error: string | null;
};

export type LookupReport = {
  query: string;
  queryKind: QueryKind;
  now: number;
  verdict: LookupVerdict;
  found: boolean;
  duplicateRisk: { level: DuplicateRiskLevel; reasons: string[] };
  conflicts: ConflictEntry[];
  warnings: string[];
  storesSearched: StoreSearchInfo[];
  canon: CanonMatch[];
  staging: StagingMatch[];
  decisions: Array<{ matchedOn: MatchedOn; decision: DecisionLite }>;
  contacts: Array<{ matchedOn: MatchedOn; contact: ContactLite }>;
  blocks: Array<{ matchedOn: MatchedOn; block: BlockLite }>;
};

// --- Matching ----------------------------------------------------------------
// Same ladder as findFpOpportunity: exact id, notice_id, sol_number, then
// punctuation-stripped sol (normalizeSolNumber). Title fragment is the loosest
// rung and only applies to queries of 3+ characters.

const MIN_FRAGMENT = 3;

function eqCi(a: string | null | undefined, b: string): boolean {
  return a != null && a.trim().toLowerCase() === b.toLowerCase();
}

function includesCi(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack || needle.length < MIN_FRAGMENT) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function matchIdentity(
  q: string,
  norm: string,
  row: { id: string; noticeId: string | null; solNumber: string | null; title: string },
): MatchedOn | null {
  if (row.id === q) return "id";
  if (eqCi(row.noticeId, q)) return "notice_id";
  if (row.solNumber != null) {
    if (row.solNumber === q) return "sol_number";
    if (norm && normalizeSolNumber(row.solNumber) === norm) return "sol_number";
  }
  if (includesCi(row.title, q)) return "title";
  return null;
}

function actedReasonsCanon(opp: FpOppLite): string[] {
  const reasons: string[] = [];
  if (opp.gmailSentIds.length > 0) {
    reasons.push(
      `${opp.gmailSentIds.length} Gmail message(s) already sent (gmail_sent_ids populated)`,
    );
  }
  if (opp.status === "submitted") reasons.push(`canon status is "submitted"`);
  else if (opp.status.startsWith("closed_")) {
    reasons.push(`canon status is "${opp.status}" — this pursuit already ran to completion`);
  }
  return reasons;
}

function actedReasonsStaging(micro: MicroLite): string[] {
  const reasons: string[] = [];
  if (micro.disposition === "submitted") reasons.push(`staging disposition is "submitted"`);
  if (micro.disposition === "won") reasons.push(`staging disposition is "won"`);
  return reasons;
}

/** The event that moved the row INTO its current status (detail.to === status). */
function statusSince(opp: FpOppLite, events: FpEventLite[] | null): number | null {
  if (!events) return null;
  for (const e of events) {
    // events arrive newest-first
    if (e.detail && e.detail.to === opp.status) return e.ts;
  }
  return null;
}

// --- Report assembly ---------------------------------------------------------

export function buildLookupReport(
  rawQuery: string,
  stores: LookupStores,
  now: number,
): LookupReport {
  const query = rawQuery.trim();
  const queryKind = classifyQuery(query);
  const norm = queryKind === "handle" ? normalizeSolNumber(query) : "";

  const warnings: string[] = [];
  const storesSearched: StoreSearchInfo[] = LOOKUP_STORES.map((name) => {
    const read = stores[name] as StoreRead<unknown>;
    if (read.ok) return { store: name, ok: true, rowsScanned: read.rows.length, error: null };
    warnings.push(
      `store "${name}" could NOT be read (${read.error}) — its records are UNKNOWN, not absent`,
    );
    return { store: name, ok: false, rowsScanned: null, error: read.error };
  });

  // Canon.
  const canon: CanonMatch[] = [];
  if (stores.fp_opportunities.ok) {
    for (const opp of stores.fp_opportunities.rows) {
      let matchedOn: MatchedOn | null = null;
      if (queryKind === "email") {
        if (eqCi(opp.poc1Email, query) || eqCi(opp.poc2Email, query)) matchedOn = "poc_email";
      } else {
        matchedOn = matchIdentity(query, norm, opp);
      }
      if (!matchedOn) continue;
      let events: FpEventLite[] | null = null;
      let eventsTotal: number | null = null;
      if (stores.fp_events.ok) {
        const all = stores.fp_events.rows
          .filter((e) => e.oppId === opp.id)
          .sort((a, b) => b.ts - a.ts);
        events = all;
        eventsTotal = all.length;
      }
      canon.push({
        matchedOn,
        opp,
        statusSince: statusSince(opp, events),
        actedReasons: actedReasonsCanon(opp),
        events,
        eventsTotal,
      });
    }
  }

  // Staging.
  const staging: StagingMatch[] = [];
  if (stores.micro_contracts.ok && queryKind === "handle") {
    for (const micro of stores.micro_contracts.rows) {
      const matchedOn = matchIdentity(query, norm, micro);
      if (!matchedOn) continue;
      staging.push({ matchedOn, micro, actedReasons: actedReasonsStaging(micro) });
    }
  }

  // Also pull in staging rows explicitly linked to a matched canon row (and
  // vice versa) so the two sides of one opportunity always appear together.
  if (stores.micro_contracts.ok) {
    const canonIds = new Set(canon.map((c) => c.opp.id));
    for (const micro of stores.micro_contracts.rows) {
      if (
        micro.fpOpportunityId != null &&
        canonIds.has(micro.fpOpportunityId) &&
        !staging.some((s) => s.micro.id === micro.id)
      ) {
        staging.push({ matchedOn: "id", micro, actedReasons: actedReasonsStaging(micro) });
      }
    }
  }
  if (stores.fp_opportunities.ok) {
    const linkedFpIds = new Set(
      staging.map((s) => s.micro.fpOpportunityId).filter((v): v is string => v != null),
    );
    for (const opp of stores.fp_opportunities.rows) {
      if (linkedFpIds.has(opp.id) && !canon.some((c) => c.opp.id === opp.id)) {
        const events = stores.fp_events.ok
          ? stores.fp_events.rows.filter((e) => e.oppId === opp.id).sort((a, b) => b.ts - a.ts)
          : null;
        canon.push({
          matchedOn: "id",
          opp,
          statusSince: statusSince(opp, events),
          actedReasons: actedReasonsCanon(opp),
          events,
          eventsTotal: events ? events.length : null,
        });
      }
    }
  }

  // Conflicts — canon vs staging on the SAME opportunity (linked, or identity
  // match by notice_id / normalised sol). Surfaced, never resolved.
  const conflicts: ConflictEntry[] = [];
  for (const c of canon) {
    for (const s of staging) {
      const linked = s.micro.fpOpportunityId === c.opp.id;
      const sameNotice =
        c.opp.noticeId != null && s.micro.noticeId != null && c.opp.noticeId === s.micro.noticeId;
      const sameSol =
        c.opp.solNumber != null &&
        s.micro.solNumber != null &&
        normalizeSolNumber(c.opp.solNumber) === normalizeSolNumber(s.micro.solNumber);
      if (!linked && !sameNotice && !sameSol) continue;
      if (statesConflict(c.opp.status, s.micro.disposition)) {
        conflicts.push({
          fpId: c.opp.id,
          microId: s.micro.id,
          fpStatus: c.opp.status,
          microDisposition: s.micro.disposition,
          note: `canon says "${c.opp.status}" but staging says "${s.micro.disposition}" — two decisions disagree; neither is auto-trusted`,
        });
      }
    }
  }

  // Decisions — attached by context_id, or the question naming the sol/notice.
  const decisions: LookupReport["decisions"] = [];
  if (stores.decision_queue.ok) {
    const knownIds = new Set<string>([
      ...canon.map((c) => c.opp.id),
      ...staging.map((s) => s.micro.id),
      ...canon.map((c) => c.opp.noticeId).filter((v): v is string => v != null),
      ...staging.map((s) => s.micro.noticeId),
    ]);
    for (const d of stores.decision_queue.rows) {
      let matchedOn: MatchedOn | null = null;
      if (d.contextId != null && (knownIds.has(d.contextId) || d.contextId === query)) {
        matchedOn = "context_id";
      } else if (query.length >= 4 && includesCi(d.question, query)) {
        matchedOn = "question";
      } else if (norm.length >= 6 && normalizeSolNumber(d.question).includes(norm)) {
        // Sol numbers inside question text arrive dash-formatted; compare
        // punctuation-stripped, same as everywhere else.
        matchedOn = "question";
      }
      if (matchedOn) decisions.push({ matchedOn, decision: d });
    }
  }

  // Contacts — the query looks like a person/email rather than a solicitation.
  const contacts: LookupReport["contacts"] = [];
  if (stores.trackl_contacts.ok) {
    for (const contact of stores.trackl_contacts.rows) {
      if (queryKind === "email") {
        if (eqCi(contact.email, query)) contacts.push({ matchedOn: "email", contact });
      } else if (query.length >= 4 && includesCi(contact.name, query)) {
        contacts.push({ matchedOn: "name", contact });
      }
    }
  }

  // Boilerplate — only when the query names one.
  const blocks: LookupReport["blocks"] = [];
  if (stores.boilerplate_blocks.ok && queryKind === "handle") {
    for (const block of stores.boilerplate_blocks.rows) {
      if (eqCi(block.key, query)) blocks.push({ matchedOn: "key", block });
      else if (query.length >= 4 && includesCi(block.title, query)) {
        blocks.push({ matchedOn: "title", block });
      }
    }
  }

  // Verdict.
  const found =
    canon.length > 0 ||
    staging.length > 0 ||
    decisions.length > 0 ||
    contacts.length > 0 ||
    blocks.length > 0;
  const verdict: LookupVerdict =
    canon.length > 0
      ? "in-canon"
      : staging.length > 0
        ? "staging-only"
        : contacts.length > 0
          ? "contact"
          : decisions.length > 0
            ? "decision-only"
            : blocks.length > 0
              ? "boilerplate"
              : "not-found";

  // Duplicate risk — THE headline. Positive evidence wins; an unreadable
  // canon/staging store downgrades certainty to "unknown", never to "none".
  const riskReasons = [
    ...canon.flatMap((c) => c.actedReasons),
    ...staging.flatMap((s) => s.actedReasons),
  ];
  let riskLevel: DuplicateRiskLevel = riskReasons.length > 0 ? "already-acted" : "none";
  if (riskLevel === "none" && (!stores.fp_opportunities.ok || !stores.micro_contracts.ok)) {
    riskLevel = "unknown";
    riskReasons.push(
      "a store that records submissions could not be read — prior action CANNOT be ruled out",
    );
  }

  return {
    query,
    queryKind,
    now,
    verdict,
    found,
    duplicateRisk: { level: riskLevel, reasons: riskReasons },
    conflicts,
    warnings,
    storesSearched,
    canon,
    staging,
    decisions,
    contacts,
    blocks,
  };
}

// --- Rendering ---------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function fmtAge(ts: number, now: number): string {
  const days = Math.floor((now - ts) / DAY_MS);
  if (days <= 0) return "less than a day";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function fmtMoney(n: number): string {
  return "$" + n.toLocaleString("en-US");
}

function compactDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  const parts: string[] = [];
  for (const key of ["by", "from", "to", "reason", "note", "via"]) {
    const v = detail[key];
    if (v != null && v !== "") parts.push(`${key}=${String(v)}`);
  }
  if (parts.length === 0) {
    const s = JSON.stringify(detail);
    return s.length > 100 ? s.slice(0, 97) + "..." : s;
  }
  return parts.join("  ");
}

const RENDER_EVENT_LIMIT = 5;

export function renderLookupReport(r: LookupReport): string {
  const out: string[] = [];
  const push = (s = "") => out.push(s);

  push(`LOOKUP: ${r.query}  (${r.queryKind})`);

  // 1. Duplicate risk banner — before anything else, impossible to skim past.
  if (r.duplicateRisk.level === "already-acted") {
    const bar = "!".repeat(72);
    push();
    push(bar);
    push("!!  DUPLICATE RISK — WE ALREADY ACTED ON THIS. DO NOT SEND AGAIN.");
    for (const reason of r.duplicateRisk.reasons) push(`!!    - ${reason}`);
    push(bar);
  } else if (r.duplicateRisk.level === "unknown") {
    push();
    push("?? DUPLICATE RISK UNKNOWN:");
    for (const reason of r.duplicateRisk.reasons) push(`??   - ${reason}`);
  }

  // 2. Unreadable stores — before results, so absence is never misread.
  for (const w of r.warnings) push(`\nWARNING: ${w}`);

  // 3. Verdict line.
  push();
  switch (r.verdict) {
    case "in-canon": {
      const alsoStaging = r.staging.length > 0 ? " + staging (micro_contracts)" : "";
      push(`ON RECORD: in canon (fp_opportunities)${alsoStaging}`);
      break;
    }
    case "staging-only":
      push("ON RECORD: staging ONLY (micro_contracts) — no canonical fp_opportunities row");
      break;
    case "contact":
      push("ON RECORD: contact (trackl_contacts) — not a solicitation record");
      break;
    case "decision-only":
      push("ON RECORD: decision queue only — no canon or staging opportunity row");
      break;
    case "boilerplate":
      push("ON RECORD: boilerplate block");
      break;
    case "not-found": {
      push(`NOT FOUND: "${r.query}" matched NOTHING in any store searched.`);
      push("This is absence from the SYSTEM (every store below), not just from one query.");
      break;
    }
  }

  // 4. Where we looked — always, so "not found" and "found" carry the same proof.
  const searched = r.storesSearched
    .map((s) => (s.ok ? `${s.store} (${s.rowsScanned} rows)` : `${s.store} (UNREADABLE)`))
    .join(", ");
  push(`Searched: ${searched}`);

  // 5. Canon matches.
  for (const c of r.canon) {
    const o = c.opp;
    push();
    push(`CANON fp_opportunities — matched on ${c.matchedOn}`);
    push(`  ${o.title}`);
    push(`  id: ${o.id}`);
    push(`  sol: ${o.solNumber ?? "—"}   notice: ${o.noticeId ?? "—"}   agency: ${o.agency ?? "—"}`);
    const label = isFpStatus(o.status) ? FP_STATUS_LABELS[o.status] : o.status;
    const since = c.statusSince ?? o.updatedAt;
    push(`  status: ${o.status} (${label}) — for ${fmtAge(since, r.now)} (since ${fmtTs(since)})`);
    if (o.nobidReason) push(`  no-bid reason: ${o.nobidReason}`);
    const bits: string[] = [];
    if (o.responseDeadline) bits.push(`deadline: ${o.responseDeadline}`);
    if (o.priceQuoted != null) {
      bits.push(`price: ${fmtMoney(o.priceQuoted)}${o.priceBasis ? ` (${o.priceBasis})` : ""}`);
    }
    if (bits.length) push(`  ${bits.join("   ")}`);
    if (o.submissionMethod || o.submissionTarget) {
      push(`  submission: ${o.submissionMethod ?? "?"} -> ${o.submissionTarget ?? "?"}`);
    }
    if (o.flaggedAt != null) push(`  FLAGGED (since ${fmtTs(o.flaggedAt)})`);
    if (o.archivedAt != null) push(`  ARCHIVED (${fmtTs(o.archivedAt)})`);
    if (c.actedReasons.length > 0) {
      push(`  >> ALREADY ACTED: ${c.actedReasons.join("; ")}`);
      if (o.gmailSentIds.length > 0) push(`  >> gmail_sent_ids: ${o.gmailSentIds.join(", ")}`);
    }
    if (c.events === null) {
      push("  provenance: UNAVAILABLE — fp_events could not be read (see warning above)");
    } else if (c.events.length === 0) {
      push("  provenance: no events recorded for this row (thin trail — ingest wrote no history)");
    } else {
      const shown = c.events.slice(0, RENDER_EVENT_LIMIT);
      push(`  provenance (last ${shown.length} of ${c.eventsTotal} events):`);
      for (const e of shown) {
        const detail = compactDetail(e.detail);
        push(`    ${fmtTs(e.ts)}  ${e.kind.padEnd(16)} ${detail}`.trimEnd());
      }
    }
  }

  // 6. Staging matches.
  for (const s of r.staging) {
    const m = s.micro;
    push();
    push(`STAGING micro_contracts — matched on ${s.matchedOn}`);
    push(`  ${m.title}`);
    push(`  id: ${m.id}`);
    push(`  sol: ${m.solNumber ?? "—"}   notice: ${m.noticeId}   agency: ${m.agency ?? "—"}`);
    push(`  disposition: ${m.disposition} — last touched ${fmtTs(m.updatedAt)} (${fmtAge(m.updatedAt, r.now)} ago)`);
    if (m.description) push(`  ${m.description}`);
    if (m.responseDeadline) push(`  deadline: ${m.responseDeadline}`);
    push(
      m.fpOpportunityId != null
        ? `  linked to canon: ${m.fpOpportunityId}`
        : "  not linked to any canon row (normal for staging — most rows never promote)",
    );
    if (s.actedReasons.length > 0) push(`  >> ALREADY ACTED: ${s.actedReasons.join("; ")}`);
  }

  // 7. Conflicts — surfaced, never resolved.
  for (const conflict of r.conflicts) {
    push();
    push(`CONFLICT: ${conflict.note}`);
    push(`  canon ${conflict.fpId} = "${conflict.fpStatus}"  vs  staging ${conflict.microId} = "${conflict.microDisposition}"`);
  }

  // 8. Decisions.
  for (const { decision: d, matchedOn } of r.decisions) {
    push();
    push(`DECISION (${d.status}) — matched on ${matchedOn}`);
    push(`  ${d.question}`);
    if (d.status === "open") {
      push(`  PENDING since ${fmtTs(d.createdAt)} (${fmtAge(d.createdAt, r.now)})`);
    } else if (d.decision) {
      const when = d.decidedAt != null ? ` at ${fmtTs(d.decidedAt)}` : "";
      push(`  decided: ${d.decision}${when}${d.decisionNote ? ` — ${d.decisionNote}` : ""}`);
    }
  }

  // 9. Contacts.
  for (const { contact } of r.contacts) {
    push();
    push(`CONTACT trackl_contacts: ${contact.name ?? "(no name)"} <${contact.email}>`);
    push(
      `  ${contact.title ?? "—"}   agency: ${contact.agencyName ?? "—"}   priority: ${contact.priority}   source: ${contact.source}`,
    );
  }

  // 10. Boilerplate.
  for (const { block } of r.blocks) {
    push();
    push(`BOILERPLATE: ${block.key} v${block.version} — ${block.title} (updated ${fmtTs(block.updatedAt)})`);
  }

  return out.join("\n") + "\n";
}

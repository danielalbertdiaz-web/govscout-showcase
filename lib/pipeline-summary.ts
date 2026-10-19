// Unified pipeline summary for the command-center home (UX audit packet U-1).
//
// The defect this exists for: app/page.tsx graded "deadlines" solely on
// saved_opportunities (2 rows) while fp_opportunities, micro_contracts and
// friends held hundreds of records with live deadlines — so the morning
// summary said "0 deadlines" against a full pipeline. This module normalises
// the deadline-bearing sources into one shape the home page can count.
//
// Everything here is pure: callers fetch the rows (owner-scoped where the
// table requires it) and pass them in, `now` is injected, and there is no
// getDb() — so the aggregation is unit-testable without a database.

export type PipelineSource = "federal" | "micro" | "saved" | "scout" | "teaming";

/** Every source, in display order. Zero-row sources still get chips/counts. */
export const PIPELINE_SOURCES: readonly PipelineSource[] = [
  "federal",
  "micro",
  "saved",
  "scout",
  "teaming",
];

export type PipelineItem = {
  id: string;
  title: string;
  source: PipelineSource;
  deadline: string | null;
  agency: string | null;
  /** Where a click on this row should land. */
  href: string;
  status: string | null;
};

// Structural input shapes — just the fields we consume, so tests (and any
// future source) can pass plain literals instead of full DB records.
export type FpInput = {
  id: string;
  title: string;
  agency: string | null;
  responseDeadline: string | null;
  status: string;
};

export type MicroInput = {
  id: string;
  title: string;
  agency: string | null;
  responseDeadline: string | null;
  disposition: string;
};

export type SavedInput = {
  id: string;
  title: string;
  agency: string | null;
  deadline: string | null;
  pipelineStage?: string | null;
};

export type ScoutInput = {
  id: string;
  title: string;
  agency: string | null;
  /** Free text from the digest ("Aug 15", "rolling") — parsed defensively. */
  deadlineText: string | null;
  status: string;
};

export type TeamingInput = {
  id: string;
  title: string;
  agency: string | null;
  responseDeadline: string | null;
  disposition: string;
};

/**
 * Normalise the deadline-bearing sources into one list. scouts/teaming are
 * optional so the original three-source callers (the home page) are
 * unaffected.
 */
export function unifyPipeline(
  fp: FpInput[],
  micro: MicroInput[],
  saved: SavedInput[],
  scouts: ScoutInput[] = [],
  teaming: TeamingInput[] = [],
): PipelineItem[] {
  const items: PipelineItem[] = [];
  for (const o of fp) {
    items.push({
      id: o.id,
      title: o.title,
      source: "federal",
      deadline: o.responseDeadline,
      agency: o.agency,
      href: "/bid-board",
      status: o.status,
    });
  }
  for (const m of micro) {
    items.push({
      id: m.id,
      title: m.title,
      source: "micro",
      deadline: m.responseDeadline,
      agency: m.agency,
      href: "/contracts",
      status: m.disposition,
    });
  }
  for (const s of saved) {
    items.push({
      id: s.id,
      title: s.title,
      source: "saved",
      deadline: s.deadline,
      agency: s.agency,
      href: `/opportunities/${s.id}`,
      status: s.pipelineStage ?? null,
    });
  }
  for (const s of scouts) {
    items.push({
      id: s.id,
      title: s.title,
      source: "scout",
      deadline: s.deadlineText,
      agency: s.agency,
      href: "/scouts",
      status: s.status,
    });
  }
  for (const t of teaming) {
    items.push({
      id: t.id,
      title: t.title,
      source: "teaming",
      deadline: t.responseDeadline,
      agency: t.agency,
      href: "/teaming",
      status: t.disposition,
    });
  }
  return items;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Statuses that mean "a decision has been made" — counting these in a
// needs-action tile trains the reader to ignore the number (the same
// cry-wolf failure the cron false alarms had). Anything NOT listed here,
// including a status we have never seen, is treated as actionable: an
// unrecognised status is one a human should look at, never silently hidden.
const MICRO_DECIDED = new Set(["passed", "won", "submitted"]);
const FEDERAL_DECIDED = new Set(["triaged_nobid", "withdrawn", "submitted"]);
// scout: "dismissed" was declined; "promoted" graduated into a pool/saved
// opportunity — the scout row itself is no longer the actionable object.
const SCOUT_DECIDED = new Set(["dismissed", "promoted"]);
// teaming: "passed" was declined; "teamed" is a done deal.
const TEAMING_DECIDED = new Set(["passed", "teamed"]);

/** Does this item still need a human decision? Unknown statuses: yes. */
export function isActionable(item: PipelineItem): boolean {
  if (item.status == null) return true;
  if (item.source === "micro") return !MICRO_DECIDED.has(item.status);
  if (item.source === "federal") {
    if (item.status.startsWith("closed_")) return false;
    return !FEDERAL_DECIDED.has(item.status);
  }
  if (item.source === "scout") return !SCOUT_DECIDED.has(item.status);
  if (item.source === "teaming") return !TEAMING_DECIDED.has(item.status);
  // saved (and any future source): no decided states defined — needs a look.
  return true;
}

/**
 * Past due = a PARSEABLE deadline strictly before `now` (D-2). An item with
 * no deadline (or free text like "rolling") is NOT past due — scouts and
 * some teaming rows genuinely have no date, and sweeping them out with the
 * expired ones would hide live work.
 *
 * This is a different question from isActionable: "already decided" is
 * status; "no longer possible" is time. The two filters compose and neither
 * implies the other.
 */
export function isPastDue(item: PipelineItem, now: number): boolean {
  const t = parseDeadlineMs(item.deadline);
  return t != null && t < now;
}

/**
 * Apply source + actionable + past-due filters together (all compose; none
 * overrides another). An empty/absent `sources` means all sources. Passing
 * `excludePastDueAsOf` (a timestamp — the clock stays injectable) drops items
 * whose deadline has elapsed; callers must surface the excluded count rather
 * than hiding it silently.
 */
export function filterPipeline(
  items: PipelineItem[],
  opts: { sources?: PipelineSource[]; actionableOnly?: boolean; excludePastDueAsOf?: number } = {},
): PipelineItem[] {
  const sources = opts.sources && opts.sources.length ? new Set(opts.sources) : null;
  return items.filter(
    (item) =>
      (!sources || sources.has(item.source)) &&
      (!opts.actionableOnly || isActionable(item)) &&
      (opts.excludePastDueAsOf == null || !isPastDue(item, opts.excludePastDueAsOf)),
  );
}

/**
 * Deadline sort for board columns: parseable deadlines soonest first, rows
 * with no/unparseable deadline LAST — a missing deadline must never read as
 * "most urgent" (the epoch-0 failure mode again).
 */
export function sortByDeadline(items: PipelineItem[]): PipelineItem[] {
  return items
    .map((item, i) => ({ item, i, t: parseDeadlineMs(item.deadline) }))
    .sort((a, b) => {
      if (a.t == null && b.t == null) return a.i - b.i; // stable
      if (a.t == null) return 1;
      if (b.t == null) return -1;
      return a.t - b.t;
    })
    .map((x) => x.item);
}

// --- Board grouping (U-2) ---------------------------------------------------
// The unified /opportunities view keeps the Bid Board's status-column layout;
// per-source statuses map onto its groups. Unknown statuses land in Triage —
// same philosophy as isActionable: something we don't recognise gets looked
// at, never hidden.

export const PIPELINE_GROUPS = [
  { key: "triage", label: "Triage" },
  { key: "drafting", label: "Drafting" },
  { key: "awaiting", label: "Awaiting the operator" },
  { key: "submitted", label: "Submitted" },
  { key: "qa", label: "Q&A" },
  { key: "closed", label: "Closed" },
] as const;

export type PipelineGroupKey = (typeof PIPELINE_GROUPS)[number]["key"];

const GROUP_BY_STATUS: Record<string, PipelineGroupKey> = {
  // federal (FP_BOARD_GROUPS, verbatim)
  discovered: "triage",
  triaged_bid: "triage",
  triaged_watch: "triage",
  drafting: "drafting",
  awaiting_approval: "awaiting",
  submitted: "submitted",
  qa_open: "qa",
  triaged_nobid: "closed",
  closed_won: "closed",
  closed_lost: "closed",
  closed_no_award: "closed",
  withdrawn: "closed",
  // micro dispositions
  new: "triage",
  reviewing: "triage",
  passed: "closed",
  won: "closed",
  // scout statuses
  interested: "triage",
  dismissed: "closed",
  promoted: "closed",
  // teaming dispositions
  pursuing: "triage",
  outreach_drafted: "drafting",
  teamed: "closed",
  // saved pipeline stages
  identification: "triage",
  development: "drafting",
  submission: "submitted",
  award_tracking: "submitted",
  execution: "submitted",
};

export function pipelineGroup(item: PipelineItem): PipelineGroupKey {
  if (item.status == null) return "triage";
  return GROUP_BY_STATUS[item.status] ?? "triage";
}

// A date with no time component ("2026-08-05" — how micro_contracts stores
// every deadline).
const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Defensive deadline parse. Deadlines are stored as free strings on every
 * source table; a malformed or empty value means "no deadline" — it must
 * never coerce to epoch 0 and surface as an overdue 1970 row at the top of
 * the list.
 *
 * A BARE date parses as END-OF-DAY LOCAL (fix 1b, 2026-08-04). Date.parse
 * pins "2026-08-05" to midnight UTC — 8pm Eastern on Aug 4 — which rendered
 * "due in 7h" against a ~35-hour deadline and made D-2 hide micro notices for
 * the whole of their real final day. A solicitation due "2026-08-05" is due
 * at close of that day; end-of-day is the honest reading, midnight-UTC is a
 * parser artifact. Values carrying an explicit time or offset are untouched.
 */
export function parseDeadlineMs(deadline: string | null | undefined): number | null {
  if (!deadline || !deadline.trim()) return null;
  const s = deadline.trim();
  const bare = BARE_DATE_RE.exec(s);
  if (bare) {
    const [, y, m, d] = bare.map(Number);
    const local = new Date(y, m - 1, d, 23, 59, 59, 999);
    // Round-trip check so "2026-99-99" (regex-shaped garbage) stays null
    // instead of rolling over into a real date.
    if (local.getFullYear() !== y || local.getMonth() !== m - 1 || local.getDate() !== d) return null;
    return local.getTime();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Items whose deadline is in the future (past deadlines are not "upcoming")
 * and within `withinDays` of `now`, soonest first. Null/malformed deadlines
 * are excluded. `now` is injected — no clock reads here.
 *
 * By default only actionable items count: a deadline on something the operator has
 * already decided (no-bid, passed, submitted, closed) is not a call to action.
 * Pass `actionableOnly: false` for the unfiltered set.
 */
export function upcomingDeadlines(
  items: PipelineItem[],
  opts: { now: number; withinDays: number; actionableOnly?: boolean },
): PipelineItem[] {
  const { now, withinDays, actionableOnly = true } = opts;
  if (!Number.isFinite(withinDays) || withinDays < 0) {
    throw new Error(`invalid withinDays: ${withinDays}`);
  }
  const horizon = now + withinDays * DAY_MS;
  return items
    .filter((item) => !actionableOnly || isActionable(item))
    .map((item) => ({ item, t: parseDeadlineMs(item.deadline) }))
    .filter((x): x is { item: PipelineItem; t: number } => x.t != null && x.t >= now && x.t <= horizon)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.item);
}

/** How many tracked items each source contributes. Zero-fills every source. */
export function countBySource(items: PipelineItem[]): Record<PipelineSource, number> {
  const counts = Object.fromEntries(PIPELINE_SOURCES.map((s) => [s, 0])) as Record<
    PipelineSource,
    number
  >;
  for (const item of items) counts[item.source] += 1;
  return counts;
}

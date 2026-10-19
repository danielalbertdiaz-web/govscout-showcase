import { randomUUID } from "crypto";
import { getDb } from "./db";
import { tryLogActivity } from "./activity";

export const FOUNDATION_STATUSES = ["open", "closed", "won", "lost", "declined"] as const;
export type FoundationStatus = (typeof FOUNDATION_STATUSES)[number];

export function isFoundationStatus(s: string): s is FoundationStatus {
  return (FOUNDATION_STATUSES as readonly string[]).includes(s);
}

export type Foundation = {
  id: string;
  createdAt: number;
  updatedAt: number;
  userEmail: string;
  sourceLabel: string;
  title: string;
  url: string | null;
  deadlineText: string | null;
  deadlineDate: string | null;
  fundingMin: string | null;
  fundingMax: string | null;
  focusArea: string | null;
  geography: string | null;
  notes: string | null;
  status: FoundationStatus;
  sourceKind: string;
};

type Row = {
  id: string;
  created_at: number;
  updated_at: number;
  user_email: string;
  source_label: string;
  title: string;
  url: string | null;
  deadline_text: string | null;
  deadline_date: string | null;
  funding_min: string | null;
  funding_max: string | null;
  focus_area: string | null;
  geography: string | null;
  notes: string | null;
  status: string;
  source_kind: string;
};

function rowTo(r: Row): Foundation {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    userEmail: r.user_email,
    sourceLabel: r.source_label,
    title: r.title,
    url: r.url,
    deadlineText: r.deadline_text,
    deadlineDate: r.deadline_date,
    fundingMin: r.funding_min,
    fundingMax: r.funding_max,
    focusArea: r.focus_area,
    geography: r.geography,
    notes: r.notes,
    status: isFoundationStatus(r.status) ? r.status : "open",
    sourceKind: r.source_kind,
  };
}

// Curated seed list — foundations Acme Consulting actively maps to (NJ + national,
// behavioral health / community resilience / poverty / criminal justice reform).
// Per pivot brief: source = `~/.openclaw/workspace/memory/projects/` notes
// + prior manual research. NO Candid / Instrumentl pulls.
export const SEED_FOUNDATIONS: Array<Omit<Foundation, "id" | "createdAt" | "updatedAt" | "userEmail">> = [
  {
    sourceLabel: "RWJF",
    title: "Robert Wood Johnson Foundation — Healthy Communities",
    url: "https://www.rwjf.org/en/grants.html",
    deadlineText: "Rolling — varies by program",
    deadlineDate: null,
    fundingMin: "$50,000",
    fundingMax: "$2,500,000",
    focusArea: "Health equity, behavioral health, community resilience",
    geography: "National (NJ-friendly per HQ in Princeton)",
    notes: "HQ in Princeton, NJ. Strong NJ regional preference. Behavioral health and SDOH-aligned programs are core. Open calls vary; Pioneering Ideas RFP runs annually.",
    status: "open",
    sourceKind: "foundation",
  },
  {
    sourceLabel: "Conrad Hilton",
    title: "Conrad N. Hilton Foundation — Substance Use Disorders",
    url: "https://www.hiltonfoundation.org/programs/substance-use-prevention",
    deadlineText: "Invitation-only — relationship-first",
    deadlineDate: null,
    fundingMin: "$250,000",
    fundingMax: "$5,000,000",
    focusArea: "SUD prevention in youth, family-based treatment models",
    geography: "National",
    notes: "Cold apps generally not accepted. Riverside + Dr. Reed story is the door-opener here.",
    status: "open",
    sourceKind: "foundation",
  },
  {
    sourceLabel: "Kresge",
    title: "Kresge Foundation — Human Services + Health",
    url: "https://kresge.org/programs/",
    deadlineText: "Multiple RFPs per year",
    deadlineDate: null,
    fundingMin: "$100,000",
    fundingMax: "$1,500,000",
    focusArea: "Health equity, human services integration, racial/economic justice",
    geography: "National (city-focused, NJ cities eligible)",
    notes: "Detroit-based but national reach. Strong on integrated systems work — Harbor County play possible.",
    status: "open",
    sourceKind: "foundation",
  },
  {
    sourceLabel: "Bloomberg",
    title: "Bloomberg Philanthropies — American Cities Initiative",
    url: "https://www.bloomberg.org/programs/american-cities/",
    deadlineText: "Cycle-based",
    deadlineDate: null,
    fundingMin: "$100,000",
    fundingMax: "$10,000,000",
    focusArea: "Local government innovation, public health, opioid response",
    geography: "US mayors and city programs",
    notes: "American Cities Initiative + Public Health Initiative both live; opioid + overdose prevention overlap with Harbor play.",
    status: "open",
    sourceKind: "foundation",
  },
  {
    sourceLabel: "NJ Health Initiatives",
    title: "New Jersey Health Initiatives (RWJF program in NJ)",
    url: "https://www.njhi.org/",
    deadlineText: "Annual calls",
    deadlineDate: null,
    fundingMin: "$25,000",
    fundingMax: "$300,000",
    focusArea: "NJ-specific community health, equity, youth, food security",
    geography: "New Jersey only",
    notes: "RWJF's NJ-only arm. Smallest checks, but quickest in. NJ-only filter is a moat — fewer national competitors.",
    status: "open",
    sourceKind: "foundation",
  },
  {
    sourceLabel: "Schultz Family",
    title: "Schultz Family Foundation — Onward Initiatives",
    url: "https://schultzfamilyfoundation.org/",
    deadlineText: "Invitation + open calls",
    deadlineDate: null,
    fundingMin: "$50,000",
    fundingMax: "$1,000,000",
    focusArea: "Youth opportunity, veterans, mental health workforce",
    geography: "National",
    notes: "Mental health workforce angle aligns with Dr. Reed / Riverside. Veteran-adjacent SUD programs especially fit.",
    status: "open",
    sourceKind: "foundation",
  },
];

export function listFoundations(opts?: {
  userEmail?: string;
  status?: FoundationStatus;
  sourceLabel?: string;
  limit?: number;
}): Foundation[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts?.userEmail) {
    conds.push("user_email = ?");
    params.push(opts.userEmail);
  }
  if (opts?.status) {
    conds.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.sourceLabel) {
    conds.push("source_label = ?");
    params.push(opts.sourceLabel);
  }
  let sql = `SELECT * FROM foundations`;
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(opts?.limit ?? 500);
  const rows = getDb().prepare(sql).all(...params) as Row[];
  return rows.map(rowTo);
}

export function getFoundation(id: string): Foundation | null {
  const row = getDb()
    .prepare(`SELECT * FROM foundations WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? rowTo(row) : null;
}

export type CreateFoundationInput = Omit<Foundation, "id" | "createdAt" | "updatedAt">;

export function createFoundation(input: CreateFoundationInput): Foundation {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO foundations
       (id, created_at, updated_at, user_email, source_label, title, url, deadline_text, deadline_date, funding_min, funding_max, focus_area, geography, notes, status, source_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      now,
      now,
      input.userEmail,
      input.sourceLabel,
      input.title,
      input.url ?? null,
      input.deadlineText ?? null,
      input.deadlineDate ?? null,
      input.fundingMin ?? null,
      input.fundingMax ?? null,
      input.focusArea ?? null,
      input.geography ?? null,
      input.notes ?? null,
      input.status,
      input.sourceKind,
    );
  tryLogActivity({
    actor: input.userEmail,
    actionType: "scout_promoted",
    targetType: "foundation",
    targetId: id,
    summary: `Foundation added: ${input.sourceLabel} — ${input.title.slice(0, 80)}`,
  });
  return getFoundation(id) as Foundation;
}

export function updateFoundationStatus(
  id: string,
  userEmail: string,
  status: FoundationStatus,
): Foundation | null {
  const existing = getFoundation(id);
  if (!existing || existing.userEmail !== userEmail) return null;
  const now = Date.now();
  getDb()
    .prepare(`UPDATE foundations SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, now, id);
  tryLogActivity({
    actor: userEmail,
    actionType: "scout_promoted",
    targetType: "foundation",
    targetId: id,
    summary: `Foundation ${existing.sourceLabel} → ${status}`,
  });
  return getFoundation(id);
}

export function deleteFoundation(id: string, userEmail: string): boolean {
  const existing = getFoundation(id);
  if (!existing || existing.userEmail !== userEmail) return false;
  const res = getDb().prepare(`DELETE FROM foundations WHERE id = ?`).run(id);
  return res.changes > 0;
}

// Seed-if-empty for a user. Returns { seeded, existing }.
export function seedFoundationsForUser(userEmail: string): { seeded: number; existing: number } {
  const existing = listFoundations({ userEmail, limit: 1 });
  if (existing.length > 0) {
    return { seeded: 0, existing: listFoundations({ userEmail }).length };
  }
  let seeded = 0;
  for (const f of SEED_FOUNDATIONS) {
    try {
      createFoundation({ ...f, userEmail });
      seeded++;
    } catch {
      // skip duplicates / errors
    }
  }
  return { seeded, existing: 0 };
}

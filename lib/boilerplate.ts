import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "./db";
import { tryLogActivity } from "./activity";
import { parseBlockEntries, type RawBlockEntry } from "./block-seed";
import {
  contentHash,
  eligibleForReuse,
  isApprovalStatus,
  isConfidentiality,
  type ApprovalStatus,
  type Confidentiality,
  type ReuseCandidate,
} from "./proposal-memory";

export type BoilerplateBlock = {
  id: string;
  key: string;
  title: string;
  bodyMarkdown: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  notes: string | null;
  /** Grouping tag (Item 2.1). Null for legacy curated blocks. */
  category: string | null;
  /** "ready" | "needs_review" — flags blocks still carrying placeholders. */
  status: string;
  // §14.9 reuse controls (migration 033) — enforced by listReusableBoilerplate,
  // exposed here so the library UI can operate them.
  approvalStatus: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: number | null;
  source: string | null;
  contentHash: string | null;
  effectiveFrom: number | null;
  expiresAt: number | null;
  confidentiality: Confidentiality;
  permittedUse: string | null;
  restrictedFunders: string[];
  doNotReuse: boolean;
  doNotReuseReason: string | null;
  supersededBy: string | null;
  /**
   * Would drafting use this block right now (external context, i.e. content
   * that leaves the building)? Computed server-side at read time so the UI
   * can answer "is this actually reaching my proposals?" at a glance.
   */
  reuse: { usable: boolean; reason: string | null };
};

export type BoilerplatePin = {
  id: string;
  draftId: string;
  blockId: string;
  blockKey: string;
  pinnedVersion: number;
  insertedAt: number;
  positionHint: string | null;
};

type BlockRow = {
  id: string;
  key: string;
  title: string;
  body_markdown: string;
  version: number;
  created_at: number;
  updated_at: number;
  notes: string | null;
  category: string | null;
  status: string | null;
  // 033_proposal_memory_controls
  approval_status: string | null;
  approved_by: string | null;
  approved_at: number | null;
  source: string | null;
  content_hash: string | null;
  effective_from: number | null;
  expires_at: number | null;
  confidentiality: string | null;
  permitted_use: string | null;
  restricted_funders_json: string | null;
  do_not_reuse: number | null;
  do_not_reuse_reason: string | null;
  superseded_by: string | null;
};

type PinRow = {
  id: string;
  draft_id: string;
  block_id: string;
  block_key: string;
  pinned_version: number;
  inserted_at: number;
  position_hint: string | null;
};

function parseFunders(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rowToBlock(r: BlockRow): BoilerplateBlock {
  const candidate: ReuseCandidate = {
    key: r.key,
    approvalStatus: isApprovalStatus(r.approval_status) ? r.approval_status : "unreviewed",
    effectiveFrom: r.effective_from ?? null,
    expiresAt: r.expires_at ?? null,
    confidentiality: isConfidentiality(r.confidentiality) ? r.confidentiality : "internal",
    restrictedFunders: parseFunders(r.restricted_funders_json),
    doNotReuse: r.do_not_reuse === 1,
    doNotReuseReason: r.do_not_reuse_reason ?? null,
    supersededBy: r.superseded_by ?? null,
  };
  // External context: "usable" here means "may leave the building in a
  // submitted proposal", the strictest common drafting path.
  const verdict = eligibleForReuse(candidate, { now: Date.now(), external: true });
  return {
    id: r.id,
    key: r.key,
    title: r.title,
    bodyMarkdown: r.body_markdown,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    notes: r.notes,
    category: r.category ?? null,
    status: r.status ?? "ready",
    approvalStatus: candidate.approvalStatus,
    approvedBy: r.approved_by ?? null,
    approvedAt: r.approved_at ?? null,
    source: r.source ?? null,
    contentHash: r.content_hash ?? null,
    effectiveFrom: candidate.effectiveFrom,
    expiresAt: candidate.expiresAt,
    confidentiality: candidate.confidentiality,
    permittedUse: r.permitted_use ?? null,
    restrictedFunders: candidate.restrictedFunders,
    doNotReuse: candidate.doNotReuse,
    doNotReuseReason: candidate.doNotReuseReason,
    supersededBy: candidate.supersededBy,
    reuse: verdict.eligible ? { usable: true, reason: null } : { usable: false, reason: verdict.reason },
  };
}

function rowToPin(r: PinRow): BoilerplatePin {
  return {
    id: r.id,
    draftId: r.draft_id,
    blockId: r.block_id,
    blockKey: r.block_key,
    pinnedVersion: r.pinned_version,
    insertedAt: r.inserted_at,
    positionHint: r.position_hint,
  };
}

// Seed catalogue per Sprint 5 brief. CRITICAL: NO "Jane Barred" anywhere
// in any block per [[banned-names-policy]]. Dr. Reed uses canonical
// "Taylor Paul Reed, PhD, MPH" per [[personnel-naming-policy]].
// Canonical email per [[canonical-email-policy]].
export const SEED_BLOCKS: Array<
  Omit<
    BoilerplateBlock,
    | "id"
    | "version"
    | "createdAt"
    | "updatedAt"
    | "category"
    | "status"
    // §14.9 columns take their schema defaults on seed.
    | "approvalStatus"
    | "approvedBy"
    | "approvedAt"
    | "source"
    | "contentHash"
    | "effectiveFrom"
    | "expiresAt"
    | "confidentiality"
    | "permittedUse"
    | "restrictedFunders"
    | "doNotReuse"
    | "doNotReuseReason"
    | "supersededBy"
    | "reuse"
  >
> = [
  {
    key: "acme-consulting-capability-statement",
    title: "Acme Consulting — Full Capability Statement",
    notes: "Lead block for any federal grant. Update annually.",
    bodyMarkdown: `## Acme Consulting Group LLC — Capability Statement

**Headquarters:** New Jersey
**Primary contact:** contact@example.org
**UEI:** EXAMPLEUEI00
**CAGE:** 0ZZZ0
**NAICS:** 541611 (Administrative Management), 541512 (Computer Systems Design),
541618 (Other Management Consulting), 561110 (Office Administrative Services)

**Core competencies:**
- AI-driven proposal development and federal grant strategy
- Behavioral health and substance use disorder program design
- Public-sector consortium orchestration (NJ-anchored)
- Court-involved population services and community reentry programs
- Federal compliance, NOFO interpretation, and submission readiness

**Differentiators:**
- 8(a) program application in process (status: pending SBA review)
- NJ MBE certification (issuer: NJ Division of Minority/Women Business Development)
- Consortium-of-record relationships with Riverside, Atlas Insights, Harborview, and Brightline
- Track record of Harbor County behavioral health and SUD funding work
`,
  },
  {
    key: "acme-consulting-naics-codes",
    title: "Acme Consulting — Primary NAICS",
    notes: "Drop-in block when a NOFO requires explicit NAICS declaration.",
    bodyMarkdown: `**Primary NAICS:** 541611 — Administrative Management & General Management Consulting Services
**Secondary NAICS:** 541512, 541618, 561110`,
  },
  {
    key: "acme-consulting-uei",
    title: "Acme Consulting — UEI",
    notes: "Single-field block. Update if UEI ever rotates.",
    bodyMarkdown: `EXAMPLEUEI00`,
  },
  {
    key: "acme-consulting-cage",
    title: "Acme Consulting — CAGE Code",
    notes: "Single-field block. Update if CAGE ever rotates.",
    bodyMarkdown: `0ZZZ0`,
  },
  {
    key: "acme-consulting-mbe-cert",
    title: "Acme Consulting — NJ MBE Certification",
    notes: "Issuer per the issuing authority — NJ Division of Minority/Women Business Development.",
    // Dates per the operator (2026-08-04): month + year only — he supplied "1/2025"
    // and "1/2030", so no day-of-month is rendered. Fabricating one in a
    // compliance document is the failure mode this library exists to avoid.
    bodyMarkdown: `**Minority Business Enterprise (MBE) Certification**
- Issuer: New Jersey Division of Minority and Women Business Development
- Confirmation Number: 00000000000
- Effective: January 2025
- Expiration: January 2030`,
  },
  {
    key: "acme-consulting-8a-status",
    title: "Acme Consulting — 8(a) Status",
    notes: "Currently application-pending. Flip to certified when SBA approves — single edit propagates.",
    bodyMarkdown: `**SBA 8(a) Business Development Program:** Application submitted; pending SBA review and certification.`,
  },
  {
    key: "harbor-county-track-record",
    title: "Harbor County — Track Record Paragraph",
    notes: "Use in past-performance and capability sections for any Harbor County opportunity.",
    bodyMarkdown: `**Harbor County Track Record.** Acme Consulting Group LLC has worked alongside Harbor County stakeholders on behavioral health and substance use disorder program design, partnering with Riverside Community Action Corporation (Riverside) and Harborview on community-based delivery models. Our team tracks county funding streams, opioid settlement disbursement timelines, and reentry-population service gaps, and can mobilize a consortium response within standard NOFO submission windows.`,
  },
  {
    key: "riverside-partnership-letter-template",
    title: "Riverside — Partnership Letter Template",
    notes: "Boilerplate intro paragraph; Riverside will sign verbatim per integration_notes.",
    bodyMarkdown: `[Riverside Letterhead]

[Date]

Re: Letter of Partnership — [Program / NOFO Title]

To Whom It May Concern:

Riverside Community Action Corporation (Riverside) is pleased to confirm its partnership with Acme Consulting Group LLC on the above-referenced opportunity. Riverside will serve as a community-based delivery partner, providing behavioral health and substance use disorder service infrastructure across our Harbor County service area.

Riverside commits to: (1) deploying licensed clinical capacity for direct service delivery, (2) coordinating with Acme Consulting on outreach to court-involved and underserved populations, and (3) participating in evaluation and reporting activities through the period of performance.

We endorse the proposed scope of work and confirm our readiness to execute upon award.

Sincerely,
[Riverside signatory name + title]`,
  },
  {
    key: "dr-reed-cv-summary",
    title: "Dr. Taylor Paul Reed — CV Summary",
    notes: "Canonical personnel name — always render the full credentialed form.",
    bodyMarkdown: `**Taylor Paul Reed, PhD, MPH**

Dr. Reed is a behavioral health researcher and program design lead with extensive experience in substance use disorder treatment models, community-based mental health delivery, and equity-centered intervention design. Dr. Reed serves as a joint principal in CasePath (with Acme Consulting Group LLC and Example Tech LLC) and contributes program design expertise across the Acme Consulting consortium's portfolio. Areas of expertise include workforce development for the behavioral health field, court-involved population service design, and culturally responsive treatment frameworks.`,
  },
  {
    key: "acme-consulting-contact-info",
    title: "Acme Consulting — Contact Information",
    notes: "Canonical email per [[canonical-email-policy]].",
    bodyMarkdown: `**Acme Consulting Group LLC**
Email: contact@example.org
Address (federal-grant address of record): 123 Main Street, Suite 100, Springfield, ST 00000
Web: app.govscout.ai (internal proposal workbench)`,
  },
  {
    key: "federal-political-climate-language",
    title: "Federal Political Climate — DEI-Scrubbed Standard Framings",
    notes: "Per standing editorial guidance. Use these instead of DEI-coded phrasing in federal applications under the current administration.",
    bodyMarkdown: `## Approved framings (use these in federal narratives)

- "Underserved communities" → use "communities with documented service gaps"
- "Equity" → use "equal access" or "fair access" where measurable
- "Inclusion" → use "broad participation" with concrete outreach metrics
- "Disparities" → use "differential outcomes" with quantitative anchors
- "Marginalized populations" → use the specific demographic backed by service-gap data
- "Anti-racism" → omit entirely from federal narratives in 2026 cycle
- "Justice-involved" / "court-involved" → both still acceptable; "justice-involved" is preferred federal language

## Framing principle

Federal funders in the current 2026 climate accept service-gap language anchored
to measurable outcomes; they reject language framed as identity politics. Frame
every population statement as a measurable service-delivery gap with a numeric
floor (e.g., "the 18-county region currently has 0.42 SUD treatment slots per
1,000 residents against a federally-recommended floor of 1.5").`,
  },
];

export function listBoilerplate(): BoilerplateBlock[] {
  const rows = getDb()
    .prepare(`SELECT * FROM boilerplate_blocks ORDER BY key ASC`)
    .all() as BlockRow[];
  return rows.map(rowToBlock);
}

/**
 * Blocks that may actually be reused, with the withheld ones and why (§14.9).
 *
 * listBoilerplate() returns the whole library, which is right for the
 * management UI and wrong for drafting: it includes unapproved, expired,
 * superseded, funder-restricted and DO_NOT_REUSE content. Drafting paths call
 * this instead, so an expired indirect-rate paragraph cannot reach a funder
 * because someone forgot it had lapsed.
 *
 * `withheld` is returned rather than silently dropped — a reviewer needs to
 * see that a block was excluded and for what reason.
 */
export function listReusableBoilerplate(ctx: {
  now?: number;
  funder?: string | null;
  external?: boolean;
}): { usable: BoilerplateBlock[]; withheld: Array<{ block: BoilerplateBlock; reason: string }> } {
  const rows = getDb()
    .prepare(`SELECT * FROM boilerplate_blocks ORDER BY key ASC`)
    .all() as BlockRow[];

  const candidates = rows.map((row) => ({
    block: rowToBlock(row),
    candidate: {
      key: row.key,
      approvalStatus: isApprovalStatus(row.approval_status) ? row.approval_status : "unreviewed",
      effectiveFrom: row.effective_from ?? null,
      expiresAt: row.expires_at ?? null,
      confidentiality: isConfidentiality(row.confidentiality) ? row.confidentiality : "internal",
      restrictedFunders: row.restricted_funders_json
        ? (JSON.parse(row.restricted_funders_json) as string[])
        : [],
      doNotReuse: row.do_not_reuse === 1,
      doNotReuseReason: row.do_not_reuse_reason ?? null,
      supersededBy: row.superseded_by ?? null,
    } satisfies ReuseCandidate,
  }));

  const usable: BoilerplateBlock[] = [];
  const withheld: Array<{ block: BoilerplateBlock; reason: string }> = [];
  const now = ctx.now ?? Date.now();
  for (const { block, candidate } of candidates) {
    const v = eligibleForReuse(candidate, { now, funder: ctx.funder, external: ctx.external });
    if (v.eligible) usable.push(block);
    else withheld.push({ block, reason: v.reason });
  }
  return { usable, withheld };
}

export function getBoilerplate(idOrKey: string): BoilerplateBlock | null {
  const row = getDb()
    .prepare(`SELECT * FROM boilerplate_blocks WHERE id = ? OR key = ?`)
    .get(idOrKey, idOrKey) as BlockRow | undefined;
  return row ? rowToBlock(row) : null;
}

/** Hard-delete a block and any draft pins referencing it. */
export function deleteBoilerplate(idOrKey: string): boolean {
  const block = getBoilerplate(idOrKey);
  if (!block) return false;
  const db = getDb();
  db.prepare(`DELETE FROM boilerplate_pins WHERE block_id = ?`).run(block.id);
  return db.prepare(`DELETE FROM boilerplate_blocks WHERE id = ?`).run(block.id).changes > 0;
}

export function upsertBoilerplate(input: {
  key: string;
  title: string;
  bodyMarkdown: string;
  notes?: string | null;
  category?: string | null;
  status?: string | null;
  actor: string;
  bumpVersion?: boolean;
}): BoilerplateBlock {
  const existing = getBoilerplate(input.key);
  const now = Date.now();
  if (existing) {
    const nextVersion = input.bumpVersion ? existing.version + 1 : existing.version;
    // Preserve existing category/status unless the caller supplies new values —
    // an interactive edit shouldn't silently wipe a seeded block's grouping.
    const nextCategory = input.category !== undefined ? input.category : existing.category;
    const nextStatus = input.status != null ? input.status : existing.status;
    getDb()
      .prepare(
        `UPDATE boilerplate_blocks
           SET title = ?, body_markdown = ?, notes = ?, category = ?, status = ?,
               version = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title,
        input.bodyMarkdown,
        input.notes ?? null,
        nextCategory,
        nextStatus,
        nextVersion,
        now,
        existing.id,
      );
    tryLogActivity({
      actor: input.actor,
      actionType: "boilerplate_updated",
      targetType: "boilerplate",
      targetId: existing.id,
      summary: `Boilerplate "${input.key}" → v${nextVersion}`,
    });
    return getBoilerplate(existing.id) as BoilerplateBlock;
  }
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO boilerplate_blocks (id, key, title, body_markdown, version, created_at, updated_at, notes, category, status)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.key,
      input.title,
      input.bodyMarkdown,
      now,
      now,
      input.notes ?? null,
      input.category ?? null,
      input.status ?? "ready",
    );
  tryLogActivity({
    actor: input.actor,
    actionType: "boilerplate_updated",
    targetType: "boilerplate",
    targetId: id,
    summary: `Boilerplate "${input.key}" v1 created`,
  });
  return getBoilerplate(id) as BoilerplateBlock;
}

/** Editable fields for updateBoilerplate. Absent fields are left unchanged. */
export type BoilerplateUpdate = {
  title?: string;
  bodyMarkdown?: string;
  notes?: string | null;
  /** Bump version even without a body change (UI "Save & bump"). */
  bumpVersion?: boolean;
  // §14.9 reuse controls.
  approvalStatus?: ApprovalStatus;
  confidentiality?: Confidentiality;
  effectiveFrom?: number | null;
  expiresAt?: number | null;
  doNotReuse?: boolean;
  doNotReuseReason?: string | null;
  restrictedFunders?: string[];
  supersededBy?: string | null;
  source?: string | null;
  permittedUse?: string | null;
};

/**
 * Update an existing block — the operating surface for the §14.9 controls.
 * Column writes are whitelisted below; arbitrary input never reaches SQL.
 *
 * Body-change rules (the capability-statement stub is why these exist):
 * - content_hash is recomputed and version bumps on any body change;
 * - approval_status is NEVER changed implicitly — approving is a deliberate
 *   act, and an edit silently keeping "approved" is how a 38-byte stub stayed
 *   drafting-reachable for two months;
 * - when the body of an APPROVED block changes, approved_by/approved_at are
 *   set to the editor and now, so the record shows who approved THIS text
 *   rather than some earlier text.
 */
export function updateBoilerplate(
  idOrKey: string,
  update: BoilerplateUpdate,
  actor: string,
): BoilerplateBlock {
  const existing = getBoilerplate(idOrKey);
  if (!existing) throw new Error(`unknown boilerplate block: ${idOrKey}`);

  if (update.title !== undefined && !update.title.trim()) throw new Error("title cannot be empty");
  if (update.bodyMarkdown !== undefined && /jane\s*barred/i.test(update.bodyMarkdown)) {
    // Same standing rule the PUT route enforces — kept here too so no other
    // caller can slip it past the API layer.
    throw new Error('Block content includes "Jane Barred" — refused per standing rule.');
  }
  if (update.approvalStatus !== undefined && !isApprovalStatus(update.approvalStatus)) {
    throw new Error(`invalid approvalStatus: ${update.approvalStatus}`);
  }
  if (update.confidentiality !== undefined && !isConfidentiality(update.confidentiality)) {
    throw new Error(`invalid confidentiality: ${update.confidentiality}`);
  }
  for (const key of ["effectiveFrom", "expiresAt"] as const) {
    const v = update[key];
    if (v !== undefined && v !== null && !Number.isFinite(v)) throw new Error(`invalid ${key}: ${v}`);
  }
  if (
    update.restrictedFunders !== undefined &&
    (!Array.isArray(update.restrictedFunders) || update.restrictedFunders.some((f) => typeof f !== "string"))
  ) {
    throw new Error("restrictedFunders must be an array of strings");
  }
  if (update.supersededBy != null) {
    if (update.supersededBy === existing.key) throw new Error("a block cannot supersede itself");
    if (!getBoilerplate(update.supersededBy)) {
      throw new Error(`supersededBy does not match any block: ${update.supersededBy}`);
    }
  }

  const now = Date.now();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: existing.id };
  const set = (col: string, value: unknown) => {
    fields.push(`${col} = @${col}`);
    params[col] = value;
  };

  if (update.title !== undefined) set("title", update.title.trim());
  if (update.notes !== undefined) set("notes", update.notes ?? null);
  if (update.approvalStatus !== undefined) set("approval_status", update.approvalStatus);
  if (update.confidentiality !== undefined) set("confidentiality", update.confidentiality);
  if (update.effectiveFrom !== undefined) set("effective_from", update.effectiveFrom);
  if (update.expiresAt !== undefined) set("expires_at", update.expiresAt);
  if (update.doNotReuse !== undefined) set("do_not_reuse", update.doNotReuse ? 1 : 0);
  if (update.doNotReuseReason !== undefined) set("do_not_reuse_reason", update.doNotReuseReason ?? null);
  if (update.restrictedFunders !== undefined) {
    set("restricted_funders_json", JSON.stringify(update.restrictedFunders));
  }
  if (update.supersededBy !== undefined) set("superseded_by", update.supersededBy ?? null);
  if (update.source !== undefined) set("source", update.source ?? null);
  if (update.permittedUse !== undefined) set("permitted_use", update.permittedUse ?? null);

  const bodyChanged = update.bodyMarkdown !== undefined && update.bodyMarkdown !== existing.bodyMarkdown;
  if (bodyChanged) {
    set("body_markdown", update.bodyMarkdown);
    set("content_hash", contentHash(update.bodyMarkdown!));
    if (existing.approvalStatus === "approved" && update.approvalStatus === undefined) {
      set("approved_by", actor);
      set("approved_at", now);
    }
  }
  // A deliberate (re-)approval records who approved and when.
  if (update.approvalStatus === "approved") {
    set("approved_by", actor);
    set("approved_at", now);
  }

  const version = bodyChanged || update.bumpVersion ? existing.version + 1 : existing.version;
  set("version", version);
  set("updated_at", now);

  getDb().prepare(`UPDATE boilerplate_blocks SET ${fields.join(", ")} WHERE id = @id`).run(params);
  tryLogActivity({
    actor,
    actionType: "boilerplate_updated",
    targetType: "boilerplate",
    targetId: existing.id,
    summary: `Boilerplate "${existing.key}" updated (v${version})`,
  });
  return getBoilerplate(existing.id) as BoilerplateBlock;
}

export function seedBoilerplate(actor: string): { seeded: number; existing: number } {
  const before = listBoilerplate().length;
  let seeded = 0;
  for (const b of SEED_BLOCKS) {
    if (getBoilerplate(b.key)) continue;
    upsertBoilerplate({
      key: b.key,
      title: b.title,
      bodyMarkdown: b.bodyMarkdown,
      notes: b.notes ?? null,
      actor,
    });
    seeded++;
  }
  return { seeded, existing: before };
}

// Item 2.1: seed the production markdown library in data/blocks/ into
// boilerplate_blocks. Reads every *.md (skipping README), derives title /
// category / needs_review via the pure block-seed transform, and upserts
// idempotently (skip if the key already exists). The disk read is the only I/O
// here; the transform is tested separately in tests/block-seed.test.ts.
export function seedBoilerplateFromDisk(
  actor: string,
  dir: string = path.join(process.cwd(), "data", "blocks"),
): { seeded: number; skipped: number; needsReview: number } {
  let entries: RawBlockEntry[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => /\.md$/i.test(f))
      .map((f) => ({ filename: f, content: fs.readFileSync(path.join(dir, f), "utf8") }));
  } catch {
    return { seeded: 0, skipped: 0, needsReview: 0 };
  }
  const blocks = parseBlockEntries(entries);
  let seeded = 0;
  let skipped = 0;
  let needsReview = 0;
  for (const b of blocks) {
    if (getBoilerplate(b.key)) {
      skipped++;
      continue;
    }
    upsertBoilerplate({
      key: b.key,
      title: b.title,
      bodyMarkdown: b.bodyMarkdown,
      notes: b.notes,
      category: b.category,
      status: b.status,
      actor,
    });
    seeded++;
    if (b.status === "needs_review") needsReview++;
  }
  return { seeded, skipped, needsReview };
}

// Combined seeder: curated catalogue + the on-disk production library. This is
// what the /boilerplate "Seed" button and the API call, so one action fills the
// library from both sources. Idempotent — re-running adds nothing.
export function seedAllBoilerplate(
  actor: string,
): { seeded: number; existing: number; needsReview: number } {
  const before = listBoilerplate().length;
  const curated = seedBoilerplate(actor);
  const disk = seedBoilerplateFromDisk(actor);
  return {
    seeded: curated.seeded + disk.seeded,
    existing: before,
    needsReview: disk.needsReview,
  };
}

// Insertion pin tracking
export function pinBoilerplateToDraft(input: {
  draftId: string;
  blockKey: string;
  positionHint?: string | null;
}): BoilerplatePin {
  const block = getBoilerplate(input.blockKey);
  if (!block) throw new Error(`unknown boilerplate key: ${input.blockKey}`);
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO boilerplate_pins (id, draft_id, block_id, block_key, pinned_version, inserted_at, position_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.draftId, block.id, block.key, block.version, now, input.positionHint ?? null);
  const pin = getDb()
    .prepare(`SELECT * FROM boilerplate_pins WHERE id = ?`)
    .get(id) as PinRow;
  return rowToPin(pin);
}

export function listPinsForDraft(draftId: string): BoilerplatePin[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM boilerplate_pins WHERE draft_id = ? ORDER BY inserted_at DESC`,
    )
    .all(draftId) as PinRow[];
  return rows.map(rowToPin);
}

// Pins where the live block has advanced past the pinned version.
export function stalePinsForDraft(draftId: string): Array<{
  pin: BoilerplatePin;
  liveVersion: number;
}> {
  const pins = listPinsForDraft(draftId);
  const out: Array<{ pin: BoilerplatePin; liveVersion: number }> = [];
  for (const p of pins) {
    const live = getBoilerplate(p.blockKey);
    if (live && live.version > p.pinnedVersion) {
      out.push({ pin: p, liveVersion: live.version });
    }
  }
  return out;
}

import { randomUUID } from "crypto";
import { getDb, getDraft, saveDraft, type DraftRecord } from "./db";
import type { SectionMap } from "./sections";
import type { ExtractedNofo } from "./extract";
import { tryLogActivity } from "./activity";

export type DraftSnapshot = {
  id: string;
  draftId: string;
  userEmail: string;
  snapshotNo: number;
  createdAt: number;
  note: string | null;
  title: string;
  business: string;
  naics: string;
  opportunity: string;
  blocks: string[];
  structured: ExtractedNofo | null;
  sections: SectionMap;
  meta: Record<string, unknown> | null;
};

type Row = {
  id: string;
  draft_id: string;
  user_email: string;
  snapshot_no: number;
  created_at: number;
  note: string | null;
  title: string;
  business: string;
  naics: string;
  opportunity: string;
  blocks_json: string;
  structured_json: string | null;
  sections_json: string;
  meta_json: string | null;
};

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowTo(r: Row): DraftSnapshot {
  return {
    id: r.id,
    draftId: r.draft_id,
    userEmail: r.user_email,
    snapshotNo: r.snapshot_no,
    createdAt: r.created_at,
    note: r.note,
    title: r.title,
    business: r.business,
    naics: r.naics,
    opportunity: r.opportunity,
    blocks: safeParse(r.blocks_json, [] as string[]),
    structured: safeParse(r.structured_json, null as ExtractedNofo | null),
    sections: safeParse(r.sections_json, {} as SectionMap),
    meta: safeParse(r.meta_json, null as Record<string, unknown> | null),
  };
}

function nextSnapshotNo(draftId: string): number {
  const row = getDb()
    .prepare(`SELECT MAX(snapshot_no) as n FROM draft_snapshots WHERE draft_id = ?`)
    .get(draftId) as { n: number | null } | undefined;
  return (row?.n ?? 0) + 1;
}

export function createSnapshot(input: {
  draftId: string;
  userEmail: string;
  note?: string | null;
}): DraftSnapshot {
  const draft = getDraft(input.draftId, input.userEmail);
  if (!draft) throw new Error(`draft ${input.draftId} not found`);
  const id = randomUUID();
  const snapshotNo = nextSnapshotNo(input.draftId);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO draft_snapshots (id, draft_id, user_email, snapshot_no, created_at, note, title, business, naics, opportunity, blocks_json, structured_json, sections_json, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.draftId,
      input.userEmail,
      snapshotNo,
      now,
      input.note ?? null,
      draft.title,
      draft.business,
      draft.naics,
      draft.opportunity,
      JSON.stringify(draft.blocks),
      draft.structured ? JSON.stringify(draft.structured) : null,
      JSON.stringify(draft.sections),
      draft.meta ? JSON.stringify(draft.meta) : null,
    );
  tryLogActivity({
    actor: input.userEmail,
    actionType: "draft_version_saved",
    targetType: "draft",
    targetId: input.draftId,
    summary: `Snapshot v${snapshotNo} saved${input.note ? `: ${input.note.slice(0, 80)}` : ""}`,
  });
  return getSnapshot(id, input.userEmail) as DraftSnapshot;
}

export function getSnapshot(id: string, userEmail: string): DraftSnapshot | null {
  const row = getDb()
    .prepare(`SELECT * FROM draft_snapshots WHERE id = ? AND user_email = ?`)
    .get(id, userEmail) as Row | undefined;
  return row ? rowTo(row) : null;
}

export function listSnapshots(draftId: string, userEmail: string): DraftSnapshot[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM draft_snapshots WHERE draft_id = ? AND user_email = ?
       ORDER BY snapshot_no DESC`,
    )
    .all(draftId, userEmail) as Row[];
  return rows.map(rowTo);
}

// Restoring a snapshot writes a *new* snapshot capturing the current state
// first (so history is preserved), then overwrites the live draft. The
// snapshot table itself stays append-only.
export function restoreSnapshot(input: {
  snapshotId: string;
  userEmail: string;
}): DraftRecord {
  const snap = getSnapshot(input.snapshotId, input.userEmail);
  if (!snap) {
    throw new Error("snapshot not found");
  }
  // Capture current state before overwriting
  createSnapshot({
    draftId: snap.draftId,
    userEmail: input.userEmail,
    note: `auto-snapshot before restore of v${snap.snapshotNo}`,
  });
  const restored = saveDraft({
    id: snap.draftId,
    userEmail: input.userEmail,
    title: snap.title,
    business: snap.business,
    naics: snap.naics,
    opportunity: snap.opportunity,
    blocks: snap.blocks,
    structured: snap.structured,
    sections: snap.sections,
    meta: { ...(snap.meta ?? {}), restoredFromSnapshot: snap.snapshotNo },
    nofoId: null,
    poolId: null,
  });
  tryLogActivity({
    actor: input.userEmail,
    actionType: "draft_version_saved",
    targetType: "draft",
    targetId: snap.draftId,
    summary: `Restored from snapshot v${snap.snapshotNo}`,
  });
  return restored;
}

// Tiny line-level unified diff. Good enough for surfacing what changed
// between two snapshots or a snapshot and the live draft. No external dep.
export function unifiedDiff(a: string, b: string, contextLines = 2): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  if (a === b) return "(no differences)";
  // Compute LCS-based diff via classic DP
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  type Op = { op: "=" | "+" | "-"; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      ops.push({ op: "=", text: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: "-", text: aLines[i] });
      i++;
    } else {
      ops.push({ op: "+", text: bLines[j] });
      j++;
    }
  }
  while (i < m) ops.push({ op: "-", text: aLines[i++] });
  while (j < n) ops.push({ op: "+", text: bLines[j++] });

  // Build hunks with context
  const out: string[] = [];
  let lastChangeIdx = -1;
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].op !== "=") {
      const start = Math.max(0, idx - contextLines);
      if (start > lastChangeIdx + 1) {
        if (lastChangeIdx >= 0) out.push("...");
        for (let k = start; k < idx; k++) out.push(` ${ops[k].text}`);
      }
      out.push(`${ops[idx].op} ${ops[idx].text}`);
      lastChangeIdx = idx;
    } else if (idx - lastChangeIdx <= contextLines && lastChangeIdx >= 0) {
      out.push(` ${ops[idx].text}`);
    }
  }
  return out.join("\n");
}

// Sections-level diff: returns a per-section map of unified-diff strings.
export function diffSnapshotsBySections(
  before: DraftSnapshot | null,
  after: { sections: SectionMap },
): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = new Set([
    ...Object.keys(after.sections ?? {}),
    ...Object.keys(before?.sections ?? {}),
  ]);
  for (const k of keys) {
    const a = before?.sections?.[k as keyof SectionMap] ?? "";
    const b = (after.sections as Record<string, string>)[k] ?? "";
    if (a === b) continue;
    out[k] = unifiedDiff(a, b);
  }
  return out;
}

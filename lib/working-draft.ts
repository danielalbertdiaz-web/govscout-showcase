// Item 2.2: Working Draft side pane data layer.
//
// Promoted draft blocks live in working_draft_items (ordered by `position`);
// each assemble pass joins them into one combined document, sanitized through
// the 1.6 partner-copy guard, and stores the result in working_draft_assemblies
// against the draft (= the opportunity). assembleWorkingDraft is pure so the
// ordering + sanitization is unit-tested without a database.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { sanitizePartnerCopy } from "./partner-copy";

export type WorkingDraftItem = {
  id: string;
  draftId: string;
  title: string;
  bodyMarkdown: string;
  sourceKind: string;
  sourceRef: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
};

type ItemRow = {
  id: string;
  draft_id: string;
  title: string;
  body_markdown: string;
  source_kind: string;
  source_ref: string | null;
  position: number;
  created_at: number;
  updated_at: number;
};

function rowToItem(r: ItemRow): WorkingDraftItem {
  return {
    id: r.id,
    draftId: r.draft_id,
    title: r.title,
    bodyMarkdown: r.body_markdown,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listWorkingDraftItems(draftId: string): WorkingDraftItem[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM working_draft_items WHERE draft_id = ? ORDER BY position ASC, created_at ASC`,
    )
    .all(draftId) as ItemRow[];
  return rows.map(rowToItem);
}

export function addWorkingDraftItem(input: {
  draftId: string;
  title: string;
  bodyMarkdown: string;
  sourceKind?: string;
  sourceRef?: string | null;
}): WorkingDraftItem {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const maxRow = db
    .prepare(`SELECT MAX(position) AS m FROM working_draft_items WHERE draft_id = ?`)
    .get(input.draftId) as { m: number | null } | undefined;
  const position = (maxRow?.m ?? -1) + 1;
  db.prepare(
    `INSERT INTO working_draft_items
       (id, draft_id, title, body_markdown, source_kind, source_ref, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.draftId,
    input.title,
    input.bodyMarkdown,
    input.sourceKind ?? "section",
    input.sourceRef ?? null,
    position,
    now,
    now,
  );
  return rowToItem(
    db.prepare(`SELECT * FROM working_draft_items WHERE id = ?`).get(id) as ItemRow,
  );
}

export function updateWorkingDraftItem(
  draftId: string,
  itemId: string,
  patch: { title?: string; bodyMarkdown?: string },
): WorkingDraftItem | null {
  const db = getDb();
  const existing = db
    .prepare(`SELECT * FROM working_draft_items WHERE id = ? AND draft_id = ?`)
    .get(itemId, draftId) as ItemRow | undefined;
  if (!existing) return null;
  db.prepare(
    `UPDATE working_draft_items SET title = ?, body_markdown = ?, updated_at = ? WHERE id = ?`,
  ).run(
    patch.title ?? existing.title,
    patch.bodyMarkdown ?? existing.body_markdown,
    Date.now(),
    itemId,
  );
  return rowToItem(
    db.prepare(`SELECT * FROM working_draft_items WHERE id = ?`).get(itemId) as ItemRow,
  );
}

export function removeWorkingDraftItem(draftId: string, itemId: string): boolean {
  const res = getDb()
    .prepare(`DELETE FROM working_draft_items WHERE id = ? AND draft_id = ?`)
    .run(itemId, draftId);
  return Number(res.changes ?? 0) > 0;
}

/**
 * Reorder the pane: `orderedIds` is the full set of item ids in their new order.
 * Positions are rewritten to the array index. Ids not belonging to the draft are
 * ignored. Returns the reordered list.
 */
export function reorderWorkingDraftItems(
  draftId: string,
  orderedIds: string[],
): WorkingDraftItem[] {
  const db = getDb();
  const owned = new Set(
    (db
      .prepare(`SELECT id FROM working_draft_items WHERE draft_id = ?`)
      .all(draftId) as Array<{ id: string }>).map((r) => r.id),
  );
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE working_draft_items SET position = ?, updated_at = ? WHERE id = ? AND draft_id = ?`,
  );
  const tx = (db as { transaction?: (fn: () => void) => () => void }).transaction;
  const run = () => {
    let pos = 0;
    for (const id of orderedIds) {
      if (!owned.has(id)) continue;
      stmt.run(pos, now, id, draftId);
      pos++;
    }
  };
  if (typeof tx === "function") tx(run)();
  else run();
  return listWorkingDraftItems(draftId);
}

/**
 * Combine promoted items into one markdown document, in order. Each block's
 * title becomes an `##` heading and each body is run through the 1.6 sanitizer
 * so no internal copy can leak into the assembled, exportable document. Pure.
 */
export function assembleWorkingDraft(
  items: Array<{ title: string; bodyMarkdown: string }>,
  opts: { documentTitle?: string } = {},
): string {
  const parts: string[] = [];
  if (opts.documentTitle && opts.documentTitle.trim()) {
    parts.push(`# ${sanitizePartnerCopy(opts.documentTitle).clean.trim()}`);
  }
  for (const item of items) {
    const title = sanitizePartnerCopy(item.title).clean.trim();
    const body = sanitizePartnerCopy(item.bodyMarkdown).clean.trim();
    if (!title && !body) continue;
    const section: string[] = [];
    if (title) section.push(`## ${title}`);
    if (body) section.push(body);
    parts.push(section.join("\n\n"));
  }
  return parts.join("\n\n").trim() + (parts.length ? "\n" : "");
}

export type WorkingDraftAssembly = {
  id: string;
  draftId: string;
  contentMarkdown: string;
  itemCount: number;
  createdAt: number;
};

/** Assemble the current pane and persist the result against the draft. */
export function assembleAndStore(draftId: string, documentTitle?: string): WorkingDraftAssembly {
  const items = listWorkingDraftItems(draftId);
  const content = assembleWorkingDraft(items, { documentTitle });
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO working_draft_assemblies (id, draft_id, content_markdown, item_count, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, draftId, content, items.length, now);
  return { id, draftId, contentMarkdown: content, itemCount: items.length, createdAt: now };
}

export function latestAssembly(draftId: string): WorkingDraftAssembly | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM working_draft_assemblies WHERE draft_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(draftId) as
    | { id: string; draft_id: string; content_markdown: string; item_count: number; created_at: number }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    draftId: r.draft_id,
    contentMarkdown: r.content_markdown,
    itemCount: r.item_count,
    createdAt: r.created_at,
  };
}

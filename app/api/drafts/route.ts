import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listDrafts, saveDraft, appendVersion, getDraft } from "@/lib/db";
import { emptySections, SECTION_KEYS, type SectionMap, type SectionKey } from "@/lib/sections";
import type { ExtractedNofo } from "@/lib/extract";
import { tryLogActivity } from "@/lib/activity";

export const runtime = "nodejs";

type SaveBody = {
  id?: string;
  title?: string;
  business?: string;
  naics?: string;
  opportunity?: string;
  blocks?: string[];
  structured?: ExtractedNofo | null;
  sections?: Partial<SectionMap>;
  meta?: Record<string, unknown> | null;
  nofoId?: string | null;
  poolId?: string | null;
  version?: {
    kind: "full" | "section";
    section?: SectionKey | null;
    instruction?: string | null;
    text: string;
  } | null;
};

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const drafts = listDrafts(session.email);
  return Response.json({
    drafts: drafts.map((d) => ({
      id: d.id,
      title: d.title,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      blocks: d.blocks,
      structured: d.structured,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body: SaveBody = await req.json().catch(() => ({}));
  const sections = { ...emptySections(), ...(body.sections ?? {}) };
  const isNew = !body.id || !getDraft(body.id, session.email);

  const draft = saveDraft({
    id: body.id,
    userEmail: session.email,
    title: body.title?.trim() || deriveTitle(body.opportunity ?? "", body.structured ?? null),
    business: String(body.business ?? ""),
    naics: String(body.naics ?? ""),
    opportunity: String(body.opportunity ?? ""),
    blocks: Array.isArray(body.blocks) ? body.blocks.map(String) : [],
    structured: body.structured ?? null,
    sections,
    meta: body.meta ?? null,
    nofoId: body.nofoId ?? null,
    poolId: body.poolId ?? null,
  });

  if (body.version && body.version.text) {
    const v = body.version;
    const sectionKey = v.section && SECTION_KEYS.includes(v.section) ? v.section : null;
    appendVersion({
      draftId: draft.id,
      kind: v.kind === "section" ? "section" : "full",
      section: sectionKey,
      instruction: v.instruction ?? null,
      text: v.text,
    });
  }

  tryLogActivity({
    actor: session.email,
    actionType: isNew ? "draft_created" : "draft_saved",
    targetType: "draft",
    targetId: draft.id,
    summary: isNew
      ? `Draft created: ${draft.title}`
      : `Draft saved: ${draft.title}`,
  });

  return Response.json({ draft });
}

function deriveTitle(opp: string, structured: ExtractedNofo | null): string {
  const fromStructured = [structured?.agency, structured?.program].filter(Boolean).join(" — ");
  if (fromStructured) return fromStructured.slice(0, 120);
  const firstLine = opp.split(/\r?\n/).find((l) => l.trim().length > 5)?.trim() ?? "";
  if (firstLine) return firstLine.replace(/^#+\s*/, "").slice(0, 120);
  return `Draft ${new Date().toLocaleString()}`;
}

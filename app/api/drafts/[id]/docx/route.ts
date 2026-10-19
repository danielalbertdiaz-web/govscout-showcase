import { NextRequest } from "next/server";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { getSession } from "@/lib/auth";
import { getDraft } from "@/lib/db";
import { SECTIONS, sectionTitle, type SectionKey } from "@/lib/sections";
import { sanitizePartnerCopy } from "@/lib/partner-copy";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });

  // Item 1.6: this .docx is a partner-facing export. Every model-generated
  // string routed into it is sanitized so leaked internal copy (dead-relationship
  // names, disparaging/strategy framing) can never ship in a downloadable doc.
  const children: Paragraph[] = [];
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun(sanitizePartnerCopy(draft.title).clean)],
    }),
  );
  if (draft.structured?.agency || draft.structured?.program) {
    const sub = [draft.structured?.agency, draft.structured?.program].filter(Boolean).join(" — ");
    children.push(
      new Paragraph({ children: [new TextRun({ text: sanitizePartnerCopy(sub).clean, italics: true })] }),
    );
  }
  children.push(new Paragraph({ text: "" }));

  const order: SectionKey[] = SECTIONS.map((s) => s.key);
  for (const key of order) {
    const body = sanitizePartnerCopy(draft.sections[key]).clean.trim();
    if (!body) continue;
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(sectionTitle(key))] }));
    for (const para of body.split(/\n\s*\n/)) {
      const text = para.replace(/\s+\n/g, "\n").trim();
      if (!text) continue;
      children.push(new Paragraph({ children: [new TextRun(text)] }));
    }
    children.push(new Paragraph({ text: "" }));
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const safeTitle = draft.title.replace(/[^a-z0-9-_ ]/gi, "_").slice(0, 80) || "draft";
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename="${safeTitle}.docx"`,
      "cache-control": "no-store",
    },
  });
}

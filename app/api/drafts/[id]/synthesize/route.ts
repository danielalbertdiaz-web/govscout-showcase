import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDraft, getDraftRoster } from "@/lib/db";
import { includedPartnerIds } from "@/lib/draft-partners";
import { loadBlocks } from "@/lib/blocks";
import { renderPartnersBlock, selectPartnersForOpportunity } from "@/lib/partners";
import { sanitizePartnerCopy } from "@/lib/partner-copy";
import { addWorkingDraftItem } from "@/lib/working-draft";
import {
  buildSynthesisSectionPrompt,
  enumerateSynthesisSections,
  SYNTHESIS_SYSTEM_PROMPT,
} from "@/lib/synthesizer";
import { CLI_MODEL_SECTION, resolveCliModel, runClaude } from "@/lib/claude-cli";

export const runtime = "nodejs";
// Each section is a full model completion; a NOFO can list several. The UI
// drives this per-section to show progress, but allow headroom for a small batch.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

// GET: report what WOULD be synthesized for this draft's loaded NOFO, so the UI
// can render the section list + readiness without spending a model call.
export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    hasNofo: Boolean(draft.structured),
    sections: enumerateSynthesisSections(draft.structured),
    hasEvaluationCriteria: Boolean(draft.structured?.evaluation_criteria?.trim()),
  });
}

// POST: synthesize one or more required sections and store each as a Working
// Draft block (Item 2.2). Output is sanitized through the 1.6 guardrail before
// it is ever persisted. Body: { sections?: string[] (slugs), partners?: string[],
// model?: string }. Defaults to all enumerated sections / auto partner match.
export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });

  if (!draft.structured) {
    return Response.json(
      { error: "no_nofo", message: "Link or extract a NOFO for this draft before synthesizing." },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    sections?: unknown;
    partners?: unknown;
    model?: unknown;
  };
  const requestedSlugs = Array.isArray(body.sections)
    ? body.sections.filter((s): s is string => typeof s === "string")
    : null;
  const model = resolveCliModel(typeof body.model === "string" ? body.model : undefined, CLI_MODEL_SECTION);

  const allSections = enumerateSynthesisSections(draft.structured);
  const targets = requestedSlugs?.length
    ? allSections.filter((s) => requestedSlugs.includes(s.slug))
    : allSections;
  if (!targets.length) {
    return Response.json({ error: "no_sections", message: "No matching sections to synthesize." }, { status: 400 });
  }

  const opportunityText = draft.opportunity?.trim() || draft.title;
  const blocks = await loadBlocks(draft.blocks ?? []);

  // Partner selection (Item 4.1): precedence is
  //   1) explicit ids from the client,
  //   2) the draft's curated roster (included entries only),
  //   3) auto-match against the opportunity text.
  // "__none__" suppresses partners entirely.
  const clientIds = Array.isArray(body.partners)
    ? body.partners.filter((p): p is string => typeof p === "string")
    : undefined;
  const rosterIds = clientIds ? undefined : includedPartnerIds(getDraftRoster(id, session.email));
  const partnerIdsRaw = clientIds ?? (rosterIds && rosterIds.length ? rosterIds : undefined);
  const suppressPartners = partnerIdsRaw?.length === 1 && partnerIdsRaw[0] === "__none__";
  let partnersBlock = "";
  if (!suppressPartners) {
    const sel = await selectPartnersForOpportunity({ explicitIds: partnerIdsRaw, opportunityText });
    partnersBlock = renderPartnersBlock(sel.partners);
  }

  const results: { slug: string; title: string; itemId?: string; redactions?: number; error?: string }[] = [];

  for (const section of targets) {
    try {
      const prompt = buildSynthesisSectionPrompt({
        sectionTitle: section.title,
        nofo: draft.structured,
        business: draft.business,
        naics: draft.naics,
        opportunityText,
        blocks,
        partnersBlock,
      });
      const { text } = await runClaude({
        model,
        systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
        userPrompt: prompt,
        // Item 3.2: attribute synthesizer spend to this draft + the synthesize stage.
        attribution: {
          userEmail: session.email,
          draftId: id,
          stage: "synthesize",
          source: "synthesize",
        },
      });
      // 1.6 guardrail: nothing internal leaks into a stored, partner-facing block.
      const sanitized = sanitizePartnerCopy(text);
      const item = addWorkingDraftItem({
        draftId: id,
        title: section.title,
        bodyMarkdown: sanitized.clean,
        sourceKind: "synthesis",
        sourceRef: section.slug,
      });
      results.push({ slug: section.slug, title: section.title, itemId: item.id, redactions: sanitized.redactions.length });
    } catch (err) {
      results.push({
        slug: section.slug,
        title: section.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const created = results.filter((r) => r.itemId).length;
  return Response.json({ ok: true, created, results });
}

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadBlocks } from "@/lib/blocks";
import { renderPartnersBlock, selectPartnersForOpportunity } from "@/lib/partners";
import {
  renderWarmContactsBlock,
  renderWarmOutreachDrafts,
  selectConnectionsForOpportunity,
  type WarmOutreachDraft,
} from "@/lib/connections";
import { SECTION_SYSTEM_PROMPT, buildSectionPrompt } from "@/lib/prompts";
import { SECTION_KEYS, emptySections, sectionTitle, type SectionMap } from "@/lib/sections";
import { CLI_MODEL_SECTION, resolveCliModel, streamClaude } from "@/lib/claude-cli";
import { getSavedOpportunity, saveDraft, appendVersion } from "@/lib/db";
import { tryLogActivity } from "@/lib/activity";
import { stripSectionHeader } from "@/lib/section-format";

export const runtime = "nodejs";
// Looping all 5 sections * ~30s each = ~2.5 min worst case. Generous ceiling.
export const maxDuration = 600;

type AutoBody = {
  // Pull saved opportunity facts when provided. Either id OR opportunity text
  // is required.
  opportunity_id?: string;
  opportunity?: string;
  business?: string;
  naics?: string;
  blocks?: string[];
  // Subset of partner ids to inject. Omit/empty -> all known partners.
  // Pass an empty sentinel like ["__none__"] to suppress partners entirely.
  partners?: string[];
  // Warm LinkedIn connections to surface. Same sentinel rules as partners.
  connections?: string[];
  // Reuse existing draft (when continuing after a partial failure). If unset,
  // a new draft is created.
  draft_id?: string;
  title?: string;
  model?: string;
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const body: AutoBody = await req.json().catch(() => ({}));
  const model = resolveCliModel(body.model, CLI_MODEL_SECTION);

  // Resolve opportunity facts: saved-opp id wins; explicit body fields second.
  let opportunity = String(body.opportunity ?? "").trim();
  const business = String(body.business ?? "").trim();
  let naics = String(body.naics ?? "").trim();
  let titleHint = body.title ?? "";
  let opportunityId: string | null = null;
  if (body.opportunity_id) {
    const saved = getSavedOpportunity(String(body.opportunity_id), session.email);
    if (!saved) {
      return new Response(JSON.stringify({ error: "opportunity_not_found" }), {
        status: 404,
      });
    }
    opportunityId = saved.id;
    if (!opportunity) {
      const parts = [
        saved.title,
        saved.agency ? `Agency: ${saved.agency}` : null,
        saved.deadline ? `Deadline: ${saved.deadline}` : null,
        saved.fundingFloor || saved.fundingCeiling
          ? `Funding: ${saved.fundingFloor ?? "?"} – ${saved.fundingCeiling ?? "?"}`
          : null,
        saved.eligibility ? `Eligibility: ${saved.eligibility}` : null,
        saved.url ? `URL: ${saved.url}` : null,
        "",
        saved.summary ?? "(no summary)",
      ].filter(Boolean);
      opportunity = parts.join("\n");
    }
    if (!naics && saved.naics) naics = saved.naics;
    if (!titleHint) titleHint = `Auto draft — ${saved.title}`;
  }

  if (!opportunity.trim()) {
    return new Response(JSON.stringify({ error: "opportunity_required" }), {
      status: 400,
    });
  }

  const blockIds = Array.isArray(body.blocks) ? body.blocks.map(String) : [];
  const blocks = await loadBlocks(blockIds);

  // Partners selection: ["__none__"] suppresses; explicit ids win; otherwise
  // run keyword/type auto-match against opportunity text; otherwise fall back
  // to all active partners. The selection reasoning leaks out via the SSE
  // `meta` event so the UI can show which partners landed and why.
  const partnerIdsRaw = Array.isArray(body.partners) ? body.partners.map(String) : undefined;
  const suppressPartners = partnerIdsRaw?.length === 1 && partnerIdsRaw[0] === "__none__";
  let partnersBlock = "";
  let partnerSelection: { reason: string; ids: string[]; matchedKeywords?: string[]; matchedTypes?: string[] } = {
    reason: "suppressed",
    ids: [],
  };
  if (!suppressPartners) {
    const { partners, selection } = await selectPartnersForOpportunity({
      explicitIds: partnerIdsRaw,
      opportunityText: opportunity,
    });
    partnersBlock = renderPartnersBlock(partners);
    partnerSelection = selection;
  }

  // Warm LinkedIn connections: same shape as partner selection but the
  // semantics are "warm-intro prospects to recruit" — not consortium
  // members. Surfaced via meta for the workbench UI; a private network
  // signal goes into the prompt so the model can allude to relationships
  // without naming individuals. Outreach drafts are generated alongside.
  const connectionIdsRaw = Array.isArray(body.connections) ? body.connections.map(String) : undefined;
  const suppressConnections = connectionIdsRaw?.length === 1 && connectionIdsRaw[0] === "__none__";
  let warmContactsBlock = "";
  let warmOutreachDrafts: WarmOutreachDraft[] = [];
  let connectionSelection: { reason: string; ids: string[]; matchedKeywords?: string[]; matchedTypes?: string[] } = {
    reason: "suppressed",
    ids: [],
  };
  if (!suppressConnections) {
    const { connections, selection } = await selectConnectionsForOpportunity({
      explicitIds: connectionIdsRaw,
      opportunityText: opportunity,
    });
    warmContactsBlock = renderWarmContactsBlock(connections);
    connectionSelection = selection;
    if (connections.length) {
      warmOutreachDrafts = await renderWarmOutreachDrafts({
        connections,
        opportunitySummary: opportunity,
        matchedKeywords: selection.matchedKeywords ?? [],
      });
    }
  }

  const sections: SectionMap = emptySections();
  const persistedDraftId: { id: string | null } = { id: body.draft_id ?? null };

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      req.signal.addEventListener("abort", onAbort, { once: true });

      const persist = (partial: boolean, failedSection?: string, error?: string) => {
        // Save what we have so far. Returns the persisted draft id so callers
        // can keep building on the same row if they retry.
        const title = titleHint || `Auto draft — ${new Date().toISOString().slice(0, 10)}`;
        const meta: Record<string, unknown> = {
          autoDraft: true,
          partial,
          model,
          partnerSelection,
          connectionSelection,
          warmOutreachDrafts,
          generatedAt: Date.now(),
        };
        if (failedSection) meta.failedSection = failedSection;
        if (error) meta.error = error;
        const saved = saveDraft({
          id: persistedDraftId.id ?? undefined,
          userEmail: session.email,
          title,
          business,
          naics,
          opportunity,
          blocks: blockIds,
          structured: null,
          sections,
          meta,
          nofoId: null,
          poolId: null,
        });
        persistedDraftId.id = saved.id;
        // Append a version row so the draft history reflects this orchestrator
        // pass — mirrors how /api/draft/section logs versions.
        try {
          appendVersion({
            draftId: saved.id,
            kind: "full",
            section: null,
            instruction: partial ? `auto-draft partial (failed ${failedSection})` : "auto-draft full",
            text: SECTION_KEYS.map((k) => `## ${sectionTitle(k)}\n\n${sections[k] ?? ""}`).join(
              "\n\n---\n\n",
            ),
            meta,
          });
        } catch {
          // version log failures shouldn't kill the draft itself
        }
        return saved.id;
      };

      try {
        send("meta", {
          model,
          sectionKeys: SECTION_KEYS,
          opportunityId,
          partnerSelection,
          connectionSelection,
          warmOutreachDrafts,
          startedAt: Date.now(),
        });

        for (const section of SECTION_KEYS) {
          if (abort.signal.aborted) {
            const id = persist(true, section, "aborted");
            send("aborted", { draft_id: id, failed_section: section });
            return;
          }
          const userPrompt = buildSectionPrompt({
            business,
            naics,
            opportunity,
            blocks,
            section,
            otherSections: sections,
            partnersBlock,
            warmContactsBlock,
          });
          send("section:start", {
            section,
            title: sectionTitle(section),
            startedAt: Date.now(),
          });
          let acc = "";
          let sectionErr: string | null = null;
          try {
            for await (const ev of streamClaude({
              model,
              systemPrompt: SECTION_SYSTEM_PROMPT,
              userPrompt,
              signal: abort.signal,
            })) {
              if (ev.type === "delta") {
                acc += ev.text;
                send("section:delta", { section, text: ev.text });
              } else if (ev.type === "done") {
                if (typeof ev.result === "string" && ev.result.length > acc.length) {
                  acc = ev.result;
                }
              } else if (ev.type === "error") {
                sectionErr = ev.message;
              }
            }
          } catch (err) {
            sectionErr = err instanceof Error ? err.message : String(err);
          }
          if (sectionErr) {
            const id = persist(true, section, sectionErr);
            send("error", {
              section,
              message: sectionErr,
              draft_id: id,
              partial: true,
              failed_section: section,
            });
            send("done", { draft_id: id, partial: true, failed_section: section });
            return;
          }
          const cleaned = stripSectionHeader(acc);
          sections[section] = cleaned;
          send("section:done", { section, length: cleaned.length });
        }

        const id = persist(false);
        tryLogActivity({
          actor: session.email,
          actionType: "draft_created",
          targetType: "draft",
          targetId: id,
          summary: `Auto-draft completed${titleHint ? `: ${titleHint}` : ""}`,
          detail: { model, sections: SECTION_KEYS },
        });
        send("done", { draft_id: id, partial: false, finishedAt: Date.now() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const id = persist(true, undefined, msg);
        send("error", { message: msg, draft_id: id, partial: true });
        send("done", { draft_id: id, partial: true });
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

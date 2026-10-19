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
import { SECTION_KEYS, type SectionKey, type SectionMap } from "@/lib/sections";
import { CLI_MODEL_SECTION, resolveCliModel, streamClaude } from "@/lib/claude-cli";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  business?: string;
  naics?: string;
  opportunity?: string;
  blocks?: string[];
  section?: string;
  instruction?: string;
  otherSections?: Partial<SectionMap>;
  model?: string;
  partners?: string[];
  connections?: string[];
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  const body: Body = await req.json().catch(() => ({}));
  const business = String(body.business ?? "");
  const naics = String(body.naics ?? "");
  const opportunity = String(body.opportunity ?? "");
  const blockIds = Array.isArray(body.blocks) ? body.blocks.map(String) : [];
  const section = String(body.section ?? "") as SectionKey;
  const instruction = body.instruction ? String(body.instruction) : undefined;
  const otherSections = body.otherSections && typeof body.otherSections === "object" ? body.otherSections : undefined;
  const model = resolveCliModel(body.model, CLI_MODEL_SECTION);

  if (!opportunity.trim()) {
    return new Response(JSON.stringify({ error: "opportunity_required" }), { status: 400 });
  }
  if (!SECTION_KEYS.includes(section)) {
    return new Response(JSON.stringify({ error: "invalid_section" }), { status: 400 });
  }

  const blocks = await loadBlocks(blockIds);
  const partnerIdsRaw = Array.isArray(body.partners) ? body.partners.map(String) : undefined;
  const suppressPartners = partnerIdsRaw?.length === 1 && partnerIdsRaw[0] === "__none__";
  let partnersBlock = "";
  let partnerSelection: { reason: string; ids: string[]; matchedKeywords?: string[]; matchedTypes?: string[] } = {
    reason: "suppressed",
    ids: [],
  };
  if (!suppressPartners) {
    const result = await selectPartnersForOpportunity({
      explicitIds: partnerIdsRaw,
      opportunityText: opportunity,
    });
    partnersBlock = renderPartnersBlock(result.partners);
    partnerSelection = result.selection;
  }

  const connectionIdsRaw = Array.isArray(body.connections) ? body.connections.map(String) : undefined;
  const suppressConnections = connectionIdsRaw?.length === 1 && connectionIdsRaw[0] === "__none__";
  let warmContactsBlock = "";
  let warmOutreachDrafts: WarmOutreachDraft[] = [];
  let connectionSelection: { reason: string; ids: string[]; matchedKeywords?: string[]; matchedTypes?: string[] } = {
    reason: "suppressed",
    ids: [],
  };
  if (!suppressConnections) {
    const result = await selectConnectionsForOpportunity({
      explicitIds: connectionIdsRaw,
      opportunityText: opportunity,
    });
    warmContactsBlock = renderWarmContactsBlock(result.connections);
    connectionSelection = result.selection;
    if (result.connections.length) {
      warmOutreachDrafts = await renderWarmOutreachDrafts({
        connections: result.connections,
        opportunitySummary: opportunity,
        matchedKeywords: result.selection.matchedKeywords ?? [],
      });
    }
  }

  const userPrompt = buildSectionPrompt({
    business,
    naics,
    opportunity,
    blocks,
    section,
    instruction,
    otherSections,
    partnersBlock,
    warmContactsBlock,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      req.signal.addEventListener("abort", onAbort, { once: true });
      try {
        send("meta", {
          model,
          blocksLoaded: blocks.map((b) => b.id),
          section,
          partnerSelection,
          connectionSelection,
          warmOutreachDrafts,
          startedAt: Date.now(),
        });
        let stopReason: string | null | undefined;
        let usage: unknown;
        for await (const ev of streamClaude({
          model,
          systemPrompt: SECTION_SYSTEM_PROMPT,
          userPrompt,
          signal: abort.signal,
        })) {
          if (ev.type === "delta") send("delta", { text: ev.text });
          else if (ev.type === "done") {
            stopReason = ev.stop_reason;
            usage = ev.usage;
          } else if (ev.type === "error") {
            send("error", { message: ev.message });
          }
        }
        send("done", { finishedAt: Date.now(), stop_reason: stopReason, usage });
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
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

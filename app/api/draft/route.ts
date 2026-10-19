import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadBlocks } from "@/lib/blocks";
import { SYSTEM_PROMPT, buildUserPrompt } from "@/lib/prompts";
import { CLI_MODEL_DRAFT, resolveCliModel, streamClaude } from "@/lib/claude-cli";

export const runtime = "nodejs";
export const maxDuration = 60;

type DraftBody = {
  business?: string;
  naics?: string;
  opportunity?: string;
  blocks?: string[];
  model?: string;
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const body: DraftBody = await req.json().catch(() => ({}));
  const business = String(body.business ?? "");
  const naics = String(body.naics ?? "");
  const opportunity = String(body.opportunity ?? "");
  const blockIds = Array.isArray(body.blocks) ? body.blocks.map(String) : [];
  const model = resolveCliModel(body.model, CLI_MODEL_DRAFT);

  if (!opportunity.trim()) {
    return new Response(JSON.stringify({ error: "opportunity_required" }), { status: 400 });
  }

  const blocks = await loadBlocks(blockIds);
  const userPrompt = buildUserPrompt({ business, naics, opportunity, blocks });

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
          user: session.email,
          startedAt: Date.now(),
        });
        let stopReason: string | null | undefined;
        let usage: unknown;
        for await (const ev of streamClaude({
          model,
          systemPrompt: SYSTEM_PROMPT,
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

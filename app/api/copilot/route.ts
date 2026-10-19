import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { CLI_MODEL_SECTION, resolveCliModel, streamClaude } from "@/lib/claude-cli";
import {
  COPILOT_SYSTEM_PROMPT,
  enforceMemoryGuards,
  parseContextRef,
  renderOpenSuggestionsBlock,
  renderWorkspacePrimer,
  resolveContext,
} from "@/lib/copilot-context";
import { executeTool, parseToolCalls, renderToolDocs } from "@/lib/alfred-tools";
import { emitMutation } from "@/lib/events";
import {
  appendCopilotMessage,
  createCopilotChat,
  getCopilotChat,
  updateCopilotChatTitle,
} from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 600;

type CopilotMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type CopilotBody = {
  messages: CopilotMessage[];
  model?: string;
  context?: string; // e.g. "scout:abc" / "pool:42"
  // Persistence (optional). Omit on first turn to have the server lazily
  // create a chat; reuse the id thereafter so the conversation survives
  // page refresh. Setting persist=false (or sending no chat_id repeatedly)
  // keeps the chat ephemeral.
  chat_id?: string;
  persist?: boolean;
};

// Build a single user prompt from the chat history. We don't ship multi-turn
// messages to the Claude CLI here — it's a one-shot per request. The history
// is folded into a single prompt with explicit role markers so the model can
// reason about the running conversation.
function buildPrompt(messages: CopilotMessage[]): string {
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}:\n${m.content.trim()}`);
  return `${turns.join("\n\n---\n\n")}\n\n---\n\nASSISTANT:`;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const body: CopilotBody = await req.json().catch(() => ({ messages: [] }));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages_required" }), { status: 400 });
  }
  const model = resolveCliModel(body.model, CLI_MODEL_SECTION);

  let systemPrompt = COPILOT_SYSTEM_PROMPT;
  let resolvedContextTitle: string | null = null;
  const workspacePrimer = await renderWorkspacePrimer(session.email);
  const suggestionsBlock = renderOpenSuggestionsBlock(session.email);
  const ref = parseContextRef(body.context);
  const parts: string[] = [COPILOT_SYSTEM_PROMPT, renderToolDocs()];
  if (workspacePrimer) parts.push(workspacePrimer);
  if (ref) {
    const ctx = resolveContext(ref, session.email);
    if (ctx) {
      resolvedContextTitle = ctx.title;
      parts.push(`---\nCURRENT CONTEXT (${ctx.kind}): ${ctx.title}\n\n${ctx.primer}\n---`);
    }
  }
  if (suggestionsBlock) parts.push(suggestionsBlock);
  systemPrompt = parts.join("\n\n");

  // Resolve/create chat record. persist defaults to true; explicit false keeps
  // the conversation ephemeral. If chat_id is supplied but doesn't belong to
  // the user, treat it as a new chat (silent fallback — single-user app so
  // mostly catches stale localStorage ids).
  const persist = body.persist !== false;
  let chatId: string | null = null;
  if (persist) {
    if (body.chat_id) {
      const existing = getCopilotChat(body.chat_id, session.email);
      if (existing) chatId = existing.id;
    }
    if (!chatId) {
      const latestUser = [...messages].reverse().find((m) => m.role === "user");
      const titleSeed = latestUser?.content.trim().slice(0, 80) ?? null;
      const chat = createCopilotChat({
        userEmail: session.email,
        contextKind: ref?.kind ?? null,
        contextId: ref?.id ?? null,
        title: titleSeed,
      });
      chatId = chat.id;
    }
    // Persist any user turns that haven't been logged yet. For simplicity we
    // assume the client only sends the new user turn since last server response;
    // we only persist the most recent user message to avoid duplicates.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "user") {
      appendCopilotMessage({
        chatId,
        role: "user",
        content: lastMsg.content,
      });
    }
  }

  const userPrompt = buildPrompt(messages);

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
      try {
        send("meta", {
          model,
          context: resolvedContextTitle,
          chat_id: chatId,
          startedAt: Date.now(),
        });
        let stopReason: string | null | undefined;
        let assistantText = "";
        for await (const ev of streamClaude({
          model,
          systemPrompt,
          userPrompt,
          signal: abort.signal,
        })) {
          if (ev.type === "delta") {
            assistantText += ev.text;
            send("delta", { text: ev.text });
          } else if (ev.type === "done") {
            stopReason = ev.stop_reason;
            if (typeof ev.result === "string" && ev.result.length > assistantText.length) {
              assistantText = ev.result;
            }
          } else if (ev.type === "error") {
            send("error", { message: ev.message });
          }
        }
        const guard = enforceMemoryGuards(assistantText);
        if (guard.flagged.length > 0) {
          send("memory_guard", { flagged: guard.flagged });
          assistantText = guard.text;
        }
        // Parse + execute any embedded tool calls Alfred emitted.
        const { calls, stripped } = parseToolCalls(assistantText);
        const toolResults: Array<{ name: string; args: Record<string, unknown>; result: unknown; error: string | null }> = [];
        for (const c of calls) {
          const r = await executeTool(c.name, c.args, { userEmail: session.email });
          toolResults.push({
            name: c.name,
            args: c.args,
            result: r.result,
            error: r.error,
          });
          send("tool_call", {
            name: c.name,
            args: c.args,
            result: r.result,
            error: r.error,
          });
          emitMutation({
            type: "tool_call",
            toolName: c.name,
            args: c.args,
            result: r.result,
            error: r.error,
            userEmail: session.email,
            at: Date.now(),
          });
        }
        // Persist the stripped text (markers removed) so chat history reads cleanly.
        if (persist && chatId && stripped.trim()) {
          appendCopilotMessage({
            chatId,
            role: "assistant",
            content: stripped,
            model,
          });
          // Backfill a chat title from the first user turn if we never set one.
          if (messages.length === 1) {
            const seed = messages[0]?.content?.trim().slice(0, 80);
            if (seed) updateCopilotChatTitle(chatId, session.email, seed);
          }
        }
        send("done", {
          finishedAt: Date.now(),
          stop_reason: stopReason,
          chat_id: chatId,
          flagged: guard.flagged,
          tool_calls: toolResults.length,
        });
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

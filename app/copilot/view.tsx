"use client";

import { useEffect, useRef, useState } from "react";
import { AppHeader } from "@/app/_components/AppHeader";

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  error: string | null;
};
type Msg = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
};

type RecentChat = {
  id: string;
  title: string;
  contextKind: string | null;
  contextId: string | null;
  updatedAtMs: number;
};

type Props = {
  user: { email: string; name: string };
  contextRaw: string | null;
  contextSummary: { kind: string; id: string; title: string } | null;
  initialChatId: string | null;
  initialMessages: Msg[];
  recentChats: RecentChat[];
};

const MODELS = [
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 (default)" },
  { value: "claude-opus-4-7", label: "Opus 4.7 (heavy)" },
];

export default function CopilotView({
  user,
  contextRaw,
  contextSummary,
  initialChatId,
  initialMessages,
  recentChats,
}: Props) {
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(MODELS[0].value);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Reflect chatId into the URL so refresh keeps the conversation. Use
  // replaceState rather than router.replace to avoid a server roundtrip on
  // every assistant turn.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (chatId) {
      if (url.searchParams.get("chat") !== chatId) {
        url.searchParams.set("chat", chatId);
        window.history.replaceState({}, "", url.toString());
      }
    } else if (url.searchParams.has("chat")) {
      url.searchParams.delete("chat");
      window.history.replaceState({}, "", url.toString());
    }
  }, [chatId]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    // Append a streaming-assistant placeholder we'll mutate as deltas land.
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: next,
          model,
          context: contextRaw ?? undefined,
          chat_id: chatId ?? undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        setError(`Failed (${res.status}): ${t || res.statusText}`);
        setStreaming(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const raw of events) {
          const lines = raw.split("\n");
          const e = lines.find((l) => l.startsWith("event: "))?.slice(7);
          const d = lines.find((l) => l.startsWith("data: "))?.slice(6);
          if (!e || !d) continue;
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(d);
          } catch {
            continue;
          }
          if (e === "meta") {
            const newId = typeof data.chat_id === "string" ? data.chat_id : null;
            if (newId && newId !== chatId) setChatId(newId);
          } else if (e === "delta") {
            const t = String(data.text ?? "");
            setMessages((prev) => {
              const copy = prev.slice();
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") {
                copy[copy.length - 1] = { ...last, content: last.content + t };
              }
              return copy;
            });
          } else if (e === "tool_call") {
            const tc = data as unknown as ToolCall;
            setMessages((prev) => {
              const copy = prev.slice();
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") {
                copy[copy.length - 1] = {
                  ...last,
                  toolCalls: [...(last.toolCalls ?? []), tc],
                };
              }
              return copy;
            });
          } else if (e === "memory_guard") {
            const flagged = Array.isArray((data as Record<string, unknown>).flagged)
              ? ((data as Record<string, unknown>).flagged as string[])
              : [];
            if (flagged.length > 0) {
              setError(
                `Memory guard redacted: ${flagged.join(", ")} — banned name detected in Alfred's reply.`,
              );
            }
          } else if (e === "error") {
            setError(String(data.message ?? "Stream error"));
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
    }
  }

  function reset() {
    setMessages([]);
    setError(null);
    setChatId(null);
  }

  async function deleteChat(id: string) {
    if (!confirm("Delete this chat?")) return;
    try {
      await fetch(`/api/copilot/chats/${id}`, { method: "DELETE" });
      // Hard reload so the server re-renders the recent-chats list.
      window.location.assign(
        id === chatId
          ? "/copilot"
          : window.location.pathname + window.location.search,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-6 py-6">
      <AppHeader
        tagline="Alfred · in-mainframe operator"
        title="🎩 Alfred"
        subtitle={
          contextSummary
            ? `Context: ${contextSummary.kind} — ${contextSummary.title}`
            : "Workspace-wide chat. Activity, decisions, scouts, partners auto-loaded."
        }
        userLabel={user.name}
        activeNav="copilot"
        trailingActions={
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            New chat
          </button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <aside className="space-y-2 lg:sticky lg:top-4">
          <div className="rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-stone-500">
              <span>Recent chats</span>
              <span className="text-stone-400">{recentChats.length}</span>
            </div>
            {recentChats.length === 0 ? (
              <p className="text-xs italic text-stone-400">No chats yet.</p>
            ) : (
              <ul className="space-y-1">
                {recentChats.map((c) => {
                  const active = c.id === chatId;
                  return (
                    <li key={c.id}>
                      <div
                        className={`group flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs ${
                          active
                            ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                            : "border-transparent text-stone-700 hover:bg-stone-50"
                        }`}
                      >
                        <a
                          href={`/copilot?chat=${encodeURIComponent(c.id)}${
                            contextRaw ? `&context=${encodeURIComponent(contextRaw)}` : ""
                          }`}
                          className="grow truncate"
                          title={c.title}
                        >
                          {c.title}
                        </a>
                        <button
                          type="button"
                          onClick={() => deleteChat(c.id)}
                          className="invisible text-stone-400 hover:text-red-600 group-hover:visible"
                          aria-label="Delete chat"
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs shadow-sm">
            <label className="font-medium text-stone-700">Model:</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-800 shadow-sm"
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            {contextSummary && (
              <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-900">
                Bound to {contextSummary.kind}:{contextSummary.id}
              </span>
            )}
            {chatId && (
              <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[11px] font-mono text-stone-600">
                chat:{chatId.slice(0, 8)}
              </span>
            )}
          </div>

          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
            style={{ minHeight: 360, maxHeight: "60vh" }}
          >
            {messages.length === 0 ? (
              <p className="text-sm italic text-stone-500">
                Start a conversation.{" "}
                {contextSummary
                  ? `Alfred has been primed with the ${contextSummary.kind} record above.`
                  : "Alfred has the workspace state in-context. Ask anything."}
              </p>
            ) : (
              messages.map((m, i) => (
                <Bubble key={i} role={m.role} content={m.content} toolCalls={m.toolCalls} />
              ))
            )}
            {streaming && (
              <p className="text-[11px] italic text-stone-400">Alfred is typing…</p>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </div>
          )}

          <form
            className="flex items-end gap-2 rounded-xl border border-stone-200 bg-white p-3 shadow-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={3}
              placeholder="Ask Alfred anything. Cmd/Ctrl+Enter to send."
              className="min-h-[72px] grow resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
            <button
              type="submit"
              disabled={streaming || !input.trim()}
              className="self-stretch rounded-md border border-emerald-700 bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {streaming ? "…" : "Send"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  role,
  content,
  toolCalls,
}: {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
}) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[85%] space-y-1">
        <div
          className={`whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm leading-6 ${
            isUser
              ? "bg-emerald-700 text-white"
              : "border border-stone-200 bg-stone-50 text-stone-900"
          }`}
        >
          {content || (isUser ? "" : "…")}
        </div>
        {toolCalls && toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {toolCalls.map((tc, i) => (
              <span
                key={i}
                title={JSON.stringify(tc.args)}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  tc.error
                    ? "border-rose-400 bg-rose-50 text-rose-900"
                    : "border-violet-400 bg-violet-50 text-violet-900"
                }`}
              >
                🎩 {tc.name}
                {tc.error ? ` — ${tc.error.slice(0, 40)}` : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

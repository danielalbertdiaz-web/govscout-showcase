"use client";

// "Chat with Alfred" — the GovScout end of the bridge into Alfred's main
// OpenClaw session (same conversation as Telegram; see
// the cron-chat integration spec). Two entry modes: the floating panel
// itself, and a per-row "Chat about this job" button that opens the panel
// with the job identified in the opening message. The prefill is a
// convenience only — Alfred looks up the job's config/run history with his
// own tools once the message arrives; there is no separate context-injection
// system.
//
// Cross-component wiring is a window CustomEvent rather than a context
// provider because the rows are rendered by a server component — a shared
// client context would force the whole cron table client-side for one
// button.

import { useCallback, useEffect, useRef, useState } from "react";

const PREFILL_EVENT = "alfred-chat-prefill";

type WireMessage = {
  id: string;
  jobId: string | null;
  message: string;
  reply: string | null;
  status: string; // pending | done | error | aborted
  error: string | null;
  createdAt: number;
  completedAt: number | null;
};

export function ChatAboutJobButton({ jobName, jobId }: { jobName: string; jobId: string }) {
  return (
    <button
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent(PREFILL_EVENT, {
            detail: { text: `About the "${jobName}" job (id ${jobId}): `, jobId },
          }),
        )
      }
      className="rounded border border-stone-300 bg-white px-2 py-0.5 text-[11px] font-medium text-stone-600 transition hover:bg-stone-100"
      title="Open the Alfred chat panel with this job pre-filled"
    >
      Chat about this job
    </button>
  );
}

export function AlfredChatPanel() {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/alfred-chat?limit=50");
      if (!res.ok) return;
      const data = (await res.json()) as { configured: boolean; messages: WireMessage[] };
      setConfigured(data.configured);
      setMessages(data.messages);
    } catch {
      /* transient poll failure — next tick retries */
    }
  }, []);

  // Poll while open; faster while a turn is pending (turns run 30–240s, but
  // a finished reply should not sit unseen for long).
  useEffect(() => {
    if (!open) return;
    void refresh();
    const anyPending = messages.some((m) => m.status === "pending");
    const t = setInterval(() => void refresh(), anyPending ? 2500 : 8000);
    return () => clearInterval(t);
  }, [open, refresh, messages]);

  // Per-job entry point → open with prefill.
  useEffect(() => {
    const onPrefill = (ev: Event) => {
      const detail = (ev as CustomEvent<{ text: string; jobId: string }>).detail;
      setOpen(true);
      setDraft(detail.text);
      setJobId(detail.jobId);
      setTimeout(() => inputRef.current?.focus(), 50);
    };
    window.addEventListener(PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(PREFILL_EVENT, onPrefill);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, open]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/alfred-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, ...(jobId ? { jobId } : {}) }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setSendError(data?.error ?? `send failed (${res.status})`);
        return;
      }
      setDraft("");
      setJobId(null);
      await refresh();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-30 rounded-full bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-stone-700"
      >
        Chat with Alfred
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-30 flex h-[32rem] w-[26rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-stone-200 bg-stone-900 px-4 py-2.5 text-white">
        <div>
          <div className="text-sm font-semibold">Chat with Alfred</div>
          <div className="text-[11px] text-white/60">
            Same session as Telegram — replies can take a few minutes
          </div>
        </div>
        <button onClick={() => setOpen(false)} className="text-white/70 hover:text-white" aria-label="Close">
          ✕
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {configured === false && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Bridge not configured: set <code>OPENCLAW_GATEWAY_TOKEN</code> in{" "}
            <code>.env.local</code> (server-side) and redeploy.
          </div>
        )}
        {messages.length === 0 && configured !== false && (
          <p className="pt-6 text-center text-xs italic text-stone-400">
            Ask anything — cron jobs, opportunities, or whatever you&apos;d message on Telegram.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id}>
            <div className="ml-8 rounded-lg rounded-br-sm bg-stone-900 px-3 py-2 text-sm text-white">
              {m.message}
            </div>
            <div className="mr-8 mt-1.5">
              {m.status === "pending" ? (
                <div className="rounded-lg rounded-bl-sm bg-stone-100 px-3 py-2 text-sm italic text-stone-400">
                  Alfred is working…
                </div>
              ) : m.status === "done" ? (
                <div className="whitespace-pre-wrap rounded-lg rounded-bl-sm bg-emerald-50 px-3 py-2 text-sm text-stone-800">
                  {m.reply}
                </div>
              ) : (
                <div className="rounded-lg rounded-bl-sm bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {m.error ?? `turn ${m.status}`}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {sendError && (
        <div className="border-t border-rose-200 bg-rose-50 px-4 py-1.5 text-xs text-rose-700">{sendError}</div>
      )}

      <div className="flex items-end gap-2 border-t border-stone-200 px-3 py-2.5">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Message Alfred… (Enter to send)"
          className="max-h-28 flex-1 resize-none rounded-md border border-stone-300 px-2.5 py-1.5 text-sm focus:border-stone-500 focus:outline-none"
        />
        <button
          onClick={() => void send()}
          disabled={sending || !draft.trim() || configured === false}
          className="rounded-md bg-stone-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

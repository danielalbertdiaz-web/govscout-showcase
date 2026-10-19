"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SectionState = {
  key: string;
  title: string;
  status: "pending" | "streaming" | "done" | "failed";
  charCount: number;
};

export default function AutoDraftButton({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [sections, setSections] = useState<SectionState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    setSections([]);
    setDraftId(null);
    setPartial(false);
    try {
      const res = await fetch("/api/draft/auto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opportunity_id: opportunityId }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setError(`Failed: ${res.status} ${text || res.statusText}`);
        setRunning(false);
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
          const eventLine = lines.find((l) => l.startsWith("event: "));
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(7);
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(dataLine.slice(6));
          } catch {
            // skip malformed event
            continue;
          }
          if (event === "meta") {
            const keys = (data.sectionKeys as string[]) ?? [];
            setSections(
              keys.map((k) => ({ key: k, title: titleize(k), status: "pending", charCount: 0 })),
            );
          } else if (event === "section:start") {
            const key = data.section as string;
            setSections((prev) =>
              prev.map((s) => (s.key === key ? { ...s, status: "streaming" } : s)),
            );
          } else if (event === "section:delta") {
            const key = data.section as string;
            const text = String(data.text ?? "");
            setSections((prev) =>
              prev.map((s) =>
                s.key === key ? { ...s, charCount: s.charCount + text.length } : s,
              ),
            );
          } else if (event === "section:done") {
            const key = data.section as string;
            setSections((prev) =>
              prev.map((s) => (s.key === key ? { ...s, status: "done" } : s)),
            );
          } else if (event === "error") {
            const key = data.section as string | undefined;
            if (key) {
              setSections((prev) =>
                prev.map((s) => (s.key === key ? { ...s, status: "failed" } : s)),
              );
            }
            if (typeof data.message === "string") setError(data.message);
          } else if (event === "done") {
            if (typeof data.draft_id === "string") setDraftId(data.draft_id);
            if (data.partial) setPartial(true);
          } else if (event === "aborted") {
            setError("Aborted by client.");
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded-md border border-emerald-700 bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
        >
          {running ? "Drafting…" : "Auto-draft full proposal"}
        </button>
        {draftId && (
          <button
            type="button"
            onClick={() => router.push(`/drafts/${draftId}`)}
            className="rounded-md border border-emerald-600 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-50"
          >
            {partial ? "Open partial draft →" : "Open draft →"}
          </button>
        )}
      </div>
      {sections.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-stone-800">
          {sections.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-stone-500">
                [{statusIcon(s.status)}]
              </span>
              <span className="font-medium">{s.title}</span>
              {s.charCount > 0 && (
                <span className="text-[11px] text-stone-500">({s.charCount} chars)</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}

function titleize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusIcon(s: SectionState["status"]): string {
  switch (s) {
    case "pending":
      return " ";
    case "streaming":
      return "…";
    case "done":
      return "✓";
    case "failed":
      return "✗";
  }
}

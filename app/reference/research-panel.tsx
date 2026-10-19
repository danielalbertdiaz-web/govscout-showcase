"use client";

// N6 — live, cited funder research (Perplexity Sonar) on the Reference page.
// Renders nothing when the seam is unconfigured. Answers come back with
// citation links so every claim is checkable before it informs outreach.

import { useEffect, useState } from "react";

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

export default function ResearchPanel() {
  const [available, setAvailable] = useState(false);
  const [usage, setUsage] = useState<{ used: number; cap: number } | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/reference/research")
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d: { available?: boolean; usedThisMonth?: number; monthlyCap?: number }) => {
        if (!alive) return;
        setAvailable(Boolean(d.available));
        if (typeof d.usedThisMonth === "number" && typeof d.monthlyCap === "number") {
          setUsage({ used: d.usedThisMonth, cap: d.monthlyCap });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!available) return null;

  async function ask() {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    setCitations([]);
    try {
      const res = await fetch("/api/reference/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const d = (await res.json()) as { answer?: string; citations?: string[]; error?: string };
      if (!res.ok) throw new Error(d.error || `request failed (${res.status})`);
      setAnswer(d.answer ?? null);
      setCitations(d.citations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "research failed");
    } finally {
      setAsking(false);
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
          Research a funder — live, cited
        </h2>
        <span className="text-[10px] text-stone-400">
          Perplexity Sonar{usage ? ` · ${usage.used}/${usage.cap} this month` : ""}
        </span>
      </div>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ask();
          }}
          placeholder='e.g. "What does the Quantum Foundation fund and how do you apply?"'
          className={`min-w-0 flex-1 ${INPUT}`}
        />
        <button
          onClick={() => void ask()}
          disabled={asking || !question.trim()}
          className="shrink-0 rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
        >
          {asking ? "Researching…" : "Ask"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {answer && (
        <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
          <p className="whitespace-pre-wrap text-sm leading-6 text-stone-800">{answer}</p>
          {citations.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-stone-200 pt-2">
              {citations.map((c, i) => (
                <a
                  key={c}
                  href={c}
                  target="_blank"
                  rel="noreferrer"
                  className="max-w-60 truncate rounded-full border border-stone-300 bg-white px-2 py-0.5 text-[10px] text-stone-600 hover:border-emerald-400 hover:text-emerald-700"
                  title={c}
                >
                  [{i + 1}] {c.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

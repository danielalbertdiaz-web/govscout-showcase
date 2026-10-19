"use client";

// S1 — the search → partner → outreach chain, on the search page itself.
// After a keyword search returns grants, this rail answers "who do we team
// with to WIN one of these?" — roster partners + Reference library, ranked.
// Each recommendation drafts a teaming email inline: copy it, or open your
// mail client prefilled. NOTHING is sent by the system.

import { useEffect, useState } from "react";

type Rec = {
  kind: "partner" | "reference";
  id: string;
  name: string;
  score: number;
  reasons: string[];
  focusAreas: string[];
};

type Grant = {
  title: string;
  agency: string | null;
  deadline: string | null;
  url: string | null;
};

type Draft = { subject: string; markdown: string; safe: boolean };

export function PartnerRecs({ query, titles, topGrant }: { query: string; titles: string[]; topGrant: Grant | null }) {
  const [recs, setRecs] = useState<Rec[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setRecs([]);
    setDrafts({});
    if (!query.trim() || titles.length === 0) return;
    (async () => {
      try {
        const res = await fetch("/api/search/partners", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: query, titles }),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setRecs(data.recommendations ?? []);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, titles]);

  async function draftFor(rec: Rec) {
    if (!topGrant) return;
    setDrafting(rec.id);
    try {
      const res = await fetch("/api/search/outreach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgName: rec.name,
          grantTitle: topGrant.title,
          agency: topGrant.agency,
          deadline: topGrant.deadline,
          url: topGrant.url,
          focusAreas: rec.focusAreas,
          knownPartner: rec.kind === "partner",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.draft) setDrafts((d) => ({ ...d, [rec.id]: data.draft }));
    } finally {
      setDrafting(null);
    }
  }

  async function copy(rec: Rec) {
    const d = drafts[rec.id];
    if (!d) return;
    await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.markdown}`);
    setCopied(rec.id);
    setTimeout(() => setCopied(null), 2000);
  }

  if (!query.trim() || titles.length === 0 || (loaded && recs.length === 0)) return null;

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600">
          Recommended partners — who to team with to win these
        </h2>
        {!loaded && <span className="text-[11px] text-stone-400">matching…</span>}
      </div>
      <ul className="mt-3 space-y-2">
        {recs.map((rec) => {
          const draft = drafts[rec.id];
          return (
            <li key={`${rec.kind}:${rec.id}`} className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-stone-900">{rec.name}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        rec.kind === "partner"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-amber-300 bg-amber-50 text-amber-900"
                      }`}
                    >
                      {rec.kind === "partner" ? "your partner" : "reference org"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-stone-600">{rec.reasons.slice(0, 2).join(" · ")}</div>
                </div>
                <button
                  onClick={() => void draftFor(rec)}
                  disabled={drafting === rec.id || !topGrant}
                  className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:border-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                >
                  {drafting === rec.id ? "Drafting…" : draft ? "Re-draft" : "Draft outreach"}
                </button>
              </div>

              {draft && (
                <div className="mt-3 rounded-lg border border-stone-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                      Draft — not sent. Review, then copy or open in your mail app.
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => void copy(rec)}
                        className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
                      >
                        {copied === rec.id ? "✓ Copied" : "Copy"}
                      </button>
                      <a
                        href={`mailto:?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.markdown)}`}
                        className="rounded-md border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                      >
                        Open in Mail
                      </a>
                    </div>
                  </div>
                  <div className="mt-2 text-xs font-semibold text-stone-800">Subject: {draft.subject}</div>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-xs leading-5 text-stone-700">
                    {draft.markdown}
                  </pre>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

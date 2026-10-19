"use client";

// R2 + R3 — pool activation: turn parked money into motion.
// Three plays, one panel: write the HOLDER (agency/municipality), write a
// PARTNER non-profit who could receive the funds and move the holder, or
// draft the RFP the holder could issue. All drafts; nothing sends.

import { useCallback, useEffect, useState } from "react";

type Draft = { subject: string; markdown: string; safe: boolean };
type Rec = { kind: "partner" | "reference"; id: string; name: string; reasons: string[]; focusAreas: string[] };
type Rfp = { markdown: string; generator: "cli" | "skeleton"; createdAt: number };

export function PoolActivationPanel({ poolId }: { poolId: string }) {
  const [holderDraft, setHolderDraft] = useState<Draft | null>(null);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [showHolder, setShowHolder] = useState(false);
  const [partnerDrafts, setPartnerDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [rfp, setRfp] = useState<Rfp | null>(null);
  const [rfpOpen, setRfpOpen] = useState(false);

  useEffect(() => {
    void fetch(`/api/pools/${poolId}/activate`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setHolderDraft(d.holderDraft ?? null);
          setRecs(d.recommendations ?? []);
        }
      })
      .catch(() => {});
    void fetch(`/api/pools/${poolId}/rfp`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRfp(d?.rfp ?? null))
      .catch(() => {});
  }, [poolId]);

  const copy = useCallback(async (key: string, subject: string | null, body: string) => {
    await navigator.clipboard.writeText(subject ? `Subject: ${subject}\n\n${body}` : body);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  async function draftForOrg(rec: Rec) {
    setBusy(rec.id);
    try {
      const res = await fetch(`/api/pools/${poolId}/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgName: rec.name, focusAreas: rec.focusAreas, knownPartner: rec.kind === "partner" }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.draft) setPartnerDrafts((s) => ({ ...s, [rec.id]: d.draft }));
    } finally {
      setBusy(null);
    }
  }

  async function generateRfp() {
    setBusy("rfp");
    try {
      const res = await fetch(`/api/pools/${poolId}/rfp`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.rfp) {
        setRfp(d.rfp);
        setRfpOpen(true);
      }
    } finally {
      setBusy(null);
    }
  }

  function mailHref(d: Draft): string {
    return `mailto:?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.markdown)}`;
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600">
        Activate this pool — money that exists but isn&rsquo;t moving
      </h2>

      {/* Play 1: the holder */}
      <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-stone-900">1 · Write the holder</div>
            <div className="text-xs text-stone-600">
              The agency or municipality sitting on the balance — offer program-design help.
            </div>
          </div>
          <button
            onClick={() => setShowHolder((v) => !v)}
            disabled={!holderDraft}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:border-emerald-600 hover:text-emerald-700 disabled:opacity-50"
          >
            {showHolder ? "Hide draft" : "View draft"}
          </button>
        </div>
        {showHolder && holderDraft && (
          <div className="mt-2 rounded-lg border border-stone-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                Draft — not sent
              </span>
              <div className="flex gap-1.5">
                <button onClick={() => void copy("holder", holderDraft.subject, holderDraft.markdown)} className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100">
                  {copied === "holder" ? "✓ Copied" : "Copy"}
                </button>
                <a href={mailHref(holderDraft)} className="rounded-md border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100">
                  Open in Mail
                </a>
              </div>
            </div>
            <div className="mt-2 text-xs font-semibold text-stone-800">Subject: {holderDraft.subject}</div>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap font-sans text-xs leading-5 text-stone-700">{holderDraft.markdown}</pre>
          </div>
        )}
      </div>

      {/* Play 2: the partner non-profit */}
      <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
        <div className="text-sm font-semibold text-stone-900">2 · Recruit a local champion</div>
        <div className="text-xs text-stone-600">
          A non-profit that could receive these funds — and credibly press the holder to move them.
        </div>
        {recs.length === 0 ? (
          <div className="mt-2 text-xs text-stone-400">No aligned orgs found for this pool&rsquo;s themes.</div>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {recs.slice(0, 4).map((rec) => {
              const d = partnerDrafts[rec.id];
              return (
                <li key={rec.id} className="rounded-md border border-stone-200 bg-white p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 text-xs">
                      <span className="font-semibold text-stone-900">{rec.name}</span>{" "}
                      <span className={rec.kind === "partner" ? "text-emerald-700" : "text-amber-800"}>
                        · {rec.kind === "partner" ? "your partner" : "reference org"}
                      </span>
                      <div className="text-stone-500">{rec.reasons[0]}</div>
                    </div>
                    <button
                      onClick={() => void draftForOrg(rec)}
                      disabled={busy === rec.id}
                      className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-semibold text-stone-700 hover:border-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                    >
                      {busy === rec.id ? "Drafting…" : d ? "Re-draft" : "Draft outreach"}
                    </button>
                  </div>
                  {d && (
                    <div className="mt-2 rounded-md border border-stone-200 bg-stone-50 p-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => void copy(rec.id, d.subject, d.markdown)} className="rounded-md border border-stone-300 bg-white px-2 py-0.5 text-[11px] text-stone-700 hover:bg-stone-100">
                          {copied === rec.id ? "✓ Copied" : "Copy"}
                        </button>
                        <a href={mailHref(d)} className="rounded-md border border-emerald-600 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100">
                          Open in Mail
                        </a>
                      </div>
                      <div className="mt-1 text-[11px] font-semibold text-stone-800">Subject: {d.subject}</div>
                      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap font-sans text-[11px] leading-4 text-stone-700">{d.markdown}</pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Play 3: the RFP */}
      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-stone-900">3 · Draft the RFP for them</div>
            <div className="text-xs text-stone-600">
              Hand the holder a ready-to-issue solicitation — the document is usually the bottleneck.
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {rfp && (
              <button onClick={() => setRfpOpen((v) => !v)} className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100">
                {rfpOpen ? "Hide RFP" : "View RFP"}
              </button>
            )}
            <button
              onClick={() => void generateRfp()}
              disabled={busy === "rfp"}
              className="rounded-md border border-amber-600 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-50"
            >
              {busy === "rfp" ? "Writing… (≈1 min)" : rfp ? "Regenerate RFP" : "Generate draft RFP"}
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-amber-900">
          ⚖ Before Acme bids on any resulting solicitation: disclose the drafting assistance to the agency and
          confirm local conflict-of-interest rules — some jurisdictions restrict a drafter&rsquo;s participation.
        </p>
        {rfpOpen && rfp && (
          <div className="mt-2 rounded-lg border border-stone-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                Draft RFP · {rfp.generator === "cli" ? "AI-written" : "template"} · {new Date(rfp.createdAt).toLocaleString()}
              </span>
              <button onClick={() => void copy("rfp", null, rfp.markdown)} className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100">
                {copied === "rfp" ? "✓ Copied" : "Copy markdown"}
              </button>
            </div>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap font-sans text-xs leading-5 text-stone-700">{rfp.markdown}</pre>
          </div>
        )}
      </div>
    </section>
  );
}

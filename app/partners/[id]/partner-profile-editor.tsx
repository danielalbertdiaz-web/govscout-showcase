"use client";

// Partner reference profile — view + inline edit (Item 1.6, layer 3).
//
// History: this briefly shipped read-only after a misread request; the
// operator confirmed (2026-06-11) they DO want in-app editing. The displayed
// text is sanitized server-side; saving writes the on-disk source profile via
// the hardened POST /api/partners (path-traversal + SSRF guarded).

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  partnerId: string;
  partnerName: string;
  /** Sanitized body shown in read mode. */
  initialBody: string;
  /** True when the on-disk source still contains copy that had to be scrubbed. */
  hadRedactions: boolean;
};

export function PartnerProfileEditor({ partnerId, partnerName, initialBody, hadRedactions }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/partners", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: partnerId, name: partnerName, body: draft }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `save failed (${res.status})`);
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
          Reference profile
        </h2>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(initialBody);
              setEditing(true);
            }}
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
          >
            Edit
          </button>
        )}
      </div>

      {hadRedactions && !editing && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          Internal copy was scrubbed from this view. The saved profile still contains it — open
          Edit to correct the source.
        </p>
      )}

      {editing ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(24, Math.max(8, draft.split("\n").length + 2))}
            className="w-full rounded-md border border-stone-300 p-3 font-sans text-sm text-stone-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
              className="rounded-md border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : initialBody.trim() ? (
        <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-stone-800">
          {initialBody.trim()}
        </pre>
      ) : (
        <p className="mt-3 text-sm text-stone-500 italic">
          No reference profile yet — click Edit to write one, or re-ingest from the partner&rsquo;s website
          via &ldquo;Add partner&rdquo;.
        </p>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PARTNER_ROLES,
  PARTNER_ROLE_LABELS,
  upsertRosterEntry,
  removeFromRoster,
  setIncluded,
  setRole,
  type DraftPartnerEntry,
  type PartnerRole,
} from "@/lib/draft-partners";

// Item 4.1 — per-draft partner roster. Multi-select from the partner pool, with
// a role label and an include/exclude toggle per partner. The included set is
// what flows into the assembled document + the synthesizer's partner block, so
// NJCU+Riverside, CFPC-only, or Brightline-referral are all expressible per draft.
// Nothing here sends anything; it only persists selection to the draft's meta.

type AvailablePartner = { id: string; name: string; type: string; description: string };

export default function PartnerRoster({ draftId }: { draftId: string }) {
  const [roster, setRoster] = useState<DraftPartnerEntry[]>([]);
  const [available, setAvailable] = useState<AvailablePartner[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const base = `/api/drafts/${draftId}/partners`;

  const load = useCallback(async () => {
    try {
      const r = await fetch(base);
      if (!r.ok) return;
      const d = (await r.json()) as { roster: DraftPartnerEntry[]; available: AvailablePartner[] };
      setRoster(d.roster ?? []);
      setAvailable(d.available ?? []);
    } finally {
      setLoaded(true);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = useMemo(() => {
    const map = new Map(available.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? id;
  }, [available]);

  const onRoster = useMemo(() => new Set(roster.map((e) => e.partnerId)), [roster]);
  const addable = available.filter((p) => !onRoster.has(p.id));

  function mutate(next: DraftPartnerEntry[]) {
    setRoster(next);
    setDirty(true);
    setMsg(null);
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roster }),
      });
      if (!r.ok) {
        setMsg("Save failed.");
        return;
      }
      const d = (await r.json()) as { roster: DraftPartnerEntry[] };
      setRoster(d.roster ?? roster);
      setDirty(false);
      setMsg("Saved.");
    } finally {
      setSaving(false);
    }
  }

  const includedCount = roster.filter((e) => e.included).length;

  return (
    <section className="mt-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
            Partner roster
          </h2>
          <p className="mt-0.5 text-xs text-stone-500">
            Who is on this draft, in what role. Excluded partners are dropped from the
            assembled document and the synthesizer&apos;s partner block.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-emerald-700">{msg}</span>}
          <span className="text-[11px] text-stone-400">
            {includedCount} included / {roster.length} on roster
          </span>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="rounded-md border border-emerald-700 bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save roster"}
          </button>
        </div>
      </header>

      {!loaded ? (
        <p className="mt-3 text-xs text-stone-400">Loading…</p>
      ) : (
        <>
          {/* Current roster */}
          {roster.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-center text-xs text-stone-500">
              No partners on this draft yet. Add from the pool below.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {roster.map((e) => (
                <li
                  key={e.partnerId}
                  className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${
                    e.included
                      ? "border-stone-200 bg-stone-50/60"
                      : "border-stone-200 bg-stone-100/70 opacity-60"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900">
                    {nameOf(e.partnerId)}
                  </span>
                  <select
                    value={e.role}
                    onChange={(ev) => mutate(setRole(roster, e.partnerId, ev.target.value as PartnerRole))}
                    className="rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700"
                    aria-label={`Role for ${nameOf(e.partnerId)}`}
                  >
                    {PARTNER_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {PARTNER_ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs text-stone-600">
                    <input
                      type="checkbox"
                      checked={e.included}
                      onChange={(ev) => mutate(setIncluded(roster, e.partnerId, ev.target.checked))}
                    />
                    Include
                  </label>
                  <button
                    onClick={() => mutate(removeFromRoster(roster, e.partnerId))}
                    className="rounded border border-stone-300 bg-white px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                    aria-label={`Remove ${nameOf(e.partnerId)}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add from the pool */}
          {addable.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                Add a partner
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {addable.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => mutate(upsertRosterEntry(roster, { partnerId: p.id }))}
                    className="rounded-full border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:border-emerald-400 hover:bg-emerald-50"
                    title={p.description || p.type}
                  >
                    + {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

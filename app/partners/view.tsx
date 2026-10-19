"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/app/_components/AppHeader";
import { SuggestionInbox } from "@/app/_components/SuggestionInbox";
import AddPartner from "./add-partner";
import { PageInfo } from "@/app/_components/PageInfo";

export type PartnerListItem = {
  id: string;
  name: string;
  type: string;
  description: string;
  capabilities: string[];
  contact: string;
  status: string;
  hasBody: boolean;
};

type Props = {
  user: { email: string; name: string };
  initial: PartnerListItem[];
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

const TYPE_PILL: Record<string, string> = {
  referral_partner: "border-violet-300 bg-violet-50 text-violet-800",
  tech_specialist: "border-sky-300 bg-sky-50 text-sky-800",
  community_partner: "border-emerald-300 bg-emerald-50 text-emerald-800",
  healthcare_partner: "border-rose-300 bg-rose-50 text-rose-800",
};

function typePillClass(t: string): string {
  return TYPE_PILL[t] ?? "border-stone-300 bg-stone-50 text-stone-700";
}

function prettyType(t: string): string {
  return t.replace(/_/g, " ");
}

function prettyCapability(c: string): string {
  return c.replace(/_/g, " ");
}

export default function PartnersView({ user, initial }: Props) {
  const [items] = useState<PartnerListItem[]>(initial);
  const [q, setQ] = useState("");
  const [capFilter, setCapFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const allCapabilities = useMemo(() => {
    const s = new Set<string>();
    for (const p of items) for (const c of p.capabilities) s.add(c);
    return Array.from(s).sort();
  }, [items]);

  const allTypes = useMemo(() => {
    const s = new Set<string>();
    for (const p of items) if (p.type) s.add(p.type);
    return Array.from(s).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((p) => {
      if (typeFilter !== "all" && p.type !== typeFilter) return false;
      if (capFilter !== "all" && !p.capabilities.includes(capFilter)) return false;
      if (!ql) return true;
      const blob = [p.name, p.type, p.description, p.capabilities.join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(ql);
    });
  }, [items, q, capFilter, typeFilter]);

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Partners"
        title={`${items.length} consortium partner${items.length === 1 ? "" : "s"}`}
        subtitle="Capability manifest powering auto-match on proposals and drafts."
        userLabel={user.name}
        activeNav="partners"
        trailingActions={<AddPartner />}
      />

      <div className="mt-4 flex flex-col gap-4">
        <PageInfo id="partners" title="How do I manage partners?">
          <p>
            Your consortium roster — auto-matched to every draft by fit score. <strong>Add a partner:</strong> click{" "}
            <em>Add partner</em> and paste their <strong>website URL</strong> — the system fetches the site, extracts
            capabilities and a profile, and you review before saving (PDF and paste-text work too).{" "}
            <strong>Edit:</strong> open a partner and hit <em>Edit</em> on the reference profile.
          </p>
          <p>
            <strong>Promote from Reference:</strong> on the Reference page, any non-profit card has a{" "}
            <em>→ Partner</em> button that copies it onto this roster. Partners marked <em>active</em> are the ones the
            auto-matcher considers first.
          </p>
        </PageInfo>
        <SuggestionInbox paneContextType="partners" />
        <section className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="grow">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Search
            </label>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, type, capability…"
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Type
            </label>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className={`mt-1 block ${INPUT}`}
            >
              <option value="all">All ({items.length})</option>
              {allTypes.map((t) => (
                <option key={t} value={t}>
                  {prettyType(t)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Capability
            </label>
            <select
              value={capFilter}
              onChange={(e) => setCapFilter(e.target.value)}
              className={`mt-1 block ${INPUT}`}
            >
              <option value="all">All</option>
              {allCapabilities.map((c) => (
                <option key={c} value={c}>
                  {prettyCapability(c)}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {filtered.map((p) => (
            <article
              key={p.id}
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-stone-900">{p.name}</h2>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {p.type && (
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${typePillClass(p.type)}`}
                      >
                        {prettyType(p.type)}
                      </span>
                    )}
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        p.status === "active"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-stone-300 bg-stone-50 text-stone-600"
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>
                </div>
              </header>

              {p.description && (
                <p className="mt-3 text-sm text-stone-700">{p.description}</p>
              )}

              {p.capabilities.length > 0 && (
                <div className="mt-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                    Capabilities
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.capabilities.map((c) => (
                      <span
                        key={c}
                        className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-700"
                      >
                        {prettyCapability(c)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <footer className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3">
                <div className="text-[11px] text-stone-500">
                  {p.contact || "Contact: —"}
                </div>
                <Link
                  href={`/partners/${p.id}`}
                  className="text-xs font-semibold text-emerald-700 hover:text-emerald-900"
                >
                  Open detail →
                </Link>
              </footer>
            </article>
          ))}
        </section>

        {filtered.length === 0 && (
          <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">
            No partners match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}

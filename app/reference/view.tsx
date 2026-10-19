"use client";

import { useMemo, useState } from "react";
import { AppHeader } from "@/app/_components/AppHeader";
import { filterReferenceOrgs, referenceOutreachFit, type ReferenceOrg } from "@/lib/reference-orgs";
import { PageInfo } from "@/app/_components/PageInfo";
import ResearchPanel from "./research-panel";
import { PromoteToPartnerButton } from "./promote-button";

type Props = {
  user: { email: string; name: string };
  orgs: ReferenceOrg[];
  focusAreas: string[];
  datasetNote: string | null;
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

const KIND_PILL: Record<ReferenceOrg["kind"], string> = {
  google_org_winner: "border-amber-300 bg-amber-50 text-amber-800",
  nonprofit: "border-sky-300 bg-sky-50 text-sky-800",
  private_foundation: "border-violet-300 bg-violet-50 text-violet-800",
};

const KIND_LABEL: Record<ReferenceOrg["kind"], string> = {
  google_org_winner: "Google.org winner",
  nonprofit: "Non-profit",
  private_foundation: "Private foundation",
};

function prettyArea(a: string): string {
  return a.replace(/_/g, " ");
}

function money(n: number | null): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

export default function ReferenceView({ user, orgs, focusAreas, datasetNote }: Props) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("all");
  const [focus, setFocus] = useState<string>("all");
  const [fitFirst, setFitFirst] = useState(false);

  const fitCount = useMemo(
    () => orgs.filter((o) => referenceOutreachFit(o)?.tier === "strong").length,
    [orgs],
  );

  const filtered = useMemo(() => {
    const base = filterReferenceOrgs(orgs, {
      q,
      kind: kind === "all" ? "all" : (kind as ReferenceOrg["kind"]),
      focusArea: focus === "all" ? null : focus,
    });
    if (!fitFirst) return base;
    // Outreach-fit first: strong (sub-host candidates) → funder matches → rest.
    const rank = (o: ReferenceOrg) => {
      const f = referenceOutreachFit(o);
      return f?.tier === "strong" ? 0 : f?.tier === "funder" ? 1 : 2;
    };
    return [...base].sort((a, b) => rank(a) - rank(b));
  }, [orgs, q, kind, focus, fitFirst]);

  const winners = orgs.filter((o) => o.kind === "google_org_winner").length;
  const nonprofits = orgs.filter((o) => o.kind === "nonprofit").length;
  const foundations = orgs.filter((o) => o.kind === "private_foundation").length;

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Reference"
        title={`${orgs.length} reference org${orgs.length === 1 ? "" : "s"}`}
        subtitle="Private foundations (IRS-mapped), Google.org winners, and a curated non-profit list — with live, cited funder research."
        userLabel={user.name}
        activeNav="reference"
      />

      <div className="mt-4 flex flex-col gap-4">
        {datasetNote && (
          <div className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-2.5 text-xs text-stone-600">
            <span className="font-semibold text-stone-700">About this dataset:</span>{" "}
            {datasetNote}
          </div>
        )}

        <PageInfo id="reference" title="How do I use Reference?">
          <p>
            This is your <strong>prospect research library</strong>: 1,400+ private foundations mapped from IRS filings (with
            assets and estimated annual giving), past Google.org winners, and a curated non-profit list. Nothing here is an
            open application — these are <strong>doors worth knocking on</strong>.
          </p>
          <p>
            <strong>Use it:</strong> filter to <em>Private foundations</em>, sort by giving capacity, open the ProPublica link
            to see their actual filings, then use the research box above to ask anything (&ldquo;what did they fund last
            year?&rdquo;). When an org looks like a partner rather than a funder, promote it to your roster from its card.
          </p>
          <p>
            <strong>The sub play:</strong> hit <em>✦ Outreach fit first</em> to surface funded orgs whose focus areas overlap
            Acme&rsquo;s verticals — they hold program money and need delivery capacity, which is exactly where Acme subs in.
            <em> Funder match</em> marks foundations whose grantees are that same conversation one step removed. Teaming
            notices from any org in this library are also auto-flagged <em>Known prime</em> on the Teaming page.
          </p>
        </PageInfo>

        <ResearchPanel />

        <section className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="grow">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Search
            </label>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Org, geography, focus area…"
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Type
            </label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className={`mt-1 block ${INPUT}`}
            >
              <option value="all">All ({orgs.length})</option>
              <option value="google_org_winner">Google.org winners ({winners})</option>
              <option value="nonprofit">Non-profits ({nonprofits})</option>
              <option value="private_foundation">Private foundations ({foundations})</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Focus area
            </label>
            <select
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              className={`mt-1 block ${INPUT}`}
            >
              <option value="all">All</option>
              {focusAreas.map((a) => (
                <option key={a} value={a}>
                  {prettyArea(a)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setFitFirst((v) => !v)}
            title="Rank orgs by cold-outreach fit: funded orgs doing Acme-aligned work first (they can host Acme as a sub), then theme-aligned funders"
            className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
              fitFirst
                ? "border-emerald-600 bg-emerald-100 text-emerald-900"
                : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
            }`}
          >
            ✦ Outreach fit first ({fitCount} strong)
          </button>
        </section>

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-12 text-center text-sm text-stone-500">
            No reference orgs match these filters.
          </div>
        ) : (
          <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {filtered.map((o) => {
              const amt = money(o.amountUsd);
              const fit = referenceOutreachFit(o);
              return (
                <article
                  key={`${o.kind}:${o.id}`}
                  className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
                >
                  <header className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <h2 className="truncate text-base font-semibold text-stone-900">
                          {o.name}
                        </h2>
                        <PromoteToPartnerButton
                          name={o.name}
                          note={o.note}
                          focusAreas={o.focusAreas}
                          sourceUrl={o.sourceUrl}
                        />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${KIND_PILL[o.kind]}`}
                        >
                          {KIND_LABEL[o.kind]}
                        </span>
                        {o.geography && (
                          <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-600">
                            {o.geography}
                          </span>
                        )}
                        {(amt || o.year) && (
                          <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
                            {[amt, o.year].filter(Boolean).join(" · ")}
                          </span>
                        )}
                        {fit?.tier === "strong" && (
                          <span
                            title={`Acme-aligned focus: ${fit.matchedAreas.map(prettyArea).join(", ")} — funded org doing our kind of work; cold-outreach to host Acme as a sub.`}
                            className="rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900"
                          >
                            ✦ outreach fit
                          </span>
                        )}
                        {fit?.tier === "funder" && (
                          <span
                            title={`Themes overlap Acme verticals: ${fit.matchedAreas.map(prettyArea).join(", ")} — a funder whose grantees need delivery partners.`}
                            className="rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-800"
                          >
                            funder match
                          </span>
                        )}
                      </div>
                    </div>
                  </header>

                  {o.focusAreas.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {o.focusAreas.map((a) => (
                        <span
                          key={a}
                          className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-700"
                        >
                          {prettyArea(a)}
                        </span>
                      ))}
                    </div>
                  )}

                  {o.note && <p className="mt-3 text-sm text-stone-700">{o.note}</p>}

                  {o.sourceUrl && (
                    <footer className="mt-3 border-t border-stone-100 pt-3">
                      <a
                        href={o.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-semibold text-emerald-700 hover:text-emerald-900"
                      >
                        Source ↗
                      </a>
                    </footer>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}

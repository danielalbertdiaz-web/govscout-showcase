"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { AppHeader, APP_HEADER_NAV_BASE, APP_HEADER_NAV_MUTED } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";

export type NofoListItem = {
  id: string;
  agency: string | null;
  program: string | null;
  fundingFloor: string | null;
  fundingCeiling: string | null;
  periodOfPerformance: string | null;
  summary: string | null;
  originalFilename: string | null;
  extractedAt: number;
  tags: string[];
  score: number | null;
  scoreRationale: string | null;
  scoredAt: number | null;
};

// A2: colored fit-score badge. Mirrors the scout pane convention.
function NofoScoreBadge({
  score,
  rationale,
}: {
  score: number | null;
  rationale: string | null;
}) {
  if (score == null) {
    return (
      <span
        className="shrink-0 rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-500"
        title="Unscored — click Score all to grade"
      >
        ?
      </span>
    );
  }
  const cls =
    score >= 70
      ? "border-emerald-600 bg-emerald-100 text-emerald-900"
      : score >= 40
      ? "border-amber-500 bg-amber-100 text-amber-900"
      : "border-red-500 bg-red-100 text-red-900";
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
      title={rationale ?? `Fit score ${score}/100`}
    >
      {score}
    </span>
  );
}

type Props = {
  user: { email: string; name: string };
  initial: NofoListItem[];
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

const TAG_BTN =
  "inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100";

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString();
}

export default function NofosLibrary({ user, initial }: Props) {
  const [items, setItems] = useState<NofoListItem[]>(initial);
  const [q, setQ] = useState("");
  const [agency, setAgency] = useState("");
  const [program, setProgram] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "score">("score");
  const [scoring, setScoring] = useState(false);
  const [scoreMsg, setScoreMsg] = useState<string | null>(null);

  async function scoreAll() {
    setScoring(true);
    setScoreMsg(null);
    try {
      const res = await fetch("/api/nofos/score-batch", { method: "POST" });
      const data = (await res.json()) as {
        scored?: number;
        failed?: number;
        attempted?: number;
        nofos?: { id: string; score: number; rationale: string }[];
        error?: string;
      };
      if (!res.ok) {
        setScoreMsg(`Score batch failed: ${data.error ?? res.statusText}`);
        return;
      }
      if (data.nofos?.length) {
        const lookup = new Map(data.nofos.map((x) => [x.id, x] as const));
        setItems((prev) =>
          prev.map((n) => {
            const hit = lookup.get(n.id);
            if (!hit) return n;
            return {
              ...n,
              score: hit.score,
              scoreRationale: hit.rationale,
              scoredAt: Date.now(),
            };
          }),
        );
      }
      setScoreMsg(
        `Scored ${data.scored ?? 0} of ${data.attempted ?? 0}${data.failed ? ` (${data.failed} failed)` : ""}.`,
      );
    } catch (err) {
      setScoreMsg(`Score batch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScoring(false);
    }
  }

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const n of items) for (const t of n.tags) s.add(t);
    return Array.from(s).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const al = agency.trim().toLowerCase();
    const pl = program.trim().toLowerCase();
    const tl = tagFilter.trim().toLowerCase();
    const base = items.filter((n) => {
      if (al && !(n.agency ?? "").toLowerCase().includes(al)) return false;
      if (pl && !(n.program ?? "").toLowerCase().includes(pl)) return false;
      if (tl && !n.tags.some((t) => t.toLowerCase().includes(tl))) return false;
      if (ql) {
        const blob = [
          n.agency,
          n.program,
          n.summary,
          n.originalFilename,
          n.tags.join(" "),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!blob.includes(ql)) return false;
      }
      return true;
    });
    if (sortBy !== "score") return base;
    return [...base].sort((a, b) => {
      if (a.score == null && b.score == null) return b.extractedAt - a.extractedAt;
      if (a.score == null) return 1;
      if (b.score == null) return -1;
      return b.score - a.score;
    });
  }, [items, q, agency, program, tagFilter, sortBy]);

  async function updateTags(id: string, tags: string[]) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, tags } : n)));
    const res = await fetch(`/api/nofos/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn("[nofos] tag update failed", err);
    }
  }

  async function removeNofo(id: string) {
    if (!confirm("Delete this NOFO from the library? Drafts linked to it stay, but lose the link.")) return;
    const res = await fetch(`/api/nofos/${id}`, { method: "DELETE" });
    if (res.ok) {
      setItems((prev) => prev.filter((n) => n.id !== id));
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-6">
      <AppHeader
        tagline="NOFO Library"
        title={`${items.length} NOFO${items.length === 1 ? "" : "s"} on file`}
        subtitle="Click any row to load it into the workbench. Tags are inline-editable."
        userLabel={user.name}
        activeNav="nofos"
        trailingActions={
          <>
            <button
              type="button"
              onClick={() => setSortBy((v) => (v === "score" ? "recent" : "score"))}
              className={`${APP_HEADER_NAV_BASE} ${APP_HEADER_NAV_MUTED}`}
            >
              Sort: {sortBy === "score" ? "fit" : "recent"}
            </button>
            <button
              type="button"
              onClick={scoreAll}
              disabled={scoring}
              className={`${APP_HEADER_NAV_BASE} gs-chip gs-chip-cta disabled:opacity-50`}
            >
              {scoring ? "Scoring…" : "Score all"}
            </button>
          </>
        }
      />
      <div className="mt-4">
        <PageInfo id="nofos" title="What is a NOFO?">
          <p>
            A <strong>NOFO</strong> — <em>Notice of Funding Opportunity</em> — is the official document a government agency
            publishes when it has money to award: what they&rsquo;ll fund, who&rsquo;s eligible, the required sections, how reviewers
            will score you, and the deadline. It&rsquo;s the assignment sheet for the entire application.
          </p>
          <p>
            <strong>Use it:</strong> upload a NOFO PDF in the <em>Workbench</em> (or fetch one by URL). The system extracts the
            requirements into structured fields, scores the fit, and saves it here. From a saved NOFO you can spawn a draft
            whose sections mirror exactly what the agency asked for.
          </p>
        </PageInfo>
      </div>
      {scoreMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          {scoreMsg}
        </div>
      )}

      <section className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="grow">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Search</label>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Agency, program, summary text, filename, tags…"
            className={`mt-1 block w-full ${INPUT}`}
          />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Agency</label>
          <input
            type="text"
            value={agency}
            onChange={(e) => setAgency(e.target.value)}
            placeholder="HRSA, DOD, DOE…"
            className={`mt-1 block w-44 ${INPUT}`}
          />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Program</label>
          <input
            type="text"
            value={program}
            onChange={(e) => setProgram(e.target.value)}
            placeholder="Ryan White, RECA…"
            className={`mt-1 block w-44 ${INPUT}`}
          />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Tag</label>
          <input
            type="text"
            list="nofo-tags"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            placeholder="any"
            className={`mt-1 block w-32 ${INPUT}`}
          />
          <datalist id="nofo-tags">
            {allTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
      </section>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center">
          {items.length === 0 ? (
            <>
              <p className="text-sm font-medium text-stone-800">No NOFOs in your library yet.</p>
              <p className="mt-2 text-xs leading-5 text-stone-500">
                Upload a NOFO PDF/DOCX in the workbench. After extraction, it&rsquo;s saved here automatically.
              </p>
              <Link
                href="/workbench"
                className="mt-4 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500"
              >
                Go to workbench →
              </Link>
            </>
          ) : (
            <p className="text-sm text-stone-700">No NOFOs match your filters.</p>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((n) => (
            <NofoRow
              key={n.id}
              nofo={n}
              onTagsChange={updateTags}
              onDelete={removeNofo}
              scoreBadge={<NofoScoreBadge score={n.score} rationale={n.scoreRationale} />}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function NofoRow({
  nofo,
  onTagsChange,
  onDelete,
  scoreBadge,
}: {
  nofo: NofoListItem;
  onTagsChange: (id: string, tags: string[]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  scoreBadge?: React.ReactNode;
}) {
  const [tags, setTags] = useState<string[]>(nofo.tags);
  const [draft, setDraft] = useState("");

  async function commit(next: string[]) {
    setTags(next);
    await onTagsChange(nofo.id, next);
  }
  async function addTag() {
    const v = draft.trim();
    if (!v || tags.includes(v)) {
      setDraft("");
      return;
    }
    setDraft("");
    await commit([...tags, v]);
  }
  async function removeTag(t: string) {
    await commit(tags.filter((x) => x !== t));
  }

  const title = [nofo.agency, nofo.program].filter(Boolean).join(" — ") || nofo.originalFilename || "Untitled NOFO";
  const funding = [nofo.fundingFloor, nofo.fundingCeiling].filter(Boolean).join(" – ");

  return (
    <li className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {scoreBadge}
            <Link
              href={`/?nofo=${nofo.id}`}
              className="block truncate text-base font-semibold text-emerald-700 hover:underline"
              title="Load into workbench"
            >
              {title}
            </Link>
          </div>
          {nofo.scoreRationale && (
            <p className="mt-1 text-[11px] italic text-stone-500">Fit: {nofo.scoreRationale}</p>
          )}
          {nofo.summary && (
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-stone-700">{nofo.summary}</p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-500">
            {funding && <span>Funding: {funding}</span>}
            {nofo.periodOfPerformance && <span>PoP: {nofo.periodOfPerformance}</span>}
            {nofo.originalFilename && <span className="font-mono">{nofo.originalFilename}</span>}
            <span>extracted {fmtDate(nofo.extractedAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={`/?nofo=${nofo.id}`}
            className="rounded-md border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            Open in workbench
          </Link>
          <Link
            href={`/nofos/${nofo.id}`}
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            Details
          </Link>
          <button
            onClick={() => void onDelete(nofo.id)}
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
            title="Delete NOFO"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span key={t} className={TAG_BTN}>
            {t}
            <button
              type="button"
              onClick={() => void removeTag(t)}
              className="text-emerald-700 hover:text-emerald-900"
              aria-label={`Remove tag ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addTag();
            }
          }}
          onBlur={() => void addTag()}
          placeholder="+ tag"
          className="w-24 rounded-full border border-dashed border-stone-300 bg-white px-2 py-0.5 text-[11px] text-stone-700 placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600/30"
        />
      </div>
    </li>
  );
}

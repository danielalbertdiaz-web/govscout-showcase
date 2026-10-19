"use client";

import { useMemo, useState } from "react";
import { AppHeader } from "@/app/_components/AppHeader";
import {
  OUTREACH_STATUSES,
  OUTREACH_STATUS_LABELS,
  type OutreachStatus,
} from "@/lib/contact-outreach";

export type ContactListItem = {
  id: string;
  name: string;
  title: string | null;
  agency: string | null;
  email: string | null;
  linkedinUrl: string | null;
  tags: string[];
  source: string | null;
  outreachStatus: OutreachStatus;
  introDraft: string | null;
  introDraftAt: number | null;
};

type Props = {
  user: { email: string; name: string };
  initial: ContactListItem[];
  linkedin: { totalClaimed: number | null; available: number | null };
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

// Triage (B2): a lead you can't reach or can't place is dead weight. Surface
// exactly what's wrong so the operator can fix the field or delete the row.
export function contactIssues(c: ContactListItem): string[] {
  const issues: string[] = [];
  const email = (c.email ?? "").trim();
  if (!email && !(c.linkedinUrl ?? "").trim()) issues.push("unreachable — no email or LinkedIn");
  else if (!email) issues.push("no email");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) issues.push("malformed email");
  if (!(c.agency ?? "").trim()) issues.push("no organization");
  if (!(c.name ?? "").trim() || c.name.trim().length < 3) issues.push("name incomplete");
  return issues;
}

const STATUS_PILL: Record<OutreachStatus, string> = {
  not_contacted: "border-stone-300 bg-stone-50 text-stone-600",
  contacted: "border-sky-300 bg-sky-50 text-sky-800",
  responded: "border-amber-300 bg-amber-50 text-amber-800",
  not_interested: "border-rose-300 bg-rose-50 text-rose-700",
  partnered: "border-emerald-300 bg-emerald-50 text-emerald-800",
};

export default function ContactsView({ user, initial, linkedin }: Props) {
  const [items, setItems] = useState<ContactListItem[]>(initial);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-contact intro preview state: id -> { markdown, redactions, safe }
  const [intros, setIntros] = useState<
    Record<string, { markdown: string; redactions: string[]; safe: boolean }>
  >({});

  const allSources = useMemo(() => {
    const s = new Set<string>();
    for (const c of items) if (c.source) s.add(c.source);
    return Array.from(s).sort();
  }, [items]);

  const [triageOnly, setTriageOnly] = useState(false);
  const triageCount = useMemo(() => items.filter((c) => contactIssues(c).length > 0).length, [items]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((c) => {
      if (triageOnly && contactIssues(c).length === 0) return false;
      if (statusFilter !== "all" && c.outreachStatus !== statusFilter) return false;
      if (sourceFilter !== "all" && (c.source ?? "") !== sourceFilter) return false;
      if (!ql) return true;
      const blob = [c.name, c.title, c.agency, c.email, c.tags.join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(ql);
    });
  }, [items, q, statusFilter, sourceFilter, triageOnly]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of items) m[c.outreachStatus] = (m[c.outreachStatus] ?? 0) + 1;
    return m;
  }, [items]);

  async function runImport() {
    setBusy("import");
    setError(null);
    setImportNote(null);
    try {
      const res = await fetch("/api/contacts/import", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "import_failed");
        return;
      }
      const parts = [
        `Imported ${data.imported}`,
        `skipped ${data.skipped} (already present)`,
      ];
      if (data.note) parts.push(data.note);
      setImportNote(parts.join(" · "));
      // Reload to reflect newly created leads.
      const list = await fetch("/api/contacts?limit=500").then((r) => r.json());
      if (Array.isArray(list?.contacts)) {
        setItems(
          list.contacts.map((c: Record<string, unknown>) => ({
            id: c.id,
            name: c.name,
            title: c.title ?? null,
            agency: c.agency ?? null,
            email: c.email ?? null,
            linkedinUrl: c.linkedinUrl ?? null,
            tags: Array.isArray(c.tags) ? c.tags : [],
            source: c.source ?? null,
            outreachStatus: c.outreachStatus ?? "not_contacted",
            introDraft: c.introDraft ?? null,
            introDraftAt: c.introDraftAt ?? null,
          })) as ContactListItem[],
        );
      }
    } catch {
      setError("network_error");
    } finally {
      setBusy(null);
    }
  }

  // P5 — upload any lead CSV (header row with Name or First/Last Name columns).
  async function uploadCsv(file: File) {
    setBusy("csv");
    setError(null);
    setImportNote(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/contacts/upload-csv", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "upload_failed");
        return;
      }
      setImportNote(
        `CSV: imported ${data.imported} · ${data.skippedDupes} duplicates skipped · ${data.skippedRows} unparseable rows`,
      );
      const list = await fetch("/api/contacts?limit=500").then((r) => r.json());
      if (Array.isArray(list?.contacts)) {
        setItems(
          list.contacts.map((c: Record<string, unknown>) => ({
            id: c.id,
            name: c.name,
            title: c.title ?? null,
            agency: c.agency ?? null,
            email: c.email ?? null,
            linkedinUrl: c.linkedinUrl ?? null,
            tags: Array.isArray(c.tags) ? c.tags : [],
            source: c.source ?? null,
            outreachStatus: c.outreachStatus ?? "not_contacted",
            introDraft: c.introDraft ?? null,
            introDraftAt: c.introDraftAt ?? null,
          })) as ContactListItem[],
        );
      }
    } catch {
      setError("network_error");
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(id: string, status: OutreachStatus) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outreachStatus: status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "update_failed");
        return;
      }
      setItems((prev) =>
        prev.map((c) => (c.id === id ? { ...c, outreachStatus: status } : c)),
      );
    } catch {
      setError("network_error");
    } finally {
      setBusy(null);
    }
  }

  async function removeContact(c: ContactListItem) {
    if (!window.confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
    setBusy(c.id);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${c.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "delete_failed");
        return;
      }
      setItems((prev) => prev.filter((x) => x.id !== c.id));
    } catch {
      setError("network_error");
    } finally {
      setBusy(null);
    }
  }

  async function generateIntro(id: string) {
    setBusy(id);
    setError(null);
    try {
      // NOTHING IS SENT — this only composes and saves a draft for review.
      const res = await fetch(`/api/contacts/${id}/intro`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderName: user.name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "intro_failed");
        return;
      }
      setIntros((prev) => ({
        ...prev,
        [id]: {
          markdown: data.markdown ?? "",
          redactions: Array.isArray(data.redactions) ? data.redactions : [],
          safe: Boolean(data.safe),
        },
      }));
      setItems((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, introDraft: data.markdown ?? c.introDraft, introDraftAt: Date.now() }
            : c,
        ),
      );
    } catch {
      setError("network_error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Contacts"
        title={`${items.length} outreach contact${items.length === 1 ? "" : "s"}`}
        subtitle="Cold-outreach leads & relationships. Drafts are saved for your review — nothing is sent."
        userLabel={user.name}
        activeNav="contacts"
        trailingActions={
          <>
            <label
              className={`cursor-pointer rounded-md border border-sky-600 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100 ${busy === "csv" ? "opacity-60" : ""}`}
              title="Any CSV with a header row — needs a Name (or First/Last Name) column; Company, Title, Email, Phone, LinkedIn URL all map automatically"
            >
              {busy === "csv" ? "Uploading…" : "Upload CSV leads"}
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                disabled={busy === "csv"}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadCsv(f);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              onClick={runImport}
              disabled={busy === "import"}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
            >
              {busy === "import" ? "Importing…" : "Import LinkedIn leads"}
            </button>
          </>
        }
      />

      <div className="mt-4 flex flex-col gap-4">
        {/* LinkedIn data-gap disclosure (claimed vs importable). */}
        {linkedin.totalClaimed != null && linkedin.available != null && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
            <span className="font-semibold">LinkedIn data gap:</span> the export index
            claims <strong>{linkedin.totalClaimed.toLocaleString()}</strong> connections,
            but only <strong>{linkedin.available.toLocaleString()}</strong> are enriched
            and importable. Importing brings in what is actually present — the remainder
            need re-enrichment before they can be used as leads.
          </div>
        )}

        {importNote && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-900">
            {importNote}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-2.5 text-xs text-rose-800">
            {error}
          </div>
        )}

        <section className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="grow">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Search
            </label>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, title, agency, tag…"
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Stage
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={`mt-1 block ${INPUT}`}
            >
              <option value="all">All ({items.length})</option>
              {OUTREACH_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {OUTREACH_STATUS_LABELS[s]} ({counts[s] ?? 0})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
              Source
            </label>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className={`mt-1 block ${INPUT}`}
            >
              <option value="all">All</option>
              {allSources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setTriageOnly((v) => !v)}
            title="Show only contacts with data problems (missing email/org, malformed address) so you can fix or delete them"
            className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
              triageOnly
                ? "border-amber-500 bg-amber-100 text-amber-900"
                : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
            }`}
          >
            ⚠ Needs attention ({triageCount})
          </button>
        </section>

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-12 text-center text-sm text-stone-500">
            No contacts match. Import LinkedIn leads or add contacts to get started.
          </div>
        ) : (
          <section className="flex flex-col gap-3">
            {filtered.map((c) => {
              const intro = intros[c.id];
              const issues = contactIssues(c);
              return (
                <article
                  key={c.id}
                  className={`rounded-xl border bg-white p-4 shadow-sm ${issues.length ? "border-amber-300" : "border-stone-200"}`}
                >
                  <header className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-stone-900">
                        {c.name}
                      </h2>
                      <div className="mt-0.5 text-xs text-stone-600">
                        {[c.title, c.agency].filter(Boolean).join(" · ") || "—"}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL[c.outreachStatus]}`}
                        >
                          {OUTREACH_STATUS_LABELS[c.outreachStatus]}
                        </span>
                        {c.source && (
                          <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-600">
                            {c.source}
                          </span>
                        )}
                        {issues.map((iss) => (
                          <span
                            key={iss}
                            className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800"
                          >
                            ⚠ {iss}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={c.outreachStatus}
                        disabled={busy === c.id}
                        onChange={(e) => setStatus(c.id, e.target.value as OutreachStatus)}
                        className={INPUT}
                      >
                        {OUTREACH_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {OUTREACH_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => generateIntro(c.id)}
                        disabled={busy === c.id}
                        className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 shadow-sm hover:border-emerald-600 hover:text-emerald-700 disabled:opacity-60"
                      >
                        {busy === c.id ? "Working…" : "Generate intro"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeContact(c)}
                        disabled={busy === c.id}
                        title="Delete this contact"
                        className="rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-60"
                      >
                        Delete
                      </button>
                    </div>
                  </header>

                  {c.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {c.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-700"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {(intro || c.introDraft) && (
                    <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                          Cold-intro draft — not sent
                        </span>
                        {intro && !intro.safe && (
                          <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                            {intro.redactions.length} redaction
                            {intro.redactions.length === 1 ? "" : "s"} applied
                          </span>
                        )}
                      </div>
                      <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-stone-800">
                        {intro?.markdown ?? c.introDraft}
                      </pre>
                    </div>
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

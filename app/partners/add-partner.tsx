"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";
const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-stone-600";

const TYPES = [
  "referral_partner",
  "tech_specialist",
  "community_partner",
  "healthcare_partner",
  "prime",
  "subcontractor",
];

type Form = {
  name: string;
  type: string;
  description: string;
  capabilities: string; // comma-separated in the form
  commission_structure: string;
  integration_notes: string;
  contact: string;
  status: string;
  body: string;
};

const EMPTY: Form = {
  name: "",
  type: "referral_partner",
  description: "",
  capabilities: "",
  commission_structure: "",
  integration_notes: "",
  contact: "",
  status: "active",
  body: "",
};

export default function AddPartner() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  function reset() {
    setForm(EMPTY);
    setUrl("");
    setPaste("");
    setFile(null);
    setError(null);
  }

  async function runIngest() {
    setError(null);
    setIngesting(true);
    try {
      let res: Response;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        res = await fetch("/api/partners/ingest", { method: "POST", body: fd });
      } else if (url.trim()) {
        res = await fetch("/api/partners/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: url.trim() }),
        });
      } else if (paste.trim()) {
        res = await fetch("/api/partners/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: paste }),
        });
      } else {
        setError("Add a URL, paste a prospectus, or choose a file first.");
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "ingestion failed");
      const d = data.draft;
      setForm({
        name: d.name ?? "",
        type: d.type ?? "referral_partner",
        description: d.description ?? "",
        capabilities: Array.isArray(d.capabilities) ? d.capabilities.join(", ") : "",
        commission_structure: d.commission_structure ?? "",
        integration_notes: d.integration_notes ?? "",
        contact: d.contact ?? "",
        status: d.status ?? "active",
        body: d.body ?? "",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "ingestion failed");
    } finally {
      setIngesting(false);
    }
  }

  async function save() {
    setError(null);
    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    try {
      const capabilities = form.capabilities
        .split(",")
        .map((c) => c.trim().toLowerCase().replace(/\s+/g, "_"))
        .filter(Boolean);
      const res = await fetch("/api/partners", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          description: form.description,
          capabilities,
          commission_structure: form.commission_structure,
          integration_notes: form.integration_notes,
          contact: form.contact,
          status: form.status,
          body: form.body || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to save");
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
      >
        + Add partner
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/40 p-4 backdrop-blur-sm">
      <div className="my-8 w-full max-w-2xl rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-stone-900">Add partner</h2>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              reset();
            }}
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            ✕
          </button>
        </div>

        {/* Ingest */}
        <section className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
          <div className={LABEL}>Build from a source (optional)</div>
          <p className="mt-1 text-xs text-stone-500">
            Paste a website URL, drop in a prospectus/capability deck, or paste text — it prefills
            the fields below for you to review.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://partner.org/about"
              className={`w-full ${INPUT}`}
            />
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="…or paste prospectus / capability statement text"
              rows={3}
              className={`w-full ${INPUT}`}
            />
            <input
              type="file"
              accept=".pdf,.docx,.txt,.md"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-xs text-stone-600 file:mr-3 file:rounded-md file:border-0 file:bg-stone-200 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-stone-700"
            />
            <div>
              <button
                type="button"
                onClick={runIngest}
                disabled={ingesting}
                className="rounded-md border border-stone-400 bg-white px-3 py-1.5 text-sm font-semibold text-stone-800 shadow-sm transition hover:bg-stone-100 disabled:opacity-50"
              >
                {ingesting ? "Extracting…" : "Extract capabilities"}
              </button>
            </div>
          </div>
        </section>

        {/* Form */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL}>Name *</label>
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div>
            <label className={LABEL}>Type</label>
            <select
              value={form.type}
              onChange={(e) => set("type", e.target.value)}
              className={`mt-1 block w-full ${INPUT}`}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL}>Status</label>
            <select
              value={form.status}
              onChange={(e) => set("status", e.target.value)}
              className={`mt-1 block w-full ${INPUT}`}
            >
              <option value="active">active</option>
              <option value="preferred">preferred</option>
              <option value="inactive">inactive</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Description</label>
            <input
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Capabilities (comma-separated)</label>
            <input
              value={form.capabilities}
              onChange={(e) => set("capabilities", e.target.value)}
              placeholder="grant_writing, workforce_development, data_evaluation"
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div>
            <label className={LABEL}>Commission / structure</label>
            <input
              value={form.commission_structure}
              onChange={(e) => set("commission_structure", e.target.value)}
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div>
            <label className={LABEL}>Contact</label>
            <input
              value={form.contact}
              onChange={(e) => set("contact", e.target.value)}
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Integration notes</label>
            <input
              value={form.integration_notes}
              onChange={(e) => set("integration_notes", e.target.value)}
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Reference profile (markdown)</label>
            <textarea
              value={form.body}
              onChange={(e) => set("body", e.target.value)}
              rows={5}
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              reset();
            }}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save partner"}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppHeader, APP_HEADER_NAV_BASE, APP_HEADER_NAV_MUTED } from "@/app/_components/AppHeader";
import type { CapabilityBlock } from "@/lib/blocks";
import {
  SECTIONS,
  emptySections,
  splitFullDraft,
  joinSections,
  wordCount,
  type SectionKey,
  type SectionMap,
} from "@/lib/sections";
import type { ExtractedNofo } from "@/lib/extract";
import { WORKING_DRAFT_EVENT } from "@/app/drafts/[id]/working-draft-pane";

const DEFAULT_BUSINESS = `Acme Consulting Group LLC
- State-registered, MBE-certified consulting firm (NAICS 541611)
- HQ: 123 Main Street, Suite 100, Springfield, ST 00000
- Specialties: AI-powered strategy, public health program delivery, federal grant management & compliance
- Lead entity for a regional consortium (Riverside, Lakeside, Atlas Insights, Brightline)
- Principal: Alex Doe (Managing Member), dual MBAs
- Clinical authority: Taylor Paul Reed, PhD, MPH
- EIN 00-0000000, State Entity ID 0000000000
- Currently advancing SBA 8(a) certification`;

const DEFAULT_NAICS =
  "541611, 541618, 541614, 541990, 541512, 541511, 541513, 541715, 541720, 611310, 611430, 611699, 621498, 621420, 621491, 621999, 623220, 624190, 624229";

type Props = {
  user: { email: string; name: string };
  blocks: CapabilityBlock[];
  initialDraft?: SerializedDraft;
};

export type SerializedDraft = {
  id: string;
  title: string;
  business: string;
  naics: string;
  opportunity: string;
  blocks: string[];
  structured: ExtractedNofo | null;
  sections: SectionMap;
};

type StreamMeta = { model?: string; blocksLoaded?: string[]; section?: string };

const INPUT_BASE =
  "rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 shadow-sm transition placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500";

const PRIMARY_BTN =
  "rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-600/40 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500 disabled:shadow-none";

const SECONDARY_BTN =
  "rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50";

const ACCENT_BTN =
  "rounded-md border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50";

const LABEL =
  "text-xs font-semibold uppercase tracking-wider text-stone-700";

const HELP_TEXT = "mt-1 text-xs leading-5 text-stone-500";

export default function Workbench({ user, blocks, initialDraft }: Props) {
  const [business, setBusiness] = useState(initialDraft?.business ?? DEFAULT_BUSINESS);
  const [naics, setNaics] = useState(initialDraft?.naics ?? DEFAULT_NAICS);
  const [opportunity, setOpportunity] = useState(initialDraft?.opportunity ?? "");
  const [structured, setStructured] = useState<ExtractedNofo | null>(initialDraft?.structured ?? null);
  const [sections, setSections] = useState<SectionMap>(initialDraft?.sections ?? emptySections());
  const [draftId, setDraftId] = useState<string | null>(initialDraft?.id ?? null);
  const [draftTitle, setDraftTitle] = useState<string>(initialDraft?.title ?? "");

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialDraft?.blocks ?? blocks.slice(0, 6).map((b) => b.id)),
  );
  const [running, setRunning] = useState<null | "all" | SectionKey>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<StreamMeta | null>(null);
  const [usage, setUsage] = useState<{ input_tokens?: number; output_tokens?: number } | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [perSectionInstr, setPerSectionInstr] = useState<Record<SectionKey, string>>({
    executive_summary: "",
    capability_statement: "",
    technical_approach: "",
    past_performance: "",
    reviewer_notes: "",
  });
  const [perSectionModel, setPerSectionModel] = useState<Record<SectionKey, "sonnet" | "opus">>({
    executive_summary: "sonnet",
    capability_statement: "sonnet",
    technical_approach: "sonnet",
    past_performance: "sonnet",
    reviewer_notes: "sonnet",
  });

  const [uploadingNofo, setUploadingNofo] = useState(false);
  const [fetchingNofo, setFetchingNofo] = useState(false);
  const [prefillBanner, setPrefillBanner] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastSavedSnapshot = useRef<string>("");
  const searchParams = useSearchParams();
  const prefillApplied = useRef(false);

  const selectedCount = selected.size;
  const canDraftAll = useMemo(() => opportunity.trim().length > 20 && !running, [opportunity, running]);
  const filledSectionCount = useMemo(
    () => Object.values(sections).filter((v) => v.trim().length > 0).length,
    [sections],
  );
  const totalWords = useMemo(
    () => Object.values(sections).reduce((sum, v) => sum + wordCount(v), 0),
    [sections],
  );
  const opportunityTitle = useMemo(() => {
    const agency = structured?.agency?.trim();
    const program = structured?.program?.trim();
    if (draftTitle?.trim()) return draftTitle.trim();
    if (agency && program) return `${agency} — ${program}`;
    if (program) return program;
    if (agency) return agency;
    return null;
  }, [structured, draftTitle]);

  const businessName = useMemo(() => {
    const firstLine = business.trim().split(/\r?\n/)[0]?.trim();
    return firstLine || "Business profile";
  }, [business]);

  const status: { tone: "idle" | "active" | "done" | "error"; label: string; sub?: string } = useMemo(() => {
    if (error) return { tone: "error", label: "Error", sub: error };
    if (running === "all") {
      const which = Math.max(1, filledSectionCount + 1);
      return { tone: "active", label: `Drafting full proposal — section ${Math.min(which, SECTIONS.length)} of ${SECTIONS.length}…` };
    }
    if (running) {
      const idx = SECTIONS.findIndex((s) => s.key === running);
      return {
        tone: "active",
        label: `Drafting ${SECTIONS[idx]?.title ?? running} (${idx + 1} of ${SECTIONS.length})…`,
      };
    }
    if (filledSectionCount > 0) {
      return {
        tone: "done",
        label: `Done — ${filledSectionCount} of ${SECTIONS.length} sections, ${totalWords.toLocaleString()} words`,
      };
    }
    return { tone: "idle", label: "Ready" };
  }, [error, running, filledSectionCount, totalWords]);

  useEffect(() => {
    if (!initialDraft && typeof window !== "undefined") {
      const saved = window.localStorage.getItem("gs_business");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe localStorage hydration on mount
      if (saved) setBusiness(saved);
      const savedN = window.localStorage.getItem("gs_naics");
      if (savedN) setNaics(savedN);
    }
  }, [initialDraft]);

  useEffect(() => {
    if (!initialDraft && typeof window !== "undefined") window.localStorage.setItem("gs_business", business);
  }, [business, initialDraft]);
  useEffect(() => {
    if (!initialDraft && typeof window !== "undefined") window.localStorage.setItem("gs_naics", naics);
  }, [naics, initialDraft]);

  // Prefill from /search → /?source=...&title=...&nofoUrl=... or /?url=...
  useEffect(() => {
    if (initialDraft) return;
    if (prefillApplied.current) return;
    if (!searchParams) return;
    const timer = window.setTimeout(() => {
      const title = searchParams.get("title");
      const source = searchParams.get("source");
      if (!title && !source) return;
      prefillApplied.current = true;

      const agency = searchParams.get("agency");
      const deadline = searchParams.get("deadline");
      const fundingFloor = searchParams.get("fundingFloor");
      const fundingCeiling = searchParams.get("fundingCeiling");
      const eligibility = searchParams.get("eligibility");
      const url = searchParams.get("url");
      const nofoUrl = searchParams.get("nofoUrl");
      const summary = searchParams.get("summary");
      const oppNaics = searchParams.get("naics");

      const lines: string[] = [];
      if (title) lines.push(`Title: ${title}`);
      if (agency) lines.push(`Agency: ${agency}`);
      if (deadline) lines.push(`Deadline: ${deadline}`);
      if (fundingFloor || fundingCeiling) {
        lines.push(`Funding: ${[fundingFloor, fundingCeiling].filter(Boolean).join(" – ")}`);
      }
      if (eligibility) lines.push(`Eligibility: ${eligibility}`);
      if (oppNaics) lines.push(`NAICS: ${oppNaics}`);
      if (url) lines.push(`Source URL: ${url}`);
      if (summary) lines.push(`\nSummary:\n${summary}`);
      if (lines.length) setOpportunity(lines.join("\n"));
      if (title) setDraftTitle(title);

      setPrefillBanner(
        nofoUrl
          ? `Loaded ${title ?? "opportunity"} — fetching NOFO from ${new URL(nofoUrl).hostname}…`
          : `Loaded ${title ?? "opportunity"} from search. Upload the NOFO PDF below for full extraction, or draft from the synopsis as-is.`,
      );

      if (nofoUrl) {
        void (async () => {
          setFetchingNofo(true);
          try {
            const res = await fetch("/api/nofo/fetch", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url: nofoUrl }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              opportunity?: string;
              structured?: ExtractedNofo;
              error?: string;
              host?: string;
            };
            if (!res.ok) {
              setPrefillBanner(
                `NOFO auto-fetch failed (${data.error ?? res.status}). Upload the PDF manually below.`,
              );
              return;
            }
            if (data.opportunity) setOpportunity(data.opportunity);
            if (data.structured) setStructured(data.structured);
            setPrefillBanner(`Loaded ${title ?? "opportunity"} — NOFO extracted from ${new URL(nofoUrl).hostname}.`);
          } catch (err) {
            setPrefillBanner(
              `NOFO auto-fetch error: ${err instanceof Error ? err.message : String(err)}. Upload manually below.`,
            );
          } finally {
            setFetchingNofo(false);
          }
        })();
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [initialDraft, searchParams]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function uploadNofo(file: File) {
    setUploadingNofo(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/nofo/upload", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as {
        opportunity?: string;
        structured?: ExtractedNofo;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(`Upload failed (${res.status}): ${data.error ?? data.message ?? "unknown"}`);
        return;
      }
      if (data.opportunity) setOpportunity(data.opportunity);
      if (data.structured) setStructured(data.structured);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingNofo(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const streamSection = useCallback(
    async (section: SectionKey, instruction?: string) => {
      setRunning(section);
      setError(null);
      setMeta(null);
      setUsage(null);
      setElapsedMs(null);
      const started = Date.now();
      setSections((prev) => ({ ...prev, [section]: "" }));
      try {
        const otherSections: Partial<SectionMap> = {};
        for (const k of Object.keys(sections) as SectionKey[]) {
          if (k !== section && sections[k]) otherSections[k] = sections[k];
        }
        const res = await fetch("/api/draft/section", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            business,
            naics,
            opportunity,
            blocks: Array.from(selected),
            section,
            instruction,
            otherSections,
            model: perSectionModel[section] === "opus" ? "claude-opus-4-7" : "claude-sonnet-4-6",
          }),
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          setError(`Section regen failed (${res.status}): ${text || res.statusText}`);
          return;
        }
        let acc = "";
        await consumeSse(res.body, {
          onMeta: (m) => setMeta(m as StreamMeta),
          onDelta: (text) => {
            acc += text;
            const split = splitFullDraft(acc);
            const body = split[section] || acc;
            setSections((prev) => ({ ...prev, [section]: body }));
          },
          onDone: (payload) => {
            setUsage((payload.usage as never) ?? null);
            setElapsedMs(Date.now() - started);
            const finalSplit = splitFullDraft(acc);
            // Fallback heading-strip: only remove the first `## …` line when it
            // is SHORT enough to be a pure title. The previous `^##\s+.*$`
            // swallowed the whole line — when the model put its opening
            // sentence on the heading line, the first sentence of the section
            // silently vanished (live-preview bug, PENDING watch-item #13).
            const body = finalSplit[section] || acc.replace(/^##\s+[^\n]{0,60}$/m, "").trim();
            setSections((prev) => ({ ...prev, [section]: body }));
          },
          onError: (m) => setError(m),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(null);
      }
    },
    [business, naics, opportunity, selected, sections, perSectionModel],
  );

  const autoDraft = useCallback(async () => {
    // A3 orchestrator: section-by-section streaming with persistent draft id.
    // On done, jump to /drafts/[id] so the writer can keep editing in the
    // dedicated draft view. Partner capabilities are auto-injected server-side.
    setRunning("all");
    setError(null);
    setMeta(null);
    setUsage(null);
    setElapsedMs(null);
    setSections(emptySections());
    const started = Date.now();
    try {
      const res = await fetch("/api/draft/auto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business,
          naics,
          opportunity,
          blocks: Array.from(selected),
        }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setError(`Request failed (${res.status}): ${text || res.statusText}`);
        return;
      }
      const liveSections: SectionMap = emptySections();
      let currentSection: SectionKey | null = null;
      let finalDraftId: string | null = null;
      await consumeSse(res.body, {
        onMeta: (m) => setMeta(m as StreamMeta),
        onEvent: (event, payload) => {
          if (event === "section:start") {
            currentSection = (payload.section as SectionKey) ?? null;
            if (currentSection) liveSections[currentSection] = "";
            setSections({ ...liveSections });
          } else if (event === "section:delta") {
            const k = (payload.section as SectionKey) ?? currentSection;
            const t = String(payload.text ?? "");
            if (k) {
              liveSections[k] = (liveSections[k] ?? "") + t;
              setSections({ ...liveSections });
            }
          } else if (event === "done") {
            finalDraftId = typeof payload.draft_id === "string" ? payload.draft_id : null;
            setElapsedMs(Date.now() - started);
          } else if (event === "error") {
            setError(String(payload.message ?? "Stream error"));
          } else if (event === "aborted") {
            setError("Aborted.");
          }
        },
      });
      if (finalDraftId) {
        setDraftId(finalDraftId);
        // Jump to the saved draft view so the writer can iterate. The
        // orchestrator already persists everything server-side.
        window.location.href = `/drafts/${finalDraftId}`;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  }, [business, naics, opportunity, selected]);

  const draftAll = useCallback(async () => {
    setRunning("all");
    setError(null);
    setMeta(null);
    setUsage(null);
    setElapsedMs(null);
    setSections(emptySections());
    const started = Date.now();
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business,
          naics,
          opportunity,
          blocks: Array.from(selected),
        }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setError(`Request failed (${res.status}): ${text || res.statusText}`);
        return;
      }
      let acc = "";
      await consumeSse(res.body, {
        onMeta: (m) => setMeta(m as StreamMeta),
        onDelta: (text) => {
          acc += text;
          setSections(splitFullDraft(acc));
        },
        onDone: (payload) => {
          setUsage((payload.usage as never) ?? null);
          setElapsedMs(Date.now() - started);
          setSections(splitFullDraft(acc));
        },
        onError: (m) => setError(m),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  }, [business, naics, opportunity, selected]);

  const saveDraft = useCallback(
    async (kind: "full" | "section" | null = null, sectionKey?: SectionKey, instruction?: string) => {
      const hasContent = Object.values(sections).some((v) => v.trim().length > 0);
      if (!hasContent) return;
      setSavingDraft(true);
      try {
        const body: Record<string, unknown> = {
          id: draftId ?? undefined,
          title: draftTitle || undefined,
          business,
          naics,
          opportunity,
          blocks: Array.from(selected),
          structured,
          sections,
        };
        if (kind && sectionKey !== undefined) {
          body.version = {
            kind,
            section: kind === "section" ? sectionKey : null,
            instruction: instruction ?? null,
            text: kind === "section" ? sections[sectionKey] : joinSections(sections),
          };
        } else if (kind === "full") {
          body.version = { kind: "full", section: null, instruction: null, text: joinSections(sections) };
        }
        const res = await fetch("/api/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as {
          draft?: { id: string; title: string };
          error?: string;
        };
        if (!res.ok) {
          setError(`Save failed (${res.status}): ${data.error ?? "unknown"}`);
          return;
        }
        if (data.draft) {
          setDraftId(data.draft.id);
          setDraftTitle(data.draft.title);
          setSavedAt(Date.now());
          lastSavedSnapshot.current = JSON.stringify({ sections, business, naics, opportunity });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingDraft(false);
      }
    },
    [business, draftId, draftTitle, naics, opportunity, sections, selected, structured],
  );

  useEffect(() => {
    if (running) return;
    const snapshot = JSON.stringify({ sections, business, naics, opportunity });
    if (snapshot === lastSavedSnapshot.current) return;
    const hasContent = Object.values(sections).some((v) => v.trim().length > 0);
    if (!hasContent) return;
    const t = setTimeout(() => {
      void saveDraft();
    }, 1500);
    return () => clearTimeout(t);
  }, [sections, business, naics, opportunity, running, saveDraft]);

  function copyAll() {
    const all = joinSections(sections);
    if (!all) return;
    void navigator.clipboard.writeText(all).catch(() => {});
  }

  const noOutputYet = filledSectionCount === 0 && !running;

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-6 py-6">
      <AppHeader
        tagline="Proposal Drafting Workbench"
        title={opportunityTitle ?? <span className="text-white/40">No opportunity loaded</span>}
        subtitle={
          <>
            <span className="font-medium text-white/80">{businessName}</span>
            <span className="mx-1.5 text-white/30">·</span>
            {selectedCount} of {blocks.length} capability blocks selected
            {meta?.model ? (
              <>
                <span className="mx-1.5 text-white/30">·</span>
                <span className="font-mono text-[11px]">{meta.model}</span>
              </>
            ) : null}
          </>
        }
        userLabel={user.name}
        activeNav="workbench"
        leadingActions={<StatusPill status={status} />}
        trailingActions={
          <button
            onClick={logout}
            className={`${APP_HEADER_NAV_BASE} ${APP_HEADER_NAV_MUTED}`}
          >
            Sign out
          </button>
        }
      />

      {prefillBanner && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <div className="flex items-center gap-2">
            {fetchingNofo && <Spinner />}
            <span>{prefillBanner}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[440px_1fr]">
        <section className="space-y-6">
          <Panel
            step={1}
            title="Load the opportunity"
            description="Upload a NOFO/RFP PDF or paste the solicitation text. We'll extract the agency, funding range, key dates, and required sections."
          >
            <div>
              <div className="flex items-center justify-between">
                <label className={LABEL}>NOFO upload</label>
                {uploadingNofo && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                    <Spinner /> Extracting…
                  </span>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadNofo(f);
                }}
                disabled={uploadingNofo}
                className="mt-1.5 block w-full cursor-pointer rounded-lg border border-dashed border-stone-300 bg-stone-50 p-2 text-xs text-stone-700 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className={HELP_TEXT}>PDF, DOCX, or TXT up to 25 MB. Populates the textarea below + the extracted-fields panel.</p>
            </div>

            <div className="mt-5">
              <label className={LABEL}>
                Target opportunity
              </label>
              <p className={HELP_TEXT}>Paste the full NOFO summary, eligibility, and evaluation criteria — or upload a PDF above.</p>
              <textarea
                value={opportunity}
                onChange={(e) => setOpportunity(e.target.value)}
                rows={9}
                placeholder="e.g., Example Agency Community Health Program — funding floor $1M / ceiling $2M, LOI due 2027-01-15, full proposal 2027-03-01…"
                className={`mt-2 block w-full ${INPUT_BASE} text-sm leading-6`}
              />
            </div>

            {structured && (
              <details className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3" open>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-emerald-700">
                  Extracted NOFO fields (editable)
                </summary>
                <div className="mt-3 space-y-3 text-xs">
                  <ExtractedField label="Agency" value={structured.agency} onChange={(v) => updateStructured("agency", v)} />
                  <ExtractedField label="Program" value={structured.program} onChange={(v) => updateStructured("program", v)} />
                  <div className="grid grid-cols-2 gap-2">
                    <ExtractedField label="Funding floor" value={structured.funding_floor} onChange={(v) => updateStructured("funding_floor", v)} />
                    <ExtractedField label="Funding ceiling" value={structured.funding_ceiling} onChange={(v) => updateStructured("funding_ceiling", v)} />
                  </div>
                  <ExtractedField label="Period of performance" value={structured.period_of_performance} onChange={(v) => updateStructured("period_of_performance", v)} />
                  <ExtractedField label="Eligibility" value={structured.eligibility} onChange={(v) => updateStructured("eligibility", v)} multi />
                  <div className="grid grid-cols-3 gap-2">
                    <ExtractedField label="LOI" value={structured.key_dates?.loi} onChange={(v) => updateKeyDates("loi", v)} />
                    <ExtractedField label="Proposal" value={structured.key_dates?.full_proposal} onChange={(v) => updateKeyDates("full_proposal", v)} />
                    <ExtractedField label="Award" value={structured.key_dates?.award} onChange={(v) => updateKeyDates("award", v)} />
                  </div>
                  <ExtractedField label="Evaluation criteria" value={structured.evaluation_criteria} onChange={(v) => updateStructured("evaluation_criteria", v)} multi />
                  <ExtractedField label="Page limits" value={structured.page_limits} onChange={(v) => updateStructured("page_limits", v)} />
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Required sections</label>
                    <textarea
                      value={(structured.required_sections ?? []).join("\n")}
                      onChange={(e) =>
                        setStructured((s) => ({
                          ...(s ?? {}),
                          required_sections: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
                        }))
                      }
                      rows={3}
                      className={`mt-1 block w-full ${INPUT_BASE} text-xs`}
                    />
                  </div>
                  <ExtractedField label="Summary" value={structured.summary} onChange={(v) => updateStructured("summary", v)} multi />
                </div>
              </details>
            )}
          </Panel>

          <Panel
            step={2}
            title="Pick the capability blocks"
            description="Each block is a reusable chunk of Acme Consulting past performance, methodology, or differentiators — they get woven into every section. Blocks live as markdown files in data/blocks/ (14 seeded: org overview, bios, rates, partner roster…). To add one, drop a new .md there or ask your build agent; the versioned text library lives under Boilerplate."
          >
            <div className="flex items-center justify-between">
              <label className={LABEL}>
                Capability blocks ({selectedCount}/{blocks.length})
              </label>
              <div className="flex gap-3 text-xs font-medium">
                <button onClick={() => setSelected(new Set(blocks.map((b) => b.id)))} className="text-emerald-700 hover:underline">
                  Select all
                </button>
                <button onClick={() => setSelected(new Set())} className="text-stone-500 hover:underline">
                  Clear
                </button>
              </div>
            </div>
            <div className="gs-scroll mt-2 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-stone-200 bg-white p-2">
              {blocks.map((b) => (
                <label
                  key={b.id}
                  className="flex cursor-pointer items-start gap-2 rounded-md p-2 transition hover:bg-stone-100"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(b.id)}
                    onChange={() => toggle(b.id)}
                    className="mt-1 h-4 w-4 cursor-pointer accent-emerald-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-stone-900">{b.title}</span>
                    <span className="block text-[11px] leading-5 text-stone-500">{b.summary}</span>
                  </span>
                </label>
              ))}
            </div>
          </Panel>

          <Panel
            step={3}
            title="Tune the business profile"
            description="Identity, certifications, and NAICS codes the model anchors to. These persist locally so you don't have to re-enter them."
            collapsible
            defaultOpen={false}
          >
            <div>
              <label className={LABEL}>Business profile</label>
              <textarea
                value={business}
                onChange={(e) => setBusiness(e.target.value)}
                rows={9}
                className={`mt-1.5 block w-full ${INPUT_BASE} font-mono text-xs leading-5`}
              />
            </div>
            <div className="mt-4">
              <label className={LABEL}>NAICS codes</label>
              <textarea
                value={naics}
                onChange={(e) => setNaics(e.target.value)}
                rows={2}
                className={`mt-1.5 block w-full ${INPUT_BASE} font-mono text-xs leading-5`}
              />
            </div>
          </Panel>

          <button onClick={draftAll} disabled={!canDraftAll} className={`w-full ${PRIMARY_BTN} text-base`}>
            {running === "all" ? (
              <span className="inline-flex items-center justify-center gap-2"><Spinner light /> Drafting all sections…</span>
            ) : (
              "Draft full proposal →"
            )}
          </button>
          <button
            onClick={autoDraft}
            disabled={!canDraftAll}
            className={`w-full rounded-lg border border-emerald-600 bg-white px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-stone-300 disabled:text-stone-400`}
            title="Run the A3 orchestrator: per-section streaming + partner capabilities auto-injected. Jumps to the saved draft when done."
          >
            {running === "all" ? "Auto-drafting…" : "⚡ Auto-draft (orchestrator + partners) →"}
          </button>
          <p className="text-center text-xs text-stone-500">
            Each of the {SECTIONS.length} sections streams in independently — regenerate any one without touching the others.
          </p>

          {error && (
            <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs leading-5 text-red-800">
              <strong className="font-semibold">Something went wrong.</strong> {error}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-semibold text-stone-800">Output</span>
              <span className="text-stone-300">·</span>
              <span>{filledSectionCount}/{SECTIONS.length} sections</span>
              <span className="text-stone-300">·</span>
              <span>{totalWords.toLocaleString()} words</span>
              {meta?.blocksLoaded?.length ? (
                <>
                  <span className="text-stone-300">·</span>
                  <span>{meta.blocksLoaded.length} blocks loaded</span>
                </>
              ) : null}
              {elapsedMs !== null ? (
                <>
                  <span className="text-stone-300">·</span>
                  <span>{(elapsedMs / 1000).toFixed(1)}s</span>
                </>
              ) : null}
              {usage?.output_tokens ? (
                <>
                  <span className="text-stone-300">·</span>
                  <span>{usage.output_tokens.toLocaleString()} out tokens</span>
                </>
              ) : null}
              {savedAt ? (
                <>
                  <span className="text-stone-300">·</span>
                  <span className="text-emerald-700">saved {new Date(savedAt).toLocaleTimeString()}</span>
                </>
              ) : null}
              {savingDraft ? (
                <>
                  <span className="text-stone-300">·</span>
                  <span className="inline-flex items-center gap-1 text-emerald-700"><Spinner /> saving…</span>
                </>
              ) : null}
            </span>
            <div className="flex items-center gap-2">
              {draftId && (
                <a href={`/api/drafts/${draftId}/docx`} className={SECONDARY_BTN}>
                  Export .docx
                </a>
              )}
              <button onClick={copyAll} className={SECONDARY_BTN} disabled={!Object.values(sections).some((v) => v.trim())}>
                Copy all
              </button>
            </div>
          </div>

          {noOutputYet ? (
            <EmptyState hasOpportunity={opportunity.trim().length > 0} hasBlocks={selectedCount > 0} />
          ) : null}

          {SECTIONS.map((s) => (
            <SectionCard
              key={s.key}
              sectionKey={s.key}
              title={s.title}
              description={s.description}
              body={sections[s.key]}
              instruction={perSectionInstr[s.key]}
              onInstruction={(v) => setPerSectionInstr((p) => ({ ...p, [s.key]: v }))}
              model={perSectionModel[s.key]}
              onModel={(v) => setPerSectionModel((p) => ({ ...p, [s.key]: v }))}
              onChange={(v) => setSections((prev) => ({ ...prev, [s.key]: v }))}
              onRegenerate={() => streamSection(s.key, perSectionInstr[s.key] || undefined)}
              onPromote={draftId ? (t, b) => promoteToWorkingDraft(s.key, t, b) : undefined}
              running={running === s.key}
              streamingFull={running === "all"}
              disabled={!opportunity.trim() || !!running}
            />
          ))}
        </section>
      </div>
    </div>
  );

  async function promoteToWorkingDraft(sectionKey: SectionKey, title: string, body: string) {
    if (!draftId) return;
    const res = await fetch(`/api/drafts/${draftId}/working-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        bodyMarkdown: body,
        sourceKind: "section",
        sourceRef: sectionKey,
      }),
    });
    if (res.ok) {
      window.dispatchEvent(new CustomEvent(WORKING_DRAFT_EVENT));
    }
  }

  function updateStructured<K extends keyof ExtractedNofo>(key: K, value: string) {
    setStructured((s) => ({ ...(s ?? {}), [key]: value || undefined }));
  }
  function updateKeyDates(key: "loi" | "full_proposal" | "award" | "other", value: string) {
    setStructured((s) => ({
      ...(s ?? {}),
      key_dates: { ...(s?.key_dates ?? {}), [key]: value || undefined },
    }));
  }
}

function Panel({
  step,
  title,
  description,
  children,
  collapsible,
  defaultOpen,
}: {
  step?: number;
  title: string;
  description?: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  const Heading = (
    <div className="flex items-center gap-2">
      {step !== undefined && (
        <span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white">
          {step}
        </span>
      )}
      <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
    </div>
  );
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      {collapsible ? (
        <button
          onClick={() => setOpen((x) => !x)}
          className="flex w-full items-center justify-between text-left"
          aria-expanded={open}
        >
          {Heading}
          <span className="text-xs text-stone-500">{open ? "Hide" : "Edit"}</span>
        </button>
      ) : (
        Heading
      )}
      {description && <p className="mt-1 text-xs leading-5 text-stone-500">{description}</p>}
      {(open || !collapsible) && <div className="mt-3">{children}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: { tone: "idle" | "active" | "done" | "error"; label: string; sub?: string } }) {
  const styles =
    status.tone === "idle"
      ? "border-stone-300 bg-stone-100 text-stone-700"
      : status.tone === "active"
        ? "border-emerald-300 bg-emerald-50 text-emerald-800"
        : status.tone === "done"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-red-300 bg-red-50 text-red-700";
  return (
    <span
      className={`inline-flex max-w-[28rem] items-center gap-1.5 truncate rounded-full border px-2.5 py-1 text-xs font-medium ${styles}`}
      title={status.sub ?? status.label}
    >
      {status.tone === "active" ? <Spinner /> : <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
      <span className="truncate">{status.label}</span>
    </span>
  );
}

function EmptyState({ hasOpportunity, hasBlocks }: { hasOpportunity: boolean; hasBlocks: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-700">
      <h3 className="text-base font-semibold text-stone-900">Get started in three steps</h3>
      <ol className="mt-3 space-y-2.5">
        <Step n={1} done={hasOpportunity} label="Load the opportunity" detail="Upload the NOFO PDF or paste the solicitation text." />
        <Step n={2} done={hasBlocks} label="Pick capability blocks" detail="Choose the past-performance and methodology chunks that fit this scope." />
        <Step n={3} done={false} label="Draft the proposal" detail="Hit Draft full proposal — or generate any single section first." />
      </ol>
      <p className="mt-4 text-xs leading-5 text-stone-500">
        Each section streams independently. You can regenerate any one with extra instructions (&ldquo;tighter, lean on Acme Consulting past performance&rdquo;) without touching the others. Drafts auto-save and live in <strong className="font-semibold text-stone-700">Drafts</strong> with full version history.
      </p>
    </div>
  );
}

function Step({ n, done, label, detail }: { n: number; done: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold ${done ? "bg-emerald-600 text-white" : "border border-stone-300 bg-white text-stone-600"}`}
      >
        {done ? "✓" : n}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-stone-900">{label}</span>
        <span className="block text-xs leading-5 text-stone-500">{detail}</span>
      </span>
    </li>
  );
}

function Spinner({ light }: { light?: boolean } = {}) {
  return (
    <span
      className={`inline-block h-3 w-3 flex-none animate-spin rounded-full border-2 ${light ? "border-white/40 border-t-white" : "border-current/30 border-t-current"}`}
      aria-hidden
    />
  );
}

function ExtractedField({
  label,
  value,
  onChange,
  multi,
}: {
  label: string;
  value?: string | null;
  onChange: (v: string) => void;
  multi?: boolean;
}) {
  return (
    <div>
      <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">{label}</label>
      {multi ? (
        <textarea
          value={value ?? ""}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
          className={`mt-1 block w-full ${INPUT_BASE} text-xs leading-5`}
        />
      ) : (
        <input
          type="text"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className={`mt-1 block w-full ${INPUT_BASE} text-xs`}
        />
      )}
    </div>
  );
}

function SectionCard({
  sectionKey,
  title,
  description,
  body,
  instruction,
  onInstruction,
  model,
  onModel,
  onChange,
  onRegenerate,
  onPromote,
  running,
  streamingFull,
  disabled,
}: {
  sectionKey: SectionKey;
  title: string;
  description: string;
  body: string;
  instruction: string;
  onInstruction: (v: string) => void;
  model: "sonnet" | "opus";
  onModel: (v: "sonnet" | "opus") => void;
  onChange: (v: string) => void;
  onRegenerate: () => void;
  onPromote?: (title: string, body: string) => void | Promise<void>;
  running: boolean;
  streamingFull: boolean;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [promoting, setPromoting] = useState(false);
  const wc = wordCount(body);
  const cc = body.length;
  function copy() {
    if (!body) return;
    void navigator.clipboard.writeText(body).catch(() => {});
  }
  async function promote() {
    if (!onPromote || !body.trim() || promoting) return;
    setPromoting(true);
    try {
      await onPromote(title, body);
    } finally {
      setPromoting(false);
    }
  }
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
      {/* Not sticky: the page chrome is ~128px and this header is ~114px —
          pinning both overlaid a third of the viewport and the stale 88px
          offset clipped card content underneath the chrome. */}
      <div className="border-b border-stone-200 bg-white px-4 py-3">
        {/* Two stable rows: title+description get the full width (a single
            shared flex row crushed the title column to ~100px next to the
            ~600px control cluster — the description wrapped one word per
            line), controls sit below with a fluid instruction input. */}
        <div className="flex flex-col gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setExpanded((x) => !x)}
                className="text-stone-500 transition hover:text-stone-900"
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? "▾" : "▸"}
              </button>
              <h3 className="text-sm font-semibold text-stone-900">{title}</h3>
              {running && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                  <Spinner /> Streaming
                </span>
              )}
              {!running && body && (
                <span className="text-[11px] text-stone-500">
                  {wc} words · {cc.toLocaleString()} chars
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs leading-5 text-stone-500">{description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={instruction}
              onChange={(e) => onInstruction(e.target.value)}
              placeholder='Optional: "tighter, lean on Acme Consulting past performance"'
              className={`min-w-44 flex-1 sm:max-w-md ${INPUT_BASE} px-2.5 py-1.5 text-xs`}
            />
            <select
              value={model}
              onChange={(e) => onModel(e.target.value as "sonnet" | "opus")}
              disabled={running || disabled}
              title={
                model === "opus"
                  ? "Opus 4.7 — slowest + deepest reasoning"
                  : "Sonnet 4.6 — fast default for iterative editing"
              }
              className={`${INPUT_BASE} px-2 py-1 text-xs`}
            >
              <option value="sonnet">Sonnet 4.6</option>
              <option value="opus">Opus 4.7</option>
            </select>
            <button onClick={copy} disabled={!body} className={SECONDARY_BTN}>
              Copy
            </button>
            {onPromote && (
              <button
                onClick={() => void promote()}
                disabled={!body.trim() || promoting}
                title="Add this section as a block in the Working Draft pane"
                className={SECONDARY_BTN}
              >
                {promoting ? "Adding…" : "→ Working Draft"}
              </button>
            )}
            <button onClick={onRegenerate} disabled={disabled} className={ACCENT_BTN}>
              {running ? "Regenerating…" : body ? "Regenerate" : "Generate"}
            </button>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="p-4">
          {running && !body ? (
            <SectionSkeleton />
          ) : !body && !streamingFull ? (
            <SectionEmptyState
              sectionKey={sectionKey}
              disabled={disabled}
              onGenerate={onRegenerate}
            />
          ) : (
            <textarea
              value={body}
              onChange={(e) => onChange(e.target.value)}
              rows={Math.max(8, Math.min(28, Math.ceil(body.length / 80)))}
              placeholder="Section text will stream in here. You can edit it freely afterwards."
              className={`block w-full resize-y ${INPUT_BASE} bg-stone-50 p-4 font-serif text-[15px] leading-7 text-stone-900`}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SectionEmptyState({
  sectionKey,
  disabled,
  onGenerate,
}: {
  sectionKey: SectionKey;
  disabled: boolean;
  onGenerate: () => void;
}) {
  const hint =
    sectionKey === "reviewer_notes"
      ? "Reviewer notes are best generated last — after the four narrative sections — so the model can flag gaps and missing evaluation-criteria coverage."
      : "Click Generate to draft this section in isolation, or use Draft full proposal to stream all five.";
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-600">
      <p className="leading-6">{hint}</p>
      <button onClick={onGenerate} disabled={disabled} className={ACCENT_BTN}>
        Generate this section
      </button>
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="space-y-2.5 p-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-stone-200"
          style={{ width: `${60 + ((i * 13) % 35)}%` }}
        />
      ))}
    </div>
  );
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onMeta?: (data: unknown) => void;
    onDelta?: (text: string) => void;
    onDone?: (data: { usage?: unknown; stop_reason?: unknown }) => void;
    onError?: (message: string) => void;
    // Catch-all for events the named handlers above don't cover (e.g. the A3
    // orchestrator's section:start / section:delta / section:done). Fires for
    // every event including the named ones, so callers can opt into either
    // shape — handlers stay backward-compatible.
    onEvent?: (event: string, payload: Record<string, unknown>) => void;
  },
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        if (event === "delta") handlers.onDelta?.(payload.text);
        else if (event === "meta") handlers.onMeta?.(payload);
        else if (event === "done") handlers.onDone?.(payload);
        else if (event === "error") handlers.onError?.(payload.message ?? "Stream error");
        handlers.onEvent?.(event, payload);
      } catch {
        // ignore
      }
    }
  }
}

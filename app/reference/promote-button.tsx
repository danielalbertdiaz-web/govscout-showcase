"use client";

// P5 — promote a reference org (non-profit / winner) onto the partner roster.
// Creates the partner via the hardened POST /api/partners; nothing external.

import { useState } from "react";

type Props = {
  name: string;
  note?: string | null;
  focusAreas?: string[];
  sourceUrl?: string | null;
};

export function PromoteToPartnerButton({ name, note, focusAreas, sourceUrl }: Props) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  async function promote() {
    if (state === "busy" || state === "done") return;
    setState("busy");
    try {
      const res = await fetch("/api/partners", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          type: "community_partner",
          status: "active",
          description: note ?? `Promoted from Reference${sourceUrl ? ` (${sourceUrl})` : ""}.`,
          capabilities: (focusAreas ?? []).map((f) => f.toLowerCase().replace(/[^a-z0-9]+/g, "_")),
          body: [
            `# ${name}`,
            "",
            note ?? "",
            sourceUrl ? `\nSource: ${sourceUrl}` : "",
            "\n_Promoted from the Reference library — enrich via Add partner → URL ingest._",
          ].join("\n"),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("done");
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void promote()}
      disabled={state === "busy" || state === "done"}
      title="Copy this organization onto the partner roster"
      className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold transition ${
        state === "done"
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : state === "error"
            ? "border-rose-300 bg-rose-50 text-rose-700"
            : "border-stone-300 bg-white text-stone-600 hover:border-emerald-400 hover:text-emerald-700"
      }`}
    >
      {state === "done" ? "✓ On roster" : state === "busy" ? "Promoting…" : state === "error" ? "Failed" : "→ Partner"}
    </button>
  );
}

// P2/P9 — POST /api/scouts/run-all: the on-demand discovery rail, profile-
// driven. Every lane runs once per enabled scout profile (behavioral health ·
// tech/Atlas Insights · awareness/Brightline). Same lanes as scripts/run-all-scans.mts (the
// daily launchd rail); one lane failing never blocks the rest.

import { getSession } from "@/lib/auth";
import { allEnabledProfiles } from "@/lib/custom-scouts";
import { runFoundationScan } from "@/lib/foundation-scan";
import { runTeamingScan } from "@/lib/teaming-scan";
import { runUnderspendScan } from "@/lib/underspend-scan";
import { runSettlementScan } from "@/lib/settlement-scan";

export const runtime = "nodejs";
export const maxDuration = 300;

type LaneSummary = { lane: string; ok: boolean; detail: string };

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const owner = session.email;

  const lanes: LaneSummary[] = [];
  async function lane(name: string, fn: () => Promise<string>) {
    try {
      lanes.push({ lane: name, ok: true, detail: await fn() });
    } catch (err) {
      lanes.push({ lane: name, ok: false, detail: err instanceof Error ? err.message.slice(0, 140) : String(err) });
    }
  }

  for (const p of allEnabledProfiles()) {
    await lane(`${p.label} — foundations`, async () => {
      const r = await runFoundationScan(owner, {
        keywords: p.keywords,
        themes: p.themes.length ? p.themes : undefined,
      });
      return `${r.newItems} new items`;
    });
    await lane(`${p.label} — teaming`, async () => {
      const r = await runTeamingScan(owner, { naics: p.naics });
      return `${r.persisted} notices`;
    });
    await lane(`${p.label} — unspent balances`, async () => {
      const r = await runUnderspendScan(owner, { keywords: p.keywords });
      return `${r.created + r.updated} pools`;
    });
  }
  await lane("Settlement boards", async () => {
    const r = (await runSettlementScan(owner)) as { ok?: boolean; newItems?: number };
    return r.ok === false ? "source capped/unavailable this run" : `${r.newItems ?? 0} new items`;
  });

  return Response.json({ ok: true, lanes });
}

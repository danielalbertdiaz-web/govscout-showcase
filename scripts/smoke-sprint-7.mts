/**
 * Sprint 7 smoke test — exercises tryAutoDraft against in-memory fixtures.
 *
 * Verifies:
 *   1. Score ≥ threshold creates draft + log + suggestion
 *   2. Idempotency: re-firing skips with already_exists
 *   3. Memory guard: opp containing banned name → blocked_memory_guard
 *   4. Deadline-passed → skipped reason=deadline_passed
 *   5. Rate limit: 4 distinct opps in window → 4th queued
 *   6. Kill switch via setting → skipped reason=auto_draft_disabled
 *   7. Score-drop watcher: re-score below threshold flags the draft
 *   8. Queue release path produces a new draft
 *
 * Uses the real SQLite at data/govscout.db — creates throwaway test rows
 * scoped to a synthetic user email so it doesn't pollute the operator's state.
 */

import { randomUUID } from "crypto";
import {
  getDb,
  saveOpportunity,
  setOpportunityStrategicScore,
  getDraft,
} from "../lib/db";
import {
  tryAutoDraft,
  setSetting,
  getAutoDraftEnabled,
  getAutoDraftThreshold,
  listAutoDraftLog,
  listAutoDraftQueue,
  releaseQueuedAutoDraft,
  watchScoreDrop,
} from "../lib/auto-draft";
import { seedBoilerplate } from "../lib/boilerplate";

const TEST_USER = `sprint7-smoke+${Date.now()}@acmeconsulting.test`;

function bar(s: string): void {
  process.stdout.write(`\n=== ${s} ===\n`);
}

function ok(label: string, cond: boolean, extra?: string): void {
  const tag = cond ? "PASS" : "FAIL";
  process.stdout.write(`  [${tag}] ${label}${extra ? ` — ${extra}` : ""}\n`);
  if (!cond) process.exitCode = 1;
}

async function createFixtureOpportunity(opts: {
  title: string;
  agency?: string;
  deadlineIsoDays?: number | null;
  summary?: string;
  naics?: string;
}): Promise<string> {
  const id = randomUUID();
  const deadline =
    opts.deadlineIsoDays == null
      ? null
      : new Date(Date.now() + opts.deadlineIsoDays * 86_400_000).toISOString().slice(0, 10);
  saveOpportunity(TEST_USER, {
    source: "manual",
    sourceId: `smoke-${id}`,
    title: opts.title,
    agency: opts.agency ?? "SAMHSA",
    deadline,
    fundingFloor: null,
    fundingCeiling: null,
    eligibility: "8(a) set-aside; small business; MBE preferred",
    url: null,
    nofoUrl: null,
    summary: opts.summary ?? "Substance use disorder workforce expansion in Harbor County, NJ.",
    naics: opts.naics ?? "541611",
    notes: null,
  });
  // saveOpportunity returns the new record but uses its own id; look up the
  // most recent one for this user with this source_id.
  const row = getDb()
    .prepare(
      `SELECT id FROM saved_opportunities WHERE user_email = ? AND source_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(TEST_USER, `smoke-${id}`) as { id: string } | undefined;
  if (!row) throw new Error("fixture not persisted");
  return row.id;
}

async function main(): Promise<void> {
  // Touching the DB triggers migrations (including 016) inside getDb().
  getDb();
  bar("Sprint 7 — auto-draft trigger smoke");
  process.stdout.write(`User: ${TEST_USER}\n`);
  process.stdout.write(`Threshold: ${getAutoDraftThreshold()} · Enabled: ${getAutoDraftEnabled()}\n`);

  // Make sure boilerplate is seeded so composition works.
  seedBoilerplate("sprint7-smoke");

  // ---- T1: high score creates draft ----
  bar("T1 — score ≥ threshold creates auto-draft");
  const opp1Id = await createFixtureOpportunity({
    title: "SAMHSA SOR-IV: Harbor County SUD Workforce",
    deadlineIsoDays: 45,
  });
  setOpportunityStrategicScore(opp1Id, TEST_USER, 88, { recommendation: "pursue" });
  const r1 = await tryAutoDraft({
    kind: "saved_opportunity",
    sourceId: opp1Id,
    score: 88,
    userEmail: TEST_USER,
  });
  ok("outcome=created", r1.outcome === "created", `actual=${r1.outcome} reason=${r1.reason ?? "-"}`);
  ok("draftId present", !!r1.draftId);
  if (r1.draftId) {
    const d = getDraft(r1.draftId, TEST_USER);
    ok("draft persisted", !!d, d ? `title="${d.title}"` : "");
    ok("title has [AUTO]", d?.title.startsWith("[AUTO]") ?? false);
    ok(
      "meta.autoDrafted",
      Boolean(d?.meta && (d.meta as Record<string, unknown>).autoDrafted === true),
    );
    ok(
      "exec summary non-empty",
      (d?.sections.executive_summary?.length ?? 0) > 50,
    );
  }

  // ---- T2: idempotency ----
  bar("T2 — re-firing same opp at same score skips with already_exists");
  const r2 = await tryAutoDraft({
    kind: "saved_opportunity",
    sourceId: opp1Id,
    score: 88,
    userEmail: TEST_USER,
  });
  ok("outcome=skipped", r2.outcome === "skipped", `actual=${r2.outcome}`);
  ok("reason=already_exists", r2.reason === "already_exists");
  ok("draftId matches original", r2.draftId === r1.draftId);

  // ---- T3: deadline-passed ----
  bar("T3 — opp with deadline in the past → skipped");
  const opp3Id = await createFixtureOpportunity({
    title: "Expired NJDOH workforce RFP",
    deadlineIsoDays: -5,
  });
  const r3 = await tryAutoDraft({
    kind: "saved_opportunity",
    sourceId: opp3Id,
    score: 82,
    userEmail: TEST_USER,
  });
  ok("outcome=skipped", r3.outcome === "skipped");
  ok("reason=deadline_passed", r3.reason === "deadline_passed");

  // ---- T4: memory guard ----
  bar("T4 — opp summary mentioning banned name → blocked_memory_guard");
  const opp4Id = await createFixtureOpportunity({
    title: "Behavioral health expansion — call with Jane Barred",
    summary: "Coordinated with Jane Barred on outreach strategy.",
    deadlineIsoDays: 60,
  });
  const r4 = await tryAutoDraft({
    kind: "saved_opportunity",
    sourceId: opp4Id,
    score: 90,
    userEmail: TEST_USER,
  });
  ok("outcome=blocked_memory_guard", r4.outcome === "blocked_memory_guard", `actual=${r4.outcome}`);
  ok("draftId null on block", r4.draftId === null);

  // ---- T5: rate limit ----
  bar("T5 — 3-per-24h rate limit; 4th attempt queues");
  // T1 already counts as 1. Create 2 more successful then a 4th to test queueing.
  const opp5aId = await createFixtureOpportunity({ title: "HRSA workforce 2026-A", deadlineIsoDays: 40 });
  const opp5bId = await createFixtureOpportunity({ title: "BJA reentry 2026-B", deadlineIsoDays: 40 });
  const opp5cId = await createFixtureOpportunity({ title: "DOL workforce 2026-C", deadlineIsoDays: 40 });
  await tryAutoDraft({ kind: "saved_opportunity", sourceId: opp5aId, score: 85, userEmail: TEST_USER });
  await tryAutoDraft({ kind: "saved_opportunity", sourceId: opp5bId, score: 85, userEmail: TEST_USER });
  const r5 = await tryAutoDraft({ kind: "saved_opportunity", sourceId: opp5cId, score: 85, userEmail: TEST_USER });
  ok("4th outcome=queued", r5.outcome === "queued", `actual=${r5.outcome} reason=${r5.reason}`);
  const queue = listAutoDraftQueue({ userEmail: TEST_USER, openOnly: true });
  ok("queue has 1 open row", queue.length === 1, `actual=${queue.length}`);

  // ---- T6: kill switch ----
  bar("T6 — alfred_settings kill switch → skipped reason=auto_draft_disabled");
  setSetting("auto_draft:enabled", false);
  ok("getAutoDraftEnabled()=false", getAutoDraftEnabled() === false);
  const opp6Id = await createFixtureOpportunity({ title: "Kill-switch test opp", deadlineIsoDays: 40 });
  const r6 = await tryAutoDraft({
    kind: "saved_opportunity",
    sourceId: opp6Id,
    score: 95,
    userEmail: TEST_USER,
  });
  ok("outcome=skipped", r6.outcome === "skipped");
  ok("reason=auto_draft_disabled", r6.reason === "auto_draft_disabled");
  // restore
  setSetting("auto_draft:enabled", true);

  // ---- T7: score-drop watcher ----
  bar("T7 — re-score original opp below threshold → score_dropped flag on existing draft");
  if (r1.draftId) {
    watchScoreDrop({
      kind: "saved_opportunity",
      sourceId: opp1Id,
      newScore: 60,
      userEmail: TEST_USER,
    });
    const d = getDraft(r1.draftId, TEST_USER);
    const flags = (d?.meta?.flags as Record<string, unknown> | undefined) ?? {};
    ok("flag present", !!flags.score_dropped_after_autodraft);
  }

  // ---- T8: queue release ----
  bar("T8 — release queued auto-draft");
  if (queue[0]) {
    const released = await releaseQueuedAutoDraft(queue[0].id, TEST_USER);
    ok("release outcome=created", released.outcome === "created", `actual=${released.outcome}`);
    ok("release draftId present", !!released.draftId);
    const requeue = listAutoDraftQueue({ userEmail: TEST_USER, openOnly: true });
    ok(
      "open queue now empty",
      requeue.length === 0,
      `actual=${requeue.length} still open`,
    );
  }

  // ---- summary ----
  bar("Log summary");
  const log = listAutoDraftLog({ userEmail: TEST_USER, limit: 50 });
  for (const row of log) {
    process.stdout.write(
      `  ${row.outcome.padEnd(22)} ${row.opportunityKey.padEnd(50)} score=${row.score} reason=${row.reason ?? "-"}\n`,
    );
  }

  // ---- cleanup ----
  // Leave the rows in the DB for inspection; smoke is one-shot per timestamp.
  process.stdout.write(`\nExit code: ${process.exitCode ?? 0}\n`);
}

main().catch((err) => {
  process.stderr.write(`smoke failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 2;
});

// Federal Pipeline (Bid Board) state store — round-trip tests against a fresh
// temp DB. lib/db.ts roots the SQLite file at process.cwd()/data, and node:test
// runs each file in its own process, so chdir-ing to a mkdtemp dir BEFORE the
// dynamic import gives us an isolated database with migrations applied.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let fp: typeof import("../lib/federal-pipeline");
let dbmod: typeof import("../lib/db");

before(async () => {
  // lib/db.ts resolves BOTH the sqlite file and the migrations dir from
  // process.cwd(), so the temp cwd needs a lib/migrations for the fp tables
  // to exist. Symlink the real one in before first import.
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fp-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  fp = await import("../lib/federal-pipeline");
  dbmod = await import("../lib/db");
});

describe("upsertFpOpportunity", () => {
  it("creates, then dedupes on notice_id", () => {
    const a = fp.upsertFpOpportunity({ clientId: "el",
      title: "NASA AI Tech Support",
      solNumber: "80NSSC26935917Q-R1",
      noticeId: "abc123",
      tier: "micro",
      priceQuoted: 55000,
    });
    assert.equal(a.created, true);
    const b = fp.upsertFpOpportunity({ clientId: "el",
      title: "NASA AI Tech Support (amended)",
      noticeId: "abc123",
    });
    assert.equal(b.created, false);
    assert.equal(b.opp.id, a.opp.id);
    assert.equal(b.opp.title, "NASA AI Tech Support (amended)");
    // absent fields survive the update (preserve-on-upsert)
    assert.equal(b.opp.priceQuoted, 55000);
    assert.equal(b.opp.solNumber, "80NSSC26935917Q-R1");
  });

  it("stores description on create, updates it on re-ingest, preserves it when absent", () => {
    // Migration 044: before it, description was gate-detection-only and every
    // amount/fit narrative the Riverside cron found was discarded at ingest.
    const a = fp.upsertFpOpportunity({
      clientId: "riverside",
      title: "HIV Prevention Supplemental",
      noticeId: "cdc-hiv-26",
      description: "$1.1M CDC supplemental pool for innovative HIV prevention/diagnosis",
    });
    assert.equal(a.opp.description, "$1.1M CDC supplemental pool for innovative HIV prevention/diagnosis");
    // absent field survives a re-ingest (preserve-on-upsert)
    const b = fp.upsertFpOpportunity({ clientId: "riverside", title: "HIV Prevention Supplemental", noticeId: "cdc-hiv-26" });
    assert.equal(b.opp.description, "$1.1M CDC supplemental pool for innovative HIV prevention/diagnosis");
    // present field updates
    const c = fp.upsertFpOpportunity({
      clientId: "riverside",
      title: "HIV Prevention Supplemental",
      noticeId: "cdc-hiv-26",
      description: "$1.4M after amendment",
    });
    assert.equal(c.opp.description, "$1.4M after amendment");
  });

  it("falls back to sol_number dedupe when notice_id is absent", () => {
    const a = fp.upsertFpOpportunity({ clientId: "el", title: "USAF CGC", solNumber: "FA254926R0002" });
    const b = fp.upsertFpOpportunity({ clientId: "el", title: "USAF CGC v2", solNumber: "FA254926R0002" });
    assert.equal(b.created, false);
    assert.equal(b.opp.id, a.opp.id);
  });

  it("reopen watch: sets, no-ops on same state, clears, and logs the flips (migration 046)", () => {
    const a = fp.upsertFpOpportunity({ clientId: "riverside", title: "WIC Outreach FY26", noticeId: "wic-26" });
    assert.equal(a.opp.reopenWatchAt, null);
    const set = fp.setFpReopenWatch(a.opp.id, true, { by: "demo@test" });
    assert.equal(set.changed, true);
    assert.ok(set.opp.reopenWatchAt != null);
    // same-state set is a no-op — no event spam
    const again = fp.setFpReopenWatch(a.opp.id, true, { by: "demo@test" });
    assert.equal(again.changed, false);
    assert.equal(again.event, null);
    const cleared = fp.setFpReopenWatch(a.opp.id, false, { by: "demo@test" });
    assert.equal(cleared.opp.reopenWatchAt, null);
    // attribution is required
    assert.throws(() => fp.setFpReopenWatch(a.opp.id, true, { by: "  " }));
    // client scoping: wrong panel answers "no match", not a write
    assert.throws(() => fp.setFpReopenWatch(a.opp.id, true, { by: "x", clientId: "el" }));
  });

  it("rejects bad status / tier / missing title", () => {
    assert.throws(() => fp.upsertFpOpportunity({ clientId: "el", title: "x", status: "nope" as never }));
    assert.throws(() => fp.upsertFpOpportunity({ clientId: "el", title: "x", tier: "huge" as never }));
    assert.throws(() => fp.upsertFpOpportunity({ clientId: "el", title: "  " }));
  });
});

describe("findFpOpportunity", () => {
  it("resolves by id, notice_id, and sol_number", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "BOP Training",
      solNumber: "15F06726Q0000295",
      noticeId: "bop-notice-1",
    });
    assert.equal(fp.findFpOpportunity(opp.id)?.id, opp.id);
    assert.equal(fp.findFpOpportunity("bop-notice-1")?.id, opp.id);
    assert.equal(fp.findFpOpportunity("15F06726Q0000295")?.id, opp.id);
    assert.equal(fp.findFpOpportunity("does-not-exist"), null);
  });
});

describe("setFpStatus", () => {
  it("updates status and logs the matching event kind", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el", title: "Status walk", solNumber: "WALK-1" });
    const r1 = fp.setFpStatus("WALK-1", "drafting", "kickoff");
    assert.equal(r1.opp.status, "drafting");
    assert.equal(r1.event.kind, "draft_started");
    assert.equal(r1.event.detail?.note, "kickoff");
    const r2 = fp.setFpStatus("WALK-1", "submitted");
    assert.equal(r2.event.kind, "submitted");
    const events = fp.listFpEvents(opp.id);
    assert.deepEqual(events.map((e) => e.kind).sort(), ["draft_started", "submitted"]);
  });

  it("throws on unknown handle", () => {
    assert.throws(() => fp.setFpStatus("ghost", "drafting"));
  });
});

// The 2026-08-13 audit found 34 triage decisions vs 9 triage events: status
// writes that bypass setFpStatus (ingest inserts born past "discovered",
// forceReopen updates) left no trail. These pin the fix — the event is
// emitted at the write itself, inside upsertFpOpportunity.
describe("status events at the write (event-trail discipline)", () => {
  it("a row born with a non-discovered status gets that status's trail event", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Born triaged",
      solNumber: "BORN-TRIAGED-1",
      status: "triaged_nobid",
    });
    const kinds = fp.listFpEvents(opp.id).map((e) => e.kind);
    assert.ok(kinds.includes("triaged"), `expected a triaged event, got: ${kinds.join(",")}`);
    const ev = fp.listFpEvents(opp.id).find((e) => e.kind === "triaged")!;
    assert.equal(ev.detail?.to, "triaged_nobid");
    assert.equal(ev.detail?.via, "ingest");
  });

  it("a row born discovered gets NO status event from the lib (CLI owns 'discovered')", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el", title: "Born plain", solNumber: "BORN-PLAIN-1" });
    assert.equal(fp.listFpEvents(opp.id).length, 0);
  });

  it("an ingest status move on a discovered row logs the transition", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el", title: "Move me", solNumber: "MOVE-1" });
    fp.upsertFpOpportunity({ clientId: "el", title: "Move me", solNumber: "MOVE-1", status: "triaged_bid" });
    const ev = fp.listFpEvents(opp.id).find((e) => e.kind === "triaged");
    assert.ok(ev, "expected a triaged event from the ingest-path status change");
    assert.equal(ev!.detail?.from, "discovered");
    assert.equal(ev!.detail?.to, "triaged_bid");
  });

  it("a forceReopen status change logs the transition with forceReopen marked", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Reopen me",
      solNumber: "REOPEN-EV-1",
      status: "triaged_nobid",
    });
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Reopen me",
      solNumber: "REOPEN-EV-1",
      status: "discovered",
      forceReopen: true,
    });
    const ev = fp
      .listFpEvents(opp.id)
      .find((e) => e.kind === "discovered" && e.detail?.forceReopen === true);
    assert.ok(ev, "expected a forceReopen transition event");
    assert.equal(ev!.detail?.from, "triaged_nobid");
  });

  it("a blocked (reopen-guarded) status attempt logs nothing from the lib", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Guarded",
      solNumber: "GUARD-EV-1",
      status: "triaged_nobid",
    });
    const countBefore = fp.listFpEvents(opp.id).length;
    const res = fp.upsertFpOpportunity({ clientId: "el", title: "Guarded", solNumber: "GUARD-EV-1", status: "triaged_bid" });
    assert.ok(res.statusChangeBlocked);
    assert.equal(fp.listFpEvents(opp.id).length, countBefore);
  });

  it("a same-status re-ingest logs no duplicate transition event", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el", title: "Same again", solNumber: "SAME-EV-1" });
    fp.upsertFpOpportunity({ clientId: "el", title: "Same again", solNumber: "SAME-EV-1", status: "discovered" });
    assert.equal(fp.listFpEvents(opp.id).length, 0);
  });
});

describe("listFpOpportunities", () => {
  before(() => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Due soon",
      solNumber: "DUE-SOON",
      tier: "micro",
      responseDeadline: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
    });
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Due far",
      solNumber: "DUE-FAR",
      tier: "mid",
      responseDeadline: new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString(),
    });
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Past due",
      solNumber: "DUE-PAST",
      responseDeadline: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
    });
  });

  it("filters by due-within (excludes past + beyond-window)", () => {
    const sols = fp.listFpOpportunities({ dueWithinDays: 7 }).map((o) => o.solNumber);
    assert.ok(sols.includes("DUE-SOON"));
    assert.ok(!sols.includes("DUE-FAR"));
    assert.ok(!sols.includes("DUE-PAST"));
  });

  it("filters by tier and sorts deadlines first", () => {
    const micro = fp.listFpOpportunities({ tier: "micro" });
    assert.ok(micro.every((o) => o.tier === "micro"));
    const all = fp.listFpOpportunities({});
    const deadlines = all.filter((o) => o.responseDeadline).map((o) => o.responseDeadline!);
    const sorted = [...deadlines].sort();
    assert.deepEqual(deadlines, sorted);
  });

  it("rejects invalid filter values", () => {
    assert.throws(() => fp.listFpOpportunities({ status: "nah" as never }));
    assert.throws(() => fp.listFpOpportunities({ dueWithinDays: -1 }));
  });
});

describe("pending approvals + outcomes", () => {
  it("pendingFpApprovals returns awaiting_approval rows", () => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Needs the operator",
      solNumber: "APPROVE-1",
      status: "awaiting_approval",
      priceQuoted: 42000,
    });
    const pending = fp.pendingFpApprovals();
    assert.ok(pending.some((o) => o.solNumber === "APPROVE-1" && o.priceQuoted === 42000));
  });

  it("recordFpOutcome closes with result fields and audit event", () => {
    fp.upsertFpOpportunity({ clientId: "el", title: "Winner", solNumber: "WIN-1", status: "submitted", priceQuoted: 10000 });
    const { opp, event } = fp.recordFpOutcome("WIN-1", "won", { amount: 9500, awardee: "Acme Consulting" });
    assert.equal(opp.status, "closed_won");
    assert.equal(opp.resultAwardAmount, 9500);
    assert.equal(opp.resultAwardee, "Acme Consulting");
    assert.equal(event.kind, "outcome_recorded");
    assert.equal(event.detail?.outcome, "won");
  });

  it("rejects a bogus outcome", () => {
    assert.throws(() => fp.recordFpOutcome("WIN-1", "maybe" as never));
  });
});

describe("fpPriceBand", () => {
  it("maps the scoreboard bands", () => {
    assert.equal(fp.fpPriceBand(10_000), "<25K");
    assert.equal(fp.fpPriceBand(25_000), "25–75K");
    assert.equal(fp.fpPriceBand(80_000), "75–250K");
    assert.equal(fp.fpPriceBand(600_000), "250K+");
    assert.equal(fp.fpPriceBand(null), null);
  });
});

describe("sol_number resolution hardening (HT003826SC004 report)", () => {
  it("resolves punctuation/case-drifted sol numbers", () => {
    const a = fp.upsertFpOpportunity({ clientId: "el", title: "DHA PHA Solution Brief", solNumber: "HT0038-26-SC-004" });
    const hit = fp.findFpOpportunity("HT003826SC004");
    assert.equal(hit?.id, a.opp.id);
    const hit2 = fp.findFpOpportunity("ht0038-26-sc-004");
    assert.equal(hit2?.id, a.opp.id);
  });
});

// Regression cover for the reopen guard added 2026-07-31 after the NIST
// tech-transfer opp was silently flipped triaged_nobid -> triaged_bid by a
// plain re-ingest, and NIH GLP-1 hit the same failure the same week. Ingest
// enriches; it must not make triage decisions. `fp set-status` still can.
describe("ingest reopen guard", () => {
  it("blocks a status change once an opportunity has left 'discovered'", () => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "NIST Tech Transfer",
      solNumber: "REOPEN-NIST-1",
      status: "triaged_nobid",
      nobidReason: "No lab access",
    });

    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "NIST Tech Transfer (rescan)",
      solNumber: "REOPEN-NIST-1",
      status: "triaged_bid",
    });

    assert.equal(res.created, false);
    assert.equal(res.opp.status, "triaged_nobid", "status must not be flipped by ingest");
    assert.deepEqual(res.statusChangeBlocked, { from: "triaged_nobid", attempted: "triaged_bid" });
  });

  it("preserves nobid_reason when the status change is blocked", () => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "NIH GLP-1",
      solNumber: "REOPEN-NIH-1",
      status: "triaged_nobid",
      nobidReason: "Out of scope",
    });

    const res = fp.upsertFpOpportunity({ clientId: "el",
      solNumber: "REOPEN-NIH-1",
      title: "NIH GLP-1 (rescan)",
      status: "triaged_bid",
      nobidReason: null,
    });

    assert.equal(res.opp.nobidReason, "Out of scope", "nobid reason must survive a guarded ingest");
  });

  it("still enriches non-status fields while the status is guarded", () => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Enrich Me",
      solNumber: "REOPEN-ENRICH-1",
      status: "triaged_watch",
    });

    const res = fp.upsertFpOpportunity({ clientId: "el",
      solNumber: "REOPEN-ENRICH-1",
      title: "Enrich Me (amended)",
      status: "triaged_bid",
      agency: "GSA",
    });

    assert.equal(res.opp.status, "triaged_watch", "guarded field unchanged");
    assert.equal(res.opp.agency, "GSA", "unguarded field still enriched");
    assert.equal(res.opp.title, "Enrich Me (amended)", "unguarded field still enriched");
  });

  it("allows the change when forceReopen is set", () => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Deliberate Reopen",
      solNumber: "REOPEN-FORCE-1",
      status: "triaged_nobid",
      nobidReason: "Was a no-bid",
    });

    const res = fp.upsertFpOpportunity({ clientId: "el",
      solNumber: "REOPEN-FORCE-1",
      title: "Deliberate Reopen",
      status: "triaged_bid",
      forceReopen: true,
    });

    assert.equal(res.opp.status, "triaged_bid");
    assert.equal(res.statusChangeBlocked, undefined, "no block reported on a forced reopen");
  });

  it("does not guard an opportunity still in 'discovered'", () => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Fresh Find",
      solNumber: "REOPEN-FRESH-1",
      status: "discovered",
    });

    const res = fp.upsertFpOpportunity({ clientId: "el",
      solNumber: "REOPEN-FRESH-1",
      title: "Fresh Find",
      status: "triaged_bid",
    });

    assert.equal(res.opp.status, "triaged_bid", "first triage from discovered must still work");
    assert.equal(res.statusChangeBlocked, undefined);
  });

  it("reports no block when ingest re-sends the same status", () => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Same Status",
      solNumber: "REOPEN-SAME-1",
      status: "drafting",
    });

    const res = fp.upsertFpOpportunity({ clientId: "el",
      solNumber: "REOPEN-SAME-1",
      title: "Same Status",
      status: "drafting",
    });

    assert.equal(res.statusChangeBlocked, undefined, "a no-op status is not a blocked change");
  });

  it("setFpStatus is unaffected by the guard", () => {
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Manual Triage",
      solNumber: "REOPEN-MANUAL-1",
      status: "triaged_nobid",
    });

    const { opp } = fp.setFpStatus("REOPEN-MANUAL-1", "triaged_bid");
    assert.equal(opp.status, "triaged_bid", "deliberate triage must remain possible");
  });
});

// Bid Board editing (migration 034; delete moved to the tombstone model
// below — migration 036).
describe("bid board edit", () => {
  it("editing an allowed field persists it", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el", title: "Edit Me", solNumber: "EDIT-1" });
    const updated = fp.updateFpOpportunity(opp.id, {
      title: "Edit Me (corrected)",
      agency: "GSA",
      priceQuoted: 12_500,
      tier: "micro",
    });
    assert.equal(updated.title, "Edit Me (corrected)");
    assert.equal(updated.agency, "GSA");
    assert.equal(updated.priceQuoted, 12_500);
    assert.equal(updated.tier, "micro");
    // and it is persisted, not just returned
    const fresh = fp.findFpOpportunity(opp.id)!;
    assert.equal(fresh.agency, "GSA");
  });

  it("editing cannot change sol_number, notice_id, or created_at — even with hostile keys", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Identity Locked",
      solNumber: "EDIT-LOCK-1",
      noticeId: "edit-lock-notice-1",
    });
    fp.updateFpOpportunity(opp.id, {
      title: "Identity Locked (edited)",
      // runtime whitelist check: these keys are not in FpOpportunityEdit and
      // must be ignored, not written
      solNumber: "HACKED",
      noticeId: "HACKED",
      createdAt: 1,
      id: "HACKED",
    } as never);
    const fresh = fp.findFpOpportunity(opp.id)!;
    assert.equal(fresh.solNumber, "EDIT-LOCK-1");
    assert.equal(fresh.noticeId, "edit-lock-notice-1");
    assert.equal(fresh.createdAt, opp.createdAt);
    assert.equal(fresh.title, "Identity Locked (edited)");
  });

  it("editing a non-existent id fails cleanly rather than creating a row", () => {
    const before = fp.listFpOpportunities({}).length;
    assert.throws(() => fp.updateFpOpportunity("no-such-id", { title: "Ghost" }), /unknown opportunity id/);
    const after = fp.listFpOpportunities({}).length;
    assert.equal(after, before, "a failed edit must not create a row");
    assert.equal(fp.findFpOpportunity("no-such-id"), null);
  });
});

// Permanent delete + tombstones (migration 036 — the operator's decision, replacing
// the archive model). The trap: importers dedupe on natural keys, so a bare
// DELETE resurrects on the next sweep. The tombstone is what makes the delete
// permanent, and the re-import tests below are the whole point of the packet.
describe("permanent delete + tombstones", () => {
  it("delete removes the row and it no longer appears in listFpOpportunities", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el", title: "Delete Me", solNumber: "DEL-1", noticeId: "del-notice-1" });
    fp.deleteFpOpportunity(opp.id, { reason: "no-go", by: "demo@test" });
    assert.equal(fp.findFpOpportunity(opp.id), null);
    assert.ok(!fp.listFpOpportunities({}).some((o) => o.id === opp.id));
  });

  it("delete writes a tombstone carrying title and agency", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Explain Me Later",
      solNumber: "DEL-TOMB-1",
      agency: "GSA",
    });
    const tombstone = fp.deleteFpOpportunity(opp.id, { reason: "out of scope", by: "demo@test" });
    assert.equal(tombstone.title, "Explain Me Later");
    assert.equal(tombstone.agency, "GSA");
    assert.equal(tombstone.reason, "out of scope");
    assert.equal(tombstone.deletedBy, "demo@test");
    assert.ok(tombstone.deletedAt > 0);
  });

  it("delete removes the row's fp_events — no orphans", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el", title: "Evented", solNumber: "DEL-EVT-1" });
    fp.logFpEvent(opp.id, "note", { note: "pre-delete event" });
    assert.ok(fp.listFpEvents(opp.id).length > 0, "precondition: events exist");
    fp.deleteFpOpportunity(opp.id, { by: "demo@test" });
    assert.equal(fp.listFpEvents(opp.id).length, 0, "events must not orphan");
  });

  it("re-importing a deleted opportunity does NOT recreate it", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Never Again",
      solNumber: "DEL-RESURRECT-1",
      noticeId: "del-resurrect-notice-1",
    });
    fp.deleteFpOpportunity(opp.id, { reason: "no-go", by: "demo@test" });

    // The exact call the next sweep would make.
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Never Again (rescanned)",
      solNumber: "DEL-RESURRECT-1",
      noticeId: "del-resurrect-notice-1",
    });
    assert.equal(res.created, false, "must not create");
    assert.ok(res.skippedDeleted, "must be reported as skipped, not silently ignored");
    assert.equal(res.skippedDeleted!.title, "Never Again");
    assert.equal(fp.findFpOpportunity("del-resurrect-notice-1"), null, "row must not exist");
    assert.equal(fp.findFpOpportunity("DEL-RESURRECT-1"), null);
  });

  it("the tombstone matches on sol_number even when notice_id is null, and vice versa", () => {
    // sol-only opportunity, re-imported by sol only
    const solOnly = fp.upsertFpOpportunity({ clientId: "el", title: "Sol Only", solNumber: "DEL-SOLONLY-1" });
    fp.deleteFpOpportunity(solOnly.opp.id, { by: "demo@test" });
    const bySol = fp.upsertFpOpportunity({ clientId: "el", title: "Sol Only again", solNumber: "DEL-SOLONLY-1" });
    assert.ok(bySol.skippedDeleted, "sol_number alone must match the tombstone");

    // notice-only opportunity, re-imported by notice only
    const noticeOnly = fp.upsertFpOpportunity({ clientId: "el", title: "Notice Only", noticeId: "del-noticeonly-1" });
    fp.deleteFpOpportunity(noticeOnly.opp.id, { by: "demo@test" });
    const byNotice = fp.upsertFpOpportunity({ clientId: "el", title: "Notice Only again", noticeId: "del-noticeonly-1" });
    assert.ok(byNotice.skippedDeleted, "notice_id alone must match the tombstone");

    // and a re-formatted sol number must not slip past (HT003826SC004 lesson)
    const drifted = fp.upsertFpOpportunity({ clientId: "el", title: "Sol Only drifted", solNumber: "del-solonly-1" });
    assert.ok(drifted.skippedDeleted, "normalised sol match must also hit the tombstone");
  });

  it("deleting a non-existent id fails cleanly", () => {
    assert.throws(() => fp.deleteFpOpportunity("ghost-id", { by: "demo@test" }), /unknown opportunity id/);
  });

  it("micro: delete tombstones the notice and the sweep import skips it", () => {
    const owner = "demo@test";
    const first = dbmod.upsertMicroContract({
      userEmail: owner,
      noticeId: "micro-del-1",
      solNumber: "MICRO-DEL-SOL-1",
      title: "Micro Delete Me",
      agency: "NPS",
      noticeType: "micro-purchase",
      naics: null,
      description: null,
      postedDate: null,
      responseDeadline: null,
      setAside: null,
      url: null,
    });
    assert.equal(first.created, true);
    dbmod.deleteMicroContract(first.record.id, owner, { reason: "no-go", by: owner });
    assert.equal(dbmod.getMicroContract(first.record.id, owner), null);

    // The exact call the next sweep import would make.
    const again = dbmod.upsertMicroContract({
      userEmail: owner,
      noticeId: "micro-del-1",
      solNumber: "MICRO-DEL-SOL-1",
      title: "Micro Delete Me (rescanned)",
      agency: "NPS",
      noticeType: "micro-purchase",
      naics: null,
      description: null,
      postedDate: null,
      responseDeadline: null,
      setAside: null,
      url: null,
    });
    assert.equal(again.created, false);
    assert.equal(again.skippedDeleted, true, "must be reported as skipped, not silently ignored");
    assert.ok(
      !dbmod.listMicroContracts(owner).some((m) => m.noticeId === "micro-del-1"),
      "the notice must not be recreated",
    );
  });
});

// Priority flag (migration 041). flagged_at is a nullable timestamp — NULL is
// the one unambiguous "not flagged" — written only through setFpFlag, which
// logs who made the call. The sort tiebreak applies to listFpOpportunities
// (the Bid Board) ONLY; the deadline strips are pinned deadline-ordered in
// tests/pipeline-summary.test.ts.
describe("priority flag (migration 041)", () => {
  it("flag/unflag round-trip: timestamp set, NULL means unflagged, both events logged", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el", title: "Flag Me", solNumber: "FLAG-RT-1" });
    assert.equal(opp.flaggedAt, null, "a new row starts unflagged");

    const r1 = fp.setFpFlag("FLAG-RT-1", true, { by: "demo@test", note: "high priority" });
    assert.equal(r1.changed, true);
    assert.ok(r1.opp.flaggedAt != null && r1.opp.flaggedAt > 0, "flagged_at carries WHEN");
    assert.equal(r1.event?.kind, "flagged");
    assert.equal(r1.event?.detail?.by, "demo@test", "the event carries WHO");
    assert.equal(r1.event?.detail?.note, "high priority");
    // persisted, not just returned
    assert.ok(fp.findFpOpportunity(opp.id)!.flaggedAt != null);

    const r2 = fp.setFpFlag("FLAG-RT-1", false, { by: "demo@test" });
    assert.equal(r2.changed, true);
    assert.equal(r2.opp.flaggedAt, null, "unflag restores NULL — no tri-state");
    assert.equal(r2.event?.kind, "unflagged");

    const kinds = fp.listFpEvents(opp.id).map((e) => e.kind);
    assert.ok(kinds.includes("flagged") && kinds.includes("unflagged"), "both directions on the trail");
  });

  it("setting the state it already has is a no-op — no duplicate event, timestamp kept", () => {
    fp.upsertFpOpportunity({ clientId: "el", title: "Flag Twice", solNumber: "FLAG-IDEM-1" });
    const first = fp.setFpFlag("FLAG-IDEM-1", true, { by: "demo@test" });
    const again = fp.setFpFlag("FLAG-IDEM-1", true, { by: "demo@test" });
    assert.equal(again.changed, false);
    assert.equal(again.event, null);
    assert.equal(again.opp.flaggedAt, first.opp.flaggedAt, "the original WHEN survives a re-run");
    const flagEvents = fp.listFpEvents(again.opp.id).filter((e) => e.kind === "flagged");
    assert.equal(flagEvents.length, 1, "a re-run must not spam the audit trail");
  });

  it("requires `by` — a priority call must be attributed", () => {
    fp.upsertFpOpportunity({ clientId: "el", title: "Anon Flag", solNumber: "FLAG-BY-1" });
    assert.throws(() => fp.setFpFlag("FLAG-BY-1", true, { by: "  " }), /by/);
    assert.equal(fp.findFpOpportunity("FLAG-BY-1")!.flaggedAt, null, "nothing written");
  });

  it("throws on unknown handle", () => {
    assert.throws(() => fp.setFpFlag("ghost-flag", true, { by: "demo@test" }), /no opportunity matches/);
  });

  it("flagged rows sort first in listFpOpportunities; deadline order holds within each group", () => {
    const day = 24 * 3600 * 1000;
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Flagged far",
      solNumber: "FLAG-ORD-FAR",
      responseDeadline: new Date(Date.now() + 50 * day).toISOString(),
    });
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Flagged farther",
      solNumber: "FLAG-ORD-FARTHER",
      responseDeadline: new Date(Date.now() + 60 * day).toISOString(),
    });
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Unflagged near",
      solNumber: "FLAG-ORD-NEAR",
      responseDeadline: new Date(Date.now() + 1 * day).toISOString(),
    });
    fp.setFpFlag("FLAG-ORD-FAR", true, { by: "demo@test" });
    fp.setFpFlag("FLAG-ORD-FARTHER", true, { by: "demo@test" });

    const all = fp.listFpOpportunities({});
    // the flagged block leads, itself in deadline order
    assert.equal(all[0]!.solNumber, "FLAG-ORD-FAR");
    assert.equal(all[1]!.solNumber, "FLAG-ORD-FARTHER");
    // clean partition: once the unflagged block starts, no flagged row follows
    const firstUnflagged = all.findIndex((o) => o.flaggedAt == null);
    assert.ok(firstUnflagged >= 0);
    assert.ok(
      all.slice(firstUnflagged).every((o) => o.flaggedAt == null),
      "flagged rows must all precede unflagged rows",
    );
    // within the unflagged block, the existing deadline order is untouched
    const unflaggedDeadlines = all
      .filter((o) => o.flaggedAt == null && o.responseDeadline)
      .map((o) => o.responseDeadline!);
    assert.deepEqual(unflaggedDeadlines, [...unflaggedDeadlines].sort());

    // flags absent again: pure deadline order returns (NULL means unflagged)
    fp.setFpFlag("FLAG-ORD-FAR", false, { by: "demo@test" });
    fp.setFpFlag("FLAG-ORD-FARTHER", false, { by: "demo@test" });
    const restored = fp.listFpOpportunities({});
    const deadlines = restored.filter((o) => o.responseDeadline).map((o) => o.responseDeadline!);
    assert.deepEqual(deadlines, [...deadlines].sort());
  });
});

// Client-panel corpus isolation, tracking layer (migration 043,
// PANEL_ISOLATION_SPEC.md). The bar: nothing ingested for one client is ever
// visible through, or merged into, another client's rows.
describe("client scoping (migration 043)", () => {
  it("rejects a missing or unknown clientId — no silent 'el' fallback", () => {
    assert.throws(
      () => fp.upsertFpOpportunity({ title: "no client" } as never),
      /invalid client_id/,
    );
    assert.throws(
      () => fp.upsertFpOpportunity({ clientId: "acme" as never, title: "bad client" }),
      /invalid client_id/,
    );
  });

  it("dedupes per client: the same notice under two clients is two rows", () => {
    const el = fp.upsertFpOpportunity({
      clientId: "el",
      title: "Shared federal notice",
      noticeId: "shared-notice-1",
      priceQuoted: 10_000,
    });
    const nh = fp.upsertFpOpportunity({
      clientId: "riverside",
      title: "Shared federal notice",
      noticeId: "shared-notice-1",
    });
    assert.equal(el.created, true);
    assert.equal(nh.created, true, "riverside ingest must NOT update el's row");
    assert.notEqual(nh.opp.id, el.opp.id);
    // and the riverside re-ingest updates riverside's row, not el's
    const nh2 = fp.upsertFpOpportunity({
      clientId: "riverside",
      title: "Shared federal notice (amended)",
      noticeId: "shared-notice-1",
    });
    assert.equal(nh2.created, false);
    assert.equal(nh2.opp.id, nh.opp.id);
    assert.equal(fp.findFpOpportunity("shared-notice-1", "el")!.title, "Shared federal notice");
    assert.equal(fp.findFpOpportunity("shared-notice-1", "el")!.priceQuoted, 10_000);
  });

  it("scopes handle resolution — a wrong-client lookup answers null, even by exact id", () => {
    const northstar = fp.upsertFpOpportunity({
      clientId: "northstar",
      title: "Northstar-only notice",
      noticeId: "northstar-notice-1",
      solNumber: "RZ-26-R-0001",
    });
    assert.equal(fp.findFpOpportunity("northstar-notice-1", "northstar")!.id, northstar.opp.id);
    assert.equal(fp.findFpOpportunity("northstar-notice-1", "el"), null);
    assert.equal(fp.findFpOpportunity(northstar.opp.id, "el"), null);
    assert.equal(fp.findFpOpportunity("RZ26R0001", "northstar")!.id, northstar.opp.id, "normalised sol stays scoped");
    assert.equal(fp.findFpOpportunity("RZ26R0001", "riverside"), null);
    // unscoped (board API by exact id) still resolves
    assert.equal(fp.findFpOpportunity(northstar.opp.id)!.id, northstar.opp.id);
  });

  it("partitions list reads by clientId and never leaks across panels", () => {
    const all = fp.listFpOpportunities({});
    const el = fp.listFpOpportunities({ clientId: "el" });
    const nh = fp.listFpOpportunities({ clientId: "riverside" });
    const northstar = fp.listFpOpportunities({ clientId: "northstar" });
    assert.ok(el.every((o) => o.clientId === "el"));
    assert.ok(nh.every((o) => o.clientId === "riverside"));
    assert.ok(northstar.every((o) => o.clientId === "northstar"));
    assert.equal(el.length + nh.length + northstar.length, all.length);
    assert.ok(nh.length >= 1 && northstar.length >= 1);
  });

  it("scopes status transitions: set-status under the wrong client touches nothing", () => {
    fp.upsertFpOpportunity({
      clientId: "riverside",
      title: "Riverside status target",
      noticeId: "riverside-status-1",
    });
    assert.throws(
      () => fp.setFpStatus("riverside-status-1", "triaged_bid", null, "el"),
      /no opportunity matches/,
    );
    const moved = fp.setFpStatus("riverside-status-1", "triaged_bid", null, "riverside");
    assert.equal(moved.opp.status, "triaged_bid");
  });
});

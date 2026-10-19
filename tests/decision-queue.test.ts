// Decision Queue gate (bid/no-bid + price approval) — lib/decision-queue.ts.
//
// Pure logic (validation, ordering, deadline badges, rendering) is tested
// without a DB. Filing/answering round-trips run against a fresh temp DB via
// the same chdir-before-import pattern as federal-pipeline.test.ts.
//
// MUTATION NOTE — mutants these tests are built to kill:
//   - dropping the recommendation/reason requirement in validateGateFiling
//     (filing without either must fail, not silently file an open question);
//   - flipping urgencyCompare so no-deadline sorts first / overdue sorts last;
//   - deadlineLabel losing its "!!" shout on overdue or <48h deadlines;
//   - answerGateDecision writing on an already-answered row (silent overwrite)
//     or skipping the fp_event insert;
//   - answerGateDecision mutating fp_opportunities.status (the hard boundary:
//     recording a decision executes nothing);
//   - fileGateDecision accepting a context that resolves to no Bid Board row,
//     skipping the duplicate-open warning, or filing onto a submitted/closed
//     opportunity (the two-duplicate-submissions failure).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let dq: typeof import("../lib/decision-queue");
let fp: typeof import("../lib/federal-pipeline");
let decisions: typeof import("../lib/decisions");

before(async () => {
  // lib/db.ts resolves BOTH the sqlite file and the migrations dir from
  // process.cwd(); symlink the real migrations in before first import.
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-queue-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  dq = await import("../lib/decision-queue");
  fp = await import("../lib/federal-pipeline");
  decisions = await import("../lib/decisions");
});

// --- pure: validation --------------------------------------------------------

describe("validateGateFiling", () => {
  const base = {
    type: "bid",
    question: "Bid HT0038-26-SC-004?",
    options: ["GO", "NO-GO"],
    recommendedOption: "GO",
    recommendedReason: "In NAICS sweet spot; incumbent-free.",
  };

  it("accepts a complete filing", () => {
    assert.deepEqual(dq.validateGateFiling(base), []);
  });

  it("requires a recommendation — an open question is the human doing the analysis", () => {
    const problems = dq.validateGateFiling({ ...base, recommendedOption: "" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /--recommend is required/);
  });

  it("requires a reason", () => {
    const problems = dq.validateGateFiling({ ...base, recommendedReason: "  " });
    assert.match(problems[0], /--reason is required/);
  });

  it("rejects a recommendation that is not one of the options", () => {
    const problems = dq.validateGateFiling({ ...base, recommendedOption: "MAYBE" });
    assert.match(problems[0], /not one of the options/);
  });

  it("rejects unknown types and short option lists", () => {
    assert.match(dq.validateGateFiling({ ...base, type: "vibe" })[0], /--type must be one of/);
    assert.match(dq.validateGateFiling({ ...base, options: ["GO"] })[0], /at least two/);
  });
});

describe("resolveOption", () => {
  it("matches case-insensitively and returns the canonical spelling", () => {
    assert.equal(dq.resolveOption(["GO", "NO-GO"], "no-go"), "NO-GO");
    assert.equal(dq.resolveOption(["GO", "NO-GO"], " go "), "GO");
    assert.equal(dq.resolveOption(["GO", "NO-GO"], "maybe"), null);
  });
});

// --- pure: ordering & deadlines ----------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function mkDecision(over: Partial<import("../lib/decisions").Decision>) {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    createdAt: 0,
    updatedAt: 0,
    userEmail: "hello@govscout.ai",
    question: "q",
    contextType: "fp_bid",
    contextId: null,
    options: ["GO", "NO-GO"],
    recommendedOption: "GO",
    recommendedReason: "reason",
    deadlineMs: null,
    status: "open" as const,
    decidedAt: null,
    decision: null,
    decisionNote: null,
    actionKind: null,
    actionPayload: null,
    actionStatus: null,
    ...over,
  };
}

describe("sortByUrgency", () => {
  it("orders: overdue first, then soonest deadline, no-deadline last", () => {
    const now = 100 * DAY;
    const overdue = mkDecision({ id: "a".repeat(36), deadlineMs: now - DAY });
    const soon = mkDecision({ id: "b".repeat(36), deadlineMs: now + HOUR });
    const later = mkDecision({ id: "c".repeat(36), deadlineMs: now + 10 * DAY });
    const none = mkDecision({ id: "d".repeat(36), deadlineMs: null });
    const sorted = dq.sortByUrgency([none, later, soon, overdue]);
    assert.deepEqual(
      sorted.map((d) => d.id[0]),
      ["a", "b", "c", "d"],
    );
  });

  it("breaks no-deadline ties oldest-filed-first", () => {
    const old = mkDecision({ id: "e".repeat(36), createdAt: 1 });
    const newer = mkDecision({ id: "f".repeat(36), createdAt: 2 });
    assert.deepEqual(dq.sortByUrgency([newer, old]).map((d) => d.id[0]), ["e", "f"]);
  });
});

describe("deadlineLabel", () => {
  const now = Date.UTC(2026, 7, 4);
  it("shouts on a passed deadline", () => {
    const label = dq.deadlineLabel(now - 2 * DAY, now);
    assert.match(label, /^!! OVERDUE by 2d/);
  });
  it("shouts on an approaching (<48h) deadline", () => {
    assert.match(dq.deadlineLabel(now + 5 * HOUR, now), /^!! DUE in 5h/);
  });
  it("is calm beyond 48h and explicit about no deadline", () => {
    assert.match(dq.deadlineLabel(now + 10 * DAY, now), /^due .* \(in 10d\)$/);
    assert.equal(dq.deadlineLabel(null, now), "no deadline");
  });
});

// --- pure: rendering ---------------------------------------------------------

describe("renderDecisionList", () => {
  const now = Date.UTC(2026, 7, 4);

  it("makes an overdue open decision impossible to miss", () => {
    const rows = [
      mkDecision({ id: "1".repeat(36), deadlineMs: now - 3 * DAY, question: "Bid X?" }),
      mkDecision({ id: "2".repeat(36), question: "Bid Y?" }),
    ];
    const out = dq.renderDecisionList(rows, now);
    assert.match(out, /OPEN DECISIONS \(2\)/);
    assert.match(out, /!! OVERDUE by 3d/);
    assert.match(out, /!! 1 open decision overdue or due within 48h/);
    // overdue row renders before the no-deadline row
    assert.ok(out.indexOf("1".repeat(8)) < out.indexOf("2".repeat(8)));
  });

  it("renders legacy rows (no recommendation, long reasons) without falling over", () => {
    const rows = [
      mkDecision({
        id: "3".repeat(36),
        contextType: "panel_sim",
        recommendedOption: null,
        recommendedReason: "x".repeat(2000),
      }),
    ];
    const out = dq.renderDecisionList(rows, now);
    assert.match(out, /NO RECOMMENDATION recorded/);
    assert.match(out, /legacy row/);
    // long reason is truncated, not dumped
    assert.ok(!out.includes("x".repeat(200)));
  });

  it("hides resolved rows unless --all, and labels linked context", () => {
    const rows = [
      mkDecision({
        id: "4".repeat(36),
        status: "decided",
        decision: "GO",
        decidedAt: now - DAY,
        contextId: "opp-1",
      }),
    ];
    const bare = dq.renderDecisionList(rows, now);
    assert.match(bare, /OPEN DECISIONS \(0\)/);
    assert.ok(!bare.includes("4".repeat(8)));
    const all = dq.renderDecisionList(rows, now, {
      all: true,
      contextLabels: { "opp-1": "SOL-1 — Widgets [submitted]" },
    });
    assert.match(all, /RESOLVED \/ DISMISSED \(1\)/);
    assert.match(all, /decided → GO/);
    assert.match(all, /SOL-1 — Widgets \[submitted\]/);
  });
});

describe("renderDecisionShow", () => {
  it("marks the recommended option and never claims this tool executes actions", () => {
    const now = Date.UTC(2026, 7, 4);
    const d = mkDecision({
      id: "5".repeat(36),
      actionKind: "set_pool_status",
      actionStatus: "pending",
    });
    const out = dq.renderDecisionShow(d, now, "SOL-9 — Thing [drafting]");
    assert.match(out, /→ GO/);
    assert.match(out, /  NO-GO/);
    assert.match(out, /SOL-9 — Thing \[drafting\]/);
    assert.match(out, /recorded only; this tool never executes it/);
  });
});

// --- DB round-trips ----------------------------------------------------------

describe("fileGateDecision / answerGateDecision", () => {
  let oppId: string;

  before(() => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "DHA dental wax quotation",
      solNumber: "HT0038-26-SC-004",
      noticeId: "notice-ht0038",
      status: "triaged_bid",
      priceQuoted: 12500,
    });
    oppId = res.opp.id;
  });

  it("files by sol number and links context_id to the fp opportunity id", () => {
    const { decision, opportunity, warnings } = dq.fileGateDecision({
      type: "price",
      contextHandle: "HT0038-26-SC-004",
      question: "Approve $12,500 for HT0038-26-SC-004?",
      options: ["APPROVE", "REVISE"],
      recommendedOption: "approve", // case-insensitive → canonical
      recommendedReason: "Matches sent artifact total; 22% margin.",
      deadlineMs: Date.now() + DAY,
    });
    assert.equal(opportunity.id, oppId);
    assert.equal(decision.contextId, oppId);
    assert.equal(decision.contextType, "fp_price");
    assert.equal(decision.recommendedOption, "APPROVE");
    assert.equal(decision.status, "open");
    assert.deepEqual(warnings, []);
  });

  it("warns on a duplicate open decision for the same context+type", () => {
    const { warnings } = dq.fileGateDecision({
      type: "price",
      contextHandle: oppId,
      question: "Approve $12,500 (re-filed)?",
      options: ["APPROVE", "REVISE"],
      recommendedOption: "APPROVE",
      recommendedReason: "duplicate on purpose",
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /already filed for this opportunity/);
  });

  it("refuses to file without a linked Bid Board row", () => {
    assert.throws(
      () =>
        dq.fileGateDecision({
          type: "bid",
          contextHandle: "NO-SUCH-SOL",
          question: "Bid?",
          options: ["GO", "NO-GO"],
          recommendedOption: "GO",
          recommendedReason: "r",
        }),
      /no opportunity matches/,
    );
  });

  it("refuses to file on an opportunity whose status is already past the decision", () => {
    const sub = fp.upsertFpOpportunity({ clientId: "el",
      title: "Already submitted thing",
      solNumber: "SUB-1",
      status: "submitted",
    });
    assert.throws(
      () =>
        dq.fileGateDecision({
          type: "bid",
          contextHandle: sub.opp.id,
          question: "Bid SUB-1?",
          options: ["GO", "NO-GO"],
          recommendedOption: "GO",
          recommendedReason: "r",
        }),
      /refusing to file: SUB-1 is already "submitted"/,
    );
  });

  it("answering records who/when/what, writes the fp_event, and mutates nothing else", () => {
    const { decision } = dq.fileGateDecision({
      type: "bid",
      contextHandle: oppId,
      question: "Bid HT0038-26-SC-004?",
      options: ["GO", "NO-GO"],
      recommendedOption: "GO",
      recommendedReason: "Deliverable in-house.",
    });
    const statusBefore = fp.findFpOpportunity(oppId)!.status;
    const eventsBefore = fp.listFpEvents(oppId).length;

    const res = dq.answerGateDecision({
      id: decision.id,
      decision: "go", // canonicalised to GO
      by: "the operator",
      note: "numbers re-derived from sent artifacts",
    });
    assert.equal(res.changed, true);
    assert.equal(res.decision.status, "decided");
    assert.equal(res.decision.decision, "GO");
    assert.ok(res.decision.decidedAt != null);
    assert.match(res.decision.decisionNote ?? "", /by the operator/);
    assert.match(res.decision.decisionNote ?? "", /re-derived/);

    // fp_event landed on the linked opportunity's provenance trail
    assert.ok(res.event);
    assert.equal(res.event!.oppId, oppId);
    assert.equal(res.event!.detail?.by, "the operator");
    assert.equal(res.event!.detail?.decision, "GO");
    assert.equal(res.event!.detail?.decisionId, decision.id);
    assert.equal(fp.listFpEvents(oppId).length, eventsBefore + 1);

    // the hard boundary: recording a decision executes NOTHING
    assert.equal(fp.findFpOpportunity(oppId)!.status, statusBefore);
  });

  it("re-answering is a reported no-op, never a silent overwrite", () => {
    const { decision } = dq.fileGateDecision({
      type: "bid",
      contextHandle: oppId,
      question: "Bid again?",
      options: ["GO", "NO-GO"],
      recommendedOption: "NO-GO",
      recommendedReason: "r",
    });
    dq.answerGateDecision({ id: decision.id, decision: "NO-GO", by: "the operator" });
    const eventsBefore = fp.listFpEvents(oppId).length;
    const res = dq.answerGateDecision({ id: decision.id, decision: "GO", by: "Alfred" });
    assert.equal(res.changed, false);
    assert.equal(res.event, null);
    assert.match(res.warnings[0], /already decided → "NO-GO"/);
    // first answer stands; no new event
    assert.equal(dq.findGateDecision(decision.id)!.decision, "NO-GO");
    assert.equal(fp.listFpEvents(oppId).length, eventsBefore);
  });

  it("rejects an answer that is not one of the options, and requires --by", () => {
    const { decision } = dq.fileGateDecision({
      type: "price",
      contextHandle: oppId,
      question: "Approve?",
      options: ["APPROVE", "REVISE"],
      recommendedOption: "APPROVE",
      recommendedReason: "r",
    });
    assert.throws(
      () => dq.answerGateDecision({ id: decision.id, decision: "YES", by: "the operator" }),
      /not one of this decision's options/,
    );
    assert.throws(
      () => dq.answerGateDecision({ id: decision.id, decision: "APPROVE", by: "  " }),
      /--by is required/,
    );
    // still open — the failed attempts wrote nothing
    assert.equal(dq.findGateDecision(decision.id)!.status, "open");
  });

  it("never fires a pending action — recording is not executing", () => {
    // a legacy-style row carrying an action; answered via the gate path
    const legacy = decisions.createDecision({
      userEmail: "hello@govscout.ai",
      question: "Legacy action-carrying decision",
      contextType: "pool",
      contextId: "pool-123",
      options: ["yes", "no"],
      recommendedOption: "yes",
      recommendedReason: "r",
      actionKind: "set_pool_status",
      actionPayload: { poolId: "pool-123", status: "active" },
    });
    const res = dq.answerGateDecision({ id: legacy.id, decision: "yes", by: "the operator" });
    assert.equal(res.changed, true);
    // action stays pending, event is null (no fp context), both reported
    assert.equal(res.decision.actionStatus, "pending");
    assert.ok(res.warnings.some((w) => /NOT executed/.test(w)));
    assert.ok(res.warnings.some((w) => /no fp_event written/.test(w)));
  });

  it("resolves unique id prefixes and rejects ambiguous ones", () => {
    const d = dq.fileGateDecision({
      type: "bid",
      contextHandle: oppId,
      question: "Prefix test?",
      options: ["GO", "NO-GO"],
      recommendedOption: "GO",
      recommendedReason: "r",
    }).decision;
    assert.equal(dq.findGateDecision(d.id.slice(0, 8))!.id, d.id);
    assert.throws(() => dq.findGateDecision(""), /ambiguous/);
  });

  it("a filed decision surfaces in the record lookup by its context", async () => {
    const lookup = await import("../lib/record-lookup");
    const opp = fp.findFpOpportunity(oppId)!;
    const row = dq
      .fileGateDecision({
        type: "bid",
        contextHandle: oppId,
        question: "Lookup wiring test?",
        options: ["GO", "NO-GO"],
        recommendedOption: "GO",
        recommendedReason: "r",
      })
      .decision;
    const report = lookup.buildLookupReport(
      "HT0038-26-SC-004",
      {
        fp_opportunities: {
          ok: true,
          rows: [
            {
              id: opp.id,
              solNumber: opp.solNumber,
              noticeId: opp.noticeId,
              title: opp.title,
              agency: null,
              status: opp.status,
              nobidReason: null,
              responseDeadline: null,
              priceQuoted: opp.priceQuoted,
              priceBasis: null,
              submissionMethod: null,
              submissionTarget: null,
              gmailDraftId: null,
              gmailSentIds: [],
              poc1Name: null,
              poc1Email: null,
              poc2Name: null,
              poc2Email: null,
              flaggedAt: null,
              archivedAt: null,
              createdAt: opp.createdAt,
              updatedAt: opp.updatedAt,
            },
          ],
        },
        fp_events: { ok: true, rows: [] },
        micro_contracts: { ok: true, rows: [] },
        decision_queue: {
          ok: true,
          rows: [
            {
              id: row.id,
              question: row.question,
              contextType: row.contextType,
              contextId: row.contextId,
              status: row.status,
              decision: row.decision,
              decisionNote: row.decisionNote,
              createdAt: row.createdAt,
              decidedAt: row.decidedAt,
            },
          ],
        },
        trackl_contacts: { ok: true, rows: [] },
        boilerplate_blocks: { ok: true, rows: [] },
      },
      Date.now(),
    );
    assert.equal(report.decisions.length, 1);
    assert.equal(report.decisions[0].matchedOn, "context_id");
  });
});

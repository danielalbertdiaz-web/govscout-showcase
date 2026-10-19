// Unified record lookup — pure-logic tests. No database: the module under
// test takes StoreRead inputs, so every guard here is exercised directly.
//
// The guards that matter (each maps to a real incident):
//   - duplicate risk (gmail_sent_ids / submitted / closed_*) is loud — the
//     NASA $42,800-vs-$55,000 and 18-second NIST duplicates;
//   - not-found is explicit and lists where we looked — the no-bid false alarm;
//   - an unreadable store is reported, never treated as empty;
//   - canon/staging conflict is surfaced, never resolved.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLookupReport,
  classifyQuery,
  renderLookupReport,
  LOOKUP_STORES,
  type BlockLite,
  type ContactLite,
  type DecisionLite,
  type FpEventLite,
  type FpOppLite,
  type LookupStores,
  type MicroLite,
} from "../lib/record-lookup";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0); // 2026-08-04T12:00Z, fixed clock
const DAY = 24 * 60 * 60 * 1000;

function fpOpp(over: Partial<FpOppLite> = {}): FpOppLite {
  return {
    id: "fp-1",
    solNumber: "19NP4026Q0034",
    noticeId: "n-abc123",
    title: "Embassy Kathmandu janitorial services",
    agency: "State/19NP",
    status: "triaged_bid",
    nobidReason: null,
    responseDeadline: "2026-08-15T17:00:00-04:00",
    priceQuoted: 42800,
    priceBasis: "labor+materials",
    submissionMethod: "email",
    submissionTarget: "co@state.example.org",
    gmailDraftId: null,
    gmailSentIds: [],
    poc1Name: "Pat CO",
    poc1Email: "pat.co@state.example.org",
    poc2Name: null,
    poc2Email: null,
    flaggedAt: null,
    archivedAt: null,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 2 * DAY,
    ...over,
  };
}

function micro(over: Partial<MicroLite> = {}): MicroLite {
  return {
    id: "mc-1",
    noticeId: "n-abc123",
    solNumber: "19NP4026Q0034",
    title: "Embassy Kathmandu janitorial services",
    agency: "State/19NP",
    disposition: "new",
    description: null,
    responseDeadline: "2026-08-15",
    fpOpportunityId: null,
    createdAt: NOW - 20 * DAY,
    updatedAt: NOW - 20 * DAY,
    ...over,
  };
}

function stores(over: Partial<LookupStores> = {}): LookupStores {
  return {
    fp_opportunities: { ok: true, rows: [] as FpOppLite[] },
    fp_events: { ok: true, rows: [] as FpEventLite[] },
    micro_contracts: { ok: true, rows: [] as MicroLite[] },
    decision_queue: { ok: true, rows: [] as DecisionLite[] },
    trackl_contacts: { ok: true, rows: [] as ContactLite[] },
    boilerplate_blocks: { ok: true, rows: [] as BlockLite[] },
    ...over,
  };
}

describe("classifyQuery", () => {
  it("an email address is an email query; everything else is a handle", () => {
    assert.equal(classifyQuery("pat.co@state.example.org"), "email");
    assert.equal(classifyQuery("19NP4026Q0034"), "handle");
    assert.equal(classifyQuery("Harbor"), "handle");
  });
});

describe("resolution by each query type", () => {
  it("resolves by fp id", () => {
    const r = buildLookupReport("fp-1", stores({ fp_opportunities: { ok: true, rows: [fpOpp()] } }), NOW);
    assert.equal(r.verdict, "in-canon");
    assert.equal(r.canon[0].matchedOn, "id");
  });

  it("resolves by notice id (case-insensitive)", () => {
    const r = buildLookupReport("N-ABC123", stores({ fp_opportunities: { ok: true, rows: [fpOpp()] } }), NOW);
    assert.equal(r.canon[0].matchedOn, "notice_id");
  });

  it("resolves a sol number loosely — punctuation and case stripped, same as findFpOpportunity", () => {
    const r = buildLookupReport(
      "19np-4026-q0034",
      stores({ fp_opportunities: { ok: true, rows: [fpOpp()] } }),
      NOW,
    );
    assert.equal(r.verdict, "in-canon");
    assert.equal(r.canon[0].matchedOn, "sol_number");
  });

  it("resolves by title fragment, case-insensitively", () => {
    const r = buildLookupReport("kathmandu", stores({ fp_opportunities: { ok: true, rows: [fpOpp()] } }), NOW);
    assert.equal(r.canon[0].matchedOn, "title");
  });

  it("resolves an email against trackl_contacts and canon POC emails", () => {
    const contact: ContactLite = {
      id: "ct-1",
      name: "Jo Harbor",
      title: "CLPPP Coordinator",
      email: "jo.harbor@county.example.org",
      priority: "P1_CLPPP",
      source: "NACCHO",
      agencyName: "Harbor County Health",
    };
    const r1 = buildLookupReport(
      "jo.harbor@county.example.org",
      stores({ trackl_contacts: { ok: true, rows: [contact] } }),
      NOW,
    );
    assert.equal(r1.verdict, "contact");
    assert.equal(r1.contacts[0].matchedOn, "email");

    const r2 = buildLookupReport(
      "pat.co@state.example.org",
      stores({ fp_opportunities: { ok: true, rows: [fpOpp()] } }),
      NOW,
    );
    assert.equal(r2.canon[0].matchedOn, "poc_email");
  });

  it("resolves staging-only rows and says so — no canon row implied", () => {
    const r = buildLookupReport("19NP4026Q0034", stores({ micro_contracts: { ok: true, rows: [micro()] } }), NOW);
    assert.equal(r.verdict, "staging-only");
    assert.equal(r.canon.length, 0);
    assert.match(renderLookupReport(r), /staging ONLY/);
  });

  it("resolves a boilerplate block only when the query names one", () => {
    const block: BlockLite = { id: "bp-1", key: "capability-statement", title: "Capability Statement", version: 3, updatedAt: NOW - DAY };
    const byKey = buildLookupReport("capability-statement", stores({ boilerplate_blocks: { ok: true, rows: [block] } }), NOW);
    assert.equal(byKey.verdict, "boilerplate");
    const noise = buildLookupReport("zz", stores({ boilerplate_blocks: { ok: true, rows: [block] } }), NOW);
    assert.equal(noise.verdict, "not-found");
  });

  it("attaches decisions by context_id and by sol number named inside the question", () => {
    const d: DecisionLite = {
      id: "dq-1",
      question: "Approve $55,000 price for 19NP-4026-Q0034?",
      contextType: "fp_opportunity",
      contextId: "fp-1",
      status: "decided",
      decision: "approve",
      decisionNote: "authorised ceiling",
      createdAt: NOW - 10 * DAY,
      decidedAt: NOW - 9 * DAY,
    };
    const r = buildLookupReport(
      "19NP4026Q0034",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp()] },
        decision_queue: { ok: true, rows: [d] },
      }),
      NOW,
    );
    assert.equal(r.decisions.length, 1);
    // context_id fp-1 is a matched canon id, so it attaches on context_id.
    assert.equal(r.decisions[0].matchedOn, "context_id");

    const byQuestion = buildLookupReport(
      "19NP4026Q0034",
      stores({ decision_queue: { ok: true, rows: [{ ...d, contextId: null }] } }),
      NOW,
    );
    assert.equal(byQuestion.decisions.length, 1);
    assert.equal(byQuestion.decisions[0].matchedOn, "question");
  });
});

describe("not-found is explicit — never implied by an empty result", () => {
  it("names every store searched, with row counts, and says found nothing", () => {
    const r = buildLookupReport("NO-SUCH-SOL-999", stores({
      fp_opportunities: { ok: true, rows: [fpOpp()] },
      micro_contracts: { ok: true, rows: [micro()] },
    }), NOW);
    assert.equal(r.found, false);
    assert.equal(r.verdict, "not-found");
    assert.equal(r.storesSearched.length, LOOKUP_STORES.length);
    for (const name of LOOKUP_STORES) {
      const info = r.storesSearched.find((s) => s.store === name);
      assert.ok(info, `${name} missing from storesSearched`);
      assert.equal(info.ok, true);
      assert.equal(typeof info.rowsScanned, "number");
    }
    const text = renderLookupReport(r);
    assert.match(text, /NOT FOUND/);
    assert.match(text, /fp_opportunities \(1 rows\)/);
    assert.match(text, /micro_contracts \(1 rows\)/);
    // Absence from the SYSTEM, not from one query — the false-alarm lesson.
    assert.match(text, /not just from one query/);
  });

  it("not-found over populated stores is distinguishable from not-found over empty stores", () => {
    const empty = buildLookupReport("X-1", stores(), NOW);
    const populated = buildLookupReport("X-1", stores({ fp_opportunities: { ok: true, rows: [fpOpp()] } }), NOW);
    const scanned = (r: typeof empty) =>
      r.storesSearched.find((s) => s.store === "fp_opportunities")!.rowsScanned;
    assert.equal(scanned(empty), 0);
    assert.equal(scanned(populated), 1);
  });
});

describe("duplicate risk is the headline", () => {
  it("gmail_sent_ids populated renders the DUPLICATE RISK banner before anything else", () => {
    const opp = fpOpp({ gmailSentIds: ["msg-1", "msg-2"] });
    const r = buildLookupReport("19NP4026Q0034", stores({ fp_opportunities: { ok: true, rows: [opp] } }), NOW);
    assert.equal(r.duplicateRisk.level, "already-acted");
    assert.match(r.duplicateRisk.reasons.join(" "), /2 Gmail message/);
    const text = renderLookupReport(r);
    assert.match(text, /DUPLICATE RISK — WE ALREADY ACTED/);
    // Banner must precede the record body: skimming top-down hits it first.
    assert.ok(text.indexOf("DUPLICATE RISK") < text.indexOf("CANON fp_opportunities"));
    // The actual sent ids are shown as evidence.
    assert.match(text, /msg-1, msg-2/);
  });

  it("status submitted / closed_* alone also flags already-acted", () => {
    for (const status of ["submitted", "closed_won", "closed_lost", "closed_no_award"]) {
      const r = buildLookupReport("19NP4026Q0034", stores({ fp_opportunities: { ok: true, rows: [fpOpp({ status })] } }), NOW);
      assert.equal(r.duplicateRisk.level, "already-acted", status);
    }
  });

  it("a staging row already submitted flags risk even with no canon row", () => {
    const r = buildLookupReport("19NP4026Q0034", stores({ micro_contracts: { ok: true, rows: [micro({ disposition: "submitted" })] } }), NOW);
    assert.equal(r.duplicateRisk.level, "already-acted");
  });

  it("a clean working row carries no risk banner", () => {
    const r = buildLookupReport("19NP4026Q0034", stores({ fp_opportunities: { ok: true, rows: [fpOpp()] } }), NOW);
    assert.equal(r.duplicateRisk.level, "none");
    assert.doesNotMatch(renderLookupReport(r), /DUPLICATE RISK/);
  });
});

describe("canon vs staging conflict — surfaced, never resolved", () => {
  it("fp triaged_bid vs micro passed is a conflict (the VISN 16 shape)", () => {
    const r = buildLookupReport(
      "19NP4026Q0034",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp({ status: "triaged_bid" })] },
        micro_contracts: { ok: true, rows: [micro({ disposition: "passed", fpOpportunityId: "fp-1" })] },
      }),
      NOW,
    );
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].fpStatus, "triaged_bid");
    assert.equal(r.conflicts[0].microDisposition, "passed");
    const text = renderLookupReport(r);
    assert.match(text, /CONFLICT/);
    // Neither side was altered: both states still render as stored.
    assert.match(text, /status: triaged_bid/);
    assert.match(text, /disposition: passed/);
  });

  it("normal promotion lag (fp working vs micro new) is NOT a conflict", () => {
    const r = buildLookupReport(
      "19NP4026Q0034",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp({ status: "drafting" })] },
        micro_contracts: { ok: true, rows: [micro({ disposition: "new", fpOpportunityId: "fp-1" })] },
      }),
      NOW,
    );
    assert.equal(r.conflicts.length, 0);
  });

  it("a linked pair appears together even when only one side matched the query", () => {
    // Match canon by a title word absent from the staging title: the linked
    // staging row must still be pulled in via fp_opportunity_id.
    const r = buildLookupReport(
      "janitorial",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp()] },
        micro_contracts: {
          ok: true,
          rows: [micro({ title: "Custodial svcs", fpOpportunityId: "fp-1" })],
        },
      }),
      NOW,
    );
    assert.equal(r.staging.length, 1);
  });
});

describe("an unreadable store is reported, never treated as empty", () => {
  it("fp_events failing leaves provenance UNAVAILABLE, not blank", () => {
    const r = buildLookupReport(
      "19NP4026Q0034",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp()] },
        fp_events: { ok: false, error: "disk I/O error" },
      }),
      NOW,
    );
    assert.equal(r.canon[0].events, null);
    const info = r.storesSearched.find((s) => s.store === "fp_events")!;
    assert.equal(info.ok, false);
    assert.equal(info.rowsScanned, null);
    assert.equal(info.error, "disk I/O error");
    const text = renderLookupReport(r);
    assert.match(text, /WARNING: store "fp_events" could NOT be read/);
    assert.match(text, /provenance: UNAVAILABLE/);
  });

  it("an unreadable submissions store makes duplicate risk UNKNOWN, not none", () => {
    const r = buildLookupReport(
      "19NP4026Q0034",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp()] },
        micro_contracts: { ok: false, error: "database is locked" },
      }),
      NOW,
    );
    assert.equal(r.duplicateRisk.level, "unknown");
    assert.match(renderLookupReport(r), /DUPLICATE RISK UNKNOWN/);
  });

  it("positive already-acted evidence still wins over an unreadable sibling store", () => {
    const r = buildLookupReport(
      "19NP4026Q0034",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp({ gmailSentIds: ["m1"] })] },
        micro_contracts: { ok: false, error: "database is locked" },
      }),
      NOW,
    );
    assert.equal(r.duplicateRisk.level, "already-acted");
  });
});

describe("provenance trail", () => {
  it("renders the last events newest-first with by/reason detail, and dates the current status", () => {
    const events: FpEventLite[] = [
      { oppId: "fp-1", ts: NOW - 21 * DAY, kind: "discovered", detail: { via: "fp ingest" } },
      { oppId: "fp-1", ts: NOW - 14 * DAY, kind: "triaged", detail: { from: "discovered", to: "triaged_bid", by: "alfred", note: "fits NAICS" } },
      { oppId: "other", ts: NOW - DAY, kind: "note", detail: null },
    ];
    const r = buildLookupReport(
      "19NP4026Q0034",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp({ status: "triaged_bid" })] },
        fp_events: { ok: true, rows: events },
      }),
      NOW,
    );
    assert.equal(r.canon[0].eventsTotal, 2); // other opp's event excluded
    assert.equal(r.canon[0].events![0].kind, "triaged"); // newest first
    assert.equal(r.canon[0].statusSince, NOW - 14 * DAY); // the event that set the status
    const text = renderLookupReport(r);
    assert.match(text, /by=alfred/);
    assert.match(text, /note=fits NAICS/);
    assert.match(text, /for 14 days/);
  });

  it("a row with no events says the trail is thin rather than showing nothing", () => {
    const r = buildLookupReport("19NP4026Q0034", stores({ fp_opportunities: { ok: true, rows: [fpOpp()] } }), NOW);
    assert.match(renderLookupReport(r), /no events recorded/);
  });
});

describe("--json shape is stable", () => {
  it("the report's top-level keys are the published contract", () => {
    const r = buildLookupReport("X", stores(), NOW);
    assert.deepEqual(Object.keys(r).sort(), [
      "blocks",
      "canon",
      "conflicts",
      "contacts",
      "decisions",
      "duplicateRisk",
      "found",
      "now",
      "query",
      "queryKind",
      "staging",
      "storesSearched",
      "verdict",
      "warnings",
    ]);
  });

  it("a full report round-trips through JSON with a fixed, machine-usable shape", () => {
    const r = buildLookupReport(
      "19NP4026Q0034",
      stores({
        fp_opportunities: { ok: true, rows: [fpOpp({ gmailSentIds: ["m1"] })] },
        micro_contracts: { ok: true, rows: [micro({ disposition: "passed", fpOpportunityId: "fp-1" })] },
      }),
      NOW,
    );
    const parsed = JSON.parse(JSON.stringify(r)) as typeof r;
    assert.equal(parsed.verdict, "in-canon");
    assert.equal(parsed.duplicateRisk.level, "already-acted");
    assert.equal(parsed.canon[0].opp.id, "fp-1");
    assert.equal(parsed.conflicts[0].microId, "mc-1");
    assert.deepEqual(Object.keys(parsed.canon[0]).sort(), [
      "actedReasons",
      "events",
      "eventsTotal",
      "matchedOn",
      "opp",
      "statusSince",
    ]);
    assert.deepEqual(Object.keys(parsed.storesSearched[0]).sort(), ["error", "ok", "rowsScanned", "store"]);
  });
});

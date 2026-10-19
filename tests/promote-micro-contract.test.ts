// Staging -> Bid Board promotion (lib/promote-micro-contract.ts) against a
// fresh temp DB — same isolation ritual as tests/federal-pipeline.test.ts:
// chdir to a mkdtemp dir (with lib/migrations symlinked) BEFORE the dynamic
// imports so getDb() opens an isolated database.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let promote: typeof import("../lib/promote-micro-contract");
let fp: typeof import("../lib/federal-pipeline");
let dbmod: typeof import("../lib/db");
let identity: typeof import("../lib/opportunity-identity");

const OWNER = "daniel@example.com";

before(async () => {
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  promote = await import("../lib/promote-micro-contract");
  fp = await import("../lib/federal-pipeline");
  dbmod = await import("../lib/db");
  identity = await import("../lib/opportunity-identity");
});

/**
 * Seed one staging row the way scripts/micro-sweep-import.mts does: upsert
 * always creates at "new"; a sweep kill is then applied via
 * setMicroContractDisposition (the importer's create-only path).
 */
function seedMicro(
  overrides: Partial<Parameters<typeof dbmod.upsertMicroContract>[0]> = {},
  disposition: import("../lib/micro-contracts-types").MicroContractDisposition = "passed",
) {
  const { record } = dbmod.upsertMicroContract({
    userEmail: OWNER,
    noticeId: overrides.noticeId ?? "notice-0032",
    solNumber: overrides.solNumber ?? "19NP4026Q0032",
    title: overrides.title ?? "PAS: Safe Migration Screening",
    agency: overrides.agency ?? "U.S. Department of State",
    noticeType: "micro-purchase",
    naics: overrides.naics ?? "541990",
    description: overrides.description ?? "Sweep verdict: foreign-pop-nepal-kathmandu",
    postedDate: null,
    responseDeadline: overrides.responseDeadline ?? "2026-08-20",
    setAside: overrides.setAside ?? null,
    url: overrides.url ?? "https://sam.gov/opp/notice-0032/view",
  });
  if (disposition !== "new") {
    return dbmod.setMicroContractDisposition(record.id, OWNER, disposition)!;
  }
  return record;
}

function microBySol(sol: string) {
  return dbmod.listMicroContracts(OWNER).find((m) => m.solNumber === sol)!;
}

describe("promoteMicroContracts", () => {
  it("dry run decides everything and writes nothing", () => {
    seedMicro();
    const { outcomes, ok } = promote.promoteMicroContracts(["19NP4026Q0032"], {
      ownerEmail: OWNER,
      apply: false,
      authorisedBy: "daniel",
    });
    assert.equal(ok, true);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].kind, "promoted");
    assert.equal(fp.findFpOpportunity("19NP4026Q0032"), null); // nothing written
    const micro = microBySol("19NP4026Q0032");
    assert.equal(micro.fpOpportunityId, null); // no backlink either
    assert.equal(micro.disposition, "passed"); // dry run rewrites nothing
  });

  it("promotes with the discovered entry state, carried fields, backlink and provenance event", () => {
    // Before: the linked pair would be an R-1 conflict (dead vs untouched).
    assert.equal(identity.statesConflict("discovered", "passed"), true);
    const { outcomes } = promote.promoteMicroContracts(["19NP4026Q0032"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
      priority: "high",
    });
    assert.equal(outcomes[0].kind, "promoted");
    const opp = fp.findFpOpportunity("19NP4026Q0032");
    assert.ok(opp, "fp row created");
    // Entry state is triage/new — never drafting or submitted.
    assert.equal(opp.status, promote.PROMOTION_ENTRY_STATUS);
    assert.equal(opp.status, "discovered");
    assert.equal(opp.title, "PAS: Safe Migration Screening");
    assert.equal(opp.agency, "U.S. Department of State");
    assert.equal(opp.noticeId, "notice-0032");
    assert.equal(opp.naics, "541990");
    assert.equal(opp.tier, "micro");
    assert.equal(opp.source, "sam");
    assert.equal(opp.noticeType, "micro-purchase");
    assert.equal(opp.url, "https://sam.gov/opp/notice-0032/view");
    // Deadline string is carried verbatim (parse is read-time, end-of-day rule).
    assert.equal(opp.responseDeadline, "2026-08-20");
    // Uncaptured set-aside is "unknown", never "none".
    assert.equal(opp.setAside, null);
    assert.equal(opp.setAsideCanonical, "unknown");
    // Bidirectional link.
    const micro = microBySol("19NP4026Q0032");
    assert.equal(micro.fpOpportunityId, opp.id);
    // The sweep kill is superseded in the same stroke: staging moves to
    // "reviewing", so the linked pair AGREES afterwards — promotion must not
    // manufacture an R-1 state conflict out of a decision already made.
    assert.equal(micro.disposition, promote.PROMOTED_STAGING_DISPOSITION);
    assert.equal(micro.disposition, "reviewing");
    assert.equal(identity.statesConflict(opp.status, micro.disposition), false);
    // The original kill verdict (the audit trail) survives untouched.
    assert.equal(micro.description, "Sweep verdict: foreign-pop-nepal-kathmandu");
    // Provenance: promoted from sweep, why it was excluded, who authorised.
    const events = fp.listFpEvents(opp.id);
    const prov = events.find((e) => e.detail?.source === "promote-micro-contract");
    assert.ok(prov, "provenance event logged");
    assert.equal(prov.detail?.previousExclusion, "Sweep verdict: foreign-pop-nepal-kathmandu");
    assert.equal(prov.detail?.authorisedBy, "daniel");
    assert.equal(prov.detail?.priority, "high");
    assert.equal(prov.detail?.microContractId, micro.id);
    assert.equal(prov.detail?.microDisposition, "passed"); // what it WAS
    assert.deepEqual(prov.detail?.stagingDisposition, { from: "passed", to: "reviewing" });
  });

  it("re-run is idempotent: a no-op in every table, human edits not clobbered", () => {
    // A human triages the promoted row and fixes its deadline.
    fp.setFpStatus("19NP4026Q0032", "triaged_bid", "human decision");
    const opp = fp.findFpOpportunity("19NP4026Q0032")!;
    fp.updateFpOpportunity(opp.id, { responseDeadline: "2026-08-21", title: "Human-edited title" });

    const db = dbmod.getDb();
    const snapshot = () => ({
      fp: db.prepare("SELECT * FROM fp_opportunities WHERE sol_number = ?").all("19NP4026Q0032"),
      micro: db.prepare("SELECT * FROM micro_contracts WHERE sol_number = ?").all("19NP4026Q0032"),
      events: db.prepare("SELECT COUNT(*) AS n FROM fp_events WHERE opp_id = ?").get(opp.id),
    });
    const before = snapshot();

    const { outcomes, ok } = promote.promoteMicroContracts(["19NP4026Q0032"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    assert.equal(ok, true);
    assert.equal(outcomes[0].kind, "exists");
    assert.equal((outcomes[0] as { dispositionRepair: boolean }).dispositionRepair, false);

    // Byte-for-byte no-op in every table (fp row, staging row, event count).
    assert.deepEqual(snapshot(), before);
    assert.equal(before.fp.length, 1); // and still no duplicate
    const fresh = fp.findFpOpportunity("19NP4026Q0032")!;
    assert.equal(fresh.status, "triaged_bid"); // human triage survives
    assert.equal(fresh.responseDeadline, "2026-08-21"); // human deadline survives
    assert.equal(fresh.title, "Human-edited title"); // human title survives
    assert.equal(microBySol("19NP4026Q0032").disposition, "reviewing"); // not re-written
  });

  it("repairs a missing micro->fp backlink on an exists-skip, touching nothing else", () => {
    seedMicro({ noticeId: "notice-0040", solNumber: "19NP4026Q0040", title: "Link repair case" });
    // Canonical row appears separately (different notice id, same sol), so
    // ingest-time auto-link did not fire and the backlink is null.
    fp.upsertFpOpportunity({ clientId: "el",
      title: "Pre-existing board row",
      solNumber: "19NP4026Q0040",
      noticeId: "board-notice-0040",
      status: "triaged_watch",
    });
    const beforeMicro = microBySol("19NP4026Q0040");
    assert.equal(beforeMicro.fpOpportunityId, null);

    const { outcomes } = promote.promoteMicroContracts(["19NP4026Q0040"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    assert.equal(outcomes[0].kind, "exists");
    assert.equal((outcomes[0] as { linkRepair: boolean }).linkRepair, true);
    const micro = microBySol("19NP4026Q0040");
    const existing = fp.findFpOpportunity("19NP4026Q0040")!;
    assert.equal(micro.fpOpportunityId, existing.id);
    assert.equal(existing.status, "triaged_watch"); // untouched
    assert.equal(existing.title, "Pre-existing board row"); // untouched
    // The board row was NOT created by the promoter, so fp:triaged_watch vs
    // micro:passed may be a GENUINE disagreement — never auto-resolved here.
    assert.equal((outcomes[0] as { dispositionRepair: boolean }).dispositionRepair, false);
    assert.equal(micro.disposition, "passed");
  });

  it("repairs a pre-fix promotion left on the superseded sweep kill (exists path)", () => {
    // Simulate the state the pre-fix promoter manufactured in production:
    // fp row + backlink + provenance event written, staging still "passed".
    seedMicro({ noticeId: "notice-0050", solNumber: "19NP4026Q0050", title: "Pre-fix promotion" });
    promote.promoteMicroContracts(["19NP4026Q0050"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    const microId = microBySol("19NP4026Q0050").id;
    dbmod.setMicroContractDisposition(microId, OWNER, "passed");

    const { outcomes, ok } = promote.promoteMicroContracts(["19NP4026Q0050"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    assert.equal(ok, true);
    assert.equal(outcomes[0].kind, "exists");
    assert.equal((outcomes[0] as { dispositionRepair: boolean }).dispositionRepair, true);
    const micro = microBySol("19NP4026Q0050");
    assert.equal(micro.disposition, "reviewing");
    assert.equal(micro.description, "Sweep verdict: foreign-pop-nepal-kathmandu"); // audit trail intact
    const opp = fp.findFpOpportunity("19NP4026Q0050")!;
    assert.equal(identity.statesConflict(opp.status, micro.disposition), false); // conflict cleared
    // And the repair itself is on the record + idempotent.
    const repairs = fp
      .listFpEvents(opp.id)
      .filter((e) => e.detail?.source === "promote-micro-contract");
    assert.equal(repairs.length, 2); // original promotion + one repair
    const again = promote.promoteMicroContracts(["19NP4026Q0050"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    assert.equal((again.outcomes[0] as { dispositionRepair: boolean }).dispositionRepair, false);
    assert.equal(fp.listFpEvents(opp.id).filter((e) => e.detail?.source === "promote-micro-contract").length, 2);
  });

  it("a re-sweep import cannot un-promote: disposition and backlink survive re-ingest", () => {
    // The nightly importer re-upserts every notice from a fresh CSV. Its
    // ON CONFLICT update deliberately omits disposition and fp_opportunity_id,
    // and it only applies a sweep verdict on CREATE — verify that explicitly
    // for a promoted row rather than trusting the docs.
    const beforeMicro = microBySol("19NP4026Q0032");
    assert.equal(beforeMicro.disposition, "reviewing");
    assert.ok(beforeMicro.fpOpportunityId);

    const { record, created } = dbmod.upsertMicroContract({
      userEmail: OWNER,
      noticeId: beforeMicro.noticeId,
      solNumber: beforeMicro.solNumber,
      title: beforeMicro.title,
      agency: beforeMicro.agency,
      noticeType: "micro-purchase",
      naics: beforeMicro.naics,
      description: "Sweep verdict: foreign-pop-nepal-kathmandu", // fresh CSV, same kill
      postedDate: null,
      responseDeadline: beforeMicro.responseDeadline,
      setAside: null,
      url: beforeMicro.url,
    });
    assert.equal(created, false);
    // scripts/micro-sweep-import.mts sets the verdict disposition ONLY when
    // created — so on this re-ingest it would not call
    // setMicroContractDisposition at all, and the row keeps the human state:
    assert.equal(record.disposition, "reviewing");
    assert.equal(record.fpOpportunityId, beforeMicro.fpOpportunityId);
  });

  it("a partway failure leaves nothing behind (transaction atomicity)", () => {
    seedMicro({ noticeId: "notice-0060", solNumber: "19NP4026Q0060", title: "Atomicity case" });
    const db = dbmod.getDb();
    // Force the LAST write in the promotion transaction (the provenance
    // event) to fail, after the fp row, backlink, and disposition writes.
    db.exec(
      "CREATE TRIGGER promote_test_fail BEFORE INSERT ON fp_events BEGIN SELECT RAISE(ABORT, 'forced test failure'); END",
    );
    try {
      assert.throws(() =>
        promote.promoteMicroContracts(["19NP4026Q0060"], {
          ownerEmail: OWNER,
          apply: true,
          authorisedBy: "daniel",
        }),
      );
    } finally {
      db.exec("DROP TRIGGER promote_test_fail");
    }
    // Everything rolled back: no fp row, no backlink, disposition untouched.
    assert.equal(fp.findFpOpportunity("19NP4026Q0060"), null);
    const micro = microBySol("19NP4026Q0060");
    assert.equal(micro.fpOpportunityId, null);
    assert.equal(micro.disposition, "passed");
  });

  it("canonicalises a recognised set-aside on promote", () => {
    seedMicro({
      noticeId: "notice-sba",
      solNumber: "19NP4026Q0099",
      title: "Set-aside carry",
      setAside: "Total Small Business Set-Aside",
    });
    promote.promoteMicroContracts(["19NP4026Q0099"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    const opp = fp.findFpOpportunity("19NP4026Q0099")!;
    assert.equal(opp.setAside, "Total Small Business Set-Aside"); // raw preserved
    assert.equal(opp.setAsideCanonical, "small_business");
  });

  it("REFUSES a tombstoned sol and writes nothing", () => {
    seedMicro({ noticeId: "notice-dead", solNumber: "19NP4026Q0666", title: "Deliberately deleted" });
    const { outcomes: first } = promote.promoteMicroContracts(["19NP4026Q0666"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    assert.equal(first[0].kind, "promoted");
    const oppId = (first[0] as { oppId: string }).oppId;
    fp.deleteFpOpportunity(oppId, { reason: "no-go forever", by: "daniel" });

    const { outcomes, ok } = promote.promoteMicroContracts(["19NP4026Q0666"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    assert.equal(ok, false); // caller must exit nonzero
    assert.equal(outcomes[0].kind, "tombstoned");
    assert.equal((outcomes[0] as { tombstone: { reason: string } }).tombstone.reason, "no-go forever");
    assert.equal(fp.findFpOpportunity("19NP4026Q0666"), null); // not resurrected
  });

  it("reports a missing sol and signals failure, without blocking the rest", () => {
    seedMicro({ noticeId: "notice-live", solNumber: "19NP4026Q0033", title: "PAS: Future Ready Nepal" });
    const { outcomes, ok } = promote.promoteMicroContracts(["NO-SUCH-SOL-1", "19NP4026Q0033"], {
      ownerEmail: OWNER,
      apply: true,
      authorisedBy: "daniel",
    });
    assert.equal(ok, false);
    assert.equal(outcomes[0].kind, "missing");
    assert.equal(outcomes[1].kind, "promoted"); // the valid one still lands
    assert.ok(fp.findFpOpportunity("19NP4026Q0033"));
  });

  it("matches sol numbers loosely (punctuation/case drift)", () => {
    const { outcomes } = promote.promoteMicroContracts(["19np4026q-0033"], {
      ownerEmail: OWNER,
      apply: false,
      authorisedBy: "daniel",
    });
    // Already promoted above -> exists, resolved despite formatting drift.
    assert.equal(outcomes[0].kind, "exists");
  });
});

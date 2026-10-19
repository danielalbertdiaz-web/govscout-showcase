// Cross-source opportunity identity (R-1 phase 1). Live evidence: 10 shared
// notice_ids and 21 shared sol_numbers between staging and canonical with no
// link — including "VISN 16" at fp:triaged_bid vs micro:passed. The matcher
// links and surfaces; it never resolves.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  normalizeSolNumber,
  matchKey,
  resolveLink,
  linkCandidates,
  statesConflict,
  type IdentityRow,
} from "../lib/opportunity-identity";

let fp: typeof import("../lib/federal-pipeline");
let dbmod: typeof import("../lib/db");

before(async () => {
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opp-identity-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  fp = await import("../lib/federal-pipeline");
  dbmod = await import("../lib/db");
});

const row = (id: string, noticeId: string | null, solNumber: string | null): IdentityRow => ({
  id,
  noticeId,
  solNumber,
});

describe("matching", () => {
  it("a notice_id match links, and beats sol_number", () => {
    const fpRows = [row("fp1", "N-1", "SOL-A"), row("fp2", "N-2", "SOL-B")];
    const res = resolveLink({ noticeId: "N-2", solNumber: "SOL-A" }, fpRows);
    // notice says fp2 even though the sol points at fp1 — notice_id wins.
    assert.deepEqual(res, { kind: "match", fpId: "fp2", matchedOn: "notice_id" });
  });

  it("a sol_number-only match links when notice_ids are absent", () => {
    const fpRows = [row("fp1", null, "SOL-A")];
    const res = resolveLink({ noticeId: null, solNumber: "SOL-A" }, fpRows);
    assert.deepEqual(res, { kind: "match", fpId: "fp1", matchedOn: "sol_number" });
  });

  it("DIFFERENT non-null notice_ids sharing a sol_number do NOT link — ambiguous", () => {
    // A base solicitation and its amendment can share a sol; guessing would
    // link the wrong record.
    const fpRows = [row("fp1", "N-OTHER", "SOL-A")];
    const res = resolveLink({ noticeId: "N-MINE", solNumber: "SOL-A" }, fpRows);
    assert.equal(res.kind, "ambiguous");
  });

  it("punctuation/case-drifted sol numbers match (the HT0038-26-SC-004 case)", () => {
    assert.equal(normalizeSolNumber("HT0038-26-SC-004"), normalizeSolNumber("ht003826sc004"));
    const fpRows = [row("fp1", null, "HT0038-26-SC-004")];
    const res = resolveLink({ noticeId: null, solNumber: "HT003826SC004" }, fpRows);
    assert.deepEqual(res, { kind: "match", fpId: "fp1", matchedOn: "sol_number" });
  });

  it("a sol matching MULTIPLE canonical rows is ambiguous, never a guess", () => {
    const fpRows = [row("fp1", null, "SOL-A"), row("fp2", null, "SOL-A")];
    const res = resolveLink({ noticeId: null, solNumber: "SOL-A" }, fpRows);
    assert.equal(res.kind, "ambiguous");
  });

  it("a staging row with no counterpart stays unlinked, and that is not an error", () => {
    const res = resolveLink({ noticeId: "N-ONLY-MICRO", solNumber: "SOL-ONLY" }, [
      row("fp1", "N-1", "SOL-1"),
    ]);
    assert.deepEqual(res, { kind: "none" });
    // and matchKey handles empty identity
    assert.deepEqual(matchKey(null, null), { notice: null, sol: null });
  });

  it("linkCandidates batches: links + ambiguous, unmatched rows simply absent", () => {
    const fpRows = [row("fp1", "N-1", "SOL-1"), row("fp2", null, "SOL-2")];
    const micro = [
      row("m1", "N-1", null), // notice match
      row("m2", "N-X", "SOL-2"), // sol match, fp notice null -> links
      row("m3", "N-Y", "SOL-1"), // sol match but both notices differ -> ambiguous
      row("m4", "N-Z", "SOL-Z"), // no counterpart
    ];
    const { links, ambiguous } = linkCandidates(micro, fpRows);
    assert.deepEqual(links, [
      { microId: "m1", fpId: "fp1", matchedOn: "notice_id" },
      { microId: "m2", fpId: "fp2", matchedOn: "sol_number" },
    ]);
    assert.equal(ambiguous.length, 1);
    assert.equal(ambiguous[0].microId, "m3");
  });
});

// Mutation check (verified by hand, 2026-08): making the untouched pass
// symmetric in statesConflict — `if (micro === "untouched" || fp === "untouched")
// return false;` — fails the DIRECTIONAL test below (3 assertions) plus the
// promote-micro-contract precondition assert on ("discovered","passed"). The
// asymmetry is load-bearing; these tests are its tripwire.
describe("state conflict detection", () => {
  it("flags the live pursue-vs-killed pair: fp:triaged_bid / micro:passed", () => {
    assert.equal(statesConflict("triaged_bid", "passed"), true);
  });

  it("does NOT flag the agreeing kill: fp:triaged_nobid / micro:passed", () => {
    assert.equal(statesConflict("triaged_nobid", "passed"), false);
  });

  it("does NOT flag normal promotion lag: canonical progressed, staging at new", () => {
    assert.equal(statesConflict("triaged_bid", "new"), false);
    assert.equal(statesConflict("drafting", "new"), false);
  });

  it("staging 'new' against a DECIDED canon state is lag, not a conflict", () => {
    // A staging row at "new" is the sweep saying "I have not judged this" —
    // the absence of an opinion cannot disagree with a decision. Before this
    // rule, 12 of 14 live "conflicts" had exactly this shape (sweep re-listed
    // solicitations a human had already resolved) and the noise would have
    // buried the two real entries.
    for (const decided of [
      "submitted",
      "qa_open",
      "closed_won",
      "closed_lost",
      "closed_no_award", // 4 live pairs
      "triaged_nobid", // 7 live pairs
      "withdrawn",
    ]) {
      assert.equal(statesConflict(decided, "new"), false, `fp:${decided} / micro:new must not conflict`);
    }
  });

  it("DIRECTIONAL: a real staging opinion against untriaged canon STILL conflicts", () => {
    // The pass for "untouched" applies only to the STAGING side. Canon at
    // "discovered" holds no opinion either, but here it is staging that knows
    // something canon does not — this asymmetry is how the two Nepal
    // submitted-vs-passed errors were found. A symmetric rule (fp untouched
    // also agreeing with everything) makes these assertions fail — see the
    // mutation note in the suite comment.
    assert.equal(statesConflict("discovered", "submitted"), true);
    assert.equal(statesConflict("discovered", "passed"), true);
    assert.equal(statesConflict("discovered", "won"), true);
  });

  it("two REAL opposed opinions still conflict: fp:submitted / micro:passed (Nepal)", () => {
    assert.equal(statesConflict("submitted", "passed"), true);
  });

  it("unknown statuses are flagged, never silently classified — even against staging 'new'", () => {
    assert.equal(statesConflict("some_new_status", "passed"), true);
    assert.equal(statesConflict("submitted", "mystery"), true);
    // The untouched-staging pass must not swallow an unreadable canon status.
    assert.equal(statesConflict("some_new_status", "new"), true);
  });
});

describe("link at ingest (upsertMicroContract)", () => {
  const owner = "daniel@test";
  const microInput = (noticeId: string, solNumber: string | null) => ({
    userEmail: owner,
    noticeId,
    solNumber,
    title: `Link test ${noticeId}`,
    agency: null,
    noticeType: "micro-purchase",
    naics: null,
    description: null,
    postedDate: null,
    responseDeadline: null,
    setAside: null,
    url: null,
  });

  it("a new staging row auto-links to its canonical counterpart, idempotently", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Canonical for link",
      noticeId: "link-notice-1",
      solNumber: "LINK-SOL-1",
    });
    const first = dbmod.upsertMicroContract(microInput("link-notice-1", "LINK-SOL-1"));
    assert.equal(first.record.fpOpportunityId, opp.id, "ingest must link to the canonical row");
    // re-running the linker path (a re-import) is idempotent
    const again = dbmod.upsertMicroContract(microInput("link-notice-1", "LINK-SOL-1"));
    assert.equal(again.created, false);
    assert.equal(again.record.fpOpportunityId, opp.id);
  });

  it("a row with no canonical counterpart stays unlinked (null), not an error", () => {
    const res = dbmod.upsertMicroContract(microInput("link-notice-nowhere", "LINK-NOWHERE-1"));
    assert.equal(res.record.fpOpportunityId, null);
  });

  it("no state is copied across the link — the staging disposition is untouched", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Canonical submitted",
      noticeId: "link-notice-2",
      status: "submitted",
    });
    const res = dbmod.upsertMicroContract(microInput("link-notice-2", null));
    assert.equal(res.record.fpOpportunityId, opp.id);
    assert.equal(res.record.disposition, "new", "linking must never write state");
    assert.equal(fp.findFpOpportunity(opp.id)!.status, "submitted", "canonical state untouched too");
  });
});
